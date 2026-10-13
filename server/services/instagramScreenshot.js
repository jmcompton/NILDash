'use strict';
// ── "CAN'T CONNECT? UPLOAD A SCREENSHOT OF YOUR INSIGHTS" ───────────────────
//
// A personal account cannot connect at all, and while Meta's app review is
// pending only testers can. So the athlete's page also takes up to three
// screenshots of the Instagram Insights screens; a vision model reads the
// numbers it can see (followers, reach, top cities, age, gender) and they are
// stored as an instagram_stats row with source 'screenshot' and the date.
//
// NEVER "VERIFIED". Everywhere they appear they say "From the athlete's
// screenshot", never "Verified by Instagram", and the pitch writer never sees
// them (instagramInsights.verifiedFor reads connected accounts only).
// A number the model could not read is null, never 0.
const MODEL = process.env.IG_SCREENSHOT_MODEL || 'claude-sonnet-4-6';
const MAX_IMAGES = 3;
const MAX_BYTES = 5 * 1024 * 1024;   // per image, decoded
const TYPES = { 'image/png': 1, 'image/jpeg': 1, 'image/jpg': 1, 'image/webp': 1, 'image/heic': 0 };

// data:image/png;base64,.... -> { mediaType, data } or an error.
function parseImage(dataUrl) {
  const m = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) return { error: 'not an image' };
  const mediaType = m[1].toLowerCase() === 'image/jpg' ? 'image/jpeg' : m[1].toLowerCase();
  if (!TYPES[mediaType]) return { error: mediaType === 'image/heic' ? 'HEIC photos cannot be read: take a screenshot instead' : 'only PNG, JPEG or WebP' };
  const data = m[2].replace(/\s+/g, '');
  if (Buffer.byteLength(data, 'base64') > MAX_BYTES) return { error: 'too large (5 MB each at most)' };
  return { mediaType, data };
}

const PROMPT = `These are screenshots of an athlete's Instagram Insights screens. Read ONLY numbers that are visible.
Return ONLY this JSON, with null for anything you cannot see clearly:
{
  "username": "the @handle if shown, without @, or null",
  "followers": integer or null,
  "periodDays": the number of days the Insights screen covers (7, 14, 30, 90) or null,
  "accountsReached": integer or null,
  "views": integer or null,
  "accountsEngaged": integer or null,
  "topCities": [{"city": "City name", "pct": number}] or null,
  "topCountries": [{"country": "Country", "pct": number}] or null,
  "ages": [{"band": "18-24", "pct": number}] or null,
  "gender": [{"label": "Men" or "Women", "pct": number}] or null
}
Percentages as numbers (62.5, not "62.5%"). Never guess, never estimate, never compute a number that is not printed.`;

// A number the model did not read is null, never 0 (Number('') is 0).
const int = (v) => { const t = String(v == null ? '' : v).replace(/[,\s]/g, ''); if (!/^\d+(\.\d+)?$/.test(t)) return null; const n = Math.round(Number(t)); return Number.isFinite(n) ? n : null; };
const pctRows = (rows, key) => {
  if (!Array.isArray(rows)) return null;
  const out = rows.map((r) => ({ key: String((r && r[key]) || '').trim(), pct: Number(r && r.pct) }))
    .filter((r) => r.key && Number.isFinite(r.pct) && r.pct > 0 && r.pct <= 100);
  return out.length ? out : null;
};

// The model's reply, checked. -> { username, followers, ... } with nulls.
function clean(j) {
  j = j || {};
  return {
    username: j.username ? String(j.username).replace(/^@+/, '').trim().slice(0, 60) || null : null,
    followers: int(j.followers), periodDays: int(j.periodDays),
    accountsReached: int(j.accountsReached), views: int(j.views), accountsEngaged: int(j.accountsEngaged),
    topCities: pctRows(j.topCities, 'city'), topCountries: pctRows(j.topCountries, 'country'),
    ages: pctRows(j.ages, 'band'), gender: pctRows(j.gender, 'label'),
  };
}

// The stored shape matches what instagramInsights.derive reads: percentages
// become breakdown rows (value = the percent), so top cities, ages, gender and
// the local share read the same way as a connected account's.
function asInsights(r, at) {
  const rows = (xs) => (xs ? xs.map((x) => ({ key: x.key, value: x.pct })) : null);
  const any = r.topCities || r.topCountries || r.ages || r.gender;
  return {
    fetchedAt: at.toISOString(), source: 'screenshot', periodDays: r.periodDays,
    account: { reach: r.accountsReached, views: r.views, accounts_engaged: r.accountsEngaged },
    demographics: any ? { available: true, follower_demographics: { last_30_days: { city: rows(r.topCities), country: rows(r.topCountries), age: rows(r.ages), gender: rows(r.gender) } } }
      : { available: false, reason: 'not shown in the screenshots' },
    posts: [], errors: [],
  };
}

// images: data URLs. deps.read (tests) replaces the model. -> { ok, stats } or { ok:false, error }.
async function readAndStore(pool, athleteId, images, deps = {}) {
  const list = (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES);
  if (!list.length) return { ok: false, error: 'Add at least one screenshot.' };
  const parsed = list.map(parseImage);
  const bad = parsed.find((p) => p.error);
  if (bad) return { ok: false, error: `One of the images is ${bad.error}.` };
  let raw;
  try {
    raw = deps.read ? await deps.read(parsed) : await _readWithModel(parsed);
  } catch (e) {
    require('./ourFault').record('anthropic', 'instagram screenshot read failed: ' + e.message, 'instagramScreenshot').catch(() => {});
    return { ok: false, error: 'We could not read the screenshots right now. Please try again in a few minutes.' };
  }
  const r = clean(raw);
  if (r.followers === null && r.accountsReached === null && !r.topCities && !r.ages && !r.gender) {
    return { ok: false, error: 'We could not find Instagram Insights numbers in those images. Try a screenshot of the Insights overview and the audience screen.' };
  }
  const at = new Date();
  await require('./instagramConnect').ensureTables(pool);
  await pool.query(
    `INSERT INTO instagram_stats (athlete_id, username, fetched_at, followers_count, posts, posts_counted, insights, source)
     VALUES ($1,$2,$3,$4,'[]'::jsonb,0,$5::jsonb,'screenshot')`,
    [athleteId, r.username, at, r.followers, JSON.stringify(asInsights(r, at))]);
  return { ok: true, stats: r, at };
}

async function _readWithModel(images) {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = require('../ai').guardAnthropic(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), 'instagramScreenshot');
  const t0 = Date.now();
  const resp = await anthropic.messages.create({
    model: MODEL, max_tokens: 800,
    messages: [{ role: 'user', content: images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } }))
      .concat([{ type: 'text', text: PROMPT }]) }],
  });
  try { require('./aiLedger').record(resp, { model: MODEL, ms: Date.now() - t0, site: 'instagram.screenshot' }); } catch (_) { /* ledger optional */ }
  const text = (resp.content || []).map((c) => c.text || '').join('');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  return a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : {};
}

module.exports = { readAndStore, parseImage, clean, asInsights, MAX_IMAGES, MODEL };
