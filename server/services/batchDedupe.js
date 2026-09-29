'use strict';
// ── ONE ROW PER KEY BEFORE A BATCHED UPSERT ─────────────────────────────────
//
// Postgres refuses an INSERT ... ON CONFLICT DO UPDATE that touches the same
// row twice in one statement ("ON CONFLICT DO UPDATE command cannot affect row
// a second time"). A batch built from Places can carry two places with the
// same display name -- two branches of one business -- and the pools are keyed
// (market_key, brand) on that name, so the Cypress campus rebuild found 836
// businesses and then wrote none of them.
//
// Every batched upsert into market_business_seen, market_business_rejected and
// university_market_seen goes through this first. It keeps the BETTER row, by
// the caller's rule, not whichever came first, and returns each collision so
// the caller can say which businesses shared a key.

// rows: any array. keyOf(row) -> the conflict key (null skips the row).
// better(a, b) -> true when a should be kept over b.
// Returns { rows, collisions: [{ key, kept, dropped }] }.
function dedupeBy(rows, keyOf, better) {
  const byKey = new Map();
  const collisions = [];
  for (const r of rows || []) {
    const k = keyOf(r);
    if (k == null || k === '') continue;
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, r); continue; }
    const keepNew = better ? !!better(r, prev) : false;
    collisions.push({ key: k, kept: keepNew ? r : prev, dropped: keepNew ? prev : r });
    if (keepNew) byKey.set(k, r);
  }
  return { rows: [...byKey.values()], collisions };
}

// The market pool rows the scan knows about: evidence found beats unknown or
// none, words beat a bare flag, a known category beats none.
function betterPoolMeta(a, b) {
  const score = (m) => (m && m.hasEvidence === true ? 4 : 0) + (m && m.evidence ? 2 : 0) + (m && m.category ? 1 : 0);
  return score(a) > score(b);
}

// Places candidates for the university pool: the better fit, then the more
// established (more reviews), then the one nearer the campus.
function betterPlace(a, b) {
  const fa = Number(a.fit) || 0, fb = Number(b.fit) || 0;
  if (fa !== fb) return fa > fb;
  const ra = Number(a.user_ratings_total) || 0, rb = Number(b.user_ratings_total) || 0;
  if (ra !== rb) return ra > rb;
  const da = Number.isFinite(Number(a.distance_m)) ? Number(a.distance_m) : Infinity;
  const db = Number.isFinite(Number(b.distance_m)) ? Number(b.distance_m) : Infinity;
  return da < db;
}

// One readable line per collision, naming both rows.
function describe(c, fmt) {
  const f = fmt || ((r) => JSON.stringify(r).slice(0, 120));
  return `"${c.key}": kept ${f(c.kept)}; dropped ${f(c.dropped)}`;
}

module.exports = { dedupeBy, betterPoolMeta, betterPlace, describe };
