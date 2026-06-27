import { describe, it, expect, beforeAll } from 'vitest';
import type { Express, Request } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { isLocalCliRequest } from '../../routes/proxy.js';

// The keyless-loopback bypass must trust ONLY the real TCP peer, never
// X-Forwarded-For (forgeable under TRUST_PROXY=1). isLocalCliRequest reads
// req.socket.remoteAddress directly, NOT req.ip — these unit cases pin that:
// the HTTP harness always connects over a loopback socket, so a spoofed-XFF
// remote attacker can't be reproduced end-to-end here.
describe('isLocalCliRequest trusts the socket peer, not X-Forwarded-For', () => {
  const fake = (over: Partial<Request> & { socket?: any }) =>
    ({ headers: {}, ip: undefined, socket: {}, ...over } as unknown as Request);

  it('rejects a remote socket even when req.ip claims loopback (XFF spoof)', () => {
    // The exploit shape: remote TCP peer + spoofed X-Forwarded-For: 127.0.0.1
    // surfacing as req.ip. Must NOT be trusted.
    expect(isLocalCliRequest(fake({ ip: '127.0.0.1', socket: { remoteAddress: '8.8.8.8' } }))).toBe(false);
  });

  it('trusts a loopback socket even when req.ip claims a public address', () => {
    expect(isLocalCliRequest(fake({ ip: '8.8.8.8', socket: { remoteAddress: '127.0.0.1' } }))).toBe(true);
  });

  it('still rejects a loopback socket carrying browser fetch metadata', () => {
    expect(isLocalCliRequest(fake({ socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'https://x.example' } } as any))).toBe(false);
    expect(isLocalCliRequest(fake({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'sec-fetch-site': 'cross-site' } } as any))).toBe(false);
  });
});

async function request(app: Express, method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const server = app.listen(0);
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.text();
  server.close();

  let json: any = null;
  try { json = JSON.parse(data); } catch {}

  return { status: res.status, body: json, headers: res.headers, raw: data };
}

describe('Proxy authentication and CORS', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
  });

  // A provably-non-browser loopback caller (no key, but also no Origin and no
  // Sec-Fetch-Site — i.e. a native CLI like the claude-p fork, not a web page)
  // is now authorized without the unified key. See isLocalCliRequest in
  // routes/proxy.ts: the box is single-user and loopback-only, and the browser
  // header guard below keeps the CSRF/SSRF defense intact.
  it('accepts a key-less non-browser loopback caller', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });

    // Past the 401 gate (routing then fails — no provider keys in the test DB).
    expect(status).not.toBe(401);
    expect(body?.error?.type).not.toBe('authentication_error');
  });

  // …but a key-less loopback request that looks like a browser fetch (carries
  // Origin or Sec-Fetch-Site) is still rejected — that's the CSRF/SSRF vector
  // the unified-key check guards (a malicious page reaching http://127.0.0.1).
  it('rejects a key-less loopback request carrying a browser Origin', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { Origin: 'https://attacker.example' });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('rejects a key-less loopback request carrying Sec-Fetch-Site', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { 'Sec-Fetch-Site': 'cross-site' });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  // #103: Claude Code via CC Switch (and other Anthropic-format clients) send
  // the key in the `x-api-key` header, not as an Authorization bearer token.
  // A wrong key from a browser-shaped request (Origin present, so the local-CLI
  // exception does not apply) is still rejected.
  it('rejects a wrong key supplied via the x-api-key header', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { 'x-api-key': 'api-gateway-wrong-key', Origin: 'https://attacker.example' });

    expect(status).toBe(401);
    expect(body.error.type).toBe('authentication_error');
  });

  it('accepts the unified key supplied via the x-api-key header', async () => {
    const { status, body } = await request(app, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    }, { 'x-api-key': getUnifiedApiKey() });

    // Auth passes — it gets past the 401 gate. (Routing then fails because no
    // provider keys are configured in this test DB, which is fine: we only
    // care that the x-api-key header authenticated.)
    expect(status).not.toBe(401);
    expect(body?.error?.type).not.toBe('authentication_error');
  });

  it('does not grant CORS access to arbitrary browser origins', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'https://attacker.example',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the local dashboard origin through CORS', async () => {
    const { status, headers } = await request(app, 'GET', '/api/ping', undefined, {
      Origin: 'http://localhost:5173',
    });

    expect(status).toBe(200);
    expect(headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
  });
});
