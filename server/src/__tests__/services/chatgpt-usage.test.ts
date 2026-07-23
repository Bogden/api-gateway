import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseUsageHeaders,
  recordChatgptUsageFromHeaders,
  getChatgptUsageSnapshots,
  getChatgptCooldownHintMs,
  _resetChatgptUsage,
} from '../../services/chatgpt-usage.js';

// Headers exactly as observed on a live ChatGPT-plan Responses 200 (card c2054).
function fullHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    'x-codex-active-limit': 'premium',
    'x-codex-plan-type': 'plus',
    'x-codex-primary-used-percent': '12.5',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1785375709',
    'x-codex-secondary-used-percent': '0',
    'x-codex-secondary-window-minutes': '0',
    'x-codex-secondary-reset-at': '',
    ...overrides,
  });
}

describe('chatgpt-usage', () => {
  beforeEach(() => _resetChatgptUsage());

  it('parses the primary window and nulls an absent secondary', () => {
    const parsed = parseUsageHeaders(fullHeaders());
    expect(parsed).not.toBeNull();
    expect(parsed!.limitId).toBe('premium');
    expect(parsed!.primary).toEqual({ usedPercent: 12.5, windowMinutes: 10080, resetsAt: 1785375709 });
    // secondary has an empty reset-at → collapses to null
    expect(parsed!.secondary).toBeNull();
  });

  it('returns null when no usage headers are present (older/changed upstream)', () => {
    expect(parseUsageHeaders(new Headers())).toBeNull();
    expect(parseUsageHeaders(new Headers({ 'content-type': 'application/json' }))).toBeNull();
  });

  it('parses a secondary window when the backend reports one', () => {
    const parsed = parseUsageHeaders(
      fullHeaders({
        'x-codex-secondary-used-percent': '30',
        'x-codex-secondary-window-minutes': '300',
        'x-codex-secondary-reset-at': '1785379999',
      }),
    );
    expect(parsed!.secondary).toEqual({ usedPercent: 30, windowMinutes: 300, resetsAt: 1785379999 });
  });

  it('records and exposes the latest snapshot per limit id with an ISO receivedAt', () => {
    recordChatgptUsageFromHeaders(fullHeaders({ 'x-codex-primary-used-percent': '10' }));
    recordChatgptUsageFromHeaders(fullHeaders({ 'x-codex-primary-used-percent': '20' }));
    const snaps = getChatgptUsageSnapshots();
    expect(snaps).toHaveLength(1); // same limit id → latest overwrites
    expect(snaps[0]!.limitId).toBe('premium');
    expect(snaps[0]!.primary!.usedPercent).toBe(20);
    expect(snaps[0]!.secondary).toBeNull();
    expect(() => new Date(snaps[0]!.receivedAt).toISOString()).not.toThrow();
    expect(snaps[0]!.receivedAt).toBe(new Date(snaps[0]!.receivedAt).toISOString());
  });

  it('recording tolerates missing metadata without storing anything', () => {
    recordChatgptUsageFromHeaders(new Headers());
    expect(getChatgptUsageSnapshots()).toHaveLength(0);
  });

  it('derives a cooldown hint from a fresh snapshot with a future reset', () => {
    const futureSec = Math.floor(Date.now() / 1000) + 600; // resets in 10 min
    recordChatgptUsageFromHeaders(fullHeaders({ 'x-codex-primary-reset-at': String(futureSec) }));
    const hint = getChatgptCooldownHintMs(30 * 60 * 1000);
    expect(hint).not.toBeNull();
    // ~10 minutes, allowing for clock/scheduling slack
    expect(hint!).toBeGreaterThan(9 * 60 * 1000);
    expect(hint!).toBeLessThanOrEqual(10 * 60 * 1000 + 1000);
  });

  it('gives no cooldown hint when the reset is in the past', () => {
    const pastSec = Math.floor(Date.now() / 1000) - 60;
    recordChatgptUsageFromHeaders(fullHeaders({ 'x-codex-primary-reset-at': String(pastSec) }));
    expect(getChatgptCooldownHintMs(30 * 60 * 1000)).toBeNull();
  });

  it('gives no cooldown hint when the only snapshot is older than the max age', () => {
    const futureSec = Math.floor(Date.now() / 1000) + 600;
    recordChatgptUsageFromHeaders(fullHeaders({ 'x-codex-primary-reset-at': String(futureSec) }));
    // A 0ms max-age rejects any snapshot (all are older than "now").
    expect(getChatgptCooldownHintMs(0)).toBeNull();
  });
});
