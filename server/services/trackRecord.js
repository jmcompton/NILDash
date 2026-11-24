'use strict';
// ── THE ATHLETE'S TRACK RECORD, ON THE MEDIA KIT ────────────────────────────
//
// A business deciding whether to work with a college athlete wants one thing
// before anything else: has this kid done it before, and did they post what
// they said they would? Opendorse-style profiles are a self-service listing;
// an agency (Propoint, Nov 2026) said what actually wins a local business is a
// record: "three deals last year, every post delivered". Paid, product or
// trade does not matter to the business and is never shown.
//
// Built from what NILDash already holds, never typed twice:
//   deals            a deal the agent marked Closed
//   gifted_deals     product the athlete received (Reports > Gifts & reports)
//   athlete_calendar_events
//                    deliverables marked done; on time when they were marked
//                    done on or before the day they were due
//   worked_with      the kit's own "previously worked with" names, which carry
//                    no date
//
// WHAT IS NEVER SHOWN: amounts, the product's value, whether it was paid,
// notes, contacts. A brand name, the month, and where it was posted when the
// agent saved a link to the post.
//
// The agent controls it: media_kits.show_track_record (on unless turned off)
// and media_kits.track_hidden (brands, lowercased, left off the kit).

const MAX_PARTNERS = 12;

const key = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const ym = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length === 10 ? String(v) + 'T12:00:00Z' : String(v));
  return isNaN(d) ? null : d.toISOString().slice(0, 7);
};
const PLATFORM_LABEL = { 'instagram story': 'Instagram story', 'instagram post': 'Instagram post', tiktok: 'TikTok', x: 'X', youtube: 'YouTube', facebook: 'Facebook' };

async function safeRows(pool, sql, args) {
  try { return (await pool.query(sql, args)).rows; }
  catch (e) {
    // A table that does not exist yet (no gift ever logged, no contract ever
    // uploaded) is an empty record, not an error.
    if (e && (e.code === '42P01' || e.code === '42703')) return [];
    throw e;
  }
}

// -> { partners: [{ brand, key, month, platform, postUrl, hidden }], delivered: { total, onTime } }
// Every partner is returned with hidden marked, so the builder can list them
// all; the kit filters (forKit).
async function forAthlete(pool, athleteId, { hidden = [] } = {}) {
  const hide = new Set((Array.isArray(hidden) ? hidden : []).map(key).filter(Boolean));
  const byBrand = new Map();
  const add = (brand, month, platform, postUrl) => {
    const name = clean(brand, 80);
    const k = key(name);
    if (!k || k.length < 2) return;
    const cur = byBrand.get(k);
    const p = platform ? (PLATFORM_LABEL[String(platform).toLowerCase()] || null) : null;
    const url = /^https:\/\//i.test(String(postUrl || '')) ? String(postUrl).slice(0, 500) : null;
    if (!cur) { byBrand.set(k, { brand: name, key: k, month: month || null, platform: p, postUrl: url, hidden: hide.has(k) }); return; }
    if (month && (!cur.month || month > cur.month)) cur.month = month;
    if (!cur.platform && p) cur.platform = p;
    if (!cur.postUrl && url) cur.postUrl = url;
  };

  const deals = await safeRows(pool,
    `SELECT data->>'brand' AS brand, data->>'closedAt' AS closed_at, updated_at
       FROM deals WHERE athlete_id = $1 AND data->>'stage' = 'Closed'`, [athleteId]);
  deals.forEach((d) => add(d.brand, ym(d.closed_at || d.updated_at), null, null));

  const gifts = await safeRows(pool,
    `SELECT brand, received_on, platform, post_url FROM gifted_deals WHERE athlete_id = $1`, [athleteId]);
  gifts.forEach((g) => add(g.brand, ym(g.received_on), g.platform && g.platform !== 'not posted yet' ? g.platform : null, g.post_url));

  const dv = (await safeRows(pool,
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE completed_at IS NOT NULL AND completed_at::date <= event_date)::int AS on_time
       FROM athlete_calendar_events WHERE athlete_id = $1 AND status = 'completed'`, [athleteId]))[0] || {};

  const partners = [...byBrand.values()].sort((a, b) => String(b.month || '').localeCompare(String(a.month || '')) || a.brand.localeCompare(b.brand));
  return { partners, delivered: { total: dv.total || 0, onTime: dv.on_time || 0 } };
}

// What the public kit shows, or null for no section. When something is
// recorded, mk.worked_with names not already in it join it, undated.
async function forKit(pool, mk) {
  if (!mk || !mk.athlete_id || mk.show_track_record === false) return null;
  const hidden = Array.isArray(mk.track_hidden) ? mk.track_hidden : [];
  const rec = await forAthlete(pool, mk.athlete_id, { hidden });
  // Only names the agent typed, nothing recorded: that is not a track record.
  // The kit keeps its "Previously worked with" line for those instead.
  if (!rec.partners.length && !rec.delivered.total) return null;
  const seen = new Set(rec.partners.map((p) => p.key));
  (Array.isArray(mk.worked_with) ? mk.worked_with : []).forEach((w) => {
    const name = clean(w, 80), k = key(name);
    if (k && !seen.has(k) && !hidden.map(key).includes(k)) { rec.partners.push({ brand: name, key: k, month: null, platform: null, postUrl: null, hidden: false }); seen.add(k); }
  });
  const shown = rec.partners.filter((p) => !p.hidden).slice(0, MAX_PARTNERS).map(({ brand, month, platform, postUrl }) => ({ brand, month, platform, postUrl }));
  if (!shown.length && !rec.delivered.total) return null;
  return { partners: shown, partnerCount: rec.partners.filter((p) => !p.hidden).length, delivered: rec.delivered };
}

module.exports = { forAthlete, forKit, MAX_PARTNERS, _key: key };
