'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/kitbranding.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE MEDIA KIT: THE AGENCY'S LETTERHEAD, THE ATHLETE'S PHOTO, A COUNTED FOOTER
// A real server, real pages, real database. An account that never set a brand
// renders the kit exactly as before (checked against the committed page); a
// branded one carries its logo as letterhead, its name exactly as typed, a
// readable accent and the inquiry button, its name exactly as typed; one account's brand never reaches
// another's kit; a footer click is logged once; the photo falls back cleanly;
// Total Reach shows only when it adds two platforms up.
const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store.js');
const AB = require(REPO + 'server/services/agencyBrand.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const A = 'kb-agent-a', B = 'kb-agent-b', PASS = 'kb-pass-1';
// A 1x1 PNG, as the existing upload path stores it.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mNk+M/AwMDAxMDAwMDAAAAPAQEBmwQGWgAAAABJRU5ErkJggg==';
async function freePort() { return new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); }); }

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM media_kit_footer_clicks WHERE kit_slug LIKE 'kb-%'`).catch(() => {});
    await P.query(`DELETE FROM media_kit_views WHERE kit_slug LIKE 'kb-%'`).catch(() => {});
    await P.query(`DELETE FROM media_kits WHERE slug LIKE 'kb-%'`).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE id LIKE 'kb-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id IN ($1,$2)`, [A, B]).catch(() => {});
  };
  await clean();
  const hash = await bcrypt.hash(PASS, 8);
  await P.query(`INSERT INTO users (id, name, email, password, role, plan_tier) VALUES ($1,'Ana Agent','kb-a@x.test',$3,'agent','unlimited'), ($2,'Bob Agent','kb-b@x.test',$3,'agent','unlimited')`, [A, B, hash]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('kb-ath-a',$1,'{"name":"Maya Torres","sport":"Basketball","school":"Auburn University"}'::jsonb),
                 ('kb-ath-b',$2,'{"name":"Jalen Brooks","sport":"Football","school":"Auburn University"}'::jsonb),
                 ('kb-ath-c',$2,'{"name":"Kai Lane","sport":"Soccer","school":"Auburn University"}'::jsonb)`, [A, B]);
  const kit = (slug, ath, extra) => P.query(
    `INSERT INTO media_kits (athlete_id, slug, theme, instagram_followers, tiktok_followers, instagram_engagement, headshot_url, action_shot_data)
     VALUES ($1,$2,'agency',$3,$4,$5,$6,$7)`, [ath, slug, extra.ig || null, extra.tt || null, extra.eng || null, extra.head || null, extra.action || null]);
  await kit('kb-a', 'kb-ath-a', { ig: 12000, eng: '3', head: JPG });         // branded, one platform, a headshot
  await kit('kb-b', 'kb-ath-b', { ig: 5000, tt: 3000 });                      // unbranded, two platforms, no photo
  await kit('kb-c', 'kb-ath-c', { ig: 4000, head: 'http://not-a-data-url.test/x.jpg' });  // a bad photo value

  // ── 1. THE ACCENT CAN NEVER MAKE THE KIT UNREADABLE ───────────────────────
  OUT.push('-- the accent --');
  ok('a neon accent is darkened to 4.5:1 on white, hue kept; a strong one is untouched',
    AB.contrastOnWhite(AB.clampAccent('#FFFF00')) >= 4.5 && AB.clampAccent('#8B0000') === '#8b0000' && AB.contrastOnWhite(AB.clampAccent('#FFFFFF')) >= 4.5);

  const port = await freePort();
  const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'kb-test', CYPRESS_SEED_ON_BOOT: 'off', UNIVERSITY_NIGHTLY: 'off',
      RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy', DATABASE_URL: '' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let srvErr = ''; srv.stderr.on('data', (d) => { srvErr = (srvErr + d).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  let browser = null;
  try {
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/privacy')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    ok('the server boots', up, srvErr.slice(-400));
    const login = async (email) => {
      const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PASS }) });
      return (r.headers.get('set-cookie') || '').split(';')[0];
    };
    const ca = await login('kb-a@x.test'), cb = await login('kb-b@x.test');

    // ── 2. SET ONCE ON THE ACCOUNT, THROUGH THE EXISTING ROUTE ───────────────
    OUT.push('', '-- the account sets it, and only its own --');
    const setA = await fetch(base + '/api/agent/brand', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ca },
      body: JSON.stringify({ name: 'apex sports group', logo: PNG, primaryColor: '#FFFF00', contactEmail: 'deals@apex.test' }) });
    ok('agent A saves a logo, an agency name and an accent', setA.status === 200, setA.status);
    const readB = await (await fetch(base + '/api/agent/brand', { headers: { Cookie: cb } })).json();
    ok('READ PATH: agent B reads only its own brand, which is empty', !JSON.stringify(readB).includes('apex') && !JSON.stringify(readB).includes(PNG.slice(30, 60)), readB);
    const writeB = await fetch(base + '/api/agent/brand', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cb },
      body: JSON.stringify({ name: 'Bob Brand', userId: A, id: A, agentId: A }) });
    const aAfter = (await P.query(`SELECT agency_name, agency_logo FROM users WHERE id = $1`, [A])).rows[0];
    const bAfter = (await P.query(`SELECT agency_name FROM users WHERE id = $1`, [B])).rows[0];
    ok('WRITE PATH: B naming A\'s id in the body changes only B\'s own account', writeB.status === 200 && aAfter.agency_name === 'apex sports group' && aAfter.agency_logo === PNG && bAfter.agency_name === 'Bob Brand', { aAfter: aAfter.agency_name, b: bAfter });
    await P.query(`UPDATE users SET agency_name = NULL WHERE id = $1`, [B]);   // B back to never-branded
    ok('there is no setting for the footer: the brand route cannot turn it off', !/hide_powered_by|hidePoweredBy/.test(fs.readFileSync(REPO + 'server/services/agencyBrand.js', 'utf8').split('function validate')[1].split('\n}')[0]));
    const flag = (await P.query(`SELECT hide_powered_by FROM users WHERE id = $1`, [A])).rows[0];
    ok('the account carries hide_powered_by, default false', flag && flag.hide_powered_by === false);

    // ── 3. THE PAGES ──────────────────────────────────────────────────────────
    let chromium;
    try { chromium = require(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch (_) {}
    if (!chromium) ok('playwright is available to render the kit', false);
    else {
      browser = await chromium.launch();
      const OLD_PAGE = execSync('git show HEAD:public/media-kit.html', { cwd: REPO }).toString();
      const render = async (slug, opts = {}) => {
        const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.route('**/*', (route) => {
          const u = new URL(route.request().url());
          if (u.host !== `127.0.0.1:${port}`) return route.fulfill({ status: 204, body: '' });
          if (opts.oldPage && u.pathname === '/media-kit/' + slug) return route.fulfill({ contentType: 'text/html', body: OLD_PAGE });
          return route.continue();
        });
        await page.goto(`${base}/media-kit/${slug}`);
        await page.waitForTimeout(1200);
        const g = await page.evaluate(() => {
          const vis = (id) => { const e = document.getElementById(id); return !!(e && e.offsetParent !== null && getComputedStyle(e).display !== 'none'); };
          const lhLogo = document.getElementById('mk-lh-logo');
          return {
            text: document.getElementById('mk-content') ? document.getElementById('mk-content').innerText : document.body.innerText,
            letterhead: vis('mk-letterhead'), lhLogo: lhLogo ? lhLogo.getAttribute('src') : null, lhLogoVisible: vis('mk-lh-logo'),
            lhLogoHeight: lhLogo ? lhLogo.getBoundingClientRect().height : 0,
            lhName: (document.getElementById('mk-lh-name') || {}).textContent || '',
            footerHref: (document.getElementById('mk-powered-link') || document.querySelector('.mk-powered a') || {}).getAttribute
              ? (document.getElementById('mk-powered-link') || document.querySelector('.mk-powered a')).getAttribute('href') : null,
            powered: (document.querySelector('.mk-powered') || {}).innerText || '',
            heroBg: getComputedStyle(document.getElementById('mk-hero')).backgroundImage,
            avatar: vis('mk-avatar-wrap') ? document.getElementById('mk-avatar-wrap').innerHTML : '',
            mono: vis('mk-hero-mono'),
            accent: document.getElementById('mk-card').style.getPropertyValue('--accent').trim(),
            contact: (document.getElementById('mk-contact-btn') || {}).innerText || '',
            reach: /total reach/i.test(document.body.innerText),
          };
        });
        await page.close();
        return { ...g, errors };
      };

      OUT.push('', '-- an account that never set a brand: the kit as it is today --');
      const bNew = await render('kb-b'), bOld = await render('kb-b', { oldPage: true });
      const norm = (t) => t.replace(/\s+/g, ' ').trim();
      ok('the unbranded kit reads exactly as the committed page renders it, word for word', norm(bNew.text) === norm(bOld.text) && !bNew.errors.length,
        { new: norm(bNew.text).slice(0, 300), old: norm(bOld.text).slice(0, 300), errors: bNew.errors });
      ok('  no letterhead, no logo; the hero is the gradient and initials, as today', !bNew.letterhead && !/url\(/.test(bNew.heroBg) && bNew.mono, bNew);
      ok('  "Powered by NILDash" in the footer, now a counted link to mynildash.com', /Powered by NILDash/.test(bNew.powered) && bNew.footerHref === '/go/kit-footer/kb-b', bNew.footerHref);

      OUT.push('', '-- a branded account --');
      const a = await render('kb-a');
      ok('the logo is the letterhead: the primary mark at the top, letterhead size, not a badge', a.letterhead && a.lhLogoVisible && a.lhLogo === PNG && a.lhLogoHeight >= 40, { lh: a.letterhead, h: a.lhLogoHeight });
      ok('  the agency name exactly as the agent typed it ("apex sports group"), never rewritten', a.lhName === 'apex sports group' && !/Apex Sports Group/.test(a.text), a.lhName);
      ok('  the accent is the agency\'s, clamped readable (#FFFF00 -> ' + AB.clampAccent('#FFFF00') + ')', a.accent === AB.clampAccent('#FFFF00'), a.accent);
      ok('  "Powered by NILDash" stays in the footer, a counted link', /Powered by NILDash/.test(a.powered) && a.footerHref === '/go/kit-footer/kb-a', a.footerHref);
      ok('  the inquiry button names the agency, as typed', /Contact apex sports group/.test(a.contact), a.contact);
      ok('the headshot is the hero\'s main visual, not a small circle', /url\("?data:image/.test(a.heroBg) && !a.avatar && !a.mono, { bg: a.heroBg.slice(0, 40), avatar: a.avatar });
      ok('engagement reads "3% engagement", not "3 engagement"', /3% engagement/.test(a.text) && !/\b3 engagement/.test(a.text), a.text.match(/.{0,10}engagement.{0,10}/));
      ok('one platform: Total Reach is hidden; two: it shows', !a.reach && bNew.reach);
      ok('  no script error', !a.errors.length, a.errors);

      OUT.push('', '-- one account\'s brand never on another\'s kit --');
      const bApi = await (await fetch(base + '/api/media-kit/kb-b')).json();
      ok('B\'s kit, page and API, carries nothing of A\'s brand', !/Apex|apex/.test(bNew.text) && !JSON.stringify(bApi).includes('apex') && !JSON.stringify(bApi).includes(PNG.slice(30, 60)) && bNew.accent !== AB.clampAccent('#FFFF00'));

      OUT.push('', '-- the photo falls back cleanly --');
      const c = await render('kb-c');
      ok('a photo value that is not an uploaded image: the gradient and initials, no error', !/url\(/.test(c.heroBg) && c.mono && !c.errors.length, { bg: c.heroBg, errors: c.errors });
    }

    // ── 4. THE FOOTER CLICK IS LOGGED ONCE ────────────────────────────────────
    OUT.push('', '-- the footer click --');
    const click = (cookie) => fetch(base + '/go/kit-footer/kb-a?for=acme-corp', { redirect: 'manual', headers: Object.assign({ 'User-Agent': 'kb-brand-browser' }, cookie ? { Cookie: cookie } : {}) });
    const r1 = await click();
    const rows1 = (await P.query(`SELECT * FROM media_kit_footer_clicks WHERE kit_slug = 'kb-a'`)).rows;
    ok('a click redirects to mynildash.com and logs which agency, which athlete, when', r1.status === 302 && /^https:\/\/mynildash\.com\//.test(r1.headers.get('location'))
      && rows1.length === 1 && rows1[0].agent_id === A && rows1[0].athlete_id === 'kb-ath-a' && rows1[0].clicked_at && rows1[0].variant === 'acme-corp', rows1);
    await click();
    ok('  logged once: the same click again a moment later is not a second visit', (await P.query(`SELECT COUNT(*)::int n FROM media_kit_footer_clicks WHERE kit_slug = 'kb-a'`)).rows[0].n === 1);
    await click(ca);
    ok('  the agent clicking their own kit is not a brand-side visit', (await P.query(`SELECT COUNT(*)::int n FROM media_kit_footer_clicks WHERE kit_slug = 'kb-a'`)).rows[0].n === 1);
    const r404 = await fetch(base + '/go/kit-footer/kb-nope', { redirect: 'manual' });
    ok('  an unknown kit still redirects, and logs nothing', r404.status === 302 && (await P.query(`SELECT COUNT(*)::int n FROM media_kit_footer_clicks WHERE kit_slug = 'kb-nope'`)).rows[0].n === 0);

    // ── 4b. THE BUILDERS' PREVIEWS SHOW WHAT THE PUBLIC KIT SHOWS ────────────
    const pages = ['public/media-kit.html', 'public/index.html', 'public/athlete-dashboard.html'].map((f) => [f, fs.readFileSync(REPO + f, 'utf8')]);
    ok('no renderer of the kit prints a unitless "eng." or a "Rate card coming soon" placeholder',
      pages.every(([, src]) => !/' eng\.<\/div>'/.test(src) && !/Rate card coming soon/.test(src)), pages.filter(([, src]) => /' eng\.<\/div>'|Rate card coming soon/.test(src)).map(([f]) => f));
    const vm = require('vm');
    const fnSrc = (src) => { const i = src.indexOf('function mkEngagementLabel'); return src.slice(i, src.indexOf('\n  }\n', i) + 4); };
    ok('  both builders\' previews label engagement as a percent ("3" -> "3% engagement", "4.2%" stays 4.2%)',
      ['public/index.html', 'public/athlete-dashboard.html'].every((f) => {
        const ctx = {}; vm.runInNewContext(fnSrc(fs.readFileSync(REPO + f, 'utf8')) + '; this.f = mkEngagementLabel;', ctx);
        return ctx.f('3') === '3% engagement' && ctx.f('4.2%') === '4.2% engagement' && ctx.f('') === '';
      }));

    // ── 5. THE INQUIRY GOES TO THE AGENCY ─────────────────────────────────────
    const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    ok('an athlete on an agency roster is contacted through the agency\'s contact, never the athlete\'s own email',
      /const toEmail = mk\.agent_id\s*\? \(agencyContact \|\| ath\.agent_email/.test(IDX) && /brandForUser\(\(await store\.getUser\(mk\.agent_id\)\)/.test(IDX));
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
