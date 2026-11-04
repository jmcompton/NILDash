'use strict';
// ── THE PORTAL ROOM APP (/portal-room, services/portalRoom/workspace) ───────
// Local test Postgres. Every claim the app's screen makes is checked here
// against what the code does:
//   - the pipeline stages, Committed included, and a committed offer moving
//     that school's card;
//   - a next step with a due date, and "steps due" counting only open schools
//     due today or before;
//   - the activity log: moves log themselves, emails/calls/replies move a
//     school along, and each person's "last reached" comes from it;
//   - the stats tiles, the window countdown, the roster coverage line;
//   - the client list and its counts;
//   - the coaching-change window as the NCAA wrote it (15 days);
//   - routes, the page, and the sample demo built from the same code.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('portalcrmtest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PORTAL_ROSTER_SWEEP;

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const T = require(REPO + 'server/services/portalRoom/targets');
const W = require(REPO + 'server/services/portalRoom/workspace');
const PR = require(REPO + 'server/services/portalRoom');
const Schools = require(REPO + 'server/services/portalRoom/schools');
const WINDOWS = require(REPO + 'server/services/portalRoom/windows');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const err = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  const P = store.pool;
  const AG = 'crm-agent', AT = 'crm-ath', OTHER = 'crm-other';
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Dana Price','crm@example.com','x','agent'),($2,'Other','crm2@example.com','x','agent') ON CONFLICT DO NOTHING`, [AG, OTHER]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [AT, AG, JSON.stringify({ name: 'Jordan Hayes', position: 'WR', school: 'Troy', sport: 'Football' })]);

  OUT.push('-- stages --');
  ok('the stages run target to committed, with passed last', T.STAGES.join(',') === 'target,contacted,replied,interested,visit,offer,committed,passed' && T.STAGE_LABEL.committed === 'Committed');

  OUT.push('-- the activity log --');
  const b = await T.addTarget(P, AG, AT, { school: 'Baylor' });
  await T.addTarget(P, AG, AT, { school: 'baylor' });
  let act = await T.listActivity(P, AG, AT, { targetId: b.id });
  ok('adding a school logs it once', act.length === 1 && act[0].kind === 'added', act);
  const e1 = await T.logActivity(P, AG, AT, { targetId: b.id, kind: 'email', contact: 'Player personnel', text: 'Sent the one-pager' });
  let row = (await P.query(`SELECT stage, last_touch_at FROM portal_targets WHERE id = $1`, [b.id])).rows[0];
  ok('an email to a school still at target moves it to contacted and records the touch', e1.stage === 'contacted' && row.stage === 'contacted' && row.last_touch_at);
  const e2 = await T.logActivity(P, AG, AT, { targetId: b.id, kind: 'reply', contact: 'Player personnel', text: 'Wants film' });
  ok('a reply moves it to replied', e2.stage === 'replied');
  await T.updateTarget(P, AG, AT, b.id, { stage: 'interested' });
  const e3 = await T.logActivity(P, AG, AT, { targetId: b.id, kind: 'reply', contact: 'General manager / football ops' });
  ok('a reply never moves a school backward', e3.stage === 'interested');
  act = await T.listActivity(P, AG, AT, { targetId: b.id });
  ok('moves log themselves, newest first', act[0].kind === 'reply' && act.filter((a) => a.kind === 'stage').map((a) => a.text).join('|') === 'Moved to Interested|Moved to Replied|Moved to Contacted', act.map((a) => a.kind + ':' + a.text));
  await T.updateTarget(P, AG, AT, b.id, { stage: 'interested', nextStep: 'Call the GM' });
  ok('saving the same stage logs nothing', (await T.listActivity(P, AG, AT, { targetId: b.id })).length === act.length);
  ok('a note needs words; an unknown kind is refused', (await err(() => T.logActivity(P, AG, AT, { targetId: b.id, kind: 'note' }))).status === 400 && (await err(() => T.logActivity(P, AG, AT, { targetId: b.id, kind: 'hack' }))).status === 400);
  const before = (await P.query(`SELECT last_touch_at FROM portal_targets WHERE id = $1`, [b.id])).rows[0].last_touch_at;
  await new Promise((r) => setTimeout(r, 20));
  await T.logActivity(P, AG, AT, { targetId: b.id, kind: 'note', text: 'Family likes Waco' });
  ok('a note is not a touch', String((await P.query(`SELECT last_touch_at FROM portal_targets WHERE id = $1`, [b.id])).rows[0].last_touch_at) === String(before));
  ok('another agent cannot log on his school, or read it', (await err(() => T.logActivity(P, OTHER, AT, { targetId: b.id, kind: 'call' }))).status === 404 && (await T.listActivity(P, OTHER, AT)).length === 0);

  OUT.push('-- next step and due date --');
  const d1 = await T.updateTarget(P, AG, AT, b.id, { nextStep: 'Call the GM', dueOn: '2026-11-03' });
  ok('a due date is saved', d1.dueOn === '2026-11-03' && d1.nextStep === 'Call the GM');
  ok('a date that does not exist is refused', (await err(() => T.updateTarget(P, AG, AT, b.id, { dueOn: '2026-02-30' }))).status === 400);
  ok('and it can be cleared', (await T.updateTarget(P, AG, AT, b.id, { dueOn: null })).dueOn === null);
  await T.updateTarget(P, AG, AT, b.id, { dueOn: '2026-11-02' });

  OUT.push('-- he committed --');
  const h = await T.addTarget(P, AG, AT, { school: 'Houston' });
  const c1 = await T.markCommitted(P, AG, AT, 'houston');
  ok('his committed school\'s card moves to Committed, and that is logged', c1.id === h.id && c1.stage === 'committed' && (await T.listActivity(P, AG, AT, { targetId: h.id }))[0].text === 'He committed. Moved to Committed');
  const c2 = await T.markCommitted(P, AG, AT, 'Rice');
  ok('a school not on his list goes on it as Committed', c2.school === 'Rice' && c2.stage === 'committed');
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('logging or moving an offer to committed moves the card (both offer routes)', (IX.match(/if \(o\.status === 'committed'\) await require\('\.\/services\/portalRoom\/targets'\)\.markCommitted\(store\.pool, req\.session\.userId, a\.id, o\.school\)/g) || []).length === 2);
  await P.query(`INSERT INTO portal_offers (id, agent_id, athlete_id, school, status) VALUES ('po-x',$1,$2,'Houston','committed')`, [AG, AT]).catch(async () => { await require(REPO + 'server/services/portalRoom/offers').ensureTable(P); await P.query(`INSERT INTO portal_offers (id, agent_id, athlete_id, school, status) VALUES ('po-x',$1,$2,'Houston','committed')`, [AG, AT]); });
  ok('undoing a commit leaves the card while another offer from that school is still committed', (await T.unmarkCommitted(P, AG, AT, 'Houston')) === null);
  await P.query(`UPDATE portal_offers SET status = 'offered' WHERE id = 'po-x'`);
  const un = await T.unmarkCommitted(P, AG, AT, 'Houston');
  ok('and once none is, the card goes back to Offer in, logged', un && un.stage === 'offer' && (await T.listActivity(P, AG, AT, { targetId: h.id }))[0].text === 'Commit undone. Moved back to Offer in');
  ok('the offer update route undoes the card when an offer leaves committed', /else await require\('\.\/services\/portalRoom\/targets'\)\.unmarkCommitted\(store\.pool, req\.session\.userId, a\.id, o\.school\)/.test(IX));
  await T.removeTarget(P, AG, AT, c2.id);
  ok('taking a school off his list takes its activity with it', (await T.listActivity(P, AG, AT, { targetId: c2.id })).length === 0);
  await T.updateTarget(P, AG, AT, h.id, { stage: 'offer' });

  OUT.push('-- the workspace --');
  const NOW = new Date('2026-11-03T18:00:00Z');   // noon Central, Nov 3
  const tg = [
    { id: 'a', school: 'Baylor', stage: 'offer', nextStep: 'Compare offers', dueOn: '2026-11-03' },
    { id: 'b', school: 'Houston', stage: 'contacted', nextStep: 'Follow up', dueOn: '2026-11-01' },
    { id: 'c', school: 'Rice', stage: 'target', nextStep: 'Send one-pager', dueOn: '2026-11-09' },
    { id: 'd', school: 'Tulane', stage: 'passed', nextStep: 'n/a', dueOn: '2026-10-01' },
    { id: 'e', school: 'SMU', stage: 'committed', nextStep: 'Paperwork', dueOn: '2026-10-30' },
    { id: 'f', school: 'Army', stage: 'visit', nextStep: null, dueOn: null },
  ];
  const rows = [{ school: 'Baylor', score: 88, need: { rating: 'high', on: 9, leaving: 3, back: 6, median: 8, line: 'x' }, coachingChange: { coach: 'Dave Aranda', how: 'fired', date: '2026-10-24' } },
    { school: 'Houston', score: 70, need: { rating: 'medium', on: 10, leaving: 3, back: 7, median: 8, line: 'y' }, coachingChange: null }];
  const actv = [
    { id: 1, targetId: 'a', kind: 'reply', contact: 'Player personnel', at: '2026-11-02T15:00:00Z' },
    { id: 2, targetId: 'a', kind: 'email', contact: 'Player personnel', at: '2026-10-30T15:00:00Z' },
    { id: 3, targetId: 'a', kind: 'call', contact: 'Position coach (WR)', at: '2026-10-29T15:00:00Z' },
    { id: 4, targetId: 'b', kind: 'reply', contact: 'Recruiting', at: '2026-10-20T15:00:00Z' },
    { id: 5, targetId: 'b', kind: 'note', contact: 'Recruiting', at: '2026-11-03T15:00:00Z' },
  ];
  const ob = { offers: [{ school: 'Baylor', guaranteedTotal: 360000 }, { school: 'Houston', guaranteedTotal: 0 }] };
  const ws = W.assemble({ targets: tg, boardRows: rows, rostersRead: 41, totalSchools: 136, activity: actv, offerBoard: ob, windows: WINDOWS.football, now: NOW });
  const card = (id) => ws.cards.find((c) => c.id === id);
  ok('each card carries the board\'s fit and need for that school', card('a').fit === 88 && card('a').need.leaving === 3 && card('a').level === 'P4');
  ok('a school the board has no row for shows no score rather than a made-up one', card('c').fit === null && card('c').need === null);
  ok('a coaching change reads the way the board says it', /New head coach coming: Dave Aranda was fired Oct 24/.test(card('a').coachingLine));
  ok('days to due, in Central time', card('a').dueIn === 0 && card('b').dueIn === -2 && card('c').dueIn === 6);
  ok('"steps due" counts open schools due today or before; passed and committed never count', ws.stats.due === 2);
  ok('contacted = past target, not passed', ws.stats.contacted === 4);
  ok('replies this week counts replies logged in the last 7 days only', ws.stats.repliesThisWeek === 1);
  ok('on his list excludes passed; visits and offers counted', ws.stats.onList === 5 && ws.stats.visits === 1 && ws.stats.offers === 2);
  ok('most guaranteed comes from the offer board', ws.stats.bestGuaranteed.school === 'Baylor' && ws.stats.bestGuaranteed.amount === 360000);
  ok('a committed school shows as committed', ws.stats.committed === 'SMU');
  ok('each person\'s last reach is the newest email, call, reply or visit with them; notes are not reaches', card('a').contactTouch['Player personnel'].kind === 'reply' && card('a').contactTouch['Position coach (WR)'].kind === 'call' && card('b').contactTouch.Recruiting.kind === 'reply');
  ok('the last thing that happened is on the card', card('a').lastActivity.id === 1);
  ok('steps are listed soonest due first, open schools only', ws.tasks.map((t) => t.school).join(',') === 'Houston,Baylor,Rice', ws.tasks);
  ok('the window counts down from today in Central time', ws.window.daysToOpen === 60 && ws.window.opens === '2027-01-02' && !ws.window.isOpen);
  ok('the roster coverage line is what was read', ws.coverage.read === 41 && ws.coverage.total === 136);
  ok('every stage is a column', ws.stages.map((s) => s.key).join(',') === T.STAGES.join(','));

  const agent = await store.getUser(AG);
  const ath = await store.getAthlete(AT);
  const live = await W.workspace(P, store, agent, ath, { now: NOW });
  ok('the live workspace loads from the database: his schools, scored on every FBS school', live.athlete.name === 'Jordan Hayes' && live.group === 'WR' && live.cards.length === 2 && live.cards.every((c) => c.fit != null) && live.coverage.total === Schools.all().length);
  ok('with no wish list saved, his own school (from his profile) is not scored as a place to go', !live.cards.some((c) => c.school === 'Troy') && (await T.addTarget(P, AG, AT, { school: 'Troy' })) && (await W.workspace(P, store, agent, ath, { now: NOW })).cards.find((c) => c.school === 'Troy').fit === null);
  await T.removeTarget(P, AG, AT, (await T.listTargets(P, AG, AT)).find((t) => t.school === 'Troy').id);
  ok('with no rosters read, need says unknown, never guessed', live.cards.every((c) => c.need.rating === 'unknown') && live.coverage.read === 0);
  ok('and it carries the offer board', Array.isArray(live.offers.offers) && typeof live.offers.family === 'string');
  ok('it says whether the Protect College Sports Act is law yet (pending by default)', live.pcsaStatus === 'pending');
  await PR.saveWishlist(P, AG, AT, { group: 'WR', level: 'G5', schools: ['Baylor'] });
  const live2 = await W.workspace(P, store, agent, ath, { now: NOW });
  const brd = await PR.board(P, { group: 'WR', level: 'G5', schools: ['Baylor'], limit: 60 }, { now: NOW });
  const inBoard = (s) => [...brd.dream, ...brd.options].find((r) => r.school === s);
  ok('a school shows one fit score: his list and the Schools tab use the same wish list', live2.cards.find((c) => c.school === 'Baylor').fit === inBoard('Baylor').score, [live2.cards.find((c) => c.school === 'Baylor').fit, inBoard('Baylor') && inBoard('Baylor').score]);
  ok('and a school outside the level he wants still gets scored on his list', live2.cards.find((c) => c.school === 'Houston').fit != null);

  OUT.push('-- the client list --');
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('crm-ath2',$1,$2),('crm-ath3',$1,$3) ON CONFLICT DO NOTHING`, [AG, JSON.stringify({ name: 'Alex Bell', position: 'CB', sport: 'Football' }), JSON.stringify({ name: 'Sam Hoop', sport: 'Basketball' })]);
  const cl = await W.clients(P, AG, await store.getAthletesByAgent(AG));
  ok('his football clients, the ones with schools first, with counts', cl.length === 2 && cl[0].name === 'Jordan Hayes' && cl[0].schools === 2 && cl[1].name === 'Alex Bell' && cl[1].schools === 0, cl);

  OUT.push('-- reading every FBS roster --');
  {
    const Sw = require(REPO + 'server/services/portalRoom/rosterSweep');
    const Pos = require(REPO + 'server/services/portalRoom/positions');
    const Board = require(REPO + 'server/services/portalRoom/board');
    // A WMT/Nuxt page: the players live in __NUXT_DATA__ (devalue: every object holds indexes).
    const arr = []; const push = (v) => { arr.push(v); return arr.length - 1; };
    const root = push(null), wrap = push(null), list = push(null); const items = [];
    for (let i = 0; i < 60; i++) {
      const pos = push({ abbreviation: push(i % 3 ? 'WR' : 'QB'), name: push('x') });
      const cls = push({ name: push(i % 2 ? 'Senior' : 'Sophomore') });
      const pl = push({ first_name: push('First' + i), last_name: push('Last' + i), hometown: push('Town, ST') });
      items.push(push({ player: pl, player_position: pos, class_level: cls, jersey_number: push(i) }));
    }
    arr[list] = items; arr[wrap] = ['ShallowReactive', list]; arr[root] = { data: wrap, other: push([push('noise')]) };
    const html = '<html><body>no table here<script type="application/json" id="__NUXT_DATA__" data-ssr="true">' + JSON.stringify(arr) + '</script></body></html>';
    const np = Sw.nuxtPlayers(html);
    ok('a Nuxt site\'s roster is read out of its data block (Clemson, Auburn, Iowa, Arizona State, Northwestern, Georgia Tech, New Mexico)', np.length === 60 && np[1].name === 'First1 Last1' && np[1].position === 'WR' && np[1].year === 'Senior' && np[1].hometown === 'Town, ST', np[1]);
    const r = await Sw.readRoster({ school: 'Clemson', domain: 'clemsontigers.com', now: NOW }, { fetchPage: async (url) => ({ ok: true, status: 200, url, html }), parseRoster: () => [], ai: null });
    ok('and the sweep uses it when the page has no roster table', r.status === 'ok' && r.via === 'nuxt' && r.withPos === 60, { status: r.status, via: r.via, withPos: r.withPos });
    const vue = '<table v-if="players.length"></table><script>var roster = {"title":"2026 Football","players":[' + Array.from({ length: 60 }, (_, i) => JSON.stringify({ first_name: 'Kian' + i + ' ', last_name: 'A"fro]k', position_short: i % 2 ? 'WR' : 'DB', academic_year_short: i < 10 ? 'Sr.' : 'So.', hometown: 'Logan, Utah' })).join(',') + '],"coaches":[]};</script>';
    const ep = Sw.embeddedPlayers(vue);
    ok('a Vue Sidearm page that draws its table from an embedded players list is read (Utah State), brackets and quotes inside names included', ep.length === 60 && ep[0].name === 'Kian0 A"fro]k' && ep[1].position === 'WR' && ep[0].year === 'Sr.', ep[0]);
    const rv = await Sw.readRoster({ school: 'Utah State', domain: 'utahstateaggies.com', now: NOW }, { fetchPage: async (url) => ({ ok: true, status: 200, url, html: vue }), parseRoster: () => [], ai: null });
    ok('and the sweep uses it', rv.status === 'ok' && rv.via === 'embedded' && rv.withPos === 60, { status: rv.status, via: rv.via });
    ok('garbage in the data block reads as nothing, not a crash', Sw.nuxtPlayers('<script id="__NUXT_DATA__">{not json</script>').length === 0 && Sw.nuxtPlayers('<p>plain</p>').length === 0);
    ok('the old-style sport path is tried when /sports/football is not there (Georgia Tech, Arkansas)', Sw.candidateUrls('ramblinwreck.com', null, NOW).includes('https://ramblinwreck.com/sports/m-footbl/roster') && Sw.candidateUrls('arkansasrazorbacks.com', null, NOW).includes('https://arkansasrazorbacks.com/sport/m-footbl/roster/') && Sw.candidateUrls('x.com', null, NOW)[0] === 'https://x.com/sports/football/roster');
    ok('a position printed short and long side by side still counts ("OLB OLB", Navy)', Pos.groupOf('OLB OLB') === 'LB' && Pos.groupOf('WR Wide Receiver') === 'WR' && Pos.groupOf('ATH') === null);
    ok('years in the program read as classes ("3rd year" junior, "4th" with the seniors)', Pos.classOf('3rd year').cls === 'JR' && Pos.classOf('4th').cls === 'SR' && Pos.isLeaving('4th year') && !Pos.isLeaving('2nd year') && Pos.classOf('5th year').cls === '5TH' && Pos.classOf('Sophomore').cls === 'SO');
    const ros = (n, yrs) => Array.from({ length: n }, (_, i) => ({ name: 'P' + i, pos: 'WR', group: 'WR', year: yrs ? (i < 4 ? 'Sr.' : 'So.') : '' }));
    const b2 = Board.rank({ group: 'WR', rosters: [{ school: 'Georgia Tech', status: 'ok', players: ros(10, false) }, { school: 'Baylor', status: 'ok', players: ros(10, true) }], limit: 200 });
    const gt = [...b2.dream, ...b2.options].find((x) => x.school === 'Georgia Tech');
    ok('a roster that prints no class years says need is unknown, never "deep", and stays out of the median', gt.need.rating === 'unknown' && gt.need.noYears && /no class years/.test(gt.need.line) && b2.rostersRead === 2 && b2.rostersWithYears === 1);
    const PGx = fs.readFileSync(REPO + 'server/views/portal-crm.html', 'utf8');
    ok('and the page says "No class years printed"', /No class years printed/.test(PGx));
  }

  OUT.push('-- the rules on screen --');
  ok('the coaching-change window is the NCAA\'s current one: 15 days, starting 5 days after the new coach is named', /15-day window/.test(WINDOWS.football.coachingChange) && /5 days after/.test(WINDOWS.football.coachingChange) && !/30-day/.test(fs.readFileSync(REPO + 'server/services/portalRoom/windows.js', 'utf8').replace(/\/\/.*$/gm, '')));
  ok('one source for the windows', PR.WINDOWS === WINDOWS);

  OUT.push('-- routes and the page --');
  ok('the app routes need a signed-in paying agent and his own athlete', ["app.get('/api/portal/workspace/:athleteId', requireAuth, requireAgentSubscription, _portalRoute(", "app.get('/api/portal/clients', requireAuth, requireAgentSubscription,", "app.get('/api/portal/activity/:athleteId', requireAuth, requireAgentSubscription, _portalRoute(", "app.post('/api/portal/activity/:athleteId', requireAuth, requireAgentSubscription, _portalRoute("].every((x) => IX.includes(x)));
  ok('/portal-room is the app, the demo is the app on sample data, the first page stays at /classic', /app\.get\('\/portal-room', \(req, res\) => \{\s+res\.set\('Cache-Control', 'no-store'\)\.sendFile\(path\.join\(__dirname, 'views', 'portal-crm\.html'\)\)/.test(IX) && /app\.get\('\/portal-room\/demo'[\s\S]{0,140}portal-crm\.html/.test(IX) && /app\.get\('\/portal-room\/classic'[\s\S]{0,140}portal-room\.html/.test(IX));
  const PG = fs.readFileSync(REPO + 'server/views/portal-crm.html', 'utf8');
  ok('the page escapes what it shows and only links http(s)', /const esc = /.test(PG) && /const safeUrl = /.test(PG) && !/href="\$\{(?!esc\()/.test(PG));
  const called = [...new Set((PG.match(/'\/api\/portal\/[a-z-]+/g) || []).map((x) => x.slice(1)))];
  ok('every endpoint the page calls exists', called.length >= 9 && called.every((p) => IX.includes(`'${p}`)), called.filter((p) => !IX.includes(`'${p}`)));
  ok('in the demo nothing is written, and it says it is a sample', /const DEMO = location\.pathname/.test(PG) && /if \(method !== 'GET' && !\['\/api\/portal\/enter-check', '\/api\/portal\/board'\]\.includes\(p\)\) throw new Error\(ro\)/.test(PG) && /This is a sample with made-up schools, people and numbers/.test(PG));
  ok('it says what it is not: not legal advice, and nothing is sent from here', /Not legal advice/.test(PG) && /Nothing is sent from here/.test(PG) && /You send it from your own email/.test(PG));
  ok('the page says the Protect College Sports Act is pending next to the checks built on it', /S\.ws\.pcsaStatus !== 'law'/.test(PG) && (PG.match(/class="note pcsaNote hidden"/g) || []).length === 2 && /waiting on the House/.test(PG));
  ok('no claim the page cannot back: no "Same staff", leaving is "seniors or older", a declined offer can be put back', !/Same staff/.test(PG) && /No change on file/.test(PG) && /Seniors or older/.test(PG) && !/ leaving`/.test(PG) && /data-orestore/.test(PG));
  ok('the coverage line is on the page, from the data', /Need from \$\{cov\.read\} of \$\{cov\.total\} FBS rosters read/.test(PG) && /Need comes from \$\{b\.rostersRead\} of \$\{b\.totalSchools\} FBS rosters read so far/.test(PG));

  OUT.push('-- the sample --');
  {
    const src = fs.readFileSync(REPO + 'public/portal-demo.js', 'utf8');
    const win = {}; new Function('window', src)(win);
    const D = win.PORTAL_DEMO;
    ok('the sample\'s schools are all made up', D.workspace.cards.every((c) => Schools.canonical(c.school) === null) && D.meta.schools.every((s) => Schools.canonical(s.name) === null));
    ok('its workspace came out of the real assemble (counts match its own cards)', D.workspace.stats.onList === D.workspace.cards.filter((c) => c.stage !== 'passed').length && D.workspace.stages.length === T.STAGES.length && D.workspace.window.opens === WINDOWS.football.main.opens);
    ok('every school in it opens: a contact book, an email and its activity', D.workspace.cards.every((c) => D.school[c.school] && D.emails[c.id] && Array.isArray(D.activity[c.id])));
    ok('its windows text is the real one', D.enter.windows.coachingChange === WINDOWS.football.coachingChange);
    ok('it has more than one client, and only the first is filled in', D.clients.length >= 2 && D.workspace.athlete.id === D.clients[0].id && /only ' \+ D\.workspace\.athlete\.name \+ ' is filled in/.test(PG));
  }

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
