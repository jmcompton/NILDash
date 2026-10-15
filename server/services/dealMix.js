'use strict';
// ── THE THREE-LANE DEAL MIX (MARKET_MIX_ON) ─────────────────────────────────
//
// The athlete's Market Score tier (services/marketScore) splits the five
// nightly slots between the lanes:
//
//   Local Star   4 local, 1 social (a small brand)
//   Rising       3 local, 2 social (small to mid brands)
//   Regional     2 local, 2 social (small to mid), 1 national (mid to national)
//   National     1 local, 2 social (mid to national), 2 national (mid to national)
//
// A lane's seats are a ceiling, not a target to make up from another lane: a
// social seat nobody passes the bar for stays empty, and the night says so.
//
// BRAND SIZE MATCHES THE TIER. small / mid / national, read from what we
// hold: the size the social index recorded for the brand (social_brands.
// brand_size), else how many NIL deals we have logged for it (20 or more is
// national, 3-19 mid). A brand whose size we cannot read is never pitched on
// a size-limited seat, and a household incumbent (services/signingEvidence)
// never at all. A Local Star is never pitched a national brand: not on the
// social seat and not as a chain location in the local lane.
//
// THE SAME BAR ON EVERY LANE. A social or national card is one of:
//   program  the brand's official ambassador / athlete / creator application
//            page: on the brand's own domain or a creator platform it runs its
//            program on, with a program path, verified by the social index
//   email    a NAMED partnerships, influencer or marketing contact with a
//            verified address at the brand's own domain (services/emailFinder:
//            valid only, never a catch-all guess, never a desk inbox)
// Nothing else: no DM, no guessed address, no info@ / partnerships@ inbox.

const ON = () => process.env.MARKET_MIX_ON === '1';
const LANES = ['local', 'social', 'national'];

const MIX = Object.freeze({
  local_star: Object.freeze({ local: 4, social: 1, national: 0 }),
  rising: Object.freeze({ local: 3, social: 2, national: 0 }),
  regional: Object.freeze({ local: 2, social: 2, national: 1 }),
  national: Object.freeze({ local: 1, social: 2, national: 2 }),
});
const SIZES = Object.freeze({
  local_star: { social: ['small'], national: [] },
  rising: { social: ['small', 'mid'], national: [] },
  regional: { social: ['small', 'mid'], national: ['mid', 'national'] },
  national: { social: ['mid', 'national'], national: ['mid', 'national'] },
});
const TIER_LABEL = { local_star: 'Local Star', rising: 'Rising', regional: 'Regional', national: 'National' };
const SIZE_WORD = { small: 'a small brand', mid: 'a mid-size brand', national: 'a national brand' };

function mixFor(tier) { return MIX[tier] || MIX.local_star; }
function laneOf(cand) {
  const l = cand && cand.lane;
  if (l === 'social' || l === 'national') return l;
  return 'local';                         // local and hometown share the local seats
}
function lanesFor(tier) {
  const m = mixFor(tier);
  return { local: m.local > 0, social: m.social > 0, national: m.national > 0 };
}

// held: { local, social, national } cards already holding a slot.
// -> what each lane may still place tonight.
function remaining(tier, held) {
  const m = mixFor(tier);
  const h = held || {};
  const out = {};
  for (const l of LANES) out[l] = Math.max(0, m[l] - (Number(h[l]) || 0));
  return out;
}

// ── SIZE ────────────────────────────────────────────────────────────────────
// -> { size: 'small'|'mid'|'national'|'incumbent'|null, why }
function sizeOf(cand) {
  const c = cand || {};
  const name = c.brand_name || c.brand || '';
  let inc = null;
  try { inc = require('./signingEvidence').incumbent(name); } catch (_) { inc = null; }
  if (inc) return { size: 'incumbent', why: `a household incumbent (${inc})` };
  if (c.lane === 'local' || c.lane === 'hometown') {
    let chain = null;
    try { chain = require('./nationalChains').isChainLocation(name); } catch (_) { chain = null; }
    if (chain) return { size: 'national', why: `a national chain location (${chain})` };
    return { size: 'small', why: 'a local business' };
  }
  const recorded = String(c.brandSize || '').toLowerCase();
  if (recorded === 'national' || recorded === 'global') return { size: 'national', why: 'sized national by the social index' };
  if (recorded === 'small') return { size: 'small', why: 'sized small by the social index' };
  if (recorded === 'mid' || recorded === 'regional' || recorded === 'growth') return { size: 'mid', why: `sized ${recorded} by the social index` };
  const deals = Number(c.dealCount);
  if (Number.isFinite(deals) && deals >= 20) return { size: 'national', why: `${deals} logged NIL deals` };
  if (Number.isFinite(deals) && deals >= 3) return { size: 'mid', why: `${deals} logged NIL deals` };
  return { size: null, why: 'no size recorded for this brand and fewer than 3 logged NIL deals' };
}

// May this candidate take a seat on this tier's lane? -> { ok, why, size }
function seatOk(tier, cand) {
  const lane = laneOf(cand);
  const s = sizeOf(cand);
  const label = TIER_LABEL[tier] || tier;
  if (s.size === 'incumbent') return { ok: false, size: s.size, why: `${s.why}: never pitched` };
  if (lane === 'local') {
    if (tier === 'local_star' && s.size === 'national') return { ok: false, size: s.size, why: `${s.why}; a Local Star is never pitched a national brand` };
    return { ok: true, size: s.size, why: null };
  }
  const allowed = (SIZES[tier] || SIZES.local_star)[lane] || [];
  if (!allowed.length) return { ok: false, size: s.size, why: `a ${label} has no ${lane} seats` };
  if (!s.size) return { ok: false, size: null, why: `${s.why}, so it cannot be matched to a ${label}` };
  if (!allowed.includes(s.size)) {
    return { ok: false, size: s.size, why: `${SIZE_WORD[s.size]} (${s.why}); a ${label}'s ${lane} seats take ${allowed.map((x) => SIZE_WORD[x].replace(/^an? /, '')).join(' or ')}` };
  }
  return { ok: true, size: s.size, why: null };
}

// ── THE OFFICIAL APPLICATION PAGE ───────────────────────────────────────────
// Creator platforms brands run their ambassador programs on.
const PROGRAM_HOSTS = /(^|\.)(grin\.co|aspire\.io|aspireiq\.com|creatoriq\.com|impact\.com|upfluence\.com|refersion\.com|shareasale\.com|collabs\.shopify\.com|goaffpro\.com|uppromote\.com|superfiliate\.com|social-snowball\.com|levanta\.io|partnerize\.com|awin\.com|tapfiliate\.com|influence\.co)$/i;
const PROGRAM_PATH = /(ambassador|athlete|creator|partner|affiliate|apply|application|program|collab|influencer|\bnil\b|sponsor|team-?[a-z]*-?rep|brand-?rep)/i;
function rootOf(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  try { return require('./emailTier').rootDomain(h) || h; } catch (_) { return h.split('.').slice(-2).join('.'); }
}
function hostOf(u) { try { return new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u).hostname.toLowerCase(); } catch (_) { return ''; } }

// url: the candidate page; website: the brand's own site (or null).
// -> { ok, why }
function isOfficialProgramPage(url, website) {
  const u = String(url || '').trim();
  if (!u) return { ok: false, why: 'no application page' };
  let parsed;
  try { parsed = new URL(/^https?:\/\//i.test(u) ? u : 'https://' + u); } catch (_) { return { ok: false, why: 'not a valid address' }; }
  const host = parsed.hostname.toLowerCase();
  const path = decodeURIComponent(parsed.pathname + parsed.search).toLowerCase();
  const sub = host.split('.').slice(0, -2).join('.');
  const onPlatform = PROGRAM_HOSTS.test(host);
  const own = website ? rootOf(hostOf(website)) : null;
  const onOwn = !!own && rootOf(host) === own;
  if (!onPlatform && !onOwn) {
    return { ok: false, why: own ? `${host} is not ${own} or a creator platform` : `${host} is not a creator platform and the brand's own site is not known` };
  }
  if (!PROGRAM_PATH.test(path) && !PROGRAM_PATH.test(sub) && !onPlatform) {
    return { ok: false, why: `${host}${parsed.pathname} is not an ambassador or athlete program page` };
  }
  if (onOwn && (parsed.pathname === '/' || parsed.pathname === '') && !PROGRAM_PATH.test(sub)) {
    return { ok: false, why: 'the brand\'s home page, not an application page' };
  }
  return { ok: true, why: null };
}
// The candidate's official page or null. Only the index's VERIFIED page
// (social_brands.proof_url) is a candidate: the scout's fallback to the
// brand's website is not an application page.
function officialPageOf(cand) {
  const c = cand || {};
  const url = c.proofUrl || null;
  if (!url) return { url: null, why: 'no verified application page in the social index' };
  const v = isOfficialProgramPage(url, c.website || null);
  return v.ok ? { url, why: null } : { url: null, why: v.why };
}

// ── THE CONTACT ─────────────────────────────────────────────────────────────
const CONTACT_TITLE = /\b(partnerships?|partner (marketing|relations|manager|lead)|influencer|marketing|sponsorships?|ambassadors?|creator|affiliate|nil|athlete (marketing|relations|partnerships))\b/i;
const NOT_A_LEAD = /\b(intern|internship|student|volunteer|trainee|apprentice)\b/i;
function contactTitleOk(title) {
  const t = String(title || '').trim();
  if (!t) return { ok: false, why: 'no title recorded for the contact' };
  if (NOT_A_LEAD.test(t)) return { ok: false, why: `"${t}" is not a lead who can sign a partnership` };
  if (!CONTACT_TITLE.test(t)) return { ok: false, why: `"${t}" is not a partnerships, influencer or marketing contact` };
  return { ok: true, why: null };
}

// ── WHAT HOLDS A SLOT ───────────────────────────────────────────────────────
// Under EMAIL_FIVE_ON a verified email card holds a slot (as before), and so
// does a program card on an official application page. Off: every queued
// card holds its slot.
function holdsUnderMix(row, { five } = {}) {
  if (!row) return false;
  if (!five) return true;
  if (row.channel === 'email' && row.email_verified === true) return true;
  if (row.channel === 'program' && row.program_url) {
    try { const p = new URL(row.program_url); return PROGRAM_PATH.test(p.pathname + p.search) || PROGRAM_HOSTS.test(p.hostname); } catch (_) { return false; }
  }
  return false;
}
function heldByLane(rows, opts) {
  const out = { local: 0, social: 0, national: 0 };
  for (const r of rows || []) if (holdsUnderMix(r, opts)) out[laneOf(r)]++;
  return out;
}

// The columns a mix card records (also added at boot, server/store.js).
let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS market_tier TEXT`);
    await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS brand_size TEXT`);
    await pool.query(`ALTER TABLE outreach_queue ADD COLUMN IF NOT EXISTS fit_reasons JSONB`);
  })().catch((e) => { _cols = null; throw e; });
  return _cols;
}

function describe(tier, rem) {
  const m = mixFor(tier);
  const sz = SIZES[tier] || SIZES.local_star;
  const parts = [`${m.local} local`];
  if (m.social) parts.push(`${m.social} social (${sz.social.join('/')})`);
  if (m.national) parts.push(`${m.national} national (${sz.national.join('/')})`);
  return `${TIER_LABEL[tier] || tier}: ${parts.join(', ')}` + (rem ? `; open tonight: ${LANES.map((l) => `${rem[l]} ${l}`).join(', ')}` : '');
}

module.exports = {
  ON, MIX, SIZES, LANES, TIER_LABEL, mixFor, laneOf, lanesFor, remaining, sizeOf, seatOk,
  isOfficialProgramPage, officialPageOf, contactTitleOk, holdsUnderMix, heldByLane, describe, ensureColumns,
  PROGRAM_HOSTS, PROGRAM_PATH, CONTACT_TITLE,
};
