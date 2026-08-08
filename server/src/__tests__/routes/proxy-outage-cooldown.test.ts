import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Express } from 'express';

// Which errors REST a key, driven through the real retry loops.
//
// The three cooldown sites (routes/proxy.ts key-exhaustion, routes/responses.ts
// and routes/anthropic.ts per-attempt) used to bench a key on `isRetryableError`
// — or, on the chat path, on nothing at all. Retryable is deliberately generous:
// it says yes to `fetch failed`, because when the local transport dies the NEXT
// provider is a different host/DNS/TLS path and failing over is free.
//
// Benching on that same yes is a category error. In a total local network outage
// every attempt dies as `fetch failed` before leaving the box, so the routing
// loop walked the whole chain and left every key it touched benched — and the
// bench is persisted to rate_limit_cooldowns, so it outlived the outage and kept
// healthy keys unroutable (services/router.ts:700) after the network came back.
//
// These tests import NOTHING from the new predicate on purpose: they assert the
// observable cooldown state, so they fail against the pre-fix tree on the
// assertion rather than on a missing import.

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
const { setRoutingStrategy, setGlobalRetryLimit, routeRequest } = await import('../../services/router.js');
const { isOnCooldown, clearPlatformCaches } = await import('../../services/ratelimit.js');
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

// What undici throws for every pre-flight transport death — DNS failure, no
// route to host, TLS failure, a dead local proxy. The real cause is stashed on
// .cause and the message is exactly this. No status: nothing answered.
function outageError() {
  return Object.assign(new TypeError('fetch failed'), {
    cause: new Error('getaddrinfo EAI_AGAIN api.provider.example'),
  });
}

// A provider that answered and said no, formatted the way every openai-compat
// adapter formats upstream failures. This one MUST still rest the key.
const RATE_LIMITED = Object.assign(
  new Error('flaky API error 429: too many requests'),
  { status: 429 },
);

describe('a key is rested only when the provider is at fault', () => {
  let app: Express;
  let key: string;
  let keyIds: number[];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    key = getUnifiedApiKey();

    const db = getDb();
    setRoutingStrategy('priority');

    db.prepare(`
      INSERT INTO custom_providers (slug, display_name, base_url, max_parallel_requests)
      VALUES (?, 'Flaky', 'http://127.0.0.1:1/v1', 8)
    `).run(PLATFORM);
    db.prepare('UPDATE models SET enabled = 0').run();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
      VALUES (?, ?, 'Flaky Model', 1, 1, 1)
    `).run(PLATFORM, MODEL_ID);
    const modelDbId = (db.prepare('SELECT id FROM models WHERE model_id = ?').get(MODEL_ID) as { id: number }).id;
    db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(modelDbId);

    // THREE healthy keys, so an outage has a chain to walk: the pre-fix bug
    // benched each one in turn as the loop rotated through them.
    for (const label of ['one', 'two', 'three']) {
      const enc = encrypt(`flaky-key-${label}`);
      db.prepare(`
        INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
        VALUES (?, ?, ?, ?, ?, 'healthy', 1)
      `).run(PLATFORM, label, enc.encrypted, enc.iv, enc.authTag);
    }
    keyIds = (db.prepare('SELECT id FROM api_keys WHERE platform = ? ORDER BY id').all(PLATFORM) as { id: number }[])
      .map(r => r.id);
    expect(keyIds).toHaveLength(3);
  });

  beforeEach(() => {
    chatCompletion.mockReset();
    streamChatCompletion.mockReset();
    const db = getDb();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare('DELETE FROM rate_limit_cooldowns').run();
    clearPlatformCaches(PLATFORM);
    for (const id of keyIds) clearExhausted(id, MODEL_ID);
    db.prepare("UPDATE api_keys SET status = 'healthy', enabled = 1 WHERE platform = ?").run(PLATFORM);
    setGlobalRetryLimit(9);   // enough to walk 3 keys x 3 per-key retries
  });

  const cooledKeys = () => keyIds.filter(id => isOnCooldown(PLATFORM, MODEL_ID, id));
  const persistedCooldownRows = () =>
    (getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns WHERE platform = ?').get(PLATFORM) as { n: number }).n;

  // ── The outage scenario, one test per route that benches keys ──

  it('leaves every key uncooled when the box loses its network entirely (/v1/chat/completions)', async () => {
    chatCompletion.mockImplementation(async () => { throw outageError(); });

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    // Failover behavior is unchanged: still retried, still errored to the client.
    expect(status).toBe(429);
    expect(chatCompletion.mock.calls.length).toBeGreaterThan(1);
    // Nothing reached a provider, so no key did anything wrong. Pre-fix the
    // chat path's key-exhaustion bench was ungated and cooled each key it
    // walked, persisting the bench past the end of the outage.
    expect(cooledKeys()).toEqual([]);
    expect(persistedCooldownRows()).toBe(0);
  });

  it('leaves every key uncooled during a total outage (/v1/responses)', async () => {
    chatCompletion.mockImplementation(async () => { throw outageError(); });

    const { status } = await post(app, '/v1/responses', { input: 'hi' }, key);

    expect(status).toBe(429);
    expect(chatCompletion.mock.calls.length).toBeGreaterThan(1);
    expect(cooledKeys()).toEqual([]);
    expect(persistedCooldownRows()).toBe(0);
  });

  it('leaves every key uncooled during a total outage (/v1/messages)', async () => {
    chatCompletion.mockImplementation(async () => { throw outageError(); });

    const { status } = await post(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    expect(chatCompletion.mock.calls.length).toBeGreaterThan(1);
    expect(cooledKeys()).toEqual([]);
    expect(persistedCooldownRows()).toBe(0);
  });

  it('leaves every key routable on the NORMAL pass once the network returns', async () => {
    // The outage burns a whole request...
    chatCompletion.mockImplementation(async () => { throw outageError(); });
    await post(app, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, key);
    for (const id of keyIds) clearExhausted(id, MODEL_ID);

    // ...and the network comes back. The ordinary routing pass must now find a
    // key. Pre-fix every key carried a persisted 90s bench, so this returned
    // null: a request arriving in that window could only get through by
    // degrading into the all-models-exhausted 1-RPM recovery path, which is the
    // one place the router ignores cooldowns (services/router.ts:698).
    const route = routeRequest(100);
    expect(route, 'no key routable on the normal pass after a purely local outage').not.toBeNull();
    route?.release();
  });

  // ── The control: real provider faults must still rest the key ──

  it('still rests a key when the provider itself rate-limits us (/v1/chat/completions)', async () => {
    chatCompletion.mockRejectedValue(RATE_LIMITED);

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(status).toBe(429);
    // The provider answered and said no — that IS its own condition, and
    // resting the key is the entire point of the cooldown.
    expect(cooledKeys().length).toBeGreaterThan(0);
    expect(persistedCooldownRows()).toBeGreaterThan(0);
  });

  it('still rests a key on a provider 500 (/v1/responses)', async () => {
    chatCompletion.mockRejectedValue(
      Object.assign(new Error('flaky API error 500: internal server error'), { status: 500 }),
    );

    await post(app, '/v1/responses', { input: 'hi' }, key);

    expect(cooledKeys().length).toBeGreaterThan(0);
  });

  it('still rests a key on a provider 429 (/v1/messages)', async () => {
    chatCompletion.mockRejectedValue(RATE_LIMITED);

    await post(app, '/v1/messages', {
      model: 'claude-sonnet-4-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(cooledKeys().length).toBeGreaterThan(0);
  });

  // ── Reached-but-not-their-fault: the cell that separates the two predicates ──

  it('does not rest a key for a 400 the provider rejected on our request shape', async () => {
    // Reached the provider (so the limiter charges it) and retryable (another
    // provider may accept params this one rejects) — but the key is healthy and
    // benching it helps nothing. This is the cell where "reached the provider"
    // and "provider's fault" disagree.
    chatCompletion.mockRejectedValue(
      Object.assign(new Error('flaky API error 400: unsupported parameter'), { status: 400 }),
    );

    await post(app, '/v1/responses', { input: 'hi' }, key);

    expect(cooledKeys()).toEqual([]);
  });

  // ── The dispatch-deadline row: retryable BUT not the provider's fault ──
  //
  // This block only became reachable when the two branches were integrated, and
  // it is the one combination neither could test alone. The retryability fix
  // makes ProviderTimeoutError match isRetryableError (lib/error-classify.ts),
  // so a timeout now walks the retry loop instead of being returned to the
  // client; providerAtFault deliberately answers NO for the same error, because
  // our deadline can fire before the connection is even established. Combined:
  // a provider timeout FAILS OVER and does NOT bench the key. An earlier
  // revision of this file carried a note saying a timeout never reaches a
  // cooldown site "because isRetryableError does not match it" — that premise
  // is now false, so these tests replace it.
  function timeoutError() {
    // Exactly what fetchWithTimeout throws (providers/base.ts): no status, and
    // a message none of the retryability substring rules cover.
    const e = new Error('Provider request timed out after 60000ms');
    e.name = 'ProviderTimeoutError';
    return e;
  }

  it('fails over to a later attempt on a provider timeout instead of erroring the client', async () => {
    chatCompletion
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValue({
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });

    const { status, body } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    // The failover half (the retryability fix): the slow attempt did not kill
    // the request. Before that fix this returned an error after one attempt.
    expect(status).toBe(200);
    expect(body.choices[0].message.content).toBe('ok');
    expect(chatCompletion.mock.calls.length).toBeGreaterThan(1);
    // The attribution half (the cooldown predicate): nothing was benched.
    expect(cooledKeys()).toEqual([]);
    expect(persistedCooldownRows()).toBe(0);
  });

  it('walks the whole chain on a total timeout without resting any key', async () => {
    chatCompletion.mockImplementation(async () => { throw timeoutError(); });

    const { status } = await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    // Retryable, so the loop rotated keys rather than bailing on attempt one.
    expect(chatCompletion.mock.calls.length).toBeGreaterThan(1);
    expect(status).toBeGreaterThanOrEqual(400);
    // But our own deadline is not evidence against any key: none rested, and
    // nothing persisted that would outlive the slow window.
    expect(cooledKeys()).toEqual([]);
    expect(persistedCooldownRows()).toBe(0);
  });

  it('rests the key on the same route when the provider itself answers 429', async () => {
    // Control for the pair above: the failover machinery is identical, so this
    // pins that dropping the timeout bench did not disarm the bench generally.
    chatCompletion.mockImplementation(async () => { throw RATE_LIMITED; });

    await post(app, '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hi' }],
    }, key);

    expect(cooledKeys().length).toBeGreaterThan(0);
  });
});
