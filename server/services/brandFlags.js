'use strict';
// ── NIL-ACTIVE: THIS BUSINESS HAS DONE AN NIL DEAL ON NILDASH ───────────────
//
// One flag, and it is earned one way: an agent logged a signed deal with that
// business on NILDash (services/dealLog writes the deal_outcomes row). That is
// the whole definition. A business with no logged deal carries nothing.
//
// ── WHAT THIS DELIBERATELY DOES NOT READ ───────────────────────────────────
//
// AN EMAIL REPLY IS NOT A FLAG, AND INBOX DATA NEVER LEAVES THE AGENT IT CAME
// FROM. An earlier version of this file also flagged a business that had
// replied to a pitch, read out of brand_engagement's 'responded' state -- and
// that state is written by services/followUpAutomation.markReplied, which is
// fed by reply capture over an agent's connected Gmail or Outlook mailbox.
// Showing a second agent a badge derived from the first agent's inbox is a
// disclosure of the first agent's mail, however small the badge. So:
//
//   - this module reads deal_outcomes and nothing else;
//   - it never reads outreach_logs, emails, replied_at, last_inbound_kind,
//     brand_engagement, or any other record of what arrived in a mailbox;
//   - the only thing that can create a flag is a person deciding to log a
//     deal, which is an act of their own, not a message somebody sent them.
//
// A test in tests/deals.js proves a reply creates no flag, and another proves
// this file names none of those tables.
//
// ── MATCHING ACROSS AGENTS: PLACE ID, THEN DOMAIN, NEVER A NAME ────────────
// Two agents who both pitch "Rama Jama's" are talking about the same business
// only when the same Google Place ID or the same root domain says so. A name
// is not an identity: there are four Mellow Mushrooms in one state and a
// hundred "Main Street Barbers" in the country, and flagging one because
// another agent closed a different one would be a lie with a badge on it. A
// business whose key is name-derived carries NO flag, and that is the correct
// answer rather than a missing feature.
//
// ── PRIVACY IS THE WHOLE POINT ─────────────────────────────────────────────
// A flag is one boolean. This module never returns, and no caller can obtain
// from it, which agent worked the business, which athlete, what a deal was
// worth, what the athlete agreed to do, who the contact was, or when. An
// agent learns only that the business has done an NIL deal on NILDash --
// which is a fact about the business, not about another agent's book.

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

// ── THE FLAG ITSELF ─────────────────────────────────────────────────────────
// One query over deal_outcomes for the whole page, not one per business: a My
// Brands page is fifty rows and fifty round trips is a page that hangs.
// Returns a Set of the cross-agent keys that have a logged deal against them.
//
// deal_outcomes.brand_key is written by services/dealLog when an agent logs a
// deal. A deal recorded by an older path carries no key, so it cannot be
// matched across agents and earns no flag -- which is the same rule as a
// business with no Place ID and no domain, and it is stated in the admin
// count rather than hidden.
async function loadFlagIndex(pool, keys) {
  const wanted = [...new Set((keys || []).filter(isCrossAgentKey))];
  if (!wanted.length) return new Set();
  try {
    const r = await pool.query(
      `SELECT DISTINCT brand_key FROM deal_outcomes
        WHERE brand_key = ANY($1::text[]) AND undone_at IS NULL`, [wanted]);
    return new Set(r.rows.map((x) => x.brand_key));
  } catch (e) {
    // A badge is decoration on a page that has to render. Never fail the page,
    // and never guess: an error means no flag, not a flag.
    console.error('[brandFlags] loadFlagIndex:', e.message);
    return new Set();
  }
}

// The flag for one business, given a loaded index.
function flagsFrom(index, business) {
  const keys = crossAgentKeys(business);
  const on = keys.some((k) => index && index.has && index.has(k));
  return { nilActive: !!on };
}

// Flags for a list of businesses, in one pass. Returns an array parallel to
// the input -- never a joined object, so a caller cannot accidentally carry a
// key or anything else back to a page.
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
// One badge, in words an agent can act on, and null when the business has not
// earned it -- so a page renders nothing rather than an empty chip.
const BADGE = {
  key: 'nil-active',
  label: 'NIL-active',
  title: 'This business has completed an NIL deal on NILDash.',
};
function badgeFor(flags) {
  return (flags && flags.nilActive) ? BADGE : null;
}

// How much the flag is worth when the nightly fill is choosing between
// businesses that all fit the athlete's market. A business that has signed
// before is the best lead in the pile. The number is a nudge, not an
// override: fit still decides first.
const RANK_BONUS = 30;
function rankBonus(flags) {
  return (flags && flags.nilActive) ? RANK_BONUS : 0;
}

// Admin only: how many businesses are NIL-active, across everyone.
async function counts(pool) {
  const out = { nilActive: 0, deals: 0, noIdentity: 0 };
  try {
    const r = await pool.query(
      `SELECT COUNT(DISTINCT brand_key)::int AS businesses, COUNT(*)::int AS deals
         FROM deal_outcomes
        WHERE undone_at IS NULL AND (brand_key LIKE 'place:%' OR brand_key LIKE 'dom:%')`);
    out.nilActive = (r.rows[0] && r.rows[0].businesses) || 0;
    out.deals = (r.rows[0] && r.rows[0].deals) || 0;
    // Deals whose business has neither a Place ID nor a domain can never
    // carry a flag. Reported rather than hidden: it is the ceiling on
    // coverage, and the reason is that a name is not an identity.
    const noKey = await pool.query(
      `SELECT COUNT(*)::int AS n FROM deal_outcomes
        WHERE undone_at IS NULL AND (brand_key IS NULL OR (brand_key NOT LIKE 'place:%' AND brand_key NOT LIKE 'dom:%'))`);
    out.noIdentity = (noKey.rows[0] && noKey.rows[0].n) || 0;
  } catch (e) {
    console.error('[brandFlags] counts:', e.message);
  }
  return out;
}

module.exports = {
  CROSS_AGENT_PREFIXES, BADGE, RANK_BONUS,
  isCrossAgentKey, normDomain, crossAgentKeys,
  loadFlagIndex, flagsFrom, flagsFor, attachFlags, badgeFor, rankBonus, counts,
};
