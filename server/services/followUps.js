'use strict';
// ── FOLLOW-UPS, WITH THE SAME APPROVE BUTTON ────────────────────────────────
//
// 52 businesses contacted, 2 replies, and not one follow-up ever reached a
// business. Three reasons, all in the old code:
//   1. closer.scheduleNextTouch wrote touch 2 the moment touch 1 sent, with an
//      EMPTY BODY, and nothing ever wrote one. On Home it read "This draft has
//      no body yet."
//   2. It was stamped created_at = the send, and shiftReport expires every
//      draft 7 days after created_at. Touch 3 was due at +9 days: it expired
//      before it was due, every time.
//   3. A reply never stopped anything. markReplied stamped the reply on the
//      row it threaded to and left the pending follow-up live.
//
// Now: a follow-up is written WHEN IT IS DUE, with its body, as an ordinary
// draft in the agent's morning queue (same card, same Approve, same send path
// with every guard in closer.releaseDue). Nothing is sent without the agent.
//
//   touch 1  the first email
//   touch 2  4 days after touch 1, no reply
//   touch 3  7 days after touch 2, no reply. The last, and the easiest to say no to.
//   then     done; the address rests 90 days (sendRules)
//
// IT NEVER STARTS, OR IT STOPS, when any of these is true:
//   they replied (to any touch, in any connected mailbox, or marked by hand)
//   the address bounced, unsubscribed or is suppressed
//   the agent marked it dead, not interested, signed, or skipped a follow-up
//   the first email never actually sent
//
// WHAT IT SAYS. Never "just following up", "checking in", "circling back",
// "bumping this" -- the cold agent's banned list, plus those. Every follow-up
// carries something the earlier touches did not: a concrete deliverable with
// a count, something the athlete has on record, an idea with another business
// nearby. NO PRICES: pitchWriter's rule, the one slip that reaches a business
// as a real number. And no sentence from an earlier touch is ever reused.

const suppression = require('./suppression');
const SIG = require('./signature');

const GAP_DAYS = { 2: 4, 3: 7 };
const MAX_TOUCHES = 3;
const REST_DAYS = 90;
// Sent more than this long ago and never followed: too old to pick up again.
const LOOKBACK_DAYS = parseInt(process.env.FOLLOWUP_LOOKBACK_DAYS, 10) || 60;
const DAY = 86400000;

let _coldBanned = [];
try { _coldBanned = require('./coldAgent').BANNED || []; } catch (_) { _coldBanned = []; }
const BANNED = _coldBanned.concat([
  /follow(ing|ed)?[- ]?up/i, /check(ing)?[- ]in\b/i, /circl(e|ing) back/i, /\bbump(ing)?\b/i,
  /touch(ing)? base/i, /just (wanted|checking|circling|following)/i, /\bper my (last|previous)\b/i,
  /\bas (i|we) (mentioned|said)\b/i, /\bin case (you|it) (missed|got)\b/i, /did you (get|see) my/i,
  /\bmy (last|previous|earlier) (email|note|message)\b/i, /\bfloat(ing)? this\b/i, /\bresurfac/i,
]);

// ── WHAT A BUSINESS OF THIS KIND COULD GET, AS A COUNT ─────────────────────
const DELIVERABLES = [
  [/restaurant|food|cafe|coffee|bakery|pizza|bar|grill|brew|taco|burger|bbq|dessert|ice cream/i,
    'two Instagram posts and one in-store meet-up'],
  [/gym|fitness|crossfit|yoga|pilates|training|martial|boxing|climb/i,
    'four short training videos filmed at the gym over a month'],
  [/salon|barber|spa|beauty|nail|lash|tattoo/i,
    'one before-and-after reel and two story mentions'],
  [/auto|car|dealer|tire|detail|motor/i,
    'one photo shoot on the lot and two posts the dealership can reuse'],
  [/clinic|chiro|physical therapy|dental|dentist|ortho|medical|health|wellness|massage/i,
    'one recovery-day video at the clinic and two story mentions'],
  [/apparel|clothing|boutique|shop|store|retail|outfit|shoe/i,
    'three posts wearing the product and one in-store signing'],
  [/bank|credit union|insurance|realty|real estate|law|financial/i,
    'one appearance at a community event and two posts'],
];
const DEFAULT_DELIVERABLE = 'two Instagram posts and one appearance at the business';
function deliverableFor(category, brand) {
  const s = `${category || ''} ${brand || ''}`;
  for (const [re, d] of DELIVERABLES) if (re.test(s)) return d;
  return DEFAULT_DELIVERABLE;
}

// ── TEXT ────────────────────────────────────────────────────────────────────
function textOf(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').trim();
}
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function words(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean); }
function shingles(s, n) {
  const w = words(s), out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
function sentencesOf(s) {
  return String(s || '').split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => words(x).length >= 4);
}

// NEVER REUSES AN EARLIER TOUCH. No sentence of an earlier touch appears, and
// no run of seven words is shared (a greeting and a sign-off are too short to
// count, and the business name alone is not a run).
function reuses(body, earlier) {
  const b = textOf(body).toLowerCase();
  const bs = shingles(b, 7);
  for (const e of earlier || []) {
    const et = textOf(e);
    for (const sent of sentencesOf(et)) if (b.includes(sent.toLowerCase())) return 'repeats a sentence from an earlier email: "' + sent.slice(0, 80) + '"';
    for (const sh of shingles(et, 7)) if (bs.has(sh)) return 'repeats a phrase from an earlier email: "' + sh + '"';
  }
  return null;
}

function checkFollowUp({ subject, body, earlier, touch }) {
  const problems = [];
  const all = `${subject || ''}\n${textOf(body)}`;
  // The subject threads ("Re: ...") and is the first email's, so it is not
  // held to the reuse rule; the body is.
  for (const re of BANNED) if (re.test(textOf(body))) problems.push('uses a phrase it may not: ' + re.source);
  try {
    const W = require('./pitchWriter');
    if (W.containsPrice(all)) problems.push('names a price');
    // The first pitch's season rule holds here too: we do not hold the
    // schedule, so a follow-up never anchors on one.
    const lint = W.lintMessage(textOf(body), {});
    for (const p of (lint && lint.problems) || []) if (/season|practice schedule/i.test(p)) problems.push(p);
  } catch (_) { /* rules unavailable */ }
  const r = reuses(body, earlier);
  if (r) problems.push(r);
  if (Number(touch) >= MAX_TOUCHES && !/tell me and i will stop/i.test(textOf(body))) problems.push('the last touch must make no easy to say');
  return problems;
}

// ── THE MATERIAL ────────────────────────────────────────────────────────────
// Only what we hold: the card, the athlete record, the market the card was
// found in. Nothing is invented and nothing is dated.
async function materialFor(pool, root) {
  const card = (await pool.query(
    `SELECT contact_name, business_category, category_key, market_key, lane
       FROM outreach_queue WHERE outreach_log_id = $1 ORDER BY id DESC LIMIT 1`, [root.id]).catch(() => ({ rows: [] }))).rows[0] || {};
  const ath = (await pool.query(`SELECT data FROM athletes WHERE id = $1`, [root.athlete_id]).catch(() => ({ rows: [] }))).rows[0];
  const a = (ath && ath.data) || {};
  const agent = (await pool.query(`SELECT name, signature_text, scheduling_url FROM users WHERE id = $1`, [root.agent_id]).catch(() => ({ rows: [] }))).rows[0] || {};
  const category = card.business_category || card.category_key || root.category_key || null;
  // ANOTHER BUSINESS NEARBY THAT FITS THEM: same market, a different kind of
  // business (never a competitor), one the agent has not pitched for this
  // athlete. Offered as an idea, never as a business that has agreed to it.
  let nearby = null;
  if (card.market_key) {
    const r = await pool.query(
      `SELECT m.brand, m.category FROM market_business_seen m
        WHERE m.market_key = $1 AND LOWER(m.brand) <> LOWER($2)
          AND COALESCE(m.category, '') <> COALESCE($3, '') AND m.category IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM outreach_logs o WHERE o.athlete_id = $4 AND LOWER(o.brand_name) = LOWER(m.brand))
        ORDER BY m.brand LIMIT 1`, [card.market_key, root.brand_name || '', category, root.athlete_id]).catch(() => ({ rows: [] }));
    nearby = r.rows[0] || null;
  }
  const first = String(card.contact_name || '').trim().split(/\s+/)[0] || null;
  return {
    contactFirst: first && /^[A-Za-z][A-Za-z'-]+$/.test(first) ? first : null,
    brand: root.brand_name || 'your business',
    category,
    athlete: { name: a.name || null, first: String(a.name || '').split(/\s+/)[0] || null, sport: a.sport || null,
      position: a.position || null, school: a.school || a.team || null,
      stats: a.stats ? String(a.stats).replace(/\s+/g, ' ').trim().slice(0, 140) : null,
      knownFor: a.knownFor ? String(a.knownFor).replace(/\s+/g, ' ').trim().slice(0, 140) : null },
    deliverable: deliverableFor(category, root.brand_name),
    nearby,
    agentFirst: String(agent.name || '').split(/\s+/)[0] || null,
    signature: SIG.signatureOf(agent),
  };
}

// ── THE WRITING ─────────────────────────────────────────────────────────────
// Short, specific, and different every touch. Several phrasings per idea, and
// the first one that clears the reuse rule against what was already sent wins.
function linesFor(m, touch) {
  const who = m.athlete.name || 'our athlete';
  const whoFirst = m.athlete.first || who;
  const out = [];
  const fact = m.athlete.stats || m.athlete.knownFor;
  if (touch === 2) {
    out.push({ key: 'deliverable', lines: [
      `Here is something concrete for ${m.brand}: ${m.deliverable}, with ${whoFirst} on camera and the content yours to keep.`,
      `A specific version for ${m.brand}: ${m.deliverable}. You approve every post before it goes up.`,
    ] });
    if (fact) out.push({ key: 'season', lines: [`On the field, ${whoFirst}'s record reads: ${fact}.`, `For context on ${whoFirst}: ${fact}.`] });
    out.push({ key: 'ask', lines: ['Would a ten-minute call this week be useful?', 'Is that worth a short call?', 'Want me to send over how that would run?'] });
  } else {
    if (m.nearby) out.push({ key: 'nearby', lines: [
      `One more idea: a joint night with ${m.nearby.brand} nearby, where ${whoFirst} brings customers to both.`,
      `It could also pair with another local spot, ${m.nearby.brand}, so the same appearance works for two businesses.`,
    ] });
    else if (fact) out.push({ key: 'season', lines: [`Worth knowing about ${whoFirst}: ${fact}.`, `${whoFirst}'s record so far: ${fact}.`] });
    else out.push({ key: 'smaller', lines: [
      `It can also start smaller: a single post and a visit, to see how ${m.brand}'s customers respond.`,
      `If a full package is too much, one post and one visit is an easy first step.`,
    ] });
    out.push({ key: 'no', lines: [`If this is not for ${m.brand}, tell me and I will stop.`, 'If this is not a fit, tell me and I will stop.'] });
  }
  return out;
}

function compose(m, touch, earlier) {
  const greet = m.contactFirst ? `Hi ${m.contactFirst},` : 'Hi,';
  const parts = linesFor(m, touch);
  const chosen = [];
  for (const p of parts) {
    let pick = null;
    for (const line of p.lines) {
      if (!reuses(line, earlier)) { pick = line; break; }
    }
    if (pick) chosen.push({ key: p.key, line: pick });
  }
  // NEVER ONLY AN ASK. Every idea for this touch was already said: offer the
  // smaller first step instead, and failing that there is nothing new to send
  // (checkFollowUp refuses it and the run reports it).
  if (!chosen.some((c) => c.key !== 'ask' && c.key !== 'no')) {
    const smaller = [
      `It can also start smaller: a single post and a visit, to see how ${m.brand}'s customers respond.`,
      `A lighter way to try it: one post and one visit from ${m.athlete.first || 'the athlete'}, nothing longer.`,
    ].find((l) => !reuses(l, earlier));
    if (smaller) chosen.unshift({ key: 'smaller', line: smaller });
  }
  const sign = m.agentFirst ? m.agentFirst : '';
  const paras = [greet, chosen.map((c) => c.line).join(' ')];
  if (sign) paras.push(sign);
  let text = paras.join('\n\n');
  text = SIG.appendText(text, m.signature);
  const html = text.split(/\n\n/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
  return { html, text, material: chosen.map((c) => c.key) };
}

function subjectFor(subject, touch) {
  const s = String(subject || '').trim();
  const base = !s ? 'An idea for you' : (/^re:/i.test(s) ? s : 'Re: ' + s);
  if (Number(touch) >= 3) return /\(last note\)$/i.test(base) ? base : base + ' (last note)';
  return base;
}

// ── THE CHAIN AND WHY IT STOPS ──────────────────────────────────────────────
async function chainOf(pool, rootId) {
  return (await pool.query(
    `SELECT * FROM outreach_logs WHERE id = $1 OR parent_id = $1 ORDER BY COALESCE(touch_no, 1), created_at`, [rootId])).rows;
}

// Every stop, in words, or null. Read fresh, so it is as true at Approve and
// at send as it was when the card was written.
async function stopReason(pool, root, chain) {
  chain = chain || await chainOf(pool, root.id);
  if (!root.sent_at) return 'the first email never sent';
  if (chain.some((c) => c.replied_at)) return 'they replied';
  const addr = suppression.normalize(root.sent_to_email);
  if (!addr) return 'no address on the first email';
  const sup = await suppression.isSuppressed(pool, addr).catch(() => ({ suppressed: false }));
  if (sup && sup.suppressed) return sup.reason || 'the address is suppressed';
  // A reply that reached a connected mailbox and has not been matched yet.
  const inbound = (await pool.query(
    `SELECT 1 FROM emails e WHERE e.user_id = $1 AND e.direction = 'received' AND LOWER(e.from_address) = $2 AND e.sent_at > $3 AND COALESCE(e.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of (the )?office|autoreply|auto:|away from)' LIMIT 1`,
    [root.agent_id, addr, root.sent_at]).catch(() => ({ rows: [] }))).rows[0];
  if (inbound) return 'they replied (in the connected mailbox)';
  // What the agent said on the card or the ledger: replied, no, signed, dead.
  const card = (await pool.query(
    `SELECT outcome, replied_at FROM outreach_queue WHERE outreach_log_id = $1 OR (athlete_id = $2 AND LOWER(brand_name) = LOWER($3) AND state = 'sent')
      ORDER BY (outcome IS NOT NULL) DESC LIMIT 1`, [root.id, root.athlete_id, root.brand_name || '']).catch(() => ({ rows: [] }))).rows[0];
  if (card && card.replied_at) return 'they replied';
  if (card && card.outcome && card.outcome !== 'no_reply') return `the agent marked it ${card.outcome === 'closed' ? 'signed' : card.outcome}`;
  const led = (await pool.query(
    `SELECT state, outcome FROM brand_engagement WHERE athlete_id = $1 AND (brand_key = $2 OR LOWER(brand_name) = LOWER($3)) LIMIT 1`,
    [root.athlete_id, root.brand_key || '', root.brand_name || '']).catch(() => ({ rows: [] }))).rows[0];
  if (led && ['responded', 'closed', 'dead'].includes(led.state)) return led.state === 'dead' ? 'the agent marked it dead' : 'they ' + (led.state === 'closed' ? 'signed' : 'replied');
  // A follow-up the agent skipped ends the sequence: that was a no from them.
  if (chain.some((c) => Number(c.touch_no || 1) > 1 && (c.status === 'skipped' || (c.cadence_stopped_at && c.body_html && /skip/i.test(c.cadence_stop_reason || ''))))) return 'the agent skipped a follow-up';
  return null;
}

// ── REPLIES AND BOUNCES IN CONNECTED MAILBOXES ──────────────────────────────
// emailSync copies every agent's Gmail / Outlook / IMAP into `emails`, and
// nothing ever matched a received message back to the outreach it answered.
// A business that wrote back to the agent's own inbox was never a reply here.
async function detectMailboxReplies(pool, { agentId, since } = {}) {
  const FU = require('./followUpAutomation');
  const rows = (await pool.query(
    `SELECT l.id, l.agent_id, l.sent_to_email, l.sent_at, e.sent_at AS reply_at, e.from_address, e.subject, e.body_text
       FROM outreach_logs l
       JOIN LATERAL (SELECT sent_at, from_address, subject, body_text FROM emails e
                      WHERE e.user_id = l.agent_id AND e.direction = 'received'
                        AND LOWER(e.from_address) = LOWER(l.sent_to_email) AND e.sent_at > l.sent_at AND COALESCE(e.subject, '') !~* '^(automatic reply|auto[- ]?reply|out of (the )?office|autoreply|auto:|away from)'
                      ORDER BY e.sent_at ASC LIMIT 1) e ON TRUE
      WHERE l.sent_at IS NOT NULL AND l.replied_at IS NULL AND l.sent_to_email IS NOT NULL
        AND l.sent_at > $1 ${agentId ? 'AND l.agent_id = $2' : ''}
      ORDER BY l.sent_at`, agentId ? [since || new Date(Date.now() - 120 * DAY), agentId] : [since || new Date(Date.now() - 120 * DAY)]).catch((e) => { console.error('[followUps] reply scan:', e.message); return { rows: [] }; })).rows;
  let n = 0;
  for (const r of rows) {
    await FU.markReplied(r.id, r.reply_at, { text: r.body_text, from: r.from_address, subject: r.subject, via: 'mailbox' });
    n++;
  }
  // BOUNCES that landed in the mailbox (mailer-daemon / postmaster naming the
  // address): suppressed, and the sequence never starts or stops.
  const b = (await pool.query(
    `SELECT l.*, e.body_text AS bounce_text FROM outreach_logs l
       JOIN LATERAL (SELECT body_text FROM emails e
                      WHERE e.user_id = l.agent_id AND e.direction = 'received' AND e.sent_at > l.sent_at
                        AND (LOWER(e.from_address) LIKE 'mailer-daemon@%' OR LOWER(e.from_address) LIKE 'postmaster@%')
                        AND POSITION(LOWER(l.sent_to_email) IN LOWER(COALESCE(e.body_text, ''))) > 0 LIMIT 1) e ON TRUE
      WHERE l.sent_at IS NOT NULL AND l.sent_to_email IS NOT NULL AND l.sent_at > $1 ${agentId ? 'AND l.agent_id = $2' : ''}`,
    agentId ? [since || new Date(Date.now() - 120 * DAY), agentId] : [since || new Date(Date.now() - 120 * DAY)]).catch(() => ({ rows: [] }))).rows;
  for (const l of b) {
    if (await suppression.isSuppressed(pool, l.sent_to_email).then((x) => x.suppressed).catch(() => false)) continue;
    await suppression.onBounce(pool, l, { reason: 'bounced (mailbox)', text: 'permanent failure ' + String(l.bounce_text || '').slice(0, 300) }).catch(() => {});
  }
  return { replies: n, bounces: b.length };
}

// ── WHAT IS DUE ─────────────────────────────────────────────────────────────
// Every first email sent in the lookback, and for each: the next touch, when
// it is due, and whether anything stops it.
async function plan(pool, { now, agentId } = {}) {
  const t = now ? new Date(now) : new Date();
  const roots = (await pool.query(
    `SELECT * FROM outreach_logs
      WHERE parent_id IS NULL AND COALESCE(touch_no, 1) = 1 AND sent_at IS NOT NULL
        AND sent_at > $1 ${agentId ? 'AND agent_id = $2' : ''}
      ORDER BY sent_at`, agentId ? [new Date(t.getTime() - LOOKBACK_DAYS * DAY), agentId] : [new Date(t.getTime() - LOOKBACK_DAYS * DAY)])).rows;
  const out = [];
  for (const root of roots) {
    const chain = await chainOf(pool, root.id);
    const sent = chain.filter((c) => c.sent_at);
    const last = sent[sent.length - 1];
    const lastTouch = Number(last.touch_no || 1);
    if (lastTouch >= MAX_TOUCHES) { out.push({ root, done: 'three touches sent' }); continue; }
    const next = lastTouch + 1;
    const dueAt = new Date(new Date(last.sent_at).getTime() + GAP_DAYS[next] * DAY);
    const pending = chain.find((c) => Number(c.touch_no || 1) === next && !c.sent_at);
    const why = await stopReason(pool, root, chain);
    if (why) { out.push({ root, next, dueAt, stop: why, pending }); continue; }
    // The agent let a written follow-up lapse: that sequence is over.
    if (pending && pending.status === 'expired' && pending.body_html) { out.push({ root, next, dueAt, done: 'the follow-up expired unapproved', pending }); continue; }
    // Stopped with a body: the agent saw it and said no. Stopped WITHOUT one
    // was the old empty card ("This draft has no body yet") -- there was
    // nothing to approve, so skipping it is not an answer. It is written now.
    if (pending && pending.cadence_stopped_at && pending.body_html) { out.push({ root, next, dueAt, done: 'stopped: ' + (pending.cadence_stop_reason || ''), pending }); continue; }
    // Written and waiting on the agent (or approved and on its way).
    if (pending && pending.body_html && ['draft', 'approved'].includes(pending.status)) { out.push({ root, next, dueAt, waiting: true, pending }); continue; }
    out.push({ root, next, dueAt, due: dueAt.getTime() <= t.getTime(), pending, chain });
  }
  return out;
}

// ── WRITE THE DUE ONES ──────────────────────────────────────────────────────
async function prepare(pool, item, { now } = {}) {
  const { root, next } = item;
  const chain = item.chain || await chainOf(pool, root.id);
  const earlier = chain.filter((c) => c.sent_at).map((c) => c.body_html);
  const m = await materialFor(pool, root);
  const body = compose(m, next, earlier);
  const subject = subjectFor(root.subject, next);
  const problems = checkFollowUp({ subject, body: body.html, earlier, touch: next });
  if (!body.material.some((k) => k !== 'ask' && k !== 'no')) problems.push('nothing new to say that the earlier emails did not');
  if (problems.length) return { ok: false, root: root.id, why: problems.join('; ') };
  const id = `${root.id}-t${next}`;
  // created_at is NOW, so the 7-day draft expiry counts from when the agent
  // could first see it, not from the first send.
  await pool.query(
    `INSERT INTO outreach_logs
       (id, agent_id, athlete_id, brand_name, brand_key, contact_id, enrichment_id,
        subject, body_html, status, touch_no, parent_id, sent_to_email,
        angle, angle_key, category_key, next_follow_up_at, source, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11,$12,$13,$14,$15,$16,'follow-up',$17,$17)
     ON CONFLICT (id) DO UPDATE
       SET subject = EXCLUDED.subject, body_html = EXCLUDED.body_html, status = 'draft',
           next_follow_up_at = EXCLUDED.next_follow_up_at, source = 'follow-up',
           created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at,
           cadence_stopped_at = NULL, cadence_stop_reason = NULL, approved_at = NULL
     WHERE outreach_logs.sent_at IS NULL`,
    [id, root.agent_id, root.athlete_id, root.brand_name, root.brand_key, root.contact_id, root.enrichment_id,
      subject, body.html, next, root.id, root.sent_to_email, 'follow-up', 'follow-up-' + body.material.join('+'),
      root.category_key, item.dueAt || new Date(), now ? new Date(now) : new Date()]);
  return { ok: true, id, touch: next, material: body.material };
}

// The whole pass: match replies, then write what is due. Run by the hourly
// poller (followUpAutomation) and on demand from admin.
async function run(pool, { now, agentId } = {}) {
  const out = { replies: 0, bounces: 0, written: [], refused: [], stopped: [], waiting: 0, notYet: 0, done: 0 };
  try { const d = await detectMailboxReplies(pool, { agentId }); out.replies = d.replies; out.bounces = d.bounces; }
  catch (e) { console.error('[followUps] mailbox scan failed:', e.message); }
  const items = await plan(pool, { now, agentId });
  for (const it of items) {
    if (it.stop) {
      out.stopped.push({ root: it.root.id, brand: it.root.brand_name, why: it.stop });
      if (it.pending && !it.pending.sent_at && !it.pending.cadence_stopped_at) await suppression.stopCadence(pool, it.root, it.stop).catch(() => {});
      continue;
    }
    if (it.done) { out.done++; continue; }
    if (it.waiting) { out.waiting++; continue; }
    if (!it.due) { out.notYet++; continue; }
    const r = await prepare(pool, it, { now }).catch((e) => ({ ok: false, root: it.root.id, why: 'our failure: ' + e.message }));
    if (r.ok) out.written.push({ id: r.id, brand: it.root.brand_name, touch: r.touch, material: r.material });
    else out.refused.push({ root: it.root.id, brand: it.root.brand_name, why: r.why });
  }
  if (out.written.length || out.replies || out.refused.length) {
    console.log(`[followUps] wrote ${out.written.length}, matched ${out.replies} mailbox repl${out.replies === 1 ? 'y' : 'ies'}, refused ${out.refused.length}, stopped ${out.stopped.length}`);
  }
  return out;
}

// Called at send time by closer.releaseDue for any touch above 1.
async function stopForSend(pool, log) {
  if (Number(log.touch_no || 1) <= 1 || !log.parent_id) return null;
  const root = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1`, [log.parent_id])).rows[0];
  if (!root) return 'the first email is gone';
  const chain = await chainOf(pool, root.id);
  if (chain.filter((c) => c.sent_at).length >= MAX_TOUCHES) return 'three touches already sent';
  return stopReason(pool, root, chain);
}

// ── A CARD'S HISTORY, IN ORDER ──────────────────────────────────────────────
// "Sent Sep 12 · no reply · follow-up 1 sent Sep 16 · replied Sep 18"
function historyOf(chain, now) {
  const t = now ? new Date(now) : new Date();
  const d = (x) => new Date(x).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const ev = [];
  for (const c of chain) {
    const n = Number(c.touch_no || 1);
    if (c.sent_at) ev.push({ at: c.sent_at, text: (n === 1 ? 'Sent ' : `Follow-up ${n - 1} sent `) + d(c.sent_at) });
    if (c.replied_at) ev.push({ at: c.replied_at, text: 'Replied ' + d(c.replied_at), replied: true });
    if (!c.sent_at && c.cadence_stopped_at && n > 1) ev.push({ at: c.cadence_stopped_at, text: `Follow-up ${n - 1} stopped: ${c.cadence_stop_reason || 'stopped'}` });
  }
  ev.sort((a, b) => new Date(a.at) - new Date(b.at));
  const out = ev.map((e) => e.text);
  const anyReply = ev.some((e) => e.replied);
  const lastSent = chain.filter((c) => c.sent_at).pop();
  if (!anyReply && lastSent && t - new Date(lastSent.sent_at) > DAY) out.push('no reply');
  return out;
}

module.exports = {
  GAP_DAYS, MAX_TOUCHES, REST_DAYS, LOOKBACK_DAYS, BANNED,
  deliverableFor, textOf, reuses, checkFollowUp, materialFor, compose, subjectFor,
  chainOf, stopReason, detectMailboxReplies, plan, prepare, run, stopForSend, historyOf,
};
