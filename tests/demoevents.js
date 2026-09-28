'use strict';
// Runs against the local test Postgres. No network: the browser part serves
// public/demo.html itself and blocks every outside request.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/demoevents.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THE DEMO PAGE'S ANALYTICS ───────────────────────────────────────────────
// A table with nothing personal in it, a public endpoint that answers 204 and
// never blocks the page, a report at /api/admin/scripts/demo-stats, and the
// snippet the page pastes in -- run against the real page in a browser.
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const DE = require(REPO + 'server/services/demoEvents.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const SID = (n) => 'test-demo-session-' + n;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = () => P.query(`DELETE FROM demo_events`).catch(() => {});

  // ── 1. THE TABLE ──────────────────────────────────────────────────────────
  OUT.push('-- the table --');
  const cols = (await P.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'demo_events' ORDER BY column_name`)).rows.map((r) => r.column_name);
  ok('demo_events has exactly the eight columns asked for',
    JSON.stringify(cols) === JSON.stringify(['country', 'created_at', 'device', 'event', 'id', 'referrer', 'screen', 'session_id']), cols);
  ok('  and no column that could hold an IP address', !cols.some((c) => /ip|addr|agent|ua/.test(c)));

  // ── 2. WHAT A ROW IS MADE OF ──────────────────────────────────────────────
  OUT.push('', '-- device, referrer, country --');
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15';
  ok('device: iPhone is mobile, a Mac is desktop, an iPad is a tablet, LinkedIn\'s crawler is a bot',
    DE.deviceOf(IPHONE) === 'mobile' && DE.deviceOf(MAC) === 'desktop' && DE.deviceOf(IPAD) === 'tablet'
    && DE.deviceOf('LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)') === 'bot');
  ok('referrer: a LinkedIn link (either domain) is "linkedin"',
    DE.sourceOf('https://www.linkedin.com/feed/') === 'linkedin' && DE.sourceOf('https://lnkd.in/abc123') === 'linkedin');
  ok('  utm_source wins, and names it', DE.sourceOf('https://www.google.com/', 'linkedin') === 'linkedin' && DE.sourceOf('', 'newsletter') === 'utm:newsletter');
  ok('  no referrer is "direct"; an unknown site is its bare host, never the full URL',
    DE.sourceOf('') === 'direct' && DE.sourceOf('https://www.example.org/some/path?who=jane@x.com') === 'example.org');
  ok('country: a CDN header is read, a bad or unknown value is not',
    DE.countryOf({ 'cf-ipcountry': 'us' }) === 'US' && DE.countryOf({ 'cf-ipcountry': 'XX' }) === null && DE.countryOf({}) === null);
  ok('  and it never looks at an IP header', DE.countryOf({ 'x-forwarded-for': '203.0.113.9' }) === null);

  const row = DE.rowFrom({ session_id: SID(1), event: 'view', screen: 'home', ref: 'https://www.linkedin.com/', ip: '1.2.3.4' },
    { 'user-agent': IPHONE, 'x-forwarded-for': '203.0.113.9', 'cf-ipcountry': 'CA' });
  ok('a view becomes a row with source, device and country, and nothing else',
    row && row.referrer === 'linkedin' && row.device === 'mobile' && row.country === 'CA'
    && JSON.stringify(Object.keys(row).sort()) === JSON.stringify(['country', 'device', 'event', 'referrer', 'screen', 'session_id']), row);
  ok('  the IP it was handed is nowhere in it', !JSON.stringify(row).includes('203.0.113.9') && !JSON.stringify(row).includes('1.2.3.4'));
  ok('only a view carries the referrer', DE.rowFrom({ session_id: SID(1), event: 'screen', screen: 'deals', ref: 'https://linkedin.com' }, {}).referrer === null);
  ok('an event the page would not send is dropped', DE.rowFrom({ session_id: SID(1), event: 'drop_table' }, {}) === null);
  ok('  and so is a malformed session id', DE.rowFrom({ session_id: 'x', event: 'view' }, {}) === null
    && DE.rowFrom({ session_id: "a'; DROP TABLE demo_events;--", event: 'view' }, {}) === null);
  ok('  a screen that is not a plain id is kept as null, not stored raw',
    DE.rowFrom({ session_id: SID(1), event: 'screen', screen: '<script>alert(1)</script>' }, {}).screen === null);

  // ── 3. SPAM LIMITS ────────────────────────────────────────────────────────
  OUT.push('', '-- spam --');
  DE._reset();
  let allowed = 0;
  for (let i = 0; i < DE.PER_SESSION_MAX + 50; i++) if (DE.allow({ session_id: SID('flood') }, 1000)) allowed++;
  ok('one session cannot write more than its cap', allowed === DE.PER_SESSION_MAX, allowed);
  DE._reset();
  let many = 0;
  for (let i = 0; i < DE.GLOBAL_PER_MINUTE + 100; i++) if (DE.allow({ session_id: SID('g' + i) }, 5000)) many++;
  ok('many sessions together cannot pass the per-minute ceiling', many === DE.GLOBAL_PER_MINUTE, many);
  ok('  and the ceiling reopens the next minute', DE.allow({ session_id: SID('next') }, 5000 + 61000) === true);
  DE._reset();

  // ── 4. THE WRITE NEVER THROWS ─────────────────────────────────────────────
  OUT.push('', '-- the write --');
  await clean();
  ok('a good event is written', await DE.record(P, { session_id: SID(2), event: 'view', ref: '' }, { 'user-agent': MAC }) === true);
  ok('a bot is not written at all', await DE.record(P, { session_id: SID(3), event: 'view' }, { 'user-agent': 'Googlebot/2.1' }) === false);
  const broken = { query: async () => { throw new Error('database is down'); } };
  let threw = false;
  try { await DE.record(broken, { session_id: SID(4), event: 'view' }, {}); } catch (_) { threw = true; }
  ok('a database error is swallowed, not thrown', threw === false);
  ok('garbage in the body is swallowed too', await DE.record(P, 'not json', {}) === false && await DE.record(P, null, null) === false);

  // ── 5. THE ROUTE ──────────────────────────────────────────────────────────
  OUT.push('', '-- the route --');
  const IDX = read('server/index.js');
  const at = IDX.indexOf("app.post('/api/demo/event'");
  const route = IDX.slice(at, at + 260);
  ok('POST /api/demo/event exists, rate limited, with no auth in front of it',
    /app\.post\('\/api\/demo\/event', demoEventLimiter, \(req, res\) => \{/.test(route), route);
  ok('  it answers 204 BEFORE the row is written', route.indexOf('res.status(204).end()') < route.indexOf('.record('), route);
  ok('  and the limiter answers 204 too, so a limited page sees nothing',
    /const demoEventLimiter = rateLimit\(\{[\s\S]{0,200}handler: \(req, res\) => res\.status\(204\)\.end\(\)/.test(IDX));
  ok('  and it sits above the /api catch-all', at > 0 && at < IDX.indexOf("app.use('/api', (req, res) =>"));
  ok('demo-stats is registered with the admin script runner', /'demo-stats': \{ file: 'scripts\/demo-stats\.js'/.test(IDX));

  // ── 6. THE REPORT ─────────────────────────────────────────────────────────
  OUT.push('', '-- demo-stats --');
  await clean();
  const ins = (sid, event, screen, ref, secondsAgo, device) => P.query(
    `INSERT INTO demo_events (session_id, event, screen, referrer, device, created_at)
     VALUES ($1,$2,$3,$4,$5, NOW() - ($6 || ' seconds')::interval)`, [sid, event, screen, ref, device || 'desktop', String(secondsAgo)]);
  // A: LinkedIn, 3 minutes, ran a scan, opened and approved a pitch, booked.
  await ins(SID('a'), 'view', 'home', 'linkedin', 200);
  await ins(SID('a'), 'screen', 'deals', null, 190);
  await ins(SID('a'), 'deal_scan', 'deals', null, 180);
  await ins(SID('a'), 'pitch_open', 'deals', null, 150);
  await ins(SID('a'), 'pitch_approve', 'home', null, 100);
  await ins(SID('a'), 'book_call', 'home', null, 30);
  await ins(SID('a'), 'book_call', 'home', null, 25);
  await ins(SID('a'), 'leave', 'home', null, 20);        // span 180s
  // B: LinkedIn, 1 minute, looked at two screens.
  await ins(SID('b'), 'view', 'home', 'linkedin', 400, 'mobile');
  await ins(SID('b'), 'screen', 'deals', null, 380, 'mobile');
  await ins(SID('b'), 'screen', 'pipeline', null, 340, 'mobile');   // span 60s
  // C: direct, glanced and left.
  await ins(SID('c'), 'view', 'home', 'direct', 500);                // span 0
  let rep = '';
  try {
    rep = execFileSync(process.execPath, [REPO + 'scripts/demo-stats.js'],
      { encoding: 'utf8', env: { ...process.env, INIT_WAIT_MS: '5000' }, timeout: 90000 });
  } catch (e) { rep = String(e.stdout || '') + String(e.stderr || ''); }
  ok('visits today, this week and all time', /today\s+3/.test(rep) && /this week \(from Mon\)\s+3/.test(rep) && /all time\s+3/.test(rep), rep.slice(0, 500));
  ok('visits by referrer, LinkedIn named', /linkedin\s+2\s+2/.test(rep) && /direct\s+1\s+1/.test(rep), (rep.match(/VISITS BY REFERRER[\s\S]*?\n\n/) || [])[0]);
  ok('most viewed screens', /deals\s+2\s+2/.test(rep) && /pipeline\s+1\s+1/.test(rep), (rep.match(/MOST VIEWED SCREENS[\s\S]*?\n\n/) || [])[0]);
  ok('ran a Deal Scan, opened a pitch, approved a pitch',
    /ran a Deal Scan\s+1\s+33\.3%/.test(rep) && /opened a pitch\s+1\s+33\.3%/.test(rep) && /approved a pitch\s+1\s+33\.3%/.test(rep),
    (rep.match(/WHAT VISITORS DID[\s\S]*?\n\n/) || [])[0]);
  ok('clicked Book a call, as visits and as clicks', /clicked Book a call\s+1\s+33\.3%\s+\(2 clicks\)/.test(rep), (rep.match(/clicked Book a call.*/) || [])[0]);
  ok('median time on page, over every visit and over visits that stayed',
    /median, every visit\s+1m 00s/.test(rep) && /median, visits that stayed\s+2m 00s/.test(rep) && /only one event\s+1 of 3/.test(rep),
    (rep.match(/TIME ON PAGE[\s\S]*?\n\n/) || [])[0]);
  ok('device and country lines, and it says when no country reaches the app',
    /DEVICE\s+desktop 2, mobile 1/.test(rep) && /no country header reaches the app/.test(rep));
  await clean();

  // ── 7. THE SNIPPET, ON THE REAL PAGE ──────────────────────────────────────
  OUT.push('', '-- the snippet, in a browser, on public/demo.html --');
  const SNIPPET = read('docs/demo-analytics-snippet.html');
  ok('the snippet is one script block, with no stray closing tag inside it',
    (SNIPPET.match(/<script>/g) || []).length === 1 && (SNIPPET.match(/<\/script>/g) || []).length === 1 && SNIPPET.trim().endsWith('</script>'));
  ok('  it posts only to /api/demo/event', (SNIPPET.match(/\/api\/[a-z0-9/_-]+/gi) || []).every((u) => u === '/api/demo/event'));
  ok('  and every send is wrapped so it cannot throw into the page', /function send\(event, extra\) \{\s*try \{/.test(SNIPPET));
  let pw = null;
  try { pw = require(_tp.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch (_) { pw = null; }
  if (!pw) {
    OUT.push('SKIP the browser run: playwright is not installed globally on this machine');
  } else {
    const page0 = read('public/demo.html') + '\n' + SNIPPET;
    const events = [];
    const browser = await pw.chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', async (r) => {
        const u = new URL(r.request().url());
        if (u.hostname !== 'demo.test') return r.abort();
        if (u.pathname === '/demo') return r.fulfill({ status: 200, contentType: 'text/html', body: page0 });
        if (u.pathname === '/api/demo/event') {
          try { events.push(JSON.parse(r.request().postData() || '{}')); } catch (_) {}
          return r.fulfill({ status: 204, body: '' });
        }
        return r.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://demo.test/demo?utm_source=linkedin', { referer: 'https://www.linkedin.com/feed/' });
      await page.waitForTimeout(300);
      await page.click('#nav1 [data-goto="deals"]');
      await page.waitForTimeout(150);
      const crumb = await page.textContent('#crumbNow');
      await page.click('#runScan');
      await page.waitForTimeout(1400);
      const write = await page.$('[data-dsdo="write"], [data-dsdo="ai"]');
      if (write) { await write.click(); await page.waitForTimeout(1100); }
      const sendBtn = await page.$('[data-dsdo="send"]');
      if (sendBtn) { await sendBtn.click(); await page.waitForTimeout(150); }
      await page.click('#nav1 [data-goto="home"]');
      await page.waitForTimeout(150);
      await page.evaluate(() => { const a = document.querySelector('a.book'); a.addEventListener('click', (e) => e.preventDefault()); a.click(); });
      await page.waitForTimeout(300);
      const kinds = events.map((e) => e.event);
      ok('the page still works with it: Deal Scan opens', crumb === 'Deal Scan', crumb);
      ok('  and throws nothing', errors.length === 0, errors);
      ok('view, with where it came from', events[0] && events[0].event === 'view' && events[0].utm === 'linkedin'
        && /linkedin\.com/.test(events[0].ref || ''), events[0]);
      ok('screen, with the screen it opened', events.some((e) => e.event === 'screen' && e.screen === 'deals'), kinds);
      ok('deal_scan, pitch_open and pitch_approve', ['deal_scan', 'pitch_open', 'pitch_approve'].every((k) => kinds.includes(k)), kinds);
      ok('book_call', kinds.includes('book_call'), kinds);
      ok('one session id across the whole visit', new Set(events.map((e) => e.session_id)).size === 1
        && /^[A-Za-z0-9_-]{8,64}$/.test(events[0].session_id), [...new Set(events.map((e) => e.session_id))]);
      ok('every event would pass the server\'s own check', events.every((e) => DE.rowFrom(e, {}) !== null),
        events.filter((e) => DE.rowFrom(e, {}) === null));

      // THE ENDPOINT DOWN MUST NOT MATTER.
      const page2 = await ctx.newPage();
      const errs2 = [];
      page2.on('pageerror', (e) => errs2.push(e.message));
      await page2.route('**/*', (r) => {
        const u = new URL(r.request().url());
        if (u.pathname === '/demo' && u.hostname === 'demo.test') return r.fulfill({ status: 200, contentType: 'text/html', body: page0 });
        return r.abort();
      });
      await page2.goto('http://demo.test/demo');
      await page2.click('#nav1 [data-goto="deals"]');
      await page2.waitForTimeout(150);
      ok('with the endpoint unreachable the page works and throws nothing',
        (await page2.textContent('#crumbNow')) === 'Deal Scan' && errs2.length === 0, errs2);
    } finally { await browser.close(); }
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('demoevents: FAILED', e); process.exit(1); });
