'use strict';
// Runs against the local test Postgres, in its own database. No network.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/igdisconnect.js  just this one
//
// ── DISCONNECT INSTAGRAM, FROM THE ATHLETE PAGE ─────────────────────────────
// A "Disconnect Instagram" button beside the athlete's Instagram status. After
// a confirm dialog it:
//   erases our stored access token (and revokes any unused connect link)
//   deletes everything fetched from Instagram for that athlete, right away,
//     by the same path as Meta's data deletion callback, recorded the same way
//   leaves the athlete not connected
// The privacy page's removal steps say so.
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..') + path.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('igdisconnecttest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const express = require('express');
const store = require(REPO + 'server/store.js');
const IG = require(REPO + 'server/services/instagramConnect.js');
const C = require(REPO + 'server/services/crypto.js');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await IG.ensureTables(P);
  const AG = 'igd-agent', AG2 = 'igd-other', ATH = 'igd-maya', ATH2 = 'igd-jo', ATH3 = 'igd-meta';
  await P.query(`INSERT INTO users (id, name, email, role, password) VALUES ($1,'Ana Agent','ana@agency.example','agent','x'), ($2,'Oto Other','oto@agency.example','agent','x')`, [AG, AG2]);
  const live = { name: 'Maya Torres', instagram: 5400, reachSource: 'instagram', reachAsOf: '2026-10-20', engagement: 4.2, engagementSource: 'instagram', engagementAsOf: '2026-10-20',
    igStatsSource: 'instagram_connect', igStatsFetchedAt: '2026-10-20T10:00:00Z', instagramHandle: 'maya.t', tiktok: 900 };
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3), ($4,$2,$5), ($6,$2,$7)`,
    [ATH, AG, JSON.stringify(live), ATH2, JSON.stringify({ name: 'Jo Typed', instagram: 1200, reachSource: 'agent' }), ATH3, JSON.stringify({ ...live, name: 'Meta Path' })]);
  const connect = (ath, ig) => P.query(`INSERT INTO instagram_connections (athlete_id, agent_id, ig_user_id, username, access_token_enc, token_expires_at, status, last_synced_at, scopes_granted)
     VALUES ($1,$2,$3,'maya.t',$4, NOW() + INTERVAL '50 days','connected', NOW(), $5)`, [ath, AG, ig, C.encrypt('IGQVJ-secret-token-' + ath), [IG.BASIC_SCOPE, IG.INSIGHTS_SCOPE]]);
  await connect(ATH, '17841400000000101');
  await connect(ATH3, '17841400000000303');
  const stat = (ath, ig, src) => P.query(`INSERT INTO instagram_stats (athlete_id, ig_user_id, username, followers_count, engagement_rate, posts, source) VALUES ($1,$2,'maya.t',5400,0.042,'[]'::jsonb,$3)`, [ath, ig, src]);
  await stat(ATH, '17841400000000101', 'instagram'); await stat(ATH, '17841400000000101', 'instagram'); await stat(ATH, null, 'screenshot');
  await stat(ATH3, '17841400000000303', 'instagram');
  await P.query(`INSERT INTO instagram_connect_tokens (token, athlete_id, agent_id, expires_at) VALUES ('igd-open-link',$1,$2, NOW() + INTERVAL '5 days')`, [ATH, AG]);

  // The real routes, in-process, with a session stub (as tests/instagram.js does).
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.session = { userId: req.get('x-user') || null }; next(); });
  const requireAuth = (req, res, next) => (req.session.userId ? next() : res.status(401).json({ error: 'auth' }));
  require(REPO + 'server/routes/instagram.js').mount(app, { store, requireAuth });
  const srv = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = async (p, user) => { const r = await fetch(base + p, { method: 'POST', headers: user ? { 'x-user': user } : {} }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const conn = async (ath) => (await P.query(`SELECT * FROM instagram_connections WHERE athlete_id = $1`, [ath])).rows[0];
  const statsN = async (ath) => Number((await P.query(`SELECT COUNT(*) FROM instagram_stats WHERE athlete_id = $1`, [ath])).rows[0].count);
  const dataOf = async (ath) => (await P.query(`SELECT data FROM athletes WHERE id = $1`, [ath])).rows[0].data;

  console.log('\n1. ONLY THE ATHLETE\'S OWN AGENT');
  ok('signed out: refused', (await post(`/api/agents/athletes/${ATH}/instagram-disconnect`)).status === 401);
  const other = await post(`/api/agents/athletes/${ATH}/instagram-disconnect`, AG2);
  ok('another agent: refused, and nothing is touched', other.status === 403 && (await statsN(ATH)) === 3 && (await conn(ATH)).access_token_enc !== null, other);
  ok('  the service checks the roster too', (await IG.disconnect(P, { athleteId: ATH, agentId: AG2 })).status === 404 && (await statsN(ATH)) === 3);

  console.log('\n2. DISCONNECT');
  ok('before: connected, with numbers', (await IG.isConnected(P, ATH)) === true && (await IG.statusForAgent(P, AG))[ATH].display === 'connected');
  const r = await post(`/api/agents/athletes/${ATH}/instagram-disconnect`, AG);
  ok('the agent disconnects: ok, the token was erased and the data deleted', r.status === 200 && r.body.ok && r.body.hadToken === true && r.body.wasConnected === true && r.body.statsDeleted === 3, r.body);
  const c = await conn(ATH);
  ok('the stored access token is gone, and the account with it', c.access_token_enc === null && c.ig_user_id === null && c.username === null && c.last_synced_at === null, c);
  ok('every stats row is deleted, the screenshot one too (as Meta\'s path does)', (await statsN(ATH)) === 0);
  const d = await dataOf(ATH);
  ok('the numbers Instagram put on the athlete record are gone', !('instagram' in d) && !('engagement' in d) && !('igStatsSource' in d) && !('reachSource' in d) && !('engagementSource' in d), d);
  ok('  what the agent typed stays: the handle, TikTok, the name', d.instagramHandle === 'maya.t' && d.tiktok === 900 && d.name === 'Maya Torres', d);
  ok('the unused connect link is revoked', !!(await P.query(`SELECT revoked_at FROM instagram_connect_tokens WHERE token = 'igd-open-link'`)).rows[0].revoked_at);
  const st = (await IG.statusForAgent(P, AG))[ATH];
  ok('the athlete reads not connected, and says why', st.display === 'not_connected' && st.status === 'disconnected' && /Disconnected in NILDash/.test(st.reason) && st.followers === null, st);
  ok('  isConnected is false and the media kit has no Instagram numbers', (await IG.isConnected(P, ATH)) === false && (await IG.latestFor(P, ATH)) === null);
  const req = (await P.query(`SELECT * FROM instagram_deletion_requests WHERE confirmation_code = $1`, [r.body.code])).rows[0];
  ok('recorded like a Meta deletion request: a confirmation code, completed, for this athlete', req && req.status === 'completed' && !!req.completed_at && req.athlete_ids[0] === ATH && req.ig_user_id === '17841400000000101', req);
  const page = await fetch(base + '/api/instagram/deletion-status?code=' + r.body.code).then((x) => x.text());
  ok('  the deletion-status page shows it as done', /Completed \d{4}-\d{2}-\d{2}\. All Instagram data NILDash held for this account has been deleted\./.test(page));
  const again = await post(`/api/agents/athletes/${ATH}/instagram-disconnect`, AG);
  ok('pressing it twice is harmless', again.status === 200 && again.body.statsDeleted === 0 && again.body.hadToken === false, again.body);
  const never = await post(`/api/agents/athletes/${ATH2}/instagram-disconnect`, AG);
  ok('an athlete who never connected: nothing to delete, and a typed follower count is kept', never.status === 200 && (await dataOf(ATH2)).instagram === 1200, never.body);
  ok('another athlete\'s connection is untouched', (await statsN(ATH3)) === 1 && (await conn(ATH3)).access_token_enc !== null);

  console.log('\n3. THE SAME PATH AS META\'S DATA DELETION CALLBACK');
  const SRC = read('server/services/instagramConnect.js');
  ok('one deletion function, used by both', /async function _deleteFetched\(/.test(SRC) && (SRC.match(/await _deleteFetched\(pool, /g) || []).length === 2
    && /async function deleteData\(pool, igUserId\)[\s\S]*?await _deleteFetched\(pool, ids, igUserId/.test(SRC) && /async function disconnect\([\s\S]*?await _deleteFetched\(pool, \[athleteId\]/.test(SRC));
  const md = await IG.deleteData(P, '17841400000000303');
  const c3 = await conn(ATH3), d3 = await dataOf(ATH3);
  ok('Meta\'s callback still deletes as before: token, stats, the record\'s Instagram numbers, with its own reason', md.athleteIds[0] === ATH3 && c3.access_token_enc === null
    && /data deleted at the athlete's request/.test(c3.status_reason) && (await statsN(ATH3)) === 0 && !('instagram' in d3) && d3.instagramHandle === 'maya.t', { md, c3, d3 });

  console.log('\n4. THE BUTTON');
  const html = read('public/index.html');
  const grab = (re) => { const m = html.match(re); if (!m) throw new Error('not found: ' + re); return m[0]; };
  const fn = new Function('igStatus', grab(/function igDisconnectHtml[\s\S]*?\n}\n/) + '; return igDisconnectHtml;');
  const btnFor = (s) => fn({ a1: s })('a1');
  ok('beside the status whenever NILDash holds a connection', /Disconnect Instagram<\/button>/.test(btnFor({ status: 'connected' })) && /Disconnect Instagram/.test(btnFor({ status: 'expired' }))
    && /Disconnect Instagram/.test(btnFor({ status: 'personal_account' })));
  ok('  not when there is nothing to disconnect', btnFor({ status: 'not_connected' }) === '' && btnFor({ status: 'disconnected' }) === '' && fn({})('a1') === '');
  ok('  it is part of the status block on the athlete page and the roster card', /\` \+ igDisconnectHtml\(id\);/.test(html) && /el\.innerHTML = igStatusHtml\(id\) \+ igButtonsHtml\(id\);/.test(html));
  const go = grab(/async function igDisconnect\(id, btn\) \{[\s\S]*?\n}\n/);
  ok('a confirm dialog first, saying what it deletes; nothing runs on Cancel', /if \(!confirm\(`Disconnect \$\{who\} Instagram\?/.test(go) && /deletes the stored access token and every number NILDash fetched from their Instagram, right away/.test(go)
    && go.indexOf('confirm(') < go.indexOf('fetch('));
  ok('  then the route, and the page reads the athlete again', /\/api\/agents\/athletes\/\$\{encodeURIComponent\(id\)\}\/instagram-disconnect/.test(go) && /await loadAthletes\(\)/.test(go));
  ok('  an open edit form drops the deleted numbers, so saving cannot write them back', /igEl\.value = a2\.instagram \|\| ''/.test(go) && /engEl\.value = a2\.engagement \|\| ''/.test(go));
  ok('no em dash in the button\'s words', !/—|&mdash;/.test(grab(/function igDisconnectHtml[\s\S]*?\n}\n/) + go));

  srv.close();
  await P.end().catch(() => {});
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
