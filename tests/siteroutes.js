'use strict';
// Runs from a checkout on any machine: no database, no network, no key.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/siteroutes.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const fs = require('fs');

// ── FOUR URLS THAT ALL RETURNED THE HOMEPAGE ────────────────────────────────
//
// /robots.txt, /sitemap.xml, /favicon.ico and /terms each answered 200 with
// 1.8MB of the single-page app, because none of them existed in public/ and
// the catch-all hands the app to every unmatched GET. A crawler asking for
// robots.txt was handed HTML, found no rules it could parse, and crawled
// everything -- including the token links.

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const exists = (p) => fs.existsSync(REPO + p);

(async () => {
  // ── THE FILES ARE REAL ─────────────────────────────────────────────────
  OUT.push('-- the four files --');
  for (const f of ['public/robots.txt', 'public/sitemap.xml', 'public/favicon.ico', 'public/terms.html']) {
    ok(`${f} exists`, exists(f));
  }

  // robots.txt
  const robots = src('public/robots.txt');
  ok('robots.txt has a User-agent line', /^User-agent:\s*\*/m.test(robots));
  ok('  and names the sitemap', /^Sitemap:\s*https:\/\/mynildash\.com\/sitemap\.xml$/m.test(robots));
  ok('  it keeps crawlers out of the app', ['/api/', '/admin', '/athlete-dashboard', '/reset'].every((p) => robots.includes('Disallow: ' + p)));
  ok('IT KEEPS THEM OFF THE TOKEN LINKS, which act on a person’s behalf',
    ['/a/', '/unsubscribe', '/report/', '/kit/'].every((p) => robots.includes('Disallow: ' + p)), robots);
  ok('  and does NOT disallow the marketing pages it exists to get indexed',
    !/^Disallow:\s*\/$/m.test(robots) && !/Disallow: \/landing/.test(robots) && !/Disallow: \/privacy/.test(robots) && !/Disallow: \/terms/.test(robots));

  // sitemap.xml
  const sm = src('public/sitemap.xml');
  ok('the sitemap declares the right namespace, or it is not a sitemap',
    /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/.test(sm), (sm.match(/xmlns="[^"]*"/) || [])[0]);
  ok('  it opens with an XML declaration', /^<\?xml version="1\.0" encoding="UTF-8"\?>/.test(sm));
  ok('  every entry is an absolute https URL on the real host',
    (sm.match(/<loc>([^<]+)<\/loc>/g) || []).every((l) => /<loc>https:\/\/mynildash\.com\//.test(l)), sm.match(/<loc>[^<]+<\/loc>/g));
  ok('  it lists the pages a stranger can actually read', ['/', '/landing', '/demo', '/privacy', '/terms'].every((p) => sm.includes('<loc>https://mynildash.com' + p + '</loc>')));
  ok('  and lists NOTHING behind a login', !/(api|admin|dashboard|athlete-login|reset)/.test(sm));
  const opens = (sm.match(/<url>/g) || []).length, closes = (sm.match(/<\/url>/g) || []).length;
  ok('  the tags balance', opens === closes && opens === 5, [opens, closes]);

  // favicon.ico -- parsed the way a browser parses it.
  const ico = fs.readFileSync(REPO + 'public/favicon.ico');
  ok('favicon.ico is a real ICO: reserved 0, type 1', ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1);
  const count = ico.readUInt16LE(4);
  ok('  and holds at least one image', count >= 1, count);
  let icoOk = true, sizes = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + 16 * i;
    const len = ico.readUInt32LE(at + 8), off = ico.readUInt32LE(at + 12);
    sizes.push(`${ico.readUInt8(at) || 256}x${ico.readUInt8(at + 1) || 256}`);
    // Every entry has to point at bytes that are inside the file, and at a
    // PNG: an ICO whose offsets run past the end renders as nothing.
    if (off + len > ico.length) icoOk = false;
    if (ico.slice(off + 1, off + 4).toString() !== 'PNG') icoOk = false;
  }
  ok('  every entry points at a real PNG inside the file', icoOk, sizes);
  ok('  it is built from the brand icons already in the repo, not something invented',
    exists('public/icons/icon-72.png') && exists('public/icons/icon-128.png') && sizes.join(',') === '72x72,128x128', sizes);

  // terms
  const terms = src('public/terms.html');
  ok('the terms page is a whole document', /^<!DOCTYPE html>/.test(terms) && /<\/html>\s*$/.test(terms));
  ok('  titled as itself, not as the privacy policy', /<title>Terms of Service — NILDash<\/title>/.test(terms));
  ok('  and it reuses the privacy page’s stylesheet rather than inventing a second one',
    terms.includes("--accent:#84CC16") && terms.includes("font-family:'DM Sans',sans-serif"));
  ok('it carries the NIL-activity disclosure, in the words it was asked for',
    /may show that a business has completed an NIL deal on the\s+platform, without revealing the\s+agent, athlete, or deal terms/.test(terms), null);
  ok('  and states the unsubscribe promise the send path actually keeps',
    /unsubscribe link and a physical mailing address/.test(terms) && /blocked across the whole platform/.test(terms));
  ok('  it links to the privacy policy', /href="\/privacy"/.test(terms));

  // ── THE CATCH-ALL DOES NOT SWALLOW THEM ────────────────────────────────
  OUT.push('', '-- the catch-all --');
  const idx = src('server/index.js');
  ok('/terms has a route of its own', /app\.get\('\/terms', \(req, res\) => \{[\s\S]{0,120}?terms\.html/.test(idx));
  ok('THE FOUR ARE NAMED AND EXCLUDED', /const NEVER_THE_APP = new Set\(\['\/robots\.txt', '\/sitemap\.xml', '\/favicon\.ico', '\/terms', '\/terms\/'\]\)/.test(idx));
  ok('  and the catch-all checks that set before it serves the app',
    /if \(NEVER_THE_APP\.has\(p\) \|\| \/\\\.\[a-z0-9\]\{2,5\}\$\/i\.test\(p\)\) \{[\s\S]{0,120}?404/.test(idx));
  ok('  anything that looks like a FILE gets a 404 too, never HTML dressed as a stylesheet',
    /\/\\\.\[a-z0-9\]\{2,5\}\$\/i\.test\(p\)/.test(idx));
  ok('  and a real app route still gets the app', /res\.sendFile\(path\.join\(__dirname, '\.\.', 'public', 'index\.html'\)\)/.test(idx));

  // ── THE HOMEPAGE INVENTS NOBODY ────────────────────────────────────────
  OUT.push('', '-- no invented people on the homepage --');
  const html = src('public/index.html');
  for (const name of ['Sample Bramwell', 'Placeholder Castellan', 'Specimen Delacroix', 'Exemplar Everly',
    'Fixture Alvarez', 'Dana Whitfield', 'Marcus Bramwell']) {
    ok(`gone: ${name}`, !html.includes(name));
  }
  ok('THE MOCKUPS THEMSELVES ARE GONE, not just their names', !/class="cardui"/.test(html) && !/cu-prow/.test(html));
  ok('  and so is the CSS that only they used', !/#mktLanding \.cardui\{/.test(html) && !/#mktLanding \.cu-/.test(html));
  ok('  no invented phone numbers are left either', !/\(205\) 555-01/.test(html));
  ok('the two features keep their copy: only the fabricated illustration went',
    /A name, not a front desk\./.test(html) && /The people who decide roster spots\./.test(html));
  ok('  and they render as one column rather than a half-empty grid',
    (html.match(/<div class="feature solo">/g) || []).length === 2 && /#mktLanding \.feature\.solo\{grid-template-columns:1fr/.test(html));
  // EVERY REMAINING ILLUSTRATION IS A REAL SCREENSHOT. Five .fimg blocks are
  // left -- the hero and the four features that always had a capture -- and
  // each one holds a base64 JPEG. The two that held hand-written markup are
  // gone entirely, which is what the counts below pin.
  const fimgs = (html.match(/<div class="fimg">/g) || []).length;
  const withShot = (html.match(/<div class="fimg">\s*(<div class="browser">[\s\S]{0,200}?)?<img src="data:image\/jpeg;base64,/g) || []).length;
  ok('every illustration left on the page is a real screenshot', fimgs === 5 && withShot === 5, { fimgs, withShot });
  ok('  the two fabricated ones are gone, not merely emptied',
    (html.match(/<div class="feature solo">/g) || []).length === 2 && !/class="cardui"/.test(html));

  // ── EACH SCRIPT LOADS ONCE ─────────────────────────────────────────────
  OUT.push('', '-- nine scripts, once each --');
  const NINE = ['calendar', 'pipeline', 'search', 'analytics', 'nil-extras', 'email', 'outreach-engine', 'assistant', 'onboarding'];
  const tags = (html.match(/<script[^>]*src="([^"]*)"/g) || []).map((t) => (t.match(/src="([^"]*)"/) || [])[1]);
  for (const n of NINE) {
    const c = tags.filter((t) => t === `/${n}.js`).length;
    ok(`${n}.js is loaded exactly once`, c === 1, c);
  }
  ok('  and nothing else is loaded from a tag we did not count', tags.length === NINE.length, tags);
  // A second <script src> is one way to run an init twice; injecting one at
  // runtime is the other. Neither happens.
  ok('NO SCRIPT IS INJECTED AT RUNTIME, so the rendered DOM cannot grow a second copy',
    !/createElement\(['"]script['"]\)/.test(html)
    && NINE.every((n) => !/createElement\(['"]script['"]\)/.test(src(`public/${n}.js`))));
  // Each file starts itself once: either one DOMContentLoaded listener, or the
  // readyState guard, which is the same thing for a script that loads late.
  for (const n of NINE) {
    const s = src(`public/${n}.js`);
    const listeners = (s.match(/addEventListener\('DOMContentLoaded'/g) || []).length;
    ok(`${n}.js registers at most one DOMContentLoaded entry point`, listeners <= 1, listeners);
  }
  for (const n of ['email', 'onboarding']) {
    const s = src(`public/${n}.js`);
    ok(`${n}.js uses the readyState guard, so it starts once whenever it loads`,
      /if \(document\.readyState === 'loading'\)[\s\S]{0,140}?addEventListener\('DOMContentLoaded'/.test(s));
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('siteroutes: FAILED', e); process.exit(1); });
