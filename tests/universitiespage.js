'use strict';
// No database. Run:  node tests/universitiespage.js
//
// ── THE UNIVERSITIES SALES PAGE (public/universities.html) ─────────────────
// The page NIL directors and ADs are sent to. It must be public, carry the
// same prices and guarantee as the business plan, show only real image files,
// never claim NILDash negotiates or represents athletes, and read as plain
// copy (no em dashes).
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..') + path.sep;
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };

const html = fs.readFileSync(REPO + 'public/universities.html', 'utf8');
const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');

ok('served at /universities, public, no-cache', /app\.get\(\['\/universities', '\/universities\/'\], \(req, res\) => \{\s*res\.sendFile\(path\.join\(__dirname, '\.\.', 'public', 'universities\.html'\),\s*\{ cacheControl: false, headers: \{ 'Cache-Control': DEMO_NO_CACHE \} \}\)/.test(idx));
ok('  the route sits above the app catch-all', idx.indexOf("app.get(['/universities'") > 0 && (idx.indexOf("app.get('*'") === -1 || idx.indexOf("app.get(['/universities'") < idx.indexOf("app.get('*'")));
ok('in the sitemap', /<loc>https:\/\/mynildash\.com\/universities<\/loc>/.test(fs.readFileSync(REPO + 'public/sitemap.xml', 'utf8')));

const imgs = [...html.matchAll(/src: '([a-z]+)'/g)].map((m) => m[1]).concat([...html.matchAll(/\/images\/universities\/([a-z]+)\.webp/g)].map((m) => m[1]));
const missing = [...new Set(imgs)].filter((n) => !fs.existsSync(REPO + 'public/images/universities/' + n + '.webp'));
ok('every screen image exists', imgs.length >= 5 && missing.length === 0, missing);
ok('five screens, five tabs, only screens the product has (no AD report or follow-through mockups)', (html.match(/class="tab"/g) || []).length === 5 && (html.match(/\{ src: '/g) || []).length === 5
  && !/src: '(report|followthrough|requestlink)'/.test(html));
ok('screens are labeled as a sample', /Sample school and sample data/.test(html));

ok('the offer: free until a business pays one of your athletes, then D1 $1,000, D2/NAIA $500, JUCO $300', /Free until your athletes get paid/.test(text) && /\$0/.test(text)
  && /\$1,000 \/ month/.test(text) && /\$500 \/ month/.test(text) && /\$300 \/ month/.test(text) && !/\$1,500|refund the pilot/.test(text));
ok('promises only what is built: no NIL Go filing, donor holds, sponsor lists, 30-a-day sending or monthly report', !/prepares the NIL Go report|held for your compliance|sponsor list|30 a day|monthly report|sponsor lead/i.test(text));
ok('works alongside their marketplace, Teamworks and NIL Go', /sent to your marketplace page/.test(text) && /Teamworks/.test(text) && /deal summary/.test(text));
ok('says NILDash does not negotiate or represent athletes', /does not sign, negotiate or take a cut/.test(text) && /Does NILDash represent athletes or negotiate deals\?/.test(text) && /No\. NILDash is software for your NIL office/.test(text));
ok('never claims to negotiate, close or represent', !/we (negotiate|close|represent)|negotiates? (your|the) deal/i.test(text));
ok('no em dashes or en dashes in the copy', !/[—–]/.test(html) && !/&mdash;|&ndash;/.test(html));
ok('every booking button is a real mailto', (html.match(/href="mailto:john@comptongroupllc\.com\?subject=/g) || []).length === 3);
ok('no external scripts', !/<script[^>]+src=/.test(html));
ok('mobile layout rules present', /@media \(max-width:900px\)/.test(html) && /@media \(max-width:560px\)/.test(html) && /name="viewport"/.test(html));

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
