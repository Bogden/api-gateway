import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Express } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { _resetChatgptCooldowns } from '../../services/chatgpt-cooldown.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) && !('Authorization' in headers) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  server.close();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: Object.fromEntries(res.headers) };
}

function authHeaders() {
  return { Authorization: `Bearer ${getUnifiedApiKey()}` };
}

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

// The Codex responses endpoint; everything else is delegated to the real fetch
// so the test harness can still reach its own express server.
const CODEX_URL = 'https://chatgpt.com/backend-api/codex/responses';

describe('ChatGPT provider routing (/v1/chat/completions, gpt-*)', () => {
  let app: Express;
  let codexHome: string;
  const origEnv = process.env.CODEX_HOME;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();

    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e2e-'));
    process.env.CODEX_HOME = codexHome;
    const farFuture = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
    fs.writeFileSync(
      path.join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: jwt({ exp: farFuture }), refresh_token: 'rt', account_id: 'acct' } }),
    );
  });

  afterAll(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
  });

  beforeEach(async () => {
    const db = getDb();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare("DELETE FROM models WHERE platform = 'chatgpt'").run();
    _resetChatgptCooldowns();
    // Register the keyless chatgpt provider (sentinel key, no key material).
    const add = await request(app, 'POST', '/api/keys', { platform: 'chatgpt', label: 'codex' });
    expect(add.status).toBe(201);
  });

  function mockCodex(handler: () => any) {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const s = typeof url === 'string' ? url : url.toString();
      if (s === CODEX_URL) return handler();
      return origFetch(url as any, init as any);
    });
  }

  it('routes a gpt-* request to the chatgpt provider and returns the completion', async () => {
    mockCodex(() => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'pong' }] }],
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      }),
    }));

    const res = await request(
      app,
      'POST',
      '/v1/chat/completions',
      { model: 'gpt-5-codex', messages: [{ role: 'user', content: 'ping' }], stream: false },
      authHeaders(),
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-routed-via']).toBe('chatgpt/gpt-5-codex');
    expect(res.body.choices[0].message.content).toBe('pong');

    // The auto-provisioned catalog row must NOT be enrolled in the auto bandit.
    const inChain = getDb().prepare(`
      SELECT COUNT(*) AS n FROM fallback_config fc
      JOIN models m ON m.id = fc.model_db_id
      WHERE m.platform = 'chatgpt' AND fc.enabled = 1
    `).get() as { n: number };
    expect(inChain.n).toBe(0);
  });

  it('returns a distinctive 429 and surfaces the cooldown on /api/health', async () => {
    let codexCalls = 0;
    mockCodex(() => {
      codexCalls++;
      return {
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '300' }),
        text: async () => 'too many',
      };
    });

    const res = await request(
      app,
      'POST',
      '/v1/chat/completions',
      { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: false },
      authHeaders(),
    );
    expect(res.status).toBe(429);
    expect(res.body.error.message).toMatch(/usage window exhausted/i);
    // Terminal cooldown: the plan is probed exactly once, never ground through
    // the 1-RPM recovery loop.
    expect(codexCalls).toBe(1);

    const health = await request(app, 'GET', '/api/health');
    expect(health.status).toBe(200);
    const cds = health.body.chatgptCooldowns;
    expect(Array.isArray(cds)).toBe(true);
    expect(cds.map((c: any) => c.modelId)).toContain('gpt-5');
  });

  it('returns an actionable creds error when the Codex login is missing', async () => {
    // Point at an empty Codex home so auth.json is absent for this request.
    const prev = process.env.CODEX_HOME;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-empty-'));
    process.env.CODEX_HOME = empty;
    try {
      const res = await request(
        app,
        'POST',
        '/v1/chat/completions',
        { model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }], stream: false },
        authHeaders(),
      );
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/codex login/i);
    } finally {
      process.env.CODEX_HOME = prev;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
