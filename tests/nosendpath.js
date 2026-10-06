'use strict';
//   node tests/nosendpath.js
//
// ── A CARD CANNOT EXIST WITHOUT A WAY TO REACH SOMEONE (agent side) ─────────
// The builder wrote full emails for contacts with only a phone or a handle,
// Approve accepted them, and the release queue then had nothing to send to:
// "no address to send to", and nobody was told. Real Postgres, the real
// buildHome, approveBatch, digest queries and morning alert.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const Home = require(REPO + 'server/services/homeQueue.js');
const Closer = require(REPO + 'server/services/closer.js');
const DC = require(REPO + 'server/services/draftChannel.js');
const CHN = require(REPO + 'server/services/cardChannel.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const AG = 'nsp-agent', ATH = 'nsp-ath';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue']) await P.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
    await P.query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Jabree Test','nsp@x.com','x','agent','America/Chicago')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data,created_at) VALUES ($1,$2,$3,NOW())`, [ATH, AG, JSON.stringify({ name: 'Mataya Test', school: 'Alabama', dob: '2004-09-02' })]);
  let seq = 0;
  const draft = async (brand, to) => {
    const id = 'nsp-log-' + (++seq);
    await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,created_at)
                   VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,NOW())`, [id, AG, ATH, brand, 'Quick idea for ' + brand,
      `<p>Hi there,</p><p>${brand} is two miles from campus and Mataya trains nearby. Would you be open to a few posts this season? A short call would be great.</p>`, to]);
    return id;
  };
  const card = async (brand, slot, o) => (await P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,why,phone,instagram,email,outreach_log_id,contact_name,created_at)
     VALUES ($1,$2,$3,$4,$5,'email','queued','They sponsor local teams.',$6,$7,$8,$9,'Pat Owner',NOW()) RETURNING id`,
    [AG, ATH, slot, 'name:' + brand.toLowerCase(), brand, o.phone || null, o.instagram || null, o.email || null, o.log || null])).rows[0].id;

  const dMail = await draft('Mail Co', 'owner@mailco.test');
  const dPhone = await draft('Phone Grill', null);
  const qPhone = await card('Phone Grill', 1, { phone: '205-555-0101', log: dPhone });
  const dGram = await draft('Gram Studio', null);
  const qGram = await card('Gram Studio', 2, { instagram: 'gramstudio', log: dGram });
  const dLinked = await draft('Linked Cafe', '');
  await card('Linked Cafe', 3, { email: 'hello@linkedcafe.test', log: dLinked });
  const dGhost = await draft('Ghost Shop', null);

  // ── APPROVE REFUSES UP FRONT ──────────────────────────────────────────────
  OUT.push('-- approve refuses anything with no address, and says why --');
  const a1 = await Closer.approveBatch(P, AG, { ids: [dPhone, dGhost] });
  ok('AN EMAIL DRAFT WITH NO ADDRESS IS NOT APPROVED', a1.scheduled === 0 && a1.refused.length === 2, a1);
  ok('  the reason is said, naming the call card it becomes', /No email address for this business, so this email cannot be sent\. It is a call card now\./.test(a1.refused.find((x) => x.id === dPhone).why)
    && /no phone or Instagram/.test(a1.refused.find((x) => x.id === dGhost).why) && /no email address and were not approved/.test(a1.note), a1);
  const rowPhone = (await P.query(`SELECT status, approved_at, cadence_stop_reason FROM outreach_logs WHERE id = $1`, [dPhone])).rows[0];
  ok('  and nothing was written as approved: no row waits in the send queue to die', rowPhone.status === 'draft' && !rowPhone.approved_at, rowPhone);
  const qp = (await P.query(`SELECT channel, state, outreach_log_id FROM outreach_queue WHERE id = $1`, [qPhone])).rows[0];
  ok('PHONE ONLY: its card became a CALL card and the email draft was retired', qp.channel === 'call' && qp.state === 'queued' && qp.outreach_log_id === null
    && /call card now/.test(rowPhone.cadence_stop_reason || ''), { qp, rowPhone });
  const a2 = await Closer.approveBatch(P, AG, { ids: [dMail, dLinked] });
  ok('an addressed draft is approved as before; a draft whose card holds the address takes it first', a2.scheduled === 2 && a2.refused.length === 0
    && (await P.query(`SELECT sent_to_email FROM outreach_logs WHERE id = $1`, [dLinked])).rows[0].sent_to_email === 'hello@linkedcafe.test', a2);

  // ── HOME: CONVERTED, NOT HIDDEN ───────────────────────────────────────────
  OUT.push('', '-- Home: a call card, a DM card, never an email with nowhere to go --');
  const home = await Home.buildHome(P, AG, { athleteId: ATH });
  const byBiz = Object.fromEntries((home.cards || []).map((c) => [c.business, c]));
  ok('INSTAGRAM ONLY: a DM card with the message and the handle', byBiz['Gram Studio'] && byBiz['Gram Studio'].channel === 'dm' && byBiz['Gram Studio'].handle === 'gramstudio'
    && /two miles from campus/.test(byBiz['Gram Studio'].dmText) && !/Hi there/.test(byBiz['Gram Studio'].dmText), byBiz['Gram Studio']);
  const qg = (await P.query(`SELECT channel FROM outreach_queue WHERE id = $1`, [qGram])).rows[0];
  ok('  (its queue row is a DM card now)', qg.channel === 'dm');
  const call = byBiz['Phone Grill'];
  ok('A CALL CARD: the number, the best time, three talking points, and no email body', call && call.channel === 'call' && call.phone === '205-555-0101'
    && call.bestTime && Array.isArray(call.talkingPoints) && call.talkingPoints.length === 3 && /Jabree Test, Mataya Test's agent/.test(call.talkingPoints[0])
    && !call.body && !call.subject, call);
  ok('NO EMAIL CARD WITHOUT AN ADDRESS on the page', (home.cards || []).filter((c) => c.channel === 'email').every((c) => c.to), home.cards.map((c) => [c.business, c.channel, c.to]));
  ok('nothing to reach: no card at all', !byBiz['Ghost Shop'], Object.keys(byBiz));

  // ── THE PAGE ──────────────────────────────────────────────────────────────
  const html = require('fs').readFileSync(REPO + 'public/index.html', 'utf8');
  ok('the row button says what it does: Mark called, Mark sent, Approve', /c\.channel === 'call' \? 'Mark called' : c\.channel === 'dm' \? 'Mark sent' : 'Approve'/.test(html));
  ok('  and Approve on an email card with no address is refused on the page, with the reason', /Not approved: there is no email address for this business, so there is nothing to send it to\./.test(html)
    && /c\.channel === 'email' && c\.to/.test(html));

  // ── THE DIGEST: NO APPROVE BUTTON ON SOMETHING THAT CANNOT SEND ──────────
  OUT.push('', '-- the digest email and its one-tap buttons --');
  const dLate = await draft('Late Diner', null);
  const T = require(REPO + 'server/services/pitchActionTokens.js');
  const pend = await T.pendingForAthlete(P, AG, ATH);
  ok('one-tap Approve all never includes a draft with no address', !pend.some((p) => p.id === dLate), pend.map((p) => p.brand_name));
  const ND = require(REPO + 'server/services/nightlyDigest.js');
  if (typeof ND.pitchesFor === 'function') {
    const pf = await ND.pitchesFor(P, AG, {});
    const all = JSON.stringify(pf);
    ok('  and the digest lists no draft with no address', !/Late Diner/.test(all), all.slice(0, 300));
  }
  const one = await Closer.approveBatch(P, AG, { ids: [dLate] });
  ok('  a one-tap Approve on one anyway is refused with the sentence, not accepted', one.scheduled === 0 && /cannot be sent/.test(one.note + one.refused[0].why), one);

  // ── THE MORNING ALERT STOPS RE-REPORTING THE DEAD ─────────────────────────
  OUT.push('', '-- the morning alert --');
  await P.query(`INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,approved_at,scheduled_send_at,cadence_stopped_at,cadence_stop_reason,created_at)
                 VALUES ('nsp-dead-1',$1,$2,'Old Dead','x','x','approved',NOW() - INTERVAL '13 days',NOW() - INTERVAL '13 days',NOW() - INTERVAL '12 days','no address to send to',NOW() - INTERVAL '13 days')`, [AG, ATH]);
  const MA = require(REPO + 'server/services/morningAlert.js');
  const fn = MA.gather || MA.collect || MA.build || MA.report;
  if (fn) {
    const r = await fn(P).catch((e) => ({ error: e.message }));
    const why = JSON.stringify((r.overdueSends || {}).reasons || []);
    ok('a stopped approved row is not "approved, not sent" every morning forever', !r.error && !/no address to send to/.test(why), { why, err: r.error });
  } else ok('the alert query skips stopped rows', /AND cadence_stopped_at IS NULL/.test(require('fs').readFileSync(REPO + 'server/services/morningAlert.js', 'utf8')));

  ok('cardChannel: an email wins; a phone alone is a call; a handle alone is a DM; nothing is no card',
    CHN.channelOf({ email: 'a@b.co', phone: '205 555 0101' }) === 'email' && CHN.channelOf({ phone: '205 555 0101' }) === 'call'
    && CHN.channelOf({ instagram: '@abc' }) === 'dm' && CHN.channelOf({}) === null && CHN.channelOf({ email: 'not-an-email' }) === null);
  await clean();
}

main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
