'use strict';
// No database needed.
//
//   node tests/cardrules.js
//
// ── SMALL CARD FIXES FROM THE CYPRESS REVIEW (CARD_RULES_ON) ────────────────
//   DSW / Designer Brands and DXL / Destination XL are national chains
//   "staff", "employee", "team member", or a creative role (videographer,
//   photographer, designer) is refused unless the title also says owner,
//   founder, general manager or marketing -- on agent and university cards
//   alike, through the shared title check
//   "(per news)" and "(state filing)" are dropped from the title shown on a
//   card (Home, university, the cold agent's email); the record keeps them
//   off: nothing changes
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
delete process.env.CARD_RULES_ON;

const NC = require(REPO + 'server/services/nationalChains.js');
const ONS = require(REPO + 'server/services/ownerNameSearch.js');
const CQ = require(REPO + 'server/services/campusQuality.js');
const CT = require(REPO + 'server/services/cardTitle.js');
const CM = require(REPO + 'server/services/campusMarket.js');
const AC = require(REPO + 'server/services/actionable.js');
const CA = require(REPO + 'server/services/coldAgent.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const on = () => { process.env.CARD_RULES_ON = '1'; };
const off = () => { delete process.env.CARD_RULES_ON; };
const agentRefuses = (t) => !!ONS.titleProblem(t);
const univRefuses = (t) => !!CQ.refusedTitle(t);

// ── 1. CHAINS ──────────────────────────────────────────────────────────────
OUT.push('-- national chains --');
off();
ok('off: Designer Brands and DXL are not on the list yet', !NC.isNationalChain('DXL Destination XL') && !NC.isChainLocation('Designer Brands Outlet'));
ok('  DSW already was', NC.isNationalChain('DSW Designer Shoe Warehouse'));
on();
ok('on: DXL, Destination XL and Designer Brands are national chains', NC.isNationalChain('DXL Destination XL') && NC.isNationalChain('Destination XL #212')
  && NC.isNationalChain('Designer Brands Inc'));
ok('  and count as a chain location when deciding who to pitch', NC.isChainLocation('DXL Big + Tall') === 'dxl' && NC.isChainLocation('Designer Brands Outlet') === 'designer brands');
ok('  "dxl" is a whole word: Redxl Auto is not flagged', !NC.isNationalChain('Redxl Auto') && !NC.isChainLocation('Redxl Auto'));
ok('  a founder at a DXL is the parent company\'s, not this location\'s', /parent company's leadership/.test(ONS.titleProblem('Founder', { brand: 'DXL Destination XL', city: 'Waco' }) || ''));
off();

// ── 2. TITLES, BOTH SIDES ─────────────────────────────────────────────────
OUT.push('', '-- titles: agent and university cards, one rule --');
on();
for (const t of ['Staff', 'Staff Member', 'Employee', 'Team Member', 'Videographer', 'Photographer', 'Graphic Designer']) {
  ok(`"${t}" is refused on agent and university cards`, agentRefuses(t) && univRefuses(t), [ONS.titleProblem(t), CQ.refusedTitle(t)]);
}
for (const t of ['Owner & Photographer', 'Co-Founder, Designer', 'Marketing Designer', 'General Manager / Staff', 'Owner']) {
  ok(`"${t}" is allowed on both (it also says owner, founder, general manager or marketing)`, !agentRefuses(t) && !univRefuses(t), [ONS.titleProblem(t), CQ.refusedTitle(t)]);
}
ok('the reason says what we want instead', /we want the owner, a founder, the general manager or the marketing lead/.test(ONS.titleProblem('Staff')));
ok('the university side reads it from the shared check (one rule, not two)', /require\('\.\/ownerNameSearch'\)\.titleProblem\(t\)/.test(require('fs').readFileSync(REPO + 'server/services/campusQuality.js', 'utf8')));
ok('  its other refusals are unchanged (barista, intern, influencer)', univRefuses('Barista') && univRefuses('Intern') && univRefuses('Influencer'));
off();
ok('off: as before -- "Staff" passes on agent cards, "Owner & Photographer" is refused on university cards',
  !agentRefuses('Staff') && !agentRefuses('Employee') && univRefuses('Owner & Photographer') && univRefuses('Videographer'));

// ── 3. THE TITLE SHOWN ─────────────────────────────────────────────────────
OUT.push('', '-- source notes off the card, kept in the record --');
on();
const cases = [['Owner (per news)', 'Owner'], ['Registered Agent (state filing)', 'Registered Agent'], ['Owner (operator, per news report)', 'Owner'],
  ['Member (state filing)', 'Member'], ['Co-Owner (per LinkedIn), Marketing', 'Co-Owner, Marketing']];
for (const [a, b] of cases) ok(`"${a}" is shown as "${b}"`, CT.displayTitle(a) === b, CT.displayTitle(a));
ok('a bracket about the person stays: "(Tempe)", "(not confirmed owner)"', CT.displayTitle('General Manager (Tempe)') === 'General Manager (Tempe)'
  && CT.displayTitle('Owner (not confirmed owner)') === 'Owner (not confirmed owner)');
ok('a title that was only a note is shown as stored, never as nothing', CT.displayTitle('(per news)') === '(per news)' && CT.displayTitle(null) === null);
const q = AC.normQueue({ id: 7, athlete_id: 'a', brand_name: 'Fernbrook Pizza', channel: 'dm', contact_name: 'Dana Reed', contact_title: 'Owner (per news)', created_at: new Date() });
ok('HOME: a card shows "Owner"', q.contactTitle === 'Owner', q.contactTitle);
const e = AC.normEmail({ id: 'l1', athlete_id: 'a', brand_name: 'Fernbrook Pizza', contact_name: 'Dana Reed', contact_title: 'Registered Agent (state filing)', created_at: new Date() });
ok('  an email card too', e.contactTitle === 'Registered Agent', e.contactTitle);
const rec = { id: 'u1', brand_name: 'Fernbrook Pizza', contact_name: 'Dana Reed', contact_title: 'Owner (per news)', contact_email: 'dana@fernbrook.com', lane: 'local', channel: 'email' };
const card = CM.cardForPortal(rec, 'Baylor');
ok('UNIVERSITY: a card shows "Owner", and the record it came from still says "(per news)"', card.contact_title === 'Owner' && rec.contact_title === 'Owner (per news)', [card.contact_title, rec.contact_title]);
const mail = CA.templateEmail({ u: { name: 'Kim Lowe', athletes: 1 }, subject: { kind: 'their athlete', name: 'Tess Court', school: 'Auburn University' },
  cards: [1, 2, 3].map((i) => ({ brandName: 'Court Side Grill ' + i, contactName: 'Dana Kessler ' + i, contactTitle: 'Owner (per news)' })), senderFull: 'JohnMark', touchNo: 1, research: {} });
ok('THE COLD AGENT\'S EMAIL: "- Court Side Grill 1: Dana Kessler 1, Owner"', /- Court Side Grill 1: Dana Kessler 1, Owner\n/.test(mail.body) && !/per news/.test(mail.body), mail.body);
off();
ok('off: every title is shown exactly as stored', CT.displayTitle('Owner (per news)') === 'Owner (per news)'
  && AC.normQueue({ id: 8, contact_title: 'Owner (per news)', created_at: new Date() }).contactTitle === 'Owner (per news)');

const pass = OUT.filter((l) => l.startsWith('PASS')).length;
console.log(OUT.join('\n'));
console.log(`\n${pass}/${pass + F} passed`);
process.exit(F ? 1 : 0);
