// ChatGPT subscription cooldown tracker.
//
// A ChatGPT plan enforces a rolling usage window (e.g. the 5-hour window) that
// is bound to the subscription, not to an API key. When the Codex backend
// returns 429 / window-exhaustion there is nothing to fail over to — the whole
// plan is throttled — so the gateway must NOT retry other providers and must
// NOT hammer the plan through the normal 1-RPM recovery loop (which would keep
// probing a window that only resets in hours).
//
// Instead the `chatgpt` provider records a cooldown here on a 429, short-circuits
// ordinary requests with a distinctive error, and admits one exponentially
// backed-off probe so an early reset can recover without a process restart.
// This state is surfaced on the gateway's health/status endpoint (GET
// /api/health → `chatgptCooldowns`) so operators and sibling tooling can read it.
//
// In-memory only: like the rate-limit cooldown-escalation ledger it resets on
// restart, which is fine — a genuinely-exhausted window will re-arm on the next
// 429. Entries are account-scoped so a new Codex login never inherits the prior
// account's plan state.

import { getStoredCodexAccountId } from '../lib/codex-auth.js';

// A reset hint can be days away but the subscription can recover earlier (for
// example after an operator-side plan reset). Revalidate conservatively: first
// after five minutes, then exponentially less often, capped at once per hour.
const INITIAL_RECHECK_MS = 5 * 60 * 1000;
const MAX_RECHECK_MS = 60 * 60 * 1000;

interface CooldownEntry {
  /** Epoch ms after which the cooldown lapses. */
  expiresAtMs: number;
  /** Human-readable reason (surfaced on the status endpoint). */
  reason: string;
  /** When the cooldown was armed. */
  setAtMs: number;
  /** Account whose subscription produced this cooldown. */
  accountId: string | null;
  /** Earliest time one caller may revalidate the subscription upstream. */
  nextProbeAtMs: number;
  /** Delay to use after the next admitted probe. */
  nextProbeDelayMs: number;
}

// Key: model id (e.g. "gpt-5-codex"). One plan, but different model ids can be
// throttled independently by the backend, so track per model.
const cooldowns = new Map<string, CooldownEntry>();

function storedAccountOrNull(): string | null {
  return getStoredCodexAccountId() ?? null;
}

/** Arm (or extend) a cooldown for a ChatGPT model. */
export function setChatgptCooldown(
  modelId: string,
  durationMs: number,
  reason: string,
  accountId: string | null = storedAccountOrNull(),
): void {
  const now = Date.now();
  const expiresAtMs = now + Math.max(0, durationMs);
  const existing = cooldowns.get(modelId);
  // Never shorten an active same-account cooldown. Preserve its revalidation
  // schedule too: a probe that gets another 429 must continue backing off
  // rather than resetting to the five-minute first-probe cadence.
  if (existing && existing.accountId === accountId && now < existing.expiresAtMs) {
    existing.expiresAtMs = Math.max(existing.expiresAtMs, expiresAtMs);
    existing.reason = reason;
    return;
  }
  cooldowns.set(modelId, {
    expiresAtMs,
    reason,
    setAtMs: now,
    accountId,
    nextProbeAtMs: Math.min(expiresAtMs, now + INITIAL_RECHECK_MS),
    nextProbeDelayMs: INITIAL_RECHECK_MS,
  });
}

/** The active cooldown for a model, or null if none / lapsed. Prunes lapsed
 *  entries lazily on read. */
export function getChatgptCooldown(
  modelId: string,
  accountId: string | null | undefined = getStoredCodexAccountId(),
): { expiresAtMs: number; reason: string; remainingMs: number } | null {
  const entry = cooldowns.get(modelId);
  if (!entry) return null;
  const now = Date.now();
  if ((accountId !== undefined && entry.accountId !== accountId) || now >= entry.expiresAtMs) {
    cooldowns.delete(modelId);
    return null;
  }
  return { expiresAtMs: entry.expiresAtMs, reason: entry.reason, remainingMs: entry.expiresAtMs - now };
}

/** Atomically admit at most one upstream revalidation probe when its backoff
 * has elapsed. Advancing the next-probe timestamp before the caller awaits the
 * network prevents a busy fleet from stampeding the exhausted subscription. */
export function claimChatgptCooldownProbe(
  modelId: string,
  accountId: string | null | undefined = getStoredCodexAccountId(),
): boolean {
  const entry = cooldowns.get(modelId);
  if (!entry) return false;
  const now = Date.now();
  if ((accountId !== undefined && entry.accountId !== accountId) || now >= entry.expiresAtMs) {
    cooldowns.delete(modelId);
    return false;
  }
  if (now < entry.nextProbeAtMs) return false;

  entry.nextProbeDelayMs = Math.min(entry.nextProbeDelayMs * 2, MAX_RECHECK_MS);
  entry.nextProbeAtMs = Math.min(entry.expiresAtMs, now + entry.nextProbeDelayMs);
  return true;
}

/** True when the model is currently cooling down. */
export function isChatgptCoolingDown(
  modelId: string,
  accountId: string | null | undefined = getStoredCodexAccountId(),
): boolean {
  return getChatgptCooldown(modelId, accountId) !== null;
}

/** Clear a model's cooldown (used on a subsequent success). */
export function clearChatgptCooldown(
  modelId: string,
  accountId: string | null | undefined = getStoredCodexAccountId(),
): void {
  const entry = cooldowns.get(modelId);
  if (entry && accountId !== undefined && entry.accountId !== accountId) return;
  cooldowns.delete(modelId);
}

/** All active cooldowns, for the status/analytics surface. Shape is the
 *  documented contract consumed by external tooling (card c1843). */
export interface ChatgptCooldownStatus {
  modelId: string;
  reason: string;
  setAt: string;
  expiresAt: string;
  remainingMs: number;
}

export function getActiveChatgptCooldowns(): ChatgptCooldownStatus[] {
  const now = Date.now();
  const accountId = getStoredCodexAccountId();
  const out: ChatgptCooldownStatus[] = [];
  for (const [modelId, entry] of cooldowns) {
    if ((accountId !== undefined && entry.accountId !== accountId) || now >= entry.expiresAtMs) {
      cooldowns.delete(modelId);
      continue;
    }
    out.push({
      modelId,
      reason: entry.reason,
      setAt: new Date(entry.setAtMs).toISOString(),
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
      remainingMs: entry.expiresAtMs - now,
    });
  }
  return out;
}

/** Test/reset hook. */
export function _resetChatgptCooldowns(): void {
  cooldowns.clear();
}
