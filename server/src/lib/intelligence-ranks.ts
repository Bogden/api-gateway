/**
 * Benchmark-derived intelligence ranks for models.
 *
 * `intelligence_rank` in the `models` table is an ORDINAL RANK (1 = smartest), NOT a
 * 0-100 score: the router builds its fallback chain with `ORDER BY intelligence_rank ASC`
 * (see db/migrations.ts, services/router.ts), so a LOWER number means the model is tried
 * EARLIER. The values below are grounded in public benchmark standings as of early 2026
 * (Artificial Analysis Intelligence Index, LMArena Elo, MMLU-Pro / GPQA) — the smartest
 * frontier models sit near 1, fast small models near 30.
 *
 * Two uses:
 *   1. `scripts/seed-intelligence-ranks.ts` applies these (plus median-consistency for any
 *      family not listed here) to the existing `models` rows, so the same underlying model
 *      gets the same rank on every platform and corrupted seeds are corrected.
 *   2. Custom-provider auto-discovery (routes/custom.ts) calls `benchmarkRankFor()` so a
 *      newly discovered model that matches a known family gets a real rank instead of the
 *      middle-of-the-pack default.
 *
 * `normalizeModelId` collapses provider/org prefixes and free/quant suffixes so that, e.g.,
 * `accounts/fireworks/models/deepseek-v4-pro`, `deepseek-ai/deepseek-v4-pro`, and
 * `deepseek/deepseek-v4-pro` all key to `deepseek-v4-pro`.
 */

/** Collapse a provider-qualified model id to a canonical family key (lowercase). */
export function normalizeModelId(modelId: string): string {
  let s = (modelId || '').toLowerCase().trim();
  // Cloudflare Workers-AI prefix and Fireworks' deep path.
  s = s.replace(/^@cf\//, '');
  s = s.replace(/^accounts\/fireworks\/models\//, '');
  // Drop any remaining org/vendor prefix (everything up to and including the last '/').
  const slash = s.lastIndexOf('/');
  if (slash !== -1) s = s.slice(slash + 1);
  // Normalize the ':' separator (e.g. `gpt-oss:120b` == `gpt-oss-120b`) BEFORE stripping
  // the ':free' tier marker (already handled below as a whole-suffix strip).
  s = s.replace(/:free$/, '').replace(/-free$/, '');
  s = s.replace(/-fp8-fast$/, '').replace(/[:-]fp8$/, '');
  s = s.replace(/:/g, '-');
  return s;
}

/**
 * Benchmark-grounded canonical ranks (1 = smartest) keyed by `normalizeModelId`.
 * Not exhaustive — families absent here fall back to median-of-existing in the seed
 * script (which preserves the project's prior curation) and to `null` (→ caller default)
 * in `benchmarkRankFor`. Curated for the families currently present plus near neighbours.
 */
export const BENCHMARK_RANKS: Record<string, number> = {
  // ── Frontier (1-6) ────────────────────────────────────────────────────────
  'gemini-3.1-pro-preview': 1,
  'gemini-3.5-flash': 3,
  'minimax-m3': 2,
  'minimaxai-minimax-m3': 2,
  'qwen3-coder-480b-a35b-instruct': 2,
  'qwen3-coder': 2,
  'qwen3-coder-480b': 2,
  'qwen3-coder-next': 3,
  'qwen-3-235b-a22b-instruct-2507': 3,
  'qwen3-next-80b-a3b-instruct': 3,
  'deepseek-v4-pro': 3,
  'mistral-large-3-675b': 3,
  'mistral-large-3-675b-instruct-2512': 3,
  'minimax-m2.7': 3,
  'kimi-k2.6': 3,
  'deepseek-v4-flash': 4,
  'minimax-m3-frontier': 4,
  'kimi-k2-thinking': 5,
  'qwen3.6-max-preview': 5,
  'owl-alpha': 5,
  'deepseek-v3.2': 6,
  'glm-5.1': 6,
  'glm-4.7': 6,
  'gpt-oss-120b': 6,
  'compound': 6,
  // ── Strong (7-13) ─────────────────────────────────────────────────────────
  'zai-glm-4.7': 7,
  'qwen3-30b-a3b-fp8': 7,
  'nemotron-3-ultra': 7,
  'nemotron-3-ultra-550b-a55b': 7,
  'devstral-2-123b': 8,
  'kimi-k2.5': 8,
  'glm-5': 10,
  'glm-4.5-air': 8,
  'deepseek-r1-distill-qwen-32b': 9,
  'nemotron-3-120b-a12b': 9,
  'qwen3.6-plus': 10,
  'big-pickle': 10,
  'llama-4-maverick-17b-128e-instruct': 11,
  'gemini-3-flash-preview': 11,
  'nemotron-3-super': 12,
  'nemotron-3-super-120b-a12b': 12,
  'llama-4-scout-17b-16e-instruct': 12,
  'gpt-4.1': 12,
  'magistral-medium-latest': 13,
  'command-a-reasoning-08-2025': 13,
  // ── Mid (14-22) ───────────────────────────────────────────────────────────
  'gemini-2.5-pro': 14,
  'mistral-large-latest': 14,
  'mistral-medium-latest': 14,
  'minimax-m2.5': 14,
  'mimo-v2.5': 14,
  'glm-4.7-flash': 14,
  'codestral-latest': 16,
  'devstral-latest': 16,
  'gpt-4o': 16,
  'llama-3.3-70b-versatile': 17,
  'llama-3.3-70b-instruct': 17,
  'llama-3.1-70b-instruct': 17,
  'gpt-oss-20b': 18,
  'compound-mini': 18,
  'glm-4.6v-flash': 18,
  'qwen3-32b': 19,
  'gemma-4-31b-it': 19,
  'gemini-2.5-flash': 20,
  'gemma-4-26b-a4b-it': 20,
  'glm-4.5-flash': 24,
  // ── Small / fast (25-30) ──────────────────────────────────────────────────
  'command-r-plus-08-2024': 27,
  'gpt-oss-safeguard-20b': 18,
  'gemini-2.5-flash-lite': 26,
  'nemotron-nano-9b-v2': 28,
  'llama-3.1-8b-instant': 28,
  'llama3.1-8b': 28,
  'ministral-8b-latest': 28,
  'granite-4.0-h-micro': 29,
  'llama-3.2-3b-instruct': 30,
};

/**
 * Benchmark rank for a model id, or null when the family is unknown (the caller decides a
 * default — auto-discovery uses the middle-of-pack value so the unknown model sorts neither
 * first nor last).
 */
export function benchmarkRankFor(modelId: string): number | null {
  const norm = normalizeModelId(modelId);
  return Object.prototype.hasOwnProperty.call(BENCHMARK_RANKS, norm) ? BENCHMARK_RANKS[norm] : null;
}
