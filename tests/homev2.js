'use strict';
// ── THE PUBLIC HOMEPAGE (HOME_V2_ON, services/publicHome) ───────────────────
//
// Logged-out mynildash.com becomes its own page: server/views/home.html. This
// checks, on a fresh database and the real server:
//   1. what the page says, against the rules it was written to (no em dashes,
//      not sold as an AI product, no "built" addresses, no free athlete plan),
//      and each claim against the code that makes it true;
//   2. the fonts load (Syne, DM Mono, Inter, font-display: swap) and every
//      stack falls back to a sans or mono face, never a serif;
//   3. none of the agent portal is in it;
//   4. the live counts: honest labels, zeros hidden, the demo account left out;
//   5. who gets the page at / with the switch on, and that off changes nothing;
//   6. the athlete waitlist and its admin script;
//   7. the hero graphic: a morning card built in HTML, CSS and inline SVG, no
//      pictures anywhere on the page, fictional names;
//   8. at 390px and 1440px wide in a real browser (when Playwright is installed).
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('homev2test', { schema: true });
delete process.env.HOME_V2_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const net = require('net');
const { spawn, execSync } = require('child_process');
const bcrypt = require('bcryptjs');
const store = require(REPO + 'server/store');
const PH = require(REPO + 'server/services/publicHome');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const read = (f) => fs.readFileSync(REPO + f, 'utf8');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

const HTML = read('server/views/home.html');
// What a visitor reads: no comments, scripts or styles, no tags, entities decoded.
const VISIBLE = HTML.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&middot;/g, '·').replace(/&#10003;/g, '✓').replace(/\s+/g, ' ');
const CSS = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
const Q0 = () => require(REPO + 'server/services/outreachQueue');
const section = (id) => { const i = HTML.indexOf(`id="${id}"`); return i < 0 ? '' : HTML.slice(i, HTML.indexOf('</section>', i)); };

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n1. THE COPY');
  ok('no em dash anywhere in the page, in any form', !/—|&mdash;|&#8212;|&#x2014;/i.test(HTML));
  ok('  and no en dash standing in for one', !/–|&ndash;|&#8211;/i.test(HTML));
  ok('not sold as an AI product: no "AI" anywhere a visitor reads', !/\bA\.?I\b/.test(VISIBLE), (VISIBLE.match(/.{30}\bAI\b.{30}/) || [])[0]);
  ok('  and no "AI command center" anywhere in the file', !/command center/i.test(HTML));
  ok('no copy about "built" addresses', !/\bbuilt\b/i.test(VISIBLE) && !/found or built/i.test(HTML));
  ok('no free athlete plan: "Free, no card required" is gone', !/no card required/i.test(HTML) && !/\bFree\b/.test(VISIBLE));
  ok('the hero headline: "Buy back your time."', /<h1 class="h1">Buy back <em>your time<\/em>\.<\/h1>/.test(HTML) && /Buy back your time ?\./.test(VISIBLE));   // the <em> leaves a space when tags are stripped
  ok('  the sub, word for word', /<p class="lede">Every morning, 5 researched deals for every athlete: the right business, the owner or marketing person, a verified email, and a written pitch\. You just approve\.<\/p>/.test(HTML));
  ok('  the title and description say the same', /<title>NILDash \| Buy back your time<\/title>/.test(HTML)
    && /<meta name="description" content="Every morning, 5 researched deals for every athlete: the right business, the owner or marketing person, a verified email, and a written pitch\. You just approve\.">/.test(HTML));
  const hero = HTML.slice(HTML.indexOf('<section class="hero">'), HTML.indexOf('</section>', HTML.indexOf('<section class="hero">')));
  ok('  CTA "Get started" opens agent sign-up', /<a class="btn primary" href="\/\?signin=agent&amp;tab=signup">Get started<\/a>/.test(hero));
  ok('  CTA "Try the interactive demo" goes to the demo', /<a class="btn ghost" href="\/demo">Try the interactive demo<\/a>/.test(hero));
  ok('  and /demo is a real public route', /app\.get\('\/demo'/.test(read('server/index.js')) && fs.existsSync(REPO + 'public/demo.html'));

  console.log('\n   ...where your hours go');
  const hrs = section('hours');
  const ids = [...HTML.matchAll(/<section class="[^"]*" id="([a-z]+)"|<!--HOME_STATS-->/g)].map((m) => m[1] || 'stats');
  ok('"Where your hours go today" comes right after the hero', /<h2 class="h2">Where your hours go today<\/h2>/.test(hrs)
    && HTML.indexOf('id="hours"') > HTML.indexOf('<section class="hero">') && ids[0] === 'hours', ids);
  const items = (cls) => { const c = hrs.slice(hrs.indexOf(`class="col ${cls}"`)); return [...c.slice(0, c.indexOf('</ol>')).matchAll(/<li>(?:<span>)?([^<]+)/g)].map((m) => m[1].trim()); };
  ok('  side by side: by hand, the seven jobs', JSON.stringify(items('byhand')) === JSON.stringify(['Find the business', 'Find the owner', 'Hunt for an email', 'Check it', 'Write the pitch', 'Send', 'Remember to follow up']), items('byhand'));
  ok('  with NILDash: open Home, approve, done', JSON.stringify(items('nild')) === JSON.stringify(['Open Home', 'Approve', 'Done']), items('nild'));
  ok('  laid out as two columns from tablet width, stacked on a phone', /\.vs\{display:grid;gap:12px/.test(CSS) && /@media \(min-width:700px\)\{\s*\.vs\{grid-template-columns:1fr 1fr/.test(CSS));
  ok('no time figures anywhere a visitor reads', !/\d[\d,.]*\s*(min|mins|minutes?|hours?|hrs?|h)\b/i.test(VISIBLE) && !/\b(save|saves|saving)\b[^.]{0,40}\d/i.test(VISIBLE),
    (VISIBLE.match(/.{20}\d[\d,.]*\s*(min|minutes?|hours?|hrs?)\b.{10}/i) || [])[0]);
  ok('THE CALCULATOR IS GONE: "hours a week back" is nowhere in the page, its markup, CSS or script', !/hours a week back/i.test(HTML), (HTML.match(/.{40}hours a week back.{20}/i) || [])[0]);
  ok('  no calculator form, fields, result or script left behind', !/class="calc|id="calc|calc-(ath|min|out|ex|grid|title)|Your hours back|var PITCHES|EXAMPLE = /.test(HTML)
    && !/\.calc\b|\.field\b/.test(CSS));
  ok('  the only inputs left are the athlete waitlist\'s', JSON.stringify((HTML.match(/<input id="([a-z-]+)"/g) || []).map((t) => t.slice(11, -1))) === '["wl-email","wl-website"]',
    HTML.match(/<input id="([a-z-]+)"/g));
  ok('  and the hours section ends with the By hand / With NILDash comparison', /<div class="vs">/.test(hrs) && !/<form/.test(hrs)
    && /<\/ol>\s*<\/div>\s*<\/div>\s*<\/div>$/.test(hrs.trim()), hrs.slice(-120));

  console.log('\n   ...who it\'s for');
  const who = section('who');
  const cards = [...who.matchAll(/<li class="audc" id="([a-z-]+)">([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1], h: (m[2].match(/<h3>([^<]+)<\/h3>/) || [])[1], p: (m[2].match(/<p>([^<]+)<\/p>/) || [])[1], a: (m[2].match(/<a class="btn [a-z]+" href="([^"]+)">([^<]+)<\/a>/) || []).slice(1) }));
  ok('"Who it\'s for": three cards, after where your hours go', /<span class="eyebrow">Who it's for<\/span>/.test(who) && cards.length === 3 && ids.indexOf('who') === 1, { ids, n: cards.length });
  ok('  Agents: 5 researched, verified deals every morning; you approve', cards[0].h === 'Agents' && cards[0].p === 'Every athlete on your roster gets 5 researched, verified deals every morning; you approve.', cards[0]);
  ok('  Universities and athletic departments: sponsors found and pitched, time on relationships', cards[1].h === 'Universities and athletic departments'
    && cards[1].p === 'Local sponsors found and pitched for every team, so your NIL staff spends time on relationships, not prospecting.', cards[1]);
  ok('  Collectives: businesses that fit, the decision maker and a verified email included, "Talk to us"', cards[2].h === 'Collectives'
    && cards[2].p === 'Local businesses that fit your athletes, with the decision maker and a verified email included, ready to partner.'
    && cards[2].a[1] === 'Talk to us' && /^mailto:contact@mynildash\.com\?subject=/.test(cards[2].a[0]), cards[2]);
  ok('  each is one sentence', cards.every((c) => c.p && (c.p.match(/[.!?](\s|$)/g) || []).length === 1), cards.map((c) => c.p));
  ok('  agents get started, schools talk to us too', cards[0].a[1] === 'Get started' && /signin=agent/.test(cards[0].a[0]) && cards[1].a[1] === 'Talk to us' && /^mailto:/.test(cards[1].a[0]));
  ok('nothing about program directories, the 119 football or 126 basketball programs, or coach contacts',
    !/program director|programs director|\b119\b|\b126\b|football programs|basketball programs|\bcoach/i.test(HTML), (HTML.match(/.{30}(program director|\b119\b|\b126\b|coach).{30}/i) || [])[0]);

  const how = section('how');
  ok('"How a morning works": three steps', /How a morning works/.test(how) && (how.match(/class="step"/g) || []).length === 3, (how.match(/class="step"/g) || []).length);
  ok('  overnight research, morning approval, sent from your inbox, in that order',
    /Overnight research[\s\S]*Morning approval[\s\S]*Sent from your inbox/.test(how));
  ok('  with follow-ups and replies tracked', /follow-up comes back to your morning to approve, so there's nothing to remember, and every reply is tracked/.test(how));
  ok('  and it is about time back', /<h2 class="h2">The work happens overnight\. You get the time back\.<\/h2>/.test(how) && /While you're off the clock/.test(how)
    && /That's your part\./.test(how) && /The rest of your day is yours\./.test(how));

  const ver = section('verified');
  ok('"Verified, or it doesn\'t send"', /<h2 class="h2">Verified, or it doesn't send\.<\/h2>/.test(ver));
  ok('  every email checked before it goes out', /Every email is checked before it goes out/.test(ver));
  ok('  no guessed addresses', /No guessed addresses/.test(ver));
  ok('  one email per business contact every 4 days', /One email per business contact every 4 days/.test(ver));
  ok('  unsubscribe and address on every pitch', /Unsubscribe and address on every pitch/.test(ver));

  console.log('\n   ...and each claim against the code that makes it true');
  const Q = require(REPO + 'server/services/outreachQueue');
  ok('"5 researched deals": the queue holds five slots per athlete', Q.SLOTS_PER_ATHLETE === 5, Q.SLOTS_PER_ATHLETE);
  ok('"every 4 days": the send rules\' window is 4 days', require(REPO + 'server/services/sendRules').WINDOW_DAYS === 4);
  const SG = read('server/services/sendGate.js');
  ok('"checked before it goes out": the send gate verifies at send time and offers a call or DM instead',
    /re-verified right now/.test(SG) && /offers a call or a DM instead/.test(SG));
  const CS = read('server/services/canSpam.js');
  ok('"unsubscribe and address on every pitch": the footer carries both, and refuses to send without the address',
    /unsubscribe/i.test(CS) && /BUSINESS_MAILING_ADDRESS/.test(CS) && /footerText\(\) throws/.test(CS));
  ok('  "stops all mail to that address": the unsubscribe writes the global suppression list', /GLOBAL suppression list/.test(CS));

  const inc = section('included');
  const tiles = (inc.match(/<li class="mini"><h3>([^<]+)<\/h3>/g) || []).map((s) => s.replace(/.*<h3>/, '').replace('</h3>', ''));
  ok('the old feature tour is one compact "Also included" grid', /Also included/.test(inc) && /class="grid6"/.test(inc));
  ok('  Deal Scan, Contact Ladder, Outreach, Pipeline, Media Kit, Assistant', JSON.stringify(tiles) === JSON.stringify(['Deal Scan', 'Contact Ladder', 'Outreach', 'Pipeline', 'Media Kit', 'Assistant']), tiles);
  ok('  each in one line, no screenshot', !/<img/.test(inc) && !/base64/.test(inc));
  const progOn = /var PROGRAMS_ENABLED = true;/.test(read('public/index.html'));
  ok('  Programs is listed only while the app shows it (PROGRAMS_ENABLED)', tiles.includes('Programs') === progOn, { progOn, tiles });
  ok('the old feature sections are not on this page', !/class="feat|id="features"|class="asstband"/.test(HTML));

  const pr = section('pricing');
  ok('pricing: Agent $99/month to get your mornings back', /<span class="who">Agent<\/span>\s*<div class="price">\$99<span>\/month<\/span><\/div>\s*<p class="why">to get your mornings back<\/p>/.test(pr)
    && /\$99 \/month to get your mornings back/.test(VISIBLE));
  ok('  Athletes: "Coming soon" with a waitlist email field', /<span class="who">Athletes<\/span>\s*<div class="soon">Coming soon<\/div>/.test(pr)
    && /<form class="wl" id="wl" action="\/api\/public\/waitlist" method="post"/.test(pr) && /type="email"/.test(pr));
  ok('  Schools and collectives: talk to us, by email', /<span class="who">Schools and collectives<\/span>\s*<div class="soon">Talk to us<\/div>/.test(pr) && /mailto:contact@mynildash\.com/.test(pr));
  ok('  no athlete price anywhere', !/id="athletes"[\s\S]*?\$\d/.test(pr.slice(pr.indexOf('id="athletes"'), pr.indexOf('id="teams"'))));
  ok('the footer keeps the postal address, Privacy and Terms', /Compton Group LLC, 3796 Turnberry Court, Duluth, GA 30096/.test(HTML)
    && /href="\/privacy"/.test(HTML) && /href="\/terms"/.test(HTML));

  console.log('\n2. THE FONTS');
  const link = (HTML.match(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)">/) || [])[1] || '';
  ok('the brand fonts are loaded: Syne, DM Mono, Inter', /family=Syne:/.test(link) && /family=DM\+Mono:/.test(link) && /family=Inter:/.test(link), link);
  ok('  with font-display: swap', /&display=swap$/.test(link), link);
  ok('  the weights the page uses are the weights it loads (Syne 700 and 800)', /Syne:wght@[0-9;]*700[0-9;]*800/.test(link));
  ok('  preconnected, the font files with crossorigin', /<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>/.test(HTML));
  const stacks = [...CSS.matchAll(/--(head|body|mono):([^;]+);/g)].map((m) => [m[1], m[2]]);
  ok('three stacks, Syne for headings, Inter for body, DM Mono for labels', stacks.length === 3
    && /^'Syne'/.test(stacks.find((s) => s[0] === 'head')[1]) && /^'Inter'/.test(stacks.find((s) => s[0] === 'body')[1]) && /^'DM Mono'/.test(stacks.find((s) => s[0] === 'mono')[1]), stacks);
  ok('  each ends in a sans or mono generic, never a serif', stacks.every(([k, v]) => (k === 'mono' ? /monospace$/ : /sans-serif$/).test(v.trim()) && !/(^|,)\s*serif\b/.test(v)), stacks);
  ok('  and no rule names a font outside the stacks (the old page\'s bare font-family:\'Syne\')', !/font-family:\s*'/.test(CSS));

  console.log('\n3. NONE OF THE PORTAL');
  ok('no app markup in the page', !/id="(appScreen|authScreen|mktLanding|home-panel|home-tabs|loginForm)"/.test(HTML));
  ok('  no "Could not load today\'s outreach"', !/Could not load today/.test(HTML));
  ok('  no app scripts loaded', !/<script[^>]+src=/.test(HTML), (HTML.match(/<script[^>]+src=[^>]+>/g) || []));
  ok('  the only request the page makes is the waitlist', (HTML.match(/fetch\('([^']+)'/g) || []).join() === "fetch('/api/public/waitlist'");
  ok('it is not under public/, so express.static can never serve it raw', !fs.existsSync(REPO + 'public/home.html') && /server\/views\/home\.html|'views', 'home\.html'/.test(read('server/services/publicHome.js')));

  console.log('\n4. THE LIVE COUNTS');
  ok('three counts, each named for what it counts', JSON.stringify(PH.STATS.map((s) => s.key)) === '["businesses","verified","sent"]');
  ok('  zeros are left off', PH.renderStats({ businesses: 0, verified: 3, sent: 0 }).match(/class="stat"/g).length === 1
    && !/local businesses/.test(PH.renderStats({ businesses: 0, verified: 3, sent: 0 })));
  ok('  a count that could not be read is left off', !/pitch emails/.test(PH.renderStats({ businesses: 2, verified: 3, sent: null })));
  ok('  all zero: no row at all', PH.renderStats({ businesses: 0, verified: 0, sent: 0 }) === '' && PH.renderStats(null) === '');
  ok('  numbers are formatted, labels say where they come from', /<span class="n">12,345<\/span>/.test(PH.renderStats({ businesses: 12345 })) && /Counted live from NILDash/.test(PH.renderStats({ businesses: 1 })));
  PH._reset();
  let s0 = await PH.stats(P);
  ok('a fresh database: every count is zero', s0.businesses === 0 && s0.verified === 0 && s0.sent === 0, s0);
  await P.query(`INSERT INTO market_business_seen (market_key, brand) VALUES ('atl', 'a'), ('atl', 'b'), ('aub', 'a')`);
  await P.query(`INSERT INTO email_verification (email, result, checked_at) VALUES ('a@x.example', 'valid', NOW()), ('b@x.example', 'valid', NOW()), ('c@x.example', 'invalid', NOW())`);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ('hv-agent', 'Real Agent', 'real@agency.example', 'x', 'agent'),
                 ('hv-demo', 'NILDash Demo', 'demo@comptongroupllc.com', 'x', 'agent')`);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at, created_at, updated_at) VALUES
                 ('hv-1', 'hv-agent', 'hv-ath', 'A', 'sent', NOW(), NOW(), NOW()), ('hv-2', 'hv-agent', 'hv-ath', 'B', 'replied', NOW(), NOW(), NOW()),
                 ('hv-3', 'hv-agent', 'hv-ath', 'C', 'draft', NULL, NOW(), NOW()), ('hv-4', 'hv-demo', 'hv-dath', 'D', 'sent', NOW(), NOW(), NOW())`);
  const s1 = await PH.stats(P);
  ok('  cached for 10 minutes: new rows are not counted inside the window', s1.businesses === 0, s1);
  const s2 = await PH.stats(P, { now: Date.now() + PH.STATS_TTL_MS + 1000 });
  ok('  after it: businesses found, one per market (3)', s2.businesses === 3, s2);
  ok('  verified: only addresses verified valid (2)', s2.verified === 2, s2);
  ok('  sent: only sent mail, and not the demo account\'s (2)', s2.sent === 2, s2);
  const slow = { query: () => new Promise((r) => setTimeout(() => r({ rows: [{ n: 9 }] }), 2000)) };
  PH._reset();
  const t0 = Date.now();
  const sp = await PH.statsForPage(slow, { waitMs: 200 });
  ok('the page never waits on a slow count: it renders without them', sp === null && Date.now() - t0 < 1500, { sp, ms: Date.now() - t0 });
  PH._reset();

  console.log('\n5. WHO GETS THE PAGE');
  const req = (o) => ({ method: 'GET', path: '/', query: {}, session: {}, ...o });
  ok('switch off: nobody', !PH.servesHome(req({})));
  process.env.HOME_V2_ON = '1';
  ok('switch on: a visitor with no session', PH.servesHome(req({})));
  ok('  and one carrying ad or referral tags', PH.servesHome(req({ query: { ref: 'x', utm_source: 'ig', utm_campaign: 'fall', gclid: '1', fbclid: '2' } })));
  for (const q of ['jwt', 'actor', 'next', 'subscribed', 'signin', 'app', 'tab', 'gcal'])
    ok(`  not with ?${q}= (the app reads it)`, !PH.servesHome(req({ query: { [q]: '1' } })));
  ok('  not a signed-in session', !PH.servesHome(req({ session: { userId: 'u1' } })));
  ok('  not another path, not a POST', !PH.servesHome(req({ path: '/index.html' })) && !PH.servesHome(req({ method: 'POST' })));
  delete process.env.HOME_V2_ON;
  const SRV = read('server/index.js');
  const at = (t) => SRV.indexOf(t);
  ok('the route for / runs after the session, so it can read it', at("app.get('/', (req, res, next)") > at('app.use(session({') && at('app.use(session({') > 0);
  ok('  express.static leaves / to it only with the switch on (off, static answers / as always)',
    /index: require\('\.\/services\/publicHome'\)\.ON\(\) \? false : 'index\.html',/.test(SRV) && at("index: require('./services/publicHome')") > at('app.use(express.static('));
  ok('  and anything it does not serve falls to the catch-all\'s index.html', /if \(!PH\.servesHome\(req\)\) return next\(\);/.test(SRV) && at("app.get('*'") > at("app.get('/', (req, res, next)"));
  ok('  the session mount itself is untouched: one session({ ... }), mounted with app.use', (SRV.match(/session\(\{/g) || []).length === 1 && at('app.use(session({') > 0);
  const IDX = read('public/index.html');
  ok('index.html opens sign-in from ?signin=agent, and sign-up with &tab=signup', /qs\.get\('signin'\)/.test(IDX) && /mktOpenAuth\(role\)/.test(IDX) && /switchTab\('signup'\)/.test(IDX));
  ok('  logging out goes to the new page when the server says so', /if \(await toPublicHome\(r\)\) return;\n  showMarketingLanding\(\);/.test(IDX) && /d\.home === '\/'\) \{ window\.location\.assign\('\/'\)/.test(IDX) && /home: require\('\.\/services\/publicHome'\)\.ON\(\) \? '\/' : null/.test(SRV));
  ok('  the first-paint Home load writes nothing with no session', /if \(r\.status === 401 && opts && opts\.firstPaint\) return;/.test(IDX) && /hqLoad\(undefined, \{ firstPaint: true \}\)/.test(IDX));
  ok('  and the old landing in index.html is untouched (the switch off keeps it)', /<div id="mktLanding">/.test(IDX));

  // The real server, twice: switch off, then on.
  await P.query(`INSERT INTO users (id, name, email, password, role, plan_tier, comped) VALUES ('hv-login', 'Lou Login', 'lou@agency.example', $1, 'agent', 'unlimited', TRUE)`, [await bcrypt.hash('home-pass-123', 6)]);
  const boot = async (extra) => {
    const port = await freePort();
    const srv = spawn(process.execPath, [REPO + 'server/index.js'], {
      env: { ...process.env, PORT: String(port), NODE_ENV: 'development', SESSION_SECRET: 'home-test', RESEND_API_KEY: process.env.RESEND_API_KEY || 're_test_dummy',
        DATABASE_URL: '', ADMIN_EMAIL: 'admin@x.example', ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; srv.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    let up = false;
    for (let i = 0; i < 90 && !up; i++) { try { up = (await fetch(base + '/health')).ok; } catch (_) {} if (!up) await new Promise((r) => setTimeout(r, 1000)); }
    return { srv, base, up, err: () => err };
  };
  const isHome = (h) => /<title>NILDash \| Buy back your time<\/title>/.test(h) && !/id="appScreen"/.test(h);
  const isApp = (h) => /<div id="mktLanding">/.test(h) && /id="appScreen"/.test(h);

  const off = await boot({ HOME_V2_ON: '' });
  try {
    ok('SWITCH OFF: the server boots', off.up, off.err());
    const h = await (await fetch(off.base + '/')).text();
    ok('  / is index.html exactly as before', isApp(h) && h === read('public/index.html'));
    const pv = await fetch(off.base + '/home-preview');
    const pvh = await pv.text();
    ok('  /home-preview shows the new page, kept out of search', pv.ok && isHome(pvh) && /<meta name="robots" content="noindex">/.test(pvh));
    const lo = await (await fetch(off.base + '/api/auth/logout', { method: 'POST' })).json();
    ok('  logout says nothing about a homepage', lo.ok === true && lo.home === null, lo);
  } finally { off.srv.kill(); }

  const on = await boot({ HOME_V2_ON: '1' });
  let browser = null;
  try {
    ok('SWITCH ON: the server boots', on.up, on.err());
    PH._reset();
    const r = await fetch(on.base + '/');
    const h = await r.text();
    ok('  / for a visitor with no session is the new page', r.ok && isHome(h));
    ok('  with the live counts in it (3 businesses, 2 verified, 2 sent)', /<span class="n">3<\/span><span class="l">local businesses found/.test(h)
      && /<span class="n">2<\/span><span class="l">contact emails verified/.test(h) && /<span class="n">2<\/span><span class="l">pitch emails sent/.test(h), (h.match(/<section class="stats"[\s\S]*?<\/section>/) || [])[0]);
    ok('  not cached by anything in between, and varies by cookie', /private/.test(r.headers.get('cache-control') || '') && /Cookie/.test(r.headers.get('vary') || ''), [r.headers.get('cache-control'), r.headers.get('vary')]);
    ok('  and none of the portal is in what the server sent', !/Could not load today|id="appScreen"|id="home-panel"/.test(h));
    const hd = await fetch(on.base + '/', { method: 'HEAD' });
    ok('  HEAD / answers too', hd.ok);
    ok('  ?ref= keeps the page, and still sets the referral cookie', await (async () => { const x = await fetch(on.base + '/?ref=coach1&utm_source=ig'); return isHome(await x.text()) && /nildash_ref=coach1/.test(x.headers.get('set-cookie') || ''); })());
    for (const q of ['jwt=abc', 'actor=agent', 'next=%2Freconnect-mailbox%3Fprovider%3Dgmail', 'subscribed=1', 'signin=agent', 'app=1'])
      ok(`  /?${q} is the app, as before`, isApp(await (await fetch(on.base + '/?' + q)).text()));
    const lr = await fetch(on.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'lou@agency.example', password: 'home-pass-123' }) });
    const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
    ok('  a signed-in agent at / gets the app', lr.ok && isApp(await (await fetch(on.base + '/', { headers: { Cookie: cookie } })).text()), lr.status);
    const lo = await (await fetch(on.base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })).json();
    ok('  logout sends them to the new page', lo.ok === true && lo.home === '/', lo);
    ok('  /index.html is still the app (the sign-in page)', isApp(await (await fetch(on.base + '/index.html')).text()));

    console.log('\n6. THE ATHLETE WAITLIST');
    // One made-up client address for this section (the server trusts one proxy
    // hop), so its rate-limit bucket is not the browser's below.
    const XFF = { 'X-Forwarded-For': '203.0.113.7' };
    const post = (body, json = true) => fetch(on.base + '/api/public/waitlist', { method: 'POST', redirect: 'manual',
      headers: json ? { ...XFF, 'Content-Type': 'application/json', Accept: 'application/json' } : { ...XFF, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: json ? JSON.stringify(body) : new URLSearchParams(body).toString() });
    const a = await post({ email: '  Jordan.Lee@School.EDU ' });
    ok('an email joins (JSON)', a.ok && (await a.json()).ok === true);
    const rows = (await P.query(`SELECT email, audience, source FROM home_waitlist`)).rows;
    ok('  stored once, lowercased, as an athlete, from the homepage', rows.length === 1 && rows[0].email === 'jordan.lee@school.edu' && rows[0].audience === 'athlete' && rows[0].source === 'home', rows);
    const again = await post({ email: 'jordan.lee@school.edu' });
    ok('  joining twice is fine and stores nothing new', again.ok && (await P.query(`SELECT COUNT(*)::int n FROM home_waitlist`)).rows[0].n === 1);
    const bad = await post({ email: 'not an email' });
    ok('a bad address is refused in plain words', bad.status === 400 && /valid email/i.test((await bad.json()).error || ''));
    const bot = await post({ email: 'bot@spam.example', website: 'http://spam.example' });
    ok('the hidden field catches a bot: thanked, not stored', bot.ok && !(await P.query(`SELECT 1 FROM home_waitlist WHERE email = 'bot@spam.example'`)).rows.length);
    const form = await post({ email: 'nojs@school.edu' }, false);
    ok('without JavaScript: a plain form post joins and comes back to the page', form.status === 303 && form.headers.get('location') === '/?joined=1#athletes'
      && (await P.query(`SELECT 1 FROM home_waitlist WHERE email = 'nojs@school.edu'`)).rows.length === 1, [form.status, form.headers.get('location')]);
    const lim = await post({ email: 'six@school.edu' });
    ok('  five tries per quarter hour from one address, then a plain "too many"', lim.status === 429, lim.status);
    const reg = require(REPO + 'server/services/adminScripts').registry();
    ok('admin script athlete-waitlist lists them', reg['athlete-waitlist'] && reg['athlete-waitlist'].file === 'scripts/athlete-waitlist.js' && fs.existsSync(REPO + 'scripts/athlete-waitlist.js'));
    const outTxt = execSync(`node ${REPO}scripts/athlete-waitlist.js`, { env: { ...process.env, INIT_WAIT_MS: '2500' } }).toString();
    ok('  and prints each one, newest first', /ATHLETE WAITLIST: 2/.test(outTxt) && outTxt.indexOf('nojs@school.edu') < outTxt.indexOf('jordan.lee@school.edu'), outTxt);

    console.log('\n7. THE HERO GRAPHIC: NO PICTURES');
    ok('no <img>, <picture>, <canvas> or <video> anywhere on the page', !/<(img|picture|canvas|video)\b/i.test(HTML));
    ok('  no raster image in the CSS either', !/url\(/i.test(CSS));
    ok('  the old screenshot and the script that made it are gone', !fs.existsSync(REPO + 'public/images/home-morning.png') && !fs.existsSync(REPO + 'scripts/home-screenshot.js'));
    const fig = HTML.slice(HTML.indexOf('<figure class="mc-fig">'), HTML.indexOf('</figure>', HTML.indexOf('<figure class="mc-fig">')));
    ok('the hero is a morning card built in HTML and inline SVG', fig.length > 1500 && /<div class="mc">/.test(fig));
    ok('  a fictional athlete', /<div class="mc-name">Maya Torres<\/div><div class="mc-sub">Soccer, Riverside State<\/div>/.test(fig));
    ok('  a local business', /<div class="mc-bizname">Harbor Street Coffee<\/div><div class="mc-sub">Local coffee shop, near campus<\/div>/.test(fig));
    ok('  the owner\'s name with a Verified badge', /<span class="mc-person">Dana Kim <span>Owner<\/span><\/span>\s*<span class="mc-badge"><svg viewBox="0 0 24 24">[\s\S]*?<\/svg>Verified<\/span>/.test(fig));
    ok('  a pitch preview held to 2 lines', /<p class="mc-pitch">Hi Dana, [^<]{120,}<\/p>/.test(fig) && /\.mc-pitch\{[^}]*-webkit-line-clamp:2;line-clamp:2;overflow:hidden\}/.test(CSS));
    ok('  Approve and Skip', /<span class="mc-btn ok">[\s\S]*?Approve<\/span>/.test(fig) && /<span class="mc-btn skip">Skip<\/span>/.test(fig));
    ok('  a picture, not controls: one labeled image to a screen reader, nothing to tab to', /<div class="mc-stage" role="img" aria-label="Illustration of a NILDash morning card[^"]+">/.test(fig)
      && /<div class="mc-stack" aria-hidden="true">/.test(fig) && !/<(a|button|input)\b/.test(fig));
    const svgs = fig.match(/<svg\b[^>]*>/g) || [];
    ok('  every icon is vector, sized by CSS (a viewBox, no fixed width or height)', svgs.length >= 5 && svgs.every((t) => /viewBox="0 0 24 24"/.test(t) && !/\s(width|height)=/.test(t)), svgs);
    ok('  the names are fictional and it says so; no email address in it', /<figcaption>An illustration\. The names and the business are fictional\.<\/figcaption>/.test(fig) && !/@/.test(fig));

    console.log('\n8. AT 390PX, IN A BROWSER');
    let pw = null;
    try { pw = require('playwright'); } catch (_) { try { pw = require(_tp.join(execSync('npm root -g').toString().trim(), 'playwright')); } catch (__) { pw = null; } }
    if (pw) {
      try { browser = await pw.chromium.launch(); } catch (_) { browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }).catch(() => null); }
    }
    if (!browser) console.log('  SKIP the browser checks: no Playwright or Chromium here');
    else {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const pg = await ctx.newPage();
      pg.on('pageerror', () => {});
      await pg.route(/^https?:\/\/(?!127\.0\.0\.1)/, (rt) => rt.abort());   // no network: the fallback stacks are what render
      await pg.goto(on.base + '/', { waitUntil: 'domcontentloaded' });
      const m = await pg.evaluate(() => {
        const vw = window.innerWidth;
        const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); })
          .filter((e) => !e.closest('.sr,.hp')).map((e) => e.tagName + '.' + e.className).slice(0, 5);
        const ctas = [...document.querySelectorAll('.hero .btn, .plan .btn, .wl button')].map((b) => Math.round(b.getBoundingClientRect().height));
        const h1 = document.querySelector('h1');
        return { scroll: document.documentElement.scrollWidth - vw, wide, ctas, h1: h1 && h1.textContent, h1font: h1 && getComputedStyle(h1).fontFamily,
          body: getComputedStyle(document.body).fontFamily, stats: document.querySelectorAll('.stat').length, navHidden: getComputedStyle(document.querySelector('.navlinks')).display === 'none',
          portal: !!document.getElementById('appScreen') || /Could not load today/.test(document.body.innerHTML) };
      });
      ok('no sideways scroll at 390px', m.scroll <= 0, m.scroll);
      ok('  nothing pokes past the edge', m.wide.length === 0, m.wide);
      ok('  every button is a full tap target (44px or taller)', m.ctas.length >= 5 && m.ctas.every((x) => x >= 44), m.ctas);
      ok('  the hero reads as written', m.h1 === 'Buy back your time.', m.h1);
      ok('  headings are set in Syne, falling back to a sans, never a serif', /^Syne,/.test(m.h1font) && /sans-serif$/.test(m.h1font) && /^Inter,/.test(m.body), [m.h1font, m.body]);
      ok('  the section links fold away on a phone; Sign in and Get started stay', m.navHidden && await pg.isVisible('.navright .signin') && await pg.isVisible('.navright .btn'));
      ok('  the counts show', m.stats === 3, m.stats);
      ok('  and none of the portal is in the page', !m.portal);
      // NO CALCULATOR, the comparison stays.
      const nc = await pg.evaluate(() => ({ text: /hours a week back/i.test(document.body.innerText), calc: !!document.getElementById('calc'),
        vsCols: getComputedStyle(document.querySelector('.vs')).gridTemplateColumns.split(' ').length,
        cols: [...document.querySelectorAll('.vs .col h3')].map((h) => h.textContent) }));
      ok('no calculator on the page as rendered, and no "hours a week back"', !nc.text && !nc.calc, nc);
      ok('  By hand and With NILDash still there, stacked on a phone', JSON.stringify(nc.cols) === '["By hand","With NILDash"]' && nc.vsCols === 1, nc);
      // THE HERO GRAPHIC.
      const g = await pg.evaluate(() => {
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const pitch = document.querySelector('.mc-pitch');
        const lh = parseFloat(getComputedStyle(pitch).lineHeight);
        return { raster: document.querySelectorAll('img,picture,canvas,video').length,
          bg: [...document.querySelectorAll('*')].filter((e) => /url\(/.test(getComputedStyle(e).backgroundImage)).length,
          card: r('.mc'), vw: window.innerWidth, lines: Math.round(pitch.getBoundingClientRect().height / lh),
          svgs: [...document.querySelectorAll('.mc-stage svg')].map((s) => { const b = s.getBoundingClientRect(); return b.width > 0 && b.height > 0; }) };
      });
      ok('the card renders with no raster image anywhere, so nothing on the page can blur', g.raster === 0 && g.bg === 0, g);
      ok('  it fits the phone', g.card.left >= 0 && g.card.right <= g.vw, g.card);
      ok('  the pitch shows exactly 2 lines', g.lines === 2, g.lines);
      ok('  every icon draws', g.svgs.length >= 5 && g.svgs.every(Boolean), g.svgs);
      await pg.fill('#wl-email', 'browser@school.edu');
      await pg.click('#wl button');
      await pg.waitForFunction(() => /on the list/.test(document.getElementById('wl-msg').textContent), null, { timeout: 8000 }).catch(() => {});
      ok('the waitlist form joins from the page and says so', /You're on the list/.test(await pg.textContent('#wl-msg'))
        && (await P.query(`SELECT 1 FROM home_waitlist WHERE email = 'browser@school.edu'`)).rows.length === 1);
      await pg.goto(on.base + '/?signin=agent&tab=signup', { waitUntil: 'domcontentloaded' });
      await pg.waitForTimeout(400);
      const auth = await pg.evaluate(() => ({ auth: !document.getElementById('authScreen').classList.contains('hidden'),
        landing: document.getElementById('mktLanding').classList.contains('hidden'),
        signup: !!document.getElementById('signupForm') && getComputedStyle(document.getElementById('signupForm')).display !== 'none',
        // Text nodes only: the words are also in the page's own script source.
        loadErr: (() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n, hit = false;
          while ((n = w.nextNode())) if (!n.parentElement.closest('script,style') && /Could not load today/.test(n.nodeValue)) hit = true; return hit; })(),
        panel: (document.getElementById('home-panel') || {}).innerHTML || '' }));
      ok('"Get started" lands on agent sign-up', auth.auth && auth.landing && auth.signup, auth);
      ok('  and the sign-in page no longer carries "Could not load today\'s outreach"', !auth.loadErr && !/Could not load today/.test(auth.panel), auth.panel.slice(0, 200));
      const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await ctx2.addInitScript(() => { try { if (location.pathname === '/' && !location.search) localStorage.setItem('athlete_token', 'tok'); } catch (e) {} });
      const pg2 = await ctx2.newPage();
      pg2.on('pageerror', () => {});
      const navs = [];
      pg2.on('request', (rq) => { if (rq.isNavigationRequest()) navs.push(rq.url()); });
      await pg2.route(/^https?:\/\/(?!127\.0\.0\.1)/, (rt) => rt.abort());
      await pg2.goto(on.base + '/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await pg2.waitForTimeout(1500);
      ok('an athlete signed in on this browser is sent to their portal', navs.includes(on.base + '/?app=1'), navs);
      await ctx2.close();
      // 1440px: the desktop layout.
      const ctx3 = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      const pg3 = await ctx3.newPage();
      pg3.on('pageerror', () => {});
      await pg3.route(/^https?:\/\/(?!127\.0\.0\.1)/, (rt) => rt.abort());
      await pg3.goto(on.base + '/', { waitUntil: 'domcontentloaded' });
      const d = await pg3.evaluate(() => {
        const vw = window.innerWidth;
        const wide = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 1 || r.left < -1); })
          .filter((e) => !e.closest('.sr,.hp')).map((e) => e.tagName + '.' + e.className).slice(0, 5);
        const h1 = document.querySelector('h1').getBoundingClientRect(), card = document.querySelector('.mc').getBoundingClientRect();
        return { scroll: document.documentElement.scrollWidth - vw, wide, side: card.left > h1.left + 200 && card.top < h1.bottom + 200,
          audCols: getComputedStyle(document.querySelector('.aud')).gridTemplateColumns.split(' ').length,
          nav: getComputedStyle(document.querySelector('.navlinks')).display !== 'none', raster: document.querySelectorAll('img,picture,canvas,video').length,
          vsCols: getComputedStyle(document.querySelector('.vs')).gridTemplateColumns.split(' ').length, calcText: /hours a week back/i.test(document.body.innerText), calc: !!document.getElementById('calc'),
          lines: Math.round(document.querySelector('.mc-pitch').getBoundingClientRect().height / parseFloat(getComputedStyle(document.querySelector('.mc-pitch')).lineHeight)) };
      });
      ok('AT 1440PX: no sideways scroll, nothing past the edge', d.scroll <= 0 && d.wide.length === 0, d);
      ok('  the card sits beside the headline', d.side, d);
      ok('  "Who it\'s for" is three across, the section links show, still no raster image, the pitch still 2 lines', d.audCols === 3 && d.nav && d.raster === 0 && d.lines === 2, d);
      ok('  By hand and With NILDash side by side, and no calculator', d.vsCols === 2 && !d.calcText && !d.calc, d);
      await ctx3.close();
      PH._reset();
      await P.query(`DELETE FROM market_business_seen; DELETE FROM email_verification; DELETE FROM outreach_logs`);
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    on.srv.kill();
  }
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
