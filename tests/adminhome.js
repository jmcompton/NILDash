'use strict';
// The admin home (services/adminHome) and the admin page it lives on.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..') + '/';
let fails = 0;
function ok(name, cond, got) { if (cond) console.log('  PASS ' + name); else { fails++; console.log('  FAIL ' + name + '  got=' + JSON.stringify(got)); } }

const H = require(ROOT + 'server/services/adminHome');

console.log('\n-- THE WINDOW IS BOUNDED --');
ok('default is 30 days', H._days(undefined) === 30, H._days(undefined));
ok('  a silly value is clamped', H._days(9999) === 365 && H._days(-4) === 1, [H._days(9999), H._days(-4)]);

console.log('\n-- WHAT NEEDS ME --');
{
  const old = new Date(Date.now() - 6 * 86400000).toISOString();
  const a = H._attention([
    { name: 'Busy', waiting: 15, oldestWaiting: old },
    { name: 'Fine', waiting: 15, oldestWaiting: new Date().toISOString() },
    { name: 'Few', waiting: 3, oldestWaiting: old },
  ], [{ athlete: 'A', agent: 'Busy', fresh: 0 }, { athlete: 'B', agent: 'Busy', fresh: 3 }]);
  ok('an agent sitting on 10+ pitches for 3+ days is flagged', a.some((x) => /Busy has 15 pitches waiting/.test(x.title)), a);
  ok('  fresh pitches are not nagged about', !a.some((x) => /Fine/.test(x.title)), a);
  ok('  nor a handful', !a.some((x) => /Few/.test(x.title)), a);
  ok('  athletes under five are counted, with how many got none', a.some((x) => /2 athletes got fewer than 5/.test(x.title) && /1 got none/.test(x.detail)), a);
  ok('  nothing to say says nothing', H._attention([], []).length === 0);
}

console.log('\n-- THE PAGE --');
{
  const html = fs.readFileSync(ROOT + 'public/admin.html', 'utf8');
  ok('nothing after </html> (a stray copy printed raw code on the page)', /<\/html>\s*$/.test(html));
  ok('  the deal counter loader exists exactly once', (html.match(/async function loadDealCounter\(/g) || []).length === 1);
  ok('  and the brand flags loader', (html.match(/async function loadBrandFlags\(/g) || []).length === 1);
  ok('  the home reads its own route', /\/api\/admin\/home\?days=/.test(html));
  ok('  every tab button has a target', ['home', 'agents', 'accounts', 'universities', 'email', 'tools', 'referrals']
    .every((t) => html.includes('data-go="' + t + '"')));
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('  the route is admin-gated', /app\.get\('\/api\/admin\/home', requireAuth,[\s\S]{0,200}_inboundAdminOk\(user\)/.test(idx));
}

console.log('\nfailures: ' + fails);
process.exit(fails ? 1 : 0);
