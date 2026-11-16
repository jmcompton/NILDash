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
  const u = (await pool.query(`SELECT id, name, short_name, location FROM universities WHERE id = $1`, [id])).rows[0];
  if (!u) return null;
  const teams = (await pool.query(
    `SELECT t.id, t.name, t.sport, t.season,
            (to_jsonb(t)->>'nil_rate_cents')::int AS nil_rate_cents, to_jsonb(t)->>'nil_rate_what' AS nil_rate_what
       FROM university_teams t WHERE t.university_id = $1`, [id])).rows
    .sort((a, b) => (SEASON_ORDER[a.season] || 4) - (SEASON_ORDER[b.season] || 4) || a.name.localeCompare(b.name))
    .map((t) => ({ id: t.id, name: t.name, season: t.season || null,
      rate: t.nil_rate_cents > 0 ? { cents: t.nil_rate_cents, price: money(t.nil_rate_cents), what: t.nil_rate_what || '' } : null }));
  return { school: { name: u.name, short: u.short_name || u.name, location: u.location || null }, teams };
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

module.exports = { ensureTables, page, book, list, setStatus, bookUrl, slugOf, idOf, allow, money };
