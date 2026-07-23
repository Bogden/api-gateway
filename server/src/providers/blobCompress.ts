// ────────────────────────────────────────────────────────────────────────────
// Conservative, tool-call-SAFE blob compressor for ChatGPT/Codex tool-result
// output (card c2081). Shrinks large JSON tool-result blobs before they're
// re-sent to the Responses backend every round trip, so they count less
// against the ChatGPT subscription usage window.
//
// Scope: this module ONLY strips insignificant JSON whitespace from the
// ORIGINAL string. It deliberately does NOT do `JSON.stringify(JSON.parse(s))`
// — that silently rounds integers beyond 2^53 and normalizes floats
// (1.0→1, 1e10→10000000000), which would corrupt large IDs embedded in tool
// results. Operating on the original text byte-for-byte (outside string
// literals) is what makes this provably lossless.
// ────────────────────────────────────────────────────────────────────────────

// A conservative tunable floor — below it, structural whitespace savings are
// negligible and not worth the work.
const MIN_BLOB_CHARS = 1024;

function stripJsonWhitespace(s: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === '\\' && i + 1 < s.length) {
        out += c + s[i + 1];
        i++;
        continue;
      }
      out += c;
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    out += c;
  }
  return out;
}

export function compressBlob(s: string): string {
  try {
    if (s.length < MIN_BLOB_CHARS) return s;

    // Validity gate: prove s is well-formed JSON before running the stripper.
    // The parsed value is discarded — it's used only to gate safety, never to
    // reserialize (see module comment for why reserializing is unsafe).
    try {
      JSON.parse(s);
    } catch {
      return s;
    }

    const stripped = stripJsonWhitespace(s);
    return stripped.length < s.length ? stripped : s;
  } catch {
    return s;
  }
}
