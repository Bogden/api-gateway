import crypto from 'crypto';
import Database from 'better-sqlite3';

const ALGORITHM = 'aes-256-gcm';

let cachedKey: Buffer | null = null;

/**
 * AES-256-GCM uses a 32-byte key, hex-encoded as 64 chars.
 * A typo'd ENCRYPTION_KEY (e.g. "abc") would historically fall through
 * the placeholder check, get truncated to 1.5 bytes, and only fail at
 * the first encrypt() call with a cryptic node:crypto error. Validate
 * the length up front and fail fast with an actionable message.
 */
const KEY_BYTES = 32;
const KEY_HEX_LEN = KEY_BYTES * 2;
const PLACEHOLDER_KEY = 'your-64-char-hex-key-here';

function parseHexKey(value: string, source: 'env' | 'db'): Buffer {
  if (value.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(value)) {
    throw new Error(
      `Invalid ENCRYPTION_KEY (${source}): expected ${KEY_HEX_LEN} hex chars (32 bytes), got ${value.length} chars. ` +
      `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(value, 'hex');
}

/**
 * The DB-stored fallback key is NOT encryption: it sits in the same SQLite file
 * as the ciphertext it protects, so anyone who can read the DB can read every
 * stored provider key. It exists only so a fresh clone (`npm run dev`) boots
 * without manual setup — the placeholder ENCRYPTION_KEY in .env.example would
 * otherwise crash the server, which surfaces in the client as "Can't reach the
 * server".
 *
 * It is therefore gated on an EXPLICIT opt-in env var, never on an inferred
 * signal. It used to be gated on `NODE_ENV !== 'production'`, which meant any
 * deployment that simply never set NODE_ENV — the common case for a systemd
 * unit or a bare `node dist/index.js` — silently got the insecure mode with a
 * single console.warn as its only trace. Absence of a variable must never be
 * what turns encryption off.
 */
const DEV_FALLBACK_ENV = 'API_GATEWAY_ALLOW_INSECURE_DB_KEY';
const OPT_IN_TRUE = new Set(['1', 'true', 'yes', 'on']);
const OPT_IN_FALSE = new Set(['', '0', 'false', 'no', 'off']);

function devFallbackOptIn(): boolean {
  const raw = process.env[DEV_FALLBACK_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (OPT_IN_TRUE.has(value)) return true;
  if (OPT_IN_FALSE.has(value)) return false;
  // Never guess: an unreadable opt-in that we quietly treat as "off" would
  // reproduce the same silent-degradation class in the other direction.
  throw new Error(
    `${DEV_FALLBACK_ENV} is set to an unrecognized value. ` +
    `Use one of 1/true/yes/on to opt in, or 0/false/no/off (or unset it) to require ENCRYPTION_KEY. ` +
    'Refusing to guess.',
  );
}

function missingKeyError(): Error {
  return new Error(
    '\n' +
    '='.repeat(78) + '\n' +
    'FATAL: ENCRYPTION_KEY is not set — refusing to start.\n' +
    '\n' +
    'Stored provider API keys are encrypted with this key. Without it the only\n' +
    'other option is a key generated into the SAME SQLite file as the encrypted\n' +
    'data, which protects nothing. That mode is now opt-in and off by default.\n' +
    '\n' +
    'To fix, add to .env (or the service EnvironmentFile):\n' +
    `  ENCRYPTION_KEY=<${KEY_HEX_LEN} hex chars>\n` +
    '  generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
    '\n' +
    'For local development ONLY, the insecure DB-stored key can be re-enabled with:\n' +
    `  ${DEV_FALLBACK_ENV}=1\n` +
    'Never set that on a host holding real provider keys.\n' +
    '='.repeat(78),
  );
}

function productionOptInError(): Error {
  return new Error(
    '\n' +
    '='.repeat(78) + '\n' +
    `FATAL: ${DEV_FALLBACK_ENV} is set while NODE_ENV=production — refusing to start.\n` +
    '\n' +
    'The DB-stored fallback key offers no protection for real provider keys.\n' +
    `Unset ${DEV_FALLBACK_ENV} and set a real ENCRYPTION_KEY instead.\n` +
    '='.repeat(78),
  );
}

function warnInsecureFallback(detail: string): void {
  console.warn(
    '\n' +
    '!'.repeat(78) + '\n' +
    `[crypto] INSECURE MODE — ${DEV_FALLBACK_ENV} is set and ENCRYPTION_KEY is not.\n` +
    `[crypto] ${detail}\n` +
    '[crypto] The encryption key is stored in the same database file as the data it\n' +
    '[crypto] encrypts. Anyone who can read that file can read every stored API key.\n' +
    '[crypto] This is for local development only. Set ENCRYPTION_KEY for any real use.\n' +
    '!'.repeat(78),
  );
}

/**
 * A DB-stored fallback key left over from an earlier insecure boot stays in the
 * settings table forever. It is inert while ENCRYPTION_KEY is set, but it is
 * both a plaintext key sitting next to the data and the thing that would be
 * picked up again if the opt-in were ever re-enabled. Surface it; never delete
 * it automatically — data encrypted under it would become unrecoverable.
 */
function warnIfStaleDbKey(db: Database.Database): void {
  try {
    const row = db
      .prepare("SELECT 1 AS present FROM settings WHERE key = 'encryption_key'")
      .get() as { present: number } | undefined;
    if (!row) return;
    console.warn(
      "[crypto] NOTE: a legacy 'encryption_key' row is present in the settings table — residue from an " +
      'earlier insecure-fallback boot. ENCRYPTION_KEY takes precedence, so it is unused, but it is a ' +
      'plaintext key stored beside the encrypted data. Remove it once you have confirmed nothing is ' +
      'still encrypted under it.',
    );
  } catch {
    // A caller that has not created the settings table yet (import scripts,
    // partial fixtures) must not fail to boot over an advisory notice.
  }
}

/**
 * Initialize encryption key from env, or from an explicitly opted-in local-dev
 * fallback. Must be called after DB is initialized.
 */
export function initEncryptionKey(db: Database.Database): void {
  // 1. Check env var
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey && envKey !== PLACEHOLDER_KEY) {
    cachedKey = parseHexKey(envKey, 'env');
    warnIfStaleDbKey(db);
    return;
  }

  // No usable ENCRYPTION_KEY. The insecure fallback requires an explicit opt-in
  // — absence of any variable now fails loudly instead of degrading silently.
  if (!devFallbackOptIn()) {
    throw missingKeyError();
  }
  if (process.env.NODE_ENV === 'production') {
    throw productionOptInError();
  }

  // 2. Check DB for persisted key
  const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string } | undefined;
  if (row) {
    cachedKey = parseHexKey(row.value, 'db');
    warnInsecureFallback('Using the auto-generated key already persisted in the local DB.');
    return;
  }

  // 3. Generate and persist
  cachedKey = crypto.randomBytes(KEY_BYTES);
  db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run(cachedKey.toString('hex'));
  warnInsecureFallback('Generated a new key and persisted it into the local DB.');
}

function getEncryptionKey(): Buffer {
  if (!cachedKey) {
    throw new Error('Encryption key not initialized. Call initEncryptionKey() first.');
  }
  return cachedKey;
}

export function encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return {
    encrypted,
    iv: iv.toString('hex'),
    authTag,
  };
}

export function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****' + key.slice(-4);
  return key.slice(0, 4) + '...' + key.slice(-4);
}
