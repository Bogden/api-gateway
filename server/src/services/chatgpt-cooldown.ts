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
// subsequent requests with a distinctive error until it lapses, and this state
// is surfaced on the gateway's health/status endpoint (GET /api/health →
// `chatgptCooldowns`) so operators and sibling tooling can read it.
//
// In-memory only: like the rate-limit cooldown-escalation ledger it resets on
// restart, which is fine — a genuinely-exhausted window will re-arm on the next
// 429, and a stale in-memory entry never outlives the process.

interface CooldownEntry {
  /** Epoch ms after which the cooldown lapses. */
  expiresAtMs: number;
  /** Human-readable reason (surfaced on the status endpoint). */
  reason: string;
  /** When the cooldown was armed. */
  setAtMs: number;
}

// Key: model id (e.g. "gpt-5-codex"). One plan, but different model ids can be
// throttled independently by the backend, so track per model.
const cooldowns = new Map<string, CooldownEntry>();

/** Arm (or extend) a cooldown for a ChatGPT model. */
export function setChatgptCooldown(modelId: string, durationMs: number, reason: string): void {
  const now = Date.now();
  const expiresAtMs = now + Math.max(0, durationMs);
  const existing = cooldowns.get(modelId);
  // Never shorten an active cooldown — honor the longest known backoff.
  if (existing && existing.expiresAtMs > expiresAtMs) {
    existing.reason = reason;
    return;
  }
  cooldowns.set(modelId, { expiresAtMs, reason, setAtMs: now });
}

/** The active cooldown for a model, or null if none / lapsed. Prunes lapsed
 *  entries lazily on read. */
export function getChatgptCooldown(
  modelId: string,
): { expiresAtMs: number; reason: string; remainingMs: number } | null {
  const entry = cooldowns.get(modelId);
  if (!entry) return null;
  const now = Date.now();
  if (now >= entry.expiresAtMs) {
    cooldowns.delete(modelId);
    return null;
  }
  return { expiresAtMs: entry.expiresAtMs, reason: entry.reason, remainingMs: entry.expiresAtMs - now };
}

/** True when the model is currently cooling down. */
export function isChatgptCoolingDown(modelId: string): boolean {
  return getChatgptCooldown(modelId) !== null;
}

/** Clear a model's cooldown (used on a subsequent success). */
export function clearChatgptCooldown(modelId: string): void {
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
  const out: ChatgptCooldownStatus[] = [];
  for (const [modelId, entry] of cooldowns) {
    if (now >= entry.expiresAtMs) {
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
