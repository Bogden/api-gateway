import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { providerAtFault, attemptReachedProvider, isRetryableError } from '../../lib/error-classify.js';

// The THIRD question this file answers, after "should we fail over?"
// (isRetryableError) and "did this attempt spend the provider's quota?"
// (attemptReachedProvider): is the failure attributable to the PROVIDER, such
// that RESTING this key is the right response?
//
// The cooldown sites used to stand isRetryableError in for this. Retryable is
// deliberately generous — it says yes to `fetch failed` because the next
// provider is a different host/DNS/TLS path — so a total local network outage
// benched every key the routing loop touched, for a fault on our side of the
// wire, with a bench that persists past the outage.

const here = path.dirname(fileURLToPath(import.meta.url));
const routesDir = path.resolve(here, '../../routes');
const readRoute = (f: string) => readFileSync(path.join(routesDir, f), 'utf8');

// The attribution table. Each row: the error as the code actually produces it,
// whether the provider is at fault, and why.
const TABLE: Array<{
  what: string;
  err: () => any;
  atFault: boolean;
  why: string;
}> = [
  {
    what: 'local timeout (our dispatch deadline)',
    err: () => { const e = new Error('Provider request timed out after 60000ms'); e.name = 'ProviderTimeoutError'; return e; },
    atFault: false,
    why: 'our number, and the timer starts before the connection is established',
  },
  {
    what: 'fetch failed (transport death before the request left the box)',
    err: () => Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo EAI_AGAIN') }),
    atFault: false,
    why: 'nothing reached the provider; it carries no evidence about it at all',
  },
  {
    what: 'ECONNREFUSED',
    err: () => new Error('connect ECONNREFUSED 127.0.0.1:443'),
    atFault: false,
    why: 'same as fetch failed — a local/pre-flight transport death',
  },
  {
    what: 'client abort',
    err: () => { const e = new Error('request aborted by client'); e.name = 'RequestAbortError'; return e; },
    atFault: false,
    why: 'the caller hung up; the provider never finished answering',
  },
  {
    what: '400 (provider read our request and rejected its content)',
    err: () => Object.assign(new Error('flaky API error 400: unsupported parameter'), { status: 400 }),
    atFault: false,
    why: 'our request shape — a sibling request succeeds on this same key',
  },
  {
    what: '400/422 the adapter marked retryable:false',
    err: () => Object.assign(new Error('ChatGPT Responses API error 400: bad input'), { status: 400, retryable: false }),
    atFault: false,
    why: 'the adapter knows it is a deterministic request-shaped rejection',
  },
  {
    what: '401 (bad or expired credential)',
    err: () => Object.assign(new Error('flaky API error 401: invalid api key'), { status: 401 }),
    atFault: false,
    why: 'our credential; validateKey/the health checker disable a dead key outright',
  },
  {
    what: '403 (model off-limits to this key tier)',
    err: () => Object.assign(new Error('flaky API error 403: forbidden'), { status: 403 }),
    atFault: true,
    why: "the provider's own tier policy for this key+model — a durable upstream fact",
  },
  {
    what: '404/410 (model pulled upstream)',
    err: () => Object.assign(new Error('flaky API error 404: no endpoints found'), { status: 404 }),
    atFault: true,
    why: 'the provider removed the model; it stays gone until they bring it back',
  },
  {
    what: '402 (this key is out of credits upstream)',
    err: () => Object.assign(new Error('flaky API error 402: payment required'), { status: 402 }),
    atFault: true,
    why: 'upstream account state for this key — resting it is the entire point',
  },
  {
    what: '429 (the provider rate-limited us)',
    err: () => Object.assign(new Error('flaky API error 429: too many requests'), { status: 429 }),
    atFault: true,
    why: "the provider's own limit; backing off is exactly the asked-for response",
  },
  {
    what: '5xx (provider outage)',
    err: () => Object.assign(new Error('flaky API error 503: service unavailable'), { status: 503 }),
    atFault: true,
    why: 'the provider is broken right now; resting spares the next request',
  },
  {
    what: 'dead turn off a 200 (empty completion / stalled stream)',
    err: () => new Error('empty completion from flaky'),
    atFault: true,
    why: 'the provider answered 200 and produced nothing usable — a bad response',
  },
];

describe('providerAtFault — the attribution table', () => {
  for (const row of TABLE) {
    it(`${row.atFault ? 'RESTS' : 'spares'} the key on ${row.what} — ${row.why}`, () => {
      expect(providerAtFault(row.err())).toBe(row.atFault);
    });
  }

  it('a missing error is never the provider\'s fault', () => {
    expect(providerAtFault(undefined)).toBe(false);
    expect(providerAtFault(null)).toBe(false);
  });

  it('reads a status carried only in the message text, with no err.status', () => {
    // Adapters that attach no numeric status still format "<Name> API error <n>".
    expect(providerAtFault(new Error('flaky API error 400: bad params'))).toBe(false);
    expect(providerAtFault(new Error('flaky API error 429: slow down'))).toBe(true);
  });
});

describe('providerAtFault vs attemptReachedProvider — a strict subset, not a synonym', () => {
  // Both predicates must exist. They agree on most rows, which is why the
  // cooldown sites got away with conflating a related pair for so long, but the
  // rows where they disagree are exactly the ones that matter.

  it('provider-at-fault implies reached-the-provider, for every row in the table', () => {
    // The nesting direction: nothing that never reached the provider can be its
    // fault. Enforced structurally by providerAtFault's first check.
    for (const row of TABLE) {
      const err = row.err();
      if (providerAtFault(err)) {
        expect(attemptReachedProvider(err), `${row.what} is at-fault but not reached`).toBe(true);
      }
    }
  });

  it('but the converse fails: reached-and-charged yet NOT the key\'s fault', () => {
    // This gap is the whole reason a second predicate is needed rather than
    // reusing attemptReachedProvider at the cooldown sites.
    const ourRequestShape = Object.assign(new Error('flaky API error 400: unsupported parameter'), { status: 400 });
    expect(attemptReachedProvider(ourRequestShape)).toBe(true);   // charge the quota
    expect(providerAtFault(ourRequestShape)).toBe(false);          // but do not rest the key

    const ourDeadline = new Error('Provider request timed out after 60000ms');
    ourDeadline.name = 'ProviderTimeoutError';
    expect(attemptReachedProvider(ourDeadline)).toBe(true);
    expect(providerAtFault(ourDeadline)).toBe(false);
  });

  it('the not-reached-but-at-fault cell is empty by construction', () => {
    for (const row of TABLE) {
      const err = row.err();
      if (!attemptReachedProvider(err)) expect(providerAtFault(err)).toBe(false);
    }
  });
});

describe('providerAtFault vs isRetryableError — also different questions', () => {
  it('fetch failed is retryable but never rests a key (the outage cell)', () => {
    const outage = Object.assign(new TypeError('fetch failed'), { cause: new Error('EAI_AGAIN') });
    // Failover behavior is deliberately unchanged by this split.
    expect(isRetryableError(outage)).toBe(true);
    expect(providerAtFault(outage)).toBe(false);
  });

  it('a 429 is both retryable and rest-worthy', () => {
    const limited = Object.assign(new Error('flaky API error 429: too many'), { status: 429 });
    expect(isRetryableError(limited)).toBe(true);
    expect(providerAtFault(limited)).toBe(true);
  });
});

describe('no cooldown site keys its bench off the retryable predicate', () => {
  // Structural guard, in the spirit of error-classify-retryable.test.ts: the
  // conflation is easy to reintroduce by copying a nearby line, so pin that
  // every setCooldown call is reached under a providerAtFault check.
  for (const file of ['proxy.ts', 'responses.ts', 'anthropic.ts']) {
    it(`${file} gates every retry-loop setCooldown on providerAtFault`, () => {
      const src = readRoute(file);
      expect(src).toContain('providerAtFault');

      // The rule, stated semantically rather than as a magic count: a
      // setCooldown whose duration is derived from a caught ERROR is a bench
      // decided by that error's class, so it must sit under a providerAtFault
      // guard. The dead-turn sites (empty completion, unparseable dialect) pass
      // no error at all — a literal `false`/`{}` — because they are reached only
      // from a 200 the provider answered with garbage, which is
      // provider-at-fault by construction. Those stay exempt.
      const lines = src.split('\n');
      const unguarded: number[] = [];
      lines.forEach((line, i) => {
        if (!/\bsetCooldown\(/.test(line)) return;
        // Accumulate the whole call statement, which spans several lines.
        let depth = 0;
        let stmt = '';
        for (let j = i; j < lines.length; j++) {
          stmt += lines[j] + '\n';
          for (const ch of lines[j]) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
          }
          if (depth <= 0) break;
        }
        const errorDerived = /\b(err|lastError)\b/.test(stmt);
        if (!errorDerived) return;   // dead-turn bench, no error object
        const window = lines.slice(Math.max(0, i - 12), i).join('\n');
        if (!/providerAtFault\(/.test(window)) unguarded.push(i + 1);
      });

      expect(unguarded, `unguarded error-derived setCooldown in ${file}`).toEqual([]);
    });
  }
});
