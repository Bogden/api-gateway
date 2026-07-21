import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatGptProvider } from '../../providers/chatgpt.js';
import { codexAuthPath } from '../../lib/codex-auth.js';
import {
  isChatgptCoolingDown,
  getActiveChatgptCooldowns,
  _resetChatgptCooldowns,
} from '../../services/chatgpt-cooldown.js';
import type { ChatCompletionChunk } from '@api-gateway/shared/types.js';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

// A live (far-future) Codex login fixture, so no token refresh is attempted.
function writeLogin(): void {
  const farFuture = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
  fs.writeFileSync(
    codexAuthPath(),
    JSON.stringify({
      tokens: { access_token: jwt({ exp: farFuture }), refresh_token: 'rt', account_id: 'acct-xyz' },
    }),
  );
}

// A Response-shaped object backed by a real ReadableStream so the provider's
// res.body.getReader() SSE path runs for real.
function sseResponse(frames: string[]): any {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return { ok: true, status: 200, headers: new Headers(), body: stream };
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('ChatGptProvider', () => {
  let home: string;
  const origEnv = process.env.CODEX_HOME;
  let provider: ChatGptProvider;

  beforeEach(() => {
    vi.restoreAllMocks();
    _resetChatgptCooldowns();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-prov-'));
    process.env.CODEX_HOME = home;
    provider = new ChatGptProvider();
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
  });

  it('has the correct platform, is keyless, and validates without a key', async () => {
    expect(provider.platform).toBe('chatgpt');
    expect(provider.keyless).toBe(true);
    await expect(provider.validateKey('no-key')).resolves.toBe(true);
  });

  it('translates messages into a store:false Responses request with the ChatGPT auth headers', async () => {
    writeLogin();
    let capturedUrl = '';
    let capturedHeaders: any = {};
    let capturedBody: any = null;
    vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      capturedUrl = String(url);
      capturedHeaders = (init as any).headers;
      capturedBody = JSON.parse((init as any).body);
      return sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      ]);
    });

    await collect(
      provider.streamChatCompletion(
        'no-key',
        [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
        ],
        'gpt-5-codex',
        { tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }] },
      ),
    );

    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(capturedHeaders['Authorization']).toMatch(/^Bearer /);
    expect(capturedHeaders['chatgpt-account-id']).toBe('acct-xyz');
    expect(capturedHeaders['originator']).toBe('codex_cli_rs');
    expect(capturedBody.store).toBe(false);
    expect(capturedBody.stream).toBe(true);
    expect(capturedBody.instructions).toBe('be terse');
    expect(capturedBody.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
    expect(capturedBody.tools).toEqual([
      { type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } },
    ]);
  });

  it('streams a happy-path turn with a tool call and extracts usage', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Let me check. "}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"get_weather"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"paris\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}}}\n\n',
      ]) as any,
    );

    const chunks = await collect(
      provider.streamChatCompletion('no-key', [{ role: 'user', content: 'weather?' }], 'gpt-5'),
    );

    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Let me check. ');

    // Reassemble the tool call across deltas the way the proxy accumulator does.
    const acc = new Map<number, { id?: string; name: string; args: string }>();
    for (const c of chunks) {
      for (const tc of (c.choices[0]?.delta?.tool_calls ?? []) as any[]) {
        const idx = tc.index ?? 0;
        if (!acc.has(idx)) acc.set(idx, { id: undefined, name: '', args: '' });
        const a = acc.get(idx)!;
        if (tc.id) a.id = tc.id;
        if (tc.function?.name) a.name += tc.function.name;
        if (tc.function?.arguments) a.args += tc.function.arguments;
      }
    }
    expect(acc.size).toBe(1);
    const call = acc.get(0)!;
    expect(call.id).toBe('call_abc');
    expect(call.name).toBe('get_weather');
    expect(JSON.parse(call.args)).toEqual({ city: 'paris' });

    const last = chunks[chunks.length - 1]!;
    expect(last.choices[0]?.finish_reason).toBe('tool_calls');
    expect(last.usage).toEqual({ prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
  });

  it('extracts text + usage from a non-streaming completion', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello world' }] }],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      }),
    } as any);

    const res = await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5');
    expect(res.choices[0]?.message.content).toBe('hello world');
    expect(res.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(res._routed_via?.platform).toBe('chatgpt');
  });

  it('raises an actionable creds error when there is no Codex login (no upstream call)', async () => {
    // No writeLogin() → auth.json absent.
    const fetchSpy = vi.spyOn(global, 'fetch');
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5')),
    ).rejects.toThrow(/codex login/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('arms a distinctive cooldown on a 429 and short-circuits the next request', async () => {
    writeLogin();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '120' }),
      text: async () => 'rate limited',
    } as any);

    // First request hits the backend, gets 429, arms the cooldown, throws a
    // distinctive (non-retryable-classified) error carrying the cooldown code.
    let err: any;
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('CHATGPT_COOLDOWN');
    expect(err.status).toBe(429);
    expect(err.message).toMatch(/usage window exhausted/i);
    expect(isChatgptCoolingDown('gpt-5-codex')).toBe(true);

    const active = getActiveChatgptCooldowns();
    expect(active).toHaveLength(1);
    expect(active[0]!.modelId).toBe('gpt-5-codex');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second request short-circuits on the cooldown without calling upstream.
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'again' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
