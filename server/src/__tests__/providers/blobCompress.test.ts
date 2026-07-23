import { describe, it, expect } from 'vitest';
import { compressBlob } from '../../providers/blobCompress.js';

// Pad a JSON string with extra key/value pairs so it clears the 1024-char gate
// without changing the shape callers are asserting on.
function pad(json: object, targetLen = 1200): string {
  let s = JSON.stringify(json, null, 2);
  let i = 0;
  const obj: any = JSON.parse(s);
  while (s.length < targetLen) {
    obj[`__pad${i}`] = 'x'.repeat(20);
    s = JSON.stringify(obj, null, 2);
    i++;
  }
  return s;
}

describe('compressBlob', () => {
  it('strips whitespace from a pretty-printed JSON blob above the threshold, preserving semantics', () => {
    const input = pad({ tool: 'read_file', lines: Array.from({ length: 30 }, (_, i) => `line ${i}`) });
    expect(input.length).toBeGreaterThanOrEqual(1024);
    const output = compressBlob(input);
    expect(output.length).toBeLessThan(input.length);
    expect(JSON.parse(output)).toEqual(JSON.parse(input));
  });

  it('preserves big integers verbatim (no parse/reserialize round-trip)', () => {
    const raw = `{\n  "id": 12345678901234567890,\n  "pad": "${'x'.repeat(1100)}"\n}`;
    expect(raw.length).toBeGreaterThanOrEqual(1024);
    // Prove it's valid JSON per the gate (JSON.parse will round the bigint,
    // but that's only used to prove validity — never to reserialize).
    expect(() => JSON.parse(raw)).not.toThrow();
    const output = compressBlob(raw);
    expect(output).toContain('12345678901234567890');
  });

  it('preserves float literals verbatim (1.0 and 1e10 survive)', () => {
    const raw = `{\n  "a": 1.0,\n  "b": 1e10,\n  "pad": "${'x'.repeat(1100)}"\n}`;
    expect(raw.length).toBeGreaterThanOrEqual(1024);
    const output = compressBlob(raw);
    expect(output).toContain('1.0');
    expect(output).toContain('1e10');
  });

  it('preserves whitespace inside string values', () => {
    // The JSON text itself: an escaped \n followed by 4 literal spaces inside
    // the string value — both must survive the stripper untouched.
    const raw = `{\n  "code": "def f():\\n    return 1",\n  "pad": "${'x'.repeat(1100)}"\n}`;
    expect(raw).toContain('def f():\\n    return 1');
    const output = compressBlob(raw);
    expect(output).toContain('def f():\\n    return 1');
  });

  it('passes through a non-JSON multi-line log blob unchanged', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[INFO] step ${i} completed successfully`);
    const input = lines.join('\n');
    expect(input.length).toBeGreaterThanOrEqual(1024);
    expect(compressBlob(input)).toBe(input);
  });

  it('passes through malformed JSON unchanged', () => {
    const input = '{"a": ' + 'x'.repeat(1100);
    expect(compressBlob(input)).toBe(input);
  });

  it('passes through small JSON below the threshold unchanged', () => {
    const input = JSON.stringify({ a: 1 }, null, 2);
    expect(input.length).toBeLessThan(1024);
    expect(compressBlob(input)).toBe(input);
  });

  it('leaves already-compact JSON above the threshold unchanged (idempotent)', () => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < 60; i++) obj[`k${i}`] = 'v'.repeat(15);
    const input = JSON.stringify(obj);
    expect(input.length).toBeGreaterThanOrEqual(1024);
    expect(compressBlob(input)).toBe(input);
  });
});
