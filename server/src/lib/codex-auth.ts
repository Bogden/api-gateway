// Codex CLI credential store integration.
//
// The `chatgpt` provider authenticates on a ChatGPT subscription using the same
// OAuth credentials the official Codex CLI writes to `~/.codex/auth.json`. There
// is deliberately NO API-key path: subscription access is gated behind the
// ChatGPT OAuth flow, so the gateway reuses whatever the operator already logged
// in with via `codex login`.
//
// Ported from the OAuth handling in bman654/clodex (MIT) — specifically the
// issuer/client-id constants and the refresh-token grant — adapted to this
// gateway's structure. clodex drives an interactive device/PKCE login; here we
// only *consume* an existing login and refresh it, so the interactive flow is
// intentionally omitted (operators run `codex login` in the Codex CLI).
//
// auth.json shape (as written by the Codex CLI):
//   {
//     "OPENAI_API_KEY": null,
//     "tokens": {
//       "id_token": "<jwt>",
//       "access_token": "<jwt>",
//       "refresh_token": "<opaque>",
//       "account_id": "<chatgpt account id>"
//     },
//     "last_refresh": "2026-07-20T12:34:56.000Z"
//   }

import fs from 'fs';
import os from 'os';
import path from 'path';

// These match the official Codex CLI's OAuth values verbatim — reusing the same
// client_id is what lets a non-OpenAI program present itself to the consent
// screen as a Codex client and receive a ChatGPT-subscription-scoped token.
const ISSUER = 'https://auth.openai.com';
const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// Refresh a little before the access token's real expiry so an in-flight
// request never races the deadline.
const EXPIRY_SKEW_MS = 60_000;

/** Resolve the Codex home directory. Mirrors the Codex CLI: honors CODEX_HOME,
 *  else ~/.codex. Exposed as a function so tests can point it at a fixture dir. */
export function codexAuthPath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

/** Thrown when there is no usable Codex login (file missing, malformed, or an
 *  expired token that could not be refreshed). Carries an actionable message
 *  telling the operator to log in via the Codex CLI. Deliberately worded to
 *  avoid the substrings the proxy's retry classifier treats as retryable
 *  (429/timeout/quota/…) so it surfaces immediately instead of being retried
 *  or failed over. */
export class CodexCredentialsError extends Error {
  readonly code = 'CHATGPT_NO_CREDENTIALS';
  readonly status = 401;
  constructor(detail: string) {
    // NOTE: this message must avoid the substrings the proxy's retry classifier
    // treats as retryable (e.g. "unavailable", "timeout", "429") so a genuine
    // login problem surfaces immediately instead of being retried/failed over.
    super(
      `ChatGPT provider cannot authenticate: ${detail}. ` +
        'Log in with the Codex CLI (`codex login`) so ~/.codex/auth.json holds a ' +
        'valid ChatGPT subscription token, then try again.',
    );
    this.name = 'CodexCredentialsError';
  }
}

export interface CodexTokens {
  access_token?: string | null;
  refresh_token?: string | null;
  id_token?: string | null;
  account_id?: string | null;
}

interface CodexAuthFile {
  tokens?: CodexTokens;
  last_refresh?: string;
  OPENAI_API_KEY?: string | null;
}

/** Access token + the ChatGPT account id the Codex backend requires on every
 *  request via the `chatgpt-account-id` header. */
export interface CodexCredential {
  accessToken: string;
  accountId: string | null;
}

/** Decode the payload of a JWT without verifying the signature. Returns null
 *  for anything that doesn't parse — callers treat that as "unknown expiry". */
function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Access-token expiry in ms since epoch, from the JWT `exp` claim. Null when
 *  the token isn't a decodable JWT (then we can't proactively refresh and rely
 *  on a reactive 401 → refresh instead). */
function accessTokenExpiryMs(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken);
  const exp = payload?.exp;
  if (typeof exp === 'number') return exp * 1000;
  return null;
}

/** Derive the ChatGPT account id: prefer the explicit `account_id` field, else
 *  fall back to the id_token's chatgpt_account_id auth claim (the same
 *  precedence the Codex CLI and community ports use). */
function deriveAccountId(tokens: CodexTokens): string | null {
  if (tokens.account_id) return tokens.account_id;
  if (tokens.id_token) {
    const payload = decodeJwtPayload(tokens.id_token);
    const authClaim = payload?.['https://api.openai.com/auth'] as
      | Record<string, unknown>
      | undefined;
    const acct = authClaim?.['chatgpt_account_id'];
    if (typeof acct === 'string') return acct;
  }
  return null;
}

function readAuthFile(): CodexAuthFile | null {
  const authPath = codexAuthPath();
  let raw: string;
  try {
    raw = fs.readFileSync(authPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as CodexAuthFile;
  } catch {
    throw new CodexCredentialsError('~/.codex/auth.json is not valid JSON');
  }
}

function writeAuthFile(file: CodexAuthFile): void {
  const authPath = codexAuthPath();
  try {
    fs.writeFileSync(authPath, JSON.stringify(file, null, 2), { mode: 0o600 });
  } catch (err) {
    // A failed write-back is non-fatal: the refreshed token still works for
    // this process. Log so a persistently unwritable store is diagnosable.
    console.error('[codex-auth] failed to persist refreshed tokens:', err);
  }
}

interface RefreshResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** Exchange a refresh token for a fresh access token via the OAuth token
 *  endpoint, and persist the rotated tokens back to auth.json so this process
 *  and the Codex CLI stay in sync. Throws CodexCredentialsError on failure. */
async function refreshTokens(file: CodexAuthFile, refreshToken: string): Promise<CodexTokens> {
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
    });
  } catch (err) {
    throw new CodexCredentialsError(
      `could not reach the OpenAI token endpoint to refresh the session (${(err as Error).message})`,
    );
  }
  if (!res.ok) {
    throw new CodexCredentialsError(
      `the stored refresh token was rejected (HTTP ${res.status}) — the login has likely expired`,
    );
  }
  const body = (await res.json()) as RefreshResponse;
  if (!body.access_token) {
    throw new CodexCredentialsError('the token refresh response contained no access token');
  }
  const prev = file.tokens ?? {};
  const tokens: CodexTokens = {
    // A refresh may or may not rotate the refresh/id tokens; keep the old ones
    // when the response omits them.
    access_token: body.access_token,
    refresh_token: body.refresh_token ?? prev.refresh_token,
    id_token: body.id_token ?? prev.id_token,
    account_id: prev.account_id,
  };
  writeAuthFile({ ...file, tokens, last_refresh: new Date().toISOString() });
  return tokens;
}

/**
 * Load a usable ChatGPT access token, refreshing proactively when the current
 * one is at/near expiry.
 *
 * @param forceRefresh - refresh even if the access token still looks valid.
 *   Used for the reactive 401 → refresh-and-retry path when the upstream
 *   rejects an access token we believed was live.
 */
export async function getCodexCredential(forceRefresh = false): Promise<CodexCredential> {
  const file = readAuthFile();
  if (!file || !file.tokens) {
    throw new CodexCredentialsError('no Codex login was found at ~/.codex/auth.json');
  }
  const tokens = file.tokens;
  if (!tokens.access_token && !tokens.refresh_token) {
    throw new CodexCredentialsError('the Codex login at ~/.codex/auth.json has no tokens');
  }

  const expiry = tokens.access_token ? accessTokenExpiryMs(tokens.access_token) : null;
  const expired = expiry !== null && Date.now() >= expiry - EXPIRY_SKEW_MS;
  const needRefresh = forceRefresh || expired || !tokens.access_token;

  let active = tokens;
  if (needRefresh) {
    if (!tokens.refresh_token) {
      throw new CodexCredentialsError(
        'the stored access token has expired and no refresh token is available',
      );
    }
    active = await refreshTokens(file, tokens.refresh_token);
  }

  if (!active.access_token) {
    throw new CodexCredentialsError('no access token available after refresh');
  }
  return { accessToken: active.access_token, accountId: deriveAccountId(active) };
}
