import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initEncryptionKey, encrypt, decrypt } from '../../lib/crypto.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return db;
}

const OPT_IN = 'API_GATEWAY_ALLOW_INSECURE_DB_KEY';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function restoreEnv() {
  delete process.env[OPT_IN];
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

/** The suite-wide ENCRYPTION_KEY must be out of the way to test key-absent paths. */
function noEnvKey() {
  delete process.env.ENCRYPTION_KEY;
}

function hasKeyRow(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM settings WHERE key = 'encryption_key'").get() !== undefined;
}

describe('initEncryptionKey — input validation', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('accepts a valid 64-char hex env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    // Round-trip a value to confirm the key actually works.
    const enc = encrypt('hello');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('hello');
  });

  it('throws on too-short env key (typo guard)', () => {
    process.env.ENCRYPTION_KEY = 'abc';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\).+expected 64 hex chars/);
  });

  it('throws on too-long env key', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(80);
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('throws on non-hex env key of correct length', () => {
    process.env.ENCRYPTION_KEY = 'g'.repeat(64); // g is not hex
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(env\)/);
  });

  it('auto-generates and persists a key with the explicit dev opt-in', () => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = '1';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('loads an existing DB-stored fallback key with the explicit dev opt-in', () => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = '1';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).not.toThrow();
    // The existing key is reused, not overwritten.
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toBe('b'.repeat(64));
  });

  it('treats the placeholder as "not set" and auto-generates under the dev opt-in', () => {
    process.env.ENCRYPTION_KEY = 'your-64-char-hex-key-here';
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = '1';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('throws on a corrupted DB-stored key', () => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = '1';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('not-hex');
    expect(() => initEncryptionKey(db)).toThrow(/Invalid ENCRYPTION_KEY \(db\)/);
  });
});

describe('initEncryptionKey — the fallback is opt-in, never inferred', () => {
  beforeEach(() => {
    restoreEnv();
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // The shape of the real deployment: a systemd unit / bare `node dist/index.js`
  // that never sets NODE_ENV at all. Under the old NODE_ENV-only gate this
  // silently wrote a plaintext key into the credential DB and kept serving.
  it('fails loudly when NODE_ENV is unset and there is no opt-in, and persists nothing', () => {
    noEnvKey();
    delete process.env.NODE_ENV;
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/FATAL: ENCRYPTION_KEY is not set — refusing to start/);
    expect(hasKeyRow(db)).toBe(false);
  });

  it('does not adopt a pre-existing DB key when NODE_ENV is unset and there is no opt-in', () => {
    noEnvKey();
    delete process.env.NODE_ENV;
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).toThrow(/FATAL: ENCRYPTION_KEY is not set/);
  });

  it('fails loudly in production without the key, and persists nothing', () => {
    noEnvKey();
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/FATAL: ENCRYPTION_KEY is not set — refusing to start/);
    expect(hasKeyRow(db)).toBe(false);
  });

  it('does not load a DB-stored fallback key in production', () => {
    noEnvKey();
    process.env.NODE_ENV = 'production';
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).toThrow(/FATAL: ENCRYPTION_KEY is not set/);
  });

  it('refuses the dev opt-in outright when NODE_ENV=production', () => {
    noEnvKey();
    process.env.NODE_ENV = 'production';
    process.env[OPT_IN] = '1';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/is set while NODE_ENV=production — refusing to start/);
    expect(hasKeyRow(db)).toBe(false);
  });

  it('the error names both the fix and the dev opt-in', () => {
    noEnvKey();
    delete process.env.NODE_ENV;
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/ENCRYPTION_KEY=<64 hex chars>/);
    expect(() => initEncryptionKey(db)).toThrow(/API_GATEWAY_ALLOW_INSECURE_DB_KEY=1/);
  });

  it('the explicit dev opt-in still works and shouts about it', () => {
    noEnvKey();
    process.env.NODE_ENV = 'development';
    process.env[OPT_IN] = 'true';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    expect(hasKeyRow(db)).toBe(true);
    // Encryption is actually usable on the dev path.
    const enc = encrypt('dev-secret');
    expect(decrypt(enc.encrypted, enc.iv, enc.authTag)).toBe('dev-secret');
    const shouted = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(shouted).toMatch(/INSECURE MODE/);
    expect(shouted).toMatch(/same database file as the data it/);
  });

  it.each(['yes', 'on', '1', 'TRUE'])('accepts opt-in value %s', (value) => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = value;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
  });

  it.each(['0', 'false', 'off', ''])('treats opt-in value %s as no opt-in', (value) => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = value;
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/FATAL: ENCRYPTION_KEY is not set/);
    expect(hasKeyRow(db)).toBe(false);
  });

  it('refuses to guess at an unrecognized opt-in value', () => {
    noEnvKey();
    process.env.NODE_ENV = 'test';
    process.env[OPT_IN] = 'maybe';
    const db = freshDb();
    expect(() => initEncryptionKey(db)).toThrow(/unrecognized value.+Refusing to guess/s);
    expect(hasKeyRow(db)).toBe(false);
  });

  it('flags a stale DB-stored key as residue when a real ENCRYPTION_KEY is in use', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = freshDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('encryption_key', ?)").run('b'.repeat(64));
    expect(() => initEncryptionKey(db)).not.toThrow();
    const notices = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(notices).toMatch(/legacy 'encryption_key' row is present/);
    // The env key wins; the stale row is never removed automatically.
    const row = db.prepare("SELECT value FROM settings WHERE key = 'encryption_key'").get() as { value: string };
    expect(row.value).toBe('b'.repeat(64));
  });

  it('says nothing about residue when there is none', () => {
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = freshDb();
    expect(() => initEncryptionKey(db)).not.toThrow();
    const notices = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(notices).not.toMatch(/legacy 'encryption_key' row/);
  });
});
