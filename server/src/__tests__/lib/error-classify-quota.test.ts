import { describe, it, expect } from 'vitest';
import { indicatesQuotaExhaustion, attemptReachedProvider } from '../../lib/error-classify.js';

// Two SEPARATE questions about a failed attempt, deliberately not collapsed
// into one (card c4406):
//
//   attemptReachedProvider   → do we BILL it against the usage counter?
//   indicatesQuotaExhaustion → may it ESCALATE the bench onto the daily
//                              2m→10m→1h→24h ladder?
//
// The deciding line for the first is "did the request leave the box", NOT
// "was it accepted". A refusal still counts: the provider saw it and may well
// have counted it on its side, and undercounting silently overruns a real
// budget.
//
// The deciding line for the second is narrower — does the response actually
// mean this key is out of quota TODAY. Refusals split in two here:
//   429/402         → about the key's remaining budget. Real evidence.
//   400/422/404/401 → about OUR call, or a durable access fact. Not evidence.
// Quarantining a healthy key for a day because we sent a malformed request is
// the same defect as billing a request that never left the box.
//
// Three cases the card is about, pinned below:
//   1. blocked locally, never sent  → neither billed nor escalated
//   2. reached but counted nowhere  → billed
//   3. reached and refused          → billed; escalates only if budget-shaped

const withStatus = (message: string, status: number) =>
  Object.assign(new Error(message), { status });

describe('case 1 — blocked locally, never sent', () => {
  // Our own ChatGPT plan-cooldown guard throws a self-imposed 429 precisely to
  // AVOID dispatching, and the Responses translator throws a 400 while building
  // the request. Both are shaped like an upstream answer. Neither may touch
  // provider quota in any form.
  it('a self-imposed refusal is neither billed nor allowed to escalate', () => {
    const selfImposed = Object.assign(new Error('subscription usage window exhausted'), {
      status: 429,
      reachedProvider: false,
    });
    expect(attemptReachedProvider(selfImposed)).toBe(false);
    expect(indicatesQuotaExhaustion(selfImposed)).toBe(false);
  });

  it('a pre-dispatch translation rejection is neither billed nor allowed to escalate', () => {
    const preDispatch = Object.assign(new Error('translation rejected input'), {
      status: 400,
      reachedProvider: false,
    });
    expect(attemptReachedProvider(preDispatch)).toBe(false);
    expect(indicatesQuotaExhaustion(preDispatch)).toBe(false);
  });

  it('transport deaths and client aborts are neither billed nor allowed to escalate', () => {
    const abort = new Error('request aborted by client');
    abort.name = 'RequestAbortError';
    for (const err of [
      new Error('connect ECONNREFUSED 127.0.0.1:443'),
      new TypeError('fetch failed'),
      new Error('getaddrinfo ENOTFOUND api.example.com'),
      abort,
      null,
      undefined,
    ]) {
      expect(attemptReachedProvider(err), String(err)).toBe(false);
      expect(indicatesQuotaExhaustion(err), String(err)).toBe(false);
    }
  });
});

describe('case 2 — reached the provider but counted nowhere', () => {
  it('a dead-turn wrapper with no status at all is still billed', () => {
    // /v1/messages rethrows a mid-stream death as an empty marker class. It is
    // only ever thrown after real bytes streamed, so the provider did the work.
    const streamDied = Object.assign(new Error(''), { reachedProvider: true });
    expect(attemptReachedProvider(streamDied)).toBe(true);
    // It happened, so it counts — but it says nothing about remaining budget.
    expect(indicatesQuotaExhaustion(streamDied)).toBe(false);
  });

  it('dead turns off a 200 are billed but never escalate', () => {
    for (const m of [
      'empty completion (no content, no tool_calls)',
      'in-band provider error from Flaky: overloaded',
      'stream ended unexpectedly',
      'stream stalled',
      'unparseable inline tool-call dialect',
    ]) {
      expect(attemptReachedProvider(new Error(m)), m).toBe(true);
      expect(indicatesQuotaExhaustion(new Error(m)), m).toBe(false);
    }
  });
});

describe('case 3 — reached the provider and it refused', () => {
  it('bills every refusal, budget-shaped or not', () => {
    for (const status of [400, 401, 402, 403, 404, 410, 422, 429]) {
      const err = withStatus(`flaky API error ${status}: refused`, status);
      expect(attemptReachedProvider(err), String(status)).toBe(true);
    }
  });

  it('treats a rate-limit or out-of-credits refusal as real quota evidence', () => {
    expect(indicatesQuotaExhaustion(withStatus('flaky API error 429: too many requests', 429))).toBe(true);
    expect(indicatesQuotaExhaustion(withStatus('flaky API error 402: payment required', 402))).toBe(true);
  });

  it('does NOT treat a request-shaped refusal as quota evidence', () => {
    // These say our call was wrong, or state a durable access fact. Benching a
    // healthy key for a day over any of them is our bug quarantining our key.
    for (const status of [400, 422, 404, 410, 401, 403]) {
      const err = withStatus(`flaky API error ${status}: refused`, status);
      expect(indicatesQuotaExhaustion(err), String(status)).toBe(false);
    }
  });

  it('does not let a readable non-budget status be re-admitted by its wording', () => {
    // A 400 whose text happens to mention "quota" must not climb the ladder —
    // the status is readable and settles it.
    const err = withStatus('flaky API error 400: unknown parameter quota_hint', 400);
    expect(indicatesQuotaExhaustion(err)).toBe(false);
  });

  // KNOWN LIMIT, pinned deliberately rather than papered over. An error whose
  // ONLY evidence is prose — no numeric status, no "<Name> API error <NNN>"
  // wording — is not recognised as having reached the provider at all, so it
  // can be neither billed nor treated as quota evidence. That is a pre-existing
  // property of attemptReachedProvider, and it errs conservative in both
  // directions at once: we under-bill it, and we refuse to quarantine on it.
  // Every adapter in this repo attaches err.status, so this is a gap for a
  // hypothetical future adapter that doesn't, not a live one.
  it('does not treat prose alone as quota evidence when nothing shows it was sent', () => {
    expect(indicatesQuotaExhaustion(new Error('rate limit exceeded'))).toBe(false);
    expect(indicatesQuotaExhaustion(new Error('You exceeded your current quota'))).toBe(false);
  });

  it('reads the wording once something else shows the request was sent', () => {
    // The marker says it left the box; the prose then supplies the meaning.
    // This is the path an adapter without a numeric status would take.
    const sent = (message: string) => Object.assign(new Error(message), { reachedProvider: true });
    expect(indicatesQuotaExhaustion(sent('rate limit exceeded'))).toBe(true);
    expect(indicatesQuotaExhaustion(sent('RESOURCE_EXHAUSTED'))).toBe(true);
    expect(indicatesQuotaExhaustion(sent('You exceeded your current quota'))).toBe(true);
    expect(indicatesQuotaExhaustion(sent('Insufficient credit for this request'))).toBe(true);
    expect(indicatesQuotaExhaustion(sent('stream stalled'))).toBe(false);
  });
});

describe('failures the provider served', () => {
  it('bills a 5xx and our own deadline, but neither escalates', () => {
    const timeout = new Error('Provider request timed out after 60000ms');
    timeout.name = 'ProviderTimeoutError';
    for (const err of [
      withStatus('flaky API error 500: boom', 500),
      withStatus('flaky API error 502: bad gateway', 502),
      withStatus('flaky API error 503: unavailable', 503),
      timeout,
    ]) {
      expect(attemptReachedProvider(err), err.message).toBe(true);
      // A broken provider is not an exhausted budget.
      expect(indicatesQuotaExhaustion(err), err.message).toBe(false);
    }
  });
});
