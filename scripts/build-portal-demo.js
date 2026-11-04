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
const W = require(path.join(R, 'workspace'));
const WINDOWS = require(path.join(R, 'windows')).football;

const NOW = new Date('2026-12-28T15:00:00Z');
const SCHOOLS = [
  { name: 'Midwest Tech', level: 'P4', conference: 'Sample P4 conference', state: 'IA', on: 9, leaving: 5, coach: null },
  { name: 'River City University', level: 'P4', conference: 'Sample P4 conference', state: 'TX', on: 10, leaving: 4, coach: { coach: 'The head coach', how: 'fired', date: '2026-11-24' } },
  { name: 'Summit University', level: 'P4', conference: 'Sample P4 conference', state: 'CO', on: 11, leaving: 3, coach: null },
  { name: 'Bayou State', level: 'G5', conference: null, state: 'LA', on: 8, leaving: 4, coach: null },
  { name: 'Coastal A&M', level: 'G5', conference: null, state: 'TX', on: 12, leaving: 2, coach: null },
  { name: 'Northern Plains', level: 'P4', conference: 'Sample P4 conference', state: 'NE', on: 14, leaving: 3, coach: null },
  { name: 'Pine Valley University', level: 'P4', conference: 'Sample P4 conference', state: 'OK', on: 9, leaving: 4, coach: null },
  { name: 'Granite Tech', level: 'G5', conference: null, state: 'NM', on: 10, leaving: 3, coach: null },
  { name: 'Harbor State', level: 'G5', conference: null, state: 'TX', on: 11, leaving: 4, coach: null },
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
  options: [row(SCHOOLS[1], false, 84), row(SCHOOLS[0], false, 80), row(SCHOOLS[6], false, 77), row(SCHOOLS[3], false, 66), row(SCHOOLS[8], false, 63), row(SCHOOLS[7], false, 60), row(SCHOOLS[4], false, 58), row(SCHOOLS[5], false, 49)],
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
  windows: WINDOWS,
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
    { id: 't1', school: 'Summit University', stage: 'interested', nextStep: 'Call the GM Thursday', dueOn: '2026-12-31' },
    { id: 't2', school: 'River City University', stage: 'offer', nextStep: 'Get the NIL work in writing', dueOn: '2026-12-28' },
    { id: 't3', school: 'Midwest Tech', stage: 'offer', nextStep: 'Compare against River City with the family', dueOn: '2026-12-29' },
    { id: 't4', school: 'Bayou State', stage: 'offer', nextStep: 'Ask what the two appearances are', dueOn: '2026-12-27' },
    { id: 't5', school: 'Pine Valley University', stage: 'visit', nextStep: 'Confirm the visit date', dueOn: '2026-12-30' },
    { id: 't6', school: 'Northern Plains', stage: 'replied', nextStep: 'Send film to the WR coach', dueOn: '2027-01-02' },
    { id: 't7', school: 'Granite Tech', stage: 'contacted', nextStep: 'Second email to recruiting', dueOn: '2027-01-03' },
    { id: 't8', school: 'Coastal A&M', stage: 'contacted', nextStep: 'Call the football office', dueOn: '2027-01-03' },
    { id: 't9', school: 'Harbor State', stage: 'target', nextStep: 'Send his one-pager', dueOn: null },
  ].map((t) => ({ ...t, stageLabel: T.STAGE_LABEL[t.stage], notes: null, lastTouchAt: null, updatedAt: NOW })),
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

// The workspace (what /portal-room opens to), from the real assemble().
const at = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86400000).toISOString();
const A = (id, school, list) => list.map(([k, contact, text, d], i) => ({ id: `${id}-${i}`, targetId: id, school, kind: k, kindLabel: T.KIND_LABEL[k], contact, text, at: at(d) }));
const activity = {
  t2: A('t2', 'River City University', [['reply', 'General manager / football ops', 'Offer coming: $160k guaranteed plus collective NIL', 1], ['call', 'Position coach (WR)', 'Wants him on campus before the window', 3], ['email', 'Player personnel', 'Sent film and the one-pager', 6], ['added', null, 'Added to his list', 9]]),
  t3: A('t3', 'Midwest Tech', [['reply', 'Player personnel', 'Offer in writing: $185k a year for 2 years', 2], ['email', 'General manager / football ops', 'Sent the one-pager', 7], ['added', null, 'Added to his list', 9]]),
  t1: A('t1', 'Summit University', [['reply', 'Recruiting', 'Interested, GM to call', 2], ['email', 'Recruiting', 'Sent the one-pager', 5], ['added', null, 'Added to his list', 9]]),
  t5: A('t5', 'Pine Valley University', [['visit', 'Position coach (WR)', 'Visit offered for the first week of the window', 1], ['email', 'Position coach (WR)', 'Sent film', 4], ['added', null, 'Added to his list', 8]]),
  t6: A('t6', 'Northern Plains', [['reply', 'Position coach (WR)', 'Asked for full-game film', 0], ['opened', null, 'Someone at Northern Plains opened his one-pager', 1], ['email', 'Player personnel', 'Sent the one-pager', 3], ['added', null, 'Added to his list', 8]]),
  t4: A('t4', 'Bayou State', [['reply', 'Player personnel', 'Offer: $70k guaranteed plus $40k NIL from a local business', 2], ['email', 'Player personnel', 'Sent the one-pager', 5], ['added', null, 'Added to his list', 8]]),
  t7: A('t7', 'Granite Tech', [['email', 'Recruiting', 'Sent the one-pager', 4], ['added', null, 'Added to his list', 6]]),
  t8: A('t8', 'Coastal A&M', [['email', 'Recruiting', 'Sent the one-pager', 1], ['added', null, 'Added to his list', 2]]),
  t9: A('t9', 'Harbor State', [['added', null, 'Added to his list', 2]]),
};
const allActivity = Object.values(activity).flat().sort((a, b) => b.at.localeCompare(a.at));
// Sample opens of his one-pager (services/portalRoom/opens).
const opens = { t2: { opens: 4, firstOpenAt: at(6), lastOpenAt: at(1) }, t6: { opens: 2, firstOpenAt: at(2), lastOpenAt: at(1) }, t7: { opens: 1, firstOpenAt: at(0), lastOpenAt: at(0) } };
const ws = W.assemble({ targets: targets.targets, boardRows: [...board.dream, ...board.options], rostersRead: board.rostersRead, totalSchools: board.totalSchools, activity: allActivity, offerBoard, windows: WINDOWS, opens, now: NOW });
for (const c of ws.cards) { const s = SCHOOLS.find((x) => x.name === c.school); c.level = s.level; c.conference = s.conference; c.state = s.state; }
const workspace = { athlete: { id: 'demo-1', name: 'Jordan Hayes', position: 'WR', school: 'Lakeshore State' }, group: 'WR', groupLabel: P.LABEL.WR, hasPlayerDetails: true, pcsaStatus: require(path.join(__dirname, '..', 'server', 'services', 'pcsa')).rules().status, ...ws, offers: offerBoard };
const clients = [
  { id: 'demo-1', name: 'Jordan Hayes', position: 'WR', school: 'Lakeshore State', schools: ws.stats.onList, committed: false, offers: offerBoard.offers.length },
  { id: 'demo-2', name: 'Devin James', position: 'CB', school: 'Sample College', schools: 6, committed: false, offers: 1 },
  { id: 'demo-3', name: 'Tre Owens', position: 'OL', school: 'Sample College', schools: 4, committed: false, offers: 0 },
];

const meta = {
  groups: P.GROUPS.map((g) => ({ key: g, label: P.LABEL[g] })),
  schools: SCHOOLS.map((s) => ({ name: s.name, level: s.level, conference: s.conference, state: s.state })),
  regions: ['Southeast', 'Northeast', 'Midwest', 'Southwest', 'West'],
  windows: enter.windows,
};
const athletes = [{ id: 'demo-1', name: 'Jordan Hayes', school: 'Lakeshore State', position: 'WR', hometown: 'Dallas, TX', sport: 'Football' }];
const wishlist = { prefs: { group: 'WR', currentSchool: 'Lakeshore State', currentLevel: 'G5', homeState: 'TX', birthDate: '2006-03-10', firstEnrollment: '2024-08-20', priorTransfers: 0, schools: ['Summit University'], states: ['TX'], regions: [], level: 'any', closeToHome: true } };

const data = { meta, athletes, wishlist, enter, board, school, targets, emails, offerBoard, workspace, clients, activity };
const out = `// GENERATED by scripts/build-portal-demo.js. Do not edit by hand.
// Sample data for /portal-room/demo: every school, person and number is made up.
window.PORTAL_DEMO = ${JSON.stringify(data)};
`;
fs.writeFileSync(path.join(__dirname, '..', 'public', 'portal-demo.js'), out);
console.log('wrote public/portal-demo.js', out.length, 'bytes');
