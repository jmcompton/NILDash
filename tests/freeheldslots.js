'use strict';
// Needs the test Postgres.
//
//   node tests/freeheldslots.js
//
// ── FREE THE SLOTS HELD BY CARDS THAT CAN NEVER COUNT ───────────────────────
// services/freeHeldSlots, the one-time script for EMAIL_FIVE_ON: every queued
// DM, call and unverified email card is retired so the five open for verified
// emails. A card the agent approved, sent or marked done, or anything with a
// reply, is never touched. Dry run unless apply. And going forward, under
// EMAIL_FIVE_ON, those cards no longer hold a slot at all (openSlotsFor).
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

const store = require(REPO + 'server/store.js');
const FH = require(REPO + 'server/services/freeHeldSlots.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const job = require(REPO + 'server/jobs/outreachQueue.js');

let F = 0, N = 0;
const ok = (c, m, d) => { N++; console.log((c ? 'PASS ' : 'FAIL ') + m + (c || d === undefined ? '' : '   ' + JSON.stringify(d).slice(0, 900))); if (!c) F++; };
const AA = 'fh-agent-a', AB = 'fh-agent-b';

(async () => {
  console.log('the slot rule, going forward');
  {
    const dm = (s) => ({ slot: s, state: 'queued', channel: 'dm', email_verified: false });
    const ver = (s) => ({ slot: s, state: 'queued', channel: 'email', email_verified: true });
    const five = [1, 2, 3, 4, 5].map(dm);
    ok(Q.slotsToFill(five).length === 0, 'without the option, five held DM cards leave nothing open (the old rule, unchanged)');
    ok(String(Q.slotsToFill(five, { holds: job.holdsUnderFive })) === '6,7,8,9,10', '  with it, five DM cards hold nothing: five open, numbered past the ones taken', Q.slotsToFill(five, { holds: job.holdsUnderFive }));
    const mixed = [ver(1), dm(2), ver(3), dm(4), { slot: 5, state: 'queued', channel: 'email', email_verified: false }];
    ok(String(Q.slotsToFill(mixed, { holds: job.holdsUnderFive })) === '6,7,8', '  two verified emails among them: three open', Q.slotsToFill(mixed, { holds: job.holdsUnderFive }));
    ok(String(Q.slotsToFill([ver(1), dm(2), ver(4)], { holds: job.holdsUnderFive })) === '3,5,6', '  a gap is used before a number past five', Q.slotsToFill([ver(1), dm(2), ver(4)], { holds: job.holdsUnderFive }));
    ok(Q.slotsToFill([1, 2, 3, 4, 5].map(ver), { holds: job.holdsUnderFive }).length === 0, '  five verified emails: full');
    ok(job.holdsUnderFive({ channel: 'program', email_verified: false }) === false && job.holdsUnderFive({ channel: 'call' }) === false
      && job.holdsUnderFive({ channel: 'email', email_verified: true }) === true, '  only a verified email card holds (a program card does not either)');
    delete process.env.EMAIL_FIVE_ON;
    ok(job.openSlotsFor(five).length === 0, 'openSlotsFor, EMAIL_FIVE_ON off: as before');
    process.env.EMAIL_FIVE_ON = '1';
    ok(job.openSlotsFor(five).length === 5, '  on: DM, call and unverified cards no longer hold a slot');
    delete process.env.EMAIL_FIVE_ON;
  }

  console.log('\none card, one decision');
  {
    const base = { state: 'queued', channel: 'dm' };
    const C = (x) => FH.classify({ ...base, ...x });
    ok(C({}).action === 'retire' && C({ channel: 'call' }).action === 'retire', 'a queued DM card and a queued call card: retired');
    ok(C({ channel: 'email', email: 'info@shop.com' }).action === 'retire', 'an email card with no verified named address: retired');
    ok(/desk or role/.test(C({ channel: 'email', email: 'info@shop.com' }).why) && /no address/.test(C({ channel: 'email' }).why)
      && /never verified/.test(C({ channel: 'email', email: 'dana@shop.com' }).why), '  and says why: a desk address, no address, never verified');
    ok(C({ channel: 'email', email_verified: true }).action === 'keep' && C({ channel: 'email', email_verified: true, email_label: 'General inbox' }).why === 'verified General inbox card', 'a verified email card, named or the General inbox one: kept');
    ok(C({ channel: 'email', email_verified: false, email: 'dana.reed@shop.com', contact_name: 'Dana Reed', verify_result: 'valid' }).backfill === true,
      'an older email card whose address is valid and carries the name: kept, and flagged verified on apply');
    ok(C({ channel: 'email', email: 'dana.reed@shop.com', contact_name: 'Sam Holt', verify_result: 'valid' }).action === 'retire', '  valid, but not the named person\'s address: retired');
    for (const [x, why] of [[{ sent_at: new Date() }, 'sent'], [{ sent_via: 'dm' }, 'sent'], [{ outcome: 'no_reply' }, 'marked done (no_reply)'],
      [{ replied_at: new Date() }, 'has a reply'], [{ log_replied_at: new Date(), log_id: 'x', log_status: 'draft' }, 'has a reply'],
      [{ brand_replied: true }, 'has a reply'], [{ card_replied: true }, 'has a reply'],
      [{ log_id: 'x', log_status: 'draft', log_approved_at: new Date() }, 'the agent approved its email'],
      [{ log_id: 'x', log_status: 'approved' }, 'the agent approved its email'],
      [{ log_id: 'x', log_status: 'draft', log_edited: true }, 'the agent edited its email']]) {
      ok(C(x).action === 'keep' && C(x).why === why, `never touched: ${why} (${Object.keys(x).join(', ')})`, C(x));
    }
    ok(C({ channel: 'program' }).action === 'keep', 'a program card: kept (not a DM, call or email card)');
    ok(C({ state: 'sent' }).action === 'keep', 'anything not queued: kept');
  }

  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM outreach_queue WHERE agent_id IN ($1,$2)`, [AA, AB]);
    await P.query(`DELETE FROM outreach_logs WHERE agent_id IN ($1,$2)`, [AA, AB]);
    await P.query(`DELETE FROM athletes WHERE agent_id IN ($1,$2)`, [AA, AB]);
    await P.query(`DELETE FROM users WHERE id IN ($1,$2)`, [AA, AB]);
    await P.query(`DELETE FROM email_verification WHERE email LIKE '%@fh-%'`);
  };
  await clean();
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Ava Agent','fh-a@x.test','x','agent'), ($2,'Ben Agent','fh-b@x.test','x','agent')`, [AA, AB]);
  for (const [id, ag, name] of [['fh-a1', AA, 'Ari One'], ['fh-a2', AA, 'Bo Two'], ['fh-b1', AB, 'Cy Three']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [id, ag, JSON.stringify({ name })]);
  }
  const ids = {};
  const card = async (key, ag, ath, slot, ch, x = {}) => {
    const r = await P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, email, email_verified, email_label,
        contact_name, sent_at, sent_via, outcome, replied_at, outreach_log_id)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [ag, ath, slot, x.brand || `FH ${key}`, ch, x.state || 'queued', x.email || null, x.verified === true, x.label || null,
        x.contact || 'Dana Reed', x.sent_at || null, x.sent_via || null, x.outcome || null, x.replied_at || null, x.log || null]);
    ids[key] = r.rows[0].id;
  };
  const log = async (id, ag, ath, brand, x = {}) => P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, approved_at, replied_at, edited_before_approval, sent_to_email)
      VALUES ($1,$2,$3,$4,'Hi','<p>Hi Dana</p>',$5,$6,$7,$8,$9)`, [id, ag, ath, brand, x.status || 'draft', x.approved_at || null, x.replied_at || null, x.edited === true, x.to || null]);

  // Ari One: five cards, the five slots held.
  await card('a1-dm', AA, 'fh-a1', 1, 'dm');
  await card('a1-call', AA, 'fh-a1', 2, 'call');
  await log('fh-log-info', AA, 'fh-a1', 'FH a1-info', { to: 'info@fh-shop.com' });
  await card('a1-info', AA, 'fh-a1', 3, 'email', { email: 'info@fh-shop.com', log: 'fh-log-info' });
  await card('a1-ver', AA, 'fh-a1', 4, 'email', { email: 'dana@fh-ver.com', verified: true });
  await P.query(`INSERT INTO email_verification (email, result, source) VALUES ('dana.reed@fh-old.com', 'valid', 'hunter') ON CONFLICT (email) DO UPDATE SET result = 'valid'`);
  await card('a1-old', AA, 'fh-a1', 5, 'email', { email: 'dana.reed@fh-old.com' });
  // Bo Two: everything the agent has touched, and a program card.
  await card('a2-replied', AA, 'fh-a2', 1, 'dm', { replied_at: new Date() });
  await card('a2-done', AA, 'fh-a2', 2, 'call', { outcome: 'no_reply' });
  await log('fh-log-appr', AA, 'fh-a2', 'FH a2-appr', { status: 'approved', approved_at: new Date() });
  await card('a2-appr', AA, 'fh-a2', 3, 'email', { email: 'x@fh-appr.com', log: 'fh-log-appr' });
  await log('fh-log-edit', AA, 'fh-a2', 'FH a2-edit', { edited: true });
  await card('a2-edit', AA, 'fh-a2', 4, 'email', { email: 'x@fh-edit.com', log: 'fh-log-edit' });
  await log('fh-log-brandreply', AA, 'fh-a2', 'FH Brand Replied', { status: 'replied', replied_at: new Date() });
  await card('a2-brand', AA, 'fh-a2', 5, 'dm', { brand: 'FH Brand Replied' });
  await card('a2-prog', AA, 'fh-a2', 6, 'program');
  await card('a2-sentvia', AA, 'fh-a2', 7, 'dm', { sent_via: 'dm' });
  await card('a2-wassent', AA, 'fh-a2', 1, 'dm', { state: 'sent', sent_at: new Date(), sent_via: 'dm' });
  await card('a2-free', AA, 'fh-a2', 8, 'call');
  // Cy Three, another agent.
  await card('b1-dm', AB, 'fh-b1', 1, 'dm');
  await card('b1-gi', AB, 'fh-b1', 2, 'email', { email: 'info@fh-tiny.com', verified: true, label: 'General inbox' });
  await card('b1-noaddr', AB, 'fh-b1', 3, 'email');

  const RETIRE = ['a1-dm', 'a1-call', 'a1-info', 'a2-free', 'b1-dm', 'b1-noaddr'];
  const snap = async () => (await P.query(`SELECT id, state, outcome, email_verified, updated_at FROM outreach_queue WHERE agent_id IN ($1,$2) ORDER BY id`, [AA, AB])).rows
    .concat((await P.query(`SELECT id, status, cadence_stopped_at, updated_at FROM outreach_logs WHERE agent_id IN ($1,$2) ORDER BY id`, [AA, AB])).rows);
  const mine = (r) => ({ ...r, agents: r.agents.filter((a) => a.agentId === AA || a.agentId === AB), cards: r.cards.filter((c) => c.agent_id === AA || c.agent_id === AB) });

  console.log('\nthe dry run');
  const before = JSON.stringify(await snap());
  const dry = mine(await FH.run(P, {}));
  ok(JSON.stringify(await snap()) === before, 'a dry run changes nothing: no card, no draft, no flag');
  const would = dry.cards.filter((c) => c.decision.action === 'retire').map((c) => Object.keys(ids).find((k) => ids[k] === c.id)).sort();
  ok(JSON.stringify(would) === JSON.stringify(RETIRE.slice().sort()), 'it would retire exactly the DM, call and unverified email cards nobody has touched', would);
  ok(!dry.cards.some((c) => c.id === ids['a2-wassent']), '  a card already sent is not even read');
  const text = FH.format(dry);
  ok(/^FREE HELD SLOTS: DRY RUN \(nothing changed; add &apply=1 to retire\)/.test(text), 'the printout says it is a dry run', text.slice(0, 200));
  ok(/Ava Agent <fh-a@x\.test>: retire 4, keep 9/.test(text) && /Ben Agent <fh-b@x\.test>: retire 2, keep 1/.test(text), '  counts per agent', text);
  ok(/\n  Ari One: retire 3 \(DM 1, call 1, unverified email 1\); keep 2 \(verified email 2\); verified after 2, open tonight 3\n/.test(text),
    '  per athlete: retired, kept and why, and what opens tonight', text.split('\n').filter((l) => /Ari One/.test(l)));
  ok(/\n  Bo Two: retire 1 \(call 1\); keep 7 \(reply 2, marked done 1, approved 1, edited 1, program 1, sent 1\); verified after 0, open tonight 5\n/.test(text),
    '  every reason a card is kept, counted', text.split('\n').filter((l) => /Bo Two/.test(l)));
  ok(/\n  Cy Three: retire 2 \(DM 1, unverified email 1\); keep 1 \(General inbox 1\); verified after 1, open tonight 4\n/.test(text),
    '  the General inbox card is kept and counts', text.split('\n').filter((l) => /Cy Three/.test(l)));
  ok(/WOULD RETIRE: 6\n {6}2  DM card\n {6}2  call card\n {6}1  email card, not a verified named-person address: (a desk or role address|no address)\n/.test(text)
    && /KEPT: 10\n {6}2  has a reply\n/.test(text), '  the totals, one reason a line', text.slice(0, 900));
  ok(/KEPT FOR A REASON OTHER THAN A VERIFIED EMAIL/.test(text) && new RegExp(`#${ids['a2-appr']} Ava Agent / Bo Two / FH a2-appr \\(email\\): the agent approved its email`).test(text),
    '  and each card kept for another reason is listed');
  ok(/1  verified named-person email, placed before the flag existed \(flagged on apply\)/.test(text), '  the older verified card is named as such');

  console.log('\napply');
  // The agent works a card between the read and the write: it is not retired.
  const racing = { query: (...a) => P.query(...a), connect: async () => { await P.query(`UPDATE outreach_queue SET replied_at = NOW() WHERE id = $1`, [ids['a2-free']]); return P.connect(); } };
  const app = mine(await FH.run(racing, { apply: true }));
  const rows = new Map((await P.query(`SELECT id, state, outcome, email_verified FROM outreach_queue WHERE agent_id IN ($1,$2)`, [AA, AB])).rows.map((r) => [r.id, r]));
  const retired = Object.keys(ids).filter((k) => rows.get(ids[k]).state === 'retired').sort();
  ok(JSON.stringify(retired) === JSON.stringify(RETIRE.filter((k) => k !== 'a2-free').sort()), 'apply retires exactly those cards', retired);
  ok(retired.every((k) => rows.get(ids[k]).outcome === FH.OUTCOME), `  each with outcome ${FH.OUTCOME}`);
  ok(rows.get(ids['a2-free']).state === 'queued' && app.raced >= 1, 'a card the agent acted on after the read is not retired (the guards are in the UPDATE too)', { state: rows.get(ids['a2-free']).state, raced: app.raced });
  const untouched = ['a1-ver', 'a2-replied', 'a2-done', 'a2-appr', 'a2-edit', 'a2-brand', 'a2-prog', 'a2-sentvia', 'b1-gi'];
  ok(untouched.every((k) => rows.get(ids[k]).state === 'queued'), 'approved, sent, done, replied, edited, verified and program cards: all still queued', untouched.filter((k) => rows.get(ids[k]).state !== 'queued'));
  ok(rows.get(ids['a2-wassent']).state === 'sent', '  and the sent card is still sent');
  ok(rows.get(ids['a1-old']).state === 'queued' && rows.get(ids['a1-old']).email_verified === true && app.flagged === 1, 'the older verified named card is kept and flagged verified, so it holds its slot', { row: rows.get(ids['a1-old']), flagged: app.flagged });
  const logs = new Map((await P.query(`SELECT id, status, cadence_stopped_at, cadence_stop_reason FROM outreach_logs WHERE agent_id = $1`, [AA])).rows.map((r) => [r.id, r]));
  ok(logs.get('fh-log-info').cadence_stopped_at && logs.get('fh-log-info').cadence_stop_reason === FH.STOP_REASON && app.draftsStopped === 1, 'the retired email card\'s draft is stopped with it (it leaves the page)', logs.get('fh-log-info'));
  ok(!logs.get('fh-log-appr').cadence_stopped_at && !logs.get('fh-log-edit').cadence_stopped_at && logs.get('fh-log-appr').status === 'approved', '  an approved or edited draft is not touched');
  const atext = FH.format(app);
  ok(/^FREE HELD SLOTS: APPLIED/.test(atext) && /RETIRED: 5\n/.test(atext) && /older verified named cards flagged verified: 1/.test(atext) && /not retired, because the agent acted on them since the read: 1/.test(atext), 'the printout says what was done', atext.slice(0, 600));
  const again = mine(await FH.run(P, { apply: true }));
  ok(again.retired === 0 && again.cards.filter((c) => c.decision.action === 'retire').length === 0, 'a second apply finds nothing to retire');

  console.log('\none agent only');
  await card('b1-dm2', AB, 'fh-b1', 4, 'dm');
  await card('a1-dm2', AA, 'fh-a1', 6, 'dm');
  const one = await FH.run(P, { apply: true, agentId: AB });
  const st = async (k) => (await P.query(`SELECT state FROM outreach_queue WHERE id = $1`, [ids[k]])).rows[0].state;
  ok(one.retired === 1 && (await st('b1-dm2')) === 'retired' && (await st('a1-dm2')) === 'queued', 'agent= touches that agent\'s cards only');

  console.log('\nthe admin script');
  const AS = require(REPO + 'server/services/adminScripts.js');
  const def = AS.registry()['free-held-slots'];
  ok(def && def.file === 'scripts/free-held-slots.js' && require('fs').existsSync(REPO + def.file), 'free-held-slots is registered and its script exists');
  ok(JSON.stringify(def.args({})) === '[]' && JSON.stringify(def.args({ apply: '1' })) === '["--apply"]' && JSON.stringify(def.args({ apply: 'yes' })) === '[]',
    '  dry run unless apply=1 exactly');
  ok(JSON.stringify(def.args({ agent: 'a@b.com; rm -rf' })) === '["--agent","a@b.comrm-rf"]', '  agent= is stripped to an email or id');

  await clean();
  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('THREW', e.stack); process.exit(1); });
