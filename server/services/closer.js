'use strict';
// ── THE CLOSER ───────────────────────────────────────────────────────────────
//
// It builds the night's email batch, the agent approves it in ONE decision, and
// it releases each message into the send window on its own. The agent never
// picks a send time and never clicks send on an individual message.
//
// WHY BATCH APPROVAL AND NOT PER MESSAGE. Per-message approval is the feature
// that looks careful and is actually the product failing: forty clicks a night
// is not a review, it is data entry, and by message six nobody is reading. One
// decision the agent actually makes beats forty they rubber-stamp.
//
// So: approve all, or uncheck the few that are wrong and approve the rest.
//
// WHAT THIS DOES NOT DO. It does not choose when mail goes out. sendWindow.js
// already answers that -- Tuesday to Thursday, 9:30 to 11:00 in the RECIPIENT's
// timezone, never weekends -- and the agent does not configure it, because a
// business owner reads mail on their clock and not on the agent's.
//
// SCHEDULED IS NOT SENT. Nothing in the codebase ever read scheduled_send_at;
// the column was written and then nothing happened. releaseDue() is the job that
// was missing, and it is the only thing that calls the provider.

const sendGuard = require('./sendGuard');
const suppression = require('./suppression');
const sendWindow = require('./sendWindow');

// ── THE CADENCE ──────────────────────────────────────────────────────────────
// One message rarely gets it done, and five is harassment. Three touches over a
// fortnight, each landing in the same window, stopping the moment they answer.
// The gaps widen: someone who ignored two is not going to be won by a third
// arriving the next morning.
const CADENCE = [
  { touch: 1, afterDays: 0 },
  { touch: 2, afterDays: 4 },
  { touch: 3, afterDays: 9 },
];
const MAX_TOUCHES = CADENCE.length;

// Auto mode is not offered until the agent has approved this many pitches
// without editing any of them. Editing is the signal that the writing is not
// yet trusted, and offering autonomy before then is asking for permission we
// have not earned.
const AUTO_MODE_THRESHOLD = 30;

function laneOf(row) { return row && row.lane ? row.lane : 'local'; }

// ── Building tonight's batch ─────────────────────────────────────────────────
// Drafts that are ready to go out: written, addressed, not yet approved, not to
// a suppressed address, and inside the athlete's allocation.
async function buildBatch(pool, agentId, opts = {}) {
  const guard = await sendGuard.status(pool, agentId, opts);
  if (guard.blocked) {
    return { batch: [], budget: guard, blocked: true,
      note: `sending is stopped for today: ${guard.blockedReason}` };
  }
  if (guard.remaining < 1) {
    return { batch: [], budget: guard, blocked: false,
      note: `tonight's ${guard.cap}-email ceiling is already used up` };
  }

  // THE 120 DRAFTS THAT ALREADY EXIST have no address, because the column was
  // never in the INSERT. New drafts are born with one now; this catches the
  // backlog, at batch time, so the pile drains instead of being rewritten.
  // Cheap: it only touches rows where the address is still NULL.
  try {
    const attached = await require('./draftAddress').attach(pool, { agentId, limit: 300 });
    if (attached.attached) {
      console.log(`[closer] attached ${attached.attached} address(es) to drafts that had none`
        + ` (${attached.missing} still have no cached address)`);
    }
  } catch (e) { console.error('[closer] address backfill:', e.message); }

  const alloc = require('./closerAllocator');
  const signals = await alloc.gatherSignals(pool, agentId, opts);
  const plan = alloc.allocate(signals, guard.remaining, opts);
  if (!plan.picks.length) {
    return { batch: [], budget: guard, blocked: false, plan,
      note: plan.note || 'nothing to allocate tonight' };
  }

  const wanted = new Map(plan.picks.map((p) => [p.athleteId, p]));
  const drafts = (await pool.query(
    `SELECT l.id, l.athlete_id, l.brand_name, l.brand_key, l.subject, l.body_html,
            l.sent_to_email, l.angle, l.angle_key, l.category_key, l.touch_no,
            l.created_at, l.edited_before_approval,
            a.data->>'name' AS athlete_name,
            e.location AS biz_address,
            a.data->>'school' AS school,
            COALESCE(c.email, l.sent_to_email) AS to_email
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
       LEFT JOIN brand_contacts c ON c.id = l.contact_id
      WHERE l.agent_id = $1
        AND l.status = 'draft'
        AND l.approved_at IS NULL
        AND l.cadence_stopped_at IS NULL
        AND l.athlete_id = ANY($2::text[])
      ORDER BY l.created_at ASC`,
    [agentId, [...wanted.keys()]])).rows;

  // ONE QUERY FOR THE BOUNCE LIST, not one per draft.
  const suppressed = await suppression.suppressedSet(pool, drafts.map((d) => d.to_email));

  const batch = [];
  const perAthlete = new Map();
  const dropped = [];
  for (const d of drafts) {
    const cap = wanted.get(d.athlete_id);
    if (!cap) continue;
    const used = perAthlete.get(d.athlete_id) || 0;
    if (used >= cap.count) continue;                       // athlete's allocation is full
    if (batch.length >= guard.remaining) break;            // the agent's ceiling
    const addr = suppression.normalize(d.to_email);
    if (!addr) {
      // Says WHICH kind of nothing this is. "No email address on file" read as a
      // storage bug for weeks when it was in fact two different situations: a
      // business we have never checked, and one we checked and found nothing on.
      dropped.push({ id: d.id, brand: d.brand_name,
        why: 'no email found for this business yet — it stays a DM or call card' });
      continue;
    }
    if (suppressed.has(addr)) {
      dropped.push({ id: d.id, brand: d.brand_name, why: 'that address bounced before' });
      continue;
    }
    perAthlete.set(d.athlete_id, used + 1);
    batch.push({
      id: d.id, athleteId: d.athlete_id, athleteName: d.athlete_name,
      brand: d.brand_name, toEmail: addr, subject: d.subject,
      body: d.body_html, angle: d.angle, touch: d.touch_no || 1,
      why: cap.reason, floor: !!cap.floor,
    });
  }

  return {
    batch, dropped, plan, budget: guard, blocked: false,
    note: batch.length ? null : 'no drafts are ready for the athletes allocated tonight',
  };
}

// ── The one decision ─────────────────────────────────────────────────────────
// approve everything in the batch except `skip`. The agent unchecks a few and
// approves the rest; that is the whole interaction.
async function approveBatch(pool, agentId, opts = {}) {
  const skip = new Set((opts.skip || []).map(String));
  const ids = (opts.ids || []).map(String).filter((id) => !skip.has(id));
  if (!ids.length) return { approved: 0, scheduled: 0, skipped: skip.size, note: 'nothing approved' };

  const guard = await sendGuard.status(pool, agentId, opts);
  if (guard.blocked) return { approved: 0, scheduled: 0, blocked: true, note: guard.blockedReason };

  // Never approve more than the ceiling allows, even if the client posts more.
  const allowed = ids.slice(0, guard.remaining);
  const overflow = ids.length - allowed.length;

  const rows = (await pool.query(
    `SELECT l.id, l.body_html, l.subject, l.athlete_id, l.brand_name,
            e.location AS biz_address, a.data->>'school' AS school
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
      WHERE l.agent_id = $1 AND l.id = ANY($2::text[])
        AND l.status = 'draft' AND l.approved_at IS NULL
        AND l.cadence_stopped_at IS NULL`,
    [agentId, allowed])).rows;

  let scheduled = 0;
  const when = [];
  for (const r of rows) {
    // THE WINDOW IS COMPUTED PER MESSAGE, in the RECIPIENT's timezone, because
    // it is the business owner's Tuesday morning that matters and a roster can
    // span Oregon to New Jersey.
    const slot = sendWindow.nextSendSlot(opts.now || new Date(), {
      businessAddress: r.biz_address, athleteSchoolState: r.school, key: r.id,
    });
    if (!slot) continue;
    await pool.query(
      `UPDATE outreach_logs
          SET status = 'approved', approved_at = NOW(), approved_by = $2,
              scheduled_send_at = $3, send_timezone = $4, updated_at = NOW()
        WHERE id = $1`,
      [r.id, agentId, slot.at, slot.timezone]);
    scheduled++;
    when.push({ id: r.id, brand: r.brand_name, at: slot.at, tz: slot.timezone });
  }
  return {
    approved: rows.length, scheduled, skipped: skip.size, overflow,
    when,
    note: overflow > 0
      ? `${overflow} left for tomorrow: approving them would have gone past tonight's ${guard.cap}-email ceiling`
      : null,
  };
}

// ── RELEASE: the job that actually sends ─────────────────────────────────────
// Nothing read scheduled_send_at before this existed. Runs on a tick, sends what
// is due and inside the window, and stops the moment the provider says stop.
async function releaseDue(pool, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const limit = opts.limit || 200;
  const sendFn = opts.send;      // injected: (log) => provider result
  if (typeof sendFn !== 'function') throw new Error('releaseDue needs a send function');

  const due = (await pool.query(
    `SELECT l.*, a.data->>'name' AS athlete_name, e.location AS biz_address,
            a.data->>'school' AS school
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN company_enrichment e ON e.id = l.enrichment_id
      WHERE l.status = 'approved'
        AND l.scheduled_send_at IS NOT NULL
        AND l.scheduled_send_at <= $1
        AND l.cadence_stopped_at IS NULL
      ORDER BY l.scheduled_send_at ASC
      LIMIT $2`, [now, limit])).rows;

  const out = { considered: due.length, sent: 0, held: 0, failed: 0, stoppedAgents: [], detail: [] };
  const blockedAgents = new Set();

  for (const log of due) {
    if (blockedAgents.has(log.agent_id)) { out.held++; continue; }

    // Late guards. All three can have become true since approval: the recipient
    // may have replied, the address may have bounced for another athlete, and
    // the window may have closed while the queue drained.
    if (log.replied_at) {
      await stop(pool, log, 'they replied before this went out');
      out.held++; out.detail.push({ id: log.id, result: 'stopped', why: 'replied first' });
      continue;
    }
    const sup = await suppression.isSuppressed(pool, log.sent_to_email || log.to_email);
    if (sup.suppressed) {
      await stop(pool, log, sup.reason);
      out.held++; out.detail.push({ id: log.id, result: 'stopped', why: sup.reason });
      continue;
    }
    if (!sendWindow.isSendable(now, {
      businessAddress: log.biz_address, athleteSchoolState: log.school,
    })) {
      out.held++; out.detail.push({ id: log.id, result: 'held', why: 'outside the send window' });
      continue;
    }

    // RESERVE BEFORE SENDING. The reservation is the cap.
    const res = await sendGuard.reserve(pool, log.agent_id, opts);
    if (!res.ok) {
      blockedAgents.add(log.agent_id);
      out.held++;
      out.detail.push({ id: log.id, result: 'held', why: res.reason });
      continue;
    }

    const attempt = await sendGuard.sendWithRetry(() => sendFn(log), {
      sleep: opts.sleep, rnd: opts.rnd,
      onQuota: async (c) => {
        // The provider refused on quota. Stop this agent for the rest of the
        // day rather than walking the rest of their batch into the same wall --
        // retrying into a 403 is how a short refusal becomes a long one.
        blockedAgents.add(log.agent_id);
        out.stoppedAgents.push({ agentId: log.agent_id, why: c.detail });
        await sendGuard.blockForDay(pool, log.agent_id, c.detail, opts);
      },
      onRetry: (r) => console.log(`[closer] ${log.id} rate-limited, waiting ${r.waitMs}ms (attempt ${r.attempt})`),
    });

    if (attempt.ok) {
      const r = attempt.result || {};
      await pool.query(
        `UPDATE outreach_logs
            SET status='sent', sent_at=NOW(), email_message_id=$2, message_id=$3,
                reply_to=$4, sent_to_email=$5, send_attempts=$6, send_error=NULL,
                updated_at=NOW()
          WHERE id=$1`,
        [log.id, r.providerMessageId || null, r.messageId || null, r.replyTo || null,
         suppression.normalize(log.sent_to_email || log.to_email), attempt.attempts]);
      out.sent++;
      out.detail.push({ id: log.id, result: 'sent', brand: log.brand_name });
      await scheduleNextTouch(pool, log, opts).catch((e) =>
        console.error('[closer] next touch failed:', e.message));
    } else {
      // THE RESERVATION GOES BACK. A failed send did not consume reputation and
      // must not consume the allowance either.
      await sendGuard.release(pool, log.agent_id, opts);
      out.failed++;
      await pool.query(
        `UPDATE outreach_logs SET send_error=$2, send_attempts=$3, updated_at=NOW() WHERE id=$1`,
        [log.id, String(attempt.detail || attempt.kind).slice(0, 300), attempt.attempts]).catch(() => {});
      if (attempt.kind === 'auth' || attempt.kind === 'quota') blockedAgents.add(log.agent_id);
      out.detail.push({ id: log.id, result: 'failed', why: attempt.detail || attempt.kind });
    }
  }
  return out;
}

async function stop(pool, log, reason) {
  await pool.query(
    `UPDATE outreach_logs SET cadence_stopped_at=NOW(), cadence_stop_reason=$2, updated_at=NOW()
      WHERE id=$1 AND cadence_stopped_at IS NULL`,
    [log.id, String(reason || 'stopped').slice(0, 300)]).catch(() => {});
  await suppression.stopCadence(pool, log, reason).catch(() => {});
}

// ── The next touch ───────────────────────────────────────────────────────────
// Written as a draft at send time so it is visible in tomorrow's batch and the
// agent can uncheck it. NOT auto-sent -- it goes through the same one decision.
async function scheduleNextTouch(pool, log, opts = {}) {
  const touch = Number(log.touch_no || 1);
  if (touch >= MAX_TOUCHES) return null;
  const next = CADENCE.find((c) => c.touch === touch + 1);
  if (!next) return null;

  const root = log.parent_id || log.id;
  const id = `${root}-t${next.touch}`;
  const dueAt = new Date((opts.now ? new Date(opts.now) : new Date()).getTime()
    + next.afterDays * 86400000);

  await pool.query(
    `INSERT INTO outreach_logs
       (id, agent_id, athlete_id, brand_name, brand_key, contact_id, enrichment_id,
        subject, body_html, status, touch_no, parent_id, sent_to_email,
        angle, angle_key, category_key, next_follow_up_at, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,'closer-cadence')
     ON CONFLICT (id) DO NOTHING`,
    [id, log.agent_id, log.athlete_id, log.brand_name, log.brand_key, log.contact_id,
     log.enrichment_id, followUpSubject(log.subject), null, next.touch, root,
     log.sent_to_email, log.angle, log.angle_key, log.category_key, dueAt]
  ).catch((e) => console.error('[closer] could not queue the next touch:', e.message));
  return { id, touch: next.touch, dueAt };
}

function followUpSubject(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Following up';
  return /^re:/i.test(s) ? s : 'Re: ' + s;
}

// ── Auto mode, earned ────────────────────────────────────────────────────────
// Not offered until the agent has approved AUTO_MODE_THRESHOLD pitches without
// editing any of them. The progress is shown so the offer arrives as something
// they have built up to rather than a checkbox asking for trust on day one.
async function autoModeProgress(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS approved,
              COUNT(*) FILTER (WHERE edited_before_approval)::int AS edited
         FROM outreach_logs
        WHERE agent_id = $1 AND approved_at IS NOT NULL`, [agentId]);
    const approved = Number(r.rows[0].approved) || 0;
    const edited = Number(r.rows[0].edited) || 0;
    const clean = approved - edited;
    return {
      approved, edited, clean,
      threshold: AUTO_MODE_THRESHOLD,
      eligible: edited === 0 && approved >= AUTO_MODE_THRESHOLD,
      remaining: Math.max(0, AUTO_MODE_THRESHOLD - clean),
      // An edit is not a permanent disqualification, but it does mean the run of
      // untouched approvals starts again -- that run is the entire evidence.
      note: edited > 0
        ? `${edited} of ${approved} approved pitches were edited first, so the writing is not being trusted unedited yet`
        : null,
    };
  } catch (e) {
    console.error('[closer] autoModeProgress:', e.message);
    return { approved: 0, edited: 0, clean: 0, threshold: AUTO_MODE_THRESHOLD,
      eligible: false, remaining: AUTO_MODE_THRESHOLD, note: null };
  }
}

async function autoModeFor(pool, agentId) {
  try {
    const r = await pool.query(
      `SELECT scope_kind, scope_id FROM agent_auto_mode WHERE agent_id = $1`, [agentId]);
    const athletes = new Set(), lanes = new Set();
    for (const row of r.rows) {
      if (row.scope_kind === 'athlete') athletes.add(row.scope_id);
      else if (row.scope_kind === 'lane') lanes.add(row.scope_id);
    }
    return { athletes, lanes, any: r.rows.length > 0 };
  } catch (_) { return { athletes: new Set(), lanes: new Set(), any: false }; }
}

// Is THIS message covered by auto mode? Never global: an agent who switched one
// athlete on has not switched the roster on.
function isAuto(auto, row) {
  if (!auto || !auto.any) return false;
  if (row.athlete_id && auto.athletes.has(row.athlete_id)) return true;
  return auto.lanes.has(laneOf(row));
}

async function setAutoMode(pool, agentId, { scopeKind, scopeId, enabled }) {
  if (scopeKind !== 'athlete' && scopeKind !== 'lane') {
    return { ok: false, error: 'auto mode is per athlete or per lane, never global' };
  }
  const progress = await autoModeProgress(pool, agentId);
  if (enabled && !progress.eligible) {
    return { ok: false, error: `auto mode unlocks after ${AUTO_MODE_THRESHOLD} approvals with no edits `
      + `(${progress.clean} so far)`, progress };
  }
  if (enabled) {
    await pool.query(
      `INSERT INTO agent_auto_mode (agent_id, scope_kind, scope_id) VALUES ($1,$2,$3)
       ON CONFLICT (agent_id, scope_kind, scope_id) DO NOTHING`, [agentId, scopeKind, scopeId]);
  } else {
    await pool.query(
      `DELETE FROM agent_auto_mode WHERE agent_id=$1 AND scope_kind=$2 AND scope_id=$3`,
      [agentId, scopeKind, scopeId]);
  }
  return { ok: true, progress };
}

module.exports = {
  buildBatch, approveBatch, releaseDue, scheduleNextTouch, stop,
  autoModeProgress, autoModeFor, isAuto, setAutoMode, followUpSubject,
  CADENCE, MAX_TOUCHES, AUTO_MODE_THRESHOLD,
};
