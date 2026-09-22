'use strict';
// ── ONE ADDRESS, ONE RULEBOOK, EVERY SYSTEM ──────────────────────────────────
//
// Luke Mazur got the same email from us every other day. Six different things
// in this codebase can put mail in front of a business contact -- the Closer's
// nightly release, its follow-up cadence, an agent clicking Send on a draft, an
// agent composing from the connected inbox, an athlete's own brand email, and
// the growth sequence -- and until this file none of them asked what the others
// had already sent to that address. Each kept its own log and its own idea of
// "recently".
//
// So the rules live here and every sender asks before it sends:
//
//   1. THE SUPPRESSION LIST stops everything. A bounce puts an address on it
//      automatically; an admin can add one by hand. Nothing checks the reason.
//   2. NEVER THE SAME SUBJECT TWICE to one address, from any system, ever. The
//      cadence's "Re: ..." is a different subject from the first note, and its
//      last note is different again (closer.followUpSubject), so the cadence
//      still runs; a second copy of the same pitch does not.
//   3. NEVER MORE THAN ONE EMAIL TO ONE ADDRESS IN ANY 4-DAY WINDOW, counting
//      every system. A follow-up due today to an address that another athlete's
//      pitch reached yesterday waits.
//
// WHICH SENDERS ARE UNDER WHICH RULE. Outreach -- anything a business contact or
// a prospect receives because we chose to write to them -- is under all three.
// Notices an agent asked for by using the product (the nightly and weekly
// digests, the shift report, the deliverable reminders, the media-kit and
// brand-inquiry alerts) are under the suppression list only: the nightly digest
// is nightly by design and a 4-day rule would silence it. Password resets and
// account verification are under none of them, because the person just asked
// for that email and blocking it locks them out.
//
// WHAT COUNTS AS A SEND. history() reads every log this codebase keeps --
// outreach_logs, growth_outreach_log, nightly_digest_sends, digest_sends,
// shift_report_sends, deliverable_reminder_sends, the connected inbox's own
// sent mail, athlete_brand_outreach -- and email_sends, the one row every
// gated sender now writes at send time. The per-system tables stay the source
// of truth for what they own; email_sends is what makes the rule checks one
// cheap query and covers senders that never kept an address on their log.

const suppression = require('./suppression');

const WINDOW_DAYS = 4;

// The systems, as the admin page names them. Keep these in words a founder
// reads, not table names.
const SYSTEMS = {
  closer: 'Closer batch (approved pitch)',
  'follow-up': 'follow-up sequence',
  manual: 'manual send (agent clicked Send on a draft)',
  compose: 'manual (composed in the inbox)',
  athlete: 'athlete brand email',
  growth: 'growth sequence',
  'nightly-digest': 'nightly digest',
  'weekly-digest': 'weekly digest',
  'shift-report': 'shift report',
  'deliverable-digest': 'deliverable reminders',
  report: 'athlete weekly report',
  'media-kit': 'media kit opened alert',
  inquiry: 'brand inquiry forward',
  brief: 'prospecting brief',
  reply: 'manual (reply in an inbox thread)',
};

// Notices are not outreach: suppression only. A reply inside a thread the
// other side is part of is a conversation, so it sits here too.
const NOTICE_SYSTEMS = new Set(['nightly-digest', 'weekly-digest', 'shift-report', 'deliverable-digest', 'report', 'media-kit', 'inquiry', 'brief', 'reply']);

function normalize(email) { return suppression.normalize(email); }

// ── THE DATE IN THE SUBJECT ──────────────────────────────────────────────────
// One agent got 29 daily reports in 30 days under one subject. A recurring
// email carries its date in the subject ("..., Fri Sep 18") so no two days
// are the same email, and the history page can tell them apart. In the
// agent's own timezone, because the report is about their morning.
function dayLabel(date, tz) {
  const d = date ? new Date(date) : new Date();
  const zone = tz && /^[A-Za-z]+\/[A-Za-z_]+$/.test(tz) ? tz : 'America/Chicago';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' })
      .format(d).replace(/,/g, '');
  } catch (_) {
    return d.toDateString().replace(/^(\w+) (\w+) (\d+).*$/, (m, w, mo, da) => `${w} ${mo} ${Number(da)}`);
  }
}
function withDate(subject, date, tz) {
  const s = String(subject || '').trim();
  const label = dayLabel(date, tz);
  return s.endsWith(', ' + label) ? s : `${s}, ${label}`;
}

// Same subject means the same words. Case and spacing do not make a new
// subject; "Re:" does, because a reply in the thread is a different email to
// the person reading it. Never strip it here.
function subjectKey(subject) {
  return String(subject || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Which system an outreach_logs row went out through.
function systemOfLog(row) {
  if (!row) return 'manual';
  const touch = Number(row.touch_no || 1);
  if (touch > 1 || row.source === 'closer-cadence' || row.parent_id) return 'follow-up';
  if (row.approved_at) return 'closer';
  return 'manual';
}

function labelFor(system, touch) {
  const base = SYSTEMS[system] || system || 'unknown';
  return system === 'follow-up' && touch ? `${base} (touch ${touch})` : base;
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_sends (
      id          SERIAL PRIMARY KEY,
      email       TEXT NOT NULL,
      subject     TEXT,
      subject_key TEXT,
      system      TEXT NOT NULL,
      agent_id    TEXT,
      ref_id      TEXT,
      sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch((e) => console.error('[sendRules] ensureTable:', e.message));
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_email_sends_email_at ON email_sends (email, sent_at DESC)`).catch(() => {});
}

// Written after a send actually went out. Never throws: a logging failure must
// not undo a send that already happened, but it is printed, because a missing
// row here is a hole in the rule.
async function record(pool, { email, subject, system, agentId, refId, now }) {
  const addr = normalize(email);
  if (!addr) return false;
  try {
    await pool.query(
      `INSERT INTO email_sends (email, subject, subject_key, system, agent_id, ref_id, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [addr, subject == null ? null : String(subject).slice(0, 500), subjectKey(subject), String(system || 'manual'),
        agentId || null, refId == null ? null : String(refId), now ? new Date(now) : new Date()]);
    return true;
  } catch (e) {
    console.error('[sendRules] record:', e.message);
    return false;
  }
}

// ── EVERY EMAIL TO ONE ADDRESS ───────────────────────────────────────────────
// Rows: { sentAt, subject, system, label, agentId, ref, touch }. Newest first.
// Each per-system table is read on its own so one missing table (a fresh
// database, a test schema) costs that system's rows and nothing else.
async function history(pool, email, opts = {}) {
  const addr = normalize(email);
  if (!addr) return [];
  const days = Number(opts.days) > 0 ? Number(opts.days) : 30;
  const now = opts.now ? new Date(opts.now) : new Date();
  const since = new Date(now.getTime() - days * 86400000);
  const seen = new Set();
  const out = [];
  const add = (r) => {
    if (!r.sentAt) return;
    const at = new Date(r.sentAt);
    if (at < since || at > new Date(now.getTime() + 60000)) return;
    const key = `${r.system}:${r.ref || ''}:${r.ref ? '' : at.toISOString() + subjectKey(r.subject)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...r, sentAt: at.toISOString(), label: labelFor(r.system, r.touch) });
  };
  const q = async (sql, params, map) => {
    try {
      const r = await pool.query(sql, params);
      for (const row of r.rows) add(map(row));
    } catch (e) {
      if (!/does not exist/.test(e.message)) console.error('[sendRules] history:', e.message);
    }
  };

  await q(`SELECT id, subject, sent_at, agent_id, touch_no, source, parent_id, approved_at, brand_name, athlete_id
             FROM outreach_logs WHERE status IN ('sent','replied') AND sent_at >= $2 AND LOWER(sent_to_email) = $1`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject, system: systemOfLog(r), agentId: r.agent_id, ref: r.id,
      touch: Number(r.touch_no || 1), brand: r.brand_name, athleteId: r.athlete_id }));
  await q(`SELECT l.id, l.sent_at, l.sequence_step, p.type,
                  CASE l.sequence_step WHEN 1 THEN s.subject1 WHEN 2 THEN s.subject2 WHEN 3 THEN s.subject3 END AS subject
             FROM growth_outreach_log l JOIN growth_prospects p ON p.id = l.prospect_id
             LEFT JOIN growth_sequences s ON s.type = p.type
            WHERE LOWER(p.email) = $1 AND l.sent_at >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject, system: 'growth', agentId: null, ref: 'growth:' + r.id, touch: r.sequence_step }));
  await q(`SELECT id, sent_at, agent_id, subject FROM nightly_digest_sends WHERE LOWER(email) = $1 AND status = 'sent' AND sent_at >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject || 'Your athletes have new pitches ready', system: 'nightly-digest', agentId: r.agent_id, ref: 'nd:' + r.id }));
  await q(`SELECT id, sent_at, agent_id, subject FROM digest_sends WHERE LOWER(email) = $1 AND status = 'sent' AND sent_at >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject, system: 'weekly-digest', agentId: r.agent_id, ref: 'wd:' + r.id }));
  // The subject column on these two is new; rows written before it carry the
  // system's name and the day, which is all that was known about them.
  await q(`SELECT s.agent_id, s.local_date, s.sent_at, s.subject, s.items FROM shift_report_sends s JOIN users u ON u.id = s.agent_id
            WHERE LOWER(u.email) = $1 AND COALESCE(s.sent_at, s.local_date::timestamptz) >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at || r.local_date, subject: r.subject || ('Daily report (subject not recorded), ' + String(r.local_date).slice(0, 10)),
      system: 'shift-report', agentId: r.agent_id, ref: 'sr:' + r.agent_id + ':' + String(r.local_date).slice(0, 10), items: r.items }));
  await q(`SELECT s.agent_id, s.local_date, s.sent_at, s.subject FROM deliverable_reminder_sends s JOIN users u ON u.id = s.agent_id
            WHERE LOWER(u.email) = $1 AND COALESCE(s.sent_at, s.local_date::timestamptz) >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at || r.local_date, subject: r.subject || ('Deliverable reminders (subject not recorded), ' + String(r.local_date).slice(0, 10)),
      system: 'deliverable-digest', agentId: r.agent_id, ref: 'dr:' + r.agent_id + ':' + String(r.local_date).slice(0, 10) }));
  await q(`SELECT id, subject, sent_at, user_id FROM emails
            WHERE direction = 'sent' AND sent_at >= $2 AND $1::text = ANY(SELECT LOWER(x) FROM unnest(to_addresses) x)`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject, system: 'compose', agentId: r.user_id, ref: 'inbox:' + r.id }));
  await q(`SELECT id, brand_name, created_at, agent_id FROM athlete_brand_outreach
            WHERE LOWER(brand_contact_email) = $1 AND created_at >= $2`, [addr, since],
    (r) => ({ sentAt: r.created_at, subject: r.brand_name, system: 'athlete', agentId: r.agent_id, ref: 'abo:' + r.id }));
  // Last, so a per-system row wins the dedupe over the mirror written here.
  await q(`SELECT id, subject, system, agent_id, ref_id, sent_at FROM email_sends WHERE email = $1 AND sent_at >= $2`, [addr, since],
    (r) => ({ sentAt: r.sent_at, subject: r.subject, system: r.system, agentId: r.agent_id, ref: r.ref_id || ('es:' + r.id) }));

  out.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  return out;
}

// ── THE CHECK, BEFORE EVERY SEND ─────────────────────────────────────────────
// Returns { ok: true } or { ok: false, kind, reason, retryAfter? }.
//   kind 'suppressed'    the address is on the list. Stop for good.
//   kind 'same-subject'  this subject already went to this address. Stop for good.
//   kind 'window'        something reached this address inside 4 days. Wait.
// Fails CLOSED on a read error, the same way the suppression list does: not
// knowing what we already sent is not permission to send more.
async function check(pool, { email, subject, system, now, agentId, refId } = {}) {
  const addr = normalize(email);
  if (!addr) return { ok: false, kind: 'suppressed', reason: 'no address to send to' };
  const sup = await suppression.isSuppressed(pool, addr);
  if (sup.suppressed) {
    return { ok: false, kind: 'suppressed', reason: `${addr} is on the suppression list (${sup.reason})` };
  }
  if (NOTICE_SYSTEMS.has(system)) return { ok: true };
  const at = now ? new Date(now) : new Date();
  try {
    const key = subjectKey(subject);
    // The mirror table holds every gated send since it shipped; outreach_logs
    // holds what went out before. Both are asked, so a pitch sent last month
    // by hand still counts.
    const same = key ? await pool.query(
      `SELECT 1 FROM email_sends WHERE email = $1 AND subject_key = $2 AND ($3::text IS NULL OR ref_id IS DISTINCT FROM $3) LIMIT 1`,
      [addr, key, refId == null ? null : String(refId)]) : { rows: [] };
    if (!same.rows.length && key) {
      const older = await pool.query(
        `SELECT 1 FROM outreach_logs WHERE status IN ('sent','replied') AND LOWER(sent_to_email) = $1
            AND LOWER(REGEXP_REPLACE(COALESCE(subject,''), '\\s+', ' ', 'g')) = $2
            AND ($3::text IS NULL OR id <> $3) LIMIT 1`, [addr, key, refId == null ? null : String(refId)]);
      if (older.rows.length) same.rows.push(older.rows[0]);
    }
    if (same.rows.length) {
      return { ok: false, kind: 'same-subject', reason: `"${String(subject || '').trim()}" was already sent to ${addr}` };
    }
    const recent = await lastSend(pool, addr, { now: at, refId });
    if (recent && (at.getTime() - new Date(recent.sentAt).getTime()) < WINDOW_DAYS * 86400000) {
      const retryAfter = new Date(new Date(recent.sentAt).getTime() + WINDOW_DAYS * 86400000);
      return { ok: false, kind: 'window', retryAfter,
        reason: `${addr} already got "${String(recent.subject || '').trim() || '(no subject)'}" from the ${labelFor(recent.system, recent.touch)} on ${String(recent.sentAt).slice(0, 10)}; nothing else for ${WINDOW_DAYS} days` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[sendRules] check:', e.message);
    return { ok: false, kind: 'window', reason: 'could not read what was already sent to this address, so not sending' };
  }
}

// The most recent send to an address inside the window, from any system.
async function lastSend(pool, email, opts = {}) {
  const addr = normalize(email);
  if (!addr) return null;
  const rows = await history(pool, addr, { days: WINDOW_DAYS + 1, now: opts.now });
  const skip = opts.refId == null ? null : String(opts.refId);
  return rows.find((r) => !skip || r.ref !== skip) || null;
}

// ── THE SUPPRESSION LIST, BY HAND ────────────────────────────────────────────
// `kind` is how the suppression list explains itself on the admin page, and an
// unsubscribe is not a hand-added row: one is a person saying stop and the
// other is us deciding. They must never be confused, because removing an
// unsubscribed address from the list is unlawful and removing one we added by
// hand is routine.
async function suppressManually(pool, email, { reason, by, kind } = {}) {
  const addr = normalize(email);
  if (!addr || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return { ok: false, error: 'that is not an email address' };
  const done = await suppression.suppress(pool, addr, {
    reason: reason ? String(reason).slice(0, 300) : 'added by hand', kind: kind || 'manual', agentId: by || null,
  });
  if (!done) return { ok: false, error: 'could not write the suppression list' };
  // Every unsent message to this address stops now, on every agent's roster.
  let stopped = 0;
  try {
    const r = await pool.query(
      `UPDATE outreach_logs SET cadence_stopped_at = NOW(), cadence_stop_reason = $2, updated_at = NOW()
        WHERE LOWER(sent_to_email) = $1 AND status <> 'sent' AND cadence_stopped_at IS NULL`,
      [addr, 'suppressed: ' + (reason ? String(reason).slice(0, 200) : 'added by hand')]);
    stopped = r.rowCount || 0;
  } catch (e) { console.error('[sendRules] stop after suppress:', e.message); }
  return { ok: true, email: addr, stopped };
}

// ── AN OPT-OUT IS NOT OURS TO UNDO ───────────────────────────────────────────
// Taking a bounced address off the list is routine: the mailbox may have been
// fixed. Taking off an address whose owner clicked Unsubscribe is resuming
// mail to somebody who told us to stop, which CAN-SPAM 7704(a)(4) forbids and
// which no admin should be able to do by misreading a row. So this refuses,
// and says why, rather than quietly doing it.
async function unsuppress(pool, email) {
  const addr = normalize(email);
  if (!addr) return { ok: false, error: 'no address' };
  try {
    const cur = await pool.query(`SELECT kind FROM email_suppression WHERE email = $1`, [addr]);
    if (cur.rows[0] && cur.rows[0].kind === 'unsubscribe') {
      return { ok: false, error: `${addr} unsubscribed. An opt-out cannot be undone from here: `
        + 'mailing an address again after it asked to stop is what CAN-SPAM forbids.' };
    }
    const r = await pool.query(`DELETE FROM email_suppression WHERE email = $1`, [addr]);
    return { ok: true, email: addr, removed: r.rowCount || 0 };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function listSuppressed(pool, opts = {}) {
  const limit = Math.min(1000, Math.max(1, Number(opts.limit) || 500));
  try {
    const r = await pool.query(
      `SELECT s.email, s.reason, s.kind, s.first_seen_at, s.hits, s.agent_id, u.email AS agent_email
         FROM email_suppression s LEFT JOIN users u ON u.id = s.agent_id
        ORDER BY s.first_seen_at DESC LIMIT $1`, [limit]);
    return r.rows;
  } catch (e) { console.error('[sendRules] listSuppressed:', e.message); return []; }
}

module.exports = {
  WINDOW_DAYS, SYSTEMS, NOTICE_SYSTEMS,
  normalize, subjectKey, systemOfLog, labelFor, dayLabel, withDate,
  ensureTable, record, history, check, lastSend,
  suppressManually, unsuppress, listSuppressed,
};
