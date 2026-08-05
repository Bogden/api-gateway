import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { ChatGptProvider } from '../../providers/chatgpt.js';
import { codexAuthPath } from '../../lib/codex-auth.js';
import {
  isChatgptCoolingDown,
  getActiveChatgptCooldowns,
  _resetChatgptCooldowns,
} from '../../services/chatgpt-cooldown.js';
import {
  getChatgptUsageSnapshots,
  _resetChatgptUsage,
} from '../../services/chatgpt-usage.js';
import type { ChatCompletionChunk } from '@api-gateway/shared/types.js';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

// A live (far-future) Codex login fixture, so no token refresh is attempted.
function writeLogin(accountId = 'acct-xyz'): void {
  const farFuture = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
  fs.writeFileSync(
    codexAuthPath(),
    JSON.stringify({
      tokens: { access_token: jwt({ exp: farFuture }), refresh_token: 'rt', account_id: accountId },
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

// The `x-codex-*` plan-usage headers the backend returns on every response.
function usageHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'x-codex-active-limit': 'premium',
    'x-codex-primary-used-percent': '7',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1785375709',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-secondary-reset-at': '',
    ...overrides,
  });
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
    _resetChatgptUsage();
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
        {
          // max_tokens MUST be stripped (the subscription backend 400s on
          // max_output_tokens); temperature/top_p MUST survive. (card c1881)
          max_tokens: 4096,
          temperature: 0.4,
          top_p: 0.9,
          tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }],
        },
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
    // The failing shape from card c1881: the max-tokens field must not reach the
    // Responses upstream in any form, while other tuning params are preserved.
    expect(capturedBody.max_output_tokens).toBeUndefined();
    expect(capturedBody.max_tokens).toBeUndefined();
    expect(capturedBody.temperature).toBe(0.4);
    expect(capturedBody.top_p).toBe(0.9);
  });

  it('preserves ordered text and image parts in the upstream Responses request', async () => {
    writeLogin();
    let capturedBody: any;
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as any).body);
      return sseResponse([
        'event: response.completed\\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\\n\\n',
      ]);
    });
    await collect(provider.streamChatCompletion('no-key', [{
      role: 'user',
      content: [
        { type: 'text', text: 'before' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: 'after' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.png' } },
      ],
    }], 'gpt-5', {}));
    expect(capturedBody.input).toEqual([{
      type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'before' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_text', text: 'after' },
        { type: 'input_image', image_url: 'https://example.com/image.png' },
      ],
    }]);
  });

  it('rejects unsupported image shapes before contacting Codex', async () => {
    writeLogin();
    const fetchSpy = vi.spyOn(global, 'fetch');
    await expect(collect(provider.streamChatCompletion('no-key', [{
      role: 'user',
      content: [{ type: 'image_url', image_url: 'https://example.com/image.png' }],
    }], 'gpt-5', {}))).rejects.toThrow(/image_url parts must use the object shape/i);
    await expect(collect(provider.streamChatCompletion('no-key', [{
      role: 'user',
      content: [{ image_url: { url: 'https://example.com/image.png' } }],
    }], 'gpt-5', {}))).rejects.toThrow(/image-bearing.*missing/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects image blocks in system and tool messages before contacting Codex', async () => {
    writeLogin();
    const fetchSpy = vi.spyOn(global, 'fetch');
    for (const message of [
      { role: 'system', content: [{ type: 'image_url', image_url: { url: 'https://example.com/system.png' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'image_url', image_url: { url: 'https://example.com/tool.png' } }] },
    ] as any[]) {
      await expect(collect(provider.streamChatCompletion('no-key', [message], 'gpt-5', {}))).rejects.toThrow(/user messages/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects provider-generated image output instead of returning an empty completion', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: 'r', output: [{ type: 'message', content: [{ type: 'output_image', image_url: 'data:image/png;base64,AAAA' }] }] }),
    } as any);
    await expect(provider.chatCompletion('no-key', [{ role: 'user', content: 'draw' }], 'gpt-5', {})).rejects.toThrow(/provider image output/i);
  });

  it('remaps minimal reasoning effort to low on codex models, but not on other models', async () => {
    writeLogin();
    const bodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      ]);
    });

    // gpt-5-codex has no 'minimal' preset (API limitation) -> remapped to 'low'.
    await collect(provider.streamChatCompletion(
      'no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex', { reasoning_effort: 'minimal' },
    ));
    // Non-codex models keep 'minimal' unchanged.
    await collect(provider.streamChatCompletion(
      'no-key', [{ role: 'user', content: 'hi' }], 'gpt-5', { reasoning_effort: 'minimal' },
    ));
    // xhigh/max clamp to 'high' regardless of model, unaffected by the codex remap.
    await collect(provider.streamChatCompletion(
      'no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex', { reasoning_effort: 'xhigh' },
    ));

    expect(bodies[0].reasoning).toEqual({ effort: 'low' });
    expect(bodies[1].reasoning).toEqual({ effort: 'minimal' });
    expect(bodies[2].reasoning).toEqual({ effort: 'high' });
  });

  it('uses the stable system-and-tools prefix for the prompt cache key', async () => {
    writeLogin();
    const bodies: any[] = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse((init as any).body));
      return sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      ]);
    });

    const tools = [{ type: 'function' as const, function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }];
    await collect(provider.streamChatCompletion(
      'no-key',
      [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'first turn' }],
      'gpt-5-codex',
      { tools },
    ));
    await collect(provider.streamChatCompletion(
      'no-key',
      [
        { role: 'system', content: 'be terse' },
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'second turn' },
      ],
      'gpt-5-codex',
      { tools },
    ));
    await collect(provider.streamChatCompletion(
      'no-key',
      [{ role: 'system', content: 'be expansive' }, { role: 'user', content: 'first turn' }],
      'gpt-5-codex',
      { tools },
    ));

    expect(bodies).toHaveLength(3);
    expect(bodies[0].prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(bodies[1].prompt_cache_key).toBe(bodies[0].prompt_cache_key);
    expect(bodies[2].prompt_cache_key).not.toBe(bodies[0].prompt_cache_key);
    expect(bodies[0].prompt_cache_retention).toBeUndefined();
    expect(bodies[0].previous_response_id).toBeUndefined();
  });

  it('keeps a late system reminder in input without changing cache affinity', async () => {
    writeLogin();
    const calls: Array<{ body: any; headers: any }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      calls.push({ body: JSON.parse((init as any).body), headers: (init as any).headers });
      return sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      ]);
    });

    const tools = [{ type: 'function' as const, function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }];
    const priorMessages: any[] = [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'I will check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '/workspace' },
      { role: 'user', content: 'continue' },
    ];

    await collect(provider.streamChatCompletion(
      'no-key', priorMessages, 'gpt-5-codex', { tools, prompt_cache_key: 'ccrun:stable' },
    ));
    await collect(provider.streamChatCompletion(
      'no-key', [...priorMessages, { role: 'system', content: 'Late reminder: use concise output.' }], 'gpt-5-codex',
      { tools, prompt_cache_key: 'ccrun:stable' },
    ));

    const [before, after] = calls;
    expect(after.body.instructions).toBe(before.body.instructions);
    expect(after.body.prompt_cache_key).toBe(before.body.prompt_cache_key);
    expect(after.headers.session_id).toBe(before.headers.session_id);
    expect(after.body.input.slice(0, before.body.input.length)).toEqual(before.body.input);
    expect(after.body.input).toHaveLength(before.body.input.length + 1);
    expect(after.body.input.at(-1)).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<system-reminder>\nLate reminder: use concise output.\n</system-reminder>' }],
    });
  });

  it('keeps session id and cache key stable per conversation key, and distinct across keys', async () => {
    writeLogin();
    const calls: Array<{ body: any; headers: any }> = [];
    vi.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      calls.push({ body: JSON.parse((init as any).body), headers: (init as any).headers });
      return sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
      ]);
    });

    const tools = [{ type: 'function' as const, function: { name: 'shell', description: 'run', parameters: { type: 'object' } } }];
    const turn = (userText: string, prompt_cache_key?: string) =>
      collect(provider.streamChatCompletion(
        'no-key',
        [{ role: 'system', content: 'be terse' }, { role: 'user', content: userText }],
        'gpt-5-codex',
        { tools, ...(prompt_cache_key ? { prompt_cache_key } : {}) },
      ));

    // Same conversation key, two different turns.
    await turn('first turn', 'ccrun:abc');
    await turn('second turn', 'ccrun:abc');
    // A different conversation, identical instructions + tools.
    await turn('first turn', 'ccrun:xyz');
    // No caller key at all — legacy behavior.
    await turn('first turn');

    const [a, b, c, legacy] = calls;
    expect(a.body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(b.body.prompt_cache_key).toBe(a.body.prompt_cache_key);
    expect(a.headers.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(b.headers.session_id).toBe(a.headers.session_id);

    expect(c.body.prompt_cache_key).not.toBe(a.body.prompt_cache_key);
    expect(c.headers.session_id).not.toBe(a.headers.session_id);

    // No caller key → the old system-and-tools prefix hash, unchanged.
    expect(legacy.body.prompt_cache_key).toBe(
      createHash('sha256')
        .update(JSON.stringify({
          instructions: 'be terse',
          tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }],
        }))
        .digest('hex'),
    );
    expect(legacy.body.prompt_cache_key).not.toBe(a.body.prompt_cache_key);
  });

  it('fails fast on a deterministic 400 (marked non-retryable, upstream error passed through)', async () => {
    writeLogin();
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => '{"detail":"Unsupported parameter: max_output_tokens"}',
    } as any);

    let err: any;
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // The proxy's recovery loop honors this flag to fail fast instead of
    // grinding the whole retry budget on a deterministic client error.
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(400);
    // The upstream detail is passed through to the caller.
    expect(err.message).toMatch(/Unsupported parameter: max_output_tokens/);
    // No retry attempted at the provider seam.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('marks a 422 non-retryable too, but leaves 5xx retryable', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 422, headers: new Headers(), text: async () => 'unprocessable',
    } as any);
    let err422: any;
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex'));
    } catch (e) { err422 = e; }
    expect(err422.retryable).toBe(false);

    // A 500 stays retryable (retryable flag left undefined → proxy decides).
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false, status: 500, headers: new Headers(), text: async () => 'boom',
    } as any);
    let err500: any;
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5'));
    } catch (e) { err500 = e; }
    expect(err500.retryable).toBeUndefined();
    expect(err500.status).toBe(500);
  });

  it('streams a happy-path turn with a tool call and extracts usage', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Let me check. "}\n\n',
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"call_abc","name":"get_weather"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"city\\":"}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"\\"paris\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":8},"output_tokens":7,"total_tokens":19}}}\n\n',
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

    // Usage rides a trailing choice-less frame (OpenAI include_usage shape);
    // the finish_reason lives on the chunk just before it.
    const last = chunks[chunks.length - 1]!;
    expect(last.choices).toEqual([]);
    expect(last.usage).toEqual({
      prompt_tokens: 4,
      completion_tokens: 7,
      total_tokens: 19,
      cache_read_input_tokens: 8,
    });
    const finishChunk = chunks[chunks.length - 2]!;
    expect(finishChunk.choices[0]?.finish_reason).toBe('tool_calls');
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
        usage: {
          input_tokens: 5,
          input_tokens_details: { cached_tokens: 3 },
          output_tokens: 2,
          total_tokens: 7,
        },
      }),
    } as any);

    const res = await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5');
    expect(res.choices[0]?.message.content).toBe('hello world');
    expect(res.usage).toEqual({
      prompt_tokens: 2,
      completion_tokens: 2,
      total_tokens: 7,
      cache_read_input_tokens: 3,
    });
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

  it('revalidates a long cooldown with exponential backoff and clears it on early recovery', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    writeLogin();

    const recovered = sseResponse([
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]);
    recovered.headers = usageHeaders({ 'x-codex-primary-used-percent': '3' });
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': String(24 * 60 * 60) }),
        text: async () => 'rate limited',
      } as any)
      .mockResolvedValueOnce(recovered as any);

    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'first' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);

    // Ordinary traffic remains short-circuited before the first probe window.
    now += 4 * 60 * 1000;
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'blocked' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Exactly one request is admitted after five minutes. Its success both
    // refreshes usage and clears the stale long cooldown.
    now += 60 * 1000;
    await collect(
      provider.streamChatCompletion('no-key', [{ role: 'user', content: 'probe' }], 'gpt-5-codex'),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(isChatgptCoolingDown('gpt-5-codex')).toBe(false);
    expect(getChatgptUsageSnapshots()[0]!.primary!.usedPercent).toBe(3);
  });

  it('backs off repeated cooldown probes instead of resetting to five-minute polling', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    writeLogin();
    const rejection = () => ({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': String(24 * 60 * 60) }),
      text: async () => 'rate limited',
    } as any);
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockImplementation(async () => rejection());

    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'initial' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);

    now += 5 * 60 * 1000;
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'first probe' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A rejected first probe advances the next window to ten minutes. It does
    // not restart the five-minute cadence when handle429 re-arms the cooldown.
    now += 5 * 60 * 1000;
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'too soon' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    now += 5 * 60 * 1000;
    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'second probe' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not carry a cooldown across a Codex account switch', async () => {
    writeLogin('acct-old');
    const ok = sseResponse([
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]);
    const fetchSpy = vi.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': String(24 * 60 * 60) }),
        text: async () => 'rate limited',
      } as any)
      .mockResolvedValueOnce(ok as any);

    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'old' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(getActiveChatgptCooldowns()).toHaveLength(1);

    writeLogin('acct-new');
    // The status surface must stop reporting the old account before a provider
    // request, otherwise the console's pre-dispatch health gate still blocks.
    expect(getActiveChatgptCooldowns()).toHaveLength(0);

    await collect(
      provider.streamChatCompletion('no-key', [{ role: 'user', content: 'new' }], 'gpt-5-codex'),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('preserves cooldown status while the credential file is temporarily unreadable', async () => {
    writeLogin('acct-stable');
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': String(24 * 60 * 60) }),
      text: async () => 'rate limited',
    } as any);

    await expect(
      collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'arm' }], 'gpt-5-codex')),
    ).rejects.toThrow(/usage window exhausted/i);
    expect(getActiveChatgptCooldowns()).toHaveLength(1);

    fs.writeFileSync(codexAuthPath(), '{');
    expect(getActiveChatgptCooldowns()).toHaveLength(1);

    writeLogin('acct-stable');
    expect(getActiveChatgptCooldowns()).toHaveLength(1);
  });

  it('captures the plan-usage snapshot from response headers on a streaming turn', async () => {
    writeLogin();
    const res = sseResponse([
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
    ]);
    res.headers = usageHeaders({ 'x-codex-primary-used-percent': '42' });
    vi.spyOn(global, 'fetch').mockResolvedValue(res as any);

    await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5'));

    const snaps = getChatgptUsageSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.limitId).toBe('premium');
    expect(snaps[0]!.primary).toEqual({ usedPercent: 42, windowMinutes: 10080, resetsAt: 1785375709 });
    expect(snaps[0]!.secondary).toBeNull();
  });

  it('captures the plan-usage snapshot from response headers on a non-streaming turn', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: usageHeaders({ 'x-codex-primary-used-percent': '55' }),
      json: async () => ({
        id: 'resp_1',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
    } as any);

    await provider.chatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5');
    const snaps = getChatgptUsageSnapshots();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.primary!.usedPercent).toBe(55);
  });

  it('never fails a request when usage headers are absent (older/changed upstream)', async () => {
    writeLogin();
    vi.spyOn(global, 'fetch').mockResolvedValue(
      sseResponse([
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      ]) as any,
    );
    const chunks = await collect(
      provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5'),
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(getChatgptUsageSnapshots()).toHaveLength(0);
  });

  it('prefers the fresh snapshot resets_at over the 5-min default when a 429 has no Retry-After', async () => {
    writeLogin();
    const resetSec = Math.floor(Date.now() / 1000) + 20 * 60; // window resets in ~20 min

    // First: a successful turn that seeds a fresh usage snapshot.
    const ok = sseResponse([
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]);
    ok.headers = usageHeaders({ 'x-codex-primary-reset-at': String(resetSec) });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(ok as any);
    await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex'));

    // Then: a 429 with NO Retry-After. Cooldown should track the snapshot's
    // resets_at (~20 min), well beyond the flat 5-minute default.
    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 429, headers: new Headers(), text: async () => 'rate limited',
    } as any);
    let err: any;
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'again' }], 'gpt-5-codex'));
    } catch (e) { err = e; }
    expect(err.code).toBe('CHATGPT_COOLDOWN');

    const active = getActiveChatgptCooldowns();
    expect(active).toHaveLength(1);
    // Comfortably longer than the 5-minute default → snapshot preference took effect.
    expect(active[0]!.remainingMs).toBeGreaterThan(10 * 60 * 1000);
  });

  it('keeps the 5-min default on a 429 with no Retry-After when the snapshot reset is stale/past', async () => {
    writeLogin();
    const pastSec = Math.floor(Date.now() / 1000) - 60; // already reset

    const ok = sseResponse([
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ]);
    ok.headers = usageHeaders({ 'x-codex-primary-reset-at': String(pastSec) });
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(ok as any);
    await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'hi' }], 'gpt-5-codex'));

    fetchSpy.mockResolvedValueOnce({
      ok: false, status: 429, headers: new Headers(), text: async () => 'rate limited',
    } as any);
    try {
      await collect(provider.streamChatCompletion('no-key', [{ role: 'user', content: 'again' }], 'gpt-5-codex'));
    } catch { /* expected */ }

    const active = getActiveChatgptCooldowns();
    expect(active).toHaveLength(1);
    // Falls back to the flat 5-minute default (≤ 5 min remaining).
    expect(active[0]!.remainingMs).toBeLessThanOrEqual(5 * 60 * 1000);
    expect(active[0]!.remainingMs).toBeGreaterThan(4 * 60 * 1000);
  });
});
