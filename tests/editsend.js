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
// THE ONE QUESTION THIS FILE ANSWERS: when an agent edits a draft and approves
// it, does the EDITED text reach the provider, or the original?
//
// Not asserted from reading the code. The provider's sendEmail is replaced with
// a recorder, the real closer.approveBatch and closer.releaseDue are run, and
// what the recorder captured is compared against both versions.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const Closer = require(ROOT + 'server/services/closer.js');
const Home = require(ROOT + 'server/services/homeQueue.js');
const sendWindow = require(ROOT + 'server/services/sendWindow.js');

// A real instant inside the real send window, found with the shipping predicate
// rather than hardcoded -- the window is Tue-Thu mid-morning in the RECIPIENT's
// timezone, and hardcoding a timestamp would make this test fail on a Friday.
function aSendableTime() {
  const t = new Date();
  for (let i = 0; i < 24 * 14; i++) {
    if (sendWindow.isSendable(t, {})) return new Date(t);
    t.setUTCHours(t.getUTCHours() + 1);
  }
  throw new Error('no sendable hour found in two weeks');
}

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

const AG = 'ed-agent', ATH = 'ed-ath', LOG = 'ed-log-1';
const ORIG_SUBJ = 'A partnership idea';
const ORIG_BODY = '<p>Hi there,</p><p>THE ORIGINAL SENTENCE THE MODEL WROTE.</p>';
const NEW_SUBJ  = 'Quick idea for Vigilante Coffee';
const NEW_TEXT  = 'Hi Eric,\n\nTHE SENTENCE THE AGENT TYPED INSTEAD.\n\nWorth a short call?';

// The route's own converter, lifted so the test runs the shipping one.
function liftFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('cannot lift ' + name);
}
const fs = require('fs');
const textToHtml = eval('(' + liftFn(fs.readFileSync(ROOT + 'server/routes/outreach.js', 'utf8'), 'textToHtml') + ')');

// The PATCH handler's UPDATE, verbatim, so this exercises what ships.
async function editDraft(P, id, agentId, subject, bodyText) {
  const body_html = textToHtml(bodyText);
  const before = await P.query(
    `SELECT subject, body_html FROM outreach_logs WHERE id=$1 AND agent_id=$2 AND status='draft'`,
    [id, agentId]);
  const prev = before.rows[0];
  const changed = !!prev && (String(prev.subject || '') !== String(subject || '')
    || String(prev.body_html || '') !== String(body_html || ''));
  const r = await P.query(
    `UPDATE outreach_logs SET subject=$1, body_html=$2, updated_at=NOW(),
            edited_before_approval = edited_before_approval OR $5,
            original_subject   = COALESCE(original_subject,   CASE WHEN $5 THEN $6 END),
            original_body_html = COALESCE(original_body_html, CASE WHEN $5 THEN $7 END)
     WHERE id=$3 AND agent_id=$4 AND status='draft'
     RETURNING *`,
    [subject, body_html, id, agentId, changed,
      (prev && prev.subject) || null, (prev && prev.body_html) || null]);
  return r.rows[0];
}

async function seed(P) {
  for (const t of ['outreach_logs', 'outreach_queue', 'athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM agent_send_budget WHERE agent_id=$1`, [AG]).catch(() => {});
  // A hold from an earlier run survives the draft it was raised on and is
  // re-read by the gate, so an old alcohol hold kept this brand blocked under a
  // new name.
  await P.query(`DELETE FROM compliance_holds WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM compliance_holds WHERE athlete_id=$1`, [ATH]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role,report_tz)
                 VALUES ($1,'Jordan','ed@x.com','x','agent','America/New_York')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Marcus Johnson', school: 'Alabama', dob: '2004-09-02' })]);
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,
                                sent_to_email,created_at)
     VALUES ($1,$2,$3,'Vigilante Coffee Company',$4,$5,'draft','chris@vigilantecoffee.com',NOW())`,
    [LOG, AG, ATH, ORIG_SUBJ, ORIG_BODY]);
  // The compliance gate checks the business CATEGORY against the restricted
  // list and holds anything it cannot verify. A real business has a Places
  // record; without one this test would only ever prove the gate works.
  for (const [key, brand, types] of [
    ['ed:place:1', 'Vigilante Coffee Company', ['cafe', 'coffee_shop', 'food']],
    ['ed:place:2', 'Trak Shak', ['shoe_store', 'store']],
  ]) {
    await P.query(
      `INSERT INTO brand_evidence_cache (brand_key,lane,brand,website,evidence,refreshed_at)
       VALUES ($1,'places',$2,'x',$3,NOW())
       ON CONFLICT (brand_key,lane) DO UPDATE SET brand=EXCLUDED.brand, evidence=EXCLUDED.evidence`,
      [key, brand, JSON.stringify({ types, primaryType: types[0], name: brand })]);
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await seed(P);

  console.log('\n1. THE EDIT LANDS, AND THE ORIGINAL IS KEPT');
  const saved = await editDraft(P, LOG, AG, NEW_SUBJ, NEW_TEXT);
  check('subject is the edited one', saved.subject === NEW_SUBJ, saved.subject);
  check('body carries the agent\'s sentence', /THE SENTENCE THE AGENT TYPED/.test(saved.body_html));
  check('body no longer carries the model\'s', !/THE ORIGINAL SENTENCE/.test(saved.body_html));
  check('the edit is flagged', saved.edited_before_approval === true);
  check('original_subject holds what the model wrote', saved.original_subject === ORIG_SUBJ, saved.original_subject);
  check('original_body_html holds it too', /THE ORIGINAL SENTENCE/.test(saved.original_body_html || ''));
  check('text became paragraphs, not one blob',
    (saved.body_html.match(/<p>/g) || []).length === 3, saved.body_html);
  check('no markup from the client survives as markup',
    !/<script|<img/i.test(saved.body_html));

  console.log('\n2. A SECOND EDIT DOES NOT OVERWRITE THE ORIGINAL');
  const again = await editDraft(P, LOG, AG, 'Third version', 'Changed my mind again.');
  check('original_subject is still the model\'s first version',
    again.original_subject === ORIG_SUBJ, again.original_subject);
  check('original_body_html is still the first', /THE ORIGINAL SENTENCE/.test(again.original_body_html || ''));
  // Put the real edit back for the send test.
  await P.query(`UPDATE outreach_logs SET subject=$2, body_html=$3 WHERE id=$1`,
    [LOG, NEW_SUBJ, textToHtml(NEW_TEXT)]);

  console.log('\n3. SAVING AN UNCHANGED DRAFT IS NOT AN EDIT');
  await P.query(`DELETE FROM outreach_logs WHERE id='ed-log-2'`).catch(() => {});
  await P.query(
    `INSERT INTO outreach_logs (id,agent_id,athlete_id,brand_name,subject,body_html,status,sent_to_email,created_at)
     VALUES ('ed-log-2',$1,$2,'Trak Shak',$3,$4,'draft','jeff@trakshak.com',NOW())`,
    [AG, ATH, 'Subject B', '<p>Line one.</p>']);
  const noop = await editDraft(P, 'ed-log-2', AG, 'Subject B', 'Line one.');
  check('an unchanged save does not set the edited flag', noop.edited_before_approval === false);
  check('and stamps no original', !noop.original_subject && !noop.original_body_html,
    JSON.stringify([noop.original_subject, noop.original_body_html]));

  console.log('\n4. HOME SHOWS THE EDITED VERSION AFTER A RELOAD');
  const h = await Home.buildHome(P, AG, { athleteId: ATH });
  // NAMESPACED NOW. Home is a mixed queue of two tables with separate id spaces,
  // so every card id carries the table it came from. The bare id is what the
  // outreach_logs routes still take, and it is what a page cached before this
  // shipped will post -- both are asserted below.
  const card = (h.cards || []).find((c) => c.id === 'email:' + LOG);
  check('the card exists, under a namespaced id', !!card,
    JSON.stringify((h.cards || []).map((c) => c.id)));
  check('it shows the edited subject', card && card.subject === NEW_SUBJ, card && card.subject);
  check('it shows the edited body', card && /THE SENTENCE THE AGENT TYPED/.test(card.bodyText || ''));
  check('and never the original', card && !/THE ORIGINAL SENTENCE/.test(card.bodyText || ''));
  check('the card is marked as edited', card && card.edited === true);

  console.log('\n5. APPROVE');
  await P.query(`UPDATE outreach_logs SET status='draft' WHERE id=$1`, [LOG]);
  // A BARE ID, ON PURPOSE. This is the shape a browser tab cached before the
  // namespace shipped will post at 8am on the morning of the deploy. It must
  // still approve, because the only thing that page ever showed was email
  // drafts -- while a queue id, which such a page could never have held, throws.
  const ap = await Closer.approveBatch(P, AG, { ids: [LOG], athleteId: ATH });
  check('a bare id from a stale cached page still approves', ap.scheduled >= 0, JSON.stringify(ap.note));
  const afterApprove = (await P.query(`SELECT status, subject, body_html, scheduled_send_at
                                         FROM outreach_logs WHERE id=$1`, [LOG])).rows[0];
  check('the draft is approved', afterApprove.status === 'approved', afterApprove.status);
  check('approval did not revert the subject', afterApprove.subject === NEW_SUBJ, afterApprove.subject);
  check('approval kept the edited body', /THE SENTENCE THE AGENT TYPED/.test(afterApprove.body_html));
  check('and did not resurrect the original', !/THE ORIGINAL SENTENCE/.test(afterApprove.body_html));

  console.log('\n6. WHAT THE PROVIDER ACTUALLY RECEIVES');
  // Due now, so releaseDue picks it up.
  await P.query(`UPDATE outreach_logs SET scheduled_send_at = NOW() - INTERVAL '1 minute' WHERE id=$1`, [LOG]);
  const wire = [];
  const WHEN = aSendableTime();
  console.log('    sending at ' + WHEN.toISOString() + ' (inside the real window)');
  const res = await Closer.releaseDue(P, {
    now: WHEN,
    send: async (log) => {
      // EXACTLY what closerRelease.buildSend hands the provider.
      wire.push({ to: log.sent_to_email, subject: log.subject, bodyHtml: log.body_html });
      return { providerMessageId: 'p1', providerThreadId: null };
    },
  });
  // ── SCOPED TO THIS DRAFT ────────────────────────────────────────────────
  // releaseDue is global. This asserted `wire.length === 1` and then read
  // wire[0], which held only while this suite ran alone -- inside the runner,
  // compliance.js leaves its own approved draft behind and sends first, so this
  // suite was reading someone else's email and reporting it as a send-path
  // failure. The assertion is about THIS message, found by its recipient.
  const mine = wire.filter((w) => w.to === 'chris@vigilantecoffee.com');
  if (!mine.length) console.log('    HELD: ' + JSON.stringify(res.detail || res, null, 1).slice(0, 700));
  check('this draft went out exactly once', mine.length === 1,
    'mine=' + mine.length + ' otherSuites=' + (wire.length - mine.length)
    + ' considered=' + res.considered);
  const sent = mine[0] || {};
  console.log('    SUBJECT ON THE WIRE: ' + JSON.stringify(sent.subject));
  console.log('    BODY ON THE WIRE:    ' + JSON.stringify(String(sent.bodyHtml || '').slice(0, 120)));
  check('THE SUBJECT ON THE WIRE IS THE EDITED ONE', sent.subject === NEW_SUBJ, sent.subject);
  check('THE BODY ON THE WIRE IS THE AGENT\'S TEXT',
    /THE SENTENCE THE AGENT TYPED/.test(sent.bodyHtml || ''));
  check('THE ORIGINAL NEVER REACHES THE PROVIDER',
    !/THE ORIGINAL SENTENCE/.test(sent.bodyHtml || ''));
  check('the recipient is unchanged', sent.to === 'chris@vigilantecoffee.com', sent.to);
  check('and nothing this suite owns was sent twice',
    wire.filter((w) => w.to === 'chris@vigilantecoffee.com').length === 1);

  console.log('\n7. THE ORIGINAL IS STILL ON THE ROW AFTER SENDING');
  const post = (await P.query(
    `SELECT status, original_subject, original_body_html, edited_before_approval
       FROM outreach_logs WHERE id=$1`, [LOG])).rows[0];
  check('the row is sent', post.status === 'sent', post.status);
  check('the original subject survived the send', post.original_subject === ORIG_SUBJ, post.original_subject);
  check('the original body survived too', /THE ORIGINAL SENTENCE/.test(post.original_body_html || ''));
  check('the edited flag survived, for the auto-mode signal', post.edited_before_approval === true);

  console.log('\n8. AN UNEDITED DRAFT STILL SENDS WHAT THE MODEL WROTE');
  await P.query(`UPDATE outreach_logs SET status='draft', scheduled_send_at=NULL WHERE id='ed-log-2'`);
  await Closer.approveBatch(P, AG, { ids: ['ed-log-2'], athleteId: ATH });
  await P.query(`UPDATE outreach_logs SET scheduled_send_at = NOW() - INTERVAL '1 minute' WHERE id='ed-log-2'`);
  const wire2 = [];
  await Closer.releaseDue(P, { now: aSendableTime(),
    send: async (log) => { wire2.push(log); return { providerMessageId: 'p2' }; } });
  check('it went out', wire2.length === 1, 'sent=' + wire2.length);
  check('carrying the untouched text', /Line one/.test((wire2[0] || {}).body_html || ''),
    String((wire2[0] || {}).body_html || '').slice(0, 80));

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
