/**
 * Normalize and benchmark-correct `models.intelligence_rank` across all platforms.
 *
 * For each underlying model (collapsed by `normalizeModelId`) it computes one canonical
 * rank and writes it to every platform copy, so the same model can't be rank 3 on one
 * provider and 95 on another. Canonical rank precedence:
 *   1. BENCHMARK_RANKS[norm]            — curated, benchmark-grounded (lib/intelligence-ranks)
 *   2. median of existing ranks < 40    — preserves the project's prior curation, discards
 *                                          corrupted high-outlier seeds (the 85-95 batch)
 *   3. size-label tier default          — only if a family has NO sane existing value
 *
 * Usage:
 *   npx tsx src/scripts/seed-intelligence-ranks.ts            # apply
 *   npx tsx src/scripts/seed-intelligence-ranks.ts --dry-run  # preview only
 */
import { initDb, getDb } from '../db/index.js';
import { normalizeModelId, BENCHMARK_RANKS } from '../lib/intelligence-ranks.js';

const DRY = process.argv.includes('--dry-run');
const OUTLIER = 40; // ranks >= this are treated as corrupted seeds, excluded from the median
const SIZE_DEFAULT: Record<string, number> = { Frontier: 6, Large: 14, Medium: 18, Small: 28, Custom: 50 };

interface Row { id: number; platform: string; model_id: string; intelligence_rank: number; size_label: string }

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

initDb();
const db = getDb();
const rows = db.prepare('SELECT id, platform, model_id, intelligence_rank, size_label FROM models').all() as Row[];

// Group rows by canonical family.
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = normalizeModelId(r.model_id);
  (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
}

// Resolve one canonical rank per family.
const canonical = new Map<string, { rank: number; source: string }>();
for (const [k, rs] of groups) {
  let rank: number, source: string;
  if (Object.prototype.hasOwnProperty.call(BENCHMARK_RANKS, k)) {
    rank = BENCHMARK_RANKS[k]; source = 'benchmark';
  } else {
    const sane = rs.map((r) => r.intelligence_rank).filter((v) => v > 0 && v < OUTLIER);
    if (sane.length) { rank = median(sane); source = 'median'; }
    else { rank = SIZE_DEFAULT[rs[0].size_label] ?? 50; source = 'size-default'; }
  }
  canonical.set(k, { rank: Math.max(1, Math.min(100, rank)), source });
}

// Apply.
const upd = db.prepare('UPDATE models SET intelligence_rank = ? WHERE id = ?');
const changes: { model: string; from: number; to: number; src: string }[] = [];
const tx = db.transaction(() => {
  for (const [k, rs] of groups) {
    const { rank, source } = canonical.get(k)!;
    for (const r of rs) {
      if (r.intelligence_rank !== rank) {
        changes.push({ model: `${r.platform}/${r.model_id}`, from: r.intelligence_rank, to: rank, src: source });
        if (!DRY) upd.run(rank, r.id);
      }
    }
  }
});
tx();

changes.sort((a, b) => a.to - b.to || a.model.localeCompare(b.model));
console.log(`${DRY ? '[dry-run] ' : ''}${changes.length} row(s) ${DRY ? 'would change' : 'changed'} across ${groups.size} families (${rows.length} models total)\n`);
for (const c of changes) {
  console.log(`  ${c.from.toString().padStart(3)} -> ${c.to.toString().padStart(2)}  [${c.src.padEnd(12)}] ${c.model}`);
}
if (!DRY && changes.length) console.log('\nDone. Restart the gateway so the router rebuilds its fallback chain.');
