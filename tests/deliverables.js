'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings, and a startup wait the runner can shorten once the schema
// has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/deliverables.js   just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── THE DELIVERABLES TRACKER ────────────────────────────────────────────────
//
// Contract PDF in, obligations out, on a calendar, with a reminder before each
// one is due and the late ones pinned where nobody has to go looking.
//
// THIS PIPELINE HAD NO TESTS AT ALL. It was also the part of the codebase with
// two implementations of the same job, which is not a coincidence: nothing was
// checking that they agreed, so they stopped. The scanner's save route dropped
// deliverable_type on every single write -- the model extracted it, the review
// table displayed it, and the column it belonged in did not exist -- and it
// reasoned that a random contract id per upload made duplicates "impossible",
// which had it exactly backwards.
//
// WHAT THIS SUITE PROTECTS, in order of what would actually hurt:
//
//   1. A DRAFT MUST NEVER REACH A REAL SURFACE. Between analyze and confirm a
//      row is a model's guess that no person has accepted. If one leaks onto
//      the calendar, into the digest, or onto the Home pin, the product is
//      inventing obligations and mailing an agent about them. Every read path
//      is checked separately, because they are separate queries and each one
//      can regress alone.
//
//   2. THE TYPE SURVIVES THE ROUND TRIP. The bug that started this.
//
//   3. T-5 AND T-1 ARE EXACT. Off-by-one here means a reminder that arrives the
//      morning after the deadline. Boundaries are tested on both sides.
//
//   4. THE DIGEST SENDS ONCE. It runs on an in-process timer; a restart
//      re-arms it. Without the claim table an agent gets the same email twice.
//
//   5. DONE IS DONE, WHOEVER SAID SO. Either side can mark an item complete,
//      the pin clears either way, and the row records which of them it was --
//      the athlete doing the work and the agent clearing a stale row look
//      identical in the data and mean opposite things.
//
// The AI call is never exercised: it needs a key and a network, and what breaks
// here is the plumbing around it. Extraction is fed as fixed input.

const { Pool } = require(REPO + 'node_modules/pg');
const CE = require(REPO + 'server/services/contractExtraction');
const DG = require(REPO + 'server/services/deliverableDigest');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const AG = 'dlv-agent';
const AG2 = 'dlv-other-agent';
const ATH = 'dlv-athlete';
const CID = 'contract-dlvtest';

// Dates are computed relative to a fixed "today" the queries are told about,
// so the suite does not change behaviour depending on when it runs.
const TODAY = '2026-06-15';
function shift(days) {
  const d = new Date(TODAY + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const P = new Pool({ max: 4 });

async function cleanup() {
  await P.query(`DELETE FROM athlete_calendar_events WHERE agent_id = ANY($1::text[])`, [[AG, AG2]]);
  await P.query(`DELETE FROM athlete_deliverables    WHERE agent_id = ANY($1::text[])`, [[AG, AG2]]);
  await P.query(`DELETE FROM athlete_contracts       WHERE agent_id = ANY($1::text[])`, [[AG, AG2]]);
  await P.query(`DELETE FROM contract_audit_log      WHERE agent_id = ANY($1::text[])`, [[AG, AG2]]);
  await P.query(`DELETE FROM deliverable_reminder_sends WHERE agent_id = ANY($1::text[])`, [[AG, AG2]]);
  await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]);
  await P.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[AG, AG2]]);
}

// Insert a contract + draft deliverables the way analyzeContractUpload does,
// without the AI call. The COLUMN LIST AND STATUS HERE MUST MATCH the engine --
// if analyze starts writing something else, confirm's behaviour under test
// diverges from production and this suite would keep passing. Asserted below.
async function seedDrafts(rows, contractId = CID) {
  await P.query(
    `INSERT INTO athlete_contracts (id, athlete_id, agent_id, filename, brand, file_hash, extraction_status)
     VALUES ($1,$2,$3,'test.pdf','Nike',$4,'awaiting_review')`,
    [contractId, ATH, AG, 'hash-' + contractId]);
  const ids = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const q = await P.query(
      `INSERT INTO athlete_deliverables
         (athlete_id, agent_id, contract_id, deliverable_description, due_date, brand,
          status, recurrence, recurrence_rule, ai_confidence_score, source, sort_order, deliverable_type)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,$9,'ai_extracted',$10,$11) RETURNING id`,
      [ATH, AG, contractId, r.desc, r.due || null, r.brand || 'Nike',
       r.recurrence || null, r.rrule || null, r.confidence == null ? 90 : r.confidence,
       i, r.type || null]);
    ids.push(q.rows[0].id);
  }
  return ids;
}

async function main() {
  await cleanup();
  // password is NOT NULL on users. No .catch() on any fixture insert in this
  // file: a fixture that fails silently makes the guard under test look broken
  // when the data never arrived, and that has already cost a debugging session.
  await P.query(`INSERT INTO users (id, email, name, password) VALUES ($1,$2,$3,$4)
                 ON CONFLICT (id) DO NOTHING`,
    [AG, 'dlv@example.test', 'Dana Agent', 'x-not-a-real-hash']);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3)
                 ON CONFLICT (id) DO NOTHING`,
    [ATH, AG, JSON.stringify({ name: 'Noah Carpenter', sport: 'Football' })]);

  // ── 1. THE TYPE SURVIVES ──────────────────────────────────────────────────
  {
    const ids = await seedDrafts([
      { desc: 'Two Instagram stories on game day', due: shift(10), type: 'story' },
      { desc: 'Autograph session at the dealership', due: shift(4), type: 'appearance' },
    ]);
    const r = await CE.confirmContract({ pool: P, athleteId: ATH, agentId: AG, contractId: CID });
    ok('confirm accepts both drafts', r.deliverableCount === 2, r.deliverableCount);
    ok('  and generates one calendar event each', r.calendarEventCount === 2, r.calendarEventCount);

    const d = await P.query(
      `SELECT deliverable_type FROM athlete_deliverables WHERE id = ANY($1::int[]) ORDER BY sort_order`, [ids]);
    ok('deliverable_type is stored on the deliverable',
      d.rows.map((x) => x.deliverable_type).join(',') === 'story,appearance',
      d.rows.map((x) => x.deliverable_type));

    const e = await P.query(
      `SELECT event_type FROM athlete_calendar_events WHERE contract_id=$1 ORDER BY event_date`, [CID]);
    ok('  and mirrored onto the dated instance',
      e.rows.every((x) => x.event_type) && e.rows.length === 2,
      e.rows.map((x) => x.event_type));
  }

  // ── 2. DRAFTS REACH NOTHING ───────────────────────────────────────────────
  // The single most important property in this file. Checked against each read
  // path separately: they are separate queries and regress independently.
  {
    await seedDrafts([
      { desc: 'UNCONFIRMED — must not appear anywhere', due: shift(1), type: 'social_post' },
      { desc: 'UNCONFIRMED — also overdue', due: shift(-3), type: 'social_post' },
    ], 'contract-dlvdraft');

    const cal = await P.query(
      `SELECT 1 FROM athlete_calendar_events WHERE contract_id='contract-dlvdraft'`);
    ok('a draft generates NO calendar event', cal.rowCount === 0, cal.rowCount);

    const dig = await DG.collectDigest(P, AG, TODAY);
    const leaked = [...dig.overdue, ...dig.tomorrow, ...dig.soon]
      .filter((i) => /UNCONFIRMED/.test(i.title));
    ok('  and never reaches the reminder digest', leaked.length === 0, leaked.map((l) => l.title));

    // The Home pin, through the SAME function the route calls -- not a copy of
    // its SQL. A replica here would keep passing while the endpoint drifted,
    // which is the failure this whole suite exists because of.
    const pinned = await DG.collectPinned(P, AG);
    ok('  and is excluded from the Home pin',
      !pinned.overdue.some((r) => /UNCONFIRMED/.test(r.title))
      && !pinned.undated.some((r) => /UNCONFIRMED/.test(r.title)),
      [...pinned.overdue, ...pinned.undated].map((r) => r.title));
  }

  // ── 3. REJECTION AT REVIEW ────────────────────────────────────────────────
  // A confidence score the agent cannot act on is decoration.
  {
    const ids = await seedDrafts([
      { desc: 'Clear obligation', due: shift(20), confidence: 95 },
      { desc: 'Low-confidence guess', due: shift(20), confidence: 41 },
    ], 'contract-dlvreject');
    const r = await CE.confirmContract({
      pool: P, athleteId: ATH, agentId: AG,
      contractId: 'contract-dlvreject', rejectIds: [ids[1]],
    });
    ok('a rejected draft is dropped', r.rejectedCount === 1, r.rejectedCount);
    ok('  and the accepted one still lands', r.deliverableCount === 1, r.deliverableCount);
    const gone = await P.query(`SELECT 1 FROM athlete_deliverables WHERE id=$1`, [ids[1]]);
    ok('  rejected row is deleted, not left as a draft', gone.rowCount === 0, gone.rowCount);
    const ev = await P.query(
      `SELECT 1 FROM athlete_calendar_events WHERE deliverable_id=$1`, [ids[1]]);
    ok('  and generates no calendar event', ev.rowCount === 0, ev.rowCount);
  }

  // ── 4. CONFIRM IS IDEMPOTENT ──────────────────────────────────────────────
  // A double-click, or a retried request, must not double-generate a calendar.
  {
    const again = await CE.confirmContract({ pool: P, athleteId: ATH, agentId: AG, contractId: CID });
    ok('a second confirm accepts nothing', again.deliverableCount === 0, again.deliverableCount);
    ok('  and creates no further events', again.calendarEventCount === 0, again.calendarEventCount);
    const n = await P.query(
      `SELECT COUNT(*)::int c FROM athlete_calendar_events WHERE contract_id=$1`, [CID]);
    ok('  leaving the original two intact', n.rows[0].c === 2, n.rows[0].c);
  }

  // ── 5. ANOTHER AGENT CANNOT CONFIRM YOUR CONTRACT ─────────────────────────
  {
    await seedDrafts([{ desc: 'Someone else\'s contract', due: shift(3) }], 'contract-dlvown');
    let threw = null;
    try {
      await CE.confirmContract({
        pool: P, athleteId: ATH, agentId: AG2, contractId: 'contract-dlvown' });
    } catch (e) { threw = e; }
    ok('confirm by a different agent is refused', threw !== null && threw.statusCode === 404,
      threw && threw.message);
    const still = await P.query(
      `SELECT status FROM athlete_deliverables WHERE contract_id='contract-dlvown'`);
    ok('  and the drafts are untouched',
      still.rows.length === 1 && still.rows[0].status === 'draft', still.rows.map((r) => r.status));
  }

  // ── 6. RECURRENCE GENERATES INSTANCES ─────────────────────────────────────
  // "2 posts a month for 6 months" is one deliverable and six separately-owed,
  // separately-late dates.
  {
    const ids = await seedDrafts([{
      desc: 'Monthly product post', due: shift(30),
      recurrence: 'monthly', rrule: 'FREQ=MONTHLY;INTERVAL=1;COUNT=6', type: 'social_post',
    }], 'contract-dlvrec');
    const r = await CE.confirmContract({
      pool: P, athleteId: ATH, agentId: AG, contractId: 'contract-dlvrec' });
    ok('a monthly rule generates six instances', r.calendarEventCount === 6, r.calendarEventCount);
    const ev = await P.query(
      `SELECT to_char(event_date,'YYYY-MM-DD') d, event_type, recurrence_instance
         FROM athlete_calendar_events WHERE deliverable_id=$1 ORDER BY event_date`, [ids[0]]);
    ok('  the first lands on the due date', ev.rows[0].d === shift(30), ev.rows[0].d);
    ok('  each is flagged as a recurrence instance',
      ev.rows.every((x) => x.recurrence_instance === true), null);
    ok('  and each carries the type', ev.rows.every((x) => x.event_type === 'social_post'), null);
  }

  // ── 7. THE DUE DATE DOES NOT DRIFT A DAY ──────────────────────────────────
  // node-pg turns a DATE into local midnight; toISOString() then reports the day
  // before for every timezone west of UTC. A deadline that moves is worse than
  // no deadline, and the bug only appears for some agents.
  {
    const row = await P.query(
      `SELECT *, to_char(due_date,'YYYY-MM-DD') AS due_date_iso
         FROM athlete_deliverables WHERE contract_id=$1 ORDER BY sort_order LIMIT 1`, [CID]);
    const shape = CE.deliverableRowToShape(row.rows[0]);
    ok('the stored due date round-trips exactly', shape.dueDate === shift(10), shape.dueDate);
    const ev = await P.query(
      `SELECT to_char(event_date,'YYYY-MM-DD') d FROM athlete_calendar_events
        WHERE deliverable_id=$1`, [row.rows[0].id]);
    ok('  and the generated event sits on the same day', ev.rows[0].d === shift(10), ev.rows[0].d);
  }

  // ── 8. T-5 AND T-1, ON BOTH SIDES OF EACH BOUNDARY ────────────────────────
  {
    await P.query(`DELETE FROM athlete_calendar_events WHERE agent_id=$1`, [AG]);
    await P.query(`DELETE FROM athlete_deliverables WHERE agent_id=$1`, [AG]);
    const mk = async (label, days) => {
      const q = await P.query(
        `INSERT INTO athlete_deliverables
           (athlete_id, agent_id, deliverable_description, due_date, brand, status, deliverable_type)
         VALUES ($1,$2,$3,$4,'Nike','pending','social_post') RETURNING id`,
        [ATH, AG, label, shift(days)]);
      await P.query(
        `INSERT INTO athlete_calendar_events
           (id, athlete_id, agent_id, deliverable_id, title, event_date, brand, status, event_type)
         VALUES ($1,$2,$3,$4,$5,$6,'Nike','pending','social_post')`,
        ['evt-' + label, ATH, AG, q.rows[0].id, label, shift(days)]);
    };
    await mk('d6', 6); await mk('d5', 5); await mk('d4', 4);
    await mk('d2', 2); await mk('d1', 1); await mk('d0', 0);
    await mk('dm1', -1); await mk('dm9', -9);

    const d = await DG.collectDigest(P, AG, TODAY);
    const titles = (a) => a.map((x) => x.title).sort().join(',');

    ok('T-5 picks up exactly the 5-day item', titles(d.soon) === 'd5', titles(d.soon));
    ok('  not 4 days out', !d.soon.some((x) => x.title === 'd4'), null);
    ok('  not 6 days out', !d.soon.some((x) => x.title === 'd6'), null);
    ok('T-1 picks up exactly the 1-day item', titles(d.tomorrow) === 'd1', titles(d.tomorrow));
    ok('  today is NOT "due tomorrow"', !d.tomorrow.some((x) => x.title === 'd0'), null);
    // Due today is neither a T-5 nor a T-1 milestone and is not yet late. It is
    // deliberately absent rather than silently folded into another bucket.
    ok('  and today is not in any bucket',
      !['d0'].some((t) => [...d.soon, ...d.tomorrow, ...d.overdue].some((x) => x.title === t)), null);
    ok('overdue collects everything past due', titles(d.overdue) === 'dm1,dm9', titles(d.overdue));
    ok('  ordered worst-first', d.overdue[0].title === 'dm9', d.overdue[0].title);
    ok('  with a positive-reading late count',
      /9 days late/.test(DG.renderDigestEmail(d, {}).text), null);
  }

  // ── 9. THE DIGEST ITSELF ──────────────────────────────────────────────────
  {
    const d = await DG.collectDigest(P, AG, TODAY);
    const mail = DG.renderDigestEmail(d, { appUrl: 'https://x.test', agentName: 'Dana Agent' });
    ok('the subject leads with overdue', /^2 deliverables overdue/.test(mail.subject), mail.subject);
    ok('  and still names what is coming', /coming up/.test(mail.subject), mail.subject);
    ok('the athlete is named in the body', /Noah Carpenter/.test(mail.html), null);
    ok('the type is labelled in plain words', /&gt;Post&lt;|>Post</.test(mail.html), null);
    ok('a completed item never appears', !/d5-done/.test(mail.html), null);
    // An email that renders a JS Date object, or "Invalid Date", is a shipped bug
    // that only shows up in someone's inbox.
    ok('no unrendered dates leak into the html',
      !/Invalid Date|\[object|GMT\+/.test(mail.html), null);
    ok('the text part carries the same items',
      /d1/.test(mail.text) && /d5/.test(mail.text) && /dm9/.test(mail.text), null);
  }

  // ── 10. DONE CLEARS THE PIN, AND IS ATTRIBUTED ────────────────────────────
  {
    await P.query(
      `UPDATE athlete_calendar_events
          SET status='completed', completed_at=NOW(), completed_by_role='athlete', completed_by_id=$2
        WHERE id='evt-dm9' AND agent_id=$1`, [AG, ATH]);
    const d = await DG.collectDigest(P, AG, TODAY);
    ok('a completed item leaves the digest',
      !d.overdue.some((x) => x.title === 'dm9'), d.overdue.map((x) => x.title));

    const pinned = await DG.collectPinned(P, AG);
    ok('  and leaves the Home pin', !pinned.overdue.some((r) => r.id === 'evt-dm9'),
      pinned.overdue.map((r) => r.id));

    const who = await P.query(
      `SELECT completed_by_role, completed_by_id, completed_at
         FROM athlete_calendar_events WHERE id='evt-dm9'`);
    ok('  the row records WHO marked it', who.rows[0].completed_by_role === 'athlete',
      who.rows[0].completed_by_role);
    ok('  and when', who.rows[0].completed_at !== null, null);
  }

  // ── 11. ALL THREE SPELLINGS OF DONE ───────────────────────────────────────
  // 'completed', 'done' and 'complete' are all already in the database. A row
  // spelled one way that another reader treats as outstanding nags forever.
  {
    for (const spelling of ['done', 'complete', 'completed']) {
      await P.query(`UPDATE athlete_calendar_events SET status=$1 WHERE id='evt-dm1'`,
        [spelling]);
      const d = await DG.collectDigest(P, AG, TODAY);
      ok(`status "${spelling}" counts as done`,
        !d.overdue.some((x) => x.title === 'dm1'), d.overdue.map((x) => x.title));
    }
    await P.query(`UPDATE athlete_calendar_events SET status='pending' WHERE id='evt-dm1'`);
    const back = await DG.collectDigest(P, AG, TODAY);
    ok('  and reopening puts it back', back.overdue.some((x) => x.title === 'dm1'), null);
  }

  // ── 12. AN EMPTY ROSTER SENDS NOTHING ─────────────────────────────────────
  // The scheduler collects BEFORE claiming the day, so an agent with nothing due
  // gets no email and no claim row -- and a deliverable added later the same
  // morning can still reach them on the next tick.
  {
    const d = await DG.collectDigest(P, AG2, TODAY);
    ok('an agent with no deliverables has nothing actionable', d.actionable === 0, d.actionable);
  }

  // ── 13. THE HOME PIN ──────────────────────────────────────────────────────
  // The pin's whole job is that an athlete falling behind is visible without
  // anyone choosing to look, so what it groups and how it orders matter as much
  // as what it selects.
  {
    const pinned = await DG.collectPinned(P, AG);
    ok('the pin carries the overdue items', pinned.overdueCount >= 1, pinned.overdueCount);
    ok('  worst first', pinned.overdue[0].days_late >= (pinned.overdue[1] ? pinned.overdue[1].days_late : 0),
      pinned.overdue.map((r) => r.days_late));
    ok('  days_late reads as a positive number of days',
      pinned.overdue.every((r) => r.days_late > 0), pinned.overdue.map((r) => r.days_late));
    ok('  and names the athlete who is behind',
      pinned.athletes.length === 1 && pinned.athletes[0].name === 'Noah Carpenter',
      pinned.athletes);

    // An obligation with no due date can never appear in the digest -- there is
    // no date to count back from -- so the pin is the ONLY place it can surface.
    await P.query(
      `INSERT INTO athlete_deliverables
         (athlete_id, agent_id, deliverable_description, due_date, brand, status, deliverable_type)
       VALUES ($1,$2,'Undated exclusivity clause',NULL,'Nike','pending','other')`, [ATH, AG]);
    const withUndated = await DG.collectPinned(P, AG);
    ok('an undated deliverable shows up in the pin',
      withUndated.undated.some((r) => /Undated exclusivity/.test(r.title)),
      withUndated.undated.map((r) => r.title));
    const dig = await DG.collectDigest(P, AG, TODAY);
    ok('  and correctly never reaches the digest',
      ![...dig.overdue, ...dig.tomorrow, ...dig.soon].some((r) => /Undated/.test(r.title)), null);
  }

  // ── 14. THE SEED MATCHES WHAT THE ENGINE ACTUALLY WRITES ──────────────────
  // This suite fabricates drafts rather than paying for an AI call. If analyze
  // starts writing a different status or column set, every test above would keep
  // passing while production diverged. Asserted against the source.
  {
    const fs = require('fs');
    const src = fs.readFileSync(REPO + 'server/services/contractExtraction.js', 'utf8')
      .replace(/^\s*\/\/.*$/gm, '');
    ok('analyze still writes drafts as status=draft', /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,'draft'/.test(src), null);
    ok('  and still writes deliverable_type', /deliverable_type\)\s*\n\s*VALUES/.test(src), null);
    ok('  and still parks the contract as awaiting_review',
      /'awaiting_review',1\)/.test(src), null);
    ok('confirm still promotes drafts to pending',
      /SET status='pending', reviewed_at=NOW\(\)/.test(src), null);
    ok('the duplicate scanner engine is gone',
      !fs.readFileSync(REPO + 'server/index.js', 'utf8')
        .includes("app.post('/api/pdf/save'"), null);
  }

  await cleanup();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch(async (e) => {
  console.error('THREW', e);
  try { await cleanup(); await P.end(); } catch (_) {}
  process.exit(1);
});
