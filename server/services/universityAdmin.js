'use strict';
// ── PROVISIONING A UNIVERSITY AND ITS PEOPLE ────────────────────────────────
//
// The /university portal resolves its university off the LOGGED-IN USER:
// users.university_id (routes/campus.js `staff`). The university_users table
// is legacy and empty; nothing here writes it.
//
// createUniversity: the universities row, the campus street address as its
// location (the campus pool, teamScan.discover, centres on that address), and
// the campus geocoded once and stored (lat / lng) so the centre is a fact on
// the row, not re-derived every build. An existing university (by id or by
// name) is UPDATED, so a city-only location like Samford's "Birmingham, AL"
// can be corrected to the campus address.
//
// createUniversityUser: modelled on create-comped-agent. A users row with
// role 'university', the university, comped (full free access: no card, no
// Stripe), a random password nobody knows, and a set-password link issued
// through services/passwordReset. The link is RETURNED, never emailed.

const crypto = require('crypto');

const lc = (s) => String(s || '').trim().toLowerCase();
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 200);
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const STATE = /^[A-Za-z]{2}$/;

async function ensureColumns(pool) {
  for (const c of ['city TEXT', 'state TEXT', 'street TEXT', 'lat DOUBLE PRECISION', 'lng DOUBLE PRECISION', 'geocoded_at TIMESTAMPTZ', 'geocode_error TEXT']) {
    await pool.query(`ALTER TABLE universities ADD COLUMN IF NOT EXISTS ${c}`).catch(() => {});
  }
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS university_id TEXT`).catch(() => {});
  await pool.query(`CREATE TABLE IF NOT EXISTS university_staff (user_id TEXT PRIMARY KEY, university_id TEXT, title TEXT, default_sender BOOLEAN DEFAULT FALSE)`).catch(() => {});
}

// The campus, geocoded: Places Text Search on the street address (the same
// call the campus pool makes). deps.geocode for tests.
async function geocode(address, deps = {}) {
  if (deps.geocode) return deps.geocode(address);
  const key = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
  if (!key) return { coords: null, calls: 0, error: 'GOOGLE_PLACES_API_KEY is not set' };
  return require('./placesMarket').geocodeSchool(address, key);
}

async function createUniversity(pool, body = {}, deps = {}) {
  await ensureColumns(pool);
  const name = clean(body.name, 120);
  const shortName = clean(body.shortName || body.short_name, 40) || null;
  const city = clean(body.city, 80);
  const state = clean(body.state, 2).toUpperCase();
  const street = clean(body.street || body.address, 160);
  if (!name) return { ok: false, error: 'A university name is required.' };
  if (!city) return { ok: false, error: 'The city is required.' };
  if (!STATE.test(state)) return { ok: false, error: 'The state is the two-letter code (CA, AL).' };
  if (!street || !/\d/.test(street)) return { ok: false, error: 'The campus street address is required (with its number), so the local lane has a real centre.' };
  const location = `${street}, ${city}, ${state}`;
  const existing = (await pool.query(`SELECT id FROM universities WHERE id = $1 OR LOWER(name) = LOWER($2) LIMIT 1`,
    [clean(body.id, 60) || 'univ-' + slug(shortName || name), name])).rows[0];
  const id = existing ? existing.id : (clean(body.id, 60) || 'univ-' + slug(shortName || name));
  if (existing) {
    await pool.query(`UPDATE universities SET name = $2, short_name = COALESCE($3, short_name), location = $4, city = $5, state = $6, street = $7, updated_at = NOW() WHERE id = $1`,
      [id, name, shortName, location, city, state, street]);
  } else {
    await pool.query(`INSERT INTO universities (id, name, short_name, location, city, state, street) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, name, shortName, location, city, state, street]);
  }
  const g = await geocode(location, deps).catch((e) => ({ coords: null, error: e.message }));
  if (g && g.coords) {
    await pool.query(`UPDATE universities SET lat = $2, lng = $3, geocoded_at = NOW(), geocode_error = NULL WHERE id = $1`, [id, g.coords.lat, g.coords.lng]);
  } else {
    await pool.query(`UPDATE universities SET geocode_error = $2 WHERE id = $1`, [id, String((g && g.error) || 'no result').slice(0, 300)]);
  }
  return { ok: true, id, created: !existing, updated: !!existing, name, shortName, location,
    center: g && g.coords ? g.coords : null, geocodeError: g && g.coords ? null : ((g && g.error) || 'no result') };
}

// ── THE PERSON ──────────────────────────────────────────────────────────────
async function createUniversityUser(pool, body = {}, deps = {}) {
  await ensureColumns(pool);
  const email = lc(body.email);
  const name = clean(body.name, 120);
  const title = clean(body.title, 120) || null;
  const universityId = clean(body.universityId || body.university_id || body.university, 60);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'A valid email is required.' };
  if (!name) return { ok: false, error: 'A name is required.' };
  const uni = (await pool.query(`SELECT id, name FROM universities WHERE id = $1 OR LOWER(name) = LOWER($1) LIMIT 1`, [universityId])).rows[0];
  if (!uni) return { ok: false, error: `No university "${universityId}". Create it first.` };
  const existing = (await pool.query(`SELECT id, role, university_id FROM users WHERE LOWER(email) = $1`, [email])).rows[0];
  let userId, created = false;
  if (existing) {
    // The same person on the same university: a fresh link, nothing else
    // changes. Anyone else (an agent, another university): refused, never
    // silently converted.
    if (!['university', 'university_admin'].includes(existing.role) || existing.university_id !== uni.id) {
      return { ok: false, error: `${email} already has a NILDash account (${existing.role}${existing.university_id ? ', ' + existing.university_id : ''}); it was not changed.` };
    }
    userId = existing.id;
    await pool.query(`UPDATE users SET name = $2, comped = TRUE, password_reset_required = TRUE WHERE id = $1`, [userId, name]);
  } else {
    const bcrypt = deps.bcrypt || require('bcryptjs');
    const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
    userId = 'user-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
    await pool.query(
      `INSERT INTO users (id, name, email, password, role, university_id, comped, password_reset_required, plan_tier, created_at)
       VALUES ($1,$2,$3,$4,'university',$5,TRUE,TRUE,'unlimited',NOW())`, [userId, name, email, hash, uni.id]);
    created = true;
  }
  await pool.query(`INSERT INTO university_staff (user_id, university_id, title) VALUES ($1,$2,$3)
                    ON CONFLICT (user_id) DO UPDATE SET university_id = EXCLUDED.university_id, title = COALESCE(EXCLUDED.title, university_staff.title)`,
  [userId, uni.id, title]).catch(() => {});
  const PR = require('./passwordReset');
  const { token } = await PR.issueResetToken(pool, { email, ttlMs: PR.ONBOARDING_TTL_MS });
  const resetUrl = PR.resetUrl(process.env.APP_URL, token);
  console.log(`[university-user] ${created ? 'created' : 'new link for'} ${email} at ${uni.id} (not emailed)`);
  return { ok: true, created, userId, name, email, title, universityId: uni.id, university: uni.name, resetUrl, emailed: false,
    expiresInDays: Math.round(PR.ONBOARDING_TTL_MS / 86400000) };
}

module.exports = { createUniversity, createUniversityUser, ensureColumns, geocode, slug };
