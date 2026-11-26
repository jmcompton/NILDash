'use strict';
// ── EVERY FOLLOW-UP WAITS FOR THE FOUNDER ───────────────────────────────────
//
// A follow-up told an insurance company about "a joint night with" a hardware
// store. The agent's auto-send approved it and it went out under the agent's
// name. From now on a follow-up (touch 2 or 3) is written into status
// 'founder_review': no agent's queue lists it, auto-send does not see it, and
// the send loop only ever sends 'approved'. The founder reads it, edits it if
// he wants, and approves it, has it written again, or skips it.
//
//   approve  -> an ordinary draft for the agent (auto-send picks it up for an
//               agent with auto-send on); for a done-for-you client it is
//               approved to send right away, since the founder IS the approver
//   rewrite  -> the writer writes it again
//   skip     -> that sequence is over
//
// pullBack: follow-ups written before this rule and not yet sent (drafts, and
// approved ones that have not left) come back here once. founder_ok_at is what
// marks the ones he has already seen.
const ON = () => process.env.FOUNDER_REVIEW !== 'off';

let _cols = false;
async function ensureColumns(pool) {
  if (_cols) return;
  await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS founder_ok_at TIMESTAMPTZ`);
  _cols = true;
}

async function pullBack(pool) {
  if (!ON()) return 0;
  await ensureColumns(pool);
  const r = await pool.query(
    `UPDATE outreach_logs SET status = 'founder_review', approved_at = NULL, scheduled_send_at = NULL, updated_at = NOW()
      WHERE COALESCE(touch_no, 1) > 1 AND sent_at IS NULL AND founder_ok_at IS NULL AND cadence_stopped_at IS NULL
        AND status IN ('draft', 'approved') AND COALESCE(body_html, '') <> ''
        AND (send_claimed_at IS NULL OR send_claimed_at < NOW() - INTERVAL '15 minutes')`);
  if (r.rowCount) console.log(`[founderReview] ${r.rowCount} unsent follow-up(s) pulled back for the founder to approve`);
  return r.rowCount;
}

const textOf = (html) => require('./followUps').textOf(html);
const htmlOf = (text) => String(text || '').replace(/\r/g, '').trim().split(/\n{2,}/)
  .map((p) => '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>') + '</p>').join('');

async function list(pool) {
  await ensureColumns(pool);
  const rows = (await pool.query(
    `SELECT l.id, l.agent_id, l.brand_name, l.subject, l.body_html, l.touch_no, l.parent_id, l.sent_to_email, l.created_at, l.angle_key,
            u.name AS agent_name, u.managed_since, a.data->>'name' AS athlete_name
       FROM outreach_logs l JOIN users u ON u.id = l.agent_id LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.status = 'founder_review' AND l.sent_at IS NULL
      ORDER BY (u.managed_since IS NOT NULL) DESC, u.name, l.created_at`)).rows;
  const out = [];
  for (const r of rows) {
    const earlier = (await pool.query(
      `SELECT subject, body_html, sent_at, COALESCE(touch_no, 1) AS touch FROM outreach_logs
        WHERE (id = $1 OR parent_id = $1) AND sent_at IS NOT NULL ORDER BY sent_at`, [r.parent_id])).rows;
    out.push({ id: r.id, agent: r.agent_name, agentId: r.agent_id, managed: !!r.managed_since, athlete: r.athlete_name, business: r.brand_name, to: r.sent_to_email,
      touch: Number(r.touch_no), last: Number(r.touch_no) >= 3, subject: r.subject, body: textOf(r.body_html), writtenBy: /follow-up-ai/.test(r.angle_key || '') ? 'the writer' : 'fixed wording',
      writtenAt: r.created_at, earlier: earlier.map((e) => ({ touch: Number(e.touch), sentAt: e.sent_at, subject: e.subject, body: textOf(e.body_html) })) });
  }
  return out;
}

async function rowFor(pool, id) {
  await ensureColumns(pool);
  return (await pool.query(`SELECT l.*, u.managed_since FROM outreach_logs l JOIN users u ON u.id = l.agent_id WHERE l.id = $1 AND l.status = 'founder_review' AND l.sent_at IS NULL`, [String(id || '')])).rows[0] || null;
}

// b.body: his edited text, optional. deps.approveBatch for tests.
async function approve(pool, id, b = {}, deps = {}) {
  const r = await rowFor(pool, id);
  if (!r) return { ok: false, status: 404, error: 'That follow-up is not waiting on you any more.' };
  const FU = require('./followUps');
  let html = r.body_html;
  if (typeof b.body === 'string' && b.body.trim() && b.body.trim() !== textOf(r.body_html)) html = htmlOf(b.body);
  const earlier = (await pool.query(`SELECT body_html FROM outreach_logs WHERE (id = $1 OR parent_id = $1) AND sent_at IS NOT NULL`, [r.parent_id])).rows.map((x) => x.body_html);
  // His edit is held to the same rules as the writer: no price, nothing banned, an easy no on the last one.
  const problems = FU.checkFollowUp({ subject: r.subject, body: html, earlier: html === r.body_html ? [] : earlier, touch: r.touch_no });
  if (problems.length) return { ok: false, status: 400, error: 'This cannot go out as written: ' + problems.join('; ') + '.' };
  const upd = await pool.query(
    `UPDATE outreach_logs SET status = 'draft', founder_ok_at = NOW(), body_html = $2, created_at = NOW(), updated_at = NOW(), approved_at = NULL
      WHERE id = $1 AND status = 'founder_review' AND sent_at IS NULL RETURNING id`, [r.id, html]);
  if (!upd.rowCount) return { ok: false, status: 409, error: 'That follow-up was already handled.' };
  // A done-for-you client: he is the one who approves their email, so it goes.
  let sent = null;
  if (r.managed_since) {
    try { sent = await (deps.approveBatch || require('./closer').approveBatch)(pool, r.agent_id, { ids: [r.id] }); }
    catch (e) { console.error('[founderReview] approve to send:', e.message); sent = { approved: 0, note: e.message }; }
  }
  return { ok: true, id: r.id, next: r.managed_since ? ((sent && sent.approved) ? 'approved to send' : 'in their queue: ' + ((sent && (sent.note || (sent.dropped && sent.dropped[0] && sent.dropped[0].why))) || 'could not be approved to send')) : 'in the agent\'s queue', sent };
}

async function skip(pool, id) {
  const r = await rowFor(pool, id);
  if (!r) return { ok: false, status: 404, error: 'That follow-up is not waiting on you any more.' };
  await pool.query(`UPDATE outreach_logs SET status = 'skipped', cadence_stopped_at = NOW(), cadence_stop_reason = 'skipped by the founder', updated_at = NOW() WHERE id = $1 AND status = 'founder_review'`, [r.id]);
  return { ok: true, id: r.id };
}

// The writer writes it again, with the thread in front of it.
async function rewrite(pool, id, deps = {}) {
  const r = await rowFor(pool, id);
  if (!r) return { ok: false, status: 404, error: 'That follow-up is not waiting on you any more.' };
  const FU = require('./followUps');
  const root = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1`, [r.parent_id])).rows[0];
  if (!root) return { ok: false, status: 404, error: 'The first email is gone.' };
  const earlier = (await FU.chainOf(pool, root.id)).filter((c) => c.sent_at).map((c) => c.body_html);
  const m = await FU.materialFor(pool, root);
  const ai = await require('./followUpWriter').write(m, Number(r.touch_no), earlier.map(FU.textOf).concat([FU.textOf(r.body_html)]), { ...(deps.aiDeps || {}),
    check: (html) => FU.checkFollowUp({ subject: r.subject, body: html, earlier, touch: r.touch_no }) });
  if (!ai) return { ok: false, status: 502, error: 'The writer could not produce a better one just now. Edit it by hand or try again.' };
  await pool.query(`UPDATE outreach_logs SET body_html = $2, angle_key = 'follow-up-ai', updated_at = NOW() WHERE id = $1 AND status = 'founder_review'`, [r.id, ai.html]);
  return { ok: true, id: r.id, body: ai.text };
}

async function count(pool) {
  await ensureColumns(pool);
  return Number((await pool.query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE status = 'founder_review' AND sent_at IS NULL`)).rows[0].n);
}

module.exports = { ON, ensureColumns, pullBack, list, approve, skip, rewrite, count, htmlOf };
