import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { _resetChatgptCooldowns, setChatgptCooldown } from '../../services/chatgpt-cooldown.js';

const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';

async function request(app: Express, bodyText: string, headers: Record<string, string> = {}) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  try {
    return await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: bodyText,
    });
  } finally {
    server.close();
  }
}

function mockAnthropic(handler: (init?: RequestInit) => Response | Promise<Response>) {
  const originalFetch = global.fetch;
  vi.spyOn(global, 'fetch').mockImplementation((url, init) => {
    if (url.toString() === UPSTREAM_URL) return Promise.resolve(handler(init));
    return originalFetch(url, init);
  });
}

describe('native Anthropic opt-in passthrough', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetChatgptCooldowns();
  });
  afterAll(() => vi.restoreAllMocks());

  it('forwards the exact body, caller credential, version, beta, and cache usage', async () => {
    const body = '{"model":"claude-sonnet-4-5","max_tokens":16,"messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]}';
    mockAnthropic(async init => {
      expect(Buffer.from(init?.body as Buffer).toString()).toBe(body);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer caller-oauth');
      expect(headers.get('anthropic-version')).toBe('2023-06-01');
      expect(headers.get('anthropic-beta')).toBe('prompt-caching-2024-07-31');
      expect(headers.has('x-api-gateway-anthropic-passthrough')).toBe(false);
      return new Response(JSON.stringify({
        id: 'msg_real', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'real claude' }], stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 9 },
      }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_real' } });
    });

    const response = await request(app, body, {
      authorization: 'Bearer caller-oauth',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-api-gateway-anthropic-passthrough': '1',
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('request-id')).toBe('req_real');
    expect((await response.json() as any).model).toBe('claude-sonnet-4-5');
    const row = getDb().prepare("SELECT * FROM requests WHERE platform = 'anthropic-passthrough' ORDER BY id DESC LIMIT 1").get() as any;
    expect(row).toMatchObject({ model_id: 'claude-sonnet-4-5', requested_model: 'claude-sonnet-4-5', input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 9, status: 'success' });
  });

  it('relays streaming bytes and records usage from start and delta events', async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_real","model":"claude-opus-4-1","usage":{"input_tokens":20,"output_tokens":0,"cache_read_input_tokens":15}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":4}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    mockAnthropic(() => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));

    const response = await request(app, JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }), {
      authorization: 'Bearer caller-oauth',
      'anthropic-version': '2023-06-01',
      'x-api-gateway-anthropic-passthrough': '1',
    });

    expect(await response.text()).toBe(sse);
    const row = getDb().prepare("SELECT * FROM requests WHERE platform = 'anthropic-passthrough' ORDER BY id DESC LIMIT 1").get() as any;
    expect(row).toMatchObject({ input_tokens: 20, output_tokens: 4, cache_read_input_tokens: 15, status: 'success' });
  });

  it('routes opted-in luna to native haiku only while its ChatGPT model is cooling down', async () => {
    const body = JSON.stringify({ model: 'gpt-5.6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
    setChatgptCooldown('gpt-5.6-luna', 60_000, 'window exhausted');
    mockAnthropic(async init => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'claude-haiku-4-5-20251001' });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer caller-oauth');
      return new Response(JSON.stringify({
        id: 'msg_fallback', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001',
        content: [{ type: 'text', text: 'haiku' }], stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const response = await request(app, body, {
      authorization: 'Bearer caller-oauth',
      'anthropic-version': '2023-06-01',
      'x-api-gateway-anthropic-passthrough': '1',
    });

    expect(response.status).toBe(200);
    expect((await response.json() as any).model).toBe('claude-haiku-4-5-20251001');
    const row = getDb().prepare("SELECT * FROM requests WHERE platform = 'anthropic-passthrough' AND model_id = 'claude-haiku-4-5-20251001' ORDER BY id DESC LIMIT 1").get() as any;
    expect(row).toMatchObject({ model_id: 'claude-haiku-4-5-20251001', requested_model: 'gpt-5.6-luna', status: 'success' });
  });

  it('does not passthrough without the exact opt-in or for a non-Claude model', async () => {
    const upstream = vi.fn(() => new Response('{}'));
    mockAnthropic(upstream);

    const noOptIn = await request(app, JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), { authorization: 'Bearer caller-oauth' });
    expect(noOptIn.status).not.toBe(200);
    const nonClaude = await request(app, JSON.stringify({ model: 'gpt-5.6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), { authorization: 'Bearer caller-oauth', 'x-api-gateway-anthropic-passthrough': '1' });
    expect(nonClaude.status).not.toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });
});
