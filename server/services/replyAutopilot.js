'use strict';
// ── THE CRM FILLS ITSELF IN WHEN A BUSINESS REPLIES (CRM_AUTO_ON) ──────────
//
// A reply used to change almost nothing an agent could see: the log was
// stamped, the cadence stopped, and either a bare "Reply from X" email went out
// (replies to the reply domain) or nothing at all (replies matched in a
// connected mailbox). The deal sat at "Outreach Sent" until the agent logged in
// and moved it by hand, which agents do not do.
//
// Now, once per reply (outreach_logs.reply_handled_at):
//
//   1. READ IT. One Sonnet call reads the business's reply against the pitch:
//      interested, a question, not interested, or unclear; one line of what
//      they said; and a short suggested reply in the agent's voice. The
//      suggestion never names a price or agrees to terms, and never states a
//      fact that is not in the pitch, the reply or the athlete record.
//   2. MOVE THE DEAL. The CRM stage becomes Replied (never moving a deal that
//      is already further along back). Interested or a question also moves
//      the board to Negotiating and sets the next step to Negotiate, if the
//      agent has not set one. A "no" stays Replied: the agent decides whether
//      it is a decline and why.
//   3. TELL THE AGENT. One email: who replied, about which athlete, what they
//      said, and the suggested reply ready to paste. It replaces the old bare
//      "Reply from X" email for the reply-domain path (routes/resendInbound),
//      so the agent gets one email per reply, not two.
//
// Only the agent who sent the pitch ever sees the reply or the suggestion.
// Off unless CRM_AUTO_ON=1; off, everything behaves as before.

const ON = () => /^(1|true|yes|on)$/i.test(String(process.env.CRM_AUTO_ON || '').trim());
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');
const INTENTS = ['interested', 'question', 'not_interested', 'unclear'];
// Stages a reply may overwrite; anything later (proposal, signed, paid) is kept.
const EARLY = [null, 'ask_athlete', 'sent', 'replied', 'no_reply'];

let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    for (const c of ['reply_handled_at TIMESTAMPTZ', 'reply_intent TEXT', 'reply_summary TEXT', 'reply_draft TEXT']) {
      await pool.query(`ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS ${c}`);
    }
    await require('./crm').ensureColumns(pool);
  })().catch((e) => { _cols = null; throw e; });
  return _cols;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const strip = (h) => String(h || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// The reply without the quoted pitch under it: "On Tue ... wrote:" and "> " lines.
function ownWords(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    if (/^\s*On .{3,200}wrote:\s*$/i.test(l) || /^-{2,}\s*Original Message/i.test(l) || /^\s*From:\s.+/i.test(l) && out.length) break;
    if (/^\s*>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\s+\n/g, '\n').trim().slice(0, 4000);
}
const firstName = (s) => {
  const f = String(s || '').trim().split(/\s+/)[0] || '';
  return f.length > 1 && f === f.toUpperCase() && /[A-Z]/.test(f) ? f[0] + f.slice(1).toLowerCase() : f;
};

function promptFor(c) {
  return [
    'An agent emailed a local business pitching an NIL partnership with a college athlete. The business replied.',
    '',
    `ATHLETE: ${c.athlete}${c.school ? ', ' + c.school : ''}${c.sport ? ', ' + c.sport : ''}`,
    `BUSINESS: ${c.brand}`,
    `AGENT FIRST NAME: ${c.agentFirst}`,
    c.scheduling ? `AGENT SCHEDULING LINK: ${c.scheduling}` : 'AGENT SCHEDULING LINK: none',
    '',
    'THE PITCH THE AGENT SENT:',
    c.pitch.slice(0, 2500),
    '',
    'THE BUSINESS REPLIED:',
    c.reply,
    '',
    'Return ONLY a JSON object, no other text:',
    '{"intent": "interested" | "question" | "not_interested" | "unclear",',
    ' "summary": "one short plain sentence: what they said",',
    ' "draft": "the agent\'s reply"}',
    '',
    'Rules for the draft:',
    '- 2 to 5 short sentences, plain and warm, written as the agent. Start with "Hi <their first name>," if the reply is signed with a name, else "Hi,".',
    '- Answer what they asked using only facts from the pitch, the reply or the athlete line above. If you do not know an answer, say the agent will get it to them.',
    '- Never name a price, a fee, a date, or agree to terms. The agent decides those.',
    '- Interested or a question: suggest a quick call; include the scheduling link if there is one.',
    '- Not interested: thank them in one or two sentences and leave the door open. No pushing.',
    '- No em dashes. No exclamation marks. Sign off with the agent first name only.',
  ].join('\n');
}

function parse(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const intent = INTENTS.includes(j.intent) ? j.intent : 'unclear';
    const clean = (s, n) => String(s || '').replace(/—|–/g, ', ').replace(/\s+,/g, ',').trim().slice(0, n);
    return { intent, summary: clean(j.summary, 240) || null, draft: clean(j.draft, 1500) || null };
  } catch (_) { return null; }
}

const INTENT_LINE = {
  interested: 'Sounds interested.',
  question: 'They asked a question.',
  not_interested: 'Sounds like a no for now.',
  unclear: 'Not clear yet. Worth a read.',
};

// The email to the agent. -> { subject, text, html }
function alertFor(c, r) {
  const ath = c.athlete || 'your athlete';
  const subject = `${c.brand} replied about ${ath}`;
  const lines = [
    `${c.brand} replied to your pitch for ${ath}. ${INTENT_LINE[r.intent] || ''}`.trim(),
    '',
    'What they said:',
    c.reply.slice(0, 1200),
    '',
  ];
  if (r.draft) lines.push('A reply you can send (edit anything):', '', r.draft, '');
  lines.push(`To answer, open your pitch "${c.subject || 'to them'}" in your sent mail and reply, using the suggestion if it helps.`,
    r.intent === 'interested' || r.intent === 'question' ? 'NILDash moved this deal to Negotiating.' : 'NILDash marked this deal Replied.',
    '', `Open NILDash: ${APP_URL()}/`);
  const html = `<p><b>${esc(c.brand)}</b> replied to your pitch for <b>${esc(ath)}</b>. ${esc(INTENT_LINE[r.intent] || '')}</p>`
    + `<p style="color:#374151;border-left:3px solid #d1d5db;padding-left:10px;margin:14px 0;white-space:pre-wrap">${esc(c.reply.slice(0, 1200))}</p>`
    + (r.draft ? `<p style="margin:18px 0 6px"><b>A reply you can send</b> (edit anything):</p>`
      + `<div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;white-space:pre-wrap">${esc(r.draft)}</div>` : '')
    + `<p style="color:#6b7280;font-size:13px">To answer, open your pitch "${esc(c.subject || 'to them')}" in your sent mail and reply, using the suggestion if it helps. `
    + (r.intent === 'interested' || r.intent === 'question' ? 'NILDash moved this deal to Negotiating.' : 'NILDash marked this deal Replied.') + '</p>'
    + `<p><a href="${esc(APP_URL())}/">Open NILDash</a></p>`;
  return { subject, text: lines.join('\n'), html };
}

async function sendAlert(to, msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: 'NILDash <noreply@mynildash.com>', to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
}

// Everything the read needs, for one reply. -> context or null
async function contextFor(pool, logId) {
  const r = (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.subject, l.body_html, l.reply_text, l.reply_subject,
            a.data->>'name' AS athlete, a.data->>'school' AS school, a.data->>'sport' AS sport,
            u.email AS agent_email, u.name AS agent_name, u.sign_first_name, u.scheduling_url
       FROM outreach_logs l
       JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE l.id = $1`, [logId])).rows[0];
  if (!r) return null;
  return {
    logId: r.id, agentId: r.agent_id, athleteId: r.athlete_id, brand: r.brand_name || 'The business',
    subject: r.reply_subject || r.subject || null, pitch: strip(r.body_html), reply: ownWords(r.reply_text),
    athlete: r.athlete || null, school: r.school || null, sport: r.sport || null,
    agentEmail: r.agent_email, agentFirst: firstName(r.sign_first_name || r.agent_name) || 'the agent', scheduling: r.scheduling_url || null,
  };
}

// The deal: Replied, and Negotiating with a next step when they are interested.
async function moveDeal(pool, c, intent) {
  const PIPE = require('./pipeline');
  const CRM = require('./crm');
  const warm = intent === 'interested' || intent === 'question';
  const moved = await PIPE.enterStage(pool, { athleteId: c.athleteId, agentId: c.agentId, brandName: c.brand,
    stage: warm ? 'Negotiating' : PIPE.OUTREACH_SENT, note: warm ? 'They replied: ' + (intent === 'question' ? 'a question' : 'interested') : 'They replied', source: 'reply' });
  const deal = (moved && moved.deal) || await CRM.dealFor(pool, c.agentId, c.athleteId, c.brand);
  if (!deal) return null;
  const sets = [];
  if (EARLY.includes(deal.crm_stage || null)) sets.push(`crm_stage = 'replied'`, 'crm_stage_at = NOW()');
  if (warm && !deal.next_step) sets.push(`next_step = 'negotiate'`, 'next_step_at = NOW()');
  if (sets.length) await pool.query(`UPDATE athlete_self_deals SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, [deal.id]);
  return deal.id;
}

// ── ONE REPLY ───────────────────────────────────────────────────────────────
// deps.oneShot / deps.send stand in for tests. -> what it did
async function onReply(pool, logId, { deps = {} } = {}) {
  if (!ON()) return { skipped: 'CRM_AUTO_ON is off' };
  await ensureColumns(pool);
  // Once per reply, across both paths and every instance.
  const claim = await pool.query(`UPDATE outreach_logs SET reply_handled_at = NOW() WHERE id = $1 AND reply_handled_at IS NULL AND replied_at IS NOT NULL`, [logId]);
  if (!claim.rowCount) return { skipped: 'already handled, or not a reply' };
  const c = await contextFor(pool, logId);
  if (!c || !c.agentId) return { skipped: 'no such outreach' };

  let read = { intent: 'unclear', summary: null, draft: null };
  if (c.reply) {
    try {
      const oneShot = deps.oneShot || require('../ai').oneShot;
      read = parse(await oneShot(promptFor(c), 'You read replies to NIL partnership pitches and draft short, honest answers for the agent.', 700,
        'claude-sonnet-4-6', { prose: false })) || read;
    } catch (e) { console.error(`[reply-autopilot] read failed for ${logId}: ${e.message}`); }
  }
  await pool.query(`UPDATE outreach_logs SET reply_intent = $2, reply_summary = $3, reply_draft = $4 WHERE id = $1`,
    [logId, read.intent, read.summary, read.draft]);
  let dealId = null;
  try { dealId = await moveDeal(pool, c, read.intent); } catch (e) { console.error(`[reply-autopilot] deal move failed for ${logId}: ${e.message}`); }
  let emailed = false;
  if (c.agentEmail) {
    try {
      const msg = alertFor({ ...c, reply: c.reply || '(The reply had no text we could read. Open it in your inbox.)' }, read);
      await (deps.send ? deps.send(c.agentEmail, msg) : sendAlert(c.agentEmail, msg));
      emailed = true;
    } catch (e) { console.error(`[reply-autopilot] alert to ${c.agentId} failed: ${e.message}`); }
  }
  return { logId, intent: read.intent, dealId, emailed, drafted: !!read.draft };
}

module.exports = { ON, ensureColumns, onReply, parse, alertFor, ownWords, promptFor, moveDeal, INTENTS };
