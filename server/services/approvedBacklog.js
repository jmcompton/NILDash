'use strict';
// ── APPROVED, NEVER SENT, AND TOO OLD TO SEND NOW ───────────────────────────
//
// 41 rows approved on 2026-09-23 never left: 25 "no address to send to"
// (mostly jabree@belchersportsgroup.com's, for Mataya Gayle), the rest for
// other reasons. They are two weeks old, so NOTHING is sent. For each:
//
//   1. an address, tried ONCE: the one on the row if it is still sendable
//      (not bounced or unsubscribed), else the address cache (free), else one
//      contact lookup for that business (paid: ~$0.075, the address ladder)
//   2. found   -> a FRESH draft dated today, unapproved, the same email, so the
//                 agent decides again on Home. Never approved here.
//      phone   -> a CALL card (services/cardChannel)
//      handle  -> a DM card, the email cut to a DM
//      nothing -> no card, and the report says so
//   3. the old row is CLOSED (status 'expired', the reason written down), so
//      the morning alert stops reporting it.
//
// Dry run by default: says what each row would become, spending nothing and
// looking nothing up. apply: true does it.

const CHN = require('./cardChannel');
const DC = require('./draftChannel');

// Columns a fresh draft does NOT copy from the old one: identity, the send,
// the cadence, the timestamps, the recipient (set fresh).
const NO_COPY = new Set(['id', 'status', 'approved_at', 'approved_by', 'scheduled_send_at', 'send_timezone', 'send_hold_reason', 'send_hold_at',
  'send_claimed_at', 'send_failures', 'send_attempts', 'send_error', 'sent_at', 'sent_to_email', 'cadence_stopped_at', 'cadence_stop_reason',
  'created_at', 'updated_at', 'next_follow_up_at', 'parent_id', 'touch_no', 'provider_message_id', 'message_id', 'reply_to', 'replied_at',
  'reply_handled_at', 'opened_at', 'clicked_at', 'bounced_at', 'thread_id', 'edited_before_approval', 'source']);

async function rowsFor(pool, { date, olderThanDays }) {
  const where = [`l.status = 'approved'`, `l.sent_at IS NULL`];
  const args = [];
  if (date) { args.push(date); where.push(`(l.approved_at AT TIME ZONE 'America/Chicago')::date = $${args.length}::date`); }
  else { args.push(String(olderThanDays || 7)); where.push(`l.approved_at < NOW() - ($${args.length} || ' days')::interval`); }
  return (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.brand_key, l.subject, l.body_html, l.sent_to_email, l.approved_at,
            COALESCE(l.cadence_stop_reason, l.send_hold_reason, l.send_error, 'no reason recorded') AS why,
            u.email AS agent_email, u.name AS agent_name, a.data->>'name' AS athlete_name, a.data->>'school' AS school, a.data->>'city' AS city,
            q.id AS qid, q.phone, q.instagram, q.instagram_scope, q.contact_name, q.why AS card_why, q.state AS qstate
       FROM outreach_logs l
       LEFT JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN LATERAL (SELECT id, phone, instagram, instagram_scope, contact_name, why, state FROM outreach_queue q2
                           WHERE q2.athlete_id = l.athlete_id AND (q2.outreach_log_id = l.id OR LOWER(q2.brand_name) = LOWER(l.brand_name))
                           ORDER BY (q2.outreach_log_id = l.id) DESC, q2.created_at DESC LIMIT 1) q ON TRUE
      WHERE ${where.join(' AND ')}
      ORDER BY u.email, a.data->>'name', l.brand_name`, args)).rows;
}

// One contact lookup for a business (the address ladder), as the nightly job
// makes it. Returns { email, phone, instagram, costUsd }. Injectable for tests.
async function lookupOnce(row) {
  const ai = require('../ai');
  const CL = require('./contactLadder');
  const OQ = require('./outreachQueue');
  const region = [row.city, row.school].filter(Boolean).join(', ');
  const res = await ai.getBrandContacts(row.brand_name, null, region, ai.deepContactCtx({ market: region || null, lean: true }));
  const ladder = CL.buildContactLadder(res, { rankOf: ai.contactAuthorityRank, rootDomain: ai.rootDomain, brand: row.brand_name });
  const inbox = OQ.inboxOf(ladder);
  const phone = (ladder && ladder.mainLine && ladder.mainLine.phone) || (res && res.businessPhone) || null;
  return { email: inbox ? inbox.email : null, phone, instagram: (res && res.instagram) || null, costUsd: 0.075 };
}

async function run(pool, opts = {}) {
  const apply = opts.apply === true;
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const rows = await rowsFor(pool, opts);
  const lookup = opts.lookup || lookupOnce;
  const suppression = require('./suppression');
  const draftAddress = require('./draftAddress');
  const out = { apply, rows: rows.length, results: [], lookups: 0, lookupUsd: 0 };
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'outreach_logs'`)).rows
    .map((r) => r.column_name).filter((c) => !NO_COPY.has(c));
  for (const r of rows) {
    const res = { id: r.id, agent: r.agent_email || r.agent_id, athlete: r.athlete_name, brand: r.brand_name, was: r.why, approved: r.approved_at };
    // 1. The address, once.
    let email = null, from = null;
    const onRow = CHN.hasEmail(r.sent_to_email) ? String(r.sent_to_email).trim().toLowerCase() : null;
    if (onRow) {
      const sup = await suppression.isSuppressed(pool, onRow).catch(() => ({ suppressed: false }));
      if (!sup.suppressed) { email = onRow; from = 'the address on the row'; } else res.addressRefused = `${onRow}: ${sup.reason}`;
    }
    if (!email) {
      const cached = await draftAddress.lookupOne(pool, r.brand_name).catch(() => null);
      if (cached && CHN.hasEmail(cached.email) && !(await suppression.isSuppressed(pool, cached.email).catch(() => ({}))).suppressed) { email = cached.email.toLowerCase(); from = 'the address cache'; }
    }
    let phone = r.phone || null, instagram = r.instagram_scope === 'brand' ? null : (r.instagram || null);
    if (!email) {
      if (apply) {
        try {
          const f = await lookup(r);
          out.lookups++; out.lookupUsd += Number(f.costUsd) || 0;
          if (CHN.hasEmail(f.email) && !(await suppression.isSuppressed(pool, f.email).catch(() => ({}))).suppressed) { email = f.email.toLowerCase(); from = 'one contact lookup'; }
          phone = phone || f.phone || null; instagram = instagram || f.instagram || null;
          res.lookedUp = true;
        } catch (e) { res.lookupError = e.message; }
      } else res.wouldLookUp = true;
    }
    const channel = email ? 'email' : CHN.channelOf({ phone, instagram });
    res.becomes = email ? 'fresh email card' : channel === 'call' ? 'call card' : channel === 'dm' ? 'DM card' : (apply ? 'nothing to reach' : 'unknown until the lookup');
    res.to = email; res.from = from; res.phone = channel === 'call' ? phone : null; res.instagram = channel === 'dm' ? instagram : null;
    if (apply) {
      // 2. The fresh card, unapproved.
      if (email) {
        const dup = (await pool.query(`SELECT id FROM outreach_logs WHERE agent_id = $1 AND athlete_id = $2 AND LOWER(brand_name) = LOWER($3)
                                         AND status = 'draft' AND cadence_stopped_at IS NULL LIMIT 1`, [r.agent_id, r.athlete_id, r.brand_name])).rows[0];
        if (dup) { await pool.query(`UPDATE outreach_logs SET sent_to_email = COALESCE(NULLIF(sent_to_email, ''), $2), updated_at = NOW() WHERE id = $1`, [dup.id, email]); res.newId = dup.id; res.note = 'a draft for this business was already waiting; it has the address now'; }
        else {
          const newId = require('crypto').randomUUID();
          const list = cols.map((c) => `"${c}"`).join(', ');
          await pool.query(
            `INSERT INTO outreach_logs (id, status, sent_to_email, created_at, updated_at${list ? ', ' + list : ''})
             SELECT $2, 'draft', $3, NOW(), NOW()${list ? ', ' + list : ''} FROM outreach_logs WHERE id = $1`, [r.id, newId, email]);
          res.newId = newId;
        }
      } else if (channel) {
        const slot = ((await pool.query(`SELECT COALESCE(MAX(slot), 0)::int AS s FROM outreach_queue WHERE athlete_id = $1`, [r.athlete_id])).rows[0].s || 0) + 1;
        const q = await pool.query(
          `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, channel, state, why, contact_name, phone, instagram, dm_text, source_note, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`,
          [r.agent_id, r.athlete_id, slot, r.brand_key || ('name:' + String(r.brand_name || '').toLowerCase()), r.brand_name, channel,
            r.card_why || null, r.contact_name || null, channel === 'call' ? phone : null, channel === 'dm' ? instagram : instagram,
            channel === 'dm' ? DC.dmFromEmail(r.subject, r.body_html) : null,
            `Approved on ${String(r.approved_at).slice(0, 10)} as an email that could not be sent (${r.why}); no email address found on ${today}.`]);
        res.queueId = q.rows[0].id;
      }
      // 3. The old row, closed: it leaves the morning alert for good.
      await pool.query(
        `UPDATE outreach_logs SET status = 'expired', cadence_stopped_at = COALESCE(cadence_stopped_at, NOW()),
                cadence_stop_reason = $2, updated_at = NOW() WHERE id = $1 AND status = 'approved' AND sent_at IS NULL`,
        [r.id, `closed ${today}: approved ${String(r.approved_at && new Date(r.approved_at).toISOString()).slice(0, 10)}, never sent (${String(r.why).slice(0, 80)}); `
          + (email ? 'a fresh draft is waiting for approval' : channel ? `it is a ${channel === 'call' ? 'call' : 'DM'} card now` : 'no email, phone or Instagram found')]);
      await pool.query(`UPDATE outreach_queue SET state = 'expired', updated_at = NOW() WHERE outreach_log_id = $1 AND state = 'sending'`, [r.id]).catch(() => {});
      res.closed = true;
    }
    out.results.push(res);
  }
  out.lookupUsd = Math.round(out.lookupUsd * 100) / 100;
  return out;
}

// What an agent has on Home after this: per athlete, email cards with an
// address, call cards, DM cards. agentEmail filters to one agent.
async function onHome(pool, agentEmail) {
  const u = (await pool.query(`SELECT id, name, email FROM users WHERE LOWER(email) = LOWER($1)`, [agentEmail])).rows[0];
  if (!u) return { ok: false, error: `no agent ${agentEmail}` };
  const em = (await pool.query(
    `SELECT a.data->>'name' AS athlete, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE l.created_at::date = CURRENT_DATE)::int AS today
       FROM outreach_logs l JOIN athletes a ON a.id = l.athlete_id
      WHERE l.agent_id = $1 AND l.status = 'draft' AND l.approved_at IS NULL AND l.cadence_stopped_at IS NULL
        AND COALESCE(l.sent_to_email, '') <> '' GROUP BY 1`, [u.id])).rows;
  const qc = (await pool.query(
    `SELECT a.data->>'name' AS athlete, q.channel, COUNT(*)::int AS n FROM outreach_queue q JOIN athletes a ON a.id = q.athlete_id
      WHERE q.agent_id = $1 AND q.state = 'queued' AND q.channel IN ('call','dm') GROUP BY 1, 2`, [u.id])).rows;
  const waiting = (await pool.query(`SELECT COUNT(*)::int AS n FROM outreach_logs WHERE agent_id = $1 AND status = 'approved' AND sent_at IS NULL AND cadence_stopped_at IS NULL`, [u.id])).rows[0].n;
  const by = {};
  for (const r of em) (by[r.athlete] = by[r.athlete] || { email: 0, emailToday: 0, call: 0, dm: 0 }).email += r.n, by[r.athlete].emailToday += r.today;
  for (const r of qc) (by[r.athlete] = by[r.athlete] || { email: 0, emailToday: 0, call: 0, dm: 0 })[r.channel] += r.n;
  return { ok: true, agent: u.email, name: u.name, byAthlete: by, approvedWaitingToSend: waiting };
}

function format(out, home) {
  const L = [];
  L.push(`${out.apply ? 'APPLIED' : 'DRY RUN (nothing changed, nothing looked up; add apply=1 to do it)'}: ${out.rows} approved rows that never sent`);
  const tally = out.results.reduce((o, r) => { o[r.becomes] = (o[r.becomes] || 0) + 1; return o; }, {});
  L.push('  ' + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', '));
  if (out.apply) L.push(`  contact lookups: ${out.lookups} (about $${out.lookupUsd.toFixed(2)})`);
  else { const n = out.results.filter((r) => r.wouldLookUp).length; L.push(`  would look up ${n} businesses once each (about $${(n * 0.075).toFixed(2)})`); }
  L.push('');
  let agent = null;
  for (const r of out.results) {
    if (r.agent !== agent) { agent = r.agent; L.push(`AGENT ${agent}`); }
    L.push(`  ${String(r.athlete || '?').padEnd(18)} ${String(r.brand || '').slice(0, 34).padEnd(34)} was: ${String(r.was).slice(0, 34).padEnd(34)} -> ${r.becomes}`
      + (r.to ? ` (${r.to}, from ${r.from})` : r.phone ? ` (${r.phone})` : r.instagram ? ` (@${String(r.instagram).replace(/^@/, '')})` : '')
      + (r.closed ? '; old row closed' : '') + (r.lookupError ? `; lookup failed: ${r.lookupError}` : ''));
  }
  if (home && home.ok) {
    L.push('', `WHAT ${home.agent} (${home.name || ''}) HAS NOW${out.apply ? '' : ' (before applying)'}:`);
    for (const [ath, c] of Object.entries(home.byAthlete)) L.push(`  ${String(ath).padEnd(22)} ${c.email} email cards with an address (${c.emailToday} dated today), ${c.call} call cards, ${c.dm} DM cards`);
    if (!Object.keys(home.byAthlete).length) L.push('  nothing waiting');
    L.push(`  approved and still waiting to send: ${home.approvedWaitingToSend}`);
  }
  return L.join('\n');
}

module.exports = { run, onHome, format, rowsFor, lookupOnce };
