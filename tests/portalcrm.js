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

  OUT.push('-- who opened his one-pager --');
  {
    const O = require(REPO + 'server/services/portalRoom/opens');
    const prof = await T.saveProfile(P, AG, AT, { heightWeight: '6-1, 190', measurables: '40: 4.48', lookingFor: 'A starting role', academics: '3.4 GPA', agentEmail: 'crm@example.com' });
    const rice = await T.addTarget(P, AG, AT, { school: 'Rice' });
    const lk = await O.linkFor(P, AG, AT, rice);
    ok('each school on his list gets its own link, made once', /^[a-f0-9]{16}$/.test(lk) && (await O.linkFor(P, AG, AT, rice)) === lk);
    const dr = await PR.emailDraft(P, store, agent, ath, rice.id);
    ok('the email to that school carries its own link', dr.body.includes(`/portal-profile/${prof.token}?s=${lk}`), dr.body);
    const pub = await T.publicProfile(P, store, prof.token);
    ok('the one-pager shows measurables, what he is looking for and academics, as the agent wrote them', pub.measurables === '40: 4.48' && pub.lookingFor === 'A starting role' && pub.academics === '3.4 GPA');
    const sent = [];
    const deps = { sendAlert: async (m) => { sent.push(m); } };
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
    const t0 = new Date('2026-11-04T15:00:00Z');
    ok('a mail scanner or bot is not an open', !(await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: 'Mozilla/5.0 (compatible; Proofpoint URL Defense)', ip: '1.1.1.1', now: t0 }, deps)).counted
      && !(await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: '', ip: '1.1.1.1', now: t0 }, deps)).counted);
    ok('the agent looking at his own page is not an open', (await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, viewerUserId: AG, ua: UA, ip: '1.1.1.1', now: t0 }, deps)).reason === 'own view');
    const o1 = await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: UA, ip: '2.2.2.2', now: t0 }, deps);
    ok('someone at Rice opening it counts, for Rice', o1.counted && o1.school === 'Rice' && o1.opens === 1);
    ok('Rice moves from Target to Interested, and the activity says why', o1.moved === 'interested' && (await T.listActivity(P, AG, AT, { targetId: rice.id })).slice(0, 2).map((x) => x.text).join('|') === 'Opened his one-pager. Moved to Interested|Someone at Rice opened his one-pager');
    ok('the agent gets one email: "Rice opened Jordan Hayes\'s one-pager", with a link to his board', sent.length === 1 && sent[0].to === 'crm@example.com' && sent[0].subject === "Rice opened Jordan Hayes's one-pager" && /portal-room\?a=crm-ath/.test(sent[0].text) && !/[—]/.test(sent[0].text));
    ok('the same person again within 30 minutes is not another open', !(await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: UA, ip: '2.2.2.2', now: new Date(t0.getTime() + 10 * 60000) }, deps)).counted);
    const o2 = await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: UA, ip: '3.3.3.3', now: new Date(t0.getTime() + 60 * 60000) }, deps);
    ok('a second person the same day counts, without a second email or a second activity line', o2.counted && o2.opens === 2 && sent.length === 1 && (await T.listActivity(P, AG, AT, { targetId: rice.id })).filter((x) => x.kind === 'opened').length === 1);
    const o3 = await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: UA, ip: '2.2.2.2', now: new Date('2026-11-05T15:00:00Z') }, deps);
    ok('the next day: counted, logged and emailed again, but never moved backward', o3.counted && o3.opens === 3 && sent.length === 2 && o3.moved === 'interested' && (await T.listActivity(P, AG, AT, { targetId: rice.id })).filter((x) => x.kind === 'opened').length === 2);
    const live3 = await W.workspace(P, store, agent, ath, { now: new Date('2026-11-05T16:00:00Z') });
    const rc = live3.cards.find((c) => c.school === 'Rice');
    ok('his board shows it: Rice opened 3 times, and the stats count schools that opened', rc.opens && rc.opens.opens === 3 && rc.stage === 'interested' && live3.stats.opened === 1);
    ok('without a school link it is a plain view: counted on the page, tied to no school', (await O.recordOpen(P, store, { profileToken: prof.token, linkToken: null, ua: UA, ip: '4.4.4.4', now: t0 }, deps)).counted && sent.length === 2);
    ok('a made-up link token is just a plain view', !(await O.recordOpen(P, store, { profileToken: prof.token, linkToken: 'ffffffffffffffff', ua: UA, ip: '5.5.5.5', now: t0 }, deps)).school);
    await T.saveProfile(P, AG, AT, { live: false });
    ok('a one-pager that is turned off counts nothing', !(await O.recordOpen(P, store, { profileToken: prof.token, linkToken: lk, ua: UA, ip: '6.6.6.6', now: t0 }, deps)).counted);
    await T.removeTarget(P, AG, AT, rice.id);
    ok('taking the school off his list removes its link', (await P.query(`SELECT 1 FROM portal_profile_links WHERE token = $1`, [lk])).rows.length === 0);
    const IXo = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    const PGo = fs.readFileSync(REPO + 'server/views/portal-profile.html', 'utf8');
    ok('loading the page counts nothing; the page reports a view after 1.5 seconds on screen, with the school link', /publicProfile\(store\.pool, store, req\.params\.token, \{ countView: false \}\)/.test(IXo) && /app\.post\('\/api\/portal-profile\/:token\/seen', _portalProfileLimiter/.test(IXo) && /setTimeout\(report, 1500\)/.test(PGo) && /document\.visibilityState !== 'visible'/.test(PGo) && /new URLSearchParams\(location\.search\)\.get\('s'\)/.test(PGo));
    ok('the school sees an "I\'m interested" button that emails the agent', /I'm interested/.test(PGo));
  }

  OUT.push('-- the free Portal Board --');
  {
    const FB = require(REPO + 'server/services/portalRoom/freeBoard');
    await require(REPO + 'server/services/portalRoom/rosterSweep').ensureTables(P);
    const room = (n, sr) => Array.from({ length: n }, (_, i) => ({ name: 'Player ' + i, pos: 'WR', group: 'WR', year: i < sr ? 'Sr.' : 'So.' }));
    for (const [sch, n, sr] of [['Baylor', 9, 5], ['Houston', 12, 2], ['Troy', 8, 5], ['Tulane', 10, 4]]) {
      await P.query(`INSERT INTO program_roster (school, sport, players, player_count, status, fetched_at) VALUES ($1,'football',$2,$3,'ok',NOW())
        ON CONFLICT (school, sport) DO UPDATE SET players = EXCLUDED.players, player_count = EXCLUDED.player_count, status = 'ok', fetched_at = NOW()`, [sch, JSON.stringify(room(n, sr)), n]);
    }
    PR.clearCache && PR.clearCache();
    ok('a position is required', (await err(() => FB.freeBoard(P, {}))).status === 400);
    const fb = await FB.freeBoard(P, { group: 'WR', currentSchool: 'Troy' });
    ok('the top 10 schools for his position, from the rosters read, his own school left off', fb.rows.length === 10 && !fb.rows.some((r) => r.school === 'Troy') && fb.rostersRead >= 4 && fb.group === 'WR', fb.rows.slice(0, 3));
    ok('a thin room ranks high: Baylor (5 of 9 seniors or older) is in the top 3', fb.rows.slice(0, 3).some((r) => r.school === 'Baylor' && r.need.rating === 'high' && r.need.leaving === 5), fb.rows.slice(0, 3).map((r) => r.school));
    ok('schools whose rosters were read come first; unread ones only fill in', fb.rows.slice(0, 3).every((r) => r.need.rating !== 'unknown') && fb.rows[3].need.rating === 'unknown', fb.rows.slice(0, 5).map((r) => r.school + ':' + r.need.rating));
    ok('it gives no people, emails or phone numbers: those come with the trial', !JSON.stringify(fb).match(/"(contacts|email|phone|name)"/));
    const sent = [];
    const deps = { send: async (m) => { sent.push(m); } };
    ok('a bad email is refused', (await err(() => FB.emailBoard(P, { group: 'WR', email: 'nope' }, deps))).status === 400);
    const hp = await FB.emailBoard(P, { group: 'WR', email: 'bot@example.com', website: 'http://spam' }, deps);
    ok('a bot that fills the hidden field gets ok and nothing is saved or sent', hp.ok && sent.length === 0 && (await P.query(`SELECT 1 FROM portal_board_leads WHERE email = 'bot@example.com'`).catch(() => ({ rows: [] }))).rows.length === 0);
    const e1 = await FB.emailBoard(P, { group: 'WR', currentSchool: 'Troy', email: 'Agent@Example.com', name: 'Pat Agent', agency: 'Pat Sports' }, deps);
    const lead = (await P.query(`SELECT * FROM portal_board_leads WHERE email = 'agent@example.com'`)).rows[0];
    ok('asking for the board saves the lead and emails him the board he asked for', e1.emailed && lead && lead.name === 'Pat Agent' && lead.grp === 'WR' && sent[0].to === 'agent@example.com' && /Your Portal Board: WR/.test(sent[0].subject) && /1\. /.test(sent[0].text));
    ok('the board email is honest and lawful: no people listed, the trial link, how to stop, the business address, no em dashes', !/@/.test(sent[0].text.split('\n').slice(2, 14).join(' ')) && /\/try/.test(sent[0].text) && /Reply "stop"/.test(sent[0].text) && /3796 Turnberry Court, Duluth, GA 30096/.test(sent[0].text) && !/[—–]/.test(sent[0].text));
    ok('and JohnMark hears a lead came in', sent[1] && sent[1].to === 'john@comptongroupllc.com' && /Portal Board lead: Pat Agent, Pat Sports/.test(sent[1].subject));
    await FB.emailBoard(P, { group: 'DB', email: 'agent@example.com' }, deps);
    ok('a second board from the same address counts, keeps his name', (await P.query(`SELECT boards, name, grp FROM portal_board_leads WHERE email = 'agent@example.com'`)).rows[0].boards === 2);
    await P.query(`UPDATE portal_board_leads SET unsubscribed = TRUE WHERE email = 'agent@example.com'`);
    const n0 = sent.length;
    const e3 = await FB.emailBoard(P, { group: 'WR', email: 'agent@example.com' }, deps);
    ok('someone who said stop is never emailed again', !e3.emailed && sent.slice(n0).every((m) => m.to !== 'agent@example.com'));
    const IXf = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    const PGf = fs.readFileSync(REPO + 'server/views/portal-board.html', 'utf8');
    const HM = fs.readFileSync(REPO + 'server/views/home.html', 'utf8');
    ok('public routes, rate limited, no account needed', /app\.post\('\/api\/portal\/free-board', _portalFreeLimiter, async/.test(IXf) && /app\.post\('\/api\/portal\/free-board\/email', _portalLeadLimiter, async/.test(IXf) && /app\.get\('\/api\/portal\/free-board\/meta', _portalFreeLimiter/.test(IXf) && /app\.get\('\/portal-board'/.test(IXf));
    ok('the page only calls the free routes, escapes what it shows, and sends people to the trial for the rest', !/\/api\/portal\/(school|targets|workspace|meta')/.test(PGf) && /const esc = /.test(PGf) && /href="\/try\?from=portal-board"/.test(PGf) && /Not every player listed as a senior leaves/.test(PGf));
    ok('the homepage links it', /href="\/portal-board">Get a free Portal Board</.test(HM));
  }

  OUT.push('-- the morning email --');
  {
    const AL = require(REPO + 'server/services/portalRoom/alerts');
    const nowA = new Date('2026-11-04T13:30:00Z');       // 7:30am Central
    const fakeWs = (over = {}) => ({
      athlete: { id: AT, name: 'Jordan Hayes' }, today: '2026-11-04',
      window: { opens: '2027-01-02', closes: '2027-01-16', daysToOpen: 59, daysToClose: 73, isOpen: false, closed: false },
      cards: [
        { id: 'a', school: 'Baylor', stage: 'contacted', nextStep: 'Call the GM', dueIn: 0, due: true, coachingChange: { date: '2026-11-03' }, coachingLine: 'New head coach coming: Dave Aranda was fired Nov 3.', opens: { opens: 2, lastOpenAt: '2026-11-04T01:00:00Z' } },
        { id: 'b', school: 'Houston', stage: 'interested', nextStep: 'Send film', dueIn: 3, due: false, coachingChange: { date: '2026-10-01' }, opens: { opens: 1, lastOpenAt: '2026-11-01T01:00:00Z' } },
        { id: 'c', school: 'Rice', stage: 'passed', nextStep: 'x', dueIn: -5, due: false, coachingChange: { date: '2026-11-04' } },
      ],
      offers: { deadlines: [{ date: '2026-11-05', text: 'Houston offer expires', days: 1 }, { date: '2026-11-20', text: 'Tulane offer expires', days: 16 }, { date: '2027-01-02', text: 'Portal window opens', days: 59 }], commit: null },
      ...over,
    });
    const it = AL.itemsFor(fakeWs(), nowA);
    ok('the morning holds: a step due, an offer expiring, a fresh coaching change at a target, and a school that opened his one-pager', it.map((x) => x.kind).sort().join(',') === 'coach,due,offer,opened', it);
    ok('and not: an offer 16 days out, an old coaching change, a passed school, an old open', !it.some((x) => /Tulane|Rice/.test(x.text)) && it.filter((x) => x.kind === 'coach').length === 1 && it.filter((x) => x.kind === 'opened').length === 1);
    ok('the window line only on its days: 14, 7, 1 and 0 before it opens; 3 and 1 before it closes', AL.windowLine(fakeWs()) === null && AL.windowLine(fakeWs({ window: { daysToOpen: 7 } })) === 'The portal window opens in 7 days.' && AL.windowLine(fakeWs({ window: { daysToOpen: 0 } })) === 'The portal window opens today.' && AL.windowLine(fakeWs({ window: { daysToOpen: -5, daysToClose: 1, isOpen: true } })) === 'The portal window closes in 1 day.');
    const sentA = [];
    const depsA = { workspace: async () => fakeWs(), send: async (m) => { sentA.push(m); } };
    await P.query(`DELETE FROM portal_alert_sends`).catch(() => {});
    const r1 = await AL.runAgent(P, store, AG, { now: nowA, deps: depsA });
    ok('one email to the agent, with each client\'s items and a link to his board', r1.sent && sentA.length === 1 && sentA[0].to === 'crm@example.com' && /Jordan Hayes:/.test(sentA[0].text) && /Baylor: Call the GM \(due today\)/.test(sentA[0].text) && /portal-room\?a=crm-ath/.test(sentA[0].text) && /^Portal Room: 4 things for today$/.test(sentA[0].subject), sentA[0] && sentA[0].text);
    ok('plain, no em dashes, and a working stop link', !/[—–]/.test(sentA[0].text) && /portal-alerts\/off\?a=crm-agent&s=[a-f0-9]{32}/.test(sentA[0].text));
    ok('never twice in a day, restart or not', (await AL.runAgent(P, store, AG, { now: new Date(nowA.getTime() + 3600000), deps: depsA })).skipped === 'already today' && sentA.length === 1);
    const quiet = await AL.runAgent(P, store, AG, { now: new Date('2026-11-05T13:30:00Z'), deps: { workspace: async () => fakeWs({ cards: [], offers: { deadlines: [] } }), send: depsA.send } });
    ok('a morning with nothing to act on sends nothing', !quiet.sent && sentA.length === 1);
    ok('a forged stop link does nothing; the real one turns it off', !(await AL.turnOff(P, AG, 'f'.repeat(32))) && (await AL.turnOff(P, AG, AL.stopUrl(AG).split('s=')[1])));
    ok('and after that he gets none', (await AL.runAgent(P, store, AG, { now: new Date('2026-11-06T13:30:00Z'), deps: depsA })).skipped === 'turned off' && sentA.length === 1);
    ok('the scheduler only runs 7 to 9am Central', (await AL.tick(P, store, { now: new Date('2026-11-04T18:00:00Z'), deps: depsA })).skipped === 'not the hour');
    const IXa = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    ok('it is scheduled, and the stop link has its page', /PRA\.tick\(store\.pool, store\)/.test(IXa) && /app\.get\('\/portal-alerts\/off'/.test(IXa));
  }

  OUT.push('-- coaching changes from the news --');
  {
    const CW = require(REPO + 'server/services/portalRoom/coachingWatch');
    const Co = require(REPO + 'server/services/portalRoom/coachingChanges');
    const nowC = new Date('2026-11-04T12:30:00Z');
    const news = [
      { title: 'Tulane fires head coach Jon Sumrall after 4-5 start', snippet: 'Tulane has fired head football coach Jon Sumrall, the school announced Monday.', link: 'https://www.espn.com/college-football/story/1', date: '2 days ago' },
      { title: 'Tennessee State fires head football coach', snippet: 'Tennessee State parted ways with its head football coach.', link: 'https://www.espn.com/college-football/story/2', date: '1 day ago' },
      { title: 'Coaches on the hot seat: who could be fired next', snippet: 'Several head coaches could be fired soon.', link: 'https://www.cbssports.com/x', date: '1 day ago' },
      { title: 'Houston fires defensive coordinator', snippet: 'Houston fired its defensive coordinator, not its head coach.', link: 'https://www.on3.com/y', date: '1 day ago' },
      { title: 'Rice head coach resigns', snippet: 'Rice head football coach resigned Sunday.', link: 'https://randomblog.example.com/z', date: '1 day ago' },
      { title: 'UCF parts ways with head football coach', snippet: 'UCF and its head football coach parted ways in 2025.', link: 'https://www.espn.com/college-football/story/old', date: '1 day ago' },
      { title: 'Baylor fires head coach Dave Aranda', snippet: 'Baylor fired head football coach Dave Aranda.', link: 'https://www.espn.com/college-football/story/3', date: '9 days ago' },
    ];
    const reads = {
      'https://www.espn.com/college-football/story/1': { departure: true, school: 'Tulane', coach: 'Jon Sumrall', how: 'fired', date: '2026-11-02', interim: null, newCoach: null },
      'https://www.espn.com/college-football/story/2': { departure: true, school: 'Tennessee State', coach: 'Someone', how: 'fired', date: '2026-11-03' },
      'https://www.on3.com/y': { departure: false },
      'https://randomblog.example.com/z': { departure: true, school: 'Rice', coach: 'X', how: 'resigned', date: '2026-11-02' },
      'https://www.espn.com/college-football/story/old': { departure: true, school: 'UCF', coach: 'Y', how: 'left', date: '2025-11-30' },
      'https://www.espn.com/college-football/story/3': { departure: true, school: 'Baylor', coach: 'Dave Aranda', how: 'fired', date: '2026-10-30' },
    };
    const notes = [];
    let asked = 0;
    const depsC = { search: async () => news, extract: async (it) => { asked++; return reads[it.link] || { departure: false }; }, notify: async (m) => notes.push(m) };
    const r = await CW.run(P, { now: nowC, deps: depsC });
    const why = (t) => (r.skipped.find((x) => x.title.startsWith(t)) || {}).why || '';
    ok('a real departure at an FBS school, from a known outlet, is added with its link', r.added.length === 1 && r.added[0].school === 'Tulane' && r.added[0].coach === 'Jon Sumrall' && r.added[0].source === 'https://www.espn.com/college-football/story/1', r.added);
    ok('and every board shows it from then on', (await Co.load(P, { now: nowC })).get('Tulane').coach === 'Jon Sumrall');
    ok('a namesake is refused (Tennessee State is not Tennessee)', /not FBS/.test(why('Tennessee State')));
    ok('a hot-seat story never reaches the model', why('Coaches on the hot seat') === 'rumor');
    ok('a coordinator is not a head coach', why('Houston fires defensive') === 'not a head coach leaving');
    ok('an unknown website is not a source', /unknown outlet/.test(why('Rice head coach')));
    ok('an old story is not news', /too old/.test(why('UCF parts ways')));
    ok('a change already on file is not added twice', why('Baylor fires') === 'already on file');
    ok('JohnMark gets the list with links, and how to take a wrong one out', notes.length === 1 && /Tulane: Jon Sumrall fired 2026-11-02\. https:\/\/www\.espn\.com/.test(notes[0].text) && /DELETE \/api\/admin\/portal\/coaching-change/.test(notes[0].text));
    ok('the same story the next run adds nothing', (await CW.run(P, { now: nowC, deps: depsC })).added.length === 0);
    ok('a wrong one comes out', (await CW.remove(P, 'Tulane')).removed === 1 && !(await Co.load(P, { now: nowC })).has('Tulane'));
    ok('it runs once a day, 6 to 7am Central', (await CW.tick(P, { now: new Date('2026-11-04T18:00:00Z'), deps: depsC })).skipped === 'not the hour');
    const IXc = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    ok('scheduled, with admin routes to run it and to take one out', /PCW\.tick\(store\.pool\)/.test(IXc) && /app\.delete\('\/api\/admin\/portal\/coaching-change\/:school'/.test(IXc) && /app\.post\('\/api\/admin\/portal\/coach-watch'/.test(IXc));
  }

  OUT.push('-- public position pages and the weekly report --');
  {
    const PP = require(REPO + 'server/services/portalRoom/positionPages');
    PP.clearCache();
    const html = await PP.page(P, 'wr', { now: NOW });
    ok('/portal-room/needs/wr is a full page from the roster count: thinnest rooms first, read rosters only', /<h1>FBS schools that need a wide receiver for the 2027 transfer portal<\/h1>/.test(html) && /Baylor/.test(html) && html.indexOf('Baylor') < html.indexOf('Houston') && !/Roster not read yet<\/b>/.test(html));
    ok('it says how it is counted and what it is not', /Not every senior leaves/.test(html) && /from \d+ of \d+ FBS rosters read/.test(html) && /rel="canonical" href="https:\/\/mynildash\.com\/portal-room\/needs\/wr"/.test(html));
    ok('it ends with the free board for that position and the demo', /href="\/portal-board\?position=wr"/.test(html) && /href="\/portal-room\/demo"/.test(html));
    ok('an unknown position is a 404, not a page', (await PP.page(P, 'xyz')) === null);
    ok('names are escaped on the page', !/<script>/.test(html.replace(/<script[\s\S]*?<\/script>/g, '')));
    const WR = require(REPO + 'server/services/portalRoom/weeklyReport');
    await P.query(`UPDATE portal_board_leads SET unsubscribed = FALSE WHERE email = 'agent@example.com'`);
    await P.query(`INSERT INTO portal_board_leads (email, name, grp, unsubscribed) VALUES ('gone@example.com','Gone','WR',TRUE) ON CONFLICT DO NOTHING`);
    const sentR = [];
    const monday = new Date('2026-11-09T14:30:00Z');   // Mon 8:30am Central
    const rr = await WR.run(P, { now: monday, deps: { send: async (m) => sentR.push(m) } });
    const toAgent = sentR.find((m) => m.to === 'agent@example.com');
    ok('Monday: every lead who has not said stop gets one Portal Report for his position', toAgent && !sentR.some((m) => m.to === 'gone@example.com') && rr.sent === sentR.length && /Portal Report: who needs a/.test(toAgent.subject));
    ok('it has the top 5, the window countdown, the free board and the trial, a stop link and the address, no em dashes', /^1\. /m.test(toAgent.text) && /days until the portal window opens/.test(toAgent.text) && /\/portal-board\?position=/.test(toAgent.text) && /\/try/.test(toAgent.text) && /portal-report\/stop\?e=agent%40example\.com&s=[a-f0-9]{32}/.test(toAgent.text) && /3796 Turnberry Court/.test(toAgent.text) && !/[—–]/.test(toAgent.text));
    ok('never twice in a week', (await WR.run(P, { now: new Date(monday.getTime() + 1800000), deps: { send: async (m) => sentR.push(m) } })).sent === 0);
    ok('a forged stop link does nothing; the real one stops him for good', !(await WR.stop(P, 'agent@example.com', 'a'.repeat(32))) && (await WR.stop(P, 'agent@example.com', WR.stopUrl('agent@example.com').split('s=')[1])) && (await P.query(`SELECT unsubscribed FROM portal_board_leads WHERE email = 'agent@example.com'`)).rows[0].unsubscribed === true);
    ok('it only runs Mondays 8 to 9am Central', (await WR.tick(P, { now: new Date('2026-11-10T14:30:00Z') })).skipped === 'not the hour');
    const IXp = fs.readFileSync(REPO + 'server/index.js', 'utf8');
    const SM = fs.readFileSync(REPO + 'public/sitemap.xml', 'utf8');
    const RB = fs.readFileSync(REPO + 'public/robots.txt', 'utf8');
    ok('routes, schedule, sitemap and robots: public pages listed, token links never crawled', /app\.get\('\/portal-room\/needs\/:pos'/.test(IXp) && /PWR\.tick\(store\.pool\)/.test(IXp) && /app\.get\('\/portal-report\/stop'/.test(IXp) && /portal-room\/needs\/wr<\/loc>/.test(SM) && /portal-board<\/loc>/.test(SM) && /Disallow: \/portal-profile\//.test(RB) && /Disallow: \/portal-report\//.test(RB));
  }

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
