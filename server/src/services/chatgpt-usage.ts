// ChatGPT subscription plan-usage snapshot tracker.
//
// The ChatGPT-plan Responses backend reports the plan's remaining budget on
// EVERY response as a set of `x-codex-*` response HEADERS (confirmed empirically
// on a live request, card c2054 — the SSE stream carries no usage data; the
// Codex CLI's session-log `rate_limits` objects are reconstructed from these
// same headers). Example headers on a 200:
//
//   x-codex-active-limit: premium
//   x-codex-primary-used-percent: 0
//   x-codex-primary-window-minutes: 10080
//   x-codex-primary-reset-at: 1785375709
//   x-codex-secondary-used-percent: 0
//   x-codex-secondary-window-minutes: 0
//   x-codex-secondary-reset-at:            (empty when there is no 2nd window)
//
// The `chatgpt` provider feeds these headers here on every successful upstream
// response (streaming and non-streaming). We keep the latest snapshot per
// limit-id so the gateway — blind until now, learning of exhaustion only by
// eating a 429 (see chatgpt-cooldown.ts) — can expose numeric remaining budget.
//
// In-memory only, same restart-amnesia stance as the cooldown ledger: state
// resets on restart and is re-learned on the next request; a stale entry never
// outlives the process. Parsing is best-effort — missing or malformed metadata
// must NEVER fail a request, so callers wrap this in try/catch and every parse
// helper tolerates absence by returning null.

/** One reported usage window (primary or secondary). `resetsAt` is the upstream
 *  epoch-SECONDS value (`x-codex-*-reset-at`), preserved verbatim. */
export interface UsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
}

interface StoredSnapshot {
  limitId: string;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  receivedAtMs: number;
}

// Key: the reported limit id (`x-codex-active-limit`, e.g. "premium"). One plan,
// but the backend can report distinct limit tiers, so track the latest per id.
const snapshots = new Map<string, StoredSnapshot>();

const DEFAULT_LIMIT_ID = 'codex';

/** Minimal Headers-like shape so this is testable without a real Response. */
type HeaderReader = { get(name: string): string | null };

function num(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** Build a window from its three header values. Returns null when there is no
 *  usable window (no reset-at → e.g. an absent secondary window). */
function buildWindow(
  usedPercent: string | null,
  windowMinutes: string | null,
  resetsAt: string | null,
): UsageWindow | null {
  const reset = num(resetsAt);
  // A window is only meaningful when the backend gives a reset epoch. An empty
  // `x-codex-secondary-reset-at` (its usual value) collapses to null here.
  if (reset == null || reset <= 0) return null;
  return {
    usedPercent: num(usedPercent) ?? 0,
    windowMinutes: num(windowMinutes) ?? 0,
    resetsAt: reset,
  };
}

/** Parse the plan-usage snapshot out of a response's headers, or null when the
 *  headers carry none (older/changed upstream). Never throws. */
export function parseUsageHeaders(
  headers: HeaderReader,
): { limitId: string; primary: UsageWindow | null; secondary: UsageWindow | null } | null {
  try {
    const primary = buildWindow(
      headers.get('x-codex-primary-used-percent'),
      headers.get('x-codex-primary-window-minutes'),
      headers.get('x-codex-primary-reset-at'),
    );
    const secondary = buildWindow(
      headers.get('x-codex-secondary-used-percent'),
      headers.get('x-codex-secondary-window-minutes'),
      headers.get('x-codex-secondary-reset-at'),
    );
    // Nothing usable at all → treat as "no metadata present", skip silently.
    if (!primary && !secondary) return null;
    const limitId = (headers.get('x-codex-active-limit') || '').trim() || DEFAULT_LIMIT_ID;
    return { limitId, primary, secondary };
  } catch {
    return null;
  }
}

/** Parse and store the latest snapshot from a response's headers. Best-effort:
 *  any failure or missing metadata is swallowed so a request never fails over
 *  usage bookkeeping. */
export function recordChatgptUsageFromHeaders(headers: HeaderReader): void {
  try {
    const parsed = parseUsageHeaders(headers);
    if (!parsed) return;
    snapshots.set(parsed.limitId, {
      limitId: parsed.limitId,
      primary: parsed.primary,
      secondary: parsed.secondary,
      receivedAtMs: Date.now(),
    });
  } catch {
    /* never fail a request over usage capture */
  }
}

/** A cooldown-duration hint derived from the freshest stored snapshot's primary
 *  reset time, used when a 429 arrives without Retry-After. Returns the cooldown
 *  duration in ms, or null when there is no fresh snapshot with a future reset.
 *
 * @param maxAgeMs - ignore snapshots older than this (staleness guard).
 */
export function getChatgptCooldownHintMs(maxAgeMs: number): number | null {
  const now = Date.now();
  let freshest: StoredSnapshot | null = null;
  for (const snap of snapshots.values()) {
    if (!snap.primary) continue;
    if (now - snap.receivedAtMs >= maxAgeMs) continue;
    if (!freshest || snap.receivedAtMs > freshest.receivedAtMs) freshest = snap;
  }
  if (!freshest || !freshest.primary) return null;
  const resetMs = freshest.primary.resetsAt * 1000;
  if (resetMs <= now) return null;
  return resetMs - now;
}

/** All stored usage snapshots, for the status surface. Shape is the documented
 *  contract consumed by the chain-console (epic c2053 child B). */
export interface ChatgptUsageStatus {
  limitId: string;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  /** ISO-8601 timestamp the snapshot was received, for staleness judgement. */
  receivedAt: string;
}

export function getChatgptUsageSnapshots(): ChatgptUsageStatus[] {
  const out: ChatgptUsageStatus[] = [];
  for (const snap of snapshots.values()) {
    out.push({
      limitId: snap.limitId,
      primary: snap.primary,
      secondary: snap.secondary,
      receivedAt: new Date(snap.receivedAtMs).toISOString(),
    });
  }
  return out;
}

/** Test/reset hook. */
export function _resetChatgptUsage(): void {
  snapshots.clear();
}
