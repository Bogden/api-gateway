import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  ChatContentBlock,
} from '@api-gateway/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, hasEnabledToolsModel, hasEnabledVisionModel, type RouteResult } from '../services/router.js';
import { recordRequest, recordFailedRequest, recordTokens, setCooldown, computeRetryCooldownMs } from '../services/ratelimit.js';
import { attemptConsumedQuota, providerAtFault, isRetryableError, isPaymentRequiredError } from '../lib/error-classify.js';
import { contentToString } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import {
  isAuthorizedV1Request,
  ensureChatgptModel,
  extractApiToken,
  getStickyModel,
  setStickyModel,
  logRequest,
} from './proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { attachClientAbort, isAbortError } from '../lib/abort.js';
import { getGlobalRetryLimit } from '../services/router.js';
import { publish } from '../services/events.js';
import { getDb } from '../db/index.js';

export const responsesRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// OpenAI Responses API shim (POST /v1/responses).
//
// Current Codex versions only speak the Responses API — `wire_api = "chat"`
// is rejected — so the existing /v1/chat/completions endpoint isn't reachable
// from Codex (see issue #96). This endpoint accepts a Responses-shaped request,
// translates it to the internal chat-message format, runs it through the SAME
// router/retry machinery as the proxy, and translates the result back into the
// Responses object / SSE event stream that Codex expects.
//
// Deliberately self-contained: it duplicates the proxy's retry loop rather than
// refactoring that battle-tested handler, so the production /chat/completions
// path is untouched. Shared, side-effect-free helpers (routing, rate-limit
// bookkeeping, sticky sessions, logging) are imported, not re-implemented.
// ─────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Request schema ──────────────────────────────────────────────────────
// Lenient on purpose: the Responses API surface is large and evolving, and we
// only consume the fields we can map. Unknown fields (store, reasoning,
// metadata, previous_response_id, …) are accepted and ignored.

const contentPartSchema = z.object({ type: z.string() }).passthrough();

const messageItemSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  id: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([z.string(), z.array(contentPartSchema), z.record(z.string(), z.unknown())]),
});

const inputItemSchema = z.union([
  functionCallItemSchema,
  functionCallOutputItemSchema,
  messageItemSchema,
]);

// Accept ANY tool type, not just 'function'. Codex (Responses API) sends
// built-in tools like `web_search` / `local_shell` alongside function tools;
// a strict z.literal('function') rejected the whole request. We validate
// loosely here and drop non-function tools at conversion (toChatTools), since
// chat-completions providers only accept type:'function'.
const responsesToolSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();

const responsesRequestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().nullable().optional(),
  input: z.union([z.string(), z.array(inputItemSchema)]),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  tools: z.array(responsesToolSchema).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({ type: z.literal('function'), name: z.string() }).passthrough(),
  ]).optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  // Conversation-scoped cache key; honored by cache-affinity providers only.
  // (card c3025)
  prompt_cache_key: z.string().nullable().optional(),
}).passthrough();

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

// Responses content parts → the internal OpenAI content envelope. Text and
// images stay in their original order so vision-capable providers see the
// same prompt the client sent.
type ResponsesContentPart = { type?: string; text?: unknown; image_url?: unknown; image?: unknown; source?: unknown };

function looksImageLike(part: ResponsesContentPart): boolean {
  return part.image_url != null || part.image != null || part.source != null;
}

function imageUrlFromPart(part: ResponsesContentPart): string {
  if (part.type === 'input_image') {
    if (typeof part.image_url !== 'string' || !part.image_url.trim()) {
      throw new Error('input_image.image_url must be a non-empty data URL or http(s) URL');
    }
    return part.image_url;
  }

  if (!part.image_url || typeof part.image_url !== 'object' || Array.isArray(part.image_url)) {
    throw new Error('image_url parts must use the object shape { image_url: { url: string } }');
  }
  const url = (part.image_url as { url?: unknown }).url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('image_url.url must be a non-empty data URL or http(s) URL');
  }
  return url;
}

function validateImageUrl(url: string): string {
  if (!url.startsWith('data:') && !/^https?:\/\//i.test(url)) {
    throw new Error('image URL must be a data URL or http(s) URL');
  }
  return url;
}

function partsToContent(content: string | ResponsesContentPart[]): ChatMessage['content'] {
  if (typeof content === 'string') return content;
  const parts: ChatContentBlock[] = [];
  for (const part of content) {
    if (part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') {
        throw new Error(`${part.type}.text must be a string`);
      }
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      parts.push({ type: 'image_url', image_url: { url: validateImageUrl(imageUrlFromPart(part)) } });
      continue;
    }
    if (looksImageLike(part)) {
      throw new Error(`unsupported image-bearing Responses content part type '${part.type ?? 'missing'}'`);
    }
    throw new Error(`unsupported Responses content part type '${part.type ?? 'missing'}'`);
  }
  const hasImage = parts.some((part) => typeof part !== 'string' && part.type === 'image_url');
  return hasImage ? parts : parts.map((part) => typeof part === 'string' ? part : part.text ?? '').join('');
}

function partsToString(content: string | ResponsesContentPart[]): string {
  const converted = partsToContent(content);
  if (Array.isArray(converted) && converted.some((part) => typeof part !== 'string' && part.type === 'image_url')) {
    throw new Error('image input is not supported in function_call_output');
  }
  return contentToString(converted);
}

// Identify image parts for vision routing. Conversion and validation below
// reject malformed or unsupported shapes before any provider is called.
export function responsesInputHasImage(req: ResponsesRequest): boolean {
  if (typeof req.input === 'string') return false;
  return req.input.some((item) => {
    const content = (item as { content?: unknown }).content;
    return Array.isArray(content) && content.some((part) => {
      const type = (part as { type?: unknown })?.type;
      return type === 'input_image' || type === 'image_url';
    });
  });
}

function validateResponsesInput(req: ResponsesRequest): void {
  if (typeof req.input === 'string') return;
  for (const item of req.input) {
    if (item.type === 'function_call_output') {
      if (Array.isArray(item.output)) {
        if (item.output.some((part) => part.type === 'input_image' || part.type === 'image_url' || looksImageLike(part))) {
          throw new Error('image input is supported only in user messages');
        }
        partsToString(item.output as ResponsesContentPart[]);
      } else if (typeof item.output !== 'string') {
        throw new Error('function_call_output.output must be a string or an array of text content parts');
      }
      continue;
    }
    if ('role' in item && 'content' in item) {
      const content = item.content;
      if (Array.isArray(content)) {
        const hasImage = content.some((part) => part.type === 'input_image' || part.type === 'image_url' || looksImageLike(part));
        if (hasImage && item.role !== 'user') {
          throw new Error('image input is supported only in user messages');
        }
        partsToContent(content);
      }
    }
  }
}

// ── Translate a Responses request → internal chat messages + options ──────
export function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
    return messages;
  }

  for (const item of req.input) {
    if ('type' in item && item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      });
    } else if ('type' in item && item.type === 'function_call_output') {
      if (typeof item.output !== 'string' && !Array.isArray(item.output)) {
        throw new Error('function_call_output.output must be a string or an array of text content parts');
      }
      const output = typeof item.output === 'string'
        ? item.output
        : partsToString(item.output as ResponsesContentPart[]);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    } else {
      // message item
      const m = item as z.infer<typeof messageItemSchema>;
      // 'developer' is the Responses-era system role.
      const role = m.role === 'developer' ? 'system' : m.role;
      messages.push({ role, content: partsToContent(m.content as string | ResponsesContentPart[]) });
    }
  }

  return messages;
}

export function toChatTools(tools?: ResponsesRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  // Forward only function tools — chat-completions upstreams reject other
  // Responses-API tool types (web_search, local_shell, etc.). Codex sends those
  // extras alongside its function tools (shell/exec, apply_patch); dropping them
  // keeps the request valid without losing the tools that actually do the work.
  const fns = tools.filter((t): t is typeof t & { name: string } => t.type === 'function' && typeof t.name === 'string');
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  }));
}

export function toChatToolChoice(tc?: ResponsesRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  return { type: 'function', function: { name: tc.name } };
}

// ── Build the final (non-stream) Responses object ─────────────────────────
export function buildResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
}) {
  const output: any[] = [];
  if (opts.text.length > 0) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: opts.id,
    object: 'response',
    created_at: nowUnix(),
    status: 'completed',
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

responsesRouter.post('/responses', async (req: Request, res: Response) => {
  const start = Date.now();

  // Same auth as the proxy: unified key OR a provably-non-browser loopback CLI.
  if (!isAuthorizedV1Request(req)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = responsesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const reqData = parsed.data;

  try {
    validateResponsesInput(reqData);
  } catch (err: any) {
    res.status(400).json({
      error: {
        message: `Unsupported Responses input: ${err.message}`,
        type: 'invalid_request_error',
        code: 'unsupported_image_input',
      },
    });
    return;
  }

  const stream = reqData.stream ?? false;
  const messages = toChatMessages(reqData);
  const hasImage = responsesInputHasImage(reqData);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }
  const tools = toChatTools(reqData.tools);
  // name → parameter schema, for repairing double-encoded tool arguments on
  // the way back out (see lib/tool-args.ts).
  const toolSchemas = toolSchemaMap(tools);
  const tool_choice = toChatToolChoice(reqData.tool_choice);
  // `abortSignal` is added per-call after the client-disconnect controller is
  // created below; the base opts are built here for both call sites. (#292)
  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_output_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
    parallel_tool_calls: reqData.parallel_tool_calls ?? undefined,
    prompt_cache_key: reqData.prompt_cache_key ?? undefined,
  };

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const imageCount = messages.reduce((count, message) => count + (
    Array.isArray(message.content)
      ? message.content.filter((part) => typeof part !== 'string' && part.type === 'image_url').length
      : 0
  ), 0);
  const estimatedTotal = estimatedInputTokens + imageCount * 1000 + (reqData.max_output_tokens ?? 1000);
  // Explicit model requests pin exactly as /chat/completions does. In particular,
  // arbitrary gpt-* ids provision a ChatGPT subscription row rather than being
  // ignored in favor of sticky/automatic routing.
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const requestedModel = reqData.model?.trim();
  const isAutoModel = !requestedModel || requestedModel === 'auto';
  let preferredModel: number | undefined;
  if (isAutoModel) {
    preferredModel = getStickyModel(extractApiToken(req), messages, sessionIdHeader);
  } else {
    const db = getDb();
    const slashIdx = requestedModel.indexOf('/');
    let enabled: { id: number } | undefined;
    if (slashIdx > 0) {
      enabled = db.prepare(
        'SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1',
      ).get(requestedModel.slice(0, slashIdx), requestedModel.slice(slashIdx + 1)) as { id: number } | undefined;
    }
    if (!enabled) {
      enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
    }
    if (!enabled) enabled = ensureChatgptModel(db, requestedModel);
    if (!enabled) {
      res.status(400).json({
        error: {
          message: `Model '${requestedModel}' is disabled or not in the catalog. Use 'auto' (or omit the 'model' field) to auto-route.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
      return;
    }
    preferredModel = enabled.id;
  }

  // Tool-bearing requests (the normal case for Codex/agent clients on this
  // endpoint) must stay on models that emit structured tool_calls — a model
  // that serializes the call into text strands the agent harness with a
  // "successful" run it can't act on. Mirrors the /chat/completions gate.
  const wantsTools = (tools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_tools_model',
      },
    });
    return;
  }

  const responseId = newId('resp');
  // Client-disconnect abort wiring — mirrors /chat/completions. A Stop /
  // session-close cancels the in-flight upstream call and breaks out of the
  // retry loop instead of running all MAX_RETRIES. (#292)
  const { controller: abortController } = attachClientAbort(res);
  const abortSignal = abortController.signal;
  // Global recovery limit: counts actual upstream attempts (not cycles), same
  // setting as /chat/completions. Falls back to MAX_RETRIES when the user
  // configured 0 (infinite) so this Codex path never runs away. (#292)
  const configuredLimit = getGlobalRetryLimit();
  const attemptLimit = configuredLimit > 0 ? configuredLimit : MAX_RETRIES;
  let upstreamAttempts = 0;

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  // Stream bookkeeping (used only when stream === true).
  let seq = 0;
  let streamStarted = false;
  const sse = (event: string, payload: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`);
  };

  try {
  for (let attempt = 0; attempt < attemptLimit; attempt++) {
    // ---- Exit: client disconnected ----
    if (abortSignal.aborted) {
      publish({ type: 'request.aborted', id: responseId, at: Date.now() });
      return;
    }
    // ---- Exit: upstream attempt cap reached ----
    if (upstreamAttempts >= attemptLimit) break;
    let route: RouteResult | undefined;
    try {
      route = routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        hasImage,
        wantsTools,
        skipModels.size > 0 ? skipModels : undefined,
        { pinMode: !isAutoModel },
      );
    } catch (err: any) {
      const status = lastError ? 429 : (err.status ?? 503);
      const message = lastError
        ? `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`
        : err.message;
      const type = lastError ? 'rate_limit_error' : 'routing_error';
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message, type } } });
        res.end();
      } else {
        res.status(status).json({ error: { message, type } });
      }
      return;
    }

    try {
      if (stream) {
        let outputIndex = 0;
        let msgItemId: string | null = null;
        let msgText = '';
        // tool-call accumulator keyed by the provider's tool_call index
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
        let totalOutputTokens = 0;

        // Inline-dialect hold window (#231): first text is held until it
        // either matches a tool-call dialect marker (held to the end and
        // rescued into function_call items) or provably cannot (flushed and
        // streamed normally). Mirrors the /chat/completions stream loop.
        let dialectMode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';

        // Open the text output item and stream `text` as its first delta.
        const openTextItem = (text: string) => {
          msgItemId = newId('msg');
          sse('response.output_item.added', {
            output_index: outputIndex,
            item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse('response.content_part.added', {
            item_id: msgItemId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          if (text) {
            sse('response.output_text.delta', { item_id: msgItemId, output_index: outputIndex, content_index: 0, delta: text });
            msgText += text;
          }
        };

        upstreamAttempts++; // counted toward the global recovery limit. (#292)
        const gen = route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, { ...completionOpts, abortSignal });

        for await (const chunk of gen) {
          // In-band upstream error frame ({"error":...} inside a 200 SSE
          // stream — observed live from Groq). Throw before the lazy header
          // block so a first-frame error keeps streamStarted=false and takes
          // the normal failover path in the catch below.
          const anyChunk = chunk as Record<string, any>;
          if (anyChunk.error && !anyChunk.choices) {
            throw new Error(`in-band provider error from ${route.displayName}: ${anyChunk.error.message ?? 'provider error'}`);
          }
          // LAZY header set — headers + the response.created/in_progress
          // skeleton go out only once the provider actually streams a chunk.
          // Sending them before the provider call (the previous behavior)
          // committed the SSE response, so a provider error AT STREAM OPEN —
          // e.g. OpenRouter 503ing a large-context request — was misclassified
          // as mid-stream and returned to the client with NO failover and NO
          // cooldown; the next request then hit the same broken model again
          // (observed: 17 consecutive 503s to the same model while the rest of
          // the chain sat idle). With lazy headers a connect-time error
          // bubbles to the catch with streamStarted=false and takes the normal
          // retry path. Mirrors the proxy's streaming handler.
          if (!streamStarted) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
            const skeleton = {
              id: responseId, object: 'response', created_at: nowUnix(),
              status: 'in_progress', model: route.modelId, output: [], output_text: '',
            };
            sse('response.created', { response: skeleton });
            sse('response.in_progress', { response: skeleton });
            streamStarted = true;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Text deltas → output_text events on a single message item, after
          // the dialect hold window has decided the text is real prose.
          const text = delta.content ?? '';
          if (text) {
            totalOutputTokens += Math.ceil(text.length / 4);
            if (dialectMode === 'passthrough') {
              if (msgItemId === null) openTextItem('');
              sse('response.output_text.delta', {
                item_id: msgItemId, output_index: 0, content_index: 0, delta: text,
              });
              msgText += text;
            } else {
              heldText += text;
              if (dialectMode === 'undecided') {
                const probe = heldText.trimStart();
                if (startsWithDialectMarker(probe)) {
                  dialectMode = 'dialect';
                } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                  dialectMode = 'passthrough';
                  openTextItem(heldText);
                  heldText = '';
                }
              }
            }
          }

          // Tool-call deltas → function_call item + argument deltas.
          for (const tc of delta.tool_calls ?? []) {
            const idx = (tc as any).index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              // First time we see this tool call: open a new output item.
              if (msgItemId !== null && msgText.length > 0) {
                // close the text item (always output index 0) before starting a function_call item
                sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
                sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
                sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
                msgItemId = null;
              }
              outputIndex = toolAcc.size + (msgText.length > 0 ? 1 : 0);
              acc = { outputIndex, itemId: newId('fc'), callId: tc.id || newId('call'), name: tc.function?.name ?? '', args: '' };
              toolAcc.set(idx, acc);
              sse('response.output_item.added', {
                output_index: acc.outputIndex,
                item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
              });
            }
            const argFrag = tc.function?.arguments ?? '';
            if (tc.function?.name && !acc.name) acc.name = tc.function.name;
            if (argFrag) {
              acc.args += argFrag;
              sse('response.function_call_arguments.delta', { item_id: acc.itemId, output_index: acc.outputIndex, delta: argFrag });
            }
          }
        }

        // Resolve the dialect hold window now that the full text is known.
        // Held text was never emitted, so a dead dialect turn can still fail
        // over on the same SSE stream (only the skeleton events are out).
        if (heldText.length > 0) {
          const rescue = (dialectMode === 'dialect' || containsDialectMarker(heldText))
            ? rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)))
            : { detected: false as const, calls: null, cleanText: heldText };
          if (rescue.detected && !rescue.calls) {
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, `unparseable inline tool-call dialect: ${heldText.slice(0, 120)}`);
            skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
            setCooldown(route.platform, route.modelId, route.keyId, computeRetryCooldownMs(false, route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
            recordRateLimitHit(route.modelDbId);
            lastError = new Error(`unparseable inline tool-call dialect from ${route.displayName}`);
            continue;
          }
          if (rescue.detected && rescue.calls) {
            // Rescued calls become function_call items, exactly as if the
            // provider had streamed them structurally.
            console.log(`[Responses] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`);
            if (rescue.cleanText.length > 0 && msgItemId === null) openTextItem(rescue.cleanText);
            let rescuedIdx = 0;
            for (const c of rescue.calls) {
              const idx = 1000 + rescuedIdx++; // synthetic accumulator keys, past any provider index
              const acc = {
                outputIndex: toolAcc.size + (msgText.length > 0 ? 1 : 0),
                itemId: newId('fc'), callId: newId('call'), name: c.name, args: c.arguments,
              };
              toolAcc.set(idx, acc);
              sse('response.output_item.added', {
                output_index: acc.outputIndex,
                item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
              });
            }
          } else if (msgItemId === null) {
            // Plain short answer that never left the hold window (e.g. "Hi").
            openTextItem(heldText);
          }
          heldText = '';
        }

        // Empty completion — the provider returned 200 with no text AND no
        // tool calls. Seen in production from nemotron-3-super on ~65k-token
        // contexts: transport-level "success", zero usable output, so the
        // agent client records a successful run it can't act on and its issue
        // dead-ends. Nothing substantive has been emitted yet (output_item
        // events only fire on the first delta; only the created/in_progress
        // skeletons are out), so it's safe to fail over to the next model on
        // the same SSE stream.
        if (msgText.length === 0 && toolAcc.size === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)');
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, computeRetryCooldownMs(false, route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        // Finalize any open text item.
        if (msgItemId !== null) {
          sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
          sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
          sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
        }
        // Finalize tool-call items. Arguments are repaired against the tool's
        // parameter schema at this point (after the full string accumulated):
        // models like GLM double-encode nested arrays/objects as strings, and
        // Codex hard-rejects the call ("invalid type: string, expected a
        // sequence"). Clients consume the *.done events / final response for
        // arguments, so repairing here covers the streamed path too.
        const finalToolCalls: ChatToolCall[] = [];
        for (const acc of toolAcc.values()) {
          const repairedArgs = repairToolArguments(acc.args, toolSchemas.get(acc.name));
          sse('response.function_call_arguments.done', { item_id: acc.itemId, output_index: acc.outputIndex, arguments: repairedArgs });
          sse('response.output_item.done', { output_index: acc.outputIndex, item: { id: acc.itemId, type: 'function_call', status: 'completed', call_id: acc.callId, name: acc.name, arguments: repairedArgs } });
          finalToolCalls.push({ id: acc.callId, type: 'function', function: { name: acc.name, arguments: repairedArgs } });
        }

        const finalResponse = buildResponseObject({
          id: responseId, model: route.modelId, text: msgText,
          toolCalls: finalToolCalls, promptTokens: estimatedInputTokens, completionTokens: totalOutputTokens,
        });
        sse('response.completed', { response: finalResponse });
        res.end();

        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(extractApiToken(req), messages, route.modelDbId, sessionIdHeader);
        logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null);
        return;
      } else {
        upstreamAttempts++; // counted toward the global recovery limit. (#292)
        const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, { ...completionOpts, abortSignal });

        const msg = result.choices[0]?.message;
        let text = contentToString(msg?.content ?? '');
        let toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
          ...tc,
          function: { ...tc.function, arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)) },
        }));

        // Inline tool-call dialect rescue (#231) — see /chat/completions.
        if (wantsTools && toolCalls.length === 0 && text) {
          const rescue = rescueInlineToolCalls(text, new Set((tools ?? []).map(t => t.function.name)));
          if (rescue.detected) {
            if (!rescue.calls) {
              throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${text.slice(0, 120)}`);
            }
            console.log(`[Responses] Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`);
            toolCalls = rescue.calls.map((c, i) => ({
              id: `call_rescued_${i + 1}`,
              type: 'function' as const,
              function: { name: c.name, arguments: repairToolArguments(c.arguments, toolSchemas.get(c.name)) },
            }));
            text = rescue.cleanText;
          }
        }
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);

        // Empty completion → fail over (see the streaming-path comment above).
        if (!text && toolCalls.length === 0) {
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)');
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, computeRetryCooldownMs(false, route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
        recordSuccess(route.modelDbId);
        setStickyModel(extractApiToken(req), messages, route.modelDbId, sessionIdHeader);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(buildResponseObject({
          id: responseId, model: route.modelId, text, toolCalls,
          promptTokens, completionTokens,
        }));

        logRequest(route.platform, route.modelId, route.keyId, 'success',
          promptTokens, completionTokens, Date.now() - start, null);
        return;
      }
    } catch (err: any) {
      // Client stopped the request — not a provider failure. End silently,
      // don't retry, don't 502. The abort signal already cancelled the
      // in-flight upstream call. (#292)
      if (isAbortError(err) || abortSignal.aborted) {
        if (!res.writableEnded) {
          try { res.end(); } catch { /* socket already gone */ }
        }
        publish({ type: 'request.aborted', id: responseId, at: Date.now() });
        return;
      }
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      if (!route) {
        if (!res.headersSent) res.status(err.status ?? 502).json({ error: { message: safeError, type: 'provider_error' } });
        return;
      }
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError);

      // Failed attempts count against the provider's quota too — see
      // recordFailedRequest. Skipped when nothing reached the provider, and
      // also when the provider REFUSED the request rather than serving it
      // (429/402/403/401): billing a refusal moves the daily counter that
      // decides a 24h quarantine. Backing off is the cooldown's job below.
      if (attemptConsumedQuota(err)) {
        recordFailedRequest(route.platform, route.modelId, route.keyId);
      }

      // Mid-stream failures can't be retried (bytes already sent) — close cleanly.
      if (stream && streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } } });
        res.end();
        return;
      }

      if (isRetryableError(err)) {
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        // Fail over on any retryable error, but only REST the key when the
        // provider is the one at fault. This used to key off isRetryableError,
        // which says yes to `fetch failed` — so a total local network outage
        // benched every key the chain touched, each for a persisted 90s, for a
        // fault entirely on our side of the wire. skipKeys above still rotates
        // away from this route for the rest of this request either way.
        if (providerAtFault(err)) {
          setCooldown(route.platform, route.modelId, route.keyId, computeRetryCooldownMs(
            isPaymentRequiredError(err),
            route.platform, route.modelId, route.keyId,
            { rpd: route.rpdLimit, tpd: route.tpdLimit },
          ));
        }
        recordRateLimitHit(route.modelDbId);
        lastError = err;
        continue;
      }

      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 502;
      const type = status < 500 ? 'invalid_request_error' : 'provider_error';
      res.status(status).json({ error: { message: `Provider error (${route.displayName}): ${safeError}`, type } });
      return;
    } finally {
      route?.release();
    }
  }

  // Exhausted all retries. The streaming skeleton may already be on the wire
  // (reachable since empty-completion failover can burn every attempt after
  // streamStarted) — close the SSE stream with a failed event instead of
  // writing JSON onto a committed event-stream response.
  const exhaustedMsg = `All models rate-limited after ${upstreamAttempts} attempt(s). Last: ${lastError?.message ?? 'unknown'}`;
  if (streamStarted) {
    sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: exhaustedMsg, type: 'rate_limit_error' } } });
    res.end();
    return;
  }
  res.status(429).json({
    error: { message: exhaustedMsg, type: 'rate_limit_error' },
  });
  } catch (err: any) {
    // A RequestAbortError from an outer-loop abortableSleep (or any abort that
    // escaped the inner catch) ends the response silently on client disconnect.
    // (#292)
    if (isAbortError(err) || abortSignal.aborted) {
      if (!res.writableEnded) {
        try { res.end(); } catch { /* socket already gone */ }
      }
      publish({ type: 'request.aborted', id: responseId, at: Date.now() });
      return;
    }
    console.error('[Responses] Unhandled error in retry loop:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `Internal error: ${sanitizeProviderErrorMessage(err?.message)}`, type: 'provider_error' } });
    }
  }
});
