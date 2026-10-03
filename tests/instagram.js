'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/instagram.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.INSTAGRAM_APP_ID = '1826629518692849';
process.env.INSTAGRAM_APP_SECRET = 'test-secret-abc';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── INSTAGRAM STATS VIA ATHLETE CONNECT ─────────────────────────────────────
// The agent sends a link; the athlete taps Connect and Allow; real numbers from
// then on. The real routes run in-process; only Instagram itself is stubbed.
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const store = require(REPO + 'server/store.js');
const IG = require(REPO + 'server/services/instagramConnect.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

// ── A fake Instagram ────────────────────────────────────────────────────────
const fake = { calls: [], followers: 24000, posts: null, meError: null, refreshError: null, exchangeError: null };
const realFetch = globalThis.fetch;
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (!/instagram\.com/.test(u)) return realFetch(url, init);
  fake.calls.push({ url: u, body: init && init.body ? String(init.body) : null });
  if (u.startsWith('https://api.instagram.com/oauth/access_token')) {
    if (fake.exchangeError) return json(400, { error_type: 'OAuthException', code: 400, error_message: fake.exchangeError });
    return json(200, { data: [{ access_token: 'SHORT-TOKEN', user_id: '17841400000000001', permissions: 'instagram_business_basic' }] });
  }
  if (u.startsWith('https://graph.instagram.com/access_token')) return json(200, { access_token: 'LONG-TOKEN-1', token_type: 'bearer', expires_in: 5184000 });
  if (u.startsWith('https://graph.instagram.com/refresh_access_token')) {
    if (fake.refreshError) return json(400, { error: { message: fake.refreshError, type: 'OAuthException', code: 190 } });
    return json(200, { access_token: 'LONG-TOKEN-2', token_type: 'bearer', expires_in: 5184000 });
  }
  if (u.startsWith('https://graph.instagram.com/me/media')) {
    return json(200, { data: fake.posts || Array.from({ length: 12 }, (_, i) => ({ id: 'm' + i, like_count: 500 + i * 10, comments_count: 20, timestamp: '2026-09-0' + ((i % 9) + 1) + 'T12:00:00+0000', media_type: 'IMAGE' })) });
  }
  if (u.startsWith('https://graph.instagram.com/me')) {
    if (fake.meError) return json(400, { error: { message: fake.meError, type: 'OAuthException', code: 190 } });
    return json(200, { user_id: '17841400000000001', username: 'ig.tester', followers_count: fake.followers, follows_count: 300, media_count: 88 });
  }
  return json(404, { error: 'unexpected ' + u });
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await IG.ensureTables(P);
  const AG = 'igt-agent', OTHER = 'igt-other', ATH = 'igt-ath', ATH2 = 'igt-ath2';
  const clean = async () => {
    for (const t of ['instagram_connect_tokens', 'instagram_connections', 'instagram_stats']) await P.query(`DELETE FROM ${t} WHERE athlete_id = ANY($1)`, [[ATH, ATH2]]);
    await P.query(`DELETE FROM instagram_deletion_requests WHERE ig_user_id = '17841400000000001'`);
    await P.query(`DELETE FROM athletes WHERE id = ANY($1)`, [[ATH, ATH2]]);
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [[AG, OTHER]]);
    await P.query(`DELETE FROM service_faults WHERE service LIKE 'instagram%' AND context LIKE '%igt-%'`);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Dana Agent','igt@x.test','x','agent'), ($2,'Other Agent','igt2@x.test','x','agent')`, [AG, OTHER]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,'{"name":"Maya Tester","sport":"Volleyball","instagram":0}'), ($3,$2,'{"name":"Jo Nobody"}')`, [ATH, AG, ATH2]);

  // The real routes, in-process, with a session stub.
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: req.get('x-user') || null }; next(); });
  const requireAuth = (req, res, next) => (req.session.userId ? next() : res.status(401).json({ error: 'auth' }));
  require(REPO + 'server/routes/instagram.js').mount(app, { store, requireAuth });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const get = (p, h) => realFetch(base + p, { redirect: 'manual', headers: h || {} });
  const post = (p, h, body) => realFetch(base + p, { method: 'POST', headers: { ...(h || {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body });

  try {
    // ── 1. THE LINK AND THE PAGE ────────────────────────────────────────────
    OUT.push('-- the agent sends a link; the athlete sees one page --');
    const denied = await post(`/api/agents/athletes/${ATH}/instagram-invite`, { 'x-user': OTHER });
    ok('another agent cannot make a link for someone else\'s athlete', denied.status === 403, denied.status);
    const invR = await post(`/api/agents/athletes/${ATH}/instagram-invite`, { 'x-user': AG });
    const inv = await invR.json();
    const token = inv.url.split('/').pop();
    ok('the agent gets a link, a ready-to-send text and an sms: link', invR.status === 200 && /\/athlete\/connect\/[A-Za-z0-9_-]{20,}$/.test(inv.url)
      && /Hi Maya, it's Dana/.test(inv.text) && /^sms:\?&body=/.test(inv.sms), inv);
    const pg = await get(`/athlete/connect/${token}`);
    const html = await pg.text();
    ok('the page shows the athlete\'s name and the agent\'s, says what is shared, and has one button', pg.status === 200 && /Hi Maya/.test(html) && /Dana Agent/.test(html)
      && /follower count and your recent posts' likes and comments, read-only/.test(html) && (html.match(/class="btn"/g) || []).length === 1 && /Connect Instagram/.test(html));
    ok('  mobile-first and not indexed', /width=device-width/.test(html) && /noindex/.test(html));
    const start = await get(`/api/instagram/start/${token}`);
    const loc = start.headers.get('location') || '';
    const q = new URL(loc).searchParams;
    ok('Connect goes to Instagram Login with our app, our redirect and only instagram_business_basic', start.status === 302 && loc.startsWith('https://www.instagram.com/oauth/authorize?')
      && q.get('client_id') === '1826629518692849' && q.get('redirect_uri') === 'https://mynildash.com/api/instagram/callback'
      && q.get('scope') === 'instagram_business_basic' && q.get('response_type') === 'code' && q.get('state') === token, loc);
    const second = await (await post(`/api/agents/athletes/${ATH}/instagram-invite`, { 'x-user': AG })).json();
    const oldPage = await get(`/athlete/connect/${token}`);
    ok('a newer link retires the old one', oldPage.status === 410 && /newer link/.test(await oldPage.text()));
    const tok = second.url.split('/').pop();

    // ── 2. THE CALLBACK ─────────────────────────────────────────────────────
    OUT.push('', '-- the callback: code, long-lived token, numbers --');
    const declined = await get(`/api/instagram/callback?error=access_denied&error_reason=user_denied&state=${tok}`);
    ok('an athlete who says no is told nothing was shared, and the link still works', /chose not to connect/.test(await declined.text())
      && (await IG.readInvite(P, tok)).ok);
    fake.exchangeError = 'Invalid authorization code';
    const failed = await get(`/api/instagram/callback?code=BAD&state=${tok}`);
    ok('a failed exchange shows a retry message and hands the link back', failed.status === 400 && /try your link again/.test(await failed.text()) && (await IG.readInvite(P, tok)).ok);
    fake.exchangeError = null; fake.calls.length = 0;
    const cb = await get(`/api/instagram/callback?code=GOOD-CODE%23_&state=${tok}`);
    const cbHtml = await cb.text();
    ok('connected: the page says so, with the username', cb.status === 200 && /Connected/.test(cbHtml) && /@ig\.tester/.test(cbHtml), cbHtml.slice(0, 300));
    const exch = fake.calls.find((c) => c.url.startsWith('https://api.instagram.com/oauth/access_token'));
    const exBody = new URLSearchParams(exch.body);
    ok('  the code is exchanged at api.instagram.com with our secret and redirect (the #_ suffix removed)', exBody.get('code') === 'GOOD-CODE'
      && exBody.get('client_secret') === 'test-secret-abc' && exBody.get('grant_type') === 'authorization_code' && exBody.get('redirect_uri') === 'https://mynildash.com/api/instagram/callback');
    ok('  then for a long-lived token at graph.instagram.com/access_token', fake.calls.some((c) => /graph\.instagram\.com\/access_token\?grant_type=ig_exchange_token/.test(c.url)));
    ok('  then /me and /me/media with the fields asked for', fake.calls.some((c) => /\/me\?fields=user_id%2Cusername%2Cfollowers_count%2Cfollows_count%2Cmedia_count/.test(c.url))
      && fake.calls.some((c) => /\/me\/media\?fields=id%2Clike_count%2Ccomments_count%2Ctimestamp%2Cmedia_type&limit=12/.test(c.url)));
    const conn = (await P.query(`SELECT * FROM instagram_connections WHERE athlete_id = $1`, [ATH])).rows[0];
    ok('the connection is stored: connected, the Instagram user, a ~60-day expiry', conn && conn.status === 'connected' && conn.ig_user_id === '17841400000000001'
      && Math.abs(new Date(conn.token_expires_at).getTime() - Date.now() - 5184000e3) < 120e3, conn && { status: conn.status, exp: conn.token_expires_at });
    ok('  the token is encrypted at rest, never stored in the clear', conn && !/LONG-TOKEN/.test(conn.access_token_enc) && require(REPO + 'server/services/crypto.js').decrypt(conn.access_token_enc) === 'LONG-TOKEN-1');
    const again = await get(`/api/instagram/callback?code=GOOD-CODE&state=${tok}`);
    ok('the link is single use', again.status === 400 && /already been used/.test(await again.text()));

    // ── 3. THE NUMBERS ──────────────────────────────────────────────────────
    OUT.push('', '-- what is stored, and the rate --');
    const st = (await P.query(`SELECT * FROM instagram_stats WHERE athlete_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [ATH])).rows[0];
    ok('the raw inputs are stored, not just a percentage: followers, follows, media, each post, fetched_at', st && st.followers_count === 24000 && st.follows_count === 300
      && st.media_count === 88 && Array.isArray(st.posts) && st.posts.length === 12 && st.posts[0].like_count === 500 && st.fetched_at, st && Object.keys(st));
    // avg likes = 500 + 10*5.5 = 555, avg comments 20 -> 575 / 24000
    ok('engagement = (avg likes + avg comments over the 12 posts) / followers', Math.abs(Number(st.avg_likes) - 555) < 1e-9 && Number(st.avg_comments) === 20
      && Math.abs(Number(st.engagement_rate) - 575 / 24000) < 1e-9, [st.avg_likes, st.avg_comments, st.engagement_rate]);
    const hidden = IG.computeEngagement(1000, [{ like_count: null, comments_count: 5 }, { like_count: 100, comments_count: 5 }]);
    ok('  a post with hidden likes is left out of the likes average, not counted as zero', hidden.avgLikes === 100 && hidden.avgComments === 5 && Math.abs(hidden.engagementRate - 0.105) < 1e-9, hidden);
    ok('  with no followers there is no rate, not a zero', IG.computeEngagement(0, [{ like_count: 5, comments_count: 1 }]).engagementRate === null);
    const ad = (await P.query(`SELECT data FROM athletes WHERE id = $1`, [ATH])).rows[0].data;
    ok('the athlete record carries the live numbers, sourced "instagram" and dated', ad.instagram === 24000 && ad.reachSource === 'instagram' && ad.engagementSource === 'instagram'
      && Math.abs(ad.engagement - 2.4) < 0.01 && ad.instagramHandle === 'ig.tester' && /^\d{4}-\d{2}-\d{2}$/.test(ad.reachAsOf), ad);
    ok('  which reachProvenance reads as live, with no caveat', require(REPO + 'server/services/reachProvenance.js').reachProvenance(ad).isLive === true);

    // ── 4. THE AGENT'S VIEW ─────────────────────────────────────────────────
    OUT.push('', '-- what the agent sees --');
    const status = await (await get('/api/agents/instagram/status', { 'x-user': AG })).json();
    const s1 = status.athletes[ATH], s2 = status.athletes[ATH2];
    ok('connected: username, followers, rate and the last sync', s1.status === 'connected' && s1.username === 'ig.tester' && s1.followers === 24000 && s1.lastSyncedAt, s1);
    ok('  an athlete who never connected is "not_connected" with NO numbers, never a zero', s2.status === 'not_connected' && s2.followers === null && s2.engagementRate === null, s2);
    const UI = read('public/index.html');
    ok('the roster card shows the status, not "0 reach"', /\$\{igStatusBlock\(a\)\}/.test(UI) && !/<span>\$\{reach\}<\/span> reach/.test(UI) && !/<span>\$\{a\.engagement\}%<\/span> eng/.test(UI)
      && /Instagram not connected/.test(UI) && /Instagram token expired/.test(UI) && /Instagram connected/.test(UI));
    ok('  and Add Client has the connect panel, not follower and rate boxes, with copy and text buttons', /id="a-ig-connect"/.test(UI) && /<input id="a_ig" type="hidden">/.test(UI)
      && /<input id="a_eng" type="hidden">/.test(UI) && /igInvite\('\$\{id\}','copy'/.test(UI) && /igInvite\('\$\{id\}','text'/.test(UI) && /Last sync /.test(UI));
    const IDX = read('server/index.js');
    ok('a profile save cannot overwrite the connected numbers', /isConnected\(store\.pool, req\.params\.id\)\) \{\s*for \(const k of \['instagram', 'engagement'/.test(IDX));
    ok('  nor can the old third-party stats fetch', /const _igLive = !isNew && athlete && await require\('\.\/services\/instagramConnect'\)\.isConnected/.test(IDX));
    // The kit's payload is built in one place (services/mediaKitPayload); a
    // connected account is VERIFIED there and the page labels it so.
    const MKP = read('server/services/mediaKitPayload.js');
    ok('the media kit uses the connected numbers when present, labelled verified, with the date pulled', /latestFor\(pool, mk\.athlete_id\)/.test(MKP)
      && /state: 'verified', source: 'instagram', fetchedAt: ig\.fetched_at/.test(MKP) && /Verified by NILDash/.test(read('public/media-kit.html')));
    const latest = await IG.latestFor(P, ATH);
    ok('  latestFor returns the stored numbers for a connected athlete', latest && latest.followers_count === 24000);

    // ── 5. REFRESH AND NIGHTLY ──────────────────────────────────────────────
    OUT.push('', '-- the token is refreshed well before it expires --');
    await P.query(`UPDATE instagram_connections SET token_expires_at = NOW() + INTERVAL '10 days', token_issued_at = NOW() - INTERVAL '50 days' WHERE athlete_id = $1`, [ATH]);
    fake.followers = 25100;
    const n1 = await IG.nightly(P);
    const c2 = (await P.query(`SELECT * FROM instagram_connections WHERE athlete_id = $1`, [ATH])).rows[0];
    ok('a token with 10 days left is refreshed to a fresh 60 days, and the numbers re-fetched', n1.refresh.refreshed === 1 && n1.synced === 1
      && require(REPO + 'server/services/crypto.js').decrypt(c2.access_token_enc) === 'LONG-TOKEN-2' && new Date(c2.token_expires_at).getTime() > Date.now() + 55 * 86400e3, n1);
    ok('  each fetch is a new row (history kept)', (await P.query(`SELECT COUNT(*)::int n FROM instagram_stats WHERE athlete_id = $1`, [ATH])).rows[0].n === 2);
    await P.query(`UPDATE instagram_connections SET token_issued_at = NOW() - INTERVAL '2 hours', token_expires_at = NOW() + INTERVAL '5 days' WHERE athlete_id = $1`, [ATH]);
    ok('a token under 24 hours old is not refreshed yet', (await IG.refreshDue(P)).due === 0);
    await P.query(`UPDATE instagram_connections SET token_issued_at = NOW() - INTERVAL '40 days', token_expires_at = NOW() + INTERVAL '3 days' WHERE athlete_id = $1`, [ATH]);
    fake.refreshError = 'Error validating access token: The user has not authorized application.';
    const r2 = await IG.refreshDue(P);
    await new Promise((r) => setTimeout(r, 200));
    const alert = (await P.query(`SELECT reason FROM service_faults WHERE service = 'instagram-token' AND context = $1 ORDER BY at DESC LIMIT 1`, ['instagram athlete=' + ATH])).rows[0];
    ok('a token that cannot be refreshed is an alert naming the athlete and the agent', r2.failed.length === 1 && alert && /Maya Tester \(agent Dana Agent\)/.test(alert.reason), [r2, alert]);
    ok('  and a revoked token marks the athlete "expired" (reconnect)', (await P.query(`SELECT status FROM instagram_connections WHERE athlete_id = $1`, [ATH])).rows[0].status === 'expired');
    ok('  which the agent sees', (await (await get('/api/agents/instagram/status', { 'x-user': AG })).json()).athletes[ATH].status === 'expired');
    fake.refreshError = null;
    const IDXs = read('server/index.js');
    ok('the refresh and the nightly fetch are scheduled', /IGC\.tick\(store\.pool\)/.test(IDXs) && IG.REFRESH_WHEN_DAYS_LEFT === 20);

    // ── 6. META'S CALLBACKS ─────────────────────────────────────────────────
    OUT.push('', '-- deauthorize and data deletion --');
    await P.query(`UPDATE instagram_connections SET status = 'connected' WHERE athlete_id = $1`, [ATH]);
    const sign = (payload, secret) => {
      const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
      const sig = crypto.createHmac('sha256', secret || 'test-secret-abc').update(p).digest('base64url');
      return `${sig}.${p}`;
    };
    const forged = await post('/api/instagram/deauthorize', {}, `signed_request=${encodeURIComponent(sign({ user_id: '17841400000000001', algorithm: 'HMAC-SHA256' }, 'wrong'))}`);
    ok('a signed_request that does not verify is refused', forged.status === 400 && (await P.query(`SELECT status FROM instagram_connections WHERE athlete_id = $1`, [ATH])).rows[0].status === 'connected');
    const de = await post('/api/instagram/deauthorize', {}, `signed_request=${encodeURIComponent(sign({ user_id: '17841400000000001', algorithm: 'HMAC-SHA256', issued_at: 1 }))}`);
    const c3 = (await P.query(`SELECT status, access_token_enc FROM instagram_connections WHERE athlete_id = $1`, [ATH])).rows[0];
    ok('deauthorize: the athlete is disconnected and the token deleted', de.status === 200 && c3.status === 'disconnected' && c3.access_token_enc === null, c3);
    const dd = await post('/api/instagram/data-deletion', {}, `signed_request=${encodeURIComponent(sign({ user_id: '17841400000000001', algorithm: 'HMAC-SHA256' }))}`);
    const ddj = await dd.json();
    ok('data deletion answers Meta with a status URL and a confirmation code', dd.status === 200 && /^[0-9a-f]{20}$/.test(ddj.confirmation_code)
      && ddj.url === `https://mynildash.com/api/instagram/deletion-status?code=${ddj.confirmation_code}`, ddj);
    const leftStats = (await P.query(`SELECT COUNT(*)::int n FROM instagram_stats WHERE athlete_id = $1`, [ATH])).rows[0].n;
    const ad2 = (await P.query(`SELECT data FROM athletes WHERE id = $1`, [ATH])).rows[0].data;
    ok('  and deletes every stats row and the Instagram-sourced fields on the athlete', leftStats === 0 && ad2.instagram === undefined && ad2.reachSource === undefined
      && ad2.engagement === undefined && ad2.name === 'Maya Tester', { leftStats, ad2 });
    const stp = await get(`/api/instagram/deletion-status?code=${ddj.confirmation_code}`);
    ok('  the status page shows it completed', stp.status === 200 && /Completed/.test(await stp.text()));
    // Meta validates both URLs with a GET before the dashboard will save them.
    const gDel = await get('/api/instagram/data-deletion');
    const gDelHtml = await gDel.text();
    ok('GET data-deletion: 200, a page explaining how to request deletion and a form to check a code', gDel.status === 200
      && /Delete your Instagram data/.test(gDelHtml) && /Apps and websites/.test(gDelHtml) && /action="\/api\/instagram\/deletion-status"/.test(gDelHtml) && /name="code"/.test(gDelHtml));
    const gDe = await get('/api/instagram/deauthorize');
    ok('GET deauthorize: 200', gDe.status === 200 && /Instagram access/.test(await gDe.text()));
    ok('  and the signed POSTs still refuse an unsigned request', (await post('/api/instagram/deauthorize', {}, 'x=1')).status === 400
      && (await post('/api/instagram/data-deletion', {}, 'x=1')).status === 400);
    ok('the unconfigured app refuses politely rather than sending the athlete to a broken Instagram page', (() => {
      const src = read('server/routes/instagram.js'); return /if \(!IG\.configured\(\)\)/.test(src) && /Not available right now/.test(src);
    })());
  } finally {
    srv.close();
    await clean();
  }
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
