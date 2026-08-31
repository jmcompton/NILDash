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
// EMAIL AS A NIGHTLY CHANNEL.
//
// The card carried a handle and a phone and threw the address away: passesBar
// counted a general inbox as reachable, then buildCard's `dmable ? 'dm' : 'call'`
// dropped it. A local business with an inbox and no handle became a call card.
//
// Real Postgres, the real buildCard/channelFor/insertCard, the real approveBatch.
const { execFileSync } = require('child_process');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const JOB = require(ROOT + 'server/jobs/outreachQueue.js');
const A = require(ROOT + 'server/services/actionable.js');
const Home = require(ROOT + 'server/services/homeQueue.js');
const Closer = require(ROOT + 'server/services/closer.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const AG = 'ec-agent', ATH = 'ec-ath';

// Ladders shaped the way contactLadder builds them.
const withInbox = (email, name) => ({
  mainLine: { phone: '205-555-0100' },
  tiers: [
    ...(name ? [{ tier: 1, label: 'Decision makers', rows: [{ name, title: 'Owner', phone: null }] }] : []),
    { tier: 3, label: 'Business channels', rows: [{ label: 'General inbox', email, kind: 'generic' }] },
  ],
});
const noInbox = (name) => ({
  mainLine: { phone: '205-555-0100' },
  tiers: name ? [{ tier: 1, label: 'Decision makers', rows: [{ name, title: 'Owner' }] }] : [],
});

async function seed(P) {
  for (const t of ['outreach_logs', 'outreach_queue', 'brand_evidence_cache']) {
    await P.query(t === 'brand_evidence_cache'
      ? `DELETE FROM brand_evidence_cache WHERE brand_key LIKE 'ec %' OR brand LIKE 'EC %'`
      : `DELETE FROM ${t} WHERE agent_id=$1`, t === 'brand_evidence_cache' ? [] : [AG]).catch(() => {});
  }
  await P.query(`DELETE FROM athletes WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'J','ec@x.com','x','agent','America/Chicago')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Amber Bretton', school: 'Alabama', dob: '2004-09-02' })]);
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);

  console.log('\n1. PRECEDENCE: EMAIL, THEN DM, THEN CALL');
  const igOk = { instagram: 'trakshak', instagramScope: 'business' };
  const igBrand = { instagram: 'rally_house', instagramScope: 'brand' };

  check('an inbox alone is an EMAIL card',
    Q.channelFor(withInbox('hello@trakshak.com'), {}) === 'email');
  check('an inbox AND a handle is still an EMAIL card',
    Q.channelFor(withInbox('hello@trakshak.com'), igOk) === 'email');
  check('no inbox, a storefront handle is a DM card',
    Q.channelFor(noInbox(), igOk) === 'dm');
  check('no inbox, a national handle is a CALL card',
    Q.channelFor(noInbox(), igBrand) === 'call');
  check('nothing but a phone is a CALL card', Q.channelFor(noInbox(), {}) === 'call');

  console.log('\n2. THE OTHER CHANNELS STAY ON THE CARD');
  const both = Q.buildCard({ brand: 'Trak Shak', pitch: { message: 'Hi — a real idea.\n\nMore.' } },
    withInbox('hello@trakshak.com', 'Jeff Martinez'), igOk);
  check('it is an email card', both.channel === 'email', both.channel);
  check('  carrying the address', both.email === 'hello@trakshak.com', both.email);
  check('  AND the handle is still there', both.instagram === 'trakshak', both.instagram);
  check('  AND the phone is still there', both.phone === '205-555-0100', both.phone);
  check('  AND who to ask for', both.phoneAskFor === 'Jeff', both.phoneAskFor);
  check('  with a subject', /^Quick idea for Trak Shak$/.test(both.subject || ''), both.subject);
  check('  and the pitch as the email body', /a real idea/.test(both.emailBody || ''), both.emailBody);
  check('  and NO dm_text, so nothing counts it as a DM', both.dmText === null, both.dmText);

  const dmCard = Q.buildCard({ brand: 'Hoover Cycles', pitch: { message: 'Hi.' } }, noInbox(), igOk);
  check('a DM card still writes dm_text', !!dmCard.dmText, dmCard.dmText);
  check('  and carries no email', dmCard.email === null);

  console.log('\n3. AN EMAIL CARD CREATES THE DRAFT THAT SENDS IT');
  const wrote = await JOB.insertCard(P, { agentId: AG, athleteId: ATH, slot: 1, card: {
    ...both, brandKey: 'name:trak shak', athleteName: 'Amber Bretton' } });
  check('the card was written', wrote === true);
  const card = (await P.query(
    `SELECT * FROM outreach_queue WHERE agent_id=$1 AND slot=1`, [AG])).rows[0];
  check('the queue row is channel=email', card.channel === 'email', card.channel);
  check('  with the address on it', card.email === 'hello@trakshak.com', card.email);
  check('  and a link to a draft', !!card.outreach_log_id, card.outreach_log_id);
  const draft = (await P.query(
    `SELECT * FROM outreach_logs WHERE id=$1`, [card.outreach_log_id])).rows[0];
  check('the draft exists', !!draft);
  check('  addressed to the same inbox', draft.sent_to_email === 'hello@trakshak.com', draft.sent_to_email);
  check('  with the subject', draft.subject === 'Quick idea for Trak Shak', draft.subject);
  check('  the pitch as paragraphs', /<p>Hi — a real idea\.<\/p>/.test(draft.body_html), draft.body_html);
  check('  status draft, so it cannot send until approved', draft.status === 'draft');
  check('  and stamped with where it came from', draft.source === 'nightly-queue', draft.source);

  console.log('\n4. ONE SEND PATH, NOT TWO');
  const jobSrc = require('fs').readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8')
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('the queue job never sends an email itself',
    !/sendEmail|resend|releaseDue/i.test(jobSrc));
  check('an email card is NOT served from the queue side of Home',
    /channel IN \('dm','call'\)/.test(
      require('fs').readFileSync(ROOT + 'server/services/actionable.js', 'utf8')));
  const got = await A.load(P, AG, { athleteId: ATH, full: true });
  const list = got.byAthlete.get(ATH) || [];
  check('it appears exactly ONCE on Home', list.length === 1, list.length);
  check('  as an email card', list[0] && list[0].channel === 'email', list[0] && list[0].channel);
  check('  with the id namespaced to outreach_logs',
    list[0] && list[0].id === 'email:' + card.outreach_log_id, list[0] && list[0].id);

  const h = await Home.buildHome(P, AG, { athleteId: ATH });
  const hc = h.cards[0];
  check('Home shows the handle on the email card', hc && hc.handle === 'trakshak', hc && hc.handle);
  check('  and the phone', hc && hc.phone === '205-555-0100', hc && hc.phone);
  // askFirstName, not the full name: "ask for Jeff" is what you say on a shared
  // line, and phone_ask_for has always held the first name.
  check('  and who to ask for', hc && hc.askFor === 'Jeff', hc && hc.askFor);

  console.log('\n5. APPROVING FREES THE SLOT');
  await P.query(`UPDATE outreach_queue SET state='queued' WHERE id=$1`, [card.id]);
  const before = (await P.query(`SELECT state FROM outreach_queue WHERE id=$1`, [card.id])).rows[0];
  check('the slot is held while the draft waits', before.state === 'queued');
  await Closer.approveBatch(P, AG, { ids: ['email:' + card.outreach_log_id], athleteId: ATH });
  const after = (await P.query(
    `SELECT state, sent_via FROM outreach_queue WHERE id=$1`, [card.id])).rows[0];
  check('approving the draft frees the queue slot', after.state === 'sent', after.state);
  check('  recorded as sent by email', after.sent_via === 'email', after.sent_via);

  console.log('\n6. A DRAFT THAT LOST THE SLOT DOES NOT HAUNT HOME');
  // Same identity, so the insert loses on the identity index -- the draft it
  // wrote first must not survive as an approvable email.
  await P.query(`UPDATE outreach_queue SET state='queued' WHERE id=$1`, [card.id]);
  const dupe = await JOB.insertCard(P, { agentId: AG, athleteId: ATH, slot: 2, card: {
    ...both, brandKey: 'name:trak shak', athleteName: 'Amber Bretton' } });
  check('the duplicate card is refused', dupe === false);
  const orphans = (await P.query(
    `SELECT id, cadence_stopped_at, cadence_stop_reason FROM outreach_logs
      WHERE agent_id=$1 AND id <> $2`, [AG, card.outreach_log_id])).rows;
  check('its draft was written then stopped, not left approvable',
    orphans.length === 1 && !!orphans[0].cadence_stopped_at, JSON.stringify(orphans));
  check('  with a reason a person can read',
    /slot was taken/.test((orphans[0] || {}).cadence_stop_reason || ''),
    (orphans[0] || {}).cadence_stop_reason);
  // The athlete has NO cards at all now -- the real one was approved and the
  // orphan is stopped -- so byAthlete has no entry for them. That absence is the
  // assertion.
  const afterDupe = (await A.load(P, AG, { athleteId: ATH, full: true })).byAthlete.get(ATH) || [];
  check('  and it is NOT on Home',
    !afterDupe.some((c) => c.id === 'email:' + orphans[0].id), JSON.stringify(afterDupe.map((c) => c.id)));

  console.log('\n7. THE BACKFILL RECOVERS DISCARDED ADDRESSES, SPENDING NOTHING');
  await P.query(`DELETE FROM outreach_logs WHERE agent_id=$1`, [AG]);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id=$1`, [AG]);
  // Three call cards: one with a cached address, one with none, one suppressed.
  const mk = async (slot, brand, dm) => P.query(
    `INSERT INTO outreach_queue (agent_id,athlete_id,slot,brand_key,brand_name,channel,state,why,phone,dm_text)
     VALUES ($1,$2,$3,$4,$5,'call','queued','A local reason.','205-555-0199',$6)`,
    [AG, ATH, slot, 'name:' + brand.toLowerCase(), brand, dm || null]);
  await mk(1, 'EC Recoverable', 'Hi — the pitch this card already had.');
  await mk(2, 'EC Nothing Cached', null);
  await mk(3, 'EC Bounced', null);
  const cache = async (brand, email) => P.query(
    `INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at)
     VALUES ($1,'siteemail',$2,$3,'OK',NOW())
     ON CONFLICT (brand_key, lane) DO UPDATE SET evidence=EXCLUDED.evidence`,
    [brand.toLowerCase(), brand, JSON.stringify({ email, kind: 'generic' })]);
  await cache('EC Recoverable', 'hello@ecrecoverable.com');
  await cache('EC Bounced', 'bounced@ecbounced.com');
  // first_seen_at, not created_at. Seeded WITHOUT a .catch so a schema drift
  // here fails the test rather than silently un-suppressing the address and
  // making the backfill look like it ignores bounces.
  await P.query(`INSERT INTO email_suppression (email, reason, kind)
                 VALUES ('bounced@ecbounced.com','hard bounce','hard')
                 ON CONFLICT (email) DO NOTHING`);

  const run = (extra) => execFileSync(process.execPath,
    [ROOT + 'scripts/backfill-email-channel.js', '--agent', AG, ...extra],
    { encoding: 'utf8', env: { ...process.env, NODE_PATH: ROOT + 'node_modules' } });

  const dry = run([]);
  check('the dry run names the athlete and the count', /Amber Bretton — 1/.test(dry), dry.split('\n').find((l) => /Amber/.test(l)));
  check('  names the business and the address it recovered', /EC Recoverable\s+hello@ecrecoverable\.com/.test(dry));
  check('  says why each one it left alone was left',
    /no address for this brand, cached or otherwise/.test(dry));
  check('  including the bounced one', /bounced before/.test(dry), dry.split('\n').find((l) => /bounced/.test(l)));
  check('  and writes NOTHING without --apply', /DRY RUN/.test(dry));
  const untouched = (await P.query(
    `SELECT COUNT(*)::int n FROM outreach_queue WHERE agent_id=$1 AND channel='email'`, [AG])).rows[0].n;
  check('  proved: no card changed', untouched === 0, untouched);

  const applied = run(['--apply']);
  check('--apply flips exactly the recoverable one', /Flipped 1 card/.test(applied), applied.trim().split('\n').pop());
  const flipped = (await P.query(
    `SELECT brand_name, channel, email, phone, dm_text, outreach_log_id FROM outreach_queue
      WHERE agent_id=$1 ORDER BY slot`, [AG])).rows;
  check('the recovered card is now email', flipped[0].channel === 'email', flipped[0].channel);
  check('  with the address it already had', flipped[0].email === 'hello@ecrecoverable.com');
  check('  and it KEPT its phone', flipped[0].phone === '205-555-0199', flipped[0].phone);
  check('  and kept its dm_text, nothing deleted', !!flipped[0].dm_text);
  check('the other two are untouched call cards',
    flipped[1].channel === 'call' && flipped[2].channel === 'call');
  const bfDraft = (await P.query(
    `SELECT source, sent_to_email, body_html FROM outreach_logs WHERE id=$1`,
    [flipped[0].outreach_log_id])).rows[0];
  check('a draft was created for it', !!bfDraft);
  check('  stamped so it can be found again', bfDraft.source === 'backfill-email-channel', bfDraft.source);
  check('  reusing the pitch the card already carried',
    /the pitch this card already had/.test(bfDraft.body_html), bfDraft.body_html);

  const undone = run(['--undo', '--apply']);
  check('--undo puts it back to call', /Reverted 1/.test(undone), undone.trim().split('\n').pop());
  const back = (await P.query(
    `SELECT channel, email, outreach_log_id FROM outreach_queue WHERE agent_id=$1 ORDER BY slot`, [AG])).rows[0];
  check('  channel is call again', back.channel === 'call', back.channel);
  check('  the recovered ADDRESS is kept, not deleted', back.email === 'hello@ecrecoverable.com', back.email);
  const stopped = (await P.query(
    `SELECT status, cadence_stopped_at FROM outreach_logs WHERE source=$1`, ['backfill-email-channel'])).rows;
  check('  and the draft is stopped rather than deleted',
    stopped.length === 1 && !!stopped[0].cadence_stopped_at, JSON.stringify(stopped));

  console.log('\n8. A BACKFILLED DRAFT SITS THERE. IT DOES NOT SEND.');
  // Re-apply so there is a live backfill draft to interrogate.
  run(['--apply']);
  const bf = (await P.query(
    `SELECT id, status, approved_at, scheduled_send_at, cadence_stopped_at
       FROM outreach_logs WHERE source = 'backfill-email-channel' AND status = 'draft'
        AND cadence_stopped_at IS NULL`)).rows;
  check('the backfill left a live draft', bf.length === 1, JSON.stringify(bf.map((r) => r.id)));
  check('  status is draft, not approved', bf[0].status === 'draft', bf[0].status);
  check('  it has NO approved_at', bf[0].approved_at === null, bf[0].approved_at);
  check('  and NO scheduled_send_at', bf[0].scheduled_send_at === null, bf[0].scheduled_send_at);

  // THE DECISIVE ONE. releaseDue is the only thing that sends. Driven with a
  // recorder in place of the provider and a `now` a year out, so nothing can be
  // "not due yet" -- if it were sendable it would send here.
  // SCOPED TO THIS DRAFT, not to the whole table. releaseDue is global and this
  // database carries approved drafts from every other suite, so asserting
  // considered===0 would be asserting something about them.
  const sentTo = [];
  const consideredIds = [];
  const rel = await Closer.releaseDue(P, {
    now: new Date(Date.now() + 365 * 86400000),
    send: async (log) => { consideredIds.push(log.id); sentTo.push(log.sent_to_email); return { ok: true, id: 'x' }; },
  });
  const mine = bf[0].id;
  const rows = (await P.query(
    `SELECT id FROM outreach_logs WHERE status='approved' AND scheduled_send_at IS NOT NULL
       AND cadence_stopped_at IS NULL AND id = $1`, [mine])).rows;
  check('releaseDue cannot select it — it matches none of the send predicate',
    rows.length === 0, JSON.stringify(rows));
  check('  it was not among the rows releaseDue considered',
    !consideredIds.includes(mine), JSON.stringify(consideredIds.slice(0, 3)));
  check('  and its address never reached the provider',
    !sentTo.includes('hello@ecrecoverable.com'), JSON.stringify(sentTo.slice(0, 3)));
  console.log('    (releaseDue considered ' + rel.considered + ' unrelated rows from other suites)');
  check('  because it selects status=approved with a scheduled time',
    /WHERE l\.status = 'approved'[\s\S]{0,200}scheduled_send_at IS NOT NULL/.test(
      require('fs').readFileSync(ROOT + 'server/services/closer.js', 'utf8')));

  // And the only route to `approved` is a person pressing the button.
  const srv = require('fs').readFileSync(ROOT + 'server/index.js', 'utf8');
  check('approveBatch has exactly one caller in the server', 
    (srv.match(/Closer\.approveBatch\(/g) || []).length === 1);
  check('  and it is behind requireAuth',
    /app\.post\('\/api\/agent\/closer\/approve', requireAuth/.test(srv));
  check('nothing auto-approves: autoModeFor is never called',
    (require('fs').readFileSync(ROOT + 'server/services/closer.js', 'utf8')
      .match(/autoModeFor\(/g) || []).length === 1);

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
