import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { ProviderTimeoutError, RequestAbortError } from '../../providers/base.js';

// Regression tests for card c576: a backend that returns 200 headers and then
// stalls forever mid-body used to hang the client, because fetchWithTimeout's
// abort timer is cleared once headers arrive. Every buffered post-headers read
// now goes through BaseProvider.readBodyText, which applies a per-read
// inactivity deadline and honors the caller's abort signal.

describe('post-headers body-read deadline (card c576)', () => {
  let server: http.Server | undefined;

  afterEach(async () => {
    if (server) {
      // The stalled request keeps a socket open, so close() alone would hang;
      // drop live connections first.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  /**
   * Start a server that sends `status` + headers, then never writes the body.
   * With a non-200 status this exercises the ERROR branch (card c1268): the
   * provider reads the error body to build its message, which must be bounded
   * by the same deadline as the success path.
   */
  async function startStallingServer(status = 200): Promise<string> {
    server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      // Flush the status + headers to the client so fetch() resolves and we
      // enter the body-read phase — then never write/end the body, so the body
      // stalls forever. This is exactly the bug: headers arrive, then silence.
      res.flushHeaders();
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  function makeProvider(baseUrl: string): OpenAICompatProvider {
    const p = new OpenAICompatProvider({
      platform: 'openrouter',
      name: 'StallTest',
      baseUrl,
      // Keep the connect/headers timeout generous so the STALL (not the
      // connect deadline) is what trips — headers arrive immediately.
      timeoutMs: 60000,
    });
    // Inject a short body-read deadline instead of the production 300s.
    (p as unknown as { bodyReadTimeoutMs: number }).bodyReadTimeoutMs = 150;
    return p;
  }

  it('rejects with ProviderTimeoutError when the body stalls after 200 headers', async () => {
    const baseUrl = await startStallingServer();
    const provider = makeProvider(baseUrl);

    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'model-x'),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('rejects with ProviderTimeoutError when a non-200 error body stalls (card c1268)', async () => {
    // A backend that returns error headers (500) then stalls the body used to
    // hang the provider attempt in the `!res.ok` error-message read. That read
    // now goes through readBodyText, so the inactivity deadline trips instead.
    const baseUrl = await startStallingServer(500);
    const provider = makeProvider(baseUrl);

    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'model-x'),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('rejects with RequestAbortError when the caller aborts the stalled body read', async () => {
    const baseUrl = await startStallingServer();
    const provider = makeProvider(baseUrl);
    // Push the body-read deadline out so the ABORT wins the race, not the timer.
    (provider as unknown as { bodyReadTimeoutMs: number }).bodyReadTimeoutMs = 60000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50);

    try {
      await expect(
        provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'model-x', {
          abortSignal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(RequestAbortError);
    } finally {
      clearTimeout(timer);
    }
  });
});
