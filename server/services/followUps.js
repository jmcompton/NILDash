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
// a count, something the athlete has on record, a smaller way to start.
// NO PRICES: pitchWriter's rule, the one slip that reaches a business as a
// real number. And no sentence from an earlier touch is ever reused.
//
// IT NAMES NO OTHER BUSINESS. The last touch used to offer "a joint night
// with <another business> nearby", and the other business was whichever came
// first in the alphabet in that market: an insurance company was offered a
// joint night with a hardware store whose name starts with a digit. Nobody
// had agreed to it and it made no sense. A follow-up now talks about the
// business it is written to and the athlete, and nothing else
// (checkFollowUp refuses a body that carries the old lines).

const suppression = require('./suppression');
const SIG = require('./signature');

const GAP_DAYS = { 2: 4, 3: 7 };
const MAX_TOUCHES = 3;
const REST_DAYS = 90;
// Sent more than this long ago and never followed: too old to pick up again.
const LOOKBACK_DAYS = parseInt(process.env.FOLLOWUP_LOOKBACK_DAYS, 10) || 60;
const DAY = 86400000;

// The old last-touch lines (see the header). Any draft still carrying one is
// rewritten at start-up (retireOldDrafts) and refused here.
const OTHER_BUSINESS = /\bjoint night with\b|\bpair with another local spot\b/i;
// A real email has a greeting, a point and a name under it.
const MIN_WORDS = 12;

let _coldBanned = [];
try { _coldBanned = require('./coldAgent').BANNED || []; } catch (_) { _coldBanned = []; }
const BANNED = _coldBanned.concat([
  /follow(ing|ed)?[- ]?up/i, /check(ing)?[- ]in\b/i, /circl(e|ing) back/i, /\bbump(ing)?\b/i,
  /touch(ing)? base/i, /just (wanted|checking|circling|following)/i, /\bper my (last|previous)\b/i,
  /\bas (i|we) (mentioned|said)\b/i, /\bin case (you|it) (missed|got)\b/i, /did you (get|see) my/i,
  /\bmy (last|previous|earlier) (email|note|message)\b/i, /\bfloat(ing)? this\b/i, /\bresurfac/i,
]);

// ── WHAT A BUSINESS OF THIS KIND COULD GET, AS A COUNT ─────────────────────
// Whole words only, most specific first. "bar" used to match a barbershop and
// "shop" a bookshop; an emergency vet matched nothing sensible. A kind of
// business with no natural fit gets the plain default.
const DELIVERABLES = [
  [/\b(salon|barber\w*|spa|beauty|nails?|lash\w*|tattoo)\b/i,
    'one reel filmed at the shop and two story mentions'],
  [/\b(gym|fitness|crossfit|yoga|pilates|training|martial|boxing|climbing)\b/i,
    'four short training videos filmed at the gym over a month'],
  [/\b(dental|dentist\w*|orthodont\w*|optometr\w*|eye care|veterinar\w*|animal|pet)\b/i,
    'two posts and one visit to the office'],
  [/\b(clinic|chiropract\w*|physical therapy|wellness|massage|recovery)\b/i,
    'one recovery-day video at the clinic and two story mentions'],
  [/\b(auto|cars?|dealer\w*|tires?|detailing|motors?)\b/i,
    'one photo shoot on the lot and two posts the dealership can reuse'],
  [/\b(restaurant|food|cafe|coffee|bakery|pizza\w*|grill|brew\w*|tacos?|burgers?|bbq|dessert|ice cream|deli|diner|kitchen|eatery|bar)\b/i,
    'two Instagram posts and one in-store meet-up'],
  [/\b(apparel|clothing|boutique|outfitters?|shoes?|sporting goods|sportswear)\b/i,
    'three posts wearing the product and one in-store signing'],
  [/\b(bank|credit union|insurance|realty|real estate|law|financial|mortgage)\b/i,
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
  if (OTHER_BUSINESS.test(textOf(body))) problems.push('offers a tie-in with another business nobody agreed to');
  if (words(textOf(body)).length < MIN_WORDS) problems.push('has almost nothing in it');
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
  const agent = (await pool.query(`SELECT name, email, signature_text, scheduling_url, sign_first_name FROM users WHERE id = $1`, [root.agent_id]).catch(() => ({ rows: [] }))).rows[0] || {};
  const category = card.business_category || card.category_key || root.category_key || null;
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
    // Their "First name for sign-offs" under AGENT_SETUP_ON when set
    // (services/agentName.signOffSetting); otherwise the first word, as before.
    agentFirst: require('./agentName').signOffSetting(agent) || String(agent.name || '').split(/\s+/)[0] || null,
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
    if (fact) out.push({ key: 'season', lines: [`A bit more on ${whoFirst}: ${fact}.`, `For context on ${whoFirst}: ${fact}.`] });
    out.push({ key: 'ask', lines: ['Would a ten-minute call this week be useful?', 'Is that worth a short call?', 'Want me to send over how that would run?'] });
  } else {
    // The last note: a smaller way in, and an easy no. Nothing else.
    out.push({ key: 'smaller', lines: [
      `Last note from me on this. If a full partnership is more than ${m.brand} wants right now, it can start small: one post and one visit from ${whoFirst}, and you see how your customers respond.`,
      `One last thought: this can start with a single post and one visit from ${whoFirst}, nothing longer, so ${m.brand} can judge it before doing more.`,
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
  // The idea, then the question (or the easy no) on a line of its own.
  const closeKeys = new Set(['ask', 'no']);
  const paras = [greet, chosen.filter((c) => !closeKeys.has(c.key)).map((c) => c.line).join(' '), chosen.filter((c) => closeKeys.has(c.key)).map((c) => c.line).join(' ')].filter(Boolean);
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
// A reason that is not a stop: the address check could not run this pass, so
// the follow-up waits for the next one. Never written to the row.
const HOLD = 'hold: ';
const isHold = (why) => typeof why === 'string' && why.startsWith(HOLD);

// opts.atSend: called by the send loop, which verifies the address itself
//   (sendGate.check, live, right after this), so only a known-invalid stops.
// opts.gateDeps: { verifier } for tests.
async function stopReason(pool, root, chain, opts = {}) {
  chain = chain || await chainOf(pool, root.id);
  if (!root.sent_at) return 'the first email never sent';
  if (chain.some((c) => c.replied_at)) return 'they replied';
  const addr = suppression.normalize(root.sent_to_email);
  if (!addr) return 'no address on the first email';
  const sup = await suppression.isSuppressed(pool, addr).catch(() => ({ suppressed: false }));
  if (sup && sup.suppressed) return sup.reason || 'the address is suppressed';
  // ── NEVER A FOLLOW-UP TO AN ADDRESS NOBODY VERIFIED (SEND_GATE_ON) ─────
  // A follow-up to an address that was never verified valid, or that has
  // verified invalid since the first email, is the same bounce twice more.
  // Known valid at the first send (recorded on the row), or valid in the
  // cache; never an invalid verdict since.
  if (require('./sendGate').ON()) {
    const SG = require('./sendGate');
    const v = await SG.verificationOf(pool, addr);
    if (v && v.result === 'invalid') return `the address verified invalid${v.checked_at && new Date(v.checked_at) > new Date(root.sent_at) ? ' since the first email' : ''} (${v.detail || 'the verifier says invalid'})`;
    if (!opts.atSend && root.send_verify_status !== 'valid' && !(v && v.result === 'valid')) {
      const cat = SG.categoryOf(v);
      if (cat === 'catch-all') return 'the address is on a domain that accepts any address, so it cannot be verified and no follow-up goes to it';
      // No check on record, or a check that got no answer: check it NOW
      // instead of giving up on a thread nobody ever verified. (Nov 13: follow-
      // ups died as "never verified (no check on record)" for addresses that
      // were simply never asked about.) The send loop checks again at send.
      const who = await SG.contactNameFor(pool, root).catch(() => null);
      const g = await SG.check(pool, { email: addr, contactName: who, agentId: root.agent_id, athleteId: root.athlete_id, business: root.brand_name },
        opts.gateDeps || {}).catch((e) => ({ ok: false, retry: true, why: 'the address check failed on our side: ' + e.message }));
      if (g.retry) return HOLD + g.why;
      if (!g.ok) return `the address did not verify (${g.why}), so no follow-up goes to it`;
    }
  }
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
async function plan(pool, { now, agentId, gateDeps } = {}) {
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
    const why = await stopReason(pool, root, chain, { gateDeps });
    if (isHold(why)) { out.push({ root, next, dueAt, waiting: true, hold: why.slice(HOLD.length), pending }); continue; }
    if (why) { out.push({ root, next, dueAt, stop: why, pending }); continue; }
    // The agent let a written follow-up lapse: that sequence is over.
    if (pending && pending.status === 'expired' && pending.body_html) { out.push({ root, next, dueAt, done: 'the follow-up expired unapproved', pending }); continue; }
    // Stopped with a body: the agent saw it and said no. Stopped WITHOUT one
    // was the old empty card ("This draft has no body yet") -- there was
    // nothing to approve, so skipping it is not an answer. It is written now.
    // EXCEPT the ones stopped by the old "never verified (no check on record)"
    // rule: nobody said no to those, the address was just never asked about.
    // It has been checked above (stopReason), so the follow-up is written again.
    const wrongStop = !!(pending && pending.cadence_stopped_at && !pending.sent_at && /address was never verified \(no check on record\)/.test(pending.cadence_stop_reason || ''));
    if (!wrongStop && pending && pending.cadence_stopped_at && pending.body_html) { out.push({ root, next, dueAt, done: 'stopped: ' + (pending.cadence_stop_reason || ''), pending }); continue; }
    // Written and waiting on the agent (or approved and on its way).
    if (!wrongStop && pending && pending.body_html && ['draft', 'approved'].includes(pending.status)) { out.push({ root, next, dueAt, waiting: true, pending }); continue; }
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
async function run(pool, { now, agentId, gateDeps } = {}) {
  const out = { replies: 0, bounces: 0, written: [], refused: [], stopped: [], waiting: 0, notYet: 0, done: 0 };
  try { const d = await detectMailboxReplies(pool, { agentId }); out.replies = d.replies; out.bounces = d.bounces; }
  catch (e) { console.error('[followUps] mailbox scan failed:', e.message); }
  await retireOldDrafts(pool);
  const items = await plan(pool, { now, agentId, gateDeps });
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

// Follow-ups written before this rule and not yet sent: cleared, so the next
// pass writes them again the new way. An approved one goes back to a draft.
// Nothing that already went out is touched.
async function retireOldDrafts(pool) {
  const r = await pool.query(
    `UPDATE outreach_logs SET body_html = NULL, status = 'draft', approved_at = NULL, updated_at = NOW()
      WHERE sent_at IS NULL AND COALESCE(touch_no, 1) > 1 AND status IN ('draft', 'approved')
        AND body_html ~* 'joint night with|pair with another local spot'`).catch((e) => { console.error('[followUps] retire old drafts:', e.message); return { rowCount: 0 }; });
  if (r.rowCount) console.log(`[followUps] ${r.rowCount} follow-up draft(s) written the old way were cleared to be rewritten`);
  return r.rowCount || 0;
}

// Called at send time by closer.releaseDue for any touch above 1.
async function stopForSend(pool, log) {
  if (Number(log.touch_no || 1) <= 1 || !log.parent_id) return null;
  if (OTHER_BUSINESS.test(textOf(log.body_html))) return 'this follow-up was written the old way and is being rewritten';
  const root = (await pool.query(`SELECT * FROM outreach_logs WHERE id = $1`, [log.parent_id])).rows[0];
  if (!root) return 'the first email is gone';
  const chain = await chainOf(pool, root.id);
  if (chain.filter((c) => c.sent_at).length >= MAX_TOUCHES) return 'three touches already sent';
  return stopReason(pool, root, chain, { atSend: true });
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
  chainOf, stopReason, isHold, retireOldDrafts, OTHER_BUSINESS, MIN_WORDS, detectMailboxReplies, plan, prepare, run, stopForSend, historyOf,
};
