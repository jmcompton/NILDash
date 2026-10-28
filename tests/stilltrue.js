'use strict';
// ── STILL TRUE? (services/stillTrue) and the auto-send that uses it ──────────
// Local test Postgres. Email is a stand-in.
//
//   - a pitch whose athlete changed school / position since it was written waits;
//   - a pitch for an athlete no longer on the agent's roster waits;
//   - a fallback pitch (no writer angle), a thin card, a leftover blank wait;
//   - an old draft with no saved facts is checked against the athlete on file;
//   - a good pitch goes; a missing one fails closed;
//   - auto-send: waiting pitches are not approved, the note lists them with the
//     reason, and a morning where nothing sent still gets that note;
//   - the note has a one-tap off link; the off link only asks on GET;
//   - the invite says plainly it is optional.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('stilltruetest', { schema: true });
process.env.AUTO_SEND_ON = 'true';
require('./helpers/offlineDns').install();

const fs = require('fs');
const store = require(REPO + 'server/store.js');
const ST = require(REPO + 'server/services/stillTrue.js');
const AS = require(REPO + 'server/services/autoSend.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 900) : '')); } };
const P = () => store.pool;

const JAY = { name: 'Jay Runner', school: 'Texas State', sport: 'Basketball', position: 'Guard', year: 'Junior' };
const body = (extra = '') => `<p>Hi Dana,</p><p>Jay Runner is a guard on the Texas State basketball team. ${extra}</p><p>Would you be open to a quick call?</p><p>Ann</p>`;
async function draft(id, { athlete = 'st-jay', source = 'nightly-queue', angle = 'near campus', html = body(), snap = true } = {}) {
  await P().query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, source, angle, sent_to_email, created_at)
    VALUES ($1, 'st-ann', $2, $3, 's', $4, 'draft', $5, $6, $7, NOW())`, [id, athlete, 'Biz ' + id, html, source, angle, id + '@biz.test']);
  if (snap) await ST.snapshot(P(), id, athlete);
}

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await AS.ensureTables(P());
  await P().query(`INSERT INTO users (id, name, email, password, role) VALUES
    ('st-ann', 'Ann Agent', 'ann@agents.test', 'x', 'agent'), ('st-bob', 'Bob Broker', 'bob@agents.test', 'x', 'agent')`);
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES
    ('st-jay', 'st-ann', $1::jsonb), ('st-kim', 'st-ann', $2::jsonb), ('st-bobs', 'st-bob', $3::jsonb)`,
  [JSON.stringify(JAY), JSON.stringify({ name: 'Kim Lee', school: 'Baylor', sport: 'Soccer', position: 'Forward' }), JSON.stringify({ name: 'Bo', school: 'UT', sport: 'Golf' })]);

  OUT.push('-- the facts --');
  ok('factsOf: school, sport, position, year, team only', JSON.stringify(ST.factsOf({ ...JAY, instagram: 900 })) === JSON.stringify({ school: 'Texas State', sport: 'Basketball', position: 'Guard', year: 'Junior' }));
  ok('a fact added later is not a change', ST.changes({ school: 'Texas State' }, { school: 'Texas State', position: 'Guard' }).length === 0);
  ok('capitals and punctuation are not a change', ST.changes({ school: 'Texas St.' }, { school: 'texas st' }).length === 0);
  ok('a transfer is a change, in plain words', /school changed from Texas State to Baylor/.test(ST.changes({ school: 'Texas State' }, { school: 'Baylor' })[0] || ''));

  await draft('st-good');
  await draft('st-moved');
  await draft('st-fallback', { angle: null });
  await draft('st-blank', { html: body('[Why it fits]') });
  await draft('st-other', { athlete: 'st-bobs' });
  await draft('st-thin');
  await P().query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, thin, outreach_log_id) VALUES ('st-ann', 'st-jay', 9, 'biz-thin', 'Biz st-thin', 'queued', TRUE, 'st-thin')`);
  await draft('st-old', { snap: false, html: body() });
  await draft('st-oldwrong', { snap: false, athlete: 'st-kim', html: '<p>Hi Dana,</p><p>Kim Lee plays goalkeeper on the Baylor soccer team.</p><p>Would you be open to a call?</p>' });
  await draft('st-oldkept', { snap: false, athlete: 'st-kim', html: '<p>Hi Dana,</p><p>Kim Lee plays goalkeeper on the Baylor soccer team.</p><p>Would you be open to a call?</p>' });
  // Kim was edited after st-oldwrong was written; st-oldkept is newer than the edit.
  await P().query(`UPDATE outreach_logs SET created_at = NOW() - INTERVAL '2 days' WHERE id = 'st-oldwrong'`);
  await P().query(`UPDATE athletes SET updated_at = NOW() - INTERVAL '1 day' WHERE id = 'st-kim'`);
  const snap = (await P().query(`SELECT athlete_facts FROM outreach_logs WHERE id = 'st-good'`)).rows[0].athlete_facts;
  ok('the draft keeps the facts it was written from', snap && snap.school === 'Texas State' && snap.position === 'Guard', snap);
  // Jay transfers after st-moved... and every other Jay draft was written before too,
  // so the move is applied to a copy: st-moved gets its own athlete.
  await P().query(`INSERT INTO athletes (id, agent_id, data) VALUES ('st-jay2', 'st-ann', $1::jsonb)`, [JSON.stringify(JAY)]);
  await P().query(`UPDATE outreach_logs SET athlete_id = 'st-jay2', athlete_facts = NULL WHERE id = 'st-moved'`);
  await ST.snapshot(P(), 'st-moved', 'st-jay2');
  await P().query(`UPDATE athletes SET data = data || '{"school":"Baylor"}'::jsonb WHERE id = 'st-jay2'`);

  OUT.push('-- the check --');
  const ids = ['st-good', 'st-moved', 'st-fallback', 'st-blank', 'st-other', 'st-thin', 'st-old', 'st-oldwrong', 'st-missing', 'st-oldkept'];
  const c = await ST.check(P(), 'st-ann', ids);
  const why = (id) => c.reasons.get(id) || '';
  ok('a good pitch goes', c.ok.has('st-good'), [...c.reasons]);
  ok('an old draft that still matches goes', c.ok.has('st-old'), why('st-old'));
  ok('athlete changed school: waits, says so', !c.ok.has('st-moved') && /school changed from Texas State to Baylor/.test(why('st-moved')), why('st-moved'));
  ok('fallback pitch waits', /without the pitch writer/.test(why('st-fallback')));
  ok('a leftover blank waits', /blank/.test(why('st-blank')));
  ok("another agent's athlete waits", /no longer on your roster/.test(why('st-other')));
  ok('a thin card waits', /little to go on/.test(why('st-thin')));
  ok('an old draft that no longer matches waits', /no longer matches the athlete/.test(why('st-oldwrong')), why('st-oldwrong'));
  ok('a pitch that cannot be found fails closed', /could not be found/.test(why('st-missing')));
  ok('an old draft whose athlete was not edited since is not re-read', c.ok.has('st-oldkept'), why('st-oldkept'));
  ok('only the good ones pass', c.ok.size === 3, [...c.ok]);

  OUT.push('-- auto-send --');
  const sent = [];
  const deps = {
    mailbox: async () => ({ connected: true }), senderAddress: async () => ({ ok: true }),
    buildBatch: async () => ({ batch: ids.slice(0, 8).map((id) => ({ id, athleteName: 'Jay Runner', brand: 'Biz ' + id, to: { name: 'Dana' } })) }),
    freshIds: async (x) => new Set(x.map(String)),
    approveBatch: async (agentId, x) => ({ approved: x.length, when: x.map((id) => ({ id })) }),
    statusOf: async (x) => new Map(x.map((id) => [String(id), 'sent'])),
    send: async (to, msg) => { sent.push({ to, msg }); },
    offUrl: 'https://mynildash.com/auto-send/off?t=' + 'a'.repeat(48),
  };
  await P().query(`UPDATE users SET auto_send_on = TRUE WHERE id = 'st-ann'`);
  const run = await AS.runAgent(P(), { id: 'st-ann', email: 'ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-10', deps });
  ok('only what passed was approved', run.approved === 2 && run.waiting === 6, run);
  const row = (await P().query(`SELECT detail FROM auto_send_runs WHERE agent_id = 'st-ann' AND run_date = '2026-11-10'`)).rows[0];
  ok('the run keeps what waited and why', row.detail.waiting.length === 6 && row.detail.waiting.some((w) => /Baylor/.test(w.why)));
  await AS.notes(P(), { now: new Date(), deps });
  const note = sent[0] && sent[0].msg;
  ok('the note lists what sent and what waits, with the reason', note && /sent 2 pitches/.test(note.text) && /6 pitches did not send/.test(note.text) && /Biz st-moved \(Jay Runner\): the athlete's school changed/.test(note.text), note && note.text);
  ok('the note has the one-tap off link', /Turn automatic sending off here: https:\/\/mynildash\.com\/auto-send\/off\?t=a{48}/.test(note.text) && /href="https:\/\/mynildash\.com\/auto-send\/off/.test(note.html));
  ok('the note escapes what it prints', !/<script/.test(note.html));

  // A morning where nothing passes: nothing approved, and the agent still hears why.
  sent.length = 0;
  const deps2 = { ...deps, buildBatch: async () => ({ batch: [{ id: 'st-fallback', athleteName: 'Jay Runner', brand: 'Biz st-fallback', to: null }] }),
    approveBatch: async () => { throw new Error('should not approve'); } };
  const run2 = await AS.runAgent(P(), { id: 'st-ann', email: 'ann@agents.test', name: 'Ann Agent' }, { date: '2026-11-11', deps: deps2 });
  ok('nothing passed: nothing approved', run2.approved === 0 && run2.waiting === 1, run2);
  await AS.notes(P(), { now: new Date(), deps: deps2 });
  const n2 = sent[0] && sent[0].msg;
  ok('nothing passed: the agent still gets a note saying what needs a look', n2 && /1 pitch needs a quick look/.test(n2.subject) && /Approve or edit them/.test(n2.text), n2 && n2.subject);

  OUT.push('-- off link and invite --');
  const off = AS.page('offask', { token: 'b'.repeat(48) });
  ok('the off page asks, and only the button (POST) turns it off', /method="post" action="\/auto-send\/off"/.test(off) && /Turn it off/.test(off));
  const IX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('routes: GET asks, POST turns off', /app\.get\('\/auto-send\/off', pitchActionLimiter/.test(IX) && /app\.post\('\/auto-send\/off', pitchActionLimiter/.test(IX)
    && /AS\.set\(store\.pool, u\.id, false\)/.test(IX));
  await P().query(`UPDATE users SET auto_send_on = TRUE WHERE id = 'st-bob'`);
  const url = await AS.offUrlFor(P(), 'st-bob');
  ok('offUrlFor: a link while it is on', /\/auto-send\/off\?t=[a-f0-9]{48}$/.test(url || ''), url);
  await AS.set(P(), 'st-bob', false);
  ok('offUrlFor: nothing once it is off', (await AS.offUrlFor(P(), 'st-bob')) === null);
  const inv = AS.inviteFor({ name: 'Ann Agent' }, 'https://x.test/on');
  ok('the invite says it is optional and how to say no', /completely optional/.test(inv.text) && /just ignore this email/.test(inv.text));
  ok('the invite names the last check and the script', /still right/.test(inv.text) && /pitch script/.test(inv.text));
  ok('no em dashes in the invite or the note', !/[—–]/.test(inv.text + note.text + n2.text));
  const OQ = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the nightly queue saves the facts with each draft', /require\('\.\.\/services\/stillTrue'\)\.snapshot\(pool, logId, athleteId\)/.test(OQ));

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
