'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/kitpreview.js    just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── ONE KIT RENDERER: THE BUILDERS' PREVIEWS ARE THE PUBLIC PAGE ────────────
// A real server, real pages, real database.
//   1. The preview endpoints (agent and athlete) return exactly what the
//      public API returns for the same kit, and write nothing.
//   2. The page in preview mode renders the same text as a brand's visit, and
//      records no view.
//   3. Audience numbers in three states: verified (connected Instagram, with
//      the date), self-reported (typed; labelled), empty (absent; no numbers
//      at all, no section).
//   4. "What you get": deliverables, a price in three shapes or none, an ask;
//      absent when empty.
//   5. The athlete as a person: hometown, class year, major, a line in their
//      own words, up to three past partners; each absent when empty.
//   6. Both builders frame the page and have no renderer of their own; the
//      athlete builder shows each number's state, live.
const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const A = 'kp-agent-a', PASS = 'kp-pass-1', JWT = 'kp-jwt-secret';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const MKP = require(REPO + 'server/services/mediaKitPayload.js');
  const IGC = require(REPO + 'server/services/instagramConnect.js');
  await MKP.ensureColumns(P); await IGC.ensureTables(P);
  const clean = async () => {
    await P.query(`DELETE FROM media_kit_views WHERE kit_slug LIKE 'kp-%'`).catch(() => {});
    await P.query(`DELETE FROM media_kits WHERE slug LIKE 'kp-%' OR athlete_id LIKE 'kp-%'`).catch(() => {});
    await P.query(`DELETE FROM instagram_stats WHERE athlete_id LIKE 'kp-%'`).catch(() => {});
    await P.query(`DELETE FROM instagram_connections WHERE athlete_id LIKE 'kp-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id LIKE 'kp-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [A]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role, plan_tier, agency_name, subscription_status) VALUES ($1,'Ana Agent','kp-a@x.test',$2,'agent','unlimited','Apex Sports','active')`, [A, await bcrypt.hash(PASS, 8)]);
  const ath = (id, name) => P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3::jsonb)`, [id, A, JSON.stringify({ name, sport: 'Basketball', school: 'Cypress College', position: 'Guard' })]);
  await ath('kp-full', 'Maya Torres'); await ath('kp-bare', 'Kai Lane'); await ath('kp-new', 'Remy Fox');
  // FULL: Instagram connected (verified), TikTok and X typed, every story field.
  await P.query(`INSERT INTO media_kits (athlete_id, slug, theme, instagram_handle, instagram_followers, instagram_engagement, tiktok_handle, tiktok_followers,
                   twitter_followers, bio, headshot_url, deliverables, price_mode, price_low, price_high, ask_line, hometown, class_year, major, bio_line, worked_with)
                 VALUES ('kp-full','kp-full','agency','maya.t',99999,'9','mayatok',48000,2100,'Two-way guard from Anaheim.',$1,
                   '["2 Instagram posts","1 TikTok video","1 in-store appearance"]'::jsonb,'range',1000,2500,'Looking for a local partner for the spring season.',
                   'Anaheim, CA','Sophomore','Kinesiology','I play for the kids in my neighborhood.','["Zaxby''s","Celsius","Local Gym"]'::jsonb)`, [PNG]);
  await P.query(`INSERT INTO instagram_connections (athlete_id, agent_id, username, status) VALUES ('kp-full',$1,'maya.t','connected')`, [A]);
  await P.query(`INSERT INTO instagram_stats (athlete_id, username, fetched_at, followers_count, engagement_rate) VALUES ('kp-full','maya.t','2026-09-30T15:00:00Z',12400,0.034)`);
  // BARE: no numbers, no story at all.
  await P.query(`INSERT INTO media_kits (athlete_id, slug, theme, bio) VALUES ('kp-bare','kp-bare','agency','Point guard.')`);

  // ── 0. THE PAYLOAD, AS A FUNCTION ─────────────────────────────────────────
  OUT.push('-- the payload --');
  const full = await MKP.payloadFor(P, (await P.query(`SELECT * FROM media_kits WHERE slug='kp-full'`)).rows[0]);
  const ig = full.audience.find((a) => a.platform === 'instagram'), tt = full.audience.find((a) => a.platform === 'tiktok'), tw = full.audience.find((a) => a.platform === 'twitter');
  ok('a connected Instagram is VERIFIED, with its own number and date; the typed 99,999 is not used', ig && ig.state === 'verified' && ig.followers === 12400 && ig.engagement === 3.4 && ig.fetchedAt && !JSON.stringify(full).includes('99999'), ig);
  ok('typed TikTok and X are SELF-REPORTED', tt && tt.state === 'self-reported' && tt.followers === 48000 && tw && tw.state === 'self-reported' && tw.followers === 2100, full.audience);
  ok('the raw typed counts and the rate cards are not in the payload', !('instagram_followers' in full) && !('tiktok_followers' in full) && !('twitter_followers' in full) && !('rateCards' in full) && !('variants' in full));
  const bare = await MKP.payloadFor(P, (await P.query(`SELECT * FROM media_kits WHERE slug='kp-bare'`)).rows[0]);
  ok('no numbers: the audience is empty, not zeros', Array.isArray(bare.audience) && bare.audience.length === 0, bare.audience);
  const st = MKP.storyFromBody({ deliverables: ' a \n\n b ', price_mode: 'range', price_low: '$2,500', price_high: '1000', worked_with: ['x', 'y', 'z', 'w'], hometown: '  ' });
  ok('the form is cleaned: blank lines dropped, a backwards range turned round, past partners capped at three, blanks are null',
    JSON.stringify(st.deliverables) === '["a","b"]' && st.price_low === 1000 && st.price_high === 2500 && st.worked_with.length === 3 && st.hometown === null, st);
  ok('  a price with no amount is no price', MKP.storyFromBody({ price_mode: 'exact', price_low: '' }).price_mode === null);

  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'kp-test', ATHLETE_JWT_SECRET: JWT, CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const ca = ((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'kp-a@x.test', password: PASS }) }))
      .headers.get('set-cookie') || '').split(';')[0];
    const tok = (id) => jwt.sign({ id, role: 'athlete', agent_id: A, email: id + '@x.test' }, JWT, { expiresIn: '1h' });

    // ── 1. PREVIEW JSON === PUBLIC JSON, AND NOTHING WRITTEN ──────────────
    OUT.push('', '-- the preview endpoints return the public kit --');
    const pub = await (await fetch(base + '/api/media-kit/kp-full')).json();
    const kitBefore = (await P.query(`SELECT updated_at FROM media_kits WHERE slug='kp-full'`)).rows[0].updated_at;
    const viewsBefore = (await P.query(`SELECT COUNT(*)::int n FROM media_kit_views WHERE kit_slug LIKE 'kp-%'`)).rows[0].n;
    const post = (url, body, headers) => fetch(base + url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
    const agentPrev = await (await post('/api/agent/athlete-media-kit/kp-full/preview', {}, { Cookie: ca })).json();
    const athPrev = await (await post('/api/athlete/media-kit/preview', {}, { Authorization: 'Bearer ' + tok('kp-full') })).json();
    ok('agent preview of the saved kit === GET /api/media-kit/:slug, field for field', JSON.stringify(agentPrev) === JSON.stringify(pub), { a: Object.keys(agentPrev), p: Object.keys(pub) });
    ok('athlete preview of the saved kit === GET /api/media-kit/:slug, field for field', JSON.stringify(athPrev) === JSON.stringify(pub));
    const edited = await (await post('/api/agent/athlete-media-kit/kp-full/preview?photos=0', { tiktok_followers: 51000, ask_line: 'New ask.', hometown: '' }, { Cookie: ca })).json();
    ok('an unsaved edit shows in the preview: the new TikTok number, the new ask, the cleared hometown',
      edited.audience.find((a) => a.platform === 'tiktok').followers === 51000 && edited.ask_line === 'New ask.' && edited.hometown === null, edited);
    ok('  ?photos=0 leaves the photos out of the response', !('headshot_url' in edited) && !('action_shot_data' in edited));
    const kitAfter = (await P.query(`SELECT updated_at, tiktok_followers, ask_line FROM media_kits WHERE slug='kp-full'`)).rows[0];
    const viewsAfter = (await P.query(`SELECT COUNT(*)::int n FROM media_kit_views WHERE kit_slug LIKE 'kp-%'`)).rows[0].n;
    ok('  a preview writes nothing: the kit row is unchanged, and no view is recorded', +kitAfter.updated_at === +kitBefore && kitAfter.tiktok_followers === 48000 && viewsAfter === viewsBefore,
      { kitAfter, viewsBefore, viewsAfter });
    const noKit = await (await post('/api/agent/athlete-media-kit/kp-new/preview', { tiktok_followers: 900 }, { Cookie: ca })).json();
    ok('  an athlete with no saved kit previews from the form alone', noKit.athlete_name === 'Remy Fox' && noKit.audience.length === 1 && noKit.audience[0].state === 'self-reported', noKit);
    const other = await post('/api/agent/athlete-media-kit/kp-full/preview', {}, {});
    ok('  the agent preview needs the agent\'s session; the athlete one needs the athlete\'s token',
      other.status === 401 && (await post('/api/athlete/media-kit/preview', {}, {})).status === 401, other.status);

    // ── 2. SAVE CARRIES THE NEW FIELDS ─────────────────────────────────────
    OUT.push('', '-- the saves --');
    const sv = await post('/api/athlete/media-kit/save', { bio: 'Bare bio.', class_year: 'Junior', deliverables: ['1 post'], price_mode: 'from', price_low: 300 }, { Authorization: 'Bearer ' + tok('kp-bare') });
    const bareRow = (await P.query(`SELECT class_year, deliverables, price_mode, price_low, hometown FROM media_kits WHERE athlete_id='kp-bare'`)).rows[0];
    ok('the athlete save stores the new fields', sv.status === 200 && bareRow.class_year === 'Junior' && JSON.stringify(bareRow.deliverables) === '["1 post"]' && bareRow.price_mode === 'from' && bareRow.price_low === 300, bareRow);
    const sa = await post('/api/agent/athlete-media-kit/kp-bare', { bio: 'Bare bio.', class_year: '', deliverables: [], price_mode: '' }, { Cookie: ca });
    const bareRow2 = (await P.query(`SELECT class_year, deliverables, price_mode FROM media_kits WHERE athlete_id='kp-bare'`)).rows[0];
    ok('the agent save stores them too, and clearing a field clears it', sa.status === 200 && bareRow2.class_year === null && bareRow2.deliverables === null && bareRow2.price_mode === null, { status: sa.status, body: await sa.text(), bareRow2 });

    // ── 3-5. THE PAGE ──────────────────────────────────────────────────────
    let chromium;
    try { chromium = require(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch (_) {}
    if (!chromium) ok('playwright is available to render the kit', false);
    else {
      browser = await chromium.launch();
      const grab = () => ({
        text: document.getElementById('mk-content').innerText,
        stats: document.getElementById('mk-stats-section').style.display !== 'none' && !!document.querySelector('#mk-stats .mk-stat'),
        get: document.getElementById('mk-get-section').style.display !== 'none',
        facts: document.getElementById('mk-facts').style.display !== 'none' ? document.getElementById('mk-facts').innerText : '',
        tiles: Array.prototype.map.call(document.querySelectorAll('#mk-stats .mk-stat'), (t) => ({ state: t.getAttribute('data-state'), cls: t.className, text: t.innerText.replace(/\s+/g, ' ') })),
      });
      const open = async (slug) => {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (r) => (new URL(r.request().url()).host !== `127.0.0.1:${port}` ? r.fulfill({ status: 204, body: '' }) : r.continue()));
        await page.goto(`${base}/media-kit/${slug}`);
        await page.waitForTimeout(900);
        const g = await page.evaluate(grab); await page.close();
        return { ...g, errors };
      };
      const preview = async (kit) => {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        const calls = []; page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) calls.push(u.pathname); });
        await page.route('**/*', (r) => (new URL(r.request().url()).host !== `127.0.0.1:${port}` ? r.fulfill({ status: 204, body: '' }) : r.continue()));
        await page.goto(`${base}/media-kit/_preview?preview=1`);
        await page.waitForTimeout(300);
        await page.evaluate((k) => window.postMessage({ type: 'mk-preview', kit: k }, location.origin), kit);
        await page.waitForTimeout(500);
        const g = await page.evaluate(grab);
        await page.click('#mk-contact-btn').catch(() => {});
        const modal = await page.evaluate(() => getComputedStyle(document.getElementById('contact-modal')).display);
        // A second, different kit: the page starts over (render hides sections).
        await page.evaluate((k) => window.postMessage({ type: 'mk-preview', kit: k }, location.origin), Object.assign({}, kit, { audience: [], deliverables: null, price_mode: null, ask_line: null }));
        await page.waitForTimeout(300);
        const g2 = await page.evaluate(grab);
        await page.evaluate((k) => window.postMessage({ type: 'mk-preview', kit: k }, location.origin), kit);
        await page.waitForTimeout(300);
        const g3 = await page.evaluate(grab);
        await page.close();
        return { ...g, errors, calls, modal, second: g2, third: g3 };
      };

      OUT.push('', '-- preview mode renders the public page --');
      const pubFull = await open('kp-full');
      const pv = await preview(pub);
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      ok('the page in preview mode, given the preview payload, reads exactly as a brand\'s visit, word for word', norm(pv.text) === norm(pubFull.text) && !pv.errors.length,
        { pv: norm(pv.text).slice(0, 300), pub: norm(pubFull.text).slice(0, 300), errors: pv.errors });
      ok('  preview mode fetches nothing and records nothing', pv.calls.length === 0, pv.calls);
      ok('  its buttons do nothing (no inquiry form opens)', pv.modal === 'none', pv.modal);
      ok('  each update starts from the page as served: a section hidden for one kit comes back for the next',
        !pv.second.stats && !pv.second.get && pv.third.stats && pv.third.get && norm(pv.third.text) === norm(pv.text));

      OUT.push('', '-- the audience, three states --');
      const igT = pubFull.tiles.find((t) => /instagram/i.test(t.text)), ttT = pubFull.tiles.find((t) => /tiktok/i.test(t.text)), xT = pubFull.tiles.find((t) => /^X /.test(t.text));
      ok('VERIFIED: Instagram reads "Verified by NILDash" with the date pulled, and the connected number (12.4K), not the typed one',
        igT && igT.state === 'verified' && /Verified by NILDash · Sep 30, 2026/.test(igT.text) && /12\.4K/.test(igT.text) && !/100K|99\.9K|99,999/.test(pubFull.text), igT);
      ok('SELF-REPORTED: TikTok and X are shown, labelled "Self-reported", and quieter (the self style)',
        ttT && ttT.state === 'self-reported' && /Self-reported/.test(ttT.text) && /\bself\b/.test(ttT.cls) && xT && /Self-reported/.test(xT.text) && !/Verified/.test(ttT.text + xT.text), { ttT, xT });
      ok('  Total Reach says it includes self-reported counts', /Total Reach[\s\S]*Includes self-reported counts/i.test(pubFull.text));
      const pubBare = await open('kp-bare');
      ok('EMPTY: no platform has a number, so there is no audience section at all', !pubBare.stats && !/The Audience|Total Reach|Instagram|TikTok/i.test(pubBare.text), pubBare.text);
      const oneSelf = await preview(Object.assign({}, pub, { audience: [{ platform: 'tiktok', followers: 900, state: 'self-reported' }] }));
      ok('  one platform present, the others are absent (no dashes, no zeros)', oneSelf.tiles.length === 1 && !/—|--|\b0\b/.test(oneSelf.tiles[0].text), oneSelf.tiles);

      OUT.push('', '-- what you get --');
      ok('deliverables, the range, and the ask, in a "What You Get" section', pubFull.get && /What You Get[\s\S]*2 Instagram posts[\s\S]*1 in-store appearance[\s\S]*\$1,000–\$2,500[\s\S]*Looking for a local partner/i.test(pubFull.text), pubFull.text.slice(0, 600));
      const shapes = await Promise.all([
        preview(Object.assign({}, pub, { price_mode: 'exact', price_low: 1500, price_high: null })),
        preview(Object.assign({}, pub, { price_mode: 'from', price_low: 500, price_high: null })),
        preview(Object.assign({}, pub, { price_mode: null, price_low: null, price_high: null })),
        preview(Object.assign({}, pub, { deliverables: null, price_mode: null, price_low: null, ask_line: null })),
      ]);
      ok('  a number reads $1,500; "packages from" reads Packages from $500', /Investment\s*\$1,500/.test(shapes[0].text) && /Packages from\s*\$500/.test(shapes[1].text), [shapes[0].text.slice(0, 300)]);
      ok('  no price: the deliverables with no price and no "$" anywhere in the section', shapes[2].get && /2 Instagram posts/.test(shapes[2].text) && !/\$/.test(shapes[2].text));
      ok('  nothing filled in: no section, and no "Rate card coming soon"', !shapes[3].get && !/What You Get|coming soon/i.test(shapes[3].text));

      OUT.push('', '-- the athlete as a person --');
      ok('class year, major and hometown under the name', pubFull.facts === 'Sophomore  ·  Kinesiology major  ·  From Anaheim, CA' || norm(pubFull.facts) === 'Sophomore · Kinesiology major · From Anaheim, CA', pubFull.facts);
      ok('  the line in their own words, attributed to them', /“I play for the kids in my neighborhood\.”\s*— Maya/.test(pubFull.text), pubFull.text.match(/.{0,5}I play.{0,60}/));
      ok('  "Previously worked with" and the three names', /Previously worked with\s*Zaxby's\s*Celsius\s*Local Gym/.test(pubFull.text));
      ok('  none of it on a kit that has none: no facts line, no quote, no "worked with", no placeholder', !pubBare.facts && !/“|Previously worked with|Hometown|Class of|Major/.test(pubBare.text), pubBare.text);
      ok('no script error on any page', !pubFull.errors.length && !pubBare.errors.length && shapes.every((s) => !s.errors.length));

      // ── 6. THE ATHLETE'S BUILDER, LIVE ───────────────────────────────────────
      OUT.push('', '-- the builder frames the page --');
      const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
      const errs = []; page.on('pageerror', (e) => errs.push(e.message + ' @ ' + String(e.stack || '').split('\n').slice(1, 3).join(' | ')));
      await page.route('**/*', (r) => (new URL(r.request().url()).host !== `127.0.0.1:${port}` ? r.fulfill({ status: 204, body: '' }) : r.continue()));
      // The athlete's builder is the main app in athlete mode (athlete-dashboard.html
      // redirects there), where the agent route is rewritten to the athlete one.
      await page.goto(`${base}/?jwt=${encodeURIComponent(tok('kp-full'))}`);
      await page.waitForTimeout(3000);
      await page.evaluate(() => { if (typeof showView === 'function') showView('marketing'); });
      await page.waitForTimeout(800);
      await page.evaluate(() => { if (!amkCurrentAthleteId && typeof amkLoadForAthlete === 'function') amkLoadForAthlete('kp-full'); });
      await page.waitForTimeout(2500);
      const frameText = async () => { const f = page.frames().find((fr) => /\/media-kit\/_preview/.test(fr.url())); return f ? f.evaluate(() => document.getElementById('mk-content').innerText) : null; };
      const t1 = await frameText();
      const states = await page.evaluate(() => ['instagram', 'tiktok', 'twitter'].map((k) => (document.getElementById('kb-state-' + k) || {}).innerText || ''));
      ok('the athlete builder frames /media-kit/_preview and it shows the saved kit as a brand sees it', t1 && norm(t1) === norm(pubFull.text), { url: page.url(), active: await page.evaluate(() => (document.querySelector('.view.active') || {}).id), t1: t1 && norm(t1).slice(0, 200), errs });
      ok('  each number\'s state, next to it: Instagram verified (typed number not used), TikTok and X self-reported',
        /^Verified/.test(states[0]) && /not used/.test(states[0]) && /^Self-reported/.test(states[1]) && /can't be connected yet/.test(states[1]) && /^Self-reported/.test(states[2]), states);
      await page.fill('#mk-tw-followers', '');
      await page.fill('#kb-ask', 'Typed just now.');
      await page.dispatchEvent('#mk-tw-followers', 'input'); await page.dispatchEvent('#kb-ask', 'input');
      await page.waitForTimeout(1500);
      const t2 = await frameText();
      const st2 = await page.evaluate(() => (document.getElementById('kb-state-twitter') || {}).innerText || '');
      ok('  typing updates the framed page and the label: X cleared -> "Empty", gone from the kit; the new ask shows',
        /^Empty/.test(st2) && t2 && !/\bX\b[\s\S]{0,20}2\.1K/.test(t2) && /Typed just now\./.test(t2), { st2, t2: t2 && norm(t2).slice(0, 400) });
      ok('  no script error in the builder', !errs.length, errs);
      await page.close();
    }

    // ── 7. NO SECOND RENDERER ──────────────────────────────────────────────
    OUT.push('', '-- one renderer --');
    const src = (f) => fs.readFileSync(REPO + f, 'utf8');
    const builders = ['public/index.html', 'public/athlete-dashboard.html'];
    ok('both builders load public/kit-builder.js and frame the page', builders.every((f) => /<script src="\/kit-builder\.js"><\/script>/.test(src(f))) && /\/media-kit\/_preview\?preview=1/.test(src('public/kit-builder.js')));
    ok('  neither builder has a kit renderer of its own (no platform boxes, no preview HTML, no "Rate card coming soon")',
      builders.every((f) => !/mkPlatformBox|getElementById\('mk-preview'\)\.innerHTML|prev\.innerHTML = html|Rate card coming soon|WORK WITH ME/.test(src(f))));
    ok('  the public route and both preview routes build the kit with the one function',
      (src('server/index.js').match(/mediaKitPayload'\)\.payloadFor\(|MKP\.payloadFor\(/g) || []).length >= 2 && /async function _mkPreview/.test(src('server/index.js')));
  } finally {
    if (browser) await browser.close().catch(() => {});
    srv.kill();
  }
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
