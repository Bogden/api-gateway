import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getCodexCredential,
  getStoredCodexAccountId,
  CodexCredentialsError,
  codexAuthPath,
} from '../../lib/codex-auth.js';

// Build an unsigned JWT with the given payload (base64url).
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function tmpCodexHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-test-'));
}

describe('codex-auth', () => {
  let home: string | undefined;
  const origEnv = process.env.CODEX_HOME;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
    if (origEnv === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = origEnv;
  });

  it('throws an actionable CodexCredentialsError when auth.json is missing', async () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    await expect(getCodexCredential()).rejects.toBeInstanceOf(CodexCredentialsError);
    await expect(getCodexCredential()).rejects.toThrow(/codex login/i);
  });

  it('returns access token + account id from a valid, non-expired login', async () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    const farFuture = Math.floor(Date.now() / 1000) + 3600 * 24 * 365;
    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: farFuture }),
          refresh_token: 'rt-abc',
          account_id: 'acct-123',
        },
      }),
    );
    const fetchSpy = vi.spyOn(global, 'fetch');
    const cred = await getCodexCredential();
    expect(cred.accountId).toBe('acct-123');
    expect(cred.accessToken).toContain('.');
    // No refresh should have been attempted for a live token.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reads the stored account id without refreshing tokens', () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    const expired = Math.floor(Date.now() / 1000) - 10;
    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: expired }),
          refresh_token: 'rt-abc',
          account_id: 'acct-status',
        },
      }),
    );
    const fetchSpy = vi.spyOn(global, 'fetch');
    expect(getStoredCodexAccountId()).toBe('acct-status');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('distinguishes an unreadable credential store from a readable login with no account id', () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    expect(getStoredCodexAccountId()).toBeUndefined();

    fs.writeFileSync(codexAuthPath(), '{');
    expect(getStoredCodexAccountId()).toBeUndefined();

    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({ tokens: { access_token: 'opaque', refresh_token: 'rt' } }),
    );
    expect(getStoredCodexAccountId()).toBeNull();
  });

  it('derives the account id from the id_token claim when account_id is absent', async () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    const farFuture = Math.floor(Date.now() / 1000) + 3600;
    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: farFuture }),
          refresh_token: 'rt-abc',
          id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-from-claim' } }),
        },
      }),
    );
    const cred = await getCodexCredential();
    expect(cred.accountId).toBe('acct-from-claim');
  });

  it('refreshes an expired access token and persists the rotated tokens', async () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    const expired = Math.floor(Date.now() / 1000) - 10;
    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: expired }),
          refresh_token: 'rt-old',
          account_id: 'acct-123',
        },
      }),
    );
    const newFuture = Math.floor(Date.now() / 1000) + 3600;
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ access_token: jwt({ exp: newFuture }), refresh_token: 'rt-new' }),
    } as any);

    const cred = await getCodexCredential();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://auth.openai.com/oauth/token');
    const body = JSON.parse((init as any).body);
    expect(body.grant_type).toBe('refresh_token');
    expect(body.refresh_token).toBe('rt-old');
    expect(body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    // Rotated tokens persisted back to auth.json.
    const persisted = JSON.parse(fs.readFileSync(codexAuthPath(), 'utf8'));
    expect(persisted.tokens.refresh_token).toBe('rt-new');
    expect(cred.accountId).toBe('acct-123');
  });

  it('surfaces a CodexCredentialsError when the refresh is rejected', async () => {
    home = tmpCodexHome();
    process.env.CODEX_HOME = home;
    const expired = Math.floor(Date.now() / 1000) - 10;
    fs.writeFileSync(
      codexAuthPath(),
      JSON.stringify({ tokens: { access_token: jwt({ exp: expired }), refresh_token: 'rt-old' } }),
    );
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({ ok: false, status: 400 } as any);
    await expect(getCodexCredential()).rejects.toBeInstanceOf(CodexCredentialsError);
  });
});
