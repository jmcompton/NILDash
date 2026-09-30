'use strict';
// ── INSTAGRAM CONNECT: THE ROUTES (services/instagramConnect) ───────────────
//
// Athlete-facing, no login:
//   GET  /athlete/connect/:token        the page: who, for which agent, one button
//   GET  /api/instagram/start/:token    -> instagram.com/oauth/authorize
//   GET  /api/instagram/callback        Meta's redirect back (code + state)
// Meta's callbacks (configure in the Meta dashboard):
//   POST /api/instagram/deauthorize     signed_request; the athlete removed the app
//   POST /api/instagram/data-deletion   signed_request; delete what we fetched
//   GET  /api/instagram/deletion-status?code=   what Meta shows the user
// Agent-facing (signed in, owner of the athlete):
//   POST /api/agents/athletes/:id/instagram-invite    a new link to send
//   GET  /api/agents/instagram/status                 status for the whole roster
//   POST /api/agents/athletes/:id/instagram-sync      re-fetch now
const express = require('express');
const IG = require('../services/instagramConnect');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// One small, mobile-first page shell. No scripts, no tracking, no login.
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>
:root{--bg:#0b0b0c;--card:#151517;--text:#f2f0ea;--muted:#a3a09a;--accent:#84CC16;--border:#26262a}
@media (prefers-color-scheme: light){:root{--bg:#f6f5f1;--card:#fff;--text:#161616;--muted:#5f5d58;--border:#e4e2dc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
.card{width:100%;max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 22px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 14px;color:var(--muted)}.who{color:var(--text);font-weight:600}
.btn{display:block;width:100%;padding:16px;border-radius:12px;border:0;font-size:17px;font-weight:700;text-decoration:none;
  background:linear-gradient(45deg,#f09433,#dc2743,#bc1888);color:#fff;margin-top:8px}
.small{font-size:13px}.ok{color:var(--accent)}
</style></head><body><main class="card">${body}</main></body></html>`;
}

function mount(app, { store, requireAuth }) {
  const pool = store.pool;
  const form = express.urlencoded({ extended: false, limit: '8kb' });

  // ── The athlete's page ────────────────────────────────────────────────────
  app.get('/athlete/connect/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const inv = await IG.readInvite(pool, req.params.token);
      if (!inv.ok) return res.status(inv.reason === 'invalid' ? 404 : 410).send(page('Link not valid', `<h1>This link can't be used</h1><p>${esc(IG.inviteMessage(inv.reason))}</p>`));
      const agent = inv.agentName ? esc(inv.agentName) : 'your agent';
      res.send(page('Connect Instagram', `
        <h1>Hi ${esc(firstName(inv.athleteName))}</h1>
        <p><span class="who">${agent}</span> would like to see your Instagram numbers.</p>
        <p class="small">Sharing your follower count and your recent posts' likes and comments, read-only. Nothing is ever posted.</p>
        <a class="btn" href="/api/instagram/start/${encodeURIComponent(req.params.token)}">Connect Instagram</a>
        <p class="small" style="margin-top:16px">You can remove access at any time in Instagram: Settings, Apps and websites.</p>`));
    } catch (e) {
      console.error('[instagram/connect page]', e.message);
      res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Please try your link again in a minute.</p>'));
    }
  });

  app.get('/api/instagram/start/:token', async (req, res) => {
    const inv = await IG.readInvite(pool, req.params.token).catch(() => ({ ok: false, reason: 'invalid' }));
    if (!inv.ok) return res.status(410).send(page('Link not valid', `<h1>This link can't be used</h1><p>${esc(IG.inviteMessage(inv.reason))}</p>`));
    if (!IG.configured()) {
      require('../services/ourFault').record('instagram', 'INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET not set; an athlete tried to connect', 'instagram start').catch(() => {});
      return res.status(503).send(page('Not available', '<h1>Not available right now</h1><p>Instagram connection is being set up. Please try your link again later.</p>'));
    }
    res.redirect(IG.authorizeUrl(req.params.token));
  });

  app.get('/api/instagram/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const r = await IG.handleCallback(pool, { code: req.query.code, state: req.query.state, error: req.query.error, errorReason: req.query.error_reason });
      if (!r.ok) return res.status(r.reason === 'declined' ? 200 : 400).send(page('Not connected', `<h1>Not connected</h1><p>${esc(r.message)}</p>`));
      const agent = r.agentName ? esc(firstName(r.agentName)) : 'Your agent';
      res.send(page('Connected', `<h1 class="ok">Connected</h1>
        <p>${r.username ? '@' + esc(r.username) + ' is' : 'Your Instagram is'} now connected. ${agent} will see your numbers from here on.</p>
        <p class="small">You can close this page.</p>`));
    } catch (e) {
      console.error('[instagram/callback]', e.message);
      require('../services/ourFault').record('instagram', 'callback threw: ' + e.message, 'instagram callback').catch(() => {});
      res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Nothing was shared. Please try your link again.</p>'));
    }
  });

  // ── Meta's callbacks ──────────────────────────────────────────────────────
  app.post('/api/instagram/deauthorize', form, async (req, res) => {
    const data = IG.parseSignedRequest(req.body && req.body.signed_request);
    if (!data || !data.user_id) return res.status(400).json({ error: 'invalid signed_request' });
    try {
      const r = await IG.deauthorize(pool, data.user_id);
      console.log(`[instagram] deauthorized ig_user=${data.user_id} athletes=${r.athleteIds.join(',') || 'none'}`);
      res.json({ ok: true });
    } catch (e) { console.error('[instagram/deauthorize]', e.message); res.status(500).json({ error: 'failed' }); }
  });

  app.post('/api/instagram/data-deletion', form, async (req, res) => {
    const data = IG.parseSignedRequest(req.body && req.body.signed_request);
    if (!data || !data.user_id) return res.status(400).json({ error: 'invalid signed_request' });
    try {
      const r = await IG.deleteData(pool, data.user_id);
      console.log(`[instagram] data deletion ig_user=${data.user_id} code=${r.code} athletes=${r.athleteIds.join(',') || 'none'}`);
      res.json({ url: r.url, confirmation_code: r.code });
    } catch (e) { console.error('[instagram/data-deletion]', e.message); res.status(500).json({ error: 'failed' }); }
  });

  app.get('/api/instagram/deletion-status', async (req, res) => {
    await IG.ensureTables(pool).catch(() => {});
    const r = await pool.query(`SELECT confirmation_code, status, requested_at, completed_at FROM instagram_deletion_requests WHERE confirmation_code = $1`,
      [String(req.query.code || '')]).catch(() => ({ rows: [] }));
    const d = r.rows[0];
    if (!d) return res.status(404).send(page('Not found', '<h1>Request not found</h1><p>Check the confirmation code and try again.</p>'));
    res.send(page('Data deletion', `<h1>Data deletion</h1><p>Confirmation code <span class="who">${esc(d.confirmation_code)}</span></p>
      <p>${d.status === 'completed' ? `Completed ${esc(new Date(d.completed_at).toISOString().slice(0, 10))}. All Instagram data NILDash held for this account has been deleted.` : 'Received and being processed.'}</p>`));
  });

  // ── The agent ─────────────────────────────────────────────────────────────
  const ownAthlete = async (req, res) => {
    const a = await store.getAthlete(req.params.id);
    if (!a) { res.status(404).json({ error: 'Athlete not found' }); return null; }
    if (String(a.agentId) !== String(req.session.userId)) { res.status(403).json({ error: 'Forbidden' }); return null; }
    return a;
  };

  app.post('/api/agents/athletes/:id/instagram-invite', requireAuth, async (req, res) => {
    try {
      const a = await ownAthlete(req, res); if (!a) return;
      const inv = await IG.createInvite(pool, { athleteId: a.id, agentId: req.session.userId });
      const user = await store.getUser(req.session.userId).catch(() => null);
      const text = `Hi ${firstName(a.name)}, it's ${firstName(user && user.name) || 'your agent'}. Tap this to connect your Instagram so I can use your real numbers with brands (read-only, takes 10 seconds): ${inv.url}`;
      const phone = String(a.phone || '').replace(/[^\d+]/g, '');
      res.json({ ok: true, url: inv.url, expiresAt: inv.expiresAt, text, sms: `sms:${phone}?&body=${encodeURIComponent(text)}` });
    } catch (e) { console.error('[instagram-invite]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agents/instagram/status', requireAuth, async (req, res) => {
    try { res.json({ configured: IG.configured(), athletes: await IG.statusForAgent(pool, req.session.userId) }); }
    catch (e) { console.error('[instagram/status]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/athletes/:id/instagram-sync', requireAuth, async (req, res) => {
    try {
      const a = await ownAthlete(req, res); if (!a) return;
      const r = await IG.syncAthlete(pool, a.id);
      res.status(r.ok ? 200 : 409).json(r);
    } catch (e) { console.error('[instagram-sync]', e.message); res.status(500).json({ error: e.message }); }
  });
}

module.exports = { mount, page };
