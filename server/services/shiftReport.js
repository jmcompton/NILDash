'use strict';
// ── THE SHIFT REPORT: ONE SOURCE ─────────────────────────────────────────────
//
// The home page and the daily email are the same report. They are built here so
// they cannot drift: if the sentence changes, it changes in both, and a number
// that appears on the page is the number that arrives in the inbox.
//
// THE RULE: every number is counted from rows that exist, or it is absent. Not
// zero -- absent. A role that did nothing is not named in the sentence, because
// "and drafted 0 pitches" is noise that makes the real counts harder to read.
//
// WHERE EACH NUMBER COMES FROM:
//   Scout       brand_evidence_cache lane='places'   -> businesses checked
//               outreach_queue                        -> how many became cards
//   Researcher  lane='contacts'                       -> named contacts found
//               lane='siteemail'                      -> how many are emailable
//   Writer      outreach_logs status='draft'          -> pitches drafted
//               outreach_queue.dm_text                -> DM scripts written
//   Closer      outreach_logs.sent_at / replied_at    -> sent, replies in
//   Analyst     athlete_activity_log                  -> media_kit_built,
//                                                        valuation_run
//
// THE WINDOW. outreach_queue_runs is the only record that a nightly run
// happened, so its latest row anchors everything. Work is bracketed around that
// timestamp rather than counted over a calendar day: the job fires at 3am
// Central and its artifacts land over the following minutes, while a calendar
// day would also sweep up whatever the agent did by hand at 4pm and credit it
// to the team. The bracket opens slightly BEFORE the run because ladderPrewarm
// warms contacts while the scan is still being written.
//
// WHY THE WINDOW NOW CLOSES ON finished_at. It used to close a flat 12 hours
// after the claim, and that is how the daily email and the home page came to
// disagree about the same morning. Neither was wrong and neither used a
// different query -- they ran at different times against a window that was still
// open. The night claims at 1am Central; the email goes at 7am and counts what
// exists then; the agent opens the app at midday and GET /outreach-queue kicks
// off runOnDemandFills, which places the slots the night deliberately left empty.
// Those cards and drafts land before 1pm, so the old window counted them as part
// of "last night" -- the page reported the night PLUS the work the page itself
// had just caused. Two pitches at 7am, fourteen by noon, same query.
//
// Closing on finished_at makes the sentence mean one thing: what the overnight
// run produced. Everything the day adds is counted separately, in `added`, and
// said in its own words rather than backdated into the night.
const SHIFT_PRE_HOURS = 2;
// Only for rows written before finished_at existed, and as the ceiling on a run
// that never stamped an end.
const SHIFT_POST_HOURS = 12;
// Artifacts that land just after the last athlete -- the details UPDATE and the
// trailing cache writes -- belong to the run, not to the morning.
const SHIFT_GRACE_MIN = 15;

// ── Caps ─────────────────────────────────────────────────────────────────────
// A queue item may never contain a pile. "155 pitches waiting on your approval"
// is not a decision, it is a wall, and nobody reviews 155 drafts -- so an item
// represents at most this many and the rest wait their turn.
const ITEM_MAX = 10;
// Five items on the page, hard. Anything past that is one quiet line, never a
// longer list.
const QUEUE_MAX = 5;

// A draft nothing sent is not inventory, it is debt: it inflates the queue,
// makes the Writer look productive, and ages into a pitch that references a
// season that already ended. Past this it expires (status='expired'), which is
// a status change and not a delete -- the body is kept.
//
// SEVEN, DOWN FROM TWENTY-ONE. Twenty-one days was long enough that at the
// current write rate nothing ever reached it, so the sweep ran four times a day
// and expired nothing while the pile grew.
//
// AND SEVEN DAYS IS A CEILING, NOT A CURE. Expiry bounds the pile at roughly
// one week of output -- at 27 drafts a night that is about 190, which is ABOVE
// where the pile sits today. It stops the pile being unbounded; it does not
// make it smaller. The number that decides the size of the pile is the write
// rate, not this constant.
const DRAFT_EXPIRY_DAYS = parseInt(process.env.DRAFT_EXPIRY_DAYS, 10) || 7;

// Numbers read better spelled out below ten in a sentence, and as digits at ten
// and above. That is ordinary prose style, and this sentence is prose.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function num(n) { return n <= 10 ? WORDS[n] : String(n); }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function plural(n, s, p) { return num(n) + ' ' + (n === 1 ? s : (p || s + 's')); }

// Join clauses the way a person writes a list.
function listify(parts) {
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

// THE RUN WINDOW, DERIVED IN ONE PLACE. It used to be computed inline, after
// buildNeedsYou had already run, so anything inside buildNeedsYou had no way to
// ask "was this created by the run I am reporting on?" -- which is exactly how
// the queue count came to mean something different from every other number in
// the email. Two derivations of the same window would drift; there is one.
// Returns null when there is no run to report on, which is a real state and not
// an error: nothing can be "new this run" when no run happened.
function runWindow(run) {
  if (!run) return null;
  const startedMs = new Date(run.created_at).getTime();
  const from = new Date(startedMs - SHIFT_PRE_HOURS * 3600e3);
  // The ceiling is still 12 hours, so a run that stamped no end (a crash before
  // the catch, or a row written before finished_at existed) degrades to the old
  // behaviour instead of counting forever.
  const ceiling = startedMs + SHIFT_POST_HOURS * 3600e3;
  const finishedMs = run.finished_at ? new Date(run.finished_at).getTime() : null;
  const to = new Date(finishedMs
    ? Math.min(finishedMs + SHIFT_GRACE_MIN * 60e3, ceiling)
    : ceiling);
  // A run still in flight is not a run that produced these numbers. Say so
  // rather than presenting a partial night as a finished one -- and the email
  // path holds off entirely on this flag.
  return { from, to, finishedMs, inProgress: !finishedMs && Date.now() < ceiling };
}

function makeQuery(pool, errs) {
  return async (label, sql, params) => {
    try { return (await pool.query(sql, params || [])).rows; }
    catch (e) { errs.push(label + ': ' + e.message); console.error('[shiftReport] ' + label, e.message); return null; }
  };
}

// ── The report ───────────────────────────────────────────────────────────────
async function buildShiftReport(pool, agentId) {
  const errs = [];
  const q = makeQuery(pool, errs);
  const one = async (l, s, p) => { const r = await q(l, s, p); return r && r[0] ? r[0] : null; };
  const n = (v) => (v === null || v === undefined ? 0 : Number(v));

  const run = await one('run',
    `SELECT run_date, filled, note, details, created_at, finished_at
       FROM outreach_queue_runs WHERE agent_id = $1
      ORDER BY run_date DESC LIMIT 1`, [agentId]);

  // Derived here, before buildNeedsYou, because the queue count needs it to tell
  // a card this run placed from one that has been sitting there for three nights.
  const win = runWindow(run);
  const needsYou = await buildNeedsYou(pool, agentId, q, win);
  const moving = await buildMoving(pool, agentId, q);
  const draftAudit = await buildDraftAudit(pool, agentId, q);

  // THE CLOSER BLOCK IS BUILT ONCE, FOR BOTH PATHS. An agent whose overnight run
  // has not happened yet still has drafts waiting on the one decision and still
  // has a ceiling to see -- putting it only on the ran path would hide the batch
  // from exactly the agent most likely to be looking for it.
  // Named closerBlock, not closer: `closer` further down is the Closer's SENT and
  // REPLIED counts for the sentence, which is a different thing from the send
  // ceiling and the batch waiting on approval.
  const closerBlock = await buildCloserBlock(pool, agentId).catch((e) => {
    errs.push('closer: ' + e.message); return null;
  });

  if (!run) {
    return {
      run: { ran: false, reason: 'no-run-recorded', inProgress: false, finished: false },
      sentence: null, roles: [], coverage: null, added: null,
      needsYou, moving, draftAudit, closer: closerBlock, errors: errs,
    };
  }

  const details = Array.isArray(run.details) ? run.details : [];
  // Same window buildNeedsYou was given. Destructured rather than recomputed:
  // the queue count and the coverage line disagreeing is the whole bug.
  const { from, to, finishedMs, inProgress } = win;
  const W = [agentId, from, to];

  const scoutKept = await one('scout-kept',
    `SELECT COUNT(*)::int AS kept, COUNT(DISTINCT athlete_id)::int AS athletes
       FROM outreach_queue
      WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`, W);
  // Places rows are cached globally and carry no agent_id, so they are counted
  // only where the brand is in THIS agent's ledger. Counting them raw would
  // credit one agent with another's scan.
  const scoutChecked = await one('scout-checked',
    `SELECT COUNT(DISTINCT b.brand_key)::int AS checked
       FROM brand_evidence_cache b
      WHERE b.lane = 'places' AND b.refreshed_at >= $2 AND b.refreshed_at < $3
        AND EXISTS (SELECT 1 FROM brand_engagement e
                     WHERE e.agent_id = $1 AND e.brand_key = b.brand_key)`, W);
  const research = await one('researcher',
    `SELECT COALESCE(SUM(CASE WHEN lane='contacts'
              AND jsonb_typeof(evidence->'contacts')='array'
              THEN jsonb_array_length(evidence->'contacts') ELSE 0 END),0)::int AS contacts_found,
            COUNT(*) FILTER (WHERE lane='siteemail' AND evidence->>'email' IS NOT NULL)::int AS emailable
       FROM brand_evidence_cache b
      WHERE b.refreshed_at >= $2 AND b.refreshed_at < $3
        AND b.lane IN ('contacts','siteemail')
        AND EXISTS (SELECT 1 FROM brand_engagement e
                     WHERE e.agent_id = $1 AND e.brand_key = b.brand_key)`, W);
  const drafts = await one('writer-drafts',
    `SELECT COUNT(*)::int AS n FROM outreach_logs
      WHERE agent_id = $1 AND status = 'draft'
        AND created_at >= $2 AND created_at < $3`, W);
  const scripts = await one('writer-scripts',
    `SELECT COUNT(*)::int AS n FROM outreach_queue
      WHERE agent_id = $1 AND dm_text IS NOT NULL AND dm_text <> ''
        AND created_at >= $2 AND created_at < $3`, W);
  const closer = await one('closer',
    `SELECT COUNT(*) FILTER (WHERE sent_at >= $2 AND sent_at < $3)::int       AS sent,
            COUNT(*) FILTER (WHERE replied_at >= $2 AND replied_at < $3)::int AS replies
       FROM outreach_logs WHERE agent_id = $1`, W);
  const queueSent = await one('closer-queue',
    `SELECT COUNT(*)::int AS n FROM outreach_queue
      WHERE agent_id = $1 AND sent_at >= $2 AND sent_at < $3`, W);
  const analyst = await one('analyst',
    `SELECT COUNT(*) FILTER (WHERE activity_type = 'media_kit_built')::int AS kits,
            COUNT(*) FILTER (WHERE activity_type = 'valuation_run')::int   AS valuations
       FROM athlete_activity_log
      WHERE agent_id = $1 AND created_at >= $2 AND created_at < $3`, W);

  const stat = {
    checked: n(scoutChecked && scoutChecked.checked),
    kept: n(scoutKept && scoutKept.kept),
    athletesWithWork: n(scoutKept && scoutKept.athletes),
    contacts: n(research && research.contacts_found),
    emailable: n(research && research.emailable),
    drafts: n(drafts && drafts.n) + n(scripts && scripts.n),
    emailDrafts: n(drafts && drafts.n),
    dmScripts: n(scripts && scripts.n),
    sent: n(closer && closer.sent) + n(queueSent && queueSent.n),
    replies: n(closer && closer.replies),
    kits: n(analyst && analyst.kits),
    valuations: n(analyst && analyst.valuations),
  };

  // ── THE SENTENCE ──────────────────────────────────────────────────────────
  // Roles that did nothing are ABSENT, not named with a zero.
  const clauses = [];
  if (stat.checked) clauses.push('checked ' + plural(stat.checked, 'business', 'businesses'));
  if (stat.contacts) clauses.push('found ' + plural(stat.contacts, 'contact'));
  if (stat.drafts) clauses.push('wrote ' + plural(stat.drafts, 'pitch', 'pitches'));
  if (stat.sent) clauses.push('sent ' + num(stat.sent));
  const kitBits = [];
  if (stat.kits) kitBits.push(plural(stat.kits, 'media kit'));
  if (stat.valuations) kitBits.push(plural(stat.valuations, 'valuation'));
  if (kitBits.length) clauses.push('refreshed ' + listify(kitBits));

  let sentence = null;
  if (clauses.length) {
    sentence = 'Your team ' + listify(clauses) + '.';
    if (stat.replies) sentence += ' ' + cap(plural(stat.replies, 'reply', 'replies')) + ' came back.';
  } else {
    // A run happened and produced nothing. Say that, rather than an empty string
    // which reads as a page that failed to load.
    sentence = 'Your team ran last night and found nothing new to work.';
  }

  // ── COVERAGE, AND THE GAP ─────────────────────────────────────────────────
  // athletesCovered counts every athlete the run ATTEMPTED (one entry per
  // athlete in run.details). athletesWithWork counts those that actually got a
  // card. They are different measures, and when they disagree the difference is
  // real athletes who got nothing -- so the line says so instead of printing two
  // numbers that look like a bug.
  const attempted = details.length;
  const withWork = stat.athletesWithWork;
  const blank = Math.max(0, attempted - withWork);
  const blankNames = details
    .filter((d) => d && !Number(d.filled))
    .map((d) => d.athleteName).filter(Boolean).slice(0, 6);
  // WHY each athlete got nothing, grouped. A silent zero is what we spent a day
  // debugging; the Scout now returns a named reason for every empty athlete and
  // this is where it surfaces. Reasons are counted rather than listed one by one,
  // because "4 athletes: no school we could match" is a fix and four identical
  // sentences is a wall.
  const reasonCounts = {};
  for (const d of details) {
    if (!d || Number(d.filled)) continue;
    const why = String(d.note || 'no reason recorded').trim();
    reasonCounts[why] = (reasonCounts[why] || 0) + 1;
  }
  const blankReasons = Object.keys(reasonCounts)
    .sort((a, b) => reasonCounts[b] - reasonCounts[a])
    .map((why) => ({ why, athletes: reasonCounts[why] }));
  const coverage = {
    attempted, withWork, blank, blankNames, blankReasons,
    line: !attempted ? null
      : (blank > 0
        ? `Across ${withWork} of ${attempted} athletes — ${blank} had nothing new to work`
        : `Across ${plural(attempted, 'athlete')}`),
  };

  const roles = buildRoleCards(stat);

  // ── WHAT THE DAY ADDED, SINCE THE RUN ENDED ───────────────────────────────
  // Opening the queue triggers runOnDemandFills, which places the slots the
  // night deliberately left empty. That work is real and the page must show it
  // -- it is simply not what the overnight run did, so it gets its own line
  // instead of being backdated into the sentence. This is the number that used
  // to make the page and the 7am email disagree.
  const added = await one('added-since',
    `SELECT
       (SELECT COUNT(*)::int FROM outreach_queue
         WHERE agent_id = $1 AND created_at >= $2)                        AS cards,
       (SELECT COUNT(*)::int FROM outreach_logs
         WHERE agent_id = $1 AND status = 'draft' AND created_at >= $2)   AS drafts`,
    [agentId, to]);
  const addedCards = n(added && added.cards);
  const addedDrafts = n(added && added.drafts);
  const addedBits = [];
  if (addedCards) addedBits.push(plural(addedCards, 'card'));
  if (addedDrafts) addedBits.push(plural(addedDrafts, 'pitch', 'pitches'));
  const addedBlock = (addedCards || addedDrafts)
    ? { cards: addedCards, drafts: addedDrafts,
        line: cap(listify(addedBits)) + ' added since, while you were working.' }
    : null;

  return {
    run: {
      ran: true, runDate: run.run_date, startedAt: run.created_at,
      finishedAt: run.finished_at || null, finished: !!finishedMs, inProgress,
      windowFrom: from, windowTo: to, note: run.note || null,
    },
    added: addedBlock,
    // Names a market scan produced that are not businesses. A scan returning
    // "Core Physical Therapy (or similar local PT/chiro near campus)" is a
    // broken scan, and rejecting those silently would hide that from the only
    // person who can act on it. Scoped to THIS agent's markets, and to the run
    // window, so it reads as "last night's scan produced N of these".
    scanRejects: await one('scan-rejects',
      `SELECT COUNT(*)::int AS n,
              COUNT(DISTINCT market_key)::int AS markets,
              (ARRAY_AGG(brand ORDER BY last_seen_at DESC))[1:3] AS examples
         FROM market_business_rejected
        WHERE last_seen_at >= $2 AND last_seen_at < $3
          AND market_key IN (SELECT DISTINCT market_key FROM market_business_seen)`, W)
      .then((r) => (r && r.n ? { count: r.n, markets: r.markets, examples: r.examples || [],
        line: `${plural(r.n, 'name')} the market scan produced were not businesses and were rejected` } : null))
      .catch(() => null),
    sentence, stat, coverage, roles, needsYou, moving, draftAudit,
    closer: closerBlock,
    analyst: await buildAnalystBlock(pool, agentId, from, to).catch((e) => {
      errs.push('analyst: ' + e.message); return null;
    }),
    errors: errs,
  };
}

// ── WHAT THE ANALYST REFRESHED, AND WHY ──────────────────────────────────────
// A count alone ("3 media kits refreshed") is not a report -- the agent cannot
// tell whether that was real work or churn. The reason is stored on the activity
// row at refresh time, so this reads it back rather than guessing.
async function buildAnalystBlock(pool, agentId, from, to) {
  const rows = (await pool.query(
    `SELECT l.athlete_id, l.metadata, l.created_at,
            a.data->>'name' AS name, k.slug
       FROM athlete_activity_log l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN media_kits k ON k.athlete_id = l.athlete_id
      WHERE l.agent_id = $1 AND l.activity_type = 'media_kit_built'
        AND l.created_at >= $2 AND l.created_at < $3
      ORDER BY l.created_at DESC`, [agentId, from, to])).rows;

  const refreshed = rows.map((r) => ({
    athleteId: r.athlete_id,
    name: r.name || null,
    slug: r.slug || null,
    why: (r.metadata && Array.isArray(r.metadata.reasons))
      ? r.metadata.reasons.join('; ') : null,
    auto: !!(r.metadata && r.metadata.auto),
  }));

  // Kits that exist but are THIN -- too little on file to be worth sending. The
  // fix is data the agent has and we do not, so naming them is the useful thing;
  // padding them would be the harmful one.
  const thin = (await pool.query(
    `SELECT a.id, a.data->>'name' AS name
       FROM athletes a JOIN media_kits k ON k.athlete_id = a.id
      WHERE a.agent_id = $1
        AND COALESCE(k.instagram_followers,0) = 0
        AND COALESCE(k.tiktok_followers,0) = 0
      ORDER BY a.created_at ASC LIMIT 10`, [agentId])).rows
    .map((r) => ({ athleteId: r.id, name: r.name || null }));

  return {
    refreshed,
    thin,
    line: refreshed.length
      ? `${refreshed.length} media kit${refreshed.length === 1 ? '' : 's'} brought up to date`
      : null,
    thinLine: thin.length
      ? `${thin.length} kit${thin.length === 1 ? ' has' : 's have'} no follower count on file, `
        + 'so they stay short rather than being padded'
      : null,
  };
}

// ── THE SEND CEILING, SAID OUT LOUD ──────────────────────────────────────────
// A cap that silently swallows the back half of the night is worse than no cap:
// the agent believes forty went out. Both states surface here -- the ordinary
// "you have used 12 of 40" and the two failure modes that stop sending
// altogether, a reached ceiling and a provider refusal.
async function buildCloserBlock(pool, agentId) {
  const sendGuard = require('./sendGuard');
  const Closer = require('./closer');
  const budget = await sendGuard.status(pool, agentId);

  // Waiting on the ONE decision. Not per message -- the count is the point.
  const pending = (await pool.query(
    `SELECT COUNT(*)::int AS n FROM outreach_logs
      WHERE agent_id = $1 AND status = 'draft' AND approved_at IS NULL
        AND cadence_stopped_at IS NULL`, [agentId])).rows[0].n;

  // Approved and waiting for the recipient's Tuesday morning.
  const scheduled = (await pool.query(
    `SELECT COUNT(*)::int AS n, MIN(scheduled_send_at) AS next FROM outreach_logs
      WHERE agent_id = $1 AND status = 'approved' AND cadence_stopped_at IS NULL`,
    [agentId])).rows[0];

  // Anything that failed to go out, with the reason. A send that errored and was
  // never mentioned is the exact failure this block exists to prevent.
  const failed = (await pool.query(
    `SELECT brand_name, send_error FROM outreach_logs
      WHERE agent_id = $1 AND send_error IS NOT NULL AND status <> 'sent'
      ORDER BY updated_at DESC LIMIT 5`, [agentId])).rows;

  // Cadences that ended, and why. "They replied" is good news; "it bounced" is
  // an address to fix.
  const stopped = (await pool.query(
    `SELECT cadence_stop_reason AS why, COUNT(*)::int AS n FROM outreach_logs
      WHERE agent_id = $1 AND cadence_stopped_at >= NOW() - INTERVAL '7 days'
      GROUP BY cadence_stop_reason ORDER BY n DESC LIMIT 5`, [agentId])).rows;

  const auto = await Closer.autoModeProgress(pool, agentId);

  // WHO THE WAITING PITCHES ARE FOR. The page builds the full batch through
  // Closer.buildBatch and renders every draft body; the email cannot approve
  // anything and should not carry ten message bodies, but "13 pitches waiting"
  // with no names is not something an agent can act on either. This is the same
  // grouping the page shows, reduced to what fits in an inbox: the athlete, how
  // many, and the first businesses by name.
  const byAthlete = (await pool.query(
    `SELECT l.athlete_id,
            COALESCE(a.data->>'name','an athlete') AS athlete_name,
            COUNT(*)::int AS n,
            (ARRAY_AGG(l.brand_name ORDER BY l.created_at ASC))[1:3] AS brands
       FROM outreach_logs l
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.status = 'draft' AND l.approved_at IS NULL
        AND l.cadence_stopped_at IS NULL
      GROUP BY l.athlete_id, a.data->>'name'
      ORDER BY COUNT(*) DESC, athlete_name ASC`, [agentId])).rows;

  return {
    budget,
    pendingApproval: Number(pending) || 0,
    byAthlete: byAthlete.map((r) => ({
      athleteId: r.athlete_id, name: r.athlete_name,
      count: Number(r.n) || 0, brands: (r.brands || []).filter(Boolean),
    })),
    scheduled: Number(scheduled.n) || 0,
    nextSendAt: scheduled.next || null,
    failed: failed.map((f) => ({ brand: f.brand_name, why: f.send_error })),
    stopped: stopped.map((r) => ({ why: r.why, n: Number(r.n) })),
    auto,
    line: budget.blocked
      ? `Sending is stopped for today: ${budget.blockedReason}`
      : budget.remaining < 1
        ? `Tonight's ${budget.cap}-email ceiling is used up. DMs and calls are not affected.`
        : `${budget.used} of ${budget.cap} emails used today.`,
  };
}

// The five cards, for the detail page only. The home page shows the sentence.
function buildRoleCards(s) {
  const card = (key, name, ran, value, headline, detail) =>
    (ran ? { key, name, ran: true, value, headline, detail, autonomy: 'draft' }
         : { key, name, ran: false, autonomy: 'draft' });
  return [
    card('scout', 'Scout', !!(s.checked || s.kept), s.kept,
      plural(s.kept, 'business', 'businesses') + ' kept',
      s.checked ? `from ${plural(s.checked, 'business', 'businesses')} checked` : null),
    card('researcher', 'Researcher', !!(s.contacts || s.emailable), s.contacts,
      plural(s.contacts, 'contact') + ' found',
      `${s.emailable} with an email address we can write to`),
    card('writer', 'Writer', !!s.drafts, s.drafts,
      plural(s.drafts, 'pitch', 'pitches') + ' drafted',
      s.emailDrafts && s.dmScripts
        ? `${s.emailDrafts} email ${s.emailDrafts === 1 ? 'draft' : 'drafts'}, ${s.dmScripts} DM ${s.dmScripts === 1 ? 'script' : 'scripts'}`
        : (s.emailDrafts ? 'waiting in Outreach for your approval' : 'DM scripts on the morning queue')),
    card('closer', 'Closer', !!(s.sent || s.replies), s.sent,
      plural(s.sent, 'outreach', 'outreaches') + ' sent',
      s.replies ? `${plural(s.replies, 'reply', 'replies')} came back` : 'no replies yet'),
    card('analyst', 'Analyst', !!(s.kits || s.valuations), s.kits + s.valuations,
      s.kits ? plural(s.kits, 'media kit') + ' refreshed'
             : plural(s.valuations, 'valuation') + ' updated',
      s.kits && s.valuations ? plural(s.valuations, 'valuation') + ' updated' : 'nothing else changed'),
  ];
}

// ── NEEDS YOU ────────────────────────────────────────────────────────────────
// Order is not cosmetic. A reply means a human is sitting in an inbox waiting on
// an answer, so it outranks everything. Approvals are work the team already did
// that cannot move without a decision. Queue cards are work the agent can do
// whenever. Replies, then approvals, then cards.
//
// TWO TYPES OF ITEM, NOT THREE. The brief asked for a compliance-hold row and
// there is no such mechanism here: nothing holds an outreach and no table
// records a hold. Rendering it would mean inventing the state it reports.
// win: the run window from runWindow(), or null when no run has been recorded.
// Only the queue count uses it, and only to say when a card arrived.
async function buildNeedsYou(pool, agentId, q, win) {
  const items = [];

  // ── COMPLIANCE HOLDS, ABOVE EVERYTHING ───────────────────────────────────
  // A hold is a pitch that has ALREADY been stopped, and it stays stopped until
  // a person acts. It outranks a reply: a reply is an opportunity going cold,
  // a hold is work that cannot move at all. One row per hold, named -- these are
  // never collapsed into "3 holds", because the agent has to know which business
  // and which rule to make the decision.
  const holds = await q('needs-compliance',
    `SELECT h.id, h.brand_name, h.rule_key, h.rule_label, h.severity, h.reason, h.created_at,
            COALESCE(a.data->>'name','an athlete') AS athlete_name
       FROM compliance_holds h
       LEFT JOIN athletes a ON a.id = h.athlete_id
      WHERE h.agent_id = $1 AND h.resolved_at IS NULL AND h.severity IN ('block','hold')
      -- Faults first: a broken read is not a queue of decisions and must not sit
      -- below ordinary holds where it reads as one.
      ORDER BY (h.rule_key = 'source-unreadable') DESC,
               CASE h.severity WHEN 'block' THEN 0 ELSE 1 END, h.created_at ASC
      LIMIT $2`, [agentId, ITEM_MAX]);
  for (const h of (holds || [])) {
    const blocked = h.severity === 'block';
    items.push({
      kind: 'compliance', id: h.id, priority: -1, count: 1,
      severity: h.severity,
      // A BROKEN READ IS NOT A DECISION TO MAKE. It reads differently and sorts
      // above everything, because a pile of "on hold" rows that are really "we
      // could not read the athlete" is exactly the disguise this class of fault
      // wears -- it looks like an agent with a backlog rather than a system with
      // a broken join.
      isFault: h.rule_key === 'source-unreadable',
      line: h.rule_key === 'source-unreadable'
        ? `${h.brand_name || 'A business'} could not be checked — the athlete record is missing`
        : `${h.brand_name || 'A business'} is on hold for ${h.athlete_name}`,
      detail: h.rule_label,
      reason: h.reason,
      // A block cannot be overridden, so it is not offered as if it could be.
      actionLabel: h.rule_key === 'source-unreadable' ? 'This is a fault, not a decision'
        : (blocked ? 'See why it cannot send' : 'Review and decide'),
      target: { view: 'compliance', id: h.id },
      at: h.created_at,
    });
  }

  // ONE EXIT, AND IT IS ONE A PERSON TAKES. This filtered on
  // COALESCE(status,'') <> 'closed', and nothing anywhere ever wrote 'closed' to
  // outreach_logs -- the complete set of values written is draft, approved,
  // sent, replied, expired. So the condition was always true, the query had no
  // time bound, and a captured reply stayed in NEEDS YOU permanently and kept
  // owning the report's subject line via buildSubject. reply_handled_at is the
  // acknowledgement that was missing; it is set only by the agent pressing the
  // button on the row.
  const replies = await q('needs-replies',
    `SELECT l.id, l.brand_name, l.replied_at, a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.replied_at IS NOT NULL
        AND l.reply_handled_at IS NULL
      ORDER BY l.replied_at DESC LIMIT $2`, [agentId, ITEM_MAX]);
  for (const r of (replies || [])) {
    items.push({
      kind: 'reply', id: r.id, priority: 0, count: 1,
      line: `${r.brand_name} replied${r.athlete_name ? ' about ' + r.athlete_name : ''}`,
      // No claim a drafted answer exists -- nothing in this codebase writes one.
      actionLabel: 'Read and reply', target: { view: 'outreach', id: r.id },
      at: r.replied_at,
    });
  }

  // Approvals. THE 155 PROBLEM: one item may represent at most ITEM_MAX, and the
  // ones it represents are the highest-fit, so what the agent sees first is what
  // is most worth sending -- not simply the oldest thing in the pile.
  // FIT COMES FROM THE NATURAL KEY, not a foreign key: outreach_logs carries no
  // match_score_id (that column is on automation_runs), so the score is joined on
  // the agent + athlete + brand it was computed for. A draft with no score sorts
  // last rather than being dropped -- an unscored pitch is still a pitch.
  const pending = await q('needs-drafts',
    `SELECT l.id, l.brand_name, l.created_at,
            COALESCE(m.compatibility_score, 0) AS fit,
            a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN LATERAL (
         SELECT compatibility_score FROM brand_match_scores s
          WHERE s.agent_id = l.agent_id AND s.athlete_id = l.athlete_id
            AND LOWER(s.brand_name) = LOWER(l.brand_name)
          ORDER BY s.compatibility_score DESC LIMIT 1
       ) m ON TRUE
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.status = 'draft'
      ORDER BY COALESCE(m.compatibility_score,0) DESC, l.created_at ASC`, [agentId]);
  const pendingAll = pending || [];
  if (pendingAll.length) {
    const show = pendingAll.slice(0, ITEM_MAX);
    items.push({
      kind: 'approve', id: 'drafts', priority: 1,
      count: show.length, heldBack: Math.max(0, pendingAll.length - show.length),
      line: `${plural(show.length, 'pitch', 'pitches')} ready for you`,
      detail: pendingAll.length > ITEM_MAX
        ? `highest-fit ${show.length} of ${pendingAll.length} — the rest wait`
        : null,
      actionLabel: 'Review', target: { view: 'outreach' },
      ids: show.map((r) => r.id),
      at: show[show.length - 1] && show[show.length - 1].created_at,
    });
  }

  // ── THE QUEUE, SPLIT BY WHEN THE CARD ARRIVED ──────────────────────────────
  // This counted `state = 'queued'` with NO time filter, while the headline and
  // the coverage line count the SAME TABLE windowed to the run. Both numbers were
  // right and they answered different questions, so a quiet night produced an
  // email that read:
  //
  //   subject   5 outreach cards ready to work
  //   headline  Your team ran last night and found nothing new to work.
  //   coverage  Across 0 of 1 athletes — 1 had nothing new to work
  //
  // A card leaves 'queued' only when the AGENT acts (sent, or skipped), never on
  // a timer, so the unwindowed count is a standing backlog by construction. It is
  // the right number for the subject -- a stale pile is worth a nudge on the
  // quietest morning -- and the wrong number to print under a headline about last
  // night without saying which is which.
  const queued = await q('needs-queue',
    `SELECT COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE $2::timestamptz IS NOT NULL
                               AND created_at >= $2 AND created_at < $3)::int AS fresh
       FROM outreach_queue
      WHERE agent_id = $1 AND state = 'queued'`,
    [agentId, win ? win.from : null, win ? win.to : null]);
  const queuedN = queued && queued[0] ? Number(queued[0].n) : 0;
  // With no run recorded nothing can be new, so everything reads as carried over.
  const freshN = queued && queued[0] ? Number(queued[0].fresh) : 0;
  const carriedN = Math.max(0, queuedN - freshN);
  if (queuedN > 0) {
    const shown = Math.min(queuedN, ITEM_MAX);
    // THREE SHAPES, AND THE MIDDLE ONE IS THE BUG. All-carryover must never say
    // "found last night"; all-fresh must not be hedged into sounding stale.
    let line;
    if (freshN && carriedN) {
      line = `${plural(freshN, 'new outreach card')} from last night, `
        + `${num(carriedN)} still waiting from earlier runs`;
    } else if (freshN) {
      line = `${plural(freshN, 'outreach card')} ready to work`;
    } else {
      line = `${plural(carriedN, 'outreach card')} still waiting from earlier runs`;
    }
    items.push({
      kind: 'queue', id: 'queue', priority: 2,
      // count stays the DISPLAY count (capped) so nothing downstream that reads it
      // changes meaning; total is the real backlog, which is what the subject wants.
      count: shown, total: queuedN, fresh: freshN, carried: carriedN,
      heldBack: Math.max(0, queuedN - shown),
      line,
      detail: queuedN > ITEM_MAX ? `${queuedN} in the queue — the rest wait` : null,
      actionLabel: 'Open queue', target: { view: 'outreach' },
    });
  }

  items.sort((a, b) => a.priority - b.priority);
  const shown = items.slice(0, QUEUE_MAX);
  // Overflow is ONE LINE, never a longer list.
  const overflow = Math.max(0, items.length - shown.length);
  return { items: shown, overflow, total: items.length };
}

// ── MOVING ───────────────────────────────────────────────────────────────────
// Two figures: earned, and in flight.
//
// OFF. Both figures sum `deals` for the agent over all time, and four different
// things land in that table without a person vouching for any of them:
//
//   - the demo seeder writes five demo-deal-% rows, 800 closed and 6,300 open;
//   - the Outreach Engine auto-creates a Prospecting deal per scanned brand;
//   - the public media-kit inquiry form books the MIDPOINT of a budget bracket
//     an anonymous submitter picked from a dropdown, so "$5,000+" is $7,500 of
//     "in flight" that nobody has agreed to;
//   - and the dead-stage filter is dead code. It excludes Lost/Dead/Rejected/
//     Declined, and the pipeline UI offers Prospecting, Outreach Sent,
//     Negotiating, Closing and Closed -- none of the four. So no deal can ever
//     leave "in flight" except by being closed or deleted, and the number can
//     only go up.
//
// One switch rather than three, because buildMoving returning null is already
// the "nothing to show" path that the email block, the plain-text line and
// srRenderMoving all handle. Turning it back on is MOVING_ENABLED=1, and it
// should not go on until a deal in that table means a person agreed to a number.
const MOVING_ENABLED = process.env.MOVING_ENABLED === '1';

async function buildMoving(pool, agentId, q) {
  if (!MOVING_ENABLED) return null;
  // deals is a JSONB table -- id, athlete_id, agent_id, data -- with no value or
  // status COLUMN. The stage and value live in data, and the expressions below
  // are the same ones home-metrics uses, so "earned" here is the number the rest
  // of the app already shows rather than a second definition of the same word.
  const VALUE = `COALESCE(NULLIF(data->>'value',''),'0')::numeric`;
  const CLOSED = `data->>'stage' = 'Closed'`;
  const DEAD = `data->>'stage' IN ('Lost','Dead','Rejected','Declined')`;
  const rows = await q('moving',
    `SELECT
       COALESCE(SUM(${VALUE}) FILTER (WHERE ${CLOSED}),0)::numeric       AS earned,
       COUNT(*) FILTER (WHERE ${CLOSED})::int                            AS earned_count,
       COALESCE(SUM(${VALUE}) FILTER (WHERE NOT ${CLOSED} AND NOT ${DEAD}),0)::numeric AS inflight,
       COUNT(*) FILTER (WHERE NOT ${CLOSED} AND NOT ${DEAD})::int        AS inflight_count
     FROM deals WHERE agent_id = $1`, [agentId]);
  const r = rows && rows[0];
  if (!r) return null;
  return {
    earned: Number(r.earned) || 0, earnedCount: Number(r.earned_count) || 0,
    inFlight: Number(r.inflight) || 0, inFlightCount: Number(r.inflight_count) || 0,
  };
}

// ── DRAFT AUDIT ──────────────────────────────────────────────────────────────
// The question behind the 155: is the Writer producing work that anything
// consumes? A send-through rate near zero and a months-old oldest draft means
// no, and the fix is expiry rather than a taller pile.
async function buildDraftAudit(pool, agentId, q) {
  const r = await q('draft-audit',
    `SELECT COUNT(*) FILTER (WHERE status = 'draft')::int                       AS pending,
            COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int                    AS ever_sent,
            COUNT(*)::int                                                       AS all_rows,
            COUNT(*) FILTER (WHERE status = 'expired')::int                     AS expired,
            MIN(created_at) FILTER (WHERE status = 'draft')                     AS oldest_draft,
            COUNT(*) FILTER (WHERE status = 'draft'
              AND created_at < NOW() - ($2 || ' days')::interval)::int          AS stale,
            -- WHAT WENT, SINCE THE LAST TIME THEY LOOKED. The sweep runs every
            -- six hours on its own clock, not on the run window, so this is
            -- measured in days rather than against the overnight run. A daily
            -- report reading "in the last day" is the same unit the agent is
            -- already holding in their head.
            COUNT(*) FILTER (WHERE status = 'expired'
              AND updated_at >= NOW() - INTERVAL '24 hours')::int               AS expired_recent
       FROM outreach_logs WHERE agent_id = $1`, [agentId, String(DRAFT_EXPIRY_DAYS)]);
  const row = r && r[0];
  if (!row) return null;
  const pending = Number(row.pending) || 0;
  const everSent = Number(row.ever_sent) || 0;
  const all = Number(row.all_rows) || 0;
  const oldest = row.oldest_draft ? new Date(row.oldest_draft) : null;
  return {
    pending, everSent, allRows: all,
    expired: Number(row.expired) || 0,
    expiredRecent: Number(row.expired_recent) || 0,
    stale: Number(row.stale) || 0,
    expiryDays: DRAFT_EXPIRY_DAYS,
    sendThroughPct: all ? Math.round((everSent / all) * 1000) / 10 : null,
    oldestDraftAt: oldest,
    oldestDraftAgeDays: oldest ? Math.floor((Date.now() - oldest.getTime()) / 86400000) : null,
  };
}

// Expire drafts nobody sent. A STATUS CHANGE, NOT A DELETE: the body is kept, so
// this is reversible and an expired draft can still be read.
async function expireStaleDrafts(pool, agentId) {
  const params = agentId ? [String(DRAFT_EXPIRY_DAYS), agentId] : [String(DRAFT_EXPIRY_DAYS)];
  const r = await pool.query(
    `UPDATE outreach_logs SET status = 'expired', updated_at = NOW()
      WHERE status = 'draft'
        AND created_at < NOW() - ($1 || ' days')::interval
        ${agentId ? 'AND agent_id = $2' : ''}
      RETURNING id`, params);
  return r.rowCount;
}

module.exports = {
  buildCloserBlock, buildAnalystBlock,
  buildShiftReport, buildNeedsYou, buildMoving, buildDraftAudit, expireStaleDrafts,
  buildRoleCards, num, plural, listify, cap,
  ITEM_MAX, QUEUE_MAX, DRAFT_EXPIRY_DAYS, SHIFT_PRE_HOURS, SHIFT_POST_HOURS,
  MOVING_ENABLED,
};
