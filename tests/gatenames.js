'use strict';
// ── THE SEND GATE'S NAME CHECK: NICKNAMES, INITIALS, SHORT FORMS ────────────
//
// stop-unverified stopped real owners' mailboxes on production because the
// gate only knew "the address contains the first or last name":
//   rob@drrobertshire.com (Robert Shire), jj@ripple-retreat.com (JJ Holley),
//   dj@ostromservices.com (D.J. Ostrom), s@victoryma.com (Ralph S.).
// services/nameMatch now knows initials, first initial + last, first + last
// initial and a nickname table; a single letter is a name only as the first
// initial on the person's own small business. A match still needs a valid
// verification in the last 30 days, and shared inboxes stay blocked.
// Then admin script restore-false-stops, on a fresh database, through the real
// blockAndOffer that stopped them.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('gatenamestest', { schema: true });
process.env.TZ = process.env.TZ || 'America/Chicago';
delete process.env.SEND_GATE_ON;
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
require('./helpers/offlineDns').install();
const { execSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const NM = require(REPO + 'server/services/nameMatch');
const SG = require(REPO + 'server/services/sendGate');

let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const yes = (e, n, ctx) => NM.match(e, n, ctx || {}).ok;
const howOf = (e, n, ctx) => NM.match(e, n, ctx || {}).how;
const VICTORY = { brand: 'Victory Martial Arts', title: 'Owner', lane: 'local' };

(async () => {
  console.log('\n1. THE FOUR PRODUCTION ADDRESSES');
  ok('rob@drrobertshire.com is Robert Shire\'s (a nickname)', yes('rob@drrobertshire.com', 'Robert Shire') && howOf('rob@drrobertshire.com', 'Robert Shire') === 'nickname');
  ok('jj@ripple-retreat.com is JJ Holley\'s (their first name)', yes('jj@ripple-retreat.com', 'JJ Holley'));
  ok('dj@ostromservices.com is D.J. Ostrom\'s (their initials as a first name)', yes('dj@ostromservices.com', 'D.J. Ostrom'));
  ok('s@victoryma.com is NOT Ralph S.\'s: s is not his first initial', !yes('s@victoryma.com', 'Ralph S.') && /not Ralph S\.'s first initial/.test(NM.match('s@victoryma.com', 'Ralph S.').why));
  ok('  not even on his own small business', !yes('s@victoryma.com', 'Ralph S.', VICTORY));

  console.log('\n2. EVERY FORM OF A NAME');
  const R = 'Robert Shire';
  for (const [e, how] of [['robert@x.com', 'first name'], ['shire@x.com', 'last name'], ['rs@x.com', 'initials'],
    ['rshire@x.com', 'first initial and last name'], ['roberts@x.com', 'first name and last initial'],
    ['rob@x.com', 'nickname'], ['bob@x.com', 'nickname'], ['bobby@x.com', 'nickname'], ['bobshire@x.com', 'nickname and last name'], ['bobs@x.com', 'nickname and last initial']]) {
    ok(`  ${e} for ${R}: ${how}`, howOf(e, R) === how, NM.match(e, R));
  }
  ok('  separators, a +tag and digits are ignored (r.shire, rob+nil, rshire1)', yes('r.shire@x.com', R) && yes('rob+nil@x.com', R) && yes('rshire1@x.com', R) && yes('Rob.Shire@X.com', R));
  ok('  the old rule still holds: the first or last name inside it (robert.shire, drshire)', yes('robert.shire@x.com', R) && yes('drshire@x.com', R));
  ok('  every word\'s initials with a middle name (rjs for Robert J. Shire)', howOf('rjs@x.com', 'Robert J. Shire') === 'initials');
  ok('  honorifics are not part of the name (Dr. Robert Shire: rs)', howOf('rs@x.com', 'Dr. Robert Shire') === 'initials');
  ok('  initials as a first name with the last initial (djo for D.J. Ostrom), and d.ostrom', yes('djo@x.com', 'D.J. Ostrom') && yes('d.ostrom@x.com', 'D.J. Ostrom'));
  console.log('\n   the nickname table');
  for (const [full, nicks] of [['William Hart', ['will', 'bill', 'billy']], ['Michael Lee', ['mike', 'mikey']], ['James Cole', ['jim', 'jimmy', 'jamie']],
    ['Elizabeth Park', ['liz', 'beth', 'betsy']], ['Katherine Moss', ['kate', 'katie']], ['Richard Fox', ['rick', 'rich', 'dick']], ['Anthony Gale', ['tony']]]) {
    ok(`  ${full}: ${nicks.join(', ')}`, nicks.every((n) => howOf(`${n}@x.com`, full) === 'nickname'), nicks.map((n) => NM.match(`${n}@x.com`, full)));
  }
  ok('  the other way: a card that says Bob, addressed robert@', howOf('robert@x.com', 'Bob Shire') === 'nickname');
  ok('  two short forms of one name do not match each other (Bert is not bob@)', !yes('bob@x.com', 'Bert Shire'));
  ok('  someone else\'s name is not a match (tom@, ab@, mike@ for Robert Shire)', !yes('tom@x.com', R) && !yes('ab@x.com', R) && !yes('mike@x.com', R));
  ok('  the old rule\'s refusal still stands: circleheart@ for Jamie Smith', !yes('circleheart@myyahoo.com', 'Jamie Smith'));
  ok('  a family table, not a guess: every line is a full name and its short forms', NM.FAMILIES.length >= 100 && NM.FAMILIES.every((f) => f.length >= 2 && f.every((n) => /^[a-z]+$/.test(n))));

  console.log('\n3. A SINGLE LETTER');
  ok('r@victoryma.com for Ralph S., owner of Victory Martial Arts, a local business: his first initial on his own small business',
    howOf('r@victoryma.com', 'Ralph S.', VICTORY) === 'first initial, on their own small business', NM.match('r@victoryma.com', 'Ralph S.', VICTORY));
  for (const [what, e, ctx, re] of [
    ['no title on the card', 'r@victoryma.com', { brand: 'Victory Martial Arts', lane: 'local' }, /does not say they own/],
    ['a title that is not the owner (Instructor)', 'r@victoryma.com', { ...VICTORY, title: 'Instructor' }, /does not say they own/],
    ['a national brand, not a local business', 'r@victoryma.com', { ...VICTORY, lane: 'national', sizeBand: 'national' }, /not on the card as a local business/],
    ['nothing on the card says how big it is', 'r@victoryma.com', { brand: 'Victory Martial Arts', title: 'Owner' }, /not on the card as a local business/],
    ['a personal mailbox (gmail)', 'r@gmail.com', VICTORY, /personal mailbox/],
    ['a domain that is not the business on the card', 'r@ostromservices.com', VICTORY, /could not be matched/],
    ['no business on the card', 'r@victoryma.com', { title: 'Owner', lane: 'local' }, /no business on the card/],
    ['a chain\'s corporate domain', 'r@dominos.com', { brand: "Domino's Pizza", title: 'Owner', lane: 'local' }, /chain|corporate|could not be matched/],
  ]) ok(`  blocked: ${what}`, !yes(e, 'Ralph S.', ctx) && re.test(NM.match(e, 'Ralph S.', ctx).why), NM.match(e, 'Ralph S.', ctx));
  ok('  a hometown business counts as local, and so does a small one', yes('r@victoryma.com', 'Ralph S.', { ...VICTORY, lane: 'hometown' }) && yes('r@victoryma.com', 'Ralph S.', { brand: VICTORY.brand, title: 'Founder', sizeBand: 'small' }));

  console.log('\n4. THE GATE: SHARED INBOXES STAY BLOCKED, A MATCH STILL NEEDS A VALID CHECK');
  for (const e of ['info@drrobertshire.com', 'contact@drrobertshire.com', 'hello@drrobertshire.com', 'sales@drrobertshire.com'])
    ok(`  ${e} for Robert Shire: a shared inbox`, (SG.addressProblem(e, 'Robert Shire') || {}).code === 'shared', SG.addressProblem(e, 'Robert Shire'));
  ok('  legal@ stays a department inbox, never emailed', (SG.addressProblem('legal@drrobertshire.com', 'Robert Shire') || {}).code === 'forbidden');
  ok('  the name rule\'s refusal is still "not-theirs", now saying why', (SG.addressProblem('s@victoryma.com', 'Ralph S.') || {}).code === 'not-theirs'
    && /single letter/.test(SG.addressProblem('s@victoryma.com', 'Ralph S.').why));
  ok('  a card with no person is still refused first (no-person)', (SG.addressProblem('rob@drrobertshire.com', 'Owner') || {}).code === 'no-person');

  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const AG = 'gn-agent', ATH = 'gn-ath';
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz) VALUES ($1,'Gina Agent','gn@agency.test','x','agent','America/Chicago')`, [AG]);
  await P.query(`UPDATE users SET business_street='1 Test St', business_city='Testville', business_state='AL', business_zip='35201' WHERE id=$1`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`, [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-09-02' })]);
  const verified = (email, result, ageDays, status) => P.query(
    `INSERT INTO email_verification (email, result, detail, source, status, checked_at) VALUES ($1,$2,'seeded','hunter',$3, NOW() - make_interval(days => $4))
     ON CONFLICT (email) DO UPDATE SET result=EXCLUDED.result, status=EXCLUDED.status, checked_at=EXCLUDED.checked_at`,
    [email, result, status || (result === 'valid' ? 'valid' : 'unknown'), ageDays]);
  const calls = [];
  const deps = (answers) => ({ verifier: async (email) => { calls.push(email); return answers[email] || { status: 'unknown' }; } });

  await verified('rob@drrobertshire.com', 'valid', 10);
  const g1 = await SG.check(P, { email: 'rob@drrobertshire.com', contactName: 'Robert Shire', business: 'Dr. Robert Shire DDS' }, deps({}));
  ok('rob@ with a valid check 10 days ago: passes, no credit spent', g1.ok && !g1.reverified && !calls.length, g1);
  await verified('jj@ripple-retreat.com', 'valid', 45);
  const g2 = await SG.check(P, { email: 'jj@ripple-retreat.com', contactName: 'JJ Holley' }, deps({ 'jj@ripple-retreat.com': { status: 'valid' } }));
  ok('jj@ valid 45 days ago: checked again now, and passes', g2.ok && g2.reverified && calls.includes('jj@ripple-retreat.com'), g2);
  await verified('dj@ostromservices.com', 'valid', 45);
  const g3 = await SG.check(P, { email: 'dj@ostromservices.com', contactName: 'D.J. Ostrom' }, deps({ 'dj@ostromservices.com': { status: 'accept_all' } }));
  ok('dj@ on a catch-all domain: blocked, a name match is not a verification', !g3.ok && g3.code === 'catch-all', g3);
  const g4 = await SG.check(P, { email: 'mike@nevercheck.com', contactName: 'Michael Lee' }, deps({}));
  ok('mike@ for Michael Lee, never verified and the check cannot answer: held, never sent', !g4.ok && (g4.retry || g4.code === 'unverified'), g4);
  await verified('s@victoryma.com', 'valid', 2);
  const g5 = await SG.check(P, { email: 's@victoryma.com', contactName: 'Ralph S.', business: 'Victory Martial Arts' }, deps({}));
  ok('s@victoryma.com, valid 2 days ago: still blocked, not his address', !g5.ok && g5.code === 'not-theirs', g5);

  console.log('\n   a single letter, read off the card');
  const JOB = require(REPO + 'server/jobs/outreachQueue');
  const card = (slot, o) => JOB.insertCard(P, { agentId: AG, athleteId: ATH, slot, card: { brandKey: o.key, brandName: o.brand, why: 'fit', contactName: o.name,
    contactTitle: o.title || null, greetName: o.name.split(' ')[0], email: o.email, emailKind: 'person', emailTier: 1, channel: 'email',
    subject: 'Amber Bretton x ' + o.brand, emailBody: 'Hi ' + o.name.split(' ')[0] + ',\n\nAn idea.', lane: o.lane || 'local', phone: o.phone || null, athleteName: 'Amber Bretton' } });
  await card(5, { key: 'gn-victory', brand: 'Victory Martial Arts', name: 'Ralph S.', title: 'Owner', email: 'r@victoryma.com', lane: 'local' });
  await verified('r@victoryma.com', 'valid', 3);
  const g6 = await SG.check(P, { email: 'r@victoryma.com', contactName: 'Ralph S.', business: 'Victory Martial Arts', athleteId: ATH }, deps({}));
  ok('r@victoryma.com: the card says Owner of a local business, so it passes', g6.ok, g6);
  const pk = await SG.peek(P, 'r@victoryma.com', 'Ralph S.', { brand: 'Victory Martial Arts' });
  ok('  peek reads the same card (Home\'s Verified label)', pk.verified && pk.label === 'Verified', pk);
  await P.query(`UPDATE outreach_queue SET contact_title = 'Front desk' WHERE email = 'r@victoryma.com'`);
  const g7 = await SG.check(P, { email: 'r@victoryma.com', contactName: 'Ralph S.', business: 'Victory Martial Arts', athleteId: ATH }, deps({}));
  ok('  the same card saying Front desk: blocked', !g7.ok && g7.code === 'not-theirs' && /does not say they own/.test(g7.why), g7);
  await P.query(`DELETE FROM outreach_queue WHERE email = 'r@victoryma.com'`);
  const g8 = await SG.check(P, { email: 'r@victoryma.com', contactName: 'Ralph S.', business: 'Victory Martial Arts' }, deps({}));
  ok('  no card to read at all: blocked (when unsure, block)', !g8.ok && g8.code === 'not-theirs', g8);

  console.log('\n5. RESTORE-FALSE-STOPS');
  const RF = require(REPO + 'server/services/restoreFalseStops');
  await RF.ensureColumns(P);
  // Cards placed by the real queue, then stopped by the real blockAndOffer,
  // the way stop-unverified stopped them.
  const logOf = async (email) => (await P.query(`SELECT l.* FROM outreach_logs l WHERE LOWER(l.sent_to_email) = $1 ORDER BY created_at DESC LIMIT 1`, [email])).rows[0];
  const stop = async (email, name) => { const l = await logOf(email); return SG.blockAndOffer(P, l, { code: 'not-theirs', why: `${email} is not ${name}'s address (it does not carry their name)` }, { contactName: name }); };
  const people = [
    [1, 'gn-shire', 'Dr. Robert Shire DDS', 'Robert Shire', 'rob@drrobertshire.com', 'Owner', '205-555-0101'],
    [2, 'gn-ripple', 'Ripple Retreat', 'JJ Holley', 'jj@ripple-retreat.com', 'Owner', '205-555-0102'],
    [3, 'gn-ostrom', 'Ostrom Services', 'D.J. Ostrom', 'dj@ostromservices.com', 'Owner', '205-555-0103'],
    [4, 'gn-victory2', 'Victory Martial Arts', 'Ralph S.', 's@victoryma.com', 'Owner', '205-555-0104'],
    [5, 'gn-stale', 'Hart Hardware', 'William Hart', 'bill@hartstale.com', 'Owner', '205-555-0105'],
  ];
  const wrote = [];
  for (const [slot, key, brand, name, email, title, phone] of people) wrote.push(await card(slot, { key, brand, name, title, email, phone }));
  ok('the fixture: five cards placed by the real queue', wrote.every(Boolean), wrote);
  await verified('jj@ripple-retreat.com', 'valid', 4);
  await verified('dj@ostromservices.com', 'valid', 6);
  await verified('bill@hartstale.com', 'valid', 40);
  // JJ's had been approved by the agent before it was stopped.
  await P.query(`UPDATE outreach_logs SET status = 'approved', approved_at = NOW(), approved_by = $2, scheduled_send_at = NOW() WHERE LOWER(sent_to_email) = $1`, ['jj@ripple-retreat.com', AG]);
  for (const [, , , name, email] of people) await stop(email, name);
  // Another athlete's cards, for the cases the agent has acted on.
  const ATH2 = 'gn-ath2';
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`, [ATH2, AG, JSON.stringify({ name: 'Cole Rivers', school: 'Auburn', dob: '2003-01-02' })]);
  const card2 = (slot, o) => JOB.insertCard(P, { agentId: AG, athleteId: ATH2, slot, card: { brandKey: o.key, brandName: o.brand, why: 'fit', contactName: o.name,
    contactTitle: 'Owner', greetName: o.name.split(' ')[0], email: o.email, emailKind: 'person', emailTier: 1, channel: 'email',
    subject: 'Cole Rivers x ' + o.brand, emailBody: 'Hi ' + o.name.split(' ')[0] + ',\n\nAn idea.', lane: 'local', phone: o.phone, athleteName: 'Cole Rivers' } });
  for (const [slot, key, brand, name, email, phone] of [
    [1, 'gn-done', 'Lee Bakery', 'Michael Lee', 'mike@leebakery.com', '205-555-0201'],
    [2, 'gn-supp', 'Cole Cycles', 'James Cole', 'jim@colecycles.com', '205-555-0202'],
    [3, 'gn-early', 'Park Pilates', 'Elizabeth Park', 'liz@parkpilates.com', '205-555-0203'],
  ]) { ok(`the fixture: ${email}'s card placed`, await card2(slot, { key, brand, name, email, phone })); await verified(email, 'valid', 3); }
  await stop('mike@leebakery.com', 'Michael Lee');
  await P.query(`UPDATE outreach_queue SET outcome = 'called', outcome_at = NOW() WHERE email = 'mike@leebakery.com'`);       // the agent called instead
  await stop('jim@colecycles.com', 'James Cole');
  ok('the fixture: jim@ is on the suppression list', await require(REPO + 'server/services/suppression').suppress(P, 'jim@colecycles.com', { reason: 'unsubscribed', kind: 'unsubscribe' }) !== false
    && (await require(REPO + 'server/services/suppression').isSuppressed(P, 'jim@colecycles.com')).suppressed === true);
  await P.query(`UPDATE outreach_logs SET cadence_stopped_at = NOW() - INTERVAL '3 days', cadence_stop_reason = 'the agent stopped the cadence' WHERE LOWER(sent_to_email) = 'liz@parkpilates.com'`);
  await stop('liz@parkpilates.com', 'Elizabeth Park');
  // A follow-up to a sent first email, stopped the same way.
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, touch_no, sent_at, created_at, updated_at)
                 VALUES ('gn-first', $1, $2, 'Gale Tile', 'Hi', '<p>Hi</p>', 'sent', 'tony@galetile.com', 1, NOW() - INTERVAL '6 days', NOW() - INTERVAL '6 days', NOW())`, [AG, ATH]);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, touch_no, parent_id, contact_name, scheduled_send_at, created_at, updated_at)
                 VALUES ('gn-fu', $1, $2, 'Gale Tile', 'Re: Hi', '<p>Following up</p>', 'draft', 'tony@galetile.com', 2, 'gn-first', 'Anthony Gale', NOW() + INTERVAL '1 day', NOW(), NOW())`, [AG, ATH]);
  await verified('tony@galetile.com', 'valid', 5);
  await stop('tony@galetile.com', 'Anthony Gale');
  // A stop for another reason is not this script's.
  await card(6, { key: 'gn-catch', brand: 'Catch Co', name: 'Kim Catch', title: 'Owner', email: 'kim@catchco.com', phone: '205-555-0106' });
  { const l = await logOf('kim@catchco.com'); await SG.blockAndOffer(P, l, { code: 'catch-all', why: 'kim@catchco.com is on a domain that accepts any address' }, { contactName: 'Kim Catch' }); }

  const before = (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE cadence_stopped_at IS NOT NULL`)).rows[0].n;
  const shireCard0 = (await P.query(`SELECT channel, outreach_log_id FROM outreach_queue WHERE email = 'rob@drrobertshire.com'`)).rows[0];
  ok('the fixture: rob@\'s card was turned into a call card and unlinked by the stop', shireCard0.channel === 'call' && shireCard0.outreach_log_id === null, shireCard0);

  const dry = await RF.run(P, {});
  const all = [...dry.agents.values()].flatMap((A) => [...A.restore.map((x) => ({ ...x, a: 'restore' })), ...A.stay.map((x) => ({ ...x, a: 'stay' }))]);
  const by = (email) => all.find((x) => x.address === email) || {};
  ok('only "not their address" stops are considered (the catch-all stop is not)', !by('kim@catchco.com').address && dry.considered === 9, { considered: dry.considered, list: all.map((x) => x.address) });
  ok('to restore: rob@, jj@, dj@ and the follow-up to tony@', ['rob@drrobertshire.com', 'jj@ripple-retreat.com', 'dj@ostromservices.com', 'tony@galetile.com'].every((e) => by(e).a === 'restore') && dry.restore === 4, all.map((x) => [x.address, x.a, x.why]));
  ok('  each says whose and how, and the verification date', /Robert Shire's address \(nickname\), verified valid \d{4}-\d\d-\d\d/.test(by('rob@drrobertshire.com').why) && /JJ Holley's address \(first name\)/.test(by('jj@ripple-retreat.com').why), by('rob@drrobertshire.com'));
  ok('stays: s@victoryma.com, still not Ralph S.\'s', by('s@victoryma.com').a === 'stay' && /still not theirs under the corrected rule: s@ is a single letter/.test(by('s@victoryma.com').why), by('s@victoryma.com'));
  ok('stays: bill@ for William Hart, verified 40 days ago (no valid check in 30 days)', by('bill@hartstale.com').a === 'stay' && /William Hart's address \(nickname\), but there is no valid verification in the last 30 days/.test(by('bill@hartstale.com').why), by('bill@hartstale.com'));
  ok('stays: mike@, the agent called instead (the call card is marked done)', by('mike@leebakery.com').a === 'stay' && /acted on its call card since \(called\)/.test(by('mike@leebakery.com').why), by('mike@leebakery.com'));
  ok('stays: jim@, unsubscribed since', by('jim@colecycles.com').a === 'stay' && /suppression list/.test(by('jim@colecycles.com').why), by('jim@colecycles.com'));
  ok('stays: liz@, stopped for another reason before the gate', by('liz@parkpilates.com').a === 'stay' && /before the gate, for another reason/.test(by('liz@parkpilates.com').why), by('liz@parkpilates.com'));
  ok('DRY RUN: nothing changed', (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs WHERE cadence_stopped_at IS NOT NULL`)).rows[0].n === before
    && (await P.query(`SELECT channel FROM outreach_queue WHERE email = 'rob@drrobertshire.com'`)).rows[0].channel === 'call');
  const txt = RF.format(dry);
  ok('  the printout says so, and how to apply', /DRY RUN: nothing was changed\. Add &apply=1/.test(txt) && /restore  \[queued card\] Amber Bretton -> Dr\. Robert Shire DDS: rob@drrobertshire\.com \(Robert Shire\)/.test(txt)
    && /TOTAL: 4 to restore, 5 stay stopped\./.test(txt), txt);

  const ap = await RF.run(P, { apply: true });
  ok('APPLY: four restored, three of them back on Home as email cards', ap.restored === 4 && ap.cards === 3 && !ap.failed, { restored: ap.restored, cards: ap.cards, failed: ap.failed });
  const lr = await logOf('rob@drrobertshire.com');
  ok('  rob@\'s email is a draft again, un-stopped, with the reason it is back', lr.status === 'draft' && !lr.cadence_stopped_at && !lr.gate_reason && !lr.send_error && lr.gate_restored_at
    && /^Restored: rob@drrobertshire\.com is Robert Shire's address \(nickname\)/.test(lr.gate_restored_why || ''), lr);
  const cr = (await P.query(`SELECT channel, outreach_log_id, email_note, dm_text, state FROM outreach_queue WHERE email = 'rob@drrobertshire.com'`)).rows[0];
  ok('  its card is the email card again, linked to that draft', cr.channel === 'email' && cr.outreach_log_id === lr.id && cr.state === 'queued' && /^Restored:/.test(cr.email_note || '') && !cr.dm_text, cr);
  const A = require(REPO + 'server/services/actionable');
  const home = await A.load(P, AG, { athleteId: ATH, full: true });
  const onHome = (home.byAthlete.get(ATH) || []).filter((c) => /drrobertshire/.test(JSON.stringify(c)));
  ok('  and it shows on Home once, as an email card', onHome.length === 1 && onHome[0].channel === 'email', onHome.map((c) => [c.channel, c.id]));
  const lj = await logOf('jj@ripple-retreat.com');
  ok('  JJ\'s, approved before the stop, comes back as a draft for a fresh approval: nothing sends on its own', lj.status === 'draft' && !lj.approved_at && !lj.scheduled_send_at, lj);
  const fu = (await P.query(`SELECT * FROM outreach_logs WHERE id = 'gn-fu'`)).rows[0];
  ok('  the follow-up is un-stopped and keeps its date', fu.status === 'draft' && !fu.cadence_stopped_at && fu.scheduled_send_at && new Date(fu.scheduled_send_at) > new Date(), fu);
  const gate = await SG.check(P, { email: lr.sent_to_email, contactName: 'Robert Shire', athleteId: ATH }, deps({}));
  ok('  and the gate lets it through now', gate.ok, gate);
  const still = (await P.query(`SELECT LOWER(sent_to_email) e, cadence_stopped_at, gate_reason FROM outreach_logs WHERE LOWER(sent_to_email) IN ('s@victoryma.com','bill@hartstale.com','mike@leebakery.com','jim@colecycles.com','liz@parkpilates.com','kim@catchco.com')`)).rows;
  ok('  every one that stays is untouched: still stopped', still.length === 6 && still.every((r) => r.cadence_stopped_at), still);
  ok('  and the called card stays done', (await P.query(`SELECT outcome FROM outreach_queue WHERE email = 'mike@leebakery.com'`)).rows[0].outcome === 'called');
  const again = await RF.run(P, { apply: true });
  ok('a second run restores nothing more', again.restore === 0 && again.restored === 0, { restore: again.restore });

  console.log('\n6. THE ADMIN SCRIPT');
  const AS = require(REPO + 'server/services/adminScripts');
  const reg = AS.registry();
  const d = reg['restore-false-stops'];
  ok('restore-false-stops is registered, one descriptor file', !!d && d.file === 'scripts/restore-false-stops.js' && require('fs').existsSync(REPO + 'server/scripts/admin/restore-false-stops.js'));
  ok('  print first: no apply unless apply=1', JSON.stringify(d.args({})) === '[]' && JSON.stringify(d.args({ apply: '1' })) === '["--apply"]' && JSON.stringify(d.args({ apply: 'yes' })) === '[]');
  ok('  agent= is sanitized and bounded', JSON.stringify(d.args({ agent: 'gn@agency.test; rm -rf' })) === '["--agent","gn@agency.testrm-rf"]' && d.args({ agent: 'a'.repeat(400) })[1].length === 120);
  const out = execSync(`node ${REPO}scripts/restore-false-stops.js --agent gn@agency.test`, { env: { ...process.env, INIT_WAIT_MS: '2500' } }).toString();
  ok('  the script runs and prints, dry by default', /RESTORE FALSE STOPS: \d+ email\(s\)/.test(out) && /DRY RUN/.test(out) && /s@victoryma\.com \(Ralph S\.\)/.test(out), out.slice(0, 600));

  console.log(`\n${N - F}/${N} passed`);
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
