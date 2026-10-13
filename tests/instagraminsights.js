'use strict';
// Runs against the local test Postgres. Instagram's Graph API is a fake.
//
//   node tests/instagraminsights.js
//
// ── EVERYTHING INSTAGRAM ALLOWS, USED WHERE IT MATTERS ──────────────────────
// The fixtures: a full insights response, an account under 100 followers,
// hidden likes, a post with no insights, a connection on the old scope, Meta's
// "API access blocked" (code 200) and a personal account. Then the derived
// numbers, the pitch line and its fact check, the media kit, the screenshot
// fallback, the agent's statuses, the nightly counts and the admin script.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.INSTAGRAM_APP_ID = '1826629518692849';
process.env.INSTAGRAM_APP_SECRET = 'test-secret-abc';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });

// ── THE FAKE GRAPH API ──────────────────────────────────────────────────────
// mode: 'full' | 'small' (60 followers) | 'blocked' (code 200 on insights) |
// 'personal' (the profile call refuses: not a professional account)
function graph(mode) {
  const calls = [];
  const followers = mode === 'small' ? 60 : 3800;
  const fetch = async (url) => {
    calls.push(url);
    const u = new URL(url);
    const p = u.pathname, q = u.searchParams;
    if (p === '/me' && mode === 'personal') return json(400, { error: { type: 'OAuthException', code: 10, message: 'The Instagram account is not a professional account (Business or Creator).' } });
    if (p === '/me') return json(200, { user_id: '17841400000000777', username: 'maya.hoops', name: 'Maya Brooks', biography: 'Guard', website: null,
      profile_picture_url: 'https://x/p.jpg', account_type: 'MEDIA_CREATOR', followers_count: followers, follows_count: 410, media_count: 87 });
    if (p === '/me/media') return json(200, { data: [
      { id: 'm1', media_type: 'IMAGE', media_product_type: 'FEED', like_count: 300, comments_count: 20, timestamp: '2026-10-01T00:00:00Z', permalink: 'https://instagram.com/p/1' },
      { id: 'm2', media_type: 'VIDEO', media_product_type: 'REELS', like_count: 500, comments_count: 40, timestamp: '2026-09-28T00:00:00Z' },
      { id: 'm3', media_type: 'IMAGE', media_product_type: 'FEED', comments_count: 10, timestamp: '2026-09-25T00:00:00Z' },   // hidden likes: no like_count
      { id: 'm4', media_type: 'IMAGE', media_product_type: 'FEED', like_count: 100, comments_count: 5, timestamp: '2026-09-20T00:00:00Z' }, // no insights
      { id: 's1', media_type: 'IMAGE', media_product_type: 'STORY', timestamp: '2026-10-02T00:00:00Z' },
    ] });
    if (/\/insights$/.test(p) && p.startsWith('/17841400000000777')) {
      if (mode === 'blocked') return json(403, { error: { type: 'OAuthException', code: 200, message: 'API access blocked.' } });
      const metric = q.get('metric');
      if (metric === 'impressions') return json(400, { error: { code: 100, message: 'impressions is deprecated' } });
      if (metric === 'follower_demographics' || metric === 'engaged_audience_demographics') {
        const bd = q.get('breakdown');
        const rows = { city: [['Birmingham, Alabama', 2280], ['Hoover, Alabama', 300], ['Atlanta, Georgia', 120]], country: [['US', 3600], ['CA', 50]],
          age: [['18-24', 2000], ['25-34', 1100]], gender: [['F', 2100], ['M', 1600]] }[bd];
        return json(200, { data: [{ name: metric, period: 'lifetime', total_value: { breakdowns: [{ dimension_keys: [bd], results: rows.map(([k, v]) => ({ dimension_values: [k], value: v })) }] } }] });
      }
      const v = { reach: 21000, views: 48000, accounts_engaged: 1900, total_interactions: 2600, likes: 2100, comments: 240, saves: 90, shares: 110, replies: 30,
        follows_and_unfollows: 45, profile_links_taps: 12 }[metric];
      return json(200, { data: [{ name: metric, period: 'day', total_value: { value: v } }] });
    }
    if (p === '/m4/insights') return json(400, { error: { code: 100, message: '(#100) Media posted before business account conversion' } });
    if (/^\/m\d\/insights$/.test(p)) {
      const ms = q.get('metric').split(',');
      const vals = { m1: { reach: 2000, views: 2600, saved: 12, shares: 8, total_interactions: 330, profile_visits: 40, follows: 3 },
        m2: { reach: 2200, views: 5400, saved: 20, shares: 15, total_interactions: 560, ig_reels_avg_watch_time: 6100 },
        m3: { reach: 1900, views: 2300, saved: 4, shares: 2, total_interactions: 20, profile_visits: 9, follows: 0 } }[p.split('/')[1]];
      return json(200, { data: ms.map((m) => ({ name: m, values: [{ value: vals[m] }] })) });
    }
    return json(404, { error: { code: 100, message: 'unknown path in the fake: ' + p } });
  };
  return { fetch, calls };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const IG = require(REPO + 'server/services/instagramConnect.js');
  const II = require(REPO + 'server/services/instagramInsights.js');
  const C = require(REPO + 'server/services/crypto.js');
  const P = store.pool;
  await IG.ensureTables(P);
  const AG = 'u-iginsights', A1 = 'ath-igi-full', A2 = 'ath-igi-small', A3 = 'ath-igi-old', A4 = 'ath-igi-blocked', A5 = 'ath-igi-personal', A6 = 'ath-igi-shot';
  const ALL = [A1, A2, A3, A4, A5, A6];
  const clean = async () => {
    await P.query(`DELETE FROM instagram_stats WHERE athlete_id = ANY($1)`, [ALL]);
    await P.query(`DELETE FROM instagram_connections WHERE athlete_id = ANY($1)`, [ALL]);
    await P.query(`DELETE FROM instagram_connect_tokens WHERE athlete_id = ANY($1)`, [ALL]);
    await P.query(`DELETE FROM athletes WHERE id = ANY($1)`, [ALL]);
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Dana Agent','dana@igi.example','x','agent')`, [AG]);
  for (const id of ALL) {
    await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`, [id, AG, JSON.stringify({ name: 'Maya ' + id.split('-').pop(), school: 'Samford University, Birmingham, AL', sport: 'Basketball' })]);
  }
  const connect = (id, scopes) => P.query(`INSERT INTO instagram_connections (athlete_id, agent_id, ig_user_id, access_token_enc, token_expires_at, token_issued_at, status, scopes_granted, needs_reconnect_for_insights)
    VALUES ($1,$2,'17841400000000777',$3, NOW() + INTERVAL '50 days', NOW() - INTERVAL '2 days', 'connected', $4, $5)`, [id, AG, C.encrypt('TOKEN-' + id), scopes, !(scopes && scopes.includes(II.INSIGHTS_SCOPE))]);
  const BOTH = ['instagram_business_basic', 'instagram_business_manage_insights'];

  // ── 1. A FULL INSIGHTS RESPONSE ───────────────────────────────────────────
  await connect(A1, BOTH);
  const g1 = graph('full');
  const s1 = await IG.syncAthlete(P, A1, { fetch: g1.fetch, now: '2026-10-13T12:00:00Z' });
  const row1 = (await P.query(`SELECT * FROM instagram_stats WHERE athlete_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [A1])).rows[0];
  const ins = row1 && row1.insights;
  ok('FULL: synced, with the profile and scopes stored', s1.ok && s1.insights && row1.profile.account_type === 'MEDIA_CREATOR' && row1.scopes_granted.join(',') === BOTH.join(','), { s1, profile: row1 && row1.profile });
  ok('  every account metric, summed over 30 days, raw', ins && ins.account.reach === 21000 && ins.account.views === 48000 && ins.account.profile_links_taps === 12
    && II.ACCOUNT_METRICS.every((m) => ins.account[m] !== null), ins && ins.account);
  ok('  impressions is never asked for', !g1.calls.some((c) => /metric=impressions/.test(c)));
  ok('  account metrics are asked as day / total_value over a 30-day window', g1.calls.some((c) => /metric=reach&period=day&metric_type=total_value&since=\d+&until=\d+/.test(c)));
  ok('  demographics: followers and engaged audience, 30 and 90 days, by city, country, age and gender',
    ['follower_demographics', 'engaged_audience_demographics'].every((m) => ['last_30_days', 'last_90_days'].every((tf) => ['city', 'country', 'age', 'gender'].every((bd) =>
      ins.demographics[m][tf][bd] && ins.demographics[m][tf][bd].length))), Object.keys((ins && ins.demographics) || {}));
  ok('  per-post insights: feed and reels metrics, stories skipped', ins.posts.find((p) => p.id === 'm1').insights.profile_visits === 40
    && ins.posts.find((p) => p.id === 'm2').insights.ig_reels_avg_watch_time === 6100 && !ins.posts.some((p) => p.id === 's1')
    && g1.calls.some((c) => /\/m2\/insights\?metric=reach%2Cviews%2Csaved%2Cshares%2Ctotal_interactions%2Cig_reels_avg_watch_time/.test(c)), ins.posts);
  ok('A POST WITH NO INSIGHTS: its own error, the rest kept', ins.posts.find((p) => p.id === 'm4').insights === null && /before business account conversion/.test(ins.posts.find((p) => p.id === 'm4').error));
  ok('HIDDEN LIKES: left out of the likes average, never counted as zero', Math.abs(Number(row1.avg_likes) - 300) < 0.01, row1.avg_likes);   // (300+500+100)/3

  // ── DERIVED NUMBERS ───────────────────────────────────────────────────────
  const d1 = II.derive(row1, { city: 'Birmingham, AL' });
  ok('DERIVED: engagement by reach (interactions / reach)', Math.abs(d1.engagementByReach - 2600 / 21000) < 1e-9, d1.engagementByReach);
  ok('  average reach and views per post, over posts with insights', d1.avgReachPerPost === 2033 + 1 / 3 && Math.abs(d1.avgViewsPerPost - (2600 + 5400 + 2300) / 3) < 1e-9, d1);
  ok('  LOCAL SHARE: followers in the school city over ALL followers (2,280 of 3,800 = 60%)', d1.local && Math.abs(d1.local.cityShare - 0.6) < 1e-9, d1.local);
  ok('  with an area when we know its cities', Math.abs(II.localShare(row1.insights, { city: 'Birmingham', areaCities: ['Hoover'], followers: 3800 }).areaShare - (2580 / 3800)) < 1e-9);
  ok('  top cities, countries, age bands and gender', d1.topCities[0].key === 'Birmingham, Alabama' && d1.topCountries[0].key === 'US' && d1.ageBands[0].key === '18-24' && d1.gender[0].key === 'F', d1.topCities);

  // ── 2. UNDER 100 FOLLOWERS ────────────────────────────────────────────────
  await connect(A2, BOTH);
  const g2 = graph('small');
  await IG.syncAthlete(P, A2, { fetch: g2.fetch });
  const row2 = (await P.query(`SELECT insights FROM instagram_stats WHERE athlete_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [A2])).rows[0];
  ok('UNDER 100 FOLLOWERS: demographics stored as not available, with the reason, never an empty breakdown',
    row2.insights.demographics.available === false && row2.insights.demographics.reason === 'under 100 followers' && !g2.calls.some((c) => /follower_demographics/.test(c)), row2.insights.demographics);
  ok('  and no local share is claimed', II.derive({ ...row2, followers_count: 60 }, { city: 'Birmingham' }).local === null);

  // ── 3. CONNECTED ON THE OLD SCOPE ─────────────────────────────────────────
  await connect(A3, ['instagram_business_basic']);
  const g3 = graph('full');
  const s3 = await IG.syncAthlete(P, A3, { fetch: g3.fetch });
  ok('OLD SCOPE: still syncs the basic data, never broken', s3.ok && s3.followers === 3800 && !s3.insights, s3);
  ok('  no insights call is made for it', !g3.calls.some((c) => /\/insights/.test(c)));
  const st = await IG.statusForAgent(P, AG);
  ok('  the agent sees "needs new link" for it', st[A3].display === 'needs_new_link' && st[A3].needsReconnectForInsights === true, st[A3]);
  await P.query(`UPDATE instagram_connections SET scopes_granted = NULL, needs_reconnect_for_insights = FALSE WHERE athlete_id = $1`, [A3]);
  await IG.ensureTables(P);
  ok('  a connection made before scopes were recorded is marked for a new link on the next start', (await P.query(`SELECT needs_reconnect_for_insights n FROM instagram_connections WHERE athlete_id = $1`, [A3])).rows[0].n === true);

  // ── 4. META BLOCKS THE INSIGHTS (code 200) ────────────────────────────────
  await connect(A4, BOTH);
  const s4 = await IG.syncAthlete(P, A4, { fetch: graph('blocked').fetch });
  const c4 = (await P.query(`SELECT * FROM instagram_connections WHERE athlete_id = $1`, [A4])).rows[0];
  ok('PERMISSION BLOCKED: the followers still sync, the block is named in plain words', s4.ok && s4.followers === 3800 && c4.last_error_kind === 'permission_blocked'
    && /not approved for this yet, or this athlete is not a tester/.test(c4.last_sync_error), c4);
  ok('  and the agent sees "insights blocked"', (await IG.statusForAgent(P, AG))[A4].display === 'blocked');
  ok('  classify: code 200 / "API access blocked" is permission_blocked', II.classify({ code: 200, message: 'OAuthException 200: API access blocked' }) === 'permission_blocked'
    && II.classify({ message: 'stats fetch failed ... OAuthException 200: API access blocked' }) === 'permission_blocked');

  // ── 5. A PERSONAL ACCOUNT ─────────────────────────────────────────────────
  await connect(A5, BOTH);
  const s5 = await IG.syncAthlete(P, A5, { fetch: graph('personal').fetch });
  ok('PERSONAL ACCOUNT: said in plain words, the agent told to ask them to switch', !s5.ok && s5.kind === 'personal_account'
    && (await IG.statusForAgent(P, AG))[A5].display === 'personal_account', s5);
  ok('  and the other kinds: token expired, under 100', II.classify({ code: 190, message: 'Error validating access token' }) === 'token_expired'
    && II.classify({ message: 'The account must have at least 100 followers' }) === 'under_100');

  // ── 6. THE PITCH ──────────────────────────────────────────────────────────
  const PW = require(REPO + 'server/services/pitchWriter.js');
  const v = await II.verifiedFor(P, A1);
  ok('VERIFIED FOR THE WRITER: connected numbers only', v && v.followers === 3800 && v.avgReachPerPost === 2033 && v.cityRows.length === 3, v);
  const prompt = PW.buildPrompt({ business: { name: 'Magic City Smoothies', address: '100 Main St, Birmingham, AL 35203', isLocal: true },
    athlete: { name: 'Maya Brooks', igVerified: v }, agentFirstName: 'Dana', channel: 'email' });
  ok('THE PITCH LINE: followers, the local share for the business\'s city, average reach, in plain words',
    /VERIFIED BY INSTAGRAM \(\d{4}-\d\d-\d\d\)/.test(prompt) && /3,800 followers, about 60% of them in Birmingham, averaging 2,033 people reached per post/.test(prompt), prompt.slice(prompt.indexOf('VERIFIED'), prompt.indexOf('VERIFIED') + 300));
  ok('  not for a brand programme (not local)', !/VERIFIED BY INSTAGRAM/.test(PW.buildPrompt({ business: { name: 'Grip Socks', isLocal: false }, athlete: { name: 'Maya Brooks', igVerified: v }, agentFirstName: 'Dana', channel: 'email' })));
  ok('  and not for an athlete who is not connected: the pitch is as before', !/VERIFIED BY INSTAGRAM/.test(PW.buildPrompt({ business: { name: 'Magic City Smoothies', isLocal: true }, athlete: { name: 'Maya Brooks' }, agentFirstName: 'Dana', channel: 'email' })));
  const okMsg = 'Hi Sam,\n\nMaya Brooks plays basketball at Samford. She has 3,800 followers, about 60% of them in Birmingham, averaging 2,033 people reached per post.\n\nDana';
  const f1 = PW.verifyAthleteFacts(okMsg, { name: 'Maya Brooks', sport: 'Basketball', igVerified: v, reachSource: 'instagram', reachAsOf: '2026-10-13', instagram: 3800 });
  ok('THE FACT CHECK ACCEPTS the verified reach number', !f1.problems.some((p) => /2,033|matches no stored|we hold no follower/.test(p)), f1.problems);
  const f2 = PW.verifyAthleteFacts('Hi Sam,\n\nShe reaches 9,500 people per post.\n\nDana', { name: 'Maya Brooks', igVerified: v, instagram: 3800, reachSource: 'instagram' });
  ok('  and still refuses a number Instagram did not give', f2.problems.some((p) => /9,500/.test(p)), f2.problems);

  // ── 7. THE MEDIA KIT ──────────────────────────────────────────────────────
  const MKP = require(REPO + 'server/services/mediaKitPayload.js');
  const det = MKP.instagramDetail(row1, 'Birmingham');
  ok('THE MEDIA KIT: average reach and views, local share, cities, age and gender, verified by Instagram', det && det.source === 'instagram' && det.avgReachPerPost === 2033
    && det.local.pct === 60 && det.topCities[0].label === 'Birmingham, Alabama' && det.ages.length && det.gender.length, det);
  const bare = MKP.instagramDetail({ followers_count: 900, insights: null, fetched_at: new Date() }, 'Birmingham');
  ok('  a kit with no insights has no audience section at all, never zeros', bare === null, bare);

  // ── 8. THE SCREENSHOT FALLBACK ────────────────────────────────────────────
  const SS = require(REPO + 'server/services/instagramScreenshot.js');
  const png = 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64');
  const shot = await SS.readAndStore(P, A6, [png], { read: async () => ({ username: '@maya.shot', followers: '1,240', periodDays: 30, accountsReached: 5300,
    topCities: [{ city: 'Birmingham', pct: 48.5 }, { city: 'Hoover', pct: 9 }], ages: [{ band: '18-24', pct: 61 }], gender: [{ label: 'Women', pct: 70 }] }) });
  const row6 = (await P.query(`SELECT * FROM instagram_stats WHERE athlete_id = $1`, [A6])).rows[0];
  ok('SCREENSHOT: stored with source screenshot and the date, numbers read, never verified', shot.ok && row6.source === 'screenshot' && row6.followers_count === 1240 && row6.username === 'maya.shot', row6);
  ok('  its percentages are shares of all followers (48.5% in Birmingham)', Math.abs(II.derive(row6, { city: 'Birmingham' }).local.cityShare - 0.485) < 1e-9);
  ok('  the writer never sees it', (await II.verifiedFor(P, A6)) === null);
  const aud = MKP.audienceOf({}, null, row6);
  ok('  the media kit labels it "From the athlete\'s screenshot"', aud[0].state === 'screenshot' && MKP.instagramDetail(row6, 'Birmingham').source === 'screenshot', aud);
  ok('  an image that is not one is refused, a HEIC photo named', /HEIC/.test(SS.parseImage('data:image/heic;base64,AAAA').error) && SS.parseImage('not an image').error);
  ok('  a number the model did not read is null, never 0', SS.clean({}).followers === null && SS.clean({ followers: '' }).followers === null && SS.clean({ followers: '0' }).followers === 0);
  ok('  nothing readable is not stored', (await SS.readAndStore(P, A6, [png], { read: async () => ({}) })).ok === false
    && (await P.query(`SELECT COUNT(*)::int n FROM instagram_stats WHERE athlete_id = $1`, [A6])).rows[0].n === 1);

  // ── 9. THE NIGHT AND THE ADMIN SCRIPT ─────────────────────────────────────
  const S = require(REPO + 'scripts/instagram-status.js');
  const rep = await S.run(P, { agent: 'dana@igi.example' });
  const txt = rep.lines.join('\n');
  ok('THE ADMIN SCRIPT: per athlete, connected or why not, scopes, last sync, last error, followers, local share',
    /Maya full\s+Dana Agent\s+connected/.test(txt) && /instagram_business_basic, instagram_business_manage_insights/.test(txt) && /local share: 60% in Birmingham/.test(txt)
    && /PERSONAL ACCOUNT/.test(txt) && /screenshot only/.test(txt) && /from the athlete's screenshot/.test(txt), txt.slice(0, 1500));
  const night = await IG.nightly(P, { fetch: graph('personal').fetch });
  ok('THE NIGHTLY COUNTS: connected, synced, failed by reason', night.connected >= 3 && night.failedByReason.personal_account >= 1, { connected: night.connected, byReason: night.failedByReason });
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
