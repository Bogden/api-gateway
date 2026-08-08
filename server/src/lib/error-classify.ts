// Upstream-error classification shared by the proxy chat path, the responses
// path, and the fusion panel. Pure functions over an error's message/status —
// no I/O — so they live in a neutral lib module that any of those can import
// without forming an import cycle (fusion ↔ proxy in particular).

/** Should the routing loop FAIL OVER — retry this key, rotate to a sibling key,
 *  or move to the next model in the chain — rather than giving up and handing
 *  the client an error? Purely forward-looking: it asks whether a DIFFERENT
 *  route is plausibly better than bailing out, not what this attempt cost.
 *
 *  NOT the same question as `attemptReachedProvider` below, and neither can be
 *  derived from the other — all four combinations occur:
 *    reached + retryable      → an upstream 429: charge the quota, fail over.
 *    reached + not retryable  → a 400 the adapter marked `retryable:false`:
 *                               the provider answered and charged us, but no
 *                               other route will answer differently.
 *    not reached + retryable  → `fetch failed`/ECONNREFUSED: nothing was spent
 *                               upstream, and the next provider is a different
 *                               host/DNS/TLS path, so failover is free.
 *    not reached + not retryable → a client abort, or our own validation.
 *  Conflating them would either 502 the client on every local transport blip
 *  or charge a provider's quota for requests that never left the box.
 *
 *  Do NOT gate a cooldown on this predicate — "worth trying elsewhere" is not
 *  "this key deserves a rest". Use `providerAtFault` for that. */
export function isRetryableError(err: any): boolean {
  // Explicit provider opt-out: a deterministic upstream failure (e.g. a 400/422
  // validation rejection) that will fail identically on every attempt. Honored
  // before every heuristic below so such errors fail fast and are passed
  // through rather than consuming the recovery budget — and, since failed
  // attempts that reached the provider now move the limiter's ledger, so a
  // hopeless retry doesn't spend the account's quota three times over. Set by
  // the adapter (providers/base.ts ProviderHttpError); only ever `false`, never
  // `true` to force a retry. (card c1881)
  if (err?.retryable === false) return false;
  const msg = (err.message ?? '').toLowerCase();
  // Trust the upstream HTTP status the provider attached to the error first
  // (providerHttpError in providers/base.ts sets err.status on every adapter).
  // This structured check is the robust primary signal; the message-substring
  // rules below are the fallback for errors that carry a code in their text but
  // no numeric status. It's the fix for #337/#339: an Ollama "410 Gone", or any
  // upstream 5xx the substring allowlist never enumerated (502/504/507…), used to
  // fall through to a 502 and STRAND the healthy paid routes still queued later in
  // the chain — because the old code matched specific substrings and ignored
  // err.status for every code except 403. 408 (request timeout), 409 (conflict),
  // 410 (model pulled upstream), 429 (rate limit) and all 5xx are transient or
  // fail-over-able; 400/401 stay fatal (status 0 here, handled by the absence of a
  // matching rule) and 403 is handled by isModelAccessForbiddenError below.
  const status = typeof err?.status === 'number' ? err.status : 0;
  if (status === 408 || status === 409 || status === 410 || status === 429 || status >= 500) return true;
  return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')
    || msg.includes('quota') || msg.includes('resource_exhausted')
    || msg.includes('aborted') || msg.includes('timeout') || msg.includes('etimedout')
    || msg.includes('econnrefused') || msg.includes('econnreset')
    || msg.includes('fetch failed')    // undici transport error (proxy down, DNS, TLS, etc.)
    || msg.includes('503') || msg.includes('unavailable')
    || msg.includes('500') || msg.includes('internal server error')
    // 413: this model's payload limit is too small for the request, but another
    // provider in the fallback chain may have a larger limit. Same reasoning as 503.
    || msg.includes('413') || msg.includes('payload too large') || msg.includes('request body too large')
    || msg.includes('request entity too large') || msg.includes('content too large')
    // 404: model deprecated/removed upstream (e.g. OpenRouter's "no endpoints found"
    // for a model that's been pulled). Rotate to the next model in the chain —
    // setCooldown + the health checker will avoid this model on subsequent requests.
    || msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    // 410: the model/endpoint was permanently removed upstream (e.g. Ollama Cloud
    // "API error 410: Gone", #339). Like a 404 it won't return on this provider, so
    // rotate to the next route; isModelNotFoundError benches the whole model. The
    // structured status check above already catches the 410 when the provider
    // attaches err.status — this is the text fallback for errors that don't.
    || msg.includes('410') || msg.includes('gone')
    // 403: the key is valid (it passed validateKey, and the health checker
    // disables truly-forbidden keys) but this specific model is off-limits to
    // the key's tier — e.g. gpt-4o on GitHub Models' free tier, subscription-only
    // models on Cloudflare. Another model in the chain is reachable, so fail over
    // instead of 502-ing the whole request. Paired with isModelAccessForbiddenError
    // to rule the model out for this request and a day-long bench. See issue #256.
    || isModelAccessForbiddenError(err)
    // 400: one provider may reject parameters another accepts (e.g. max_tokens
    // limits, unsupported params). The matching pattern is "api error 400"
    // which comes from the OpenAI-compat provider's error formatting, not
    // a bare "400" which is deliberately non-retryable for validation errors.
    || msg.includes('api error 400')
    // 402: this provider/key is out of credits (e.g. HuggingFace Router
    // "API error 402: Payment required"). The SAME model often lives on another
    // provider (Kimi K2.6 is on HF + Cloudflare + NVIDIA), so fail over instead
    // of killing the workflow. Paired with a long cooldown (isPaymentRequiredError)
    // so we don't re-hammer the broke key every retry.
    || isPaymentRequiredError(err)
    // Dead-turn classes from the stream turn-integrity layer (#231 audit):
    // all thrown before any byte reached the client, so another model can
    // serve the request invisibly.
    || msg.includes('empty completion')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
}

/** True when a failed attempt provably REACHED the provider, i.e. the provider
 *  accepted the request and answered: any HTTP status came back (adapters set
 *  `err.status` via providerHttpError, and format their message as
 *  "<Name> API error <status>: …"), or it answered 200 and the turn died on our
 *  side of the parse (empty completion, in-band error frame, truncated/stalled
 *  stream, unparseable inline tool-call dialect). A provider counts those
 *  against the account's request quota exactly like a success, so the rate
 *  limiter must count them too.
 *
 *  Deliberately FALSE for failures where nothing was accepted upstream — a
 *  client abort (`RequestAbortError`, no status), and transport deaths before
 *  the request is on the wire (`fetch failed`, ECONNREFUSED, DNS, TLS). Those
 *  consumed no provider quota, and charging them would bench a healthy key for
 *  a local network fault. `ProviderTimeoutError` DOES count: our deadline fires
 *  only after the request was dispatched, so the provider has it. */
export function attemptReachedProvider(err: any): boolean {
  if (!err) return false;
  if (typeof err.status === 'number' && err.status >= 400) return true;
  if (err.name === 'ProviderTimeoutError') return true;
  const msg = (err.message ?? '').toLowerCase();
  if (/api error \d{3}/.test(msg)) return true;
  return msg.includes('empty completion')
    || msg.includes('in-band provider error')
    || msg.includes('stream ended unexpectedly')
    || msg.includes('stream stalled')
    || msg.includes('unparseable inline tool-call dialect');
}

/** Is this failure attributable to the PROVIDER — its rate limit, its quota
 *  accounting for our account, its outage, its tier policy, its bad response —
 *  such that RESTING this key (a cooldown that outlives the request) is the
 *  right response? The third question in this file, and the only one that may
 *  gate `setCooldown`.
 *
 *  Distinct from `isRetryableError`, which the cooldown sites used to stand in
 *  for. Retryable asks "is another route better than erroring the client?" and
 *  is deliberately generous — it says yes to a local transport death, because
 *  the next provider is a different host/DNS/TLS path. Benching a key on that
 *  same yes is a category error: during a total local network outage EVERY
 *  attempt dies as `fetch failed`, so the routing loop would walk the chain and
 *  leave every key it touched benched (and the bench is persisted, so it
 *  outlives the outage). Keys that did nothing wrong must not be rested for a
 *  fault on our side of the wire.
 *
 *  RELATION TO `attemptReachedProvider`: a strict SUBSET, not an equivalence,
 *  which is why both must exist. Nothing that never reached the provider can be
 *  the provider's fault, so this returns false wherever that one does — the
 *  implication is enforced structurally by the first check below rather than by
 *  a parallel list that could drift. But the converse fails, and the gap is
 *  exactly the set that must NOT rest a key:
 *    reached + at fault      → 429/402/403/404/5xx, or a 200 whose turn was
 *                              dead: an upstream condition of this key/model.
 *    reached + NOT at fault  → a 400 (our request shape), a 401 (our
 *                              credential), an adapter's `retryable:false`
 *                              deterministic rejection, our own dispatch
 *                              deadline. The provider answered and charged us,
 *                              so the limiter must count it — but the key is
 *                              healthy and resting it helps nothing.
 *    not reached + at fault  → empty, and necessarily so: a failure that never
 *                              left the box carries no evidence about the
 *                              provider. Provider-side DNS death is
 *                              indistinguishable from our resolver dying, so it
 *                              is not attributed.
 *  Collapsing the two would either charge quota for requests that never left
 *  the box or bench a healthy key for our own malformed request. */
export function providerAtFault(err: any): boolean {
  if (!err) return false;
  // Enforces the subset relationship above: no reach, no attribution. This is
  // what spares every key during a total local outage — `fetch failed`,
  // ECONNREFUSED, DNS and TLS deaths all fail here.
  if (!attemptReachedProvider(err)) return false;
  // OUR deadline, not their silence. `attemptReachedProvider` counts a timeout
  // because over-counting quota is the safe direction there; for resting a key
  // the safe direction is the opposite. The timer in fetchWithTimeout
  // (providers/base.ts:188) starts BEFORE the connection is established, so a
  // timeout does not even prove the provider saw the request — during a network
  // fault that hangs rather than refuses, every key would time out and every key
  // would be benched. A genuinely hung provider is still skipped for the rest of
  // the request by skipKeys/markExhausted; only the cross-request bench is given
  // up, and a too-tight deadline against a cold-starting provider (NVIDIA's
  // 15-60s serverless starts) no longer benches a healthy key.
  if (err.name === 'ProviderTimeoutError') return false;
  // The adapter knows this failure is deterministic — it set `retryable: false`
  // for a request-shaped rejection (providers/chatgpt.ts 400/422). A request we
  // built wrong is not the key's fault, and every future request on this key is
  // unaffected.
  if (err.retryable === false) return false;
  // Request- and credential-shaped rejections. 400/422: the provider read our
  // request and rejected its CONTENT — a sibling request would succeed on this
  // same key. 401: our credential is bad, which is a real problem but not one a
  // 90s rest fixes; validateKey/the health checker disable a genuinely dead key
  // outright, a stronger and more durable response than a cooldown.
  // 403 is deliberately NOT here: it is the provider's tier policy for this
  // key+model, a durable upstream fact, and the caller benches it for a day.
  const status = effectiveStatus(err);
  if (status === 400 || status === 401 || status === 422) return false;
  return true;
}

/** The upstream HTTP status, preferring the structured `err.status` every
 *  adapter sets via providerHttpError and falling back to the "<Name> API error
 *  <status>: …" message format for errors that carry a code only in their text
 *  (the same fallback `attemptReachedProvider` matches on). 0 when neither
 *  carries one — e.g. a dead-turn error off a 200 response. */
function effectiveStatus(err: any): number {
  if (typeof err?.status === 'number') return err.status;
  const m = /api error (\d{3})/.exec((err?.message ?? '').toLowerCase());
  return m ? Number(m[1]) : 0;
}

// A 402 Payment Required / out-of-credits error. Distinct from a transient 429:
// it won't recover on the next window, so the caller benches the model+key with
// PAYMENT_REQUIRED_COOLDOWN_MS (a full day) rather than the 90s transient cooldown.
export function isPaymentRequiredError(err: any): boolean {
  const msg = (err.message ?? '').toLowerCase();
  return msg.includes('402') || msg.includes('payment required')
    || msg.includes('insufficient_quota') || msg.includes('insufficient credit')
    || msg.includes('insufficient balance');
}

// A 404 "model removed/deprecated upstream" error. It's a MODEL-level failure,
// not a key-level one: every key for the platform will 404 the same way, so the
// retry loop skips the entire model for the rest of the request instead of
// burning one fallback attempt per key on the same dead route.
// (PR #111, credits @barbotkonv.)
export function isModelNotFoundError(err: any): boolean {
  // 404 (removed/deprecated) and 410 (permanently Gone) are both MODEL-level: every
  // key for the platform fails the same way, so skip the whole model for the rest
  // of the request instead of burning one fallback attempt per sibling key. 410
  // added for #339 (Ollama Cloud "Gone"); prefer the structured status when present.
  if (err?.status === 404 || err?.status === 410) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('404') || msg.includes('not found') || msg.includes('no endpoints found')
    || msg.includes('410') || msg.includes('gone');
}

// A 403 Forbidden returned for a specific model behind an otherwise-valid key.
// Drives the same whole-model skip as a 404: every key on this platform's tier
// would be forbidden the same model, so rule it out for the rest of the request
// rather than trying it again with a sibling key. Distinct from a dead key —
// validateKey returns false on 401/403, so the health checker disables genuinely
// forbidden keys; a 403 reaching here is model-not-on-this-tier. See issue #256.
export function isModelAccessForbiddenError(err: any): boolean {
  if (err?.status === 403) return true;
  const msg = (err?.message ?? '').toLowerCase();
  return msg.includes('403') || msg.includes('forbidden');
}
