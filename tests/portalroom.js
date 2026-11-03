'use strict';
// ── THE PORTAL ROOM (services/portalRoom) ───────────────────────────────────
// Local test Postgres. No network: every roster page and model call is faked.
//
//   - positions and class years as rosters print them;
//   - a roster page read by the parser, a thin page rescued by the model, a
//     dead site recorded, and a bad read never replacing a good roster;
//   - the nightly sweep: stalest first, a slice, once a night, in the window;
//   - the need board: rooms, the FBS median, thin / some / deep, a new coach,
//     level and wish list, his schools first, unknown never guessed;
//   - the contact book: the right people in order, his position coach, nothing
//     constructed;
//   - should he enter: years left, a second transfer, the head coach exception;
//   - wish lists stay with the agent who saved them;
//   - routes, the page, and the nightly schedule are wired.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('portalroomtest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PORTAL_ROSTER_SWEEP;
delete process.env.PORTAL_ROSTER_MODEL;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const PR = require(REPO + 'server/services/portalRoom');
const Pos = require(REPO + 'server/services/portalRoom/positions');
const Schools = require(REPO + 'server/services/portalRoom/schools');
const Sweep = require(REPO + 'server/services/portalRoom/rosterSweep');
const Board = require(REPO + 'server/services/portalRoom/board');
const Contacts = require(REPO + 'server/services/portalRoom/contacts');
const Coaching = require(REPO + 'server/services/portalRoom/coachingChanges');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const NOW = new Date('2026-11-03T03:30:00Z');   // 9:30pm Central, Nov 2

// A Sidearm roster page: n players spread over the rooms, every third a senior or older.
const POSS = ['QB', 'RB', 'WR', 'WR', 'TE', 'OL', 'OL', 'DL', 'DL', 'LB', 'CB', 'S'];
const YEARS = ['Fr.', 'So.', 'R-Sr.', 'Jr.', 'Gr.', 'Sophomore'];
const FIRST = ['Jalen', 'Marcus', 'Tyler', 'Devon', 'Chris', 'Andre', 'Brandon', 'Isaiah', 'Caleb', 'Elijah', 'Jordan', 'Malik'];
const LAST = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Thomas', 'Jackson'];
function sidearm(n, { wrOn, wrLeaving } = {}) {
  const ps = [];
  let i = 0;
  const add = (pos, year) => { const nm = `${FIRST[i % 12]} ${LAST[Math.floor(i / 12) % 12]}${i >= 144 ? ' Jr' + i : ''}`; i++; ps.push({ nm, pos, year }); };
  if (wrOn != null) {
    for (let k = 0; k < wrOn; k++) add('WR', k < wrLeaving ? 'Sr.' : 'So.');
    while (ps.length < n) add(['QB', 'OL', 'DL', 'LB', 'CB', 'S', 'RB', 'TE'][ps.length % 8], 'Jr.');
  } else for (let k = 0; k < n; k++) add(POSS[k % POSS.length], YEARS[k % YEARS.length]);
  return `<html><body><ul>${ps.map((p, k) => `<li class="sidearm-roster-player"><div class="sidearm-roster-player-jersey-number">${k}</div>
    <div class="sidearm-roster-player-name"><a href="/x">${p.nm}</a></div>
    <div class="sidearm-roster-player-position"><span class="text-bold">${p.pos}</span></div>
    <span class="sidearm-roster-player-academic-year">${p.year}</span></li>`).join('')}</ul></body></html>`;
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  OUT.push('-- positions and class years --');
  const G = (x) => Pos.groupOf(x);
  ok('abbreviations', G('WR') === 'WR' && G('OT') === 'OL' && G('EDGE') === 'DL' && G('CB') === 'DB' && G('S') === 'DB' && G('OLB') === 'LB' && G('LS') === 'LS');
  ok('words and combos: the first position wins', G('Wide Receiver') === 'WR' && G('WR/KR') === 'WR' && G('DE/OLB') === 'DL' && G('Offensive Lineman') === 'OL');
  ok('a defensive tackle is not an offensive tackle', G('Defensive Tackle') === 'DL' && G('Nose Tackle') === 'DL' && G('Offensive Tackle') === 'OL');
  ok('an athlete with no position is unknown, not guessed', G('ATH') === null && G('') === null);
  const C = (y) => Pos.classOf(y).cls;
  ok('class years as printed', C('Fr.') === 'FR' && C('R-So.') === 'SO' && C('Junior') === 'JR' && C('R-Sr.') === 'SR' && C('Gr.') === 'GR' && C('Fifth Year') === '5TH' && C('6th') === '6TH' && C('Sophomore') === 'SO');
  ok('a redshirt is noticed', Pos.classOf('R-Jr.').redshirt === true && Pos.classOf('Jr.').redshirt === false);
  ok('seniors and older are likely leaving, juniors are not', Pos.isLeaving('Sr.') && Pos.isLeaving('Graduate') && Pos.isLeaving('Fifth Year') && !Pos.isLeaving('Jr.') && !Pos.isLeaving(''));

  OUT.push('-- schools --');
  const all = Schools.all();
  ok('every FBS school, Texas included, each with a state', all.length >= 136 && all.some((s) => s.name === 'Texas') && all.every((s) => s.state), all.filter((s) => !s.state).map((s) => s.name));
  ok('Power 4 is 68 schools (Notre Dame in)', all.filter((s) => s.level === 'P4').length === 68 && Schools.info('Notre Dame').level === 'P4', all.filter((s) => s.level === 'P4').length);
  ok('names as agents type them', Schools.canonical('TEXAS') === 'Texas' && Schools.canonical('Texas Tech Red Raiders') === 'Texas Tech' && Schools.canonical('University of Southern California') === 'USC' && Schools.canonical('Miami (OH)') === 'Miami (OH)' && Schools.canonical('Ole Miss') === 'Ole Miss');
  ok('a school that is not FBS is null, never a guess', Schools.canonical('Samford') === null && Schools.canonical('') === null);

  OUT.push('-- reading a roster --');
  const urls = Sweep.candidateUrls('rolltide.com', 'https://rolltide.com/sports/football/coaches', NOW);
  ok('the staff page host first, this season too', urls[0] === 'https://rolltide.com/sports/football/roster' && urls.includes('https://rolltide.com/sports/football/roster/2026') && urls.includes('https://www.rolltide.com/sports/football/roster'), urls);
  let r = await Sweep.readRoster({ school: 'Alabama', domain: 'rolltide.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: sidearm(110) }), ai: null });
  ok('a Sidearm page: 110 players, positions and years, via the parser', r.status === 'ok' && r.count === 110 && r.withPos >= 100 && r.via === 'parser', { s: r.status, c: r.count, p: r.withPos });
  ok('each player carries his room and whether he is likely leaving', r.players[2].group === 'WR' && r.players[2].leaving === true && r.players[0].leaving === false);
  let modelCalls = 0;
  const fakeAi = { MODEL_FAST: 'fast', oneShot: async (prompt) => { modelCalls++; return JSON.stringify({ players: Array.from({ length: 80 }, (_, k) => ({ name: `Player Number${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))}`, position: POSS[k % 12], year: YEARS[k % 6] })) }); } };
  r = await Sweep.readRoster({ school: 'Notre Dame', domain: 'und.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: '<main>' + 'Roster text '.repeat(200) + '</main>' }), ai: fakeAi });
  ok('a page the parser cannot read goes to the model, which copies it', r.status === 'ok' && r.via === 'model' && r.count === 80 && modelCalls === 1, { s: r.status, via: r.via, c: r.count, modelCalls });
  process.env.PORTAL_ROSTER_MODEL = 'off';
  r = await Sweep.readRoster({ school: 'Notre Dame', domain: 'und.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: '<main>nothing</main>' }), ai: fakeAi });
  ok('model off: a thin page stays thin, no call', r.status === 'thin' && modelCalls === 1);
  delete process.env.PORTAL_ROSTER_MODEL;
  r = await Sweep.readRoster({ school: 'Hawaii', domain: 'hawaiiathletics.com', now: NOW }, { fetchPage: async (u) => ({ ok: false, status: 403, url: u }), ai: null });
  ok('a site that refuses: failed, every URL tried recorded', r.status === 'failed' && r.tried.length === 4 && r.tried.every((t) => t.status === 403), r.tried);

  OUT.push('-- saving --');
  await Sweep.ensureTables(store.pool);
  const good = await Sweep.readRoster({ school: 'Georgia', domain: 'georgiadogs.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: sidearm(105) }), ai: null });
  await Sweep.save(store.pool, good, NOW);
  await Sweep.save(store.pool, { school: 'Georgia', status: 'failed', error: 'timeout', tried: [{ url: 'x', status: 0 }], players: [] }, NOW);
  let row = (await store.pool.query(`SELECT status, player_count, error FROM program_roster WHERE school='Georgia'`)).rows[0];
  ok('a failed read never wipes a good roster; the error is kept', row.status === 'ok' && row.player_count === 105 && row.error === 'timeout', row);

  OUT.push('-- the nightly sweep --');
  await store.pool.query(`DELETE FROM program_roster`);
  let fetched = [];
  const fake = { fetchPage: async (u) => { fetched.push(u); return { ok: true, status: 200, url: u, html: sidearm(100) }; }, ai: null, pauseMs: 0 };
  let sum = await Sweep.sweep(store.pool, { now: NOW, limit: 5 }, fake);
  ok('a slice, alphabetical when nothing is on file yet', sum.schools === 5 && sum.ok === 5 && sum.results[0].school === 'Air Force', sum.results.map((x) => x.school));
  sum = await Sweep.sweep(store.pool, { now: NOW, limit: 3 }, fake);
  ok('the next slice skips what was just read', !sum.results.some((x) => ['Air Force', 'Akron', 'Alabama'].includes(x.school)), sum.results.map((x) => x.school));
  const later = new Date(NOW.getTime() + 7 * 86400000);
  const d = await Sweep.due(store.pool, { now: later, limit: 500 });
  ok('six days later everything is due again, oldest first', d.length === Schools.all().length && d[d.length - 1].name !== 'Air Force');
  const portalNight = new Date('2026-12-10T03:30:00Z');
  ok('in December a roster is stale after 2 days', Sweep.staleDays(portalNight) === 2 && Sweep.staleDays(NOW) === 6);
  fetched = [];
  let t = await Sweep.tick(store.pool, { now: new Date('2026-11-02T20:00:00Z') }, fake);
  ok('outside 9 to 11pm Central: nothing runs', t.skipped === 'outside window' && fetched.length === 0);
  t = await Sweep.tick(store.pool, { now: NOW }, { ...fake, fetchPage: async (u) => { fetched.push(u); return { ok: false, status: 404, url: u }; } });
  ok('in the window: one slice runs', !t.skipped && t.schools === Sweep.SLICE, t.skipped || t.schools);
  t = await Sweep.tick(store.pool, { now: new Date(NOW.getTime() + 30 * 60000) }, fake);
  ok('once a night', t.skipped === 'already ran tonight');
  process.env.PORTAL_ROSTER_SWEEP = 'off';
  ok('off switch', (await Sweep.tick(store.pool, { now: new Date('2026-11-04T03:30:00Z') }, fake)).skipped === 'off');
  delete process.env.PORTAL_ROSTER_SWEEP;
  const cov = await Sweep.coverage(store.pool);
  ok('coverage counts read, failed and not yet, and lists what needs attention', cov.total === Schools.all().length && cov.read === 8 && cov.failed === Sweep.SLICE && cov.attention.length === Sweep.SLICE, { read: cov.read, failed: cov.failed });

  OUT.push('-- the need board --');
  // 30 rosters with 8 WRs back each make the median 8; three schools stand out.
  const rosters = [];
  const names = Schools.all().map((s) => s.name);
  for (let k = 0; k < 30; k++) {
    const sch = names[k + 20];
    let wr = { wrOn: 12, wrLeaving: 4 };          // 8 back
    if (sch === names[21]) wr = { wrOn: 9, wrLeaving: 5 };   // 4 back: thin
    if (sch === names[22]) wr = { wrOn: 9, wrLeaving: 2 };   // 7 back: some need
    if (sch === names[23]) wr = { wrOn: 14, wrLeaving: 2 };  // 12 back: deep
    const rr = await Sweep.readRoster({ school: sch, domain: 'x.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: sidearm(90, wr) }), ai: null });
    rosters.push({ school: sch, status: 'ok', players: rr.players, fetched_at: NOW });
  }
  let b = Board.rank({ group: 'WR', rosters, prefs: {}, coaching: new Map(), limit: 200 });
  const find = (s) => [...b.dream, ...b.options].find((x) => x.school === s);
  ok('the median comes from the rosters read', b.median === 8 && b.rostersRead === 30 && /30 FBS rosters/.test(b.medianFrom), { m: b.median, from: b.medianFrom });
  ok('4 back against 8: thin', find(names[21]).need.rating === 'high' && find(names[21]).need.back === 4 && find(names[21]).need.leaving === 5);
  ok('7 back: some need; 12 back: deep', find(names[22]).need.rating === 'medium' && find(names[23]).need.rating === 'low');
  ok('the need line says it in numbers', /9 wide receivers on the roster, 5 seniors or older likely leaving, 4 coming back \(FBS median 8\)/.test(find(names[21]).need.line), find(names[21]).need.line);
  ok('a school not read is unknown, not guessed', find(names[0]).need.rating === 'unknown' && /not read yet/.test(find(names[0]).need.line));
  const coach = new Map([[names[23], { school: names[23], coach: 'Coach Gone', how: 'fired', date: '2026-10-21', source: 'https://example.com/a' }]]);
  b = Board.rank({ group: 'WR', rosters, prefs: {}, coaching: coach, limit: 200 });
  ok('a new head coach lifts a deep room to some need and says why', find(names[23]).need.rating === 'medium' && find(names[23]).reasons.some((x) => /Coach Gone was fired Oct 21/.test(x)) && find(names[23]).coachingChange.source === 'https://example.com/a');
  b = Board.rank({ group: 'WR', rosters, prefs: { schools: [names[23], 'Texas'], currentSchool: names[21] }, coaching: new Map(), limit: 10 });
  ok('his schools come first, even a deep room, and the school he is leaving is out', b.dream.length === 2 && b.dream.every((x) => x.named) && ![...b.dream, ...b.options].some((x) => x.school === names[21]) && b.options.length === 10);
  b = Board.rank({ group: 'WR', rosters, prefs: { level: 'G5', schools: ['Texas'] }, coaching: new Map(), limit: 500 });
  ok('Group of 5 only: no Power 4 except one he named', b.options.every((x) => x.level === 'G5') && b.dream.some((x) => x.school === 'Texas'));
  b = Board.rank({ group: 'WR', rosters, prefs: { closeToHome: true, homeState: 'TX' }, coaching: new Map(), limit: 500 });
  const tx = [...b.options].find((x) => x.state === 'TX' && x.need.rating === 'unknown');
  ok('close to home gives a reason', tx && tx.reasons.includes('In his home state'));
  ok('level fit: one step up is a fit, three is a reach, a step down is fine', Board.levelFit('P4', { current: 'G5' }) === 1 && Board.levelFit('P4', { current: 'D2' }) === 0.35 && Board.levelFit('G5', { current: 'P4' }) === 0.7);
  b = Board.rank({ group: 'WR', rosters: rosters.slice(0, 5), prefs: {}, coaching: new Map() });
  ok('too few rosters: typical depth stands in, and it says so', b.median === Board.FALLBACK_MEDIAN.WR && /too few rosters/.test(b.medianFrom));
  let bad = null; try { Board.rank({ group: 'XX', rosters }); } catch (e) { bad = e; }
  ok('an unknown position is refused', bad && bad.status === 400);

  OUT.push('-- the contact book --');
  const staff = [
    { name: 'Gail Manager', title: 'General Manager', role: 'general_manager', is_key_contact: true, status: 'current', source_url: 'https://x.edu/staff', email: null, phone: '555-1000' },
    { name: 'Pat Personnel', title: 'Director of Player Personnel', role: 'player_personnel', is_key_contact: true, status: 'current', source_url: 'https://x.edu/staff' },
    { name: 'Wes Receiver', title: 'Wide Receivers Coach', role: 'staff', status: 'current', source_url: 'https://x.edu/staff', email: 'wes@x.edu' },
    { name: 'Gary Analyst', title: 'Wide Receivers Analyst', role: 'staff', status: 'current' },
    { name: 'Olivia Coord', title: 'Offensive Coordinator / Quarterbacks', role: 'staff', status: 'current' },
    { name: 'Dee Coord', title: 'Defensive Coordinator', role: 'staff', status: 'current' },
    { name: 'Rick Recruit', title: 'Director of Recruiting', role: 'recruiting', is_key_contact: true, status: 'current' },
    { name: 'Hal Coach', title: 'Head Coach', role: 'head_coach', is_key_contact: true, status: 'current' },
    { name: 'Old Coach', title: 'Head Coach', role: 'head_coach', status: 'previous' },
  ];
  let book = Contacts.build({ school: 'X', group: 'WR', rows: staff, contact: { office_phone: '555-0000', collective_name: 'X Collective' } });
  ok('in calling order: GM, personnel, position coach, coordinator, recruiting, head coach', book.contacts.map((c) => c.name).join('|') === 'Gail Manager|Pat Personnel|Wes Receiver|Olivia Coord|Rick Recruit|Hal Coach', book.contacts.map((c) => c.name));
  ok('his position coach, not the analyst; the offensive coordinator for a receiver', book.contacts[2].label === 'Position coach (WR)' && book.contacts[3].label === 'Offensive coordinator');
  ok('a predecessor is never served', !book.contacts.some((c) => c.name === 'Old Coach'));
  ok('only printed emails; the office line and collective come along', book.contacts.find((c) => c.name === 'Wes Receiver').email === 'wes@x.edu' && book.contacts.find((c) => c.name === 'Gail Manager').email === null && book.office.phone === '555-0000' && book.collective.name === 'X Collective' && book.withEmail === 1);
  book = Contacts.build({ school: 'X', group: 'LB', rows: staff });
  ok('a linebacker gets the defensive coordinator', book.contacts.some((c) => c.label === 'Defensive coordinator' && c.name === 'Dee Coord'));
  ok('no staff on file: says so', Contacts.build({ school: 'Y', group: 'WR', rows: [] }).note === 'No staff page read for this school yet.');

  OUT.push('-- should he enter --');
  let e = await PR.enterCheck(store.pool, { birthDate: '2006-03-10', firstEnrollment: '2024-08-20', priorTransfers: 0, group: 'WR' }, { now: NOW });
  ok('first transfer: two seasons left after this one (clock through 2028-29)', e.seasonsAfter === 2 && !e.costsYear && e.points.some((p) => /First transfer/.test(p.text)) && e.verdict.level !== 'flag', { s: e.seasonsAfter, v: e.verdict });
  ok('too few rosters read: no demand claim', e.demand.tooFew === true && !e.points.some((p) => /thin at WR/.test(p.text)));
  e = await PR.enterCheck(store.pool, { birthDate: '2006-03-10', firstEnrollment: '2024-08-20', priorTransfers: 1 }, { now: NOW });
  ok('a second transfer with no exception costs a year, and it says so', e.costsYear && e.seasonsAfter === 1 && e.verdict.level === 'warn' && e.points.some((p) => p.level === 'flag'), { s: e.seasonsAfter, v: e.verdict });
  e = await PR.enterCheck(store.pool, { birthDate: '2005-01-05', firstEnrollment: '2023-08-20', priorTransfers: 1 }, { now: NOW });
  ok('a second transfer that would cost his last season: flagged plainly', e.costsYear && e.seasonsAfter === 0 && e.verdict.level === 'flag' && /last season/.test(e.verdict.text), e.verdict);
  e = await PR.enterCheck(store.pool, { birthDate: '2006-03-10', firstEnrollment: '2024-08-20', priorTransfers: 1, currentSchool: 'Maryland' }, { now: NOW });
  ok('his head coach was fired: the exception applies by itself, with the 30-day window', e.exception === 'head_coach_departed' && !e.costsYear && e.seasonsAfter === 2 && e.points.some((p) => /Locksley/.test(p.text) && /30-day/.test(p.text)), e.points);
  e = await PR.enterCheck(store.pool, { priorTransfers: 0 }, { now: NOW });
  ok('no dates: asks for them, never assumes', e.seasonsAfter === null && e.points[0].level === 'unknown');
  ok('the window dates are there', e.windows.main.opens === '2027-01-02' && e.windows.main.closes === '2027-01-16');
  ok('seeded coaching changes are this season\'s, with sources', Coaching.SEEDED.length >= 4 && Coaching.SEEDED.every((c) => /^https?:\/\//.test(c.source)));
  await Coaching.add(store.pool, { school: 'Florida State', coach: 'Mike Norvell', how: 'fired', date: '2026-11-01', source: 'https://example.com/fsu' });
  const cm = await Coaching.load(store.pool, { now: NOW });
  ok('a coaching change added by the admin route shows', cm.get('Florida State') && cm.get('Florida State').via === 'added');
  let berr = null; try { await Coaching.add(store.pool, { school: 'Samford', date: '2026-11-01' }); } catch (x) { berr = x; }
  ok('a school that is not FBS is refused', berr && berr.status === 400);

  OUT.push('-- the board through the service --');
  PR.clearCache();
  const out = await PR.board(store.pool, { position: 'Wide Receiver', schools: ['Texas', 'Not A School'], currentSchool: 'Georgia' }, { now: NOW });
  ok('a printed position finds his room; an unknown school is returned, not guessed', out.group === 'WR' && out.unknownSchools[0] === 'Not A School' && out.dream[0].school === 'Texas');
  let berr2 = null; try { await PR.board(store.pool, { position: 'ATH' }); } catch (x) { berr2 = x; }
  ok('no position: a clear 400', berr2 && berr2.status === 400 && /position/.test(berr2.message));

  OUT.push('-- wish lists --');
  const w = await PR.saveWishlist(store.pool, 'agent-1', 'ath-1', { group: 'WR', schools: ['texas', 'Nowhere U'], states: ['ga', 'TEX'], level: 'p4', birthDate: '2005-01-05', priorTransfers: 9 });
  ok('saved cleaned: canonical schools, real state codes, level, capped transfers', w.prefs.schools.join() === 'Texas' && w.prefs.states.join() === 'GA' && w.prefs.level === 'P4' && w.prefs.priorTransfers === 5 && w.unknownSchools[0] === 'Nowhere U');
  ok('read back by the agent who saved it', (await PR.getWishlist(store.pool, 'agent-1', 'ath-1')).prefs.schools[0] === 'Texas');
  ok('another agent sees nothing', (await PR.getWishlist(store.pool, 'agent-2', 'ath-1')).prefs === null);

  OUT.push('-- review fixes --');
  ok('a different school that starts with an FBS name is refused', ['Tennessee State', 'Florida A&M', 'North Carolina A&T', 'Texas Southern', 'Washington University', 'Kansas City'].every((x) => Schools.canonical(x) === null));
  ok('nicknames still work', Schools.canonical('Penn State Nittany Lions') === 'Penn State' && Schools.canonical('LSU Tigers') === 'LSU' && Schools.canonical('Baylor University') === 'Baylor');
  const staff2 = [
    { name: 'Hal Coach', title: 'Head Coach', role: 'head_coach', is_key_contact: true, status: 'current' },
    { name: 'Ace Assoc', title: 'Associate Head Coach / Wide Receivers', role: 'head_coach', status: 'previous' },
    { name: 'Dan Dc', title: 'Assistant Head Coach / Defensive Coordinator', role: 'head_coach', status: 'previous' },
    { name: 'Old Boss', title: 'Head Coach', role: 'head_coach', status: 'previous' },
  ];
  let bk = Contacts.build({ school: 'X', group: 'WR', rows: staff2 });
  ok('an associate head coach who coaches receivers is his position coach', bk.contacts.some((c) => c.label === 'Position coach (WR)' && c.name === 'Ace Assoc'), bk.contacts.map((c) => c.name));
  bk = Contacts.build({ school: 'X', group: 'DB', rows: staff2 });
  ok('an assistant head coach who is the coordinator is the coordinator; the old head coach never shows', bk.contacts.some((c) => c.label === 'Defensive coordinator' && c.name === 'Dan Dc') && !bk.contacts.some((c) => c.name === 'Old Boss') && bk.contacts.find((c) => c.label === 'Head coach').name === 'Hal Coach');
  await store.pool.query(`INSERT INTO program_staff (school, sport, role, name, title, status, updated_at) VALUES ('Alabama','football','head_coach','Some Assistant','Assistant Head Coach','previous',NOW()) ON CONFLICT DO NOTHING`).catch(() => {});
  const cm2 = await Coaching.load(store.pool, { now: new Date() });
  ok('a staff refresh is not a coaching change', !cm2.has('Alabama'));
  e = await PR.enterCheck(store.pool, { priorTransfers: 1, currentSchool: 'Alabama', birthDate: '2006-03-10', firstEnrollment: '2024-08-20' }, { now: NOW });
  ok('so no exception is applied for him', e.exception === null && e.costsYear === true);
  // A good read, then a failed one a week later: the roster keeps its date.
  const g2 = await Sweep.readRoster({ school: 'Auburn', domain: 'auburntigers.com', now: NOW }, { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: sidearm(105) }), ai: null });
  await Sweep.save(store.pool, g2, NOW);
  const wk = new Date(NOW.getTime() + 7 * 86400000);
  await Sweep.save(store.pool, { school: 'Auburn', status: 'failed', error: 'http 403', tried: [], players: [] }, wk);
  row = (await store.pool.query(`SELECT fetched_at, last_attempt_at, last_error FROM program_roster WHERE school='Auburn'`)).rows[0];
  ok('a failed read leaves the roster dated when it was read, and records the failure', new Date(row.fetched_at).getTime() === NOW.getTime() && new Date(row.last_attempt_at).getTime() === wk.getTime() && row.last_error === 'http 403', row);
  const cov2 = await Sweep.coverage(store.pool);
  ok('and coverage lists it for attention', cov2.attention.some((x) => x.school === 'Auburn' && x.status === 'ok'));
  // The model: capped a sweep, and not the same school twice in a week.
  await store.pool.query(`DELETE FROM program_roster`);
  let calls = 0;
  const thinAi = { MODEL_FAST: 'f', oneShot: async () => { calls++; return '{"players":[]}'; } };
  const thin = { fetchPage: async (u) => ({ ok: true, status: 200, url: u, html: '<main>' + 'text '.repeat(400) + '</main>' }), ai: thinAi, pauseMs: 0 };
  await Sweep.sweep(store.pool, { now: NOW, limit: 15 }, thin);
  ok(`at most ${Sweep.MODEL_PER_NIGHT} model reads a sweep`, calls === Sweep.MODEL_PER_NIGHT, calls);
  calls = 0;
  await Sweep.sweep(store.pool, { now: new Date(NOW.getTime() + 86400000), schools: Schools.all().slice(0, 3).map((x) => x.name), force: true }, thin);
  ok('a school the model just tried is not tried again the next night', calls === 0, calls);
  let slow; const hold = new Promise((r) => { slow = r; });
  const p1 = Sweep.sweep(store.pool, { now: NOW, limit: 1, force: true }, { fetchPage: async (u) => { await hold; return { ok: false, status: 500, url: u }; }, ai: null, pauseMs: 0 });
  let busy = null; try { await Sweep.sweep(store.pool, { now: NOW, limit: 1 }, thin); } catch (x) { busy = x; }
  ok('one sweep at a time: a second one is refused with 409', busy && busy.status === 409 && Sweep.isRunning());
  slow(); await p1;
  ok('and it is free again after', !Sweep.isRunning());

  OUT.push('-- the offer board --');
  const O = require(REPO + 'server/services/portalRoom/offers');
  const A1 = 'agent-off', ATH = 'ath-off';
  const midwest = await O.create(store.pool, A1, ATH, { school: 'Iowa State', guaranteedPerYear: '$185,000', years: 2, inWriting: true });
  const river = await O.create(store.pool, A1, ATH, { school: 'Houston', guaranteedPerYear: 160000, nilPerYear: 90000, nilPayer: 'collective', nilDeliverables: '4 posts, 2 appearances', years: 1, inWriting: true, expiresOn: '2026-11-04' });
  const summit = await O.create(store.pool, A1, ATH, { school: 'utah', guaranteedPerYear: 120000, nilPerYear: 400000, nilPayer: 'collective', years: 1 });
  ok('offers saved, school names cleaned, dollars read off "$185,000"', midwest.guaranteedPerYear === 185000 && summit.school === 'Utah' && midwest.years === 2);
  let bad2 = null; try { await O.create(store.pool, A1, ATH, { school: 'Iowa', guaranteedPerYear: 'lots' }); } catch (x) { bad2 = x; }
  ok('a bad dollar amount is refused', bad2 && bad2.status === 400);
  let board = O.compare(await O.list(store.pool, A1, ATH), { seasonsLeft: 1, now: NOW, windows: PR.WINDOWS.football });
  ok('guaranteed money first: the two-year school deal leads', board.offers[0].school === 'Iowa State' && board.offers[0].guaranteedTotal === 370000, board.offers.map((o) => o.school));
  ok('the biggest number on paper is called out for being mostly NIL', /Iowa State guarantees the most \(\$370,000\)\. Utah is bigger on paper \(\$520,000\), but 77% of it is NIL/.test(board.headline), board.headline);
  const ut = board.offers.find((o) => o.school === 'Utah'), hou = board.offers.find((o) => o.school === 'Houston'), isu = board.offers[0];
  ok('collective NIL with no work named: flagged under the PCSA business purpose rule', ut.checks.some((c) => c.rule === 'nilPurpose' && c.level === 'flag'));
  ok('not in writing: flagged', ut.checks.some((c) => c.rule === 'writing' && c.level === 'flag') && !hou.checks.some((c) => c.rule === 'writing'));
  ok('two years offered with one season left: past his eligibility', isu.checks.some((c) => c.rule === 'term' && c.level === 'flag'));
  ok('expiring in 2 days: watch', hou.checks.some((c) => c.rule === 'expires' && /2 days/.test(c.text)));
  ok('the 5% fee cap in dollars on the NIL part', hou.checks.some((c) => c.rule === 'agentFee' && /\$4,500/.test(c.text)));
  ok('deadlines: the offer, then the window', board.deadlines[0].text === 'Houston offer expires' && board.deadlines.some((d) => d.text === 'Portal window opens' && d.date === '2027-01-02'));
  const upd = await O.update(store.pool, A1, ATH, summit.id, { status: 'in_writing' });
  ok('marking it in writing sets the flag', upd.inWriting === true && upd.status === 'in_writing');
  let nf = null; try { await O.update(store.pool, 'agent-other', ATH, summit.id, { status: 'declined' }); } catch (x) { nf = x; }
  ok('another agent cannot touch it', nf && nf.status === 404);
  nf = null; try { await O.remove(store.pool, 'agent-other', ATH, summit.id); } catch (x) { nf = x; }
  ok('or remove it', nf && nf.status === 404 && (await O.list(store.pool, A1, ATH)).length === 3);
  ok('and never sees it', (await O.list(store.pool, 'agent-other', ATH)).length === 0);
  await O.update(store.pool, A1, ATH, summit.id, { status: 'declined' });
  board = O.compare(await O.list(store.pool, A1, ATH), { now: NOW });
  ok('a declined offer leaves the comparison but stays listed', board.offers.length === 2 && board.declined.length === 1);
  const fam = O.familyUpdate({ athleteName: 'Jordan Hayes', agentName: 'Dana Price', board, now: NOW });
  ok('the family update: guaranteed first, plain words, signed', /^Subject: Jordan's portal update/.test(fam) && /Iowa State: \$185,000 a year guaranteed by the school, 2 years\./.test(fam) && /Dana Price$/.test(fam), fam);
  ok('nothing in it says NILDash sent it', !/NILDash/.test(fam));
  await O.remove(store.pool, A1, ATH, summit.id);
  ok('removed', (await O.list(store.pool, A1, ATH)).length === 2);
  const IX2 = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('every offer route checks the athlete is his', (IX2.match(/app\.(get|post|put|delete)\('\/api\/portal\/offers\/:athleteId[^']*', requireAuth, requireAgentSubscription, async \(req, res\) => \{\s*try \{\s*const a = await _portalOwnAthlete/g) || []).length === 4);

  OUT.push('-- what his position pays --');
  const V = require(REPO + 'server/services/portalRoom/value');
  ok('CSC numbers by position, with the source', V.forGroup('WR').p4.median === 141000 && V.forGroup('QB').p4.top10 === 2607000 && V.forGroup('DB').other.median === 17000 && /footballscoop/.test(V.SOURCE.url));
  ok('the market line reads plainly', V.line('WR') === 'Power 4 median $141,000 a year, top 10% $702,000; elsewhere in Division I median $17,000, top 10% $105,000.', V.line('WR'));
  ok('kickers: median only, said so', V.forGroup('K').p4.top10 === null && /about \$57,000/.test(V.line('K')));
  ok('an offer placed in its market', V.place(250000, 'WR', 'P4').level === 'ok' && V.place(90000, 'WR', 'P4').level === 'warn' && V.place(800000, 'WR', 'P4').level === 'warn' && /top 10%/.test(V.place(800000, 'WR', 'P4').text) && /non-Power 4/.test(V.place(20000, 'WR', 'G5').text));
  const bw = O.compare([{ id: 'x', school: 'Houston', status: 'offered', guaranteedPerYear: 160000, nilPerYear: 90000, years: 1, inWriting: true }], { group: 'WR', now: NOW });
  ok('the offer board shows where each offer sits', bw.offers[0].checks.some((c) => c.rule === 'market' && /above the Power 4 median for a WR/.test(c.text)));
  e = await PR.enterCheck(store.pool, { group: 'WR' }, { now: NOW });
  ok('the enter check says what his position pays', e.points.some((p) => /What a WR is paid: Power 4 median \$141,000/.test(p.text)) && e.value.p4.median === 141000);
  const bb = await PR.board(store.pool, { group: 'QB' }, { now: NOW });
  ok('so does the board', /Power 4 median \$296,000/.test(bb.valueLine));

  await PR.saveWishlist(store.pool, A1, ATH, { group: 'WR', birthDate: '2006-03-10', firstEnrollment: '2024-08-20' });
  const ob = await PR.offerBoard(store.pool, { id: A1, name: 'Dana Price' }, { id: ATH, name: 'Jordan Hayes', position: 'Wide Receiver' }, { now: NOW });
  ok('the whole offer board: his seasons left from the saved details, the market, the family text', ob.seasonsLeft === 2 && ob.group === 'WR' && ob.offers.length === 2 && /Dana Price$/.test(ob.family) && ob.offers.some((o) => o.checks.some((c) => c.rule === 'market')), { s: ob.seasonsLeft, g: ob.group });

  OUT.push('-- targets and the one-pager --');
  const T = require(REPO + 'server/services/portalRoom/targets');
  const AG = 'agent-t', AT = 'ath-t';
  await store.pool.query(`INSERT INTO users (id, name, email, password, role) VALUES ('agent-t','Dana Price','dana@example.com','x','agent') ON CONFLICT DO NOTHING`);
  await store.pool.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ath-t','agent-t',$1) ON CONFLICT DO NOTHING`, [JSON.stringify({ name: 'Jordan Hayes', position: 'WR', school: 'Troy', hometown: 'Dallas, TX', phone: '555-999-0000', email: 'jordan@private.com' })]);
  const t1 = await T.addTarget(store.pool, AG, AT, { school: 'baylor' });
  const t1b = await T.addTarget(store.pool, AG, AT, { school: 'Baylor' });
  ok('a school goes on his list once, by its real name', t1.school === 'Baylor' && t1b.id === t1.id && t1.stage === 'target');
  let te = null; try { await T.addTarget(store.pool, AG, AT, { school: 'Samford' }); } catch (x) { te = x; }
  ok('a school that is not FBS is refused', te && te.status === 400);
  await T.addTarget(store.pool, AG, AT, { school: 'Houston' });
  const moved = await T.updateTarget(store.pool, AG, AT, t1.id, { stage: 'interested', nextStep: 'Call the GM Thursday' });
  ok('stage and next step saved, and the touch recorded', moved.stage === 'interested' && moved.nextStep === 'Call the GM Thursday' && moved.lastTouchAt);
  const tl = await T.listTargets(store.pool, AG, AT);
  ok('furthest along first', tl[0].school === 'Baylor' && tl[1].school === 'Houston');
  te = null; try { await T.updateTarget(store.pool, 'someone-else', AT, t1.id, { stage: 'passed' }); } catch (x) { te = x; }
  ok('another agent cannot move it', te && te.status === 404);
  const prof = await T.saveProfile(store.pool, AG, AT, { heightWeight: '6-1, 195', statsLine: '58 catches, 912 yards, 7 TD', highlights: 'All-conference 2026\nTwo 100-yard games vs P4', filmUrl: 'https://hudl.com/x', statsUrl: 'javascript:alert(1)', agentPhone: '(555) 123-4567', agentEmail: 'not an email' });
  ok('one-pager saved: highlights split, bad links and a bad email dropped', prof.data.highlights.length === 2 && prof.data.filmUrl === 'https://hudl.com/x' && prof.data.statsUrl === null && prof.data.agentEmail === null && /^[a-f0-9]{24}$/.test(prof.token));
  const prof2 = await T.saveProfile(store.pool, AG, AT, { heightWeight: '6-1, 196', filmUrl: 'https://hudl.com/x', agentPhone: '(555) 123-4567' });
  ok('editing keeps the same link', prof2.token === prof.token);
  let pub = await T.publicProfile(store.pool, store, prof.token, { countView: true });
  ok('the public page shows the player and his agent', pub.name === 'Jordan Hayes' && pub.school === 'Troy' && pub.heightWeight === '6-1, 196' && pub.agent.name === 'Dana Price' && pub.agent.phone === '(555) 123-4567');
  ok('and never the player\'s own phone or email', !JSON.stringify(pub).includes('555-999-0000') && !JSON.stringify(pub).includes('jordan@private.com'));
  ok('views are counted', (await T.getProfile(store.pool, AG, AT)).views === 1);
  ok('a made-up token gets nothing', (await T.publicProfile(store.pool, store, 'f'.repeat(24))) === null && (await T.publicProfile(store.pool, store, '../x')) === null);
  const rot = await T.rotateToken(store.pool, AG, AT);
  ok('a new link kills the old one', rot.token !== prof.token && (await T.publicProfile(store.pool, store, prof.token)) === null && !!(await T.publicProfile(store.pool, store, rot.token)));
  await T.saveProfile(store.pool, AG, AT, { live: false, heightWeight: '6-1, 196' });
  ok('turned off: the page is gone', (await T.publicProfile(store.pool, store, rot.token)) === null);
  await T.saveProfile(store.pool, AG, AT, { live: true, heightWeight: '6-1, 196', filmUrl: 'https://hudl.com/x', statsLine: '58 catches, 912 yards, 7 TD' });

  OUT.push('-- the email to a school --');
  const bookX = Contacts.build({ school: 'Baylor', group: 'WR', rows: [
    { name: 'Gail Manager', title: 'General Manager', role: 'general_manager', is_key_contact: true, status: 'current', email: 'gail@baylor.edu' },
    { name: 'Wes Receiver', title: 'Wide Receivers Coach', role: 'staff', status: 'current', email: 'wes@baylor.edu' },
    { name: 'Rick Recruit', title: 'Director of Recruiting', role: 'recruiting', is_key_contact: true, status: 'current', email: 'rick@baylor.edu' },
    { name: 'Hal Coach', title: 'Head Coach', role: 'head_coach', is_key_contact: true, status: 'current' },
  ], contact: { office_phone: '254-710-1000' } });
  pub = await T.publicProfile(store.pool, store, rot.token);
  const em = T.emailFor({ school: 'Baylor', book: bookX, profile: pub, profileUrl: 'https://mynildash.com/portal-profile/' + rot.token, agentName: 'Dana Price', group: 'WR' });
  ok('to the GM and his position coach, recruiting copied', em.to.map((x) => x.email).join() === 'gail@baylor.edu,wes@baylor.edu' && em.cc[0].email === 'rick@baylor.edu');
  ok('short and specific: who, the numbers, film, the one-pager, the agent', /^Coach Manager,/.test(em.body) && /a WR at Troy \(6-1, 196\)/.test(em.body) && /58 catches/.test(em.body) && /Film: https:\/\/hudl\.com\/x/.test(em.body) && /One-pager: https:\/\/mynildash\.com\/portal-profile\//.test(em.body) && /Dana Price/.test(em.body), em.body);
  ok('the subject says it in one line', em.subject === 'Jordan Hayes, WR, Troy: in the portal');
  ok('a mailto with everything filled in', em.mailto.startsWith('mailto:gail%40baylor.edu,wes%40baylor.edu?subject=') && em.mailto.includes('&cc=rick%40baylor.edu'));
  const em2 = T.emailFor({ school: 'X', book: Contacts.build({ school: 'X', group: 'WR', rows: [{ name: 'No Email', title: 'General Manager', role: 'general_manager', status: 'current', phone: '555-1' }] }), profile: pub, profileUrl: null, agentName: 'Dana', group: 'WR' });
  ok('no published emails: no mailto, call these people instead', em2.mailto === null && em2.callInstead[0].name === 'No Email' && !/One-pager/.test(em2.body));
  const draft = await PR.emailDraft(store.pool, store, { id: AG, name: 'Dana Price' }, { id: AT, name: 'Jordan Hayes', position: 'WR', school: 'Troy' }, t1.id);
  ok('through the service: the target, the one-pager link', draft.target.school === 'Baylor' && draft.hasProfile && draft.body.includes('/portal-profile/'));

  OUT.push('-- the commit package --');
  const cO = await O.create(store.pool, AG, AT, { school: 'Baylor', guaranteedPerYear: 150000, nilPerYear: 60000, nilPayer: 'collective', years: 2, inWriting: false });
  await O.create(store.pool, AG, AT, { school: 'Houston', guaranteedPerYear: 120000, years: 1, inWriting: true });
  const comm = await O.update(store.pool, AG, AT, cO.id, { status: 'committed' });
  ok('committing starts the report clock', /^\d{4}-\d{2}-\d{2}$/.test(comm.signedOn));
  await PR.saveWishlist(store.pool, AG, AT, { group: 'WR', birthDate: '2005-01-05', firstEnrollment: '2023-08-20' });
  const cb = await PR.offerBoard(store.pool, { id: AG, name: 'Dana Price' }, { id: AT, name: 'Jordan Hayes', position: 'WR' });
  ok('the headline says he committed', /He committed to Baylor: \$300,000 guaranteed, \$420,000 in all/.test(cb.headline), cb.headline);
  const items = cb.commit.items.map((x) => x.text).join(' | ');
  ok('the checklist: writing, the 5-day report, the work named, the fee, the term', /Get the final deal in writing/.test(items) && /Protect College Sports Act report: Report due by/.test(items) && /name the work/.test(items) && /at most \$3,000 a year/.test(items) && /runs 2 years but he has 1 season left/.test(items), items);
  ok('tell the other schools, not the one he picked', /Let the other schools know he committed: Houston\./.test(items) && !/committed: [^.]*Baylor/.test(items));
  const pc = O.commitPackage({ school: 'X', inWriting: true, nilPerYear: 50000, nilPayer: 'business', nilDeliverables: '2 posts', years: 1, signedOn: '2026-10-20' }, { now: NOW, agentReady: false });
  ok('a report already late is flagged; no registration on file is flagged', pc.items.some((x) => x.level === 'flag' && /late/.test(x.text)) && pc.items.some((x) => /agent registration/.test(x.text) && x.level === 'flag'));

  OUT.push('-- review fixes, round 2 --');
  {
    // 1. The one-pager shows only what the agent put on it.
    const tok = (await T.getProfile(store.pool, AG, AT)).token;
    await T.saveProfile(store.pool, AG, AT, { heightWeight: '6-1, 196', live: true });
    let pp = await T.publicProfile(store.pool, store, tok);
    ok('the athlete record\'s hometown and his private dates stay off the one-pager', pp.hometown === null && pp.seasonsLeft === null, { h: pp.hometown, s: pp.seasonsLeft });
    await T.saveProfile(store.pool, AG, AT, { heightWeight: '6-1, 196', hometown: 'Dallas, TX', showSeasonsLeft: true, live: true });
    pp = await T.publicProfile(store.pool, store, tok);
    ok('until the agent puts them there', pp.hometown === 'Dallas, TX' && Number.isInteger(pp.seasonsLeft), { h: pp.hometown, s: pp.seasonsLeft });
    // 3. The signing date follows the real commit.
    const o3 = await O.create(store.pool, AG, 'ath-sign', { school: 'Texas', guaranteedPerYear: 100000, nilPerYear: 5000, years: 1, inWriting: true });
    await O.update(store.pool, AG, 'ath-sign', o3.id, { status: 'committed', signedOn: '2026-10-01' });
    let back = await O.update(store.pool, AG, 'ath-sign', o3.id, { status: 'offered' });
    ok('un-committing clears the signing date', back.signedOn === null);
    back = await O.update(store.pool, AG, 'ath-sign', o3.id, { status: 'committed' });
    const todayC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
    ok('committing again starts the clock today', back.signedOn === todayC, back.signedOn);
    back = await O.update(store.pool, AG, 'ath-sign', o3.id, { inWriting: true, status: 'committed' });
    ok('touching a committed offer does not reset its date', back.signedOn === todayC);
    back = await O.update(store.pool, AG, 'ath-sign', o3.id, { signedOn: '2026-10-30' });
    ok('the agent can set the real signing date', back.signedOn === '2026-10-30' && back.status === 'committed');
    // 8. Impossible dates are a 400, not a crash.
    let d8 = null; try { await O.update(store.pool, AG, 'ath-sign', o3.id, { signedOn: '2026-02-30' }); } catch (x) { d8 = x; }
    ok('February 30 is refused plainly', d8 && d8.status === 400);
    d8 = null; try { await O.create(store.pool, AG, 'ath-sign', { school: 'Iowa', expiresOn: '2026-13-01' }); } catch (x) { d8 = x; }
    ok('so is month 13', d8 && d8.status === 400);
    // 4. NIL Go on the deal's value; the PCSA report on a year of it.
    const small = O.commitPackage({ school: 'X', inWriting: true, nilPerYear: 500, nilPayer: 'business', nilDeliverables: '1 post', years: 3, signedOn: '2026-11-01' }, { now: NOW });
    const st = small.items.map((x) => x.text).join(' | ');
    ok('$500 a year for 3 years: NIL Go yes ($1,500), PCSA 12-month report no', /NIL Go: it is worth \$1,500/.test(st) && !/Protect College Sports Act report/.test(st), st);
    // 6. No money, no leader.
    const nb = O.compare([{ id: 'a', school: 'Alabama', status: 'talking', years: 1 }, { id: 'b', school: 'Auburn', status: 'talking', years: 1 }], { now: NOW });
    ok('no amounts entered: no "leads with $0" headline', nb.headline === null);
    // 5. Recruiting is the only address: it goes on the To line.
    const rb = Contacts.build({ school: 'R', group: 'WR', rows: [{ name: 'Rick Recruit', title: 'Director of Recruiting', role: 'recruiting', status: 'current', email: 'rick@x.edu' }, { name: 'Hal', title: 'Head Coach', role: 'head_coach', status: 'current', phone: '1' }] });
    const re = T.emailFor({ school: 'R', book: rb, profile: { name: 'J H', school: 'Troy', agent: {} }, profileUrl: null, agentName: 'D', group: 'WR' });
    ok('only recruiting published: it gets the email', re.to[0].email === 'rick@x.edu' && re.cc.length === 0 && re.mailto && re.mailto.startsWith('mailto:rick%40x.edu'));
    const re2 = T.emailFor({ school: 'R', book: { contacts: [], recruitingEmail: { email: 'recruit@x.edu' } }, profile: { name: 'J H', agent: {} }, profileUrl: null, agentName: 'D', group: 'WR' });
    ok('or the program\'s recruiting inbox', re2.to[0].email === 'recruit@x.edu' && !!re2.mailto);
    // 7. Days left by the calendar, in Chicago.
    const pc7 = require(REPO + 'server/services/pcsa.js');
    ok('signed Nov 1: on the evening of Nov 6 it is due today, not late', pc7.disclosure({ value: 2000, signedAt: '2026-11-01', now: new Date('2026-11-07T03:00:00Z') }).daysLeft === 0);
    ok('and on Nov 7 it is late', pc7.disclosure({ value: 2000, signedAt: '2026-11-01', now: new Date('2026-11-07T18:00:00Z') }).level === 'flag');
    // 9. Tell only the schools that know about him.
    await T.addTarget(store.pool, AG, AT, { school: 'Rice' });
    const cb9 = await PR.offerBoard(store.pool, { id: AG, name: 'Dana Price' }, { id: AT, name: 'Jordan Hayes', position: 'WR' });
    const tell = (cb9.commit.items.find((x) => /Let the other schools know/.test(x.text)) || {}).text || '';
    ok('a school never contacted is not on the tell list', !/Rice/.test(tell) && /Houston/.test(tell), tell);
  }

  const IX3 = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('target and one-pager routes check the athlete is his', /const _portalRoute = \(fn\) => async \(req, res\) => \{\s*try \{\s*const a = await _portalOwnAthlete\(req, req\.params\.athleteId\)/.test(IX3) && (IX3.match(/requireAuth, requireAgentSubscription, _portalRoute\(/g) || []).length === 7);
  ok('the public profile is by token, rate limited, and not indexed', IX3.includes("app.get('/api/portal-profile/:token', _portalProfileLimiter") && /portal-profile\.html'\)\);/.test(IX3) && IX3.includes("'X-Robots-Tag', 'noindex, nofollow').sendFile(path.join(__dirname, 'views', 'portal-profile.html'))"));
  const PP = fs.readFileSync(REPO + 'server/views/portal-profile.html', 'utf8');
  ok('the public page escapes everything and only links http(s)', /const esc = /.test(PP) && /const safeUrl = /.test(PP) && /noindex/.test(PP));

  OUT.push('-- wiring --');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('agent routes need a signed-in paying agent', ["app.post('/api/portal/board', requireAuth, requireAgentSubscription", "app.post('/api/portal/enter-check', requireAuth, requireAgentSubscription", "app.get('/api/portal/school/:school', requireAuth, requireAgentSubscription", "app.put('/api/portal/wishlist/:athleteId', requireAuth, requireAgentSubscription"].every((x) => IX.includes(x)));
  ok('a wish list is only for the agent\'s own athlete', /_portalOwnAthlete = async[\s\S]{0,200}a\.agentId !== req\.session\.userId/.test(IX) && (IX.match(/await _portalOwnAthlete\(req, req\.params\.athleteId\)/g) || []).length === 7);
  ok('sweep, coverage and coaching changes live under /api/admin (the admin gate); a second manual sweep gets 409', IX.includes('PR.Sweep.isRunning()) return res.status(409)') && IX.includes("app.post('/api/admin/portal/roster-sweep'") && IX.includes("app.get('/api/admin/portal/coverage'") && IX.includes("app.post('/api/admin/portal/coaching-change'"));
  ok('the nightly sweep is scheduled', /PRS\.tick\(store\.pool\)/.test(IX) && IX.includes("app.get('/portal-room'"));
  const PAGE = fs.readFileSync(REPO + 'server/views/portal-room.html', 'utf8');
  ok('the page escapes what it shows, only links http(s), and says it is not legal advice', /const esc = /.test(PAGE) && /const safeUrl = /.test(PAGE) && /Not legal advice/.test(PAGE) && !/href="\$\{(?!esc\()/.test(PAGE));
  ok('the dashboard links to it', fs.readFileSync(REPO + 'public/index.html', 'utf8').includes("location.href='/portal-room'"));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
