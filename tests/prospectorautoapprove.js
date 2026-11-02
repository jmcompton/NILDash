'use strict';
// ── PROSPECTOR: DRAFTS THAT APPROVE THEMSELVES (PROSPECTOR_AUTOAPPROVE_ON) ──
// Local Postgres; the mailbox is a stand-in.
//
//   - off: drafts wait for JohnMark, nothing is sent;
//   - on: one draft at a time, oldest first, only when nothing is queued;
//   - a draft is refused for a bad address, an empty or long subject, a body
//     too short or too long, no greeting, leftover placeholder text, the
//     suppression list, a paying customer, or a company already emailed;
//   - a refused draft is marked with why and left for JohnMark, never retried.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('prospectorautoapprovetest', { schema: true });
require('./helpers/offlineDns').install();
delete process.env.PROSPECTOR_AUTOSEND_ON;
delete process.env.PROSPECTOR_AUTOAPPROVE_ON;
process.env.PROSPECTOR_OUTREACH_ON = 'true';
process.env.PROSPECTOR_FROM_ADDRESS = 'john@salesbox.test';
process.env.BUSINESS_MAILING_ADDRESS = '3796 Turnberry Court, Duluth, GA 30096';

const store = require(REPO + 'server/store.js');
const O = require(REPO + 'server/services/prospector/outreach.js');
const sup = require(REPO + 'server/services/suppression.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const P = () => store.pool;
const T0 = new Date('2026-11-03T16:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60000);

const sent = [];
const deps = {
  mail: { sendNew: async (mb, m) => { sent.push(m); return { messageId: 'm' + sent.length, conversationId: 'c' + sent.length }; },
    reply: async () => ({}), findSent: async () => null, inboxSince: async () => [], ensureFolder: async () => 'f', move: async () => ({}) },
  account: async (addr) => ({ ok: true, address: addr, accountId: 1, canSend: true, canRead: true, canMove: true }),
  alert: async () => {},
};
const GOOD = (first) => `Hi ${first},\n\nI run a small software company. We built a tool that checks the public email records of local businesses and flags the ones anyone could impersonate.\n\nThree near you:\nA Dental (dental office, Hoover): no DMARC record\n\nWant the list?\n\nJohnMark Compton\nCompton Group`;
const row = async (email) => (await P().query(`SELECT * FROM prospector_outreach WHERE email = $1`, [email])).rows[0];

async function main() {
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));
  await O.ensureTables(P());
  await sup.suppress(P(), 'gone@bounced.test', { reason: 'hard bounce' });
  await P().query(`CREATE TABLE IF NOT EXISTS prospector_customers (id SERIAL PRIMARY KEY, email TEXT)`);
  const S = '3 businesses near you with an email gap';
  await O.importRows(P(), [
    { email: 'amy@one.test', first: 'Amy', subject: S, body: GOOD('Amy') },
    { email: 'bo@two.test', first: 'Bo', subject: S, body: GOOD('Bo') },
    { email: 'short@three.test', subject: S, body: 'Hi Cy,\n\nToo short.' },
    { email: 'ph@four.test', subject: S, body: GOOD('{{first}}') },
    { email: 'nogreet@five.test', subject: S, body: GOOD('Dee').replace(/^Hi Dee,/, 'Dee -') },
    { email: 'later@paying.test', subject: S, body: GOOD('Ed') },
    { email: 'ok@six.test', first: 'Flo', subject: S, body: GOOD('Flo') },
  ]);
  // Became a customer, and was suppressed, after the import.
  await P().query(`INSERT INTO prospector_customers (email) VALUES ('billing@paying.test')`);
  await O.importRows(P(), [{ email: 'gone@bounced.test', subject: S, body: GOOD('Gus') }]);
  ok('all good drafts imported as drafts', (await P().query(`SELECT COUNT(*)::int AS n FROM prospector_outreach WHERE state = 'draft'`)).rows[0].n === 7);

  OUT.push('-- off --');
  const t0 = await O.sendTick(P(), { now: T0, deps });
  ok('off: drafts wait, nothing is sent', sent.length === 0 && (await row('amy@one.test')).state === 'draft', t0);

  OUT.push('-- on --');
  process.env.PROSPECTOR_AUTOAPPROVE_ON = 'true';
  await O.sendTick(P(), { now: T0, deps });
  ok('on: the oldest draft approves itself and goes', sent.length === 1 && sent[0].to === 'amy@one.test' && (await row('amy@one.test')).state === 'active');
  ok('  only one at a time: the next waits as a draft', (await row('bo@two.test')).state === 'draft');
  const ev = (await P().query(`SELECT detail FROM prospector_outreach_events WHERE kind = 'approved' AND outreach_id = $1`, [(await row('amy@one.test')).id])).rows[0];
  ok('  the approval says why', ev && /PROSPECTOR_AUTOAPPROVE_ON/.test(ev.detail), ev);
  await O.sendTick(P(), { now: at(5), deps });
  ok('the next tick: the next one', sent.length === 2 && sent[1].to === 'bo@two.test');
  await O.sendTick(P(), { now: at(10), deps });
  ok('bad drafts are skipped on the way to a good one', sent.length === 3 && sent[2].to === 'ok@six.test', sent.map((s) => s.to));
  const why = async (e) => (await row(e)).last_error || '';
  ok('too short: refused, with why', (await row('short@three.test')).state === 'draft' && /auto-approve: the body is \d+ characters/.test(await why('short@three.test')));
  ok('leftover placeholder text: refused', /auto-approve: leftover placeholder text/.test(await why('ph@four.test')));
  ok('no greeting: refused', /auto-approve: the email does not open with a greeting/.test(await why('nogreet@five.test')));
  ok('became a customer: refused', /auto-approve: already a customer/.test(await why('later@paying.test')), await why('later@paying.test'));
  await O.sendTick(P(), { now: at(15), deps });
  ok('nothing good left: nothing more sent, and refused drafts are not retried', sent.length === 3
    && (await P().query(`SELECT COUNT(*)::int AS n FROM prospector_outreach_events WHERE kind = 'auto-skipped'`)).rows[0].n === 4);
  ok('the suppressed address was never even imported', !(await row('gone@bounced.test')));
  const one = { id: -1, email: 'x@seven.test', subject: S, body: GOOD('Hal') };
  await P().query(`INSERT INTO prospector_outreach (email, domain, subject, body, state) VALUES ('y@one.test', 'one.test', 'S', 'B', 'draft')`);
  ok('someone at a company already emailed: refused', /already emailed/.test(await O.autoCheck(P(), { id: (await row('y@one.test')).id, email: 'y@one.test', subject: S, body: GOOD('Ivy') })));
  ok('a long subject: refused', /subject/.test(await O.autoCheck(P(), { ...one, subject: 'x'.repeat(130) })));
  ok('a clean draft: passes', (await O.autoCheck(P(), one)) === null);

  console.log(OUT.join('\n'));
  const total = OUT.filter((l) => /^(PASS|FAIL) /.test(l)).length;
  console.log(`\n${total - F}/${total} passed`);
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
