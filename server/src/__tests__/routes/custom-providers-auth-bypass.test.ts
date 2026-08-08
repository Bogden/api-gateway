import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';

// The custom-provider routers are mounted at root and gated by a path-matching
// conditional in app.ts rather than by a mount-path `requireAuth`. That guard
// must recognize exactly the same requests the router itself routes — anything
// it fails to recognize reaches the handler unauthenticated.
//
// Remote-caller simulation follows requireAuth.test.ts: the TCP peer in a test
// is always loopback (auto-granted), so the app opts into TRUST_PROXY and the
// request carries an X-Forwarded-For claiming a public source.

describe('custom-provider admin routes are gated for remote callers', () => {
  let app: Express;
  const originalTrustProxy = process.env.TRUST_PROXY;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    process.env.TRUST_PROXY = '1';
    initDb(':memory:');
    app = createApp();
  });

  afterAll(() => {
    if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = originalTrustProxy;
  });

  async function remote(method: string, path: string, body?: unknown): Promise<number> {
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: {
        'X-Forwarded-For': '203.0.113.1',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    server.close();
    return res.status;
  }

  it('401s the bare collection paths', async () => {
    expect(await remote('GET', '/api/custom-providers')).toBe(401);
    expect(await remote('PATCH', '/api/custom-providers/some-slug')).toBe(401);
    expect(await remote('PATCH', '/api/custom-models/1')).toBe(401);
  });

  // The bypass: the guard used to test `req.url`, which carries the query
  // string, so `?` where the pattern expected `/` or end-of-string made the
  // protected-path test miss while Express still routed the request to the
  // handler.
  it('401s a request that appends a query string', async () => {
    expect(await remote('GET', '/api/custom-providers?x=1')).toBe(401);
    expect(await remote('GET', '/api/custom-providers?')).toBe(401);
    expect(await remote('POST', '/api/custom-providers?x=1', {
      slug: 'attacker', displayName: 'attacker', baseUrl: 'http://attacker.example/v1',
    })).toBe(401);
  });

  // Express routing is case-insensitive by default, so the handler answers a
  // case-variant path; the guard must match it the same way.
  it('401s a case-variant path', async () => {
    expect(await remote('GET', '/API/Custom-Providers')).toBe(401);
  });
});
