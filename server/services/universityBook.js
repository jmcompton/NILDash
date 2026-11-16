'use strict';
// ── THE BOOKING PAGE (public, https://mynildash.com/book/<school>) ────────────
//
// The yes made easy. Every nightly pitch links here. A business picks a team,
// sees the deal the school offers at the school's own price (My Teams, the
// NIL deal rate), or asks for options when no rate is set, says when, and
// books in two minutes. No back and forth.
//
// A booking lands with the department, not with NILDash:
//   university_bookings   the request, as the business sent it
//   university_crm        the business moves to "Working out terms" (never
//                         backwards: a signed deal stays signed)
//   university_touches    an inbound touch saying what they booked
// The office then sets terms and pays the players in its own NIL
// marketplace. NILDash never signs or negotiates anything.
//
// UNIVERSITY TABLES ONLY. The page shows teams and the school's prices; it
// never shows or names an athlete.

const SLUG = /^[a-z0-9][a-z0-9-]{1,59}$/;
const slugOf = (universityId) => String(universityId || '').replace(/^univ-/, '');
const idOf = (slug) => (SLUG.test(String(slug || '')) ? 'univ-' + slug : null);
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
function bookUrl(universityId, teamId, draftId) {
  const q = new URLSearchParams();
  if (teamId) q.set('t', teamId);
  if (draftId) q.set('r', draftId);
  const qs = q.toString();
  return `${APP_URL()}/book/${slugOf(universityId)}${qs ? '?' + qs : ''}`;
}

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS university_bookings (
    id            SERIAL      PRIMARY KEY,
    university_id TEXT        NOT NULL,
    team_id       TEXT,
    business      TEXT        NOT NULL,
    contact_name  TEXT,
    email         TEXT,
    phone         TEXT,
    deal          TEXT,
    price_cents   INTEGER,
    wants_options BOOLEAN     NOT NULL DEFAULT FALSE,
    dates         TEXT,
    note          TEXT,
    draft_id      TEXT,
    status        TEXT        NOT NULL DEFAULT 'new',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS university_bookings_university_idx ON university_bookings (university_id, created_at DESC)`);
  // THE SCHOOL'S OWN NIL MARKETPLACE (Opendorse, INFLCR, its own page): where
  // a booked business goes to set up and pay the deal. NILDash brings the
  // business; the deal runs in the system the school already uses.
  await pool.query(`ALTER TABLE universities ADD COLUMN IF NOT EXISTS nil_marketplace_name TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE universities ADD COLUMN IF NOT EXISTS nil_marketplace_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS nil_rate_cents INTEGER`).catch(() => {});
  await pool.query(`ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS nil_rate_what TEXT`).catch(() => {});
}

const money = (c) => '$' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const SEASON_ORDER = { Fall: 1, Winter: 2, Spring: 3 };

// What the public page shows: the school's name and its teams with prices.
async function page(pool, slug) {
  const id = idOf(slug);
  if (!id) return null;
  const u = (await pool.query(`SELECT id, name, short_name, location,
      to_jsonb(universities)->>'nil_marketplace_name' AS mp_name, to_jsonb(universities)->>'nil_marketplace_url' AS mp_url
      FROM universities WHERE id = $1`, [id])).rows[0];
  if (!u) return null;
  const teams = (await pool.query(
    `SELECT t.id, t.name, t.sport, t.season,
            (to_jsonb(t)->>'nil_rate_cents')::int AS nil_rate_cents, to_jsonb(t)->>'nil_rate_what' AS nil_rate_what
       FROM university_teams t WHERE t.university_id = $1`, [id])).rows
    .sort((a, b) => (SEASON_ORDER[a.season] || 4) - (SEASON_ORDER[b.season] || 4) || a.name.localeCompare(b.name))
    .map((t) => ({ id: t.id, name: t.name, season: t.season || null,
      rate: t.nil_rate_cents > 0 ? { cents: t.nil_rate_cents, price: money(t.nil_rate_cents), what: t.nil_rate_what || '' } : null }));
  return { school: { name: u.name, short: u.short_name || u.name, location: u.location || null }, teams,
    marketplace: u.mp_url ? { name: u.mp_name || 'our NIL marketplace', url: u.mp_url } : null };
}

// A business books. -> { ok, id } or { ok:false, status, error }.
async function book(pool, slug, input) {
  const id = idOf(slug);
  if (!id) return { ok: false, status: 404, error: 'No such school.' };
  const b = input || {};
  if (clean(b.website, 10)) return { ok: true, id: null };   // the hidden field a person never fills
  const business = clean(b.business, 120);
  const contactName = clean(b.name, 120);
  const email = clean(b.email, 200).toLowerCase();
  const phone = clean(b.phone, 40);
  if (business.length < 2) return { ok: false, status: 400, error: 'Enter your business name.' };
  if (contactName.length < 2) return { ok: false, status: 400, error: 'Enter your name.' };
  if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return { ok: false, status: 400, error: 'That email does not look right.' };
  if (!email && phone.replace(/\D/g, '').length < 10) return { ok: false, status: 400, error: 'Enter an email or a phone number so the office can reach you.' };
  const team = (await pool.query(
    `SELECT t.id, t.name, (to_jsonb(t)->>'nil_rate_cents')::int AS nil_rate_cents, to_jsonb(t)->>'nil_rate_what' AS nil_rate_what
       FROM university_teams t WHERE t.id = $1 AND t.university_id = $2`, [String(b.teamId || ''), id])).rows[0];
  if (!team) return { ok: false, status: 400, error: 'Pick a team.' };
  const rated = team.nil_rate_cents > 0 && !b.wantsOptions;
  const dates = clean(b.dates, 200) || null;
  const note = clean(b.note, 1000) || null;
  // A pitch's own link carries its draft id; kept only if it is this school's.
  let draftId = clean(b.ref, 80) || null;
  if (draftId) {
    const d = (await pool.query(`SELECT 1 FROM university_drafts WHERE id = $1 AND university_id = $2`, [draftId, id]).catch(() => ({ rows: [] }))).rows[0];
    if (!d) draftId = null;
  }
  // The same business booking the same team twice in ten minutes (a double
  // tap, a resend) is the first booking, not a second.
  const twin = (await pool.query(
    `SELECT id FROM university_bookings WHERE university_id = $1 AND team_id = $2 AND LOWER(business) = LOWER($3) AND created_at > NOW() - INTERVAL '10 minutes'`,
    [id, team.id, business])).rows[0];
  if (twin) return { ok: true, id: twin.id, team: team.name, rated, school: id, duplicate: true };
  const r = await pool.query(
    `INSERT INTO university_bookings (university_id, team_id, business, contact_name, email, phone, deal, price_cents, wants_options, dates, note, draft_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [id, team.id, business, contactName, email || null, phone || null, rated ? team.nil_rate_what : null, rated ? team.nil_rate_cents : null, !rated, dates, note, draftId]);

  const what = rated ? `${team.nil_rate_what} at ${money(team.nil_rate_cents)}` : 'asked for options with prices';
  const summary = [`Booked from your link: ${team.name}, ${what}.`, dates ? `When: ${dates}.` : null,
    `Contact: ${[contactName, email, phone].filter(Boolean).join(', ')}.`, note ? `Note: ${note}` : null].filter(Boolean).join(' ');
  await pool.query(
    `INSERT INTO university_touches (university_id, brand, user_id, user_name, channel, direction, team_id, summary, stage_after, draft_id)
     VALUES ($1,$2,NULL,$3,'other','in',$4,$5,'in_talks',$6)`, [id, business, contactName, team.id, summary, draftId]);
  await pool.query(
    `INSERT INTO university_crm (university_id, brand, stage, last_touch_at, last_touch_by, updated_at, updated_by)
     VALUES ($1,$2,'in_talks',NOW(),$3,NOW(),NULL)
     ON CONFLICT (university_id, brand) DO UPDATE SET
       stage = CASE WHEN university_crm.stage IN ('deal_signed', 'in_talks') THEN university_crm.stage ELSE 'in_talks' END,
       last_touch_at = NOW(), last_touch_by = $3, updated_at = NOW()`, [id, business, contactName]);
  return { ok: true, id: r.rows[0].id, team: team.name, rated, school: id };
}

// The office's list: newest first, with the team's name.
async function list(pool, universityId, { status } = {}) {
  const rows = (await pool.query(
    `SELECT b.*, t.name AS team FROM university_bookings b LEFT JOIN university_teams t ON t.id = b.team_id
      WHERE b.university_id = $1 ${status ? 'AND b.status = $2' : ''} ORDER BY b.created_at DESC LIMIT 100`,
    status ? [universityId, status] : [universityId])).rows;
  return rows.map((r) => ({ id: r.id, team: r.team || null, teamId: r.team_id, business: r.business, contact: r.contact_name, email: r.email, phone: r.phone,
    deal: r.deal, cents: r.price_cents, wantsOptions: r.wants_options, dates: r.dates, note: r.note, status: r.status, at: r.created_at }));
}
async function setStatus(pool, universityId, bookingId, status) {
  if (!['new', 'seen', 'done'].includes(status)) return { ok: false, error: 'unknown status' };
  const r = await pool.query(`UPDATE university_bookings SET status = $1 WHERE id = $2 AND university_id = $3`, [status, Number(bookingId) || 0, universityId]);
  return r.rowCount ? { ok: true } : { ok: false, error: 'no such booking' };
}

// ── WORKING ALONGSIDE THE SCHOOL'S TOOLS ────────────────────────────────────
// The marketplace link, set by staff. Only an https address is kept.
async function marketplace(pool, universityId) {
  const r = (await pool.query(`SELECT to_jsonb(universities)->>'nil_marketplace_name' AS name, to_jsonb(universities)->>'nil_marketplace_url' AS url
                                 FROM universities WHERE id = $1`, [universityId])).rows[0] || {};
  return r.url ? { name: r.name || null, url: r.url } : null;
}
async function setMarketplace(pool, universityId, { name, url }) {
  const n = clean(name, 60);
  let u = clean(url, 500);
  if (!u) {
    await pool.query(`UPDATE universities SET nil_marketplace_name = NULL, nil_marketplace_url = NULL WHERE id = $1`, [universityId]);
    return { ok: true, marketplace: null };
  }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  let parsed;
  try { parsed = new URL(u); } catch (_) { return { ok: false, error: 'That link does not look right.' }; }
  if (parsed.protocol !== 'https:' || !/\./.test(parsed.hostname)) return { ok: false, error: 'Use the https link to your marketplace page.' };
  await pool.query(`UPDATE universities SET nil_marketplace_name = $1, nil_marketplace_url = $2 WHERE id = $3`, [n || null, parsed.href, universityId]);
  return { ok: true, marketplace: { name: n || null, url: parsed.href } };
}

// The deal, written the way a marketplace and NIL Go ask for it: who pays,
// who does the work, what they do, for how much, and when. The office pastes
// it in instead of typing it. Plain text; no athlete is named here, the office
// adds the players who said yes.
function summary(b, school) {
  return [
    `NIL deal request: ${school || 'our athletes'}`,
    `Business (pays the athletes): ${b.business}`,
    `Contact: ${[b.contact, b.email, b.phone].filter(Boolean).join(', ') || 'none given'}`,
    `Team: ${b.team || 'not chosen'}`,
    `What the athletes do: ${b.deal || 'to be agreed (the business asked for options)'}`,
    `Total paid to the athletes: ${b.cents ? money(b.cents) : 'to be agreed'}`,
    `When: ${b.dates || 'to be agreed'}`,
    b.note ? `Note from the business: ${b.note}` : null,
    `Booked: ${new Date(b.at).toISOString().slice(0, 10)} through the NILDash booking page`,
    `Athletes: the players who opt in (added by the NIL office)`,
  ].filter(Boolean).join('\n');
}

// Every deal and every booking, one row each, for Teamworks, a spreadsheet or
// the AD's report. CSV, Excel-safe (a cell starting = + - @ is quoted with a
// leading apostrophe so it never runs as a formula).
async function exportRows(pool, universityId) {
  const deals = (await pool.query(
    `SELECT d.signed_on, d.created_at, d.brand, t.name AS team, d.athlete_name, d.value_cents, d.description
       FROM university_deals d LEFT JOIN university_teams t ON t.id = d.team_id
      WHERE d.university_id = $1 ORDER BY COALESCE(d.signed_on, d.created_at::date) DESC`, [universityId]).catch(() => ({ rows: [] }))).rows
    .map((d) => ({ date: String(d.signed_on ? new Date(d.signed_on).toISOString() : new Date(d.created_at).toISOString()).slice(0, 10), kind: 'Deal done', business: d.brand,
      team: d.team || '', athlete: d.athlete_name || '', amount: d.value_cents == null ? '' : (d.value_cents / 100).toFixed(2), what: d.description || '', when: '', contact: '' }));
  const bookings = (await list(pool, universityId)).map((b) => ({ date: new Date(b.at).toISOString().slice(0, 10), kind: 'Booked from link', business: b.business,
    team: b.team || '', athlete: '', amount: b.cents ? (b.cents / 100).toFixed(2) : '', what: b.deal || 'Asked for options', when: b.dates || '',
    contact: [b.contact, b.email, b.phone].filter(Boolean).join(', ') }));
  return deals.concat(bookings).sort((a, z) => z.date.localeCompare(a.date));
}
function toCsv(rows) {
  const head = ['Date', 'Type', 'Business', 'Team', 'Athlete', 'Amount (USD)', 'What the athletes do', 'When', 'Contact'];
  const keys = ['date', 'kind', 'business', 'team', 'athlete', 'amount', 'what', 'when', 'contact'];
  const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [head.join(',')].concat(rows.map((r) => keys.map((k) => cell(r[k])).join(','))).join('\r\n') + '\r\n';
}

// Five bookings from one address in ten minutes is plenty for a person.
const HITS = new Map();
function allow(ip, now = Date.now()) {
  const k = String(ip || '?');
  const recent = (HITS.get(k) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 5) { HITS.set(k, recent); return false; }
  recent.push(now); HITS.set(k, recent);
  if (HITS.size > 5000) HITS.clear();
  return true;
}

module.exports = { ensureTables, page, book, list, setStatus, bookUrl, slugOf, idOf, allow, money, marketplace, setMarketplace, summary, exportRows, toCsv };
