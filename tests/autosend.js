'use strict';
// ── DONE FOR YOU: SEND MY PITCHES EVERY MORNING (services/autoSend) ─────────
// Runs against the local test Postgres. The Closer's batch, its approval and
// the note email are stand-ins; what is under test is who gets run, when,
// once, and what the agent is told.
//
//   - off (AUTO_SEND_ON unset): nothing runs and the switch cannot be turned on;
//   - turning it on needs a connected mailbox and a business address, and says which;
//   - only weekdays, 9:00 to 3:00 Central; only agents who turned it on, not archived;
//   - once a day per agent, across ticks;
//   - approves exactly the morning's batch, and the note lists what went out;
//   - nothing ready: no note; a failure is recorded and others still run;
//   - turning it off stops the next morning.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('autosendtest', { schema: true });
delete process.env.AUTO_SEND_ON;
delete process.env.AUTO_SEND_AT;
require('./helpers/offlineDns').install();

const store = require(REPO + 'server/store.js');
const AS = require(REPO + 'server/services/autoSend.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;
// Central wall time -> Date. Oct 2026 is CDT (UTC-5).
const CT = (ymd, h, m) => new Date(`${ymd}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`);
const TUE = '2026-10-27', WED = '2026-10-28', SAT = '2026-10-31';

function makeDeps(over = {}) {
  const calls = { built: [], approved: [], sent: [] };
  const status = over.status || {};          // id -> 'sent' | 'pending' | 'stopped'
  const batches = over.batches || {};
  const deps = {
    mailbox: async (id) => ({ connected: id !== 'as-nomail' }),
    senderAddress: async (id) => ({ ok: id !== 'as-noaddr' }),
    buildBatch: async (id) => {
      calls.built.push(id);
      if (id === 'as-boom') throw new Error('provider down');
      return { batch: batches[id] || [] };
    },
    approveBatch: async (id, ids) => { calls.approved.push({ id, ids }); return { approved: ids.length, when: ids.map((x) => ({ id: x })) }; },
    send: async (to, msg) => { calls.sent.push({ to, msg }); },
    statusOf: async (ids) => new Map(ids.map((id) => [String(id), status[id] || 'sent'])),
    freshIds: async (ids) => new Set(ids.map(String).filter((id) => !(over.stale || []).includes(id))),
  };
  return { deps, calls };
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await AS.ensureTables(P());
  const mk = (id, name, extra = '') => P().query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, $2, $3, 'x', 'agent')`, [id, name, id + '@agents.test']).then(() => extra && P().query(extra, [id]));
  await mk('as-ann', 'Ann Agent');
  await mk('as-bob', 'Bob Broker');
  await mk('as-nomail', 'No Mailbox');
  await mk('as-noaddr', 'No Address');
  await mk('as-arch', 'Archived Agent', `UPDATE users SET archived = TRUE WHERE id = $1`);
  await mk('as-boom', 'Boom Agent');

  // ── OFF ───────────────────────────────────────────────────────────────
  OUT.push('-- off --');
  const off = makeDeps();
  ok('off: tick does nothing', (await AS.tick(P(), { now: CT(TUE, 9, 30), deps: off.deps })).skipped === 'AUTO_SEND_ON is off');
  const offSet = await AS.set(P(), 'as-ann', true, off.deps);
  ok('off: the switch will not turn on', !offSet.ok && /not available/.test(offSet.error), offSet);
  ok('off: Settings hides the card', (await AS.status(P(), 'as-ann', off.deps)).available === false);

  // ── TURNING IT ON ─────────────────────────────────────────────────────
  OUT.push('', '-- turning it on --');
  process.env.AUTO_SEND_ON = 'true';
  const d0 = makeDeps();
  const nm = await AS.set(P(), 'as-nomail', true, d0.deps);
  ok('no mailbox: refused, and says to connect it', !nm.ok && nm.missing.length === 1 && /mailbox/.test(nm.missing[0]), nm);
  const na = await AS.set(P(), 'as-noaddr', true, d0.deps);
  ok('no business address: refused, and says to add it', !na.ok && na.missing.length === 1 && /business address/.test(na.missing[0]), na);
  for (const id of ['as-ann', 'as-bob', 'as-boom']) ok(`${id}: turns on`, (await AS.set(P(), id, true, d0.deps)).ok);
  await P().query(`UPDATE users SET auto_send_on = TRUE WHERE id = 'as-arch'`);   // archived, switch left on
  const st = await AS.status(P(), 'as-ann', d0.deps);
  ok('status: on, ready, since set', st.available && st.on && st.ready && st.since, st);
  ok('status for the agent without a mailbox lists what is missing', (await AS.status(P(), 'as-nomail', d0.deps)).missing.length === 1);

  // ── THE WINDOW ────────────────────────────────────────────────────────
  OUT.push('', '-- the window --');
  const w = makeDeps();
  ok('8:59 Central: not yet', (await AS.tick(P(), { now: CT(TUE, 8, 59), deps: w.deps })).skipped === 'not the window');
  ok('3:00 pm Central: too late', (await AS.tick(P(), { now: CT(TUE, 15, 0), deps: w.deps })).skipped === 'not the window');
  ok('Saturday: never', (await AS.tick(P(), { now: CT(SAT, 10, 0), deps: w.deps })).skipped === 'not the window');
  ok('nothing was built outside the window', w.calls.built.length === 0, w.calls.built);

  // ── THE MORNING ───────────────────────────────────────────────────────
  OUT.push('', '-- the morning --');
  const batches = {
    'as-ann': [
      // buildBatch's real shape: `to` is { name, title, kind }.
      { id: 'L1', athleteName: 'Jay Runner', brand: 'Smoothie Hut', to: { name: 'Dana Lee', title: 'Owner', kind: 'person' } },
      { id: 'L2', athleteName: 'Jay Runner', brand: 'Tire Barn', to: { name: 'the general inbox', title: null, kind: 'inbox' } },
      { id: 'L3', athleteName: 'Kim <Swim>', brand: 'Pool & Patio', to: { name: 'Owner', title: null, kind: 'person' } },
    ],
    // Bob has nothing ready.
  };
  const m = makeDeps({ batches });
  const r1 = await AS.tick(P(), { now: CT(TUE, 9, 5), deps: m.deps });
  const ran = (r1.agents || []).map((a) => a.agentId).sort();
  ok('runs exactly the agents who turned it on, not archived, not refused', JSON.stringify(ran) === JSON.stringify(['as-ann', 'as-bob', 'as-boom']), ran);
  const annApproved = m.calls.approved.find((x) => x.id === 'as-ann');
  ok('approves exactly the morning batch', annApproved && annApproved.ids.join(',') === 'L1,L2,L3', m.calls.approved);
  ok('nothing ready: nothing approved', !m.calls.approved.some((x) => x.id === 'as-bob'));
  ok('no note at approval: nothing has been sent yet', m.calls.sent.length === 0, m.calls.sent.length);

  // ── THE NOTE WAITS FOR THE QUEUE ──────────────────────────────────────
  OUT.push('', '-- the note waits for the release queue --');
  const busy = makeDeps({ status: { L1: 'sent', L2: 'pending', L3: 'sent' } });
  const n1 = await AS.notes(P(), { now: new Date(), deps: busy.deps });
  ok('one still sending: no note yet', busy.calls.sent.length === 0 && n1.some((x) => x.agentId === 'as-ann' && x.waiting === 1), n1);
  const done = makeDeps({ status: { L1: 'sent', L2: 'stopped', L3: 'sent' } });
  await AS.notes(P(), { now: new Date(), deps: done.deps });
  m.calls.sent.push(...done.calls.sent);
  ok('one note, to the agent who had sends', done.calls.sent.length === 1 && done.calls.sent[0].to === 'as-ann@agents.test', done.calls.sent.map((x) => x.to));
  const note = done.calls.sent[0] && done.calls.sent[0].msg;
  ok('the note names only what went out, and says one was held back', note && /sent 2 pitches/.test(note.subject) && !/Tire Barn/.test(note.text)
    && /1 more didn't go out because a send check stopped it/.test(note.text) && /Smoothie Hut, to Dana Lee/.test(note.text) && !/object Object/.test(note.text), note && note.text);
  const again2 = makeDeps({ status: { L1: 'sent', L2: 'sent', L3: 'sent' } });
  await AS.notes(P(), { now: new Date(), deps: again2.deps });
  ok('never a second note for the same morning', again2.calls.sent.length === 0);
  const full = AS.noteFor({ name: 'Ann Agent' }, batches['as-ann'].map((x) => ({ ...x, to: x.to.kind === 'person' ? x.to.name : null })), 0);
  ok('the note: count in the subject', /sent 3 pitches/.test(full.subject), full.subject);
  ok('the note: grouped by athlete, each business named', /Jay Runner:\n {2}- Smoothie Hut, to Dana Lee\n {2}- Tire Barn\n/.test(full.text), full.text);
  ok('the note: starts with the first name, says how to stop', note && /^Hi Ann,/.test(note.text) && /turn it off in Settings/.test(note.text));
  ok('the note: html escapes what it prints', note && note.html.includes('Kim &lt;Swim&gt;') && note.html.includes('Pool &amp; Patio') && !note.html.includes('<Swim>'));
  const runs = (await P().query(`SELECT agent_id, approved, offered, note, emailed_at, sent, held FROM auto_send_runs WHERE run_date = $1 ORDER BY agent_id`, [TUE])).rows;
  const by = Object.fromEntries(runs.map((x) => [x.agent_id, x]));
  ok('the run is recorded: approved, offered, sent, held, emailed', by['as-ann'] && by['as-ann'].approved === 3 && by['as-ann'].offered === 3
    && by['as-ann'].sent === 2 && by['as-ann'].held === 1 && by['as-ann'].emailed_at, by['as-ann']);
  ok('nothing ready is recorded as such', by['as-bob'] && by['as-bob'].approved === 0 && /nothing ready/.test(by['as-bob'].note), by['as-bob']);
  ok('a failure is recorded, and the others still ran', by['as-boom'] && /failed: provider down/.test(by['as-boom'].note) && by['as-ann'].approved === 3, by['as-boom']);

  // ── ONCE A DAY ────────────────────────────────────────────────────────
  OUT.push('', '-- once a day --');
  const again = makeDeps({ batches });
  const r2 = await AS.tick(P(), { now: CT(TUE, 11, 0), deps: again.deps });
  ok('a second tick the same day runs nobody', (r2.agents || []).length === 0 && again.calls.built.length === 0, r2);
  const direct = await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: TUE, deps: again.deps });
  ok('even called directly, the claim holds', direct.skipped === 'already ran today' && again.calls.approved.length === 0, direct);
  const st2 = await AS.status(P(), 'as-ann', again.deps);
  ok('Settings shows the last run', st2.last && st2.last.approved === 3 && st2.last.sent === 2 && st2.last.date === TUE, st2.last);

  // ── PARTIAL APPROVAL ──────────────────────────────────────────────────
  OUT.push('', '-- only what was approved is reported --');
  const part = makeDeps({ batches });
  part.deps.approveBatch = async (id, ids) => ({ approved: 1, when: [{ id: 'L2' }], note: '2 left for tomorrow' });
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-10-29', deps: part.deps });
  await AS.notes(P(), { now: new Date(), deps: part.deps });
  const pn = part.calls.sent[0] && part.calls.sent[0].msg;
  ok('the note lists only the approved one', pn && /sent 1 pitch for/.test(pn.subject) && /Tire Barn/.test(pn.text) && !/Smoothie Hut/.test(pn.text), pn && pn.text);

  // ── THE MAILBOX DROPPED ───────────────────────────────────────────────
  OUT.push('', '-- the mailbox dropped after it was turned on --');
  const drop = makeDeps({ batches });
  drop.deps.mailbox = async () => ({ connected: false });
  const dr = await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-10-30', deps: drop.deps });
  ok('nothing built or approved, and the run says why', dr.approved === 0 && drop.calls.built.length === 0 && drop.calls.approved.length === 0
    && /not sent: connect the mailbox/.test((await P().query(`SELECT note FROM auto_send_runs WHERE agent_id = 'as-ann' AND run_date = '2026-10-30'`)).rows[0].note), dr);

  // ── A TEMPORARY HOLD IS NOT "NOT SENT" ────────────────────────────────
  OUT.push('', '-- a retry or hold still counts as going out --');
  const holdDeps = makeDeps({ batches, status: { L1: 'sent', L2: 'pending', L3: 'sent' } });
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-03', deps: holdDeps.deps });
  await AS.notes(P(), { now: new Date(), deps: holdDeps.deps });
  ok('waits while one is held for a retry', holdDeps.calls.sent.length === 0);
  await P().query(`UPDATE auto_send_runs SET started_at = NOW() - INTERVAL '13 hours' WHERE agent_id = 'as-ann' AND run_date = '2026-11-03'`);
  await AS.notes(P(), { now: new Date(), deps: holdDeps.deps });
  const hn = holdDeps.calls.sent[0] && holdDeps.calls.sent[0].msg.text;
  ok('past the cap: says it is still sending, never that it was stopped', hn && /1 is still waiting to send/.test(hn) && !/didn't go out/.test(hn), hn);

  // ── OLD DRAFTS ARE NOT THIS MORNING'S ─────────────────────────────────
  OUT.push('', '-- old drafts stay for the agent --');
  const oldDeps = makeDeps({ batches, stale: ['L1', 'L2'] });
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-04', deps: oldDeps.deps });
  ok('only the fresh draft is approved', oldDeps.calls.approved.length === 1 && oldDeps.calls.approved[0].ids.join(',') === 'L3', oldDeps.calls.approved);
  const allOld = makeDeps({ batches, stale: ['L1', 'L2', 'L3'] });
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-05', deps: allOld.deps });
  const on5 = (await P().query(`SELECT approved, note FROM auto_send_runs WHERE agent_id = 'as-ann' AND run_date = '2026-11-05'`)).rows[0];
  ok('all old: nothing approved, and the run says why', allOld.calls.approved.length === 0 && /3 older than 14 days/.test(on5.note), on5);

  // ── NOTHING SENT AT ALL ───────────────────────────────────────────────
  OUT.push('', '-- every approved email held back --');
  const allHeld = makeDeps({ batches, status: { L1: 'stopped', L2: 'stopped', L3: 'stopped' } });
  await P().query(`DELETE FROM auto_send_runs WHERE agent_id = 'as-ann' AND run_date = '2026-11-02'`);
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-02', deps: allHeld.deps });
  await AS.notes(P(), { now: new Date(), deps: allHeld.deps });
  const hr = (await P().query(`SELECT sent, held, emailed_at FROM auto_send_runs WHERE agent_id = 'as-ann' AND run_date = '2026-11-02'`)).rows[0];
  ok('no email that says "sent 0"; recorded as 0 sent, 3 held', allHeld.calls.sent.length === 0 && hr.sent === 0 && hr.held === 3 && !hr.emailed_at, hr);

  // ── TURNING IT OFF ────────────────────────────────────────────────────
  OUT.push('', '-- turning it off --');
  const bobUrlBefore = await (async () => { await P().query(`UPDATE users SET auto_send_token = 'b'||repeat('0',47) WHERE id = 'as-bob'`); return 'b' + '0'.repeat(47); })();
  ok('turns off', (await AS.set(P(), 'as-bob', false)).ok);
  ok('turning off kills the old one-tap link', (await AS.byToken(P(), bobUrlBefore)) === null);
  const lateDeps = makeDeps({ batches });
  const late = await AS.runAgent(P(), { id: 'as-bob', email: 'as-bob@agents.test', name: 'Bob Broker' }, { date: '2026-11-06', deps: lateDeps.deps });
  ok('an agent who turned it off after the tick picked them is not sent for', late.skipped && lateDeps.calls.built.length === 0, late);
  const wed = makeDeps({ batches });
  const r3 = await AS.tick(P(), { now: CT(WED, 9, 0), deps: wed.deps });
  const ranWed = (r3.agents || []).map((a) => a.agentId).sort();
  ok('the next morning skips the agent who turned it off', !ranWed.includes('as-bob') && ranWed.includes('as-ann'), ranWed);
  ok('status: off, since cleared', (await (async () => { const s = await AS.status(P(), 'as-bob', wed.deps); return !s.on && !s.since; })()));

  // ── THE ONE-TAP LINK ──────────────────────────────────────────────────
  OUT.push('', '-- the one-tap link --');
  const url = await AS.offerUrl(P(), 'as-bob');
  ok('an agent with it off is offered a link', /\/auto-send\/on\?t=[a-f0-9]{48}$/.test(url || ''), url);
  const t = url.split('t=')[1];
  ok('the same link every night', (await AS.offerUrl(P(), 'as-bob')) === url);
  ok('no link for an agent who has it on', (await AS.offerUrl(P(), 'as-ann')) === null);
  const who = await AS.byToken(P(), t);
  ok('the token finds the agent, and only a real token does', who && who.id === 'as-bob' && (await AS.byToken(P(), 'nope')) === null && (await AS.byToken(P(), 'a'.repeat(48))) === null);
  const askHtml = AS.page('ask', { user: who, token: t });
  ok('the page asks with a POST button; the GET changes nothing', /<form method="post" action="\/auto-send\/on">/.test(askHtml) && askHtml.includes(t)
    && (await AS.status(P(), 'as-bob', d0.deps)).on === false && /noindex/.test(askHtml));
  ok('the missing page says what to do', /connect the mailbox/.test(AS.page('missing', { missing: ['connect the mailbox your pitches send from (Settings, Email)'] })));
  ok('nothing in the pages is unescaped', !/<script/i.test(AS.page('on', { user: { name: '<script>x</script>' } })));

  // ── THE NIGHTLY EMAIL ─────────────────────────────────────────────────
  OUT.push('', '-- the nightly email --');
  const ND = require(REPO + 'server/services/nightlyDigest.js');
  const rows = [{ athleteId: 'a1', name: 'Jay Runner', place: 'Austin', pitches: [{ id: 'p1', brand: 'Smoothie Hut', approveUrl: 'https://x/a/1', skipUrl: 'https://x/a/2' }] }];
  const offered = ND.render({ rows, reviewUrl: 'https://x/', date: new Date(), autoSendUrl: url });
  ok('off: the email offers the one-tap link', offered.html.includes(url) && offered.text.includes(url) && /Send my pitches every morning/.test(offered.html));
  const autoOnMsg = ND.render({ rows, reviewUrl: 'https://x/', date: new Date(), autoOn: true, autoSendUrl: url });
  ok('on: no offer, and the email says they send at 9:00 and Skip is the choice', !autoOnMsg.html.includes(url) && /Automatic sending is on/.test(autoOnMsg.text) && /Skip any of these you don't want sent/.test(autoOnMsg.text));
  const plain = ND.render({ rows, reviewUrl: 'https://x/', date: new Date() });
  ok('without either, the email is as it was', !/Automatic sending/.test(plain.text) && !/every morning/.test(plain.text));

  // ── THE NIGHTLY FILL ──────────────────────────────────────────────────
  OUT.push('', '-- the nightly fill --');
  const OQ = require(REPO + 'server/jobs/outreachQueue.js');
  ok('an agent with it on is active without signing in', OQ.inactiveSkip({ last_login: null, auto_send_on: true }) === null);
  ok('an agent with it off who never signed in is still dormant', /never signed in/.test(OQ.inactiveSkip({ last_login: null, auto_send_on: false }) || ''));
  process.env.AUTO_SEND_ON = '';
  ok('with the master switch off, the flag alone does not count', /never signed in/.test(OQ.inactiveSkip({ last_login: null, auto_send_on: true }) || ''));
  process.env.AUTO_SEND_ON = 'true';

  // ── THE INVITE ────────────────────────────────────────────────────────
  OUT.push('', '-- the invite --');
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ath-bob', 'as-bob', '{"name":"B"}'), ('ath-int', 'as-int', '{"name":"I"}')`).catch(async (e) => {
    OUT.push('note: athlete insert: ' + e.message); });
  await P().query(`INSERT INTO users (id, name, email, password, role) VALUES ('as-int', 'Internal', 'x@comptongroupllc.com', 'x', 'agent') ON CONFLICT DO NOTHING`);
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ath-int2', 'as-int', '{"name":"I"}') ON CONFLICT DO NOTHING`).catch(() => {});
  const dry = await AS.invite(P(), { deps: d0.deps });
  const dryEmails = dry.list.map((x) => x.email);
  ok('dry run: real agents with athletes who have it off; never internal, never one who has it on', dryEmails.includes('as-bob@agents.test')
    && !dryEmails.includes('x@comptongroupllc.com') && !dryEmails.includes('as-ann@agents.test'), dryEmails);
  const sentInv = makeDeps();
  const real = await AS.invite(P(), { send: true, deps: { ...d0.deps, send: sentInv.deps.send } });
  const inv = sentInv.calls.sent.find((x) => x.to === 'as-bob@agents.test');
  ok('send: the email carries their own one-tap link and no em dash', inv && inv.msg.text.includes(url) && !/\u2014/.test(inv.msg.text) && /^Hi Bob,/.test(inv.msg.text), inv && inv.msg.text);
  const second = makeDeps();
  await AS.invite(P(), { send: true, deps: { ...d0.deps, send: second.deps.send } });
  ok('never twice', !second.calls.sent.some((x) => x.to === 'as-bob@agents.test') && real.list.some((x) => x.sent));
  const savedKey = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  await P().query(`UPDATE users SET auto_send_invited_at = NULL WHERE id = 'as-bob'`);
  const nokey = await AS.invite(P(), { send: true });
  ok('no email key: refuses, and marks nobody invited', /RESEND_API_KEY/.test(nokey.skipped || '')
    && (await P().query(`SELECT auto_send_invited_at FROM users WHERE id = 'as-bob'`)).rows[0].auto_send_invited_at === null);
  const failing = await AS.invite(P(), { send: true, deps: { ...d0.deps, send: async () => { throw new Error('Resend down'); } } });
  ok('a failed send is not counted as invited', failing.list.some((x) => x.error) && (await P().query(`SELECT auto_send_invited_at FROM users WHERE id = 'as-bob'`)).rows[0].auto_send_invited_at === null);
  if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
  process.env.AUTO_SEND_ON = '';
  ok('off: the invite refuses, because the link would not work', /off/.test((await AS.invite(P(), {})).skipped || ''));
  process.env.AUTO_SEND_ON = 'true';

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
