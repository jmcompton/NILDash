'use strict';
// No database needed.
//
//   node tests/dmchannel.js
//
// ── A HANDLE AND NO EMAIL IS A DM CARD ──────────────────────────────────────
// channelOf put the phone before Instagram, and nearly every business has a
// phone on its listing, so Cypress's cardsByChannel.dm was 0 every night with
// 66 handles on 88 businesses. Email, then DM, then call.
const path = require('path');
const CHN = require(path.join(__dirname, '..', 'server/services/cardChannel.js'));
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

ok('a handle and a phone, no email: DM', CHN.channelOf({ phone: '(714) 555-0101', instagram: 'tacospot' }) === 'dm');
ok('a handle only: DM', CHN.channelOf({ instagram: '@tacospot' }) === 'dm');
ok('a phone only: call', CHN.channelOf({ phone: '(714) 555-0101' }) === 'call');
ok('an email beats both', CHN.channelOf({ email: 'ana@taco.test', phone: '(714) 555-0101', instagram: 'tacospot' }) === 'email');
ok('a social brand is its program page, never a DM', CHN.channelOf({ instagram: 'gripsocks', programUrl: 'https://grip.test/athletes', social: true }) === 'program');
ok('nothing: no card', CHN.channelOf({}) === null);
ok('a handle that is not a handle is not a DM', CHN.channelOf({ instagram: 'https://instagram.com/x y', phone: '(714) 555-0101' }) === 'call');

// APPROVING A DM CARD NEVER REACHES THE EMAIL SENDER: approve is refused up
// front with what to do instead (mark it sent), for the agent and the department.
const v = CHN.canSend({ phone: '(714) 555-0101', instagram: 'tacospot' });
ok('approve on a DM card: refused, as a DM task', v.ok === false && v.channel === 'dm' && /send it as a DM, and mark it sent/.test(v.why), v);
ok('  an email card still sends', CHN.canSend({ email: 'ana@taco.test', instagram: 'tacospot' }).ok === true);

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
