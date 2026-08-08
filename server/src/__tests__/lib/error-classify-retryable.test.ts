import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { isRetryableError, attemptReachedProvider, isPaymentRequiredError } from '../../lib/error-classify.js';

// There used to be TWO isRetryableError implementations: one local to
// routes/proxy.ts (serving /v1/chat/completions and, by re-export,
// /v1/responses) and one in lib/error-classify.ts (serving /v1/messages).
// They drifted in BOTH directions, so "should I fail over?" got a different
// answer depending on which API dialect the client happened to speak. These
// tests pin the single merged predicate's answer for every condition the two
// copies disagreed on, and structurally forbid a second copy from coming back.

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(here, '../../routes');
const readRoute = (f: string) => readFileSync(path.join(routesDir, f), 'utf8');

describe('isRetryableError — divergences between the two former copies', () => {
  // DIVERGENCE 1 (was: proxy-local only). A provider adapter that KNOWS an
  // upstream failure is deterministic sets `retryable = false`
  // (providers/chatgpt.ts:106,436 for Responses 400/422). The lib copy ignored
  // it, so /v1/messages re-ran a request the provider had already said would
  // fail identically — and since fa2f55f those retries also charge the
  // limiter's ledger, so the opt-out now protects real quota too.
  describe('explicit provider opt-out (retryable: false) wins over every heuristic', () => {
    it('does not retry a deterministic 400 the provider marked non-retryable', () => {
      const err = Object.assign(new Error('ChatGPT Responses translation rejected input: bad image block'), {
        status: 400,
        retryable: false,
      });
      // Without the opt-out this is retryable twice over: status/message both
      // look like the retryable "api error 400" class.
      expect(isRetryableError(err)).toBe(false);
    });

    it('does not retry a 422 the provider marked non-retryable', () => {
      const err = Object.assign(new Error('ChatGPT API error 422: unprocessable entity'), {
        status: 422,
        retryable: false,
      });
      expect(isRetryableError(err)).toBe(false);
    });

    it('an undefined retryable flag still lets the heuristics decide', () => {
      const err = Object.assign(new Error('Groq API error 500: internal'), { status: 500 });
      expect(err.retryable).toBeUndefined();
      expect(isRetryableError(err)).toBe(true);
    });
  });

  // DIVERGENCE 2 (was: lib only). err.status is set by every adapter via
  // providerHttpError (providers/base.ts:40). The proxy copy consulted it only
  // for 403, so any upstream code whose TEXT was never enumerated (502, 504,
  // 507, a bare 409/410) fell through to a client-facing 502 and stranded the
  // healthy routes still queued behind it.
  describe('structured upstream status is trusted', () => {
    it('retries a 502 whose message text matches no substring rule', () => {
      expect(isRetryableError(Object.assign(new Error('Bad Gateway'), { status: 502 }))).toBe(true);
    });

    it('retries a 504 whose message text matches no substring rule', () => {
      expect(isRetryableError(Object.assign(new Error('Gateway Time-out'), { status: 504 }))).toBe(true);
    });

    it('retries a 507 whose message text matches no substring rule', () => {
      expect(isRetryableError(Object.assign(new Error('Insufficient Storage'), { status: 507 }))).toBe(true);
    });

    it('retries a bare 409 conflict', () => {
      expect(isRetryableError(Object.assign(new Error('Conflict'), { status: 409 }))).toBe(true);
    });

    it('still refuses a 400/401 that carries a structured status', () => {
      expect(isRetryableError(Object.assign(new Error('Bad Request'), { status: 400 }))).toBe(false);
      expect(isRetryableError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe(false);
    });
  });

  // DIVERGENCE 3 (was: lib only). undici throws `TypeError: fetch failed` for
  // every pre-flight transport death and stashes the real cause on `.cause`,
  // which nothing in this codebase reads. So "fetch failed" is the real-world
  // form of the ECONNREFUSED/ECONNRESET class BOTH copies already agreed was
  // retryable — the proxy copy's econnrefused/econnreset rules almost never
  // fire on an actual undici failure.
  describe('undici transport death ("fetch failed") fails over', () => {
    it('retries a bare undici "fetch failed"', () => {
      expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    });

    it('agrees with the ECONNREFUSED/ECONNRESET rules it is the wrapper for', () => {
      expect(isRetryableError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe(true);
      expect(isRetryableError(new Error('read ECONNRESET'))).toBe(true);
      expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    });
  });

  // DIVERGENCE 4 (was: lib only). A model permanently removed upstream
  // (Ollama Cloud "API error 410: Gone") fails identically on every key for
  // that platform, so the right move is rotating to the next route, not
  // 502-ing the client.
  describe('410 Gone text fallback (adapter that attaches no status)', () => {
    it('retries a 410 seen only in the message text', () => {
      expect(isRetryableError(new Error('Ollama Cloud API error 410: Gone'))).toBe(true);
    });
  });

  // NOT a divergence: both copies computed the same answer for 403, one
  // inline and one via isModelAccessForbiddenError. Pins existing behavior.
  describe('403 model-not-on-this-tier (pins pre-existing behavior)', () => {
    it('retries a 403 by status and by message text', () => {
      expect(isRetryableError(Object.assign(new Error('nope'), { status: 403 }))).toBe(true);
      expect(isRetryableError(new Error('GitHub Models API error 403: Forbidden'))).toBe(true);
    });
  });

  // Pins the shared conditions unchanged by the merge, in the direction that
  // matters most: retrying what should NOT be retried amplifies an outage.
  describe('conditions both copies agreed on stay put (pins pre-existing behavior)', () => {
    it('retries the transient/failover classes', () => {
      for (const m of [
        'Groq API error 429: rate limit exceeded', 'too many requests', 'quota exceeded',
        'RESOURCE_EXHAUSTED', 'ETIMEDOUT', 'request timeout',
        'Cloudflare API error 503: unavailable', 'internal server error',
        'Payload Too Large', 'No endpoints found for x/y:free',
        'HuggingFace API error 402: Payment required',
        'empty completion', 'in-band provider error', 'stream ended unexpectedly',
        'stream stalled', 'unparseable inline tool-call dialect',
        'Cerebras API error 400: tool schema not supported',
      ]) {
        expect(isRetryableError(new Error(m)), m).toBe(true);
      }
    });

    it('refuses our own validation failures and bare auth rejections', () => {
      for (const m of ['400 Bad Request', 'Invalid API key', '401 unauthorized', 'invalid_request_error']) {
        expect(isRetryableError(new Error(m)), m).toBe(false);
      }
    });
  });
});

// The load-bearing finding: "is this retryable?" and "did this reach the
// provider?" are DIFFERENT questions with different callers. isRetryableError
// is forward-looking routing (is another route likely to do better than a 502
// to the client?); attemptReachedProvider is backward-looking accounting (did
// this attempt spend the provider's quota?). All four cells are populated, so
// neither can be derived from the other.
describe('retryable vs reached-the-provider are orthogonal', () => {
  const cell = (err: any) => [isRetryableError(err), attemptReachedProvider(err)];

  it('reached + retryable: provider answered 429, charge it and fail over', () => {
    expect(cell(Object.assign(new Error('Groq API error 429: rate limited'), { status: 429 }))).toEqual([true, true]);
  });

  it('reached + NOT retryable: provider answered and charged us, but no route will do better', () => {
    expect(cell(Object.assign(new Error('ChatGPT API error 400: bad input'), { status: 400, retryable: false })))
      .toEqual([false, true]);
  });

  it('NOT reached + retryable: transport died on our side, so failover is free', () => {
    expect(cell(new TypeError('fetch failed'))).toEqual([true, false]);
    expect(cell(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toEqual([true, false]);
  });

  it('NOT reached + NOT retryable: our own request validation never left the box', () => {
    expect(cell(new Error('400 Bad Request'))).toEqual([false, false]);
  });
});

// Structural guard: the split must not come back. A future edit that pastes a
// second isRetryableError/isPaymentRequiredError into a route file fails here
// even if its behavior happens to match on the day it is written.
describe('one implementation only', () => {
  const routeFiles = ['proxy.ts', 'responses.ts', 'anthropic.ts'];

  it('no route file defines its own copy of the classifiers', () => {
    for (const f of routeFiles) {
      const src = readRoute(f);
      expect(src, `${f} must not define isRetryableError`).not.toMatch(/function\s+isRetryableError\b/);
      expect(src, `${f} must not define isPaymentRequiredError`).not.toMatch(/function\s+isPaymentRequiredError\b/);
    }
  });

  it('every route that classifies errors imports from lib/error-classify', () => {
    for (const f of routeFiles) {
      const src = readRoute(f);
      if (!src.includes('isRetryableError')) continue;
      const imports = src.match(/import\s*{[^}]*}\s*from\s*'[^']*error-classify\.js'/gs) ?? [];
      expect(imports.join(' '), `${f} must import isRetryableError from lib/error-classify`)
        .toMatch(/isRetryableError/);
    }
  });

  it('the classifiers are re-exported from nowhere else', () => {
    for (const f of routeFiles) {
      expect(readRoute(f), `${f} must not re-export the classifiers`)
        .not.toMatch(/export\s*{[^}]*isRetryableError/);
    }
  });
});

describe('isPaymentRequiredError (single copy, pins pre-existing behavior)', () => {
  it('matches the out-of-credits phrasings', () => {
    for (const m of ['API error 402: Payment required', 'insufficient_quota', 'insufficient credit', 'insufficient balance']) {
      expect(isPaymentRequiredError(new Error(m)), m).toBe(true);
    }
    expect(isPaymentRequiredError(new Error('429 rate limited'))).toBe(false);
  });
});
