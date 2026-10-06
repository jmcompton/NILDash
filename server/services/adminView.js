'use strict';
// ── THE ADMIN LOOKS AT ANY UNIVERSITY'S PORTAL ──────────────────────────────
//
// Every /api/university/* route resolves its university off the signed-in
// user (users.university_id). The admin's own account is linked to one
// school, so any other school's portal was visible only by signing in as its
// staff. This adds a SESSION-ONLY choice, for the admin login alone:
//
//   POST /api/admin/view-university { universityId }   choose (null clears)
//
// Nothing is written to any account: not the admin's university_id, not the
// school's. While a choice is set, every /api/university/* request runs with
// that university (both resolvers ask override() first), and every request
// that is not a GET is REFUSED: the admin looks, and nothing is edited or
// sent as the school.

const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

// The university the admin is viewing, for this request, or null.
function override(userId) {
  const s = als.getStore();
  if (!s || !s.universityId) return null;
  if (userId != null && String(userId) !== String(s.userId)) return null;
  return s.universityId;
}

// Mounted on /api/university. adminEmail: the one login allowed to view.
function middleware({ pool, adminEmail }) {
  return async (req, res, next) => {
    const want = req.session && req.session.viewUniversityId;
    if (!want || !req.session.userId) return next();
    try {
      const u = (await pool.query(`SELECT id, email FROM users WHERE id = $1`, [req.session.userId])).rows[0];
      if (!u || String(u.email || '').toLowerCase() !== String(adminEmail || '').toLowerCase()) {
        delete req.session.viewUniversityId;      // never for anyone else
        return next();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({ error: 'Read-only: you are viewing this university as the admin. Nothing is changed or sent as the school.', code: 'ADMIN_VIEW_READ_ONLY' });
      }
      als.run({ userId: u.id, universityId: want }, () => next());
    } catch (e) { next(e); }
  };
}

async function set(pool, req, universityId) {
  if (!universityId) { delete req.session.viewUniversityId; return { ok: true, viewing: null }; }
  const u = (await pool.query(`SELECT id, name FROM universities WHERE id = $1`, [String(universityId)])).rows[0];
  if (!u) return { ok: false, error: `No university "${universityId}".` };
  req.session.viewUniversityId = u.id;
  return { ok: true, viewing: { id: u.id, name: u.name } };
}

module.exports = { override, middleware, set, als };
