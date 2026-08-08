import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Usage-limiter accounting through the real retry loop.
//
// Two defects this file pins:
//  1. usage was recorded ONLY when a call succeeded, so the rpm/rpd ledger (and
//     the provider-wide daily cap that reads it) froze the moment a provider
//     started rejecting us — the limiter went blind exactly when it needed to
//     back off.
//  2. the provider in-flight slot was claimed once per REQUEST but released
//     once per RETRY, so a retrying request handed back more slots than it
//     took and stole capacity from concurrent requests. The /v1/messages route
//     had the mirror-image bug: it claimed a slot and never released it.

const chatCompletion = vi.fn();
const streamChatCompletion = vi.fn();
const fakeProvider = { name: 'flaky', chatCompletion, streamChatCompletion } as any;

vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getProvider: () => fakeProvider,
    resolveProvider: () => fakeProvider,
    buildProviderFor: () => fakeProvider,
  };
});

const { createApp } = await import('../../app.js');
const { initDb, getDb, getUnifiedApiKey } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { setRoutingStrategy, setGlobalRetryLimit, routeRequest, getInFlightCount } =
  await import('../../services/router.js');
const { providerDailyRequestCount, clearPlatformCaches } = await import('../../services/ratelimit.js');
const { clearExhausted } = await import('../../services/key-exhaustion.js');

const PLATFORM = 'flaky';
const MODEL_ID = 'flaky-model';

async function post(app: Express, path: string, body: any, key: string) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, raw };
}

// A rate-limit rejection formatted the way every openai-compat adapter formats
// upstream failures ("<Name> API error <status>: …") with the status attached,
// i.e. the provider answered — the attempt spent its request quota.
const RATE_LIMITED = Object.assign(
  new Error('flaky API error 429: too many requests'),
  { status: 429 },
);
const GOOD_RESULT = {
  choices: [{ message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

describe('Usage limiter accounting under failure and retry', () => {
  let app: Express;
  let key: string;
  let keyId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');

    // A custom provider capped at 2 simultaneous in-flight calls, one model,
    // one key. Every seeded catalog model is disabled so routing is
    // deterministic: this model or nothing.
    db.prepare(`
      INSERT INTO custom_providers (slug, display_name, base_url, max_parallel_requests)
      VALUES (?, 'Flaky', 'http://127.0.0.1:1/v1', 2)
    `).run(PLATFORM);
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, 'Flaky Model', 1, 1, 1)
    `).run(PLATFORM, MODEL_ID);
    const modelDbId = (db.prepare('SELECT id FROM models WHERE model_id = ?').get(MODEL_ID) as { id: number }).id;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(modelDbId);

    const enc = encrypt('flaky-key');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'only', ?, ?, ?, 'healthy', 1)
    `).run(PLATFORM, enc.encrypted, enc.iv, enc.authTag);
    keyId = (db.prepare('SELECT id FROM api_keys WHERE platform = ?').get(PLATFORM) as { id: number }).id;
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    clearPlatformCaches(PLATFORM);   // in-memory windows + cooldowns
    clearExhausted(keyId, MODEL_ID);
    setGlobalRetryLimit(3);          // bounds the loop: 3 upstream attempts, no 1-RPM sleeps
  });

  // ── Defect 1: the ledger must move on failed attempts ──
  it('counts attempts that reached the provider even when every one is rejected', async () => {
    chatCompletion.mockRejectedValue(RATE_LIMITED);

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(chatCompletion).toHaveBeenCalledTimes(3);
    // Every one of those three attempts was accepted and rejected by the
    // provider, so all three count against its request quota. Recording only
    // successes left this at 0 — the limiter saw a completely idle key while
    // the gateway hammered a provider that was already saying no.
    expect(providerDailyRequestCount(PLATFORM, keyId)).toBe(3);
  });

  it('does not charge the provider for a failure that never reached it', async () => {
    // Connection refused: retried like any transport hiccup, but no HTTP
    // response ever came back, so nothing was accepted upstream.
    chatCompletion.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(chatCompletion).toHaveBeenCalledTimes(3);
    expect(providerDailyRequestCount(PLATFORM, keyId)).toBe(0);
  });

  // ── Defect 2: claim/release symmetry across a RETRYING request ──
  it('releases exactly one slot for a request that retried before succeeding', async () => {
    expect(getInFlightCount(PLATFORM)).toBe(0);

    // A concurrent request already holds one of the provider's two slots.
    const held = routeRequest(100);
    expect(getInFlightCount(PLATFORM)).toBe(1);

    // The next request fails twice on the same key, then succeeds — three
    // upstream attempts against ONE slot reservation.
    chatCompletion
      .mockRejectedValueOnce(RATE_LIMITED)
      .mockRejectedValueOnce(RATE_LIMITED)
      .mockResolvedValueOnce(GOOD_RESULT);

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('ok');
    expect(chatCompletion).toHaveBeenCalledTimes(3);
    // It took one slot and must give back one. Releasing per retry dropped the
    // counter to 0 here — the retrying request handed away the slot still held
    // by the concurrent request above, letting the provider be pushed past its
    // configured parallel cap.
    expect(getInFlightCount(PLATFORM)).toBe(1);

    held.release();
    expect(getInFlightCount(PLATFORM)).toBe(0);
    // The handle is one-shot: a second call must not steal someone else's slot.
    held.release();
    expect(getInFlightCount(PLATFORM)).toBe(0);
  });

  it('releases the slot on the /v1/messages route too', async () => {
    expect(getInFlightCount(PLATFORM)).toBe(0);
    chatCompletion.mockResolvedValue(GOOD_RESULT);

    const { status } = await post(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(200);
    // This route claimed a slot per attempt and never released one, so every
    // request permanently consumed capacity until the provider looked full.
    expect(getInFlightCount(PLATFORM)).toBe(0);
  });
});
