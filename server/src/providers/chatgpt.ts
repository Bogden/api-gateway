import crypto from 'crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  Platform,
} from '@api-gateway/shared/types.js';
import {
  BaseProvider,
  providerHttpError,
  parseRetryAfterMs,
  RequestAbortError,
  type CompletionOptions,
  type ProviderHttpError,
} from './base.js';
import { contentToString } from '../lib/content.js';
import { getCodexCredential, CodexCredentialsError } from '../lib/codex-auth.js';
import {
  setChatgptCooldown,
  clearChatgptCooldown,
  getChatgptCooldown,
} from '../services/chatgpt-cooldown.js';
import {
  recordChatgptUsageFromHeaders,
  getChatgptCooldownHintMs,
} from '../services/chatgpt-usage.js';

// ────────────────────────────────────────────────────────────────────────────
// ChatGPT subscription provider.
//
// Lets Anthropic-wire clients (the Claude Code fork, via CC Switch's client-side
// Anthropic→OpenAI translation) run on a ChatGPT plan. It sits at the same
// BaseProvider seam as the Anthropic↔OpenAI translation provider: it receives
// the gateway's internal OpenAI-wire ChatMessage[] and emits internal
// ChatCompletionChunk / ChatCompletionResponse. Upstream, it translates to the
// OpenAI **Responses API** and authenticates on a ChatGPT subscription using the
// Codex CLI credential store (see lib/codex-auth.ts).
//
// Ported from bman654/clodex (MIT) — the Responses request/stream shaping and
// store:false handling — adapted to this gateway's structure. clodex uses a
// WebSocket Responses transport for plan OAuth; this port uses the canonical
// Codex HTTP+SSE transport instead (POST backend-api/codex/responses), which
// fits the gateway's fetch/SSE provider model and is exercisable with recorded
// SSE fixtures.
//
// Routing: only reached for model ids matching /^gpt-/ (see routes/proxy.ts and
// services/router.ts). Excluded from the free-cascade auto bandit; pin-only.
// On 429/window-exhaustion it arms a distinctive cooldown (services/
// chatgpt-cooldown.ts) and never silently falls back to another provider.
// ────────────────────────────────────────────────────────────────────────────

// The ChatGPT-backed Codex Responses endpoint. `/responses` is appended per
// request. This is an undocumented, no-SLA backend gated behind a ChatGPT
// subscription — it can change without notice.
const CODEX_RESPONSES_BASE = 'https://chatgpt.com/backend-api/codex';

// Subscription rate limits are bound to a rolling window that resets in hours,
// not per-minute — so when the backend gives no explicit Retry-After we bench
// the model for a conservative default rather than probing every few seconds.
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// When a 429 carries no Retry-After, a recent plan-usage snapshot's primary
// window reset is a better cooldown estimate than the flat default — but only
// while it's fresh enough to still describe the live window.
const USAGE_SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

// The Codex backend rejects requests without a mandatory `instructions` field;
// use a minimal default when the client sent no system message.
const DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

const STREAM_INACTIVITY_TIMEOUT_MS = 300_000;

interface ResponsesRequestBody {
  model: string;
  instructions: string;
  prompt_cache_key: string;
  input: ResponsesInputItem[];
  tools?: Array<{ type: 'function'; name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean }>;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  // NB: no max_output_tokens — the subscription backend rejects it (card c1881).
  reasoning?: { effort?: string };
  // Subscription OAuth requires store:false; some OpenAI cache controls are
  // dropped under it, which we accept.
  store: false;
  stream: boolean;
  // The Codex backend expects encrypted reasoning to be carried across turns.
  include: string[];
}

type ResponsesInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: Array<{ type: 'input_text' | 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export class ChatGptProvider extends BaseProvider {
  readonly platform: Platform = 'chatgpt';
  readonly name = 'ChatGPT (Codex subscription)';
  // Creds come from ~/.codex/auth.json, not from a stored API key. Keyless so
  // routing treats the platform as configured via a sentinel key row and no
  // Authorization header is built from the (absent) stored key.
  keyless = true;
  baseUrl = CODEX_RESPONSES_BASE;

  private readonly timeoutMs: number;

  constructor(opts?: { timeoutMs?: number }) {
    super();
    // ChatGPT-plan turns (especially gpt-*-codex with reasoning) routinely run
    // long; match the extended timeout used for other slow upstreams.
    this.timeoutMs = opts?.timeoutMs ?? 120_000;
  }

  // Creds are validated lazily on the first real request (a keyless provider
  // has no key to check here). Return true so the health checker / Keys page
  // treat the sentinel row as usable.
  async validateKey(_apiKey: string): Promise<boolean> {
    return true;
  }

  // ── Request translation: internal ChatMessage[] → Responses request ────────
  private buildRequestBody(
    messages: ChatMessage[],
    modelId: string,
    options: CompletionOptions | undefined,
    stream: boolean,
  ): ResponsesRequestBody {
    const systemParts: string[] = [];
    const input: ResponsesInputItem[] = [];

    for (const m of messages) {
      if (m.role === 'system') {
        const text = contentToString(m.content ?? '');
        if (text) systemParts.push(text);
        continue;
      }
      if (m.role === 'tool') {
        input.push({
          type: 'function_call_output',
          call_id: m.tool_call_id ?? '',
          output: contentToString(m.content ?? ''),
        });
        continue;
      }
      if (m.role === 'assistant') {
        const text = contentToString(m.content ?? '');
        if (text) {
          input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
        }
        for (const tc of m.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments ?? '',
          });
        }
        continue;
      }
      // user (and any other non-system role) → input_text message
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: contentToString(m.content ?? '') }],
      });
    }

    const instructions = systemParts.join('\n\n') || DEFAULT_INSTRUCTIONS;
    const tools = options?.tools
      ?.filter((t) => t.type === 'function' && t.function?.name)
      .map((t) => ({
        type: 'function' as const,
        name: t.function.name,
        ...(t.function.description ? { description: t.function.description } : {}),
        ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
        ...(t.function.strict != null ? { strict: t.function.strict } : {}),
      }));

    const body: ResponsesRequestBody = {
      model: modelId,
      instructions,
      prompt_cache_key: effectiveCacheKey(options?.prompt_cache_key, instructions, tools ?? []),
      input,
      store: false,
      stream,
      include: ['reasoning.encrypted_content'],
    };

    if (tools?.length) body.tools = tools;
    if (options?.tool_choice != null) body.tool_choice = options.tool_choice;
    if (options?.parallel_tool_calls != null) body.parallel_tool_calls = options.parallel_tool_calls;
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.top_p != null) body.top_p = options.top_p;
    // Deliberately DO NOT forward max_tokens as max_output_tokens. The ChatGPT
    // subscription Responses backend (chatgpt.com/backend-api/codex/responses)
    // rejects max_output_tokens with `400 Unsupported parameter`, so every
    // harness-driven request (the Anthropic wire always sends a max-tokens
    // field) failed. Prior art bman654/clodex (MIT) omits the field entirely on
    // its OpenAI-OAuth subscription path for the same reason — an explicit
    // max_output_tokens there yields a broken finish — so we strip it too. All
    // other parameters are preserved. (card c1881)

    const effort = options?.reasoning_effort ?? options?.thinking?.effort;
    if (effort) {
      let clamped = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
      // gpt-5-codex family has no 'minimal' reasoning preset (API limitation); prior
      // art jxstanford/opencode-openai-codex-auth remaps minimal->low for codex too.
      if (clamped === 'minimal' && modelId.toLowerCase().includes('codex')) clamped = 'low';
      body.reasoning = { effort: clamped };
    }

    return body;
  }

  private async buildHeaders(
    stream: boolean,
    sessionId: string,
    forceRefresh = false,
  ): Promise<Record<string, string>> {
    const cred = await getCodexCredential(forceRefresh);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${cred.accessToken}`,
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream' : 'application/json',
      // Codex requires these on every request; dropping chatgpt-account-id
      // causes 401/403 from the backend.
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
      'User-Agent': 'api-gateway-codex/1.0',
      session_id: sessionId,
    };
    if (cred.accountId) headers['chatgpt-account-id'] = cred.accountId;
    return headers;
  }

  // Guard: refuse to hit the plan while it is cooling down from a prior 429.
  private assertNotCoolingDown(modelId: string): void {
    const cd = getChatgptCooldown(modelId);
    if (cd) {
      throw this.cooldownError(modelId, cd.reason, cd.remainingMs);
    }
  }

  // A distinctive, non-retryable error (its message avoids the substrings the
  // proxy's retry classifier treats as retryable, so the request is not failed
  // over to another provider or ground through 1-RPM recovery).
  private cooldownError(modelId: string, reason: string, remainingMs: number): ProviderHttpError {
    const mins = Math.ceil(remainingMs / 60000);
    const err = new Error(
      `ChatGPT subscription usage window exhausted for '${modelId}' — cooling down ~${mins} min. ` +
        `${reason} This is a plan-level limit, not an API key issue; wait for the window to reset.`,
    ) as ProviderHttpError;
    err.status = 429;
    (err as ProviderHttpError & { code?: string }).code = 'CHATGPT_COOLDOWN';
    return err;
  }

  // Arm a cooldown from a 429 response and return the distinctive error.
  private handle429(modelId: string, res: Response): ProviderHttpError {
    // Prefer an explicit Retry-After. Absent that, fall back to the last plan-
    // usage snapshot's primary reset time (when it's fresh and still in the
    // future) before the flat default — it reflects the real window boundary.
    const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
    const cooldownMs =
      retryAfterMs ?? getChatgptCooldownHintMs(USAGE_SNAPSHOT_MAX_AGE_MS) ?? DEFAULT_COOLDOWN_MS;
    // Deliberately digit-free: the proxy's retry classifier treats "429" (and
    // "rate limit", "quota", …) as retryable, which would drive the plan into
    // the 1-RPM recovery loop and hammer it. This cooldown must be terminal.
    const reason = 'Backend signalled the subscription usage window is exhausted.';
    setChatgptCooldown(modelId, cooldownMs, reason);
    return this.cooldownError(modelId, reason, cooldownMs);
  }

  // POST to the Responses endpoint, refreshing the token once on a 401 (the
  // reactive refresh-and-retry path). Throws on non-OK responses.
  private async post(
    body: ResponsesRequestBody,
    stream: boolean,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const url = `${CODEX_RESPONSES_BASE}/responses`;
    // Same conversation → same session id, for the backend's cache affinity.
    const sessionId = sessionIdForCacheKey(body.prompt_cache_key);
    const doFetch = async (forceRefresh: boolean) => {
      const headers = await this.buildHeaders(stream, sessionId, forceRefresh);
      return this.fetchWithTimeout(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        this.timeoutMs,
        abortSignal,
      );
    };

    let res = await doFetch(false);
    if (res.status === 401) {
      // Access token rejected despite looking valid — refresh once and retry.
      res = await doFetch(true);
    }

    if (res.status === 429) {
      throw this.handle429(body.model, res);
    }
    if (res.status === 401 || res.status === 403) {
      throw new CodexCredentialsError(
        `the ChatGPT backend rejected the session (HTTP ${res.status})`,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 500);
      } catch {
        /* ignore */
      }
      const err = providerHttpError(res, `ChatGPT Responses API error ${res.status}: ${detail}`);
      // A deterministic client-side rejection (400 Bad Request / 422
      // Unprocessable Entity) will fail identically on every retry — mark it
      // non-retryable so the proxy fails fast and passes the upstream error
      // through instead of burning the whole recovery budget (which turned a
      // single 400 into "429 · Recovery limit reached after 6 attempts").
      // 429/5xx are handled above / left retryable, so their behavior is
      // unchanged. (card c1881)
      if (res.status === 400 || res.status === 422) err.retryable = false;
      throw err;
    }
    // Capture the plan-usage snapshot the backend reports on every response via
    // `x-codex-*` headers (card c2054). Best-effort — never fails a request.
    // Reading headers does not consume the (still-unread) streaming body.
    recordChatgptUsageFromHeaders(res.headers);
    // A successful call clears any prior cooldown for this model.
    clearChatgptCooldown(body.model);
    return res;
  }

  // ── Non-streaming completion ───────────────────────────────────────────────
  async chatCompletion(
    _apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): Promise<ChatCompletionResponse> {
    this.assertNotCoolingDown(modelId);
    const body = this.buildRequestBody(messages, modelId, options, false);
    const res = await this.post(body, false, options?.abortSignal);
    const json = (await res.json()) as ResponsesApiResponse;
    return this.toCompletionResponse(json, modelId);
  }

  private toCompletionResponse(json: ResponsesApiResponse, modelId: string): ChatCompletionResponse {
    let text = '';
    const toolCalls: ChatToolCall[] = [];
    for (const item of json.output ?? []) {
      if (item.type === 'message') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text' && typeof part.text === 'string') text += part.text;
        }
      } else if (item.type === 'function_call') {
        toolCalls.push({
          id: item.call_id ?? item.id ?? '',
          type: 'function',
          function: { name: item.name ?? '', arguments: item.arguments ?? '' },
        });
      }
    }
    const openAiInputTokens = json.usage?.input_tokens ?? 0;
    const cachedTokens = json.usage?.input_tokens_details?.cached_tokens ?? 0;
    const promptTokens = Math.max(0, openAiInputTokens - cachedTokens);
    const completionTokens = json.usage?.output_tokens ?? 0;
    return {
      id: json.id ?? this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: json.usage?.total_tokens ?? openAiInputTokens + completionTokens,
        cache_read_input_tokens: cachedTokens,
      },
      _routed_via: { platform: this.platform, model: modelId },
    };
  }

  // ── Streaming completion ───────────────────────────────────────────────────
  async *streamChatCompletion(
    _apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
  ): AsyncGenerator<ChatCompletionChunk> {
    this.assertNotCoolingDown(modelId);
    const body = this.buildRequestBody(messages, modelId, options, true);
    const res = await this.post(body, true, options?.abortSignal);

    const created = Math.floor(Date.now() / 1000);
    const id = this.makeId();
    const mkChunk = (
      delta: ChatCompletionChunk['choices'][number]['delta'],
      finish_reason: string | null,
      usage?: ChatCompletionChunk['usage'],
    ): ChatCompletionChunk => ({
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason }],
      ...(usage ? { usage } : {}),
    });

    // Map a Responses output_index → a contiguous tool-call index the OpenAI
    // accumulator groups on. function_call args deltas reference the same
    // output_index, so we translate through this map.
    const toolIndexByOutput = new Map<number, number>();
    let nextToolIndex = 0;
    let sawToolCall = false;
    let usage: ChatCompletionChunk['usage'] | undefined;

    for await (const evt of this.readResponsesStream(res, modelId, options?.abortSignal)) {
      const type = evt.type;
      if (type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        yield mkChunk({ content: evt.delta }, null);
      } else if (
        (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') &&
        typeof evt.delta === 'string'
      ) {
        yield mkChunk({ reasoning_content: evt.delta }, null);
      } else if (type === 'response.output_item.added' && evt.item?.type === 'function_call') {
        const outputIndex = typeof evt.output_index === 'number' ? evt.output_index : nextToolIndex;
        const toolIndex = nextToolIndex++;
        toolIndexByOutput.set(outputIndex, toolIndex);
        sawToolCall = true;
        yield mkChunk(
          {
            tool_calls: [
              {
                index: toolIndex,
                id: evt.item.call_id ?? evt.item.id ?? '',
                type: 'function',
                function: { name: evt.item.name ?? '', arguments: '' },
              },
            ] as unknown as ChatToolCall[],
          },
          null,
        );
      } else if (type === 'response.function_call_arguments.delta' && typeof evt.delta === 'string') {
        const outputIndex = typeof evt.output_index === 'number' ? evt.output_index : 0;
        const toolIndex = toolIndexByOutput.get(outputIndex) ?? 0;
        yield mkChunk(
          {
            tool_calls: [
              { index: toolIndex, function: { arguments: evt.delta } },
            ] as unknown as ChatToolCall[],
          },
          null,
        );
      } else if (type === 'response.completed' && evt.response?.usage) {
        const u = evt.response.usage;
        const openAiInputTokens = u.input_tokens ?? 0;
        const cachedTokens = u.input_tokens_details?.cached_tokens ?? 0;
        usage = {
          prompt_tokens: Math.max(0, openAiInputTokens - cachedTokens),
          completion_tokens: u.output_tokens ?? 0,
          total_tokens: u.total_tokens ?? openAiInputTokens + (u.output_tokens ?? 0),
          cache_read_input_tokens: cachedTokens,
        };
      } else if (type === 'response.failed' || type === 'error') {
        const msg = evt.response?.error?.message ?? evt.error?.message ?? 'ChatGPT Responses stream failed';
        throw new Error(`ChatGPT Responses stream error: ${msg}`);
      }
    }

    // Terminal finish chunk, then a separate usage-only frame. OpenAI's
    // streaming wire delivers usage in a trailing chunk with an EMPTY choices
    // array (its `stream_options.include_usage` shape) — and the gateway proxy
    // only harvests usage from such choice-less frames. Riding usage on the
    // finish chunk (which carries a choice) makes the proxy silently drop it,
    // so the client never sees token counts. Split them to match the shape the
    // proxy expects.
    yield mkChunk({}, sawToolCall ? 'tool_calls' : 'stop');
    if (usage) {
      yield { id, object: 'chat.completion.chunk', created, model: modelId, choices: [], usage };
    }
  }

  // Parse the Responses SSE stream into typed event objects. The Responses API
  // frames events as `event: <name>` + one or more `data: <json>` lines
  // terminated by a blank line; every data payload also carries a `type` field,
  // which is what we key on downstream. Malformed frames are skipped.
  private async *readResponsesStream(
    res: Response,
    modelId: string,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ResponsesStreamEvent> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';

    if (abortSignal?.aborted) throw new RequestAbortError();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
    };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    try {
      while (true) {
        if (aborted) throw new RequestAbortError();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`${this.name} stream stalled: no data for ${STREAM_INACTIVITY_TIMEOUT_MS}ms (timeout)`)),
              STREAM_INACTIVITY_TIMEOUT_MS,
            );
          }),
          ...(abortSignal
            ? [
                new Promise<never>((_, reject) => {
                  abortSignal.addEventListener('abort', () => reject(new RequestAbortError()), { once: true });
                }),
              ]
            : []),
        ]).finally(() => clearTimeout(timer));

        const { done, value } = result as { done: boolean; value?: Uint8Array };
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on frame boundaries (blank line). Keep the trailing partial.
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const evt = parseFrame(frame);
          if (evt) yield evt;
        }
      }
      // Flush a trailing frame with no terminating blank line.
      const evt = parseFrame(buffer);
      if (evt) yield evt;
    } finally {
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      reader.cancel().catch(() => {
        /* upstream already gone */
      });
    }
  }
}

// ── SSE frame parsing ────────────────────────────────────────────────────────

interface ResponsesStreamEvent {
  type?: string;
  delta?: unknown;
  output_index?: number;
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  response?: { usage?: ResponsesUsage; error?: { message?: string } };
  error?: { message?: string };
  [key: string]: unknown;
}

interface ResponsesUsage {
  input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens?: number;
  total_tokens?: number;
}

interface ResponsesApiResponse {
  id?: string;
  output?: Array<{
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: ResponsesUsage;
}

function parseFrame(frame: string): ResponsesStreamEvent | null {
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('data:')) dataLines.push(trimmed.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join('');
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data) as ResponsesStreamEvent;
  } catch {
    return null;
  }
}

function stablePrefixCacheKey(
  instructions: string,
  tools: NonNullable<ResponsesRequestBody['tools']>,
): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ instructions, tools }))
    .digest('hex');
}

// The cache key actually sent upstream. Without a caller key, the prefix hash
// is all the identity we have — but it collides across distinct conversations
// that share a system prompt and tool set, which is exactly the fleet's shape.
// A caller-supplied conversation key is mixed in so each conversation gets its
// own key while still changing when the cached prefix itself changes. (c3025)
export function effectiveCacheKey(
  callerKey: string | undefined,
  instructions: string,
  tools: NonNullable<ResponsesRequestBody['tools']>,
): string {
  if (!callerKey) return stablePrefixCacheKey(instructions, tools);
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ callerKey, instructions, tools }))
    .digest('hex');
}

// The backend routes on `session_id` for cache affinity, so a fresh random id
// per request scatters a single conversation across shards and intermittently
// loses the cached prefix. Derive it deterministically from the cache key
// instead — same conversation, same id — formatted UUID-shaped (v4 variant
// bits) so the backend sees a plausible identifier. (c3025)
export function sessionIdForCacheKey(cacheKey: string): string {
  const b = crypto.createHash('sha256').update(`session:${cacheKey}`).digest();
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = b.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
