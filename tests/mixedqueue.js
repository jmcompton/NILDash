'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// ONE QUEUE OUT OF TWO TABLES.
//
// Real Postgres, the real buildHome, the real approveBatch, the real shift
// report. Nothing about the ordering, the gate or the approve rejection is
// simulated -- the assertions are on what the shipping functions return.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Home = require(ROOT + 'server/services/homeQueue.js');
const A = require(ROOT + 'server/services/actionable.js');
const Closer = require(ROOT + 'server/services/closer.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const SE = require(ROOT + 'server/services/shiftEmail.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const AG = 'mix-agent';
const ATH = 'mix-ath-1';
const ATH2 = 'mix-ath-2';
const DAY = 86400000;

async function seed(P) {
  for (const t of ['outreach_logs', 'outreach_queue', 'outreach_queue_runs', 'company_enrichment', 'brand_match_scores']) {
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  }
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Jordan','mix@x.com','x','agent','America/Chicago')`, [AG]);
  for (const [id, nm] of [[ATH, 'Amber Bretton'], [ATH2, 'Devon Pike']]) {
    await P.query(`INSERT INTO athletes (id,agent_id,data,created_at) VALUES ($1,$2,$3,NOW())`,
      [id, AG, JSON.stringify({ name: nm, school: 'Alabama', dob: '2004-09-02' })]);
  }
}

// An email draft. `ageDays` back-dates created_at so starvation is testable.
let seq = 0;
async function draft(P, o) {
  const id = 'mix-log-' + (++seq);
  let encId = null;
  if (o.website) {
    encId = 'mix-enc-' + seq;
    await P.query(`INSERT INTO company_enrichment (id,agent_id,brand_name,website)
                   VALUES ($1,$2,$3,$4)`, [encId, AG, o.brand, o.website]);
  }
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,
                                status,sent_to_email,enrichment_id,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8, NOW() - ($9||' days')::interval)`,
    [id, AG, o.athleteId || ATH, o.brand, o.subject || ('Quick idea for ' + o.brand),
      o.body || ('<p>We think ' + o.brand + ' and this athlete are a natural fit locally.</p>'),
      o.to === undefined ? ('hello@' + o.brand.toLowerCase().replace(/[^a-z]/g, '') + '.com') : o.to,
      encId, String(o.ageDays || 0)]);
  return id;
}

async function card(P, o) {
  const r = await P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,
                                 why,dm_text,instagram,instagram_scope,phone,phone_ask_for,
                                 contact_name,sponsor_note,program_url,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,$13,$14,$15,
             NOW() - ($16||' days')::interval) RETURNING id`,
    [AG, o.athleteId || ATH, o.slot, o.brandKey || ('name:' + o.brand.toLowerCase()), o.brand,
      o.channel, o.why || ('They sponsor local teams and sit two miles from campus.'),
      o.dmText === undefined ? 'Hi — quick idea about working with a local athlete.' : o.dmText,
      o.handle === undefined ? 'the' + o.brand.toLowerCase().replace(/[^a-z]/g, '') : o.handle,
      o.handleScope || null,
      o.phone === undefined ? '205-555-0100' : o.phone,
      o.askFor || null, o.contactName || null, o.sponsorNote || null, o.programUrl || null,
      String(o.ageDays || 0)]);
  return r.rows[0].id;
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);

  // ── 1. BOTH TABLES REACH THE PAGE ─────────────────────────────────────────
  console.log('\n1. HOME READS BOTH TABLES');
  await draft(P, { brand: 'Cahaba Coffee', website: 'https://cahabacoffee.com' });
  await card(P, { brand: 'Hoover Cycles', slot: 1, channel: 'dm' });
  await card(P, { brand: 'Vestavia Grill', slot: 2, channel: 'call', askFor: 'Dana' });
  await card(P, { brand: 'Big National Co', slot: 3, channel: 'program', programUrl: 'https://x.com/apply' });

  let h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('no read failed', h.errors.length === 0, JSON.stringify(h.errors));
  const chans = h.cards.map((c) => c.channel);
  check('an email draft is on the page', chans.indexOf('email') !== -1, JSON.stringify(chans));
  check('a DM card is on the page', chans.indexOf('dm') !== -1);
  check('a call card is on the page', chans.indexOf('call') !== -1);
  check('a programme card is NOT', chans.indexOf('program') === -1);
  check('programmes are counted, not lost', h.programs === 1, 'programs=' + h.programs);
  check('every card carries a channel badge', h.cards.every((c) => !!c.channel));
  check('the mix is reported', h.mix.email === 1 && h.mix.dm === 1 && h.mix.call === 1,
    JSON.stringify(h.mix));

  const dm = h.cards.find((c) => c.channel === 'dm');
  check('the DM card carries its message', !!(dm && dm.dmText), dm && dm.dmText);
  check('  and its handle', !!(dm && dm.handle), dm && dm.handle);
  const call = h.cards.find((c) => c.channel === 'call');
  check('the call card carries a number', !!(call && call.phone), call && call.phone);
  check('  and who to ask for', call && call.askFor === 'Dana', call && call.askFor);
  check('a call card offers no media kit line', call && call.mediaKit === null);

  // ── 2. IDS SAY WHICH TABLE THEY CAME FROM ─────────────────────────────────
  console.log('\n2. IDS ARE NAMESPACED');
  check('email ids are namespaced',
    h.cards.filter((c) => c.channel === 'email').every((c) => /^email:/.test(c.id)));
  check('queue ids are namespaced',
    h.cards.filter((c) => c.channel !== 'email').every((c) => /^queue:/.test(c.id)));

  // ── 3. THE APPROVE PATH REJECTS WHAT IT CANNOT SEND ───────────────────────
  console.log('\n3. A QUEUE ID FED TO THE EMAIL APPROVE PATH IS AN ERROR');
  const queueCard = h.cards.find((c) => c.channel === 'dm');
  const emailCard = h.cards.find((c) => c.channel === 'email');
  const before = (await P.query(
    `SELECT status, approved_at FROM outreach_logs WHERE agent_id=$1`, [AG])).rows;
  let threw = null;
  try {
    await Closer.approveBatch(P, AG, { ids: [queueCard.id], athleteId: ATH });
  } catch (e) { threw = e; }
  check('it THREW rather than returning 0 approved', !!threw, threw && threw.message);
  check('  flagged as a bad id, so the route can answer 400 not 500', !!(threw && threw.badId));
  check('  and named the card type in the message', !!(threw && /dm|queue/i.test(threw.message)),
    threw && threw.message);
  const after = (await P.query(
    `SELECT status, approved_at FROM outreach_logs WHERE agent_id=$1`, [AG])).rows;
  check('  and wrote nothing at all',
    JSON.stringify(before) === JSON.stringify(after));

  let threw2 = null;
  try { await Closer.approveBatch(P, AG, { ids: [emailCard.id, queueCard.id], athleteId: ATH }); }
  catch (e) { threw2 = e; }
  check('one bad id fails the WHOLE batch, it is not filtered out', !!threw2, threw2 && threw2.message);
  const after2 = (await P.query(`SELECT status FROM outreach_logs WHERE agent_id=$1`, [AG])).rows;
  check('  so the good draft in that batch is untouched too',
    after2.every((r) => r.status === 'draft'));

  let threw3 = null;
  try { await Closer.approveBatch(P, AG, { ids: ['nosuchtable:9'], athleteId: ATH }); }
  catch (e) { threw3 = e; }
  check('an unknown namespace throws too', !!(threw3 && threw3.badId), threw3 && threw3.message);

  // A page cached before this shipped posts bare draft ids and must still work.
  const bareOk = await Closer.approveBatch(P, AG, { ids: [], athleteId: ATH });
  check('an empty batch is still a plain answer, not a throw', bareOk.approved === 0);

  // ── 4. THE ORDERING LADDER ────────────────────────────────────────────────
  console.log('\n4. ORDERING, WITH NO SHARED SCORE');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);

  // Six reachable cards, one of them old enough to be starved.
  await card(P, { brand: 'Alpha Auto', slot: 1, channel: 'call', askFor: 'Sam', ageDays: 0 });   // reach 2
  await card(P, { brand: 'Bravo Bakery', slot: 2, channel: 'call', ageDays: 0 });                // reach 1 (no name)
  await card(P, { brand: 'Charlie Cyc', slot: 3, channel: 'dm', handleScope: 'brand', ageDays: 0 }); // reach 1
  await card(P, { brand: 'Delta Deli', slot: 4, channel: 'dm', ageDays: 0 });                    // reach 2
  await card(P, { brand: 'Echo Electric', slot: 5, channel: 'call', ageDays: 9 });               // STARVED
  await draft(P, { brand: 'Foxtrot Foods', website: 'https://foxtrotfoods.com', ageDays: 0 });

  h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('five and no more, whatever the channel', h.cards.length === 5, 'shown=' + h.cards.length);
  check('the starved card is first',
    h.cards[0] && h.cards[0].business === 'Echo Electric',
    h.cards.map((c) => c.business).join(' → '));
  check('the pile behind the five is reported', h.pending === 6 && h.heldBack === 1,
    'pending=' + h.pending + ' heldBack=' + h.heldBack);
  // AGE IS THE ONLY TRULY SHARED SIGNAL, so it has to survive the round trip
  // through Postgres. node-postgres hands back a Date and Date.parse() takes a
  // string, so this ordering silently collapsed to the id -- which sorts by
  // TABLE -- until that was fixed. Asserted on real rows, not on hand-built ones.
  const names = h.cards.map((c) => c.business);
  check('among equal-reach cards the older one is first (real rows, real dates)',
    names.indexOf('Bravo Bakery') < names.indexOf('Foxtrot Foods'), names.join(' → '));

  // The ladder, asserted on the module directly so the reason for each position
  // is checkable rather than inferred from a rendered list.
  const now = Date.now();
  check('a named contact outranks a switchboard on the same channel',
    A.reachScore({ channel: 'call', phoneAskFor: 'Sam' }) > A.reachScore({ channel: 'call' }));
  check('a storefront handle outranks a national brand account',
    A.reachScore({ channel: 'dm' }) > A.reachScore({ channel: 'dm', instagramScope: 'brand' }));
  check('a confirmed mailbox outranks an unconfirmed one',
    A.reachScore({ channel: 'email', verified: { result: 'valid' } })
      > A.reachScore({ channel: 'email', verified: null }));
  check('an email draft starves a day before it is expired, not on the day',
    A.starveDaysFor('email') === 6 && A.starveDaysFor('call') === 7,
    'email=' + A.starveDaysFor('email') + ' call=' + A.starveDaysFor('call'));

  // Oldest first among equals, which is the only genuinely shared column.
  const eq = [
    { id: 'b', channel: 'call', phoneAskFor: 'x', why: 'w', createdAt: new Date(now - 2 * DAY).toISOString() },
    { id: 'a', channel: 'call', phoneAskFor: 'x', why: 'w', createdAt: new Date(now - 5 * DAY).toISOString() },
  ].sort(A.byRank(now));
  check('among equals, the oldest card is first', eq[0].id === 'a', eq.map((x) => x.id).join(','));

  // ── 5. TWO SLOTS ARE HELD FOR EMAIL ───────────────────────────────────────
  console.log('\n5. THE EMAIL RESERVE IS A FLOOR, NOT A CAP');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  // Six strong DM cards and two weak, brand-new email drafts. Ranked purely, the
  // DMs take all five; the reserve must still surface two emails.
  for (let i = 0; i < 6; i++) {
    await card(P, { brand: 'DM Shop ' + i, slot: i + 1, channel: 'dm', ageDays: 3 });
  }
  await draft(P, { brand: 'Late Email A', website: 'https://lateemaila.com', ageDays: 0 });
  await draft(P, { brand: 'Late Email B', website: 'https://lateemailb.com', ageDays: 0 });

  h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('exactly two of the five are email', h.mix.email === 2, JSON.stringify(h.mix));
  check('  and the other three are DMs', h.mix.dm === 3, JSON.stringify(h.mix));

  // A FLOOR, not a cap: with nothing but email, all five are email.
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  for (let i = 0; i < 4; i++) await draft(P, { brand: 'Only Email ' + i, website: 'https://onlyemail' + i + '.com' });
  h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('with nothing but email, the reserve does not cap it at two',
    h.mix.email === 5, JSON.stringify(h.mix));

  // ── 6. ONE CARD PER BUSINESS, ACROSS THE TWO TABLES ───────────────────────
  console.log('\n6. THE SAME BUSINESS DOES NOT GET TWO CARDS');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  // The two names a real duplicate arrives under: one from a scan, one from the
  // slate, spelled differently, with no shared key between the tables.
  await draft(P, { brand: 'Cahaba Brewing Company', website: 'https://cahababrewing.com' });
  await card(P, { brand: 'Cahaba Brewing Co.', slot: 1, channel: 'dm' });
  await card(P, { brand: 'Somewhere Else', slot: 2, channel: 'call' });

  h = await Home.buildHome(P, AG, { athleteId: ATH });
  const brands = h.cards.map((c) => c.business);
  check('the brewery appears once, not twice',
    brands.filter((b) => /Cahaba/i.test(b)).length === 1, JSON.stringify(brands));
  check('  and the email is the copy that survived',
    (h.cards.find((c) => /Cahaba/i.test(c.business)) || {}).channel === 'email',
    (h.cards.find((c) => /Cahaba/i.test(c.business)) || {}).channel);
  check('the unrelated business is untouched', brands.indexOf('Somewhere Else') !== -1);

  // ── 7. THE GATE IS PER CHANNEL ────────────────────────────────────────────
  console.log('\n7. EACH CHANNEL IS JUDGED BY ITS OWN REACHABILITY');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  await draft(P, { brand: 'No Address Co', to: null });
  await card(P, { brand: 'No Handle Co', slot: 1, channel: 'dm', handle: null });
  await card(P, { brand: 'No Message Co', slot: 2, channel: 'dm', dmText: null });
  await card(P, { brand: 'No Phone Co', slot: 3, channel: 'call', phone: null });
  await card(P, { brand: 'Reachable Co', slot: 4, channel: 'call' });

  h = await Home.buildHome(P, AG, { athleteId: ATH });
  check('only the reachable card is shown', h.cards.length === 1 && h.cards[0].business === 'Reachable Co',
    JSON.stringify(h.cards.map((c) => c.business)));
  const whyOf = (b) => (h.withheld.find((w) => w.business === b) || {}).why;
  check('the addressless email says so', /email address/.test(whyOf('No Address Co') || ''), whyOf('No Address Co'));
  check('the handleless DM does NOT claim an email problem',
    /Instagram/.test(whyOf('No Handle Co') || ''), whyOf('No Handle Co'));
  check('the empty DM says the message is missing',
    /DM written/.test(whyOf('No Message Co') || ''), whyOf('No Message Co'));
  check('the phoneless call says the number is missing',
    /phone number/.test(whyOf('No Phone Co') || ''), whyOf('No Phone Co'));

  // ── 8. HOME AND THE SHIFT REPORT CANNOT DISAGREE ──────────────────────────
  console.log('\n8. ONE PILE, ONE NUMBER');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  // A realistic pile: mostly unreachable email drafts (the 19-in-20 case), a
  // handful of reachable cards on two athletes, and some programme cards.
  for (let i = 0; i < 12; i++) await draft(P, { brand: 'Ghost Draft ' + i, to: null });
  await draft(P, { brand: 'Real Email One', website: 'https://realemailone.com' });
  await draft(P, { brand: 'Real Email Two', website: 'https://realemailtwo.com', athleteId: ATH2 });
  await card(P, { brand: 'Call One', slot: 1, channel: 'call' });
  await card(P, { brand: 'DM One', slot: 2, channel: 'dm' });
  await card(P, { brand: 'DM Two', slot: 1, channel: 'dm', athleteId: ATH2 });
  await card(P, { brand: 'Prog One', slot: 3, channel: 'program' });
  await card(P, { brand: 'Prog Two', slot: 4, channel: 'program' });

  const h1 = await Home.buildHome(P, AG, { athleteId: ATH });
  const h2 = await Home.buildHome(P, AG, { athleteId: ATH2 });
  const homeTotal = (h1.athletes || []).reduce((s, a) => s + a.pending, 0);
  check('Home counts three for the first athlete', h1.pending === 3, 'pending=' + h1.pending);
  check('Home counts two for the second', h2.pending === 2, 'pending=' + h2.pending);
  check('the tabs and the page agree', homeTotal === 5, 'tabs=' + homeTotal);

  const rep = await SR.buildShiftReport(P, AG);
  const ready = (rep.needsYou.items || []).find((it) => it.kind === 'approve');
  check('the report has a ready-to-work item', !!ready, JSON.stringify(ready && ready.line));
  check('IT IS THE SAME NUMBER HOME SHOWS', ready && ready.total === homeTotal,
    'report=' + (ready && ready.total) + ' home=' + homeTotal);
  check('  and it does not count the twelve addressless drafts',
    ready && ready.total === 5, ready && ready.total);
  check('the breakdown is on the line', ready && /approve/.test(ready.detail || ''), ready && ready.detail);
  check('Ready to send counts EMAIL only, and matches',
    rep.closer.pendingApproval === 2, 'pendingApproval=' + rep.closer.pendingApproval);
  check('  and readyToWork carries the whole pile',
    rep.closer.readyToWork === homeTotal, rep.closer.readyToWork);
  const prog = (rep.needsYou.items || []).find((it) => it.kind === 'queue');
  check('programmes get their own row, not silence', prog && prog.total === 2, JSON.stringify(prog && prog.line));

  const mail = SE.renderShiftEmail(rep, { agentName: 'Jordan' });
  check('the email subject uses the mixed pile', /5 cards ready to work/.test(mail.subject), mail.subject);
  check('the email names the DM and call work',
    /to DM/.test(mail.html) && /to call/.test(mail.html));
  check('the email still names the programme applications', /programme application/.test(mail.html));

  // ── 9. WHAT THE CUSTOMER WAITS FOR AT 7AM ─────────────────────────────────
  console.log('\n9. COLD LOAD');
  // A GENUINELY COLD ONE. A fresh athlete, so the per-athlete verification
  // budget is unspent, and drafts with no address so the addressing pass has
  // real work -- otherwise this measures a warm cache and reports it as 7ms.
  const ATH3 = 'mix-ath-3';
  await P.query(`INSERT INTO athletes (id,agent_id,data,created_at) VALUES ($1,$2,$3,NOW())`,
    [ATH3, AG, JSON.stringify({ name: 'Cold Load', school: 'Alabama', dob: '2004-01-01' })]);
  for (let i = 0; i < 8; i++) {
    await draft(P, { brand: 'Cold Biz ' + i, to: null, athleteId: ATH3,
      website: 'https://coldbiz' + i + '.com' });
  }
  await card(P, { brand: 'Cold Call', slot: 1, channel: 'call', athleteId: ATH3 });
  const t0 = Date.now();
  const cold = await Home.buildHome(P, AG, { athleteId: ATH3 });
  const ms = Date.now() - t0;
  check('a cold Home load stays inside the attach deadline plus a page render',
    ms < 4000, ms + 'ms');
  console.log('    cold load, unspent budget, 8 unaddressed drafts: ' + ms + 'ms'
    + ' (shown ' + cold.cards.length + ', withheld ' + cold.withheld.length + ')');

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
