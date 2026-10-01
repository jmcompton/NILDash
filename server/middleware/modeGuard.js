// server/middleware/modeGuard.js
// Mode isolation enforcement for University Mode and Agent Mode.
//
// ARCHITECTURE RULE:
//   University services must NEVER be reachable by agent/athlete roles.
//   Agent services must NEVER be reachable by university roles.
//   Admin is the only role that can traverse both (for administration only).
//
// These are server-side guards — the frontend switcher is UI only.
// Security lives here, not in the browser.

'use strict';

const { FEATURE_UNIVERSITY_MODE } = require('../config/features');

// ── Role sets ─────────────────────────────────────────────────────
const UNIVERSITY_ROLES = new Set(['university', 'university_admin', 'admin']);
// The roles the wall below confines. Admin is NOT here: it traverses both.
const UNIVERSITY_ONLY_ROLES = new Set(['university', 'university_admin']);

// ── requireUniversityMode ─────────────────────────────────────────
// Gate for all /api/university/* routes.
// Requires authenticated session + university/admin role.
// Falls back to DB lookup when session.role is missing (handles sessions
// that predate role storage — e.g. existing admin sessions).
async function requireUniversityMode(req, res, next) {
  // Feature flag gate first
  if (!FEATURE_UNIVERSITY_MODE) {
    return res.status(503).json({
      error: 'University Mode is not enabled on this instance.',
      code:  'UNIVERSITY_MODE_DISABLED',
    });
  }

  // Session check
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  // Role resolution — session first, DB fallback for legacy sessions
  let role = req.session.role;
  if (!role) {
    try {
      const store = require('../store');
      const user  = await store.getUser(req.session.userId);
      if (user) {
        role = user.role;
        req.session.role = role; // persist for subsequent requests
      }
    } catch (e) {
      console.warn('[modeGuard] DB role fallback failed:', e.message);
    }
  }

  if (!UNIVERSITY_ROLES.has(role)) {
    return res.status(403).json({
      error: 'University Mode access only.',
      code:  'UNIVERSITY_ROLE_REQUIRED',
      your_role: role,
    });
  }

  next();
}

// ── THE WALL: a university session reaches nothing on the agent side ─────
//
// Mounted ONCE, on /api, right after the session middleware (server/index.js),
// so it runs before every API route there is -- including every route added
// later. It replaces requireAgentMode, which was exported and applied to no
// route at all, so the agent/university separation this file describes did
// not exist: ~250 agent routes are gated by requireAuth alone, and a
// university-role session could reach them and write into agent tables (the
// bleed migrations/007 exists to undo).
//
// A session whose role is 'university' or 'university_admin' may call ONLY
// the method + path pairs below. Everything else is 403. Agent, athlete and
// admin sessions pass untouched (admin traverses both sides by design), and
// so does a request with no session: the routes' own auth answers those.
//
// THE ALLOWLIST IS EXACTLY WHAT public/university.html FETCHES:
//   GET  /api/university/teams      My Teams
//   GET  /api/university/inventory  Inventory
//   POST /api/auth/login            its sign-in form (a signed-in university
//                                   user can still switch accounts)
//   POST /api/auth/logout           its Sign out link
// A new university screen that needs a new endpoint adds it here, on purpose.
//
// FAILS CLOSED. The role comes from the session and, for a session that
// predates role storage, from the user's row. If that lookup errors, the
// request is refused (503) rather than guessed at; a signed-in session whose
// user row has gone is refused too.
const UNIVERSITY_ALLOWED = new Set([
  'GET /api/university/teams',
  'GET /api/university/inventory',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  // A staff member's own mailbox, so a pitch goes out signed from it. Connect,
  // the provider's return, and the list of their own accounts; nothing that
  // reads an inbox.
  'GET /api/email/oauth/gmail',
  'GET /api/email/oauth/gmail/callback',
  'GET /api/email/oauth/outlook',
  'GET /api/email/oauth/outlook/callback',
  'GET /api/email/accounts',
]);

// The department's own market tool (routes/campus.js): search, CRM, deals,
// pitches. Every route under it scopes to the session's own university.
// Matched on a whole path segment, so "/api/university/marketplace" is not in.
const UNIVERSITY_ALLOWED_PREFIXES = [
  ['GET', '/api/university/market/'],
  ['POST', '/api/university/market/'],
];
function allowedForUniversity(key) {
  if (UNIVERSITY_ALLOWED.has(key)) return true;
  const sp = key.indexOf(' ');
  const m = key.slice(0, sp), p = key.slice(sp + 1);
  if (p.includes('..')) return false;
  return UNIVERSITY_ALLOWED_PREFIXES.some(([pm, pre]) => pm === m && p.startsWith(pre) && p.length > pre.length);
}

// "/API/University/Teams/" and "/api/university/teams" are the same route to
// Express (routing is case-insensitive and ignores one trailing slash), so they
// are the same key here. The query string is not part of it.
function wallKey(req) {
  const p = String(req.originalUrl || req.url || '').split('?')[0].split('#')[0]
    .toLowerCase().replace(/\/+$/, '') || '/';
  const m = String(req.method || 'GET').toUpperCase();
  return (m === 'HEAD' ? 'GET' : m) + ' ' + p;
}

async function universityWall(req, res, next) {
  try {
    if (!req.session || !req.session.userId) return next();
    let role = req.session.role;
    if (!role) {
      let user;
      try { user = await require('../store').getUser(req.session.userId); }
      catch (e) {
        console.error('[universityWall] role lookup failed, refusing:', e.message);
        return res.status(503).json({ error: 'Could not confirm your account. Try again.', code: 'ROLE_UNKNOWN' });
      }
      if (!user) return res.status(401).json({ error: 'Not authenticated' });
      role = user.role;
      req.session.role = role;
    }
    if (!UNIVERSITY_ONLY_ROLES.has(role)) return next();
    if (allowedForUniversity(wallKey(req))) return next();
    return res.status(403).json({
      error: 'A university account cannot use this.',
      code: 'UNIVERSITY_ROLE_BLOCKED',
    });
  } catch (e) {
    console.error('[universityWall] refusing after an error:', e.message);
    return res.status(503).json({ error: 'Could not confirm your account. Try again.', code: 'ROLE_UNKNOWN' });
  }
}

// ── assertUniversityMode ──────────────────────────────────────────
// Runtime assertion for use INSIDE service files.
// Call at the top of any university service function.
// Throws — not an HTTP handler. Caller (route) catches and converts.
function assertUniversityMode(userRole) {
  if (!FEATURE_UNIVERSITY_MODE) {
    throw new Error('[ModeGuard] University Mode feature is disabled.');
  }
  if (!UNIVERSITY_ROLES.has(userRole)) {
    throw new Error(`[ModeGuard] University Mode access denied for role: ${userRole}`);
  }
}

module.exports = { requireUniversityMode, universityWall, assertUniversityMode, UNIVERSITY_ALLOWED, UNIVERSITY_ALLOWED_PREFIXES, allowedForUniversity, UNIVERSITY_ONLY_ROLES, wallKey };
