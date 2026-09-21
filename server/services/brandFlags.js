'use strict';
// ── WHAT A BUSINESS HAS DONE WITH ATHLETES, ACROSS EVERY AGENT ──────────────
//
// Two flags, earned only by something that really happened:
//
//   responded   a person at that business wrote back to a NILDash pitch.
//   nilActive   a deal with that business was logged on NILDash.
//
// Both are read from the ledgers that already record those events --
// brand_engagement (state 'responded' and 'closed') and deal_outcomes -- so
// there is no second store to keep in step. services/dealLog writes the
// 'closed' state; services/followUpAutomation.markReplied writes 'responded'.
//
// ── "REPLIED POSITIVELY" IS NOT SENTIMENT, AND THIS DOES NOT PRETEND ────────
// Nothing in this codebase reads the tone of a reply. What it can tell apart
// is a PERSON writing back from a bounce or an out-of-office
// (services/replyCapture.classifyInbound), and only a person's reply ever
// reaches markReplied. So `responded` means a human at that business answered
// a pitch. That is the honest claim, and it is the one the badge makes.
//
// ── MATCHING ACROSS AGENTS: PLACE ID, THEN DOMAIN, NEVER A NAME ────────────
// Two agents who both pitch "Rama Jama's" are talking about the same business
// only when the same Google Place ID or the same root domain says so. A name
// is not an identity: there are four Mellow Mushrooms in one state and a
// hundred "Main Street Barbers" in the country, and flagging one of them
// because another agent closed a different one would be a lie with a badge on
// it. A business whose key is name-derived carries NO flag, and that is the
// correct answer rather than a missing feature.
//
// ── PRIVACY IS THE WHOLE POINT ─────────────────────────────────────────────
// A flag is two booleans. This module never returns, and no caller can obtain
// from it, which agent worked the business, which athlete, what a deal was
// worth, who the contact was, or when. An agent learns only that the business
// has done this before -- which is a fact about the business, not about
// another agent's book.

// The key prefixes brandIdentity / ai.resolveBrandKey mint for a real
// identity. Everything else ('name:', 'localname:') is a display name in key
// clothing and is deliberately not matched on.
const CROSS_AGENT_PREFIXES = ['place:', 'dom:'];

function isCrossAgentKey(key) {
  const k = String(key || '').trim();
  return CROSS_AGENT_PREFIXES.some((p) => k.startsWith(p) && k.length > p.length);
}

function normDomain(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  const m = s.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (!m || m.indexOf('.') === -1) return null;
  const parts = m.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(-2).join('.');
}

// Every cross-agent identity a business descriptor can produce, strongest
// first: the Place ID, then the root domain. Empty when it has neither, and
// an empty list is what stops a name from ever being matched on.
function crossAgentKeys(b) {
  const o = b || {};
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  const place = o.place_id || o.placeId || null;
  if (place) push('place:' + String(place).trim());
  const bk = String(o.brand_key || o.brandKey || o.key || '').trim();
  if (bk.startsWith('place:')) push(bk);
  const dom = normDomain(o.website || o.url || o.domain || o.site || '');
  if (dom) push('dom:' + dom);
  if (bk.startsWith('dom:')) { const d = normDomain(bk.slice(4)); push('dom:' + (d || bk.slice(4))); }
  const ik = String(o.identity_key || o.identityKey || '').trim();
  if (isCrossAgentKey(ik)) push(ik.startsWith('dom:') ? 'dom:' + (normDomain(ik.slice(4)) || ik.slice(4)) : ik);
  return out;
}

// ── THE FLAGS THEMSELVES ────────────────────────────────────────────────────
// One query per level over the whole ledger, not one per business: a My
// Brands page is fifty rows and fifty round trips is a page that hangs.
// Returns a Map from cross-agent key to { responded, nilActive }.
async function loadFlagIndex(pool, keys) {
  const wanted = [...new Set((keys || []).filter(isCrossAgentKey))];
  const index = new Map();
  if (!wanted.length) return index;
  const set = (k, field) => {
    const cur = index.get(k) || { responded: false, nilActive: false };
    cur[field] = true;
    index.set(k, cur);
  };
  try {
    // A deal logged on NILDash. 'closed' is what services/dealLog writes to
    // the ledger, and deal_outcomes.brand_key is the deal's own record of the
    // same identity; either one earns the flag.
    const closed = await pool.query(
      `SELECT DISTINCT brand_key FROM brand_engagement
        WHERE state = 'closed' AND brand_key = ANY($1::text[])`, [wanted]);
    for (const r of closed.rows) set(r.brand_key, 'nilActive');
    const dealt = await pool.query(
      `SELECT DISTINCT brand_key FROM deal_outcomes
        WHERE brand_key = ANY($1::text[])`, [wanted]).catch(() => ({ rows: [] }));
    for (const r of dealt.rows) set(r.brand_key, 'nilActive');
    // A person at the business wrote back. 'closed' outranks 'responded' in
    // the ledger, so a business that replied and then signed carries both.
    const replied = await pool.query(
      `SELECT DISTINCT brand_key FROM brand_engagement
        WHERE state IN ('responded', 'closed') AND brand_key = ANY($1::text[])`, [wanted]);
    for (const r of replied.rows) set(r.brand_key, 'responded');
  } catch (e) {
    // A flag is decoration on a page that has to render. Never fail the page.
    console.error('[brandFlags] loadFlagIndex:', e.message);
    return new Map();
  }
  return index;
}

// The flags for one business, given a loaded index.
function flagsFrom(index, business) {
  const out = { responded: false, nilActive: false };
  for (const k of crossAgentKeys(business)) {
    const f = index.get(k);
    if (!f) continue;
    if (f.responded) out.responded = true;
    if (f.nilActive) out.nilActive = true;
  }
  return out;
}

// Flags for a list of businesses, in one pass. Returns an array parallel to
// the input -- never a joined object, so a caller cannot accidentally carry a
// key back to a page.
async function flagsFor(pool, businesses) {
  const list = Array.isArray(businesses) ? businesses : [];
  const keys = [];
  for (const b of list) keys.push(...crossAgentKeys(b));
  const index = await loadFlagIndex(pool, keys);
  return list.map((b) => flagsFrom(index, b));
}

// Attach `flags` to each row in place and return the rows. The convenience
// every caller wants, and the only shape the pages read.
async function attachFlags(pool, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const flags = await flagsFor(pool, list);
  list.forEach((r, i) => { if (r && typeof r === 'object') r.flags = flags[i]; });
  return list;
}

// ── THE BADGE ───────────────────────────────────────────────────────────────
// One badge, the stronger of the two, in words an agent can act on. Null when
// the business has earned neither, so a page renders nothing rather than an
// empty chip.
const BADGES = {
  nilActive: { key: 'nil-active', label: 'NIL-active', title: 'This business has signed at least one NIL deal through NILDash.' },
  responded: { key: 'responded', label: 'Responded to athletes', title: 'Someone at this business has replied to a NILDash pitch.' },
};
function badgeFor(flags) {
  const f = flags || {};
  if (f.nilActive) return BADGES.nilActive;
  if (f.responded) return BADGES.responded;
  return null;
}

// How much a flag is worth when the nightly fill is choosing between
// businesses that all fit the athlete's market. A business that has signed
// before is the best lead in the pile; one that has answered is next. The
// numbers are a nudge, not an override: fit still decides first.
const RANK_BONUS = { nilActive: 30, responded: 12 };
function rankBonus(flags) {
  const f = flags || {};
  if (f.nilActive) return RANK_BONUS.nilActive;
  if (f.responded) return RANK_BONUS.responded;
  return 0;
}

// Admin only: how many businesses sit at each level, across everyone.
async function counts(pool) {
  const out = { nilActive: 0, responded: 0, respondedOnly: 0, unflagged: null };
  try {
    const r = await pool.query(
      `SELECT
         COUNT(DISTINCT brand_key) FILTER (WHERE state = 'closed')::int AS nil_active,
         COUNT(DISTINCT brand_key) FILTER (WHERE state IN ('responded','closed'))::int AS responded
       FROM brand_engagement
      WHERE brand_key LIKE 'place:%' OR brand_key LIKE 'dom:%'`);
    out.nilActive = (r.rows[0] && r.rows[0].nil_active) || 0;
    out.responded = (r.rows[0] && r.rows[0].responded) || 0;
    out.respondedOnly = Math.max(0, out.responded - out.nilActive);
    const total = await pool.query(
      `SELECT COUNT(DISTINCT brand_key)::int AS n FROM brand_engagement
        WHERE brand_key LIKE 'place:%' OR brand_key LIKE 'dom:%'`);
    out.matchable = (total.rows[0] && total.rows[0].n) || 0;
    const unmatchable = await pool.query(
      `SELECT COUNT(DISTINCT brand_key)::int AS n FROM brand_engagement
        WHERE brand_key IS NOT NULL AND brand_key NOT LIKE 'place:%' AND brand_key NOT LIKE 'dom:%'`);
    // Businesses with no Place ID and no domain can never carry a flag. The
    // number is reported rather than hidden: it is the ceiling on coverage.
    out.noIdentity = (unmatchable.rows[0] && unmatchable.rows[0].n) || 0;
  } catch (e) {
    console.error('[brandFlags] counts:', e.message);
  }
  return out;
}

module.exports = {
  CROSS_AGENT_PREFIXES, BADGES, RANK_BONUS,
  isCrossAgentKey, normDomain, crossAgentKeys,
  loadFlagIndex, flagsFrom, flagsFor, attachFlags, badgeFor, rankBonus, counts,
};
