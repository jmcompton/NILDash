'use strict';
// ── THE MEDIA KIT, AS A BRAND GETS IT: ONE FUNCTION ─────────────────────────
//
// There were three renderers of the kit -- the public page, the agent's
// builder preview and the athlete's -- and every fix landed three times or
// drifted. Now there is one: public/media-kit.html renders whatever this
// function returns. The public route returns it for the saved kit; the two
// builders' preview endpoints return it for the unsaved form, and the
// builders frame the real page with it. So the preview IS the page.
//
// AUDIENCE NUMBERS, IN THREE STATES (audienceOf):
//   verified       pulled from an account the athlete connected (Instagram,
//                  services/instagramConnect), with the date it was pulled
//   self-reported  typed by the agent or athlete; shown, labelled as such
//   (empty)        nothing entered: the platform is not in the list at all
// A connected account wins over a typed number. TikTok and X are
// self-reported until they can be connected.
//
// NOT IN THE PAYLOAD: the typed counts themselves (only audience[] carries
// numbers, each with its state), the rate cards (the agent's own reference;
// the kit never names a rate), and the brand variants table.

const fs = require('fs');
const path = require('path');

let _cols = null;
async function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '017_media_kit_story.sql'), 'utf8');
    for (const s of sql.replace(/--[^\n]*/g, '').split(';').map((x) => x.trim()).filter(Boolean)) await pool.query(s);
  })().catch((e) => { _cols = null; throw e; });
  return _cols;
}

const MAX_DELIVERABLES = 8, MAX_WORKED_WITH = 3;
const clip = (v, n) => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s ? s.slice(0, n) : null; };
const list = (v, max, n) => {
  let a = v;
  if (typeof a === 'string') a = a.split(/\n/);
  if (!Array.isArray(a)) return null;
  const out = a.map((x) => clip(x, n)).filter(Boolean).slice(0, max);
  return out.length ? out : null;
};
const dollars = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Math.round(Number(String(v).replace(/[$,\s]/g, '')));
  return Number.isFinite(n) && n > 0 ? n : null;
};

// The new fields from a builder's body, cleaned. Only keys present in the
// body are returned, so a save that omits one leaves it as it was.
function storyFromBody(b) {
  b = b || {};
  const out = {};
  if ('deliverables' in b) out.deliverables = list(b.deliverables, MAX_DELIVERABLES, 120);
  if ('price_mode' in b || 'price_low' in b || 'price_high' in b) {
    let mode = ['exact', 'range', 'from'].includes(b.price_mode) ? b.price_mode : null;
    let lo = dollars(b.price_low), hi = dollars(b.price_high);
    if (mode === 'range' && lo && hi && hi < lo) [lo, hi] = [hi, lo];
    if (mode === 'range' && lo && !hi) mode = 'exact';
    if (!lo) mode = null;
    out.price_mode = mode; out.price_low = mode ? lo : null; out.price_high = mode === 'range' ? hi : null;
  }
  if ('ask_line' in b) out.ask_line = clip(b.ask_line, 160);
  if ('hometown' in b) out.hometown = clip(b.hometown, 80);
  if ('class_year' in b) out.class_year = clip(b.class_year, 40);
  if ('major' in b) out.major = clip(b.major, 80);
  if ('bio_line' in b) out.bio_line = clip(b.bio_line, 200);
  if ('worked_with' in b) out.worked_with = list(b.worked_with, MAX_WORKED_WITH, 80);
  return out;
}
const STORY_COLUMNS = ['deliverables', 'price_mode', 'price_low', 'price_high', 'ask_line', 'hometown', 'class_year', 'major', 'bio_line', 'worked_with'];

// A builder's unsaved form over the saved kit (or none): what the kit WOULD be.
function draftKit(saved, body, athleteId) {
  const b = body || {};
  const mk = { ...(saved || {}), athlete_id: athleteId };
  for (const k of ['instagram_handle', 'instagram_followers', 'instagram_engagement', 'tiktok_handle', 'tiktok_followers',
    'twitter_handle', 'twitter_followers', 'bio', 'primary_color', 'secondary_color']) {
    if (k in b) mk[k] = b[k] === '' ? null : b[k];
  }
  if (['school', 'nildash', 'agency'].includes(b.theme)) mk.theme = b.theme;
  // Photos: absent keeps the saved one; '' is cleared; a data URL replaces it.
  if (b.headshot_data !== undefined) mk.headshot_url = b.headshot_data || null;
  if (b.action_shot_data !== undefined) mk.action_shot_data = b.action_shot_data || null;
  Object.assign(mk, storyFromBody(b));
  return mk;
}

// The audience block's data: one entry per platform that has a number, each
// with its state. [] when nothing is known.
function audienceOf(mk, ig) {
  const n = (v) => { const x = Number(String(v == null ? '' : v).replace(/[,\s]/g, '')); return Number.isFinite(x) && x > 0 ? Math.round(x) : null; };
  const handle = (h) => { const v = String(h || '').replace(/^@+/, '').trim(); return v && v.toLowerCase() !== 'demo' ? v : null; };
  const out = [];
  if (ig && ig.followers_count !== null && ig.followers_count !== undefined) {
    out.push({ platform: 'instagram', followers: Number(ig.followers_count), handle: ig.username || handle(mk.instagram_handle),
      engagement: ig.engagement_rate !== null && ig.engagement_rate !== undefined ? Math.round(Number(ig.engagement_rate) * 1000) / 10 : null,
      state: 'verified', source: 'instagram', fetchedAt: ig.fetched_at });
  } else if (n(mk.instagram_followers)) {
    const e = parseFloat(String(mk.instagram_engagement || '').replace('%', ''));
    out.push({ platform: 'instagram', followers: n(mk.instagram_followers), handle: handle(mk.instagram_handle),
      engagement: Number.isFinite(e) && e > 0 ? Math.round(e * 10) / 10 : null, state: 'self-reported' });
  }
  if (n(mk.tiktok_followers)) out.push({ platform: 'tiktok', followers: n(mk.tiktok_followers), handle: handle(mk.tiktok_handle), engagement: null, state: 'self-reported' });
  if (n(mk.twitter_followers)) out.push({ platform: 'twitter', followers: n(mk.twitter_followers), handle: handle(mk.twitter_handle), engagement: null, state: 'self-reported' });
  return out;
}

// mk: a media_kits row (saved, or a draft from draftKit). -> the public JSON.
async function payloadFor(pool, mk, opts = {}) {
  await ensureColumns(pool);
  const store = opts.store || require('../store');
  const ath = (await pool.query(
    `SELECT a.data->>'name' AS name, a.data->>'sport' AS sport, a.data->>'school' AS school, a.data->>'position' AS position,
            u.name AS agent_name, a.agent_id
       FROM athletes a LEFT JOIN users u ON u.id = a.agent_id WHERE a.id = $1`, [mk.athlete_id])).rows[0] || {};
  const owner = ath.agent_id ? await store.getUser(ath.agent_id).catch(() => null) : null;
  const agency = await require('./agencyBrand').brandForUser(owner || {});
  let ig = null;
  try { ig = await require('./instagramConnect').latestFor(pool, mk.athlete_id); }
  catch (e) { console.warn('[mediaKitPayload] instagram stats unavailable:', e.message); }
  const forSlug = String(opts.forSlug || '').trim().toLowerCase();
  const variants = mk.variants && typeof mk.variants === 'object' ? mk.variants : {};
  const variant = forSlug && variants[forSlug] ? { ...variants[forSlug], slug: forSlug } : null;
  const {
    variants: _v, instagram_followers: _a, instagram_engagement: _b, tiktok_followers: _c, twitter_followers: _d,
    photo_hash_at_build: _e, year_at_build: _f, position_at_build: _g, school_at_build: _h, built_by: _i, ...pub
  } = mk;
  return {
    ...pub,
    athlete_name: ath.name || '', sport: ath.sport || '', school: ath.school || '', position: ath.position || '',
    agent_first_name: require('./agentName').firstNameOrNull(ath.agent_name) || '',
    agency,
    audience: audienceOf(mk, ig),
    deliverables: Array.isArray(mk.deliverables) ? mk.deliverables : null,
    worked_with: Array.isArray(mk.worked_with) ? mk.worked_with : null,
    variant,
  };
}

module.exports = { payloadFor, draftKit, storyFromBody, audienceOf, ensureColumns, STORY_COLUMNS, MAX_WORKED_WITH, MAX_DELIVERABLES };
