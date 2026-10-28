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
//   POST /api/agents/athletes/:id/instagram-disconnect  erase the token, delete what was fetched
const express = require('express');
const IG = require('../services/instagramConnect');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';

// One small, mobile-first page shell. No tracking, no login; the only script is the screenshot upload.
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
.steps{text-align:left;margin:0 0 16px;padding:12px 14px;border:1px solid var(--border);border-radius:12px;font-size:14px;color:var(--text)}
.steps ol{margin:6px 0 0 18px;padding:0}.steps li{margin:3px 0}
.nums{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:14px 0;text-align:left}
.num{border:1px solid var(--border);border-radius:12px;padding:12px}.num b{display:block;font-size:24px;color:var(--text)}.num span{font-size:12px;color:var(--muted)}
.list{text-align:left;font-size:14px;border:1px solid var(--border);border-radius:12px;padding:10px 14px;margin-bottom:10px}.list div{display:flex;justify-content:space-between;padding:2px 0}
.alt{margin-top:22px;padding-top:16px;border-top:1px solid var(--border)}
.btn2{display:block;width:100%;padding:13px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:15px;font-weight:600;margin-top:8px}
</style></head><body><main class="card">${body}</main></body></html>`;
}

// The upload form under the Connect button: up to 3 screenshots, read in the
// browser as data URLs and posted as JSON. No tracking, one small script.
function screenshotForm(token) {
  const t = encodeURIComponent(token);
  return `<div class="alt"><p class="small"><b>Can't connect?</b> Upload screenshots of your Instagram Insights instead (the overview and the audience screen, up to 3).</p>
    <input id="shots" type="file" accept="image/png,image/jpeg,image/webp" multiple style="width:100%;margin:6px 0;color:var(--muted)">
    <button class="btn2" id="shotBtn" type="button">Send screenshots</button><p class="small" id="shotMsg" style="margin-top:8px"></p><div id="shotOut"></div></div>
    <script>(function(){var b=document.getElementById('shotBtn'),m=document.getElementById('shotMsg');b.onclick=async function(){
      var f=[].slice.call(document.getElementById('shots').files||[]).slice(0,3);if(!f.length){m.textContent='Choose one to three screenshots first.';return;}
      b.disabled=true;m.textContent='Reading your screenshots...';
      var imgs=await Promise.all(f.map(function(x){return new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok(r.result)};r.onerror=no;r.readAsDataURL(x);});}));
      try{var r=await fetch('/api/instagram/screenshot/${t}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({images:imgs})});var j=await r.json();
        if(!r.ok){m.textContent=j.error||'That did not work. Try again.';b.disabled=false;return;}
        m.textContent='Got it. Your agent can see these numbers now.';document.getElementById('shotOut').innerHTML=j.html||'';}
      catch(e){m.textContent='That did not work. Try again.';b.disabled=false;}};})();</script>`;
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
        <p class="small">Read-only: your followers, reach and views, where your followers are, and how your recent posts did. Nothing is ever posted.</p>
        <div class="steps"><b>This needs a Creator or Business account.</b> Switching is free and takes 30 seconds:
          <ol><li>Open Instagram and go to Settings</li><li>Tap Account type and tools</li><li>Tap Switch to professional account</li></ol></div>
        <a class="btn" href="/api/instagram/start/${encodeURIComponent(req.params.token)}">Connect Instagram</a>
        <p class="small" style="margin-top:16px">You can remove access at any time in Instagram: Settings, Apps and websites.</p>
        ${screenshotForm(req.params.token)}`));
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
      const nums = await yourNumbers(r.athleteId).catch(() => '');
      res.send(page('Connected', `<h1 class="ok">Connected</h1>
        <p>${r.username ? '@' + esc(r.username) + ' is' : 'Your Instagram is'} now connected. ${agent} will see your numbers from here on.</p>
        ${nums}
        <p class="small">Screenshot this page if you want to share it. You can close it when you are done.</p>`));
    } catch (e) {
      console.error('[instagram/callback]', e.message);
      require('../services/ourFault').record('instagram', 'callback threw: ' + e.message, 'instagram callback').catch(() => {});
      res.status(500).send(page('Something went wrong', '<h1>Something went wrong</h1><p>Nothing was shared. Please try your link again.</p>'));
    }
  });

  // ── THE ATHLETE'S OWN NUMBERS, after connecting (or a screenshot) ─────────
  // Only what Instagram gave: a missing number is left out, never shown as 0.
  async function yourNumbers(athleteId) {
    if (!athleteId) return '';
    const row = (await pool.query(`SELECT * FROM instagram_stats WHERE athlete_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [athleteId])).rows[0];
    if (!row) return '';
    const d = require('../services/instagramInsights').derive(row, {});
    const n = (x) => Number(x).toLocaleString('en-US');
    const tiles = [];
    if (d.followers !== null) tiles.push(['Followers', n(d.followers)]);
    if (d.reach30 !== null) tiles.push(['Reached, last 30 days', n(d.reach30)]);
    if (d.avgReachPerPost !== null) tiles.push(['Avg reach per post', n(Math.round(d.avgReachPerPost))]);
    if (d.engagementByFollowers !== null) tiles.push(['Engagement', (Math.round(d.engagementByFollowers * 1000) / 10) + '%']);
    const list = (title, rows) => (rows && rows.length ? `<div class="list"><b>${esc(title)}</b>${rows.slice(0, 5).map((r) => `<div><span>${esc(r.key)}</span><span>${r.share === null ? '' : Math.round(r.share * 1000) / 10 + '%'}</span></div>`).join('')}</div>` : '');
    const src = row.source === 'screenshot' ? 'Read from your screenshots' : 'From Instagram';
    return (tiles.length ? `<div class="nums">${tiles.map(([k, v]) => `<div class="num"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')}</div>` : '')
      + list('Where your followers are', d.topCities) + list('Age', d.ageBands) + list('Gender', d.gender)
      + `<p class="small">${src}, ${esc(new Date(row.fetched_at).toISOString().slice(0, 10))}</p>`;
  }

  // ── "CAN'T CONNECT? UPLOAD A SCREENSHOT OF YOUR INSIGHTS" ─────────────────
  // services/instagramScreenshot: up to 3 images, read by a vision model,
  // stored as source 'screenshot' (shown as "From the athlete's screenshot").
  app.post('/api/instagram/screenshot/:token', express.json({ limit: '20mb' }), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const inv = await IG.readInvite(pool, req.params.token);
      if (!inv.ok) return res.status(410).json({ error: IG.inviteMessage(inv.reason) });
      const r = await require('../services/instagramScreenshot').readAndStore(pool, inv.athleteId, (req.body && req.body.images) || []);
      if (!r.ok) return res.status(422).json({ error: r.error });
      res.json({ ok: true, html: await yourNumbers(inv.athleteId) });
    } catch (e) {
      console.error('[instagram/screenshot]', e.message);
      res.status(500).json({ error: 'Something went wrong reading the screenshots. Please try again.' });
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

  // ── GET on both callback URLs ─────────────────────────────────────────────
  // Meta validates these URLs with a GET before the dashboard will save them,
  // and a person following the data-deletion link lands here too. The signed
  // POSTs above are unchanged.
  app.get('/api/instagram/deauthorize', (req, res) => {
    res.send(page('Instagram access removed', `<h1>Instagram access</h1>
      <p>This address is where Instagram tells NILDash that someone has removed its access.</p>
      <p class="small">When that happens we disconnect the account and delete its access token. Nothing needs to be done here.</p>`));
  });

  app.get('/api/instagram/data-deletion', (req, res) => {
    res.send(page('Delete your Instagram data', `<h1>Delete your Instagram data</h1>
      <p>NILDash stores your Instagram username and profile details, follower and following counts, post count, your account's reach, views and interactions, where your followers are (city, country, age and gender, as Instagram reports them), and how your recent posts did, only if you connected your account or sent us screenshots of your Insights.</p>
      <p class="small" style="text-align:left"><b>To delete it:</b> in Instagram, go to Settings, then Apps and websites, find NILDash and remove it, then choose to send a data deletion request. We delete everything we fetched from your account and give you a confirmation code. You can also email <a href="mailto:contact@mynildash.com" style="color:inherit">contact@mynildash.com</a> and we will delete it for you.</p>
      <p class="small" style="text-align:left"><b>To check a request:</b> enter the confirmation code you were given.</p>
      <form method="get" action="/api/instagram/deletion-status" style="display:flex;gap:8px;margin-top:6px">
        <input name="code" placeholder="Confirmation code" required style="flex:1;min-width:0;padding:12px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--text);font-size:15px">
        <button type="submit" style="padding:12px 16px;border-radius:10px;border:0;background:var(--accent);color:#0b0b0c;font-weight:700;font-size:15px">Check</button>
      </form>
      ${(() => { const a = require('../services/canSpam').mailingAddress(); return a ? `<p class="small" style="margin-top:16px">${esc(a)}</p>` : ''; })()}`));
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
      const text = `Hey ${firstName(a.name)}, tap this so businesses see your real Instagram numbers. Takes 30 seconds: ${inv.url}`;
      const phone = String(a.phone || '').replace(/[^\d+]/g, '');
      res.json({ ok: true, url: inv.url, expiresAt: inv.expiresAt, text, sms: `sms:${phone}?&body=${encodeURIComponent(text)}` });
    } catch (e) { console.error('[instagram-invite]', e.message); res.status(500).json({ error: e.message }); }
  });

  app.get('/api/agents/instagram/status', requireAuth, async (req, res) => {
    try {
      const athletes = await IG.statusForAgent(pool, req.session.userId);
      const v = Object.values(athletes);
      res.json({ configured: IG.configured(), athletes,
        counts: { total: v.length, connected: v.filter((x) => x.display === 'connected').length, needsNewLink: v.filter((x) => x.display === 'needs_new_link').length,
          personal: v.filter((x) => x.display === 'personal_account').length, blocked: v.filter((x) => x.display === 'blocked').length } });
    }
    catch (e) { console.error('[instagram/status]', e.message); res.status(500).json({ error: e.message }); }
  });

  // DISCONNECT, from the athlete page: the token erased, the athlete's unused
  // links revoked, and everything fetched from Instagram deleted right away,
  // by the same path as Meta's data deletion callback (services/instagramConnect).
  app.post('/api/agents/athletes/:id/instagram-disconnect', requireAuth, async (req, res) => {
    try {
      const a = await ownAthlete(req, res); if (!a) return;
      const r = await IG.disconnect(pool, { athleteId: a.id, agentId: req.session.userId });
      if (!r.ok) return res.status(r.status || 400).json({ error: r.error });
      res.json(r);
    } catch (e) { console.error('[instagram-disconnect]', e.message); res.status(500).json({ error: e.message }); }
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
