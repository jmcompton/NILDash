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
const AGENT_ROLES      = new Set(['agent', 'admin']);

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

// ── requireAgentMode ──────────────────────────────────────────────
// Gate for agent-only endpoints.
// University roles explicitly blocked — they cannot reach agent tools
// even if they somehow obtain the URL.
function requireAgentMode(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const role = req.session.role;
  if (!AGENT_ROLES.has(role)) {
    return res.status(403).json({
      error: 'Agent Mode access only.',
      code:  'AGENT_ROLE_REQUIRED',
      your_role: role,
    });
  }

  next();
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

module.exports = { requireUniversityMode, requireAgentMode, assertUniversityMode };
