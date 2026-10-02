'use strict';
// ── WHAT THE PLATFORM KNOWS, WITHOUT SAYING WHO ─────────────────────────────
//
// Two ranking signals read across every agent. Neither one ever leaves this
// file as anything but a number added to or taken off a candidate's fit:
// no name, no agent, no date, no reason string. The agent sees a different
// business, never why.
//
// THE SILENT STAGGER. A business any OTHER agent contacted in the last
// STAGGER_DAYS (30) days ranks STAGGER_PENALTY lower for every other subject,
// so it tends not to surface twice in a month. It is not excluded: a business
// that is still the best fit can still come up. "Contacted" is a card that was
// sent, or approved to send, matched on the cross-agent identities a business
// carries (Google place, website domain; services/brandFlags) or on its name
// within the same market.
//
// LEARNING FROM OUTCOMES, aggregate and anonymous. Over LEARN_DAYS (120):
//   reply                          positive, for that kind of business
//   approved, no reply in 14 days  weak negative
//   skipped by an agent            negative for that exact business (one step
//                                  per distinct agent who skipped it)
// A category's rate is used only once at least LEARN_MIN_SENDS cards of that
// kind were sent, in this market when the market alone has that many, else
// platform wide: a small count could be read back as one agent's activity.
const STAGGER_DAYS = parseInt(process.env.ENGINE_STAGGER_DAYS, 10) || 30;
const STAGGER_PENALTY = parseInt(process.env.ENGINE_STAGGER_PENALTY, 10) || 12;
const LEARN_DAYS = 120;
const LEARN_MIN_SENDS = parseInt(process.env.ENGINE_LEARN_MIN_SENDS, 10) || 8;
const NO_REPLY_DAYS = 14;
const REPLY_MAX_BONUS = 8, NO_REPLY_MAX_PENALTY = 4;
const SKIP_PER_AGENT = 2, SKIP_MAX = 6;

const normName = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// candidates: [{ brand_name, place_id?, website?, brand_key?, identity_key? }]
// -> Set of indexes into candidates that another agent contacted recently.
async function staggered(pool, { agentId, marketKey, candidates }) {
  const out = new Set();
  if (!candidates || !candidates.length) return out;
  const BF = require('./brandFlags');
  const keyToIdx = new Map(), nameToIdx = new Map();
  candidates.forEach((c, i) => {
    for (const k of BF.crossAgentKeys(c)) { if (!keyToIdx.has(k)) keyToIdx.set(k, []); keyToIdx.get(k).push(i); }
    const n = normName(c.brand_name);
    if (n) { if (!nameToIdx.has(n)) nameToIdx.set(n, []); nameToIdx.get(n).push(i); }
  });
  const r = await pool.query(
    `SELECT brand_key, identity_key, lower(brand_name) AS name, market_key
       FROM outreach_queue
      WHERE agent_id <> $1
        AND (sent_at > NOW() - make_interval(days => $2)
             OR (sent_at IS NULL AND state = 'sent' AND updated_at > NOW() - make_interval(days => $2)))
        AND (brand_key = ANY($3) OR identity_key = ANY($3)
             OR (market_key = $4 AND lower(brand_name) = ANY($5)))`,
    [String(agentId || ''), STAGGER_DAYS, [...keyToIdx.keys()], marketKey || '', [...nameToIdx.keys()].concat(candidates.map((c) => String(c.brand_name || '').toLowerCase()))]);
  for (const row of r.rows) {
    for (const k of [row.brand_key, row.identity_key]) for (const i of (keyToIdx.get(k) || [])) out.add(i);
    if (row.market_key && marketKey && row.market_key === marketKey) for (const i of (nameToIdx.get(normName(row.name)) || [])) out.add(i);
  }
  return out;
}

// -> { byCategory: Map(category -> adjustment), byBusiness: Map(identity -> adjustment) }
async function outcomes(pool, { marketKey, candidates }) {
  const byCategory = new Map(), byBusiness = new Map();
  const rows = (await pool.query(
    `SELECT business_category AS cat, market_key AS mk,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS sends,
            COUNT(*) FILTER (WHERE replied_at IS NOT NULL)::int AS replies,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL AND replied_at IS NULL AND sent_at < NOW() - make_interval(days => $2))::int AS silent
       FROM outreach_queue
      WHERE business_category IS NOT NULL AND sent_at > NOW() - make_interval(days => $1)
      GROUP BY 1, 2`, [LEARN_DAYS, NO_REPLY_DAYS])).rows;
  const agg = new Map(), mkt = new Map();
  for (const r of rows) {
    const a = agg.get(r.cat) || { sends: 0, replies: 0, silent: 0 };
    a.sends += r.sends; a.replies += r.replies; a.silent += r.silent; agg.set(r.cat, a);
    if (marketKey && r.mk === marketKey) mkt.set(r.cat, r);
  }
  // The platform's reply rate is the yardstick: a kind of business that
  // answers more often than average ranks up, one that goes quiet ranks down.
  let tS = 0, tR = 0;
  for (const a of agg.values()) { tS += a.sends; tR += a.replies; }
  const base = tS ? tR / tS : 0;
  for (const [cat, a] of agg) {
    const use = mkt.get(cat) && mkt.get(cat).sends >= LEARN_MIN_SENDS ? mkt.get(cat) : a;
    if (use.sends < LEARN_MIN_SENDS) continue;
    const rate = use.replies / use.sends;
    const silentRate = use.silent / use.sends;
    const up = Math.max(0, Math.min(REPLY_MAX_BONUS, Math.round((rate - base) * 40)));
    const down = Math.min(NO_REPLY_MAX_PENALTY, Math.round(silentRate * NO_REPLY_MAX_PENALTY));
    const adj = (rate > base ? up : -Math.min(REPLY_MAX_BONUS, Math.round((base - rate) * 40))) - down;
    if (adj) byCategory.set(cat, Math.max(-(REPLY_MAX_BONUS + NO_REPLY_MAX_PENALTY), Math.min(REPLY_MAX_BONUS, adj)));
  }
  // Skips of this exact business, by how many different agents.
  const BF = require('./brandFlags');
  const keys = [];
  for (const c of candidates || []) keys.push(...BF.crossAgentKeys(c));
  if (keys.length) {
    const s = (await pool.query(
      `SELECT identity_key AS k, COUNT(DISTINCT agent_id)::int AS agents FROM outreach_queue
        WHERE state = 'skipped' AND updated_at > NOW() - make_interval(days => $1) AND identity_key = ANY($2)
        GROUP BY 1`, [LEARN_DAYS, keys]).catch(() => ({ rows: [] }))).rows;
    for (const r of s) byBusiness.set(r.k, -Math.min(SKIP_MAX, r.agents * SKIP_PER_AGENT));
  }
  return { byCategory, byBusiness, base };
}

// The adjustment for one candidate: stagger + category learning + business skips.
function adjustmentFor(c, i, { stagger, learned }) {
  let d = 0;
  if (stagger && stagger.has(i)) d -= STAGGER_PENALTY;
  if (learned) {
    if (c.businessCategory && learned.byCategory.has(c.businessCategory)) d += learned.byCategory.get(c.businessCategory);
    const BF = require('./brandFlags');
    let worst = 0;
    for (const k of BF.crossAgentKeys(c)) worst = Math.min(worst, learned.byBusiness.get(k) || 0);
    d += worst;
  }
  return d;
}

module.exports = { staggered, outcomes, adjustmentFor, normName, STAGGER_DAYS, STAGGER_PENALTY, LEARN_MIN_SENDS, NO_REPLY_DAYS };
