'use strict';
// ── EVERY ATHLETE ON THE ROSTER, APPLIED TO BRANDS THAT WANT ATHLETES ───────
//
// What sets the university side apart from a marketplace (Opendorse, INFLCR's
// Local Exchange, TheLinkU): a marketplace waits for a business to show up.
// This goes the other way. The brands in social_brands run their own athlete,
// ambassador or creator programs and say so on a page we verified
// (jobs/socialDiscovery, services/socialProof): they are asking for
// applications. This matches each athlete on the department's roster to a few
// of them, spread so no brand gets the whole roster, and writes the finished
// application for each (services/applyPacket). The NIL office sends it to the
// athlete, the athlete submits it, the office marks it.
//
// UNIVERSITY TABLES ONLY (migrations/007): university_athletes, universities,
// and this file's university_applications. social_brands is the public brand
// catalog (web-verified program pages), not an agent's data: no agent table is
// read or written here. Every query is scoped by the caller's university id,
// which the route takes from the session.
//
// No model call and no paid API: the matching is the catalog's own facts
// (sports, tiers) and the application is built from the roster.

const AP = require('./applyPacket');

const PER_ATHLETE = 2;           // applications opened per athlete per refresh
const OPEN_CAP = 3;              // never more than this many open per athlete
const STATES = ['open', 'sent', 'applied', 'accepted', 'declined', 'skipped'];

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS university_applications (
    id            SERIAL PRIMARY KEY,
    university_id TEXT        NOT NULL,
    athlete_id    TEXT        NOT NULL,
    brand         TEXT        NOT NULL,
    program_url   TEXT,
    state         TEXT        NOT NULL DEFAULT 'open',
    acted_by      TEXT,
    acted_at      TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (university_id, athlete_id, brand))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS university_applications_univ_idx ON university_applications (university_id, state)`);
}

// "Women's Soccer" -> { sport: 'soccer', women: true }. The roster's sport is
// the team's name.
function sportOf(team) {
  const t = String(team || '').toLowerCase();
  const women = /\b(women|womens|women's|lady|ladies)\b/.test(t) || /^w\.?\s/.test(t);
  const sport = t.replace(/\b(men'?s|women'?s|mens|womens|lady|ladies|varsity)\b/g, '').replace(/^w\.?\s|^m\.?\s/, '').replace(/\s+/g, ' ').trim();
  return { sport, women };
}

// A brand's program fits the athlete's sport: it says "all", names nothing,
// or names this sport.
function sportFits(brandSports, team) {
  const list = Array.isArray(brandSports) ? brandSports.map((s) => String(s).toLowerCase().trim()).filter(Boolean) : [];
  if (!list.length || list.includes('all')) return { ok: true, named: false };
  const { sport } = sportOf(team);
  if (!sport) return { ok: false, named: false };
  const hit = list.some((s) => { const b = sportOf(s).sport; return b && (b === sport || sport.includes(b) || b.includes(sport)); });
  return { ok: hit, named: hit };
}

// We hold no follower counts for a roster athlete, so a program that states a
// floor above micro-creator size is left out rather than applied to blind.
const OPEN_FLOOR = 2000;
const tierOpen = (b) => b.tier_min == null || Number(b.tier_min) <= OPEN_FLOOR;

// Stable per pair, so a refresh is repeatable and two athletes on one team do
// not both get the same first brand.
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }

// pick({ athletes, brands, existing, perAthlete, openCap }) -> [{ athleteId, brand, programUrl }]
// Pure. existing: Map athleteId -> { brands: Set, open: n }. Each athlete gets
// the fitting brands with the fewest applications in this department so far
// (a sport-specific program before an "all sports" one), so the roster is
// spread across the catalog instead of 400 applications to one brand.
function pick({ athletes, brands, existing, perAthlete = PER_ATHLETE, openCap = OPEN_CAP }) {
  const usage = new Map();
  for (const [, ex] of existing) for (const b of ex.brands) usage.set(b, (usage.get(b) || 0) + 1);
  const out = [];
  for (const a of athletes) {
    const ex = existing.get(a.id) || { brands: new Set(), open: 0 };
    let room = Math.min(perAthlete, Math.max(0, openCap - ex.open));
    if (room <= 0) continue;
    const fits = brands
      .filter((b) => !ex.brands.has(b.brand.toLowerCase()))
      .map((b) => ({ b, f: sportFits(b.sports, a.sport) }))
      .filter((x) => x.f.ok)
      .sort((x, y) => (usage.get(x.b.brand.toLowerCase()) || 0) - (usage.get(y.b.brand.toLowerCase()) || 0)
        || (y.f.named - x.f.named)
        || (hash(a.id + x.b.brand) - hash(a.id + y.b.brand)));
    for (const { b } of fits) {
      if (room <= 0) break;
      out.push({ athleteId: a.id, brand: b.brand, programUrl: b.proof_url });
      const k = b.brand.toLowerCase();
      usage.set(k, (usage.get(k) || 0) + 1);
      ex.brands.add(k); room--;
    }
  }
  return out;
}

// The brands a department may apply to: active, a real application page
// (applyPacket.linkOk), open to an athlete of unknown size.
async function catalog(pool) {
  const rows = (await pool.query(
    `SELECT brand, category, website, proof_url, offer_summary, deal_structure, sports, tier_min, tier_max
       FROM social_brands WHERE active = true AND proof_url IS NOT NULL ORDER BY brand`)).rows;
  return rows.filter((b) => tierOpen(b) && AP.linkOk(b.proof_url, b.website).ok);
}

// Open new applications for the department's roster. Returns what it did.
async function refresh(pool, universityId, opts = {}) {
  await ensureTables(pool);
  const athletes = (await pool.query(
    `SELECT id, name, sport FROM university_athletes WHERE university_id = $1 AND name IS NOT NULL ORDER BY sport, name`, [universityId])).rows;
  const brands = await catalog(pool);
  const have = (await pool.query(
    `SELECT athlete_id, LOWER(brand) AS brand, state FROM university_applications WHERE university_id = $1`, [universityId])).rows;
  const existing = new Map();
  for (const h of have) {
    const ex = existing.get(h.athlete_id) || { brands: new Set(), open: 0 };
    ex.brands.add(h.brand); if (h.state === 'open') ex.open++;
    existing.set(h.athlete_id, ex);
  }
  const picks = pick({ athletes, brands, existing, perAthlete: opts.perAthlete || PER_ATHLETE });
  for (const p of picks) {
    await pool.query(
      `INSERT INTO university_applications (university_id, athlete_id, brand, program_url) VALUES ($1,$2,$3,$4)
       ON CONFLICT (university_id, athlete_id, brand) DO NOTHING`, [universityId, p.athleteId, p.brand, p.programUrl]);
  }
  return { athletes: athletes.length, brands: brands.length, opened: picks.length };
}

// What the NIL office sees: a count by sport and every application, written.
async function list(pool, universityId, { sport, state, staff } = {}) {
  await ensureTables(pool);
  const uni = (await pool.query(`SELECT id, name, short_name FROM universities WHERE id = $1`, [universityId])).rows[0] || { name: '' };
  const rows = (await pool.query(
    `SELECT ap.id, ap.athlete_id, ap.brand, ap.program_url, ap.state, ap.acted_at, ap.created_at,
            ua.name, ua.sport, ua.position, ua.year, ua.email, ua.data,
            sb.category, sb.offer_summary, sb.deal_structure, sb.website, sb.proof_url, sb.sports
       FROM university_applications ap
       JOIN university_athletes ua ON ua.id = ap.athlete_id AND ua.university_id = ap.university_id
       LEFT JOIN LATERAL (SELECT * FROM social_brands s WHERE LOWER(s.brand) = LOWER(ap.brand) ORDER BY s.active DESC LIMIT 1) sb ON TRUE
      WHERE ap.university_id = $1
      ORDER BY ua.sport, ua.name, ap.created_at`, [universityId])).rows;
  const roster = (await pool.query(
    `SELECT sport, COUNT(*)::int n FROM university_athletes WHERE university_id = $1 AND name IS NOT NULL GROUP BY sport ORDER BY sport`, [universityId])).rows;

  const bySport = new Map(roster.map((r) => [r.sport, { sport: r.sport, athletes: r.n, withApps: new Set(), open: 0, applied: 0, accepted: 0 }]));
  for (const r of rows) {
    const s = bySport.get(r.sport) || { sport: r.sport, athletes: 0, withApps: new Set(), open: 0, applied: 0, accepted: 0 };
    s.withApps.add(r.athlete_id);
    if (r.state === 'open' || r.state === 'sent') s.open++;
    if (r.state === 'applied') s.applied++;
    if (r.state === 'accepted') { s.applied++; s.accepted++; }
    bySport.set(r.sport, s);
  }
  const summary = [...bySport.values()].map((s) => ({ ...s, withApps: s.withApps.size, women: sportOf(s.sport).women }));
  const contact = staff && (staff.name || staff.email)
    ? { name: [staff.name, staff.title, `${uni.short_name || uni.name} NIL office`].filter(Boolean).join(', '), email: staff.email } : null;

  const apps = rows
    .filter((r) => (!sport || r.sport === sport) && (!state || r.state === state))
    .filter((r) => AP.linkOk(r.program_url, r.website).ok)
    .map((r) => {
      const d = r.data || {};
      const athlete = { name: r.name, school: uni.name, sport: r.sport, position: r.position, year: r.year,
        hometown: d.hometown || null, instagramHandle: d.instagram || null };
      const fits = sportFits(r.sports, r.sport);
      const packet = AP.build({
        card: { brand_name: r.brand, program_url: r.program_url },
        athlete,
        brand: { brand: r.brand, category: r.category, offer_summary: r.offer_summary, deal_structure: r.deal_structure, proof_url: r.proof_url },
        fit: fits.named ? { kinds: ['sport'] } : null,
        agent: contact, contactLabel: 'School contact',
      });
      return { id: r.id, athleteId: r.athlete_id, athleteName: r.name, sport: r.sport, state: r.state, actedAt: r.acted_at,
        ...packet, athleteText: AP.athleteText(packet, r.name),
        mailto: AP.mailtoFor(packet, r.email || d.email || null, r.name) };
    });
  const totals = summary.reduce((t, s) => ({ athletes: t.athletes + s.athletes, covered: t.covered + s.withApps,
    open: t.open + s.open, applied: t.applied + s.applied, accepted: t.accepted + s.accepted }),
  { athletes: 0, covered: 0, open: 0, applied: 0, accepted: 0 });
  return { university: uni.name, totals, bySport: summary, applications: apps };
}

async function setState(pool, universityId, id, state, userId) {
  if (!STATES.includes(state)) return { ok: false, error: `state must be one of ${STATES.join(', ')}` };
  await ensureTables(pool);
  const r = await pool.query(
    `UPDATE university_applications SET state = $3, acted_by = $4, acted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND university_id = $2 RETURNING id, state`, [id, universityId, state, userId || null]);
  return r.rows[0] ? { ok: true, ...r.rows[0] } : { ok: false, error: 'not found' };
}

module.exports = { ensureTables, refresh, list, setState, pick, sportOf, sportFits, catalog, STATES, PER_ATHLETE, OPEN_CAP };
