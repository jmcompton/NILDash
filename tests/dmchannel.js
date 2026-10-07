'use strict';
// No database needed.
//
//   node tests/dmchannel.js
//
// ── A HANDLE AND NO EMAIL IS A DM CARD, ON THE UNIVERSITY SIDE ──────────────
// channelOf put the phone before Instagram, and nearly every business has a
// phone on its listing, so Cypress's cardsByChannel.dm was 0 every night with
// 66 handles on 88 businesses. The university side (campusChannelOf) is
// email, DM, call, and never a chain's corporate account; the agent side
// (channelOf) is unchanged until it is decided separately.
const path = require('path');
const CHN = require(path.join(__dirname, '..', 'server/services/cardChannel.js'));
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── THE AGENT SIDE: unchanged (email, call, DM) ────────────────────────────
ok('AGENT: a handle and a phone, no email: still a call', CHN.channelOf({ phone: '(714) 555-0101', instagram: 'tacospot' }) === 'call');
ok('AGENT: a handle only: DM', CHN.channelOf({ instagram: '@tacospot' }) === 'dm');
ok('AGENT: an email beats both', CHN.channelOf({ email: 'ana@taco.test', phone: '(714) 555-0101', instagram: 'tacospot' }) === 'email');

// ── THE UNIVERSITY SIDE: email, DM, call ───────────────────────────────────
const U = (o) => CHN.campusChannelOf(o);
ok('UNIVERSITY: a handle and a phone, no email: DM', U({ phone: '(714) 555-0101', instagram: 'tacospot', brand: 'Taco Spot', city: 'Cypress, CA' }) === 'dm');
ok('UNIVERSITY: a handle only: DM', U({ instagram: '@tacospot', brand: 'Taco Spot', city: 'Cypress, CA' }) === 'dm');
ok('UNIVERSITY: a phone only: call', U({ phone: '(714) 555-0101' }) === 'call');
ok('UNIVERSITY: an email beats both', U({ email: 'ana@taco.test', phone: '(714) 555-0101', instagram: 'tacospot' }) === 'email');
ok('UNIVERSITY: a social brand is its program page, never a DM', U({ instagram: 'gripsocks', programUrl: 'https://grip.test/athletes', social: true }) === 'program');
ok('UNIVERSITY: nothing: no card', U({}) === null);
ok('UNIVERSITY: a handle that is not a handle is not a DM', U({ instagram: 'https://instagram.com/x y', phone: '(714) 555-0101' }) === 'call');

// ── A CHAIN LOCATION'S CORPORATE ACCOUNT IS NEVER A TEAM'S DM ─────────────
// The agent night's rule (instagramLookup.handleVerdict): a store whose name
// carries its town, whose handle does not, is the brand's account.
const chain = { brand: '85°C Bakery Cafe Cypress', instagram: '85cbakerycafe', city: 'Cypress, CA' };
ok('CHAIN: the store links to the corporate handle: not a DM card', U({ ...chain, phone: '(714) 555-0102' }) === 'call', U({ ...chain, phone: '(714) 555-0102' }));
ok('  and with no phone, no card at all (never the corporate DM)', U(chain) === null, U(chain));
ok('  the handle is not offered beside an email either', CHN.campusHandle(chain) === null);
ok('  a lookup that already said brand-wide is respected', U({ instagram: 'rallyhouse', instagramScope: 'brand', phone: '(479) 555-0103' }) === 'call');
ok('  the agent rule, same verdict: Rally House Fayetteville and @rallyhouse', CHN.campusHandle({ brand: 'Rally House Fayetteville', instagram: 'rallyhouse', city: 'Fayetteville, AR' }) === null);
ok('A LOCAL BUSINESS NAMED FOR THE TOWN keeps its own DM', U({ brand: 'Cypress Coffee Co', instagram: 'cypresscoffee', city: 'Cypress, CA', phone: '(714) 555-0104' }) === 'dm');

// APPROVING A DM CARD NEVER REACHES THE EMAIL SENDER: approve is refused up
// front with what to do instead (mark it sent), for the agent and the department.
const v = CHN.canSend({ channel: 'dm', phone: '(714) 555-0101', instagram: 'tacospot' });
ok('approve on a DM card: refused, as a DM task', v.ok === false && v.channel === 'dm' && /send it as a DM, and mark it sent/.test(v.why), v);
ok('  an email card still sends', CHN.canSend({ email: 'ana@taco.test', instagram: 'tacospot' }).ok === true);

console.log(OUT.join('\n'));
console.log(`\n${OUT.length - F}/${OUT.length} passed`);
process.exit(F ? 1 : 0);
