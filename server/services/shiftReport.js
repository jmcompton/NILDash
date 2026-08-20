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
const SHIFT_PRE_HOURS = 2;
const SHIFT_POST_HOURS = 12;

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
const DRAFT_EXPIRY_DAYS = parseInt(process.env.DRAFT_EXPIRY_DAYS, 10) || 21;

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
    `SELECT run_date, filled, note, details, created_at
       FROM outreach_queue_runs WHERE agent_id = $1
      ORDER BY run_date DESC LIMIT 1`, [agentId]);

  const needsYou = await buildNeedsYou(pool, agentId, q);
  const moving = await buildMoving(pool, agentId, q);
  const draftAudit = await buildDraftAudit(pool, agentId, q);

  if (!run) {
    return {
      run: { ran: false, reason: 'no-run-recorded' },
      sentence: null, roles: [], coverage: null,
      needsYou, moving, draftAudit, errors: errs,
    };
  }

  const details = Array.isArray(run.details) ? run.details : [];
  const from = new Date(new Date(run.created_at).getTime() - SHIFT_PRE_HOURS * 3600e3);
  const to = new Date(new Date(run.created_at).getTime() + SHIFT_POST_HOURS * 3600e3);
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

  return {
    run: {
      ran: true, runDate: run.run_date, startedAt: run.created_at,
      windowFrom: from, windowTo: to, note: run.note || null,
    },
    sentence, stat, coverage, roles, needsYou, moving, draftAudit, errors: errs,
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
async function buildNeedsYou(pool, agentId, q) {
  const items = [];

  const replies = await q('needs-replies',
    `SELECT l.id, l.brand_name, l.replied_at, a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.replied_at IS NOT NULL
        AND COALESCE(l.status,'') <> 'closed'
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

  const queued = await q('needs-queue',
    `SELECT COUNT(*)::int AS n FROM outreach_queue
      WHERE agent_id = $1 AND state = 'queued'`, [agentId]);
  const queuedN = queued && queued[0] ? Number(queued[0].n) : 0;
  if (queuedN > 0) {
    const shown = Math.min(queuedN, ITEM_MAX);
    items.push({
      kind: 'queue', id: 'queue', priority: 2,
      count: shown, heldBack: Math.max(0, queuedN - shown),
      line: `${plural(shown, 'outreach card')} ready to work`,
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
async function buildMoving(pool, agentId, q) {
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
              AND created_at < NOW() - ($2 || ' days')::interval)::int          AS stale
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
  buildShiftReport, buildNeedsYou, buildMoving, buildDraftAudit, expireStaleDrafts,
  buildRoleCards, num, plural, listify, cap,
  ITEM_MAX, QUEUE_MAX, DRAFT_EXPIRY_DAYS, SHIFT_PRE_HOURS, SHIFT_POST_HOURS,
};
