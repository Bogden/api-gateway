import { describe, it, expect } from 'vitest';
import { attemptConsumedQuota, attemptReachedProvider } from '../../lib/error-classify.js';

// "Did this attempt SPEND the account's request quota?" — the predicate that
// gates recordFailedRequest, and the fourth distinct question in
// error-classify.ts. Two separate defects live here (card c4406):
//
//  1. `attemptReachedProvider` inferred an HTTP round trip from the SHAPE of an
//     error. Two shapes lie. A locally-synthesized failure can carry a
//     real-looking status it never got from a provider (our own ChatGPT plan
//     cooldown is a self-imposed 429 thrown SPECIFICALLY to avoid dispatching;
//     the Responses translation rejection is a 400 thrown while building the
//     request) — both were charged for a call that never left the box. And a
//     dead-turn wrapper can carry NO status although the provider streamed real
//     bytes — /v1/messages rethrows mid-stream deaths as an empty marker class,
//     so the one route that had certainly spent quota recorded nothing.
//     Fixed with an explicit `reachedProvider` marker the thrower sets.
//
//  2. Reaching the provider was treated as sufficient to bill the attempt. It
//     isn't: a 429/402/403/401 is the provider REFUSING at the gate, not
//     serving. Free tiers don't generally bill a refusal, and the retry loop
//     makes PER_KEY_RETRIES attempts — so one refused request moved the daily
//     counter three times. That counter is what promotes a 90s rest onto the
//     2m→10m→1h→24h ladder, so keys were quarantined for a day on usage that
//     never happened.

const withStatus = (message: string, status: number) =>
  Object.assign(new Error(message), { status });

describe('attemptConsumedQuota — the provider SERVED it', () => {
  it('charges a 5xx: the provider accepted the request and broke trying', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 500: boom', 500))).toBe(true);
    expect(attemptConsumedQuota(withStatus('flaky API error 502: bad gateway', 502))).toBe(true);
    expect(attemptConsumedQuota(withStatus('flaky API error 503: unavailable', 503))).toBe(true);
  });

  it('charges a 400/422: the provider parsed our request and rejected its content', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 400: bad param', 400))).toBe(true);
    expect(attemptConsumedQuota(withStatus('flaky API error 422: unprocessable', 422))).toBe(true);
  });

  it('charges a 404/410: the provider resolved the route and answered', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 404: no such model', 404))).toBe(true);
    expect(attemptConsumedQuota(withStatus('flaky API error 410: gone', 410))).toBe(true);
  });

  it('charges our own dispatch deadline: the provider has the request', () => {
    const timeout = new Error('Provider request timed out after 60000ms');
    timeout.name = 'ProviderTimeoutError';
    expect(attemptConsumedQuota(timeout)).toBe(true);
  });

  it('charges a dead turn off a 200: it streamed, then the turn died', () => {
    for (const m of [
      'empty completion (no content, no tool_calls)',
      'in-band provider error from Flaky: overloaded',
      'stream ended unexpectedly',
      'stream stalled',
      'unparseable inline tool-call dialect',
    ]) {
      expect(attemptConsumedQuota(new Error(m)), m).toBe(true);
    }
  });
});

describe('attemptConsumedQuota — the provider REFUSED it at the gate', () => {
  // The behavior change. These all still reach the provider, and a 429 still
  // rests the key via providerAtFault — this predicate only decides billing.
  it('does not charge a 429: we were over a limit, so it declined to do the work', () => {
    const rateLimited = withStatus('flaky API error 429: too many requests', 429);
    expect(attemptReachedProvider(rateLimited)).toBe(true);
    expect(attemptConsumedQuota(rateLimited)).toBe(false);
  });

  it('does not charge a 402: the account is out of credits', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 402: payment required', 402))).toBe(false);
  });

  it('does not charge a 403: this key\'s tier may not have the model', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 403: forbidden', 403))).toBe(false);
  });

  it('does not charge a 401: the credential was rejected before anything ran', () => {
    expect(attemptConsumedQuota(withStatus('flaky API error 401: unauthorized', 401))).toBe(false);
  });

  it('reads the status out of the message when no numeric status is attached', () => {
    // Adapters normally set err.status, but the "<Name> API error <NNN>" text
    // is the documented fallback and must not silently bill a refusal.
    expect(attemptConsumedQuota(new Error('flaky API error 429: slow down'))).toBe(false);
    expect(attemptConsumedQuota(new Error('flaky API error 500: boom'))).toBe(true);
  });
});

describe('attemptConsumedQuota — nothing left the box', () => {
  it('does not charge transport deaths', () => {
    expect(attemptConsumedQuota(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(false);
    expect(attemptConsumedQuota(new TypeError('fetch failed'))).toBe(false);
    expect(attemptConsumedQuota(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe(false);
  });

  it('does not charge a client abort, or a null error', () => {
    const abort = new Error('request aborted by client');
    abort.name = 'RequestAbortError';
    expect(attemptConsumedQuota(abort)).toBe(false);
    expect(attemptConsumedQuota(null)).toBe(false);
    expect(attemptConsumedQuota(undefined)).toBe(false);
  });
});

describe('the explicit reachedProvider marker overrides the shape heuristics', () => {
  it('a self-imposed failure carrying a real-looking status is not charged', () => {
    // The shape says "a provider answered 400". The marker says we never
    // dispatched. The marker wins — this is the ChatGPT translation-rejection
    // case, which the status rules alone would have billed.
    const selfImposed = Object.assign(new Error('translation rejected input'), {
      status: 400,
      reachedProvider: false,
    });
    expect(attemptReachedProvider(selfImposed)).toBe(false);
    expect(attemptConsumedQuota(selfImposed)).toBe(false);
  });

  it('a dead-turn wrapper carrying no status at all IS charged', () => {
    // The mirror image: shape says "nothing reached the provider" because the
    // wrapper is empty, but it is only ever thrown after real bytes streamed.
    const streamDied = Object.assign(new Error(''), { reachedProvider: true });
    expect(attemptReachedProvider(streamDied)).toBe(true);
    expect(attemptConsumedQuota(streamDied)).toBe(true);
  });

  it('the marker does not let a refusal through the billing gate', () => {
    // reachedProvider:true is about REACH, not about being served. A 429 that
    // explicitly reached the provider still must not be billed.
    const refused = Object.assign(new Error('over limit'), {
      status: 429,
      reachedProvider: true,
    });
    expect(attemptReachedProvider(refused)).toBe(true);
    expect(attemptConsumedQuota(refused)).toBe(false);
  });
});
