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
      { id: 'L1', athleteName: 'Jay Runner', brand: 'Smoothie Hut', to: 'Dana Lee' },
      { id: 'L2', athleteName: 'Jay Runner', brand: 'Tire Barn', to: null },
      { id: 'L3', athleteName: 'Kim <Swim>', brand: 'Pool & Patio', to: 'Owner' },
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
  ok('one note, to the agent who had sends', m.calls.sent.length === 1 && m.calls.sent[0].to === 'as-ann@agents.test', m.calls.sent.map((x) => x.to));
  const note = m.calls.sent[0] && m.calls.sent[0].msg;
  ok('the note: count in the subject', note && /sent 3 pitches/.test(note.subject), note && note.subject);
  ok('the note: grouped by athlete, each business named', note && /Jay Runner:\n {2}- Smoothie Hut, to Dana Lee\n {2}- Tire Barn\n/.test(note.text), note && note.text);
  ok('the note: starts with the first name, says how to stop', note && /^Hi Ann,/.test(note.text) && /turn it off in Settings/.test(note.text));
  ok('the note: html escapes what it prints', note && note.html.includes('Kim &lt;Swim&gt;') && note.html.includes('Pool &amp; Patio') && !note.html.includes('<Swim>'));
  const runs = (await P().query(`SELECT agent_id, approved, offered, note, emailed_at FROM auto_send_runs WHERE run_date = $1 ORDER BY agent_id`, [TUE])).rows;
  const by = Object.fromEntries(runs.map((x) => [x.agent_id, x]));
  ok('the run is recorded: approved, offered, emailed', by['as-ann'] && by['as-ann'].approved === 3 && by['as-ann'].offered === 3 && by['as-ann'].emailed_at, by['as-ann']);
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
  ok('Settings shows the last run', st2.last && st2.last.approved === 3 && st2.last.date === TUE, st2.last);

  // ── PARTIAL APPROVAL ──────────────────────────────────────────────────
  OUT.push('', '-- only what was approved is reported --');
  const part = makeDeps({ batches });
  part.deps.approveBatch = async (id, ids) => ({ approved: 1, when: [{ id: 'L2' }], note: '2 left for tomorrow' });
  await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-10-29', deps: part.deps });
  const pn = part.calls.sent[0] && part.calls.sent[0].msg;
  ok('the note lists only the approved one', pn && /sent 1 pitch for/.test(pn.subject) && /Tire Barn/.test(pn.text) && !/Smoothie Hut/.test(pn.text), pn && pn.text);

  // ── THE MAILBOX DROPPED ───────────────────────────────────────────────
  OUT.push('', '-- the mailbox dropped after it was turned on --');
  const drop = makeDeps({ batches });
  drop.deps.mailbox = async () => ({ connected: false });
  const dr = await AS.runAgent(P(), { id: 'as-ann', email: 'as-ann@agents.test', name: 'Ann Agent' }, { date: '2026-10-30', deps: drop.deps });
  ok('nothing built or approved, and the run says why', dr.approved === 0 && drop.calls.built.length === 0 && drop.calls.approved.length === 0
    && /not sent: connect the mailbox/.test((await P().query(`SELECT note FROM auto_send_runs WHERE agent_id = 'as-ann' AND run_date = '2026-10-30'`)).rows[0].note), dr);

  // ── TURNING IT OFF ────────────────────────────────────────────────────
  OUT.push('', '-- turning it off --');
  ok('turns off', (await AS.set(P(), 'as-bob', false)).ok);
  const wed = makeDeps({ batches });
  const r3 = await AS.tick(P(), { now: CT(WED, 9, 0), deps: wed.deps });
  const ranWed = (r3.agents || []).map((a) => a.agentId).sort();
  ok('the next morning skips the agent who turned it off', !ranWed.includes('as-bob') && ranWed.includes('as-ann'), ranWed);
  ok('status: off, since cleared', (await (async () => { const s = await AS.status(P(), 'as-bob', wed.deps); return !s.on && !s.since; })()));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
