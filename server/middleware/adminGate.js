'use strict';
// ── ONE GATE IN FRONT OF EVERYTHING UNDER /admin AND /api/admin ─────────────
//
// Why it exists. Each admin route used to check for the admin itself, and
// some never did: /admin/state-rules answered GET, POST and DELETE to anyone
// with no session -- read, add and delete the compliance rules that keep
// alcohol and gambling away from athletes who are sometimes minors.
// /admin/cache-health and /admin/scan-rejects were open the same way, and the
// four /api/admin/referrals routes let any signed-in agent read the payouts and
// mark them paid.
//
// So the check is no longer each route's job. This is mounted once, straight
// after the session and before every route, on both prefixes: a route added
// under /admin or /api/admin tomorrow is gated whether or not its author
// remembered. The per-route checks stay where they are; several are stricter
// (ADMIN_EMAIL only) and that still applies after this.
//
// Who passes: the session user whose email is ADMIN_EMAIL, or a founder
// (FOUNDER_EMAILS) -- the same pair the existing admin pages accept. Not
// role='admin' and not a comped account: neither was ever enough for these.
//
// No session: 401. Signed in but not the admin: 403. A failed user lookup
// fails CLOSED (503), never open.
function makeAdminGate({ getUser, adminEmail, isFounderEmail }) {
  const isAdmin = (u) => !!u && !!u.email
    && (String(u.email).toLowerCase() === String(adminEmail || '').toLowerCase() || isFounderEmail(u.email));
  return async function adminGate(req, res, next) {
    const api = req.originalUrl.startsWith('/api/');
    const deny = (status, msg) => (api ? res.status(status).json({ error: msg }) : res.status(status).type('text').send(msg));
    // The admin working in a client's account (services/workAs): the session
    // user is the agent, so every admin route is closed to it like any agent.
    // Three paths are the exception, and are judged on who is really signed in
    // (session.adminId): the client list, opening another client, and going
    // back. Without this the admin could open a client and never get out
    // (Nov 2026: the first live open did exactly that).
    const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
    const real = req.session && req.session.adminId && WORK_AS_PATHS.includes(path);
    const uid = req.session && (real ? req.session.adminId : req.session.userId);
    if (!uid) return deny(401, 'Not authenticated');
    let user = null;
    try { user = await getUser(uid); }
    catch (e) {
      console.error('[admin-gate] user lookup failed, refusing:', e.message);
      return deny(503, 'Could not verify the admin; try again');
    }
    if (!isAdmin(user)) return deny(403, 'Forbidden');
    return next();
  };
}

// The prefixes it guards, and the static admin pages in public/ that
// express.static would otherwise hand to anyone (they are redirected to the
// gated routes that serve them).
const PREFIXES = ['/admin', '/api/admin'];
const WORK_AS_PATHS = ['/api/admin/clients', '/api/admin/work-as', '/api/admin/work-as/stop'];
const STATIC_PAGES = { '/admin.html': '/admin', '/admin-connections.html': '/admin/connections', '/admin-prospects.html': '/admin/prospects' };

module.exports = { makeAdminGate, PREFIXES, STATIC_PAGES, WORK_AS_PATHS };
