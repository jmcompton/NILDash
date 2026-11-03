'use strict';
// Builds public/portal-demo.js: the sample data behind /portal-room/demo.
//
//   node scripts/build-portal-demo.js
//
// Every school, person and number in it is MADE UP and labeled sample on the
// page: the demo shows what the Portal Room does without saying anything
// about a real program. The numbers still come out of the real code (the
// offer compare, the checks, the family update, the email, the CSC market
// data), so the demo cannot drift from what agents actually get.
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'server', 'services', 'portalRoom');
const O = require(path.join(R, 'offers'));
const V = require(path.join(R, 'value'));
const T = require(path.join(R, 'targets'));
const C = require(path.join(R, 'contacts'));
const P = require(path.join(R, 'positions'));

const NOW = new Date('2026-12-28T15:00:00Z');
const SCHOOLS = [
  { name: 'Midwest Tech', level: 'P4', conference: 'Sample P4 conference', state: 'IA', on: 9, leaving: 5, coach: null },
  { name: 'River City University', level: 'P4', conference: 'Sample P4 conference', state: 'TX', on: 10, leaving: 4, coach: { coach: 'The head coach', how: 'fired', date: '2026-11-24' } },
  { name: 'Summit University', level: 'P4', conference: 'Sample P4 conference', state: 'CO', on: 11, leaving: 3, coach: null },
  { name: 'Bayou State', level: 'G5', conference: null, state: 'LA', on: 8, leaving: 4, coach: null },
  { name: 'Coastal A&M', level: 'G5', conference: null, state: 'TX', on: 12, leaving: 2, coach: null },
  { name: 'Northern Plains', level: 'P4', conference: 'Sample P4 conference', state: 'NE', on: 14, leaving: 3, coach: null },
];
const MEDIAN = 8;
function needOf(s) {
  const back = s.on - s.leaving;
  const ratio = back / MEDIAN;
  let rating = ratio <= 0.75 ? 'high' : ratio < 1 ? 'medium' : 'low';
  if (s.coach && rating === 'low') rating = 'medium';
  return { rating, on: s.on, leaving: s.leaving, back, median: MEDIAN, line: `${s.on} wide receivers on the roster, ${s.leaving} seniors or older likely leaving, ${back} coming back (FBS median ${MEDIAN}).` };
}
const row = (s, named, score) => {
  const n = needOf(s);
  const reasons = [];
  if (n.rating === 'high') reasons.push(`Thin at WR: ${n.back} coming back against a median of ${MEDIAN}`);
  else if (n.rating === 'medium') reasons.push(`Below average at WR: ${n.back} back, median ${MEDIAN}`);
  if (s.coach) reasons.push('New head coach coming: the head coach was fired Nov 24. A new staff reshuffles the room.');
  if (named) reasons.push('On his list');
  if (s.state === 'TX') reasons.push('In his home state');
  if (s.level === 'P4') reasons.push('Power 4');
  return { school: s.name, level: s.level, conference: s.conference, state: s.state, score, named, need: n, coachingChange: s.coach, reasons, rosterReadAt: NOW };
};
const board = {
  group: 'WR', groupLabel: 'Wide receivers', median: MEDIAN, medianFrom: '131 FBS rosters (sample)', rostersRead: 131, totalSchools: 136,
  dream: [row(SCHOOLS[2], true, 71)],
  options: [row(SCHOOLS[1], false, 84), row(SCHOOLS[0], false, 80), row(SCHOOLS[3], false, 66), row(SCHOOLS[4], false, 58), row(SCHOOLS[5], false, 49)],
  unknownSchools: [], value: V.forGroup('WR'), valueLine: V.line('WR'),
};

const enter = {
  verdict: { level: 'ok', text: 'The market is open: 23 schools are thin at WR. Build the target list below.' },
  points: [
    { level: 'ok', text: '2 seasons left to play at a new school (his 5-year clock runs through 2028-29).' },
    { level: 'ok', text: 'First transfer: it costs him nothing.' },
    { level: 'ok', text: `What a WR is paid: ${V.line('WR')}` },
    { level: 'ok', text: '23 FBS schools are thin at WR (9 of them Power 4), from 131 rosters read.' },
  ],
  windows: { main: { opens: '2027-01-02', closes: '2027-01-16', text: 'The football portal window is Jan 2 to 16, 2027.' }, postseason: 'A player whose team is still playing gets 5 days after his last game.', coachingChange: 'When a school names a new head coach, its players get a 30-day window.' },
  status: 'pending',
};

const staff = (school) => [
  { name: 'Sample GM', title: 'General Manager', role: 'general_manager', is_key_contact: true, status: 'current', email: 'gm@example.edu', source_url: null },
  { name: 'Sample Personnel', title: 'Director of Player Personnel', role: 'player_personnel', is_key_contact: true, status: 'current' },
  { name: 'Sample Coach', title: 'Wide Receivers Coach', role: 'staff', status: 'current', email: 'wr@example.edu' },
  { name: 'Sample Coordinator', title: 'Offensive Coordinator', role: 'staff', status: 'current' },
  { name: 'Sample Recruiting', title: 'Director of Recruiting', role: 'recruiting', is_key_contact: true, status: 'current', email: 'recruiting@example.edu' },
  { name: 'Sample Head Coach', title: 'Head Coach', role: 'head_coach', is_key_contact: true, status: 'current' },
];
const school = {};
for (const s of SCHOOLS) {
  const book = C.build({ school: s.name, group: 'WR', rows: staff(s.name), contact: { office_phone: '(555) 010-0100', collective_name: `${s.name.split(' ')[0]} Collective (sample)` } });
  school[s.name] = { name: s.name, level: s.level, conference: s.conference, state: s.state, group: 'WR', groupLabel: 'Wide receivers',
    room: { read: true, rosterUrl: null, leavingPlayers: Array.from({ length: s.leaving }, (_, i) => ({ name: `Sample Player ${i + 1}`, year: i % 2 ? 'Sr.' : 'Gr.' })) },
    contacts: book };
}

const profile = { name: 'Jordan Hayes', position: 'Wide Receiver', group: 'WR', school: 'Lakeshore State', heightWeight: '6-1, 195', seasonsLeft: 2, statsLine: '2026: 58 catches, 912 yards, 7 TD in 9 games', filmUrl: 'https://example.com/film', agent: { name: 'Your name', phone: '(555) 010-0199', email: 'you@youragency.com' } };
const targets = {
  stages: T.STAGES.map((k) => ({ key: k, label: T.STAGE_LABEL[k] })),
  profile: { token: 'demo', live: true, views: 7, data: { heightWeight: '6-1, 195', statsLine: profile.statsLine, filmUrl: profile.filmUrl } },
  targets: [
    { id: 't1', school: 'Summit University', stage: 'interested', stageLabel: 'Interested', nextStep: 'Call the GM Thursday' },
    { id: 't2', school: 'River City University', stage: 'offer', stageLabel: 'Offer in', nextStep: 'Get the NIL work in writing' },
    { id: 't3', school: 'Midwest Tech', stage: 'offer', stageLabel: 'Offer in', nextStep: '' },
    { id: 't4', school: 'Bayou State', stage: 'contacted', stageLabel: 'Contacted', nextStep: 'Follow up Jan 3' },
  ],
};
const emails = {};
for (const t of targets.targets) {
  emails[t.id] = { ...T.emailFor({ school: t.school, book: school[t.school].contacts, profile, profileUrl: 'https://mynildash.com/portal-profile/sample', agentName: 'Your name', group: 'WR' }), target: t, hasProfile: true };
}

const offers = [
  { id: 'o1', school: 'Midwest Tech', status: 'in_writing', guaranteedPerYear: 185000, nilPerYear: null, years: 2, inWriting: true },
  { id: 'o2', school: 'River City University', status: 'offered', guaranteedPerYear: 160000, nilPerYear: 90000, nilPayer: 'collective', nilDeliverables: '4 posts, 2 appearances', years: 1, inWriting: true, expiresOn: '2026-12-31' },
  { id: 'o3', school: 'Summit University', status: 'talking', guaranteedPerYear: 120000, nilPerYear: 400000, nilPayer: 'collective', years: 1, inWriting: false },
  { id: 'o4', school: 'Bayou State', status: 'offered', guaranteedPerYear: 70000, nilPerYear: 40000, nilPayer: 'business', nilDeliverables: '2 appearances', years: 1, inWriting: true, expiresOn: '2027-01-09' },
];
const ob = O.compare(offers, { seasonsLeft: 2, now: NOW, windows: enter.windows, group: 'WR' });
// Real code, fictional schools: the level comes from the sample list.
for (const o of ob.offers) {
  const s = SCHOOLS.find((x) => x.name === o.school);
  o.level = s.level; o.conference = s.conference;
  o.checks = o.checks.filter((c) => c.rule !== 'market').concat([V.place(o.perYear, 'WR', s.level)].filter(Boolean).map((x) => ({ ...x, rule: 'market' })));
}
const offerBoard = { ...ob, seasonsLeft: 2, group: 'WR', value: V.forGroup('WR'), family: O.familyUpdate({ athleteName: 'Jordan Hayes', agentName: 'Your name', board: ob, now: NOW }) };

const meta = {
  groups: P.GROUPS.map((g) => ({ key: g, label: P.LABEL[g] })),
  schools: SCHOOLS.map((s) => ({ name: s.name, level: s.level, conference: s.conference, state: s.state })),
  regions: ['Southeast', 'Northeast', 'Midwest', 'Southwest', 'West'],
  windows: enter.windows,
};
const athletes = [{ id: 'demo-1', name: 'Jordan Hayes', school: 'Lakeshore State', position: 'WR', hometown: 'Dallas, TX', sport: 'Football' }];
const wishlist = { prefs: { group: 'WR', currentSchool: 'Lakeshore State', currentLevel: 'G5', homeState: 'TX', birthDate: '2006-03-10', firstEnrollment: '2024-08-20', priorTransfers: 0, schools: ['Summit University'], states: ['TX'], regions: [], level: 'any', closeToHome: true } };

const data = { meta, athletes, wishlist, enter, board, school, targets, emails, offerBoard };
const out = `// GENERATED by scripts/build-portal-demo.js. Do not edit by hand.
// Sample data for /portal-room/demo: every school, person and number is made up.
window.PORTAL_DEMO = ${JSON.stringify(data)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'portal-demo.js'), out);
console.log('wrote public/portal-demo.js', out.length, 'bytes');
