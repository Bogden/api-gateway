import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { Express } from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { _resetChatgptCooldowns, setChatgptCooldown } from '../../services/chatgpt-cooldown.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import { setClaudeModelMap } from '../../services/anthropic-map.js';
import { ensureChatgptModel } from '../../routes/proxy.js';

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

// The Anthropic wire format — used by the Claude Code fork routed through CC
// Switch — sends the unified key in `x-api-key` rather than a bearer token.
function xApiKeyHeaders() {
  return { 'x-api-key': getUnifiedApiKey() };
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
    ensureChatgptModel(db, 'gpt-5-codex');
    setClaudeModelMap({ default: 'gpt-5-codex' });
  });

  function mockCodex(handler: (init?: RequestInit) => any) {
    const origFetch = global.fetch;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      const s = typeof url === 'string' ? url : url.toString();
      if (s === CODEX_URL) return handler(init);
      return origFetch(url as any, init as any);
    });
  }

  function sseResponse(frames: string[]): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        for (const frame of frames) controller.enqueue(enc.encode(frame));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }

  it('routes a gpt-* request to the chatgpt provider and returns the completion', async () => {
    mockCodex(() => sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}}\n\n',
    ]));

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

  it('keeps healthy opted-in luna traffic on chatgpt', async () => {
    ensureChatgptModel(getDb(), 'gpt-5.6-luna');
    mockCodex(() => sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"luna"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_luna","usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}}\n\n',
    ]));

    const res = await request(
      app,
      'POST',
      '/v1/messages',
      { model: 'gpt-5.6-luna', max_tokens: 100, messages: [{ role: 'user', content: 'ping' }], stream: false },
      { Authorization: 'Bearer caller-anthropic-oauth', 'x-api-gateway-anthropic-passthrough': '1' },
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-routed-via']).toBe('chatgpt/gpt-5.6-luna');
    expect(res.body.content).toEqual([{ type: 'text', text: 'luna' }]);
  });

  it('keeps exhausted luna traffic without opt-in on the existing visible-error path', async () => {
    ensureChatgptModel(getDb(), 'gpt-5.6-luna');
    setChatgptCooldown('gpt-5.6-luna', 60_000, 'window exhausted');
    const codex = vi.fn();
    mockCodex(codex);

    const res = await request(
      app,
      'POST',
      '/v1/messages',
      { model: 'gpt-5.6-luna', max_tokens: 100, messages: [{ role: 'user', content: 'ping' }], stream: false },
      xApiKeyHeaders(),
    );

    expect(res.status).toBe(429);
    expect(res.text).toContain('window exhausted');
    expect(codex).not.toHaveBeenCalled();
  });

  it('maps cached input usage on a non-streaming Anthropic response', async () => {
    mockCodex(() => sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_xak","usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":6},"output_tokens":1,"total_tokens":11}}}\n\n',
    ]));

    const res = await request(
      app,
      'POST',
      '/v1/messages',
      { model: 'gpt-5-codex', max_tokens: 100, messages: [{ role: 'user', content: 'ping' }], stream: false },
      xApiKeyHeaders(),
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-routed-via']).toBe('chatgpt/gpt-5-codex');
    expect(res.body.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(res.body.usage).toEqual({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 });
    const logged = getDb().prepare(`
      SELECT input_tokens, output_tokens, cache_read_input_tokens
      FROM requests ORDER BY id DESC LIMIT 1
    `).get() as any;
    expect(logged).toEqual({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 });
  });

  it('maps cached input usage on a streaming Anthropic response', async () => {
    mockCodex(() => sseResponse([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"input_tokens_details":{"cached_tokens":6},"output_tokens":1,"total_tokens":11}}}\n\n',
    ]));

    const res = await request(
      app,
      'POST',
      '/v1/messages',
      { model: 'gpt-5-codex', max_tokens: 100, messages: [{ role: 'user', content: 'ping' }], stream: true },
      xApiKeyHeaders(),
    );

    expect(res.status).toBe(200);
    expect(res.headers['x-routed-via']).toBe('chatgpt/gpt-5-codex');
    const events = res.text
      .split('\n\n')
      .map(frame => frame.split('\n').find(line => line.startsWith('data: '))?.slice(6))
      .filter(Boolean)
      .map(data => JSON.parse(data!));
    const delta = events.find(evt => evt.type === 'message_delta');
    expect(delta.usage).toEqual({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 });
    const logged = getDb().prepare(`
      SELECT input_tokens, output_tokens, cache_read_input_tokens
      FROM requests ORDER BY id DESC LIMIT 1
    `).get() as any;
    expect(logged).toEqual({ input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 6 });
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
