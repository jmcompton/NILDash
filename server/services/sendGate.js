'use strict';
// ── ONE GATE AT SEND TIME (SEND_GATE_ON) ─────────────────────────────────────
//
// Agents were bouncing. One account sent 11 emails in 60 days; 7 went by hand
// from the outreach editor, a Deal Scan and Write Outreach, to addresses no
// email finder ever produced or checked: general.counsel@hibbett.com,
// circleheart@myyahoo.com, an info@, a hello@. A bounce lands on the agent's
// own sending reputation, and gmail.send cannot even tell us it happened.
//
// So nothing leaves without passing THIS, wherever it was written and however
// it was sent: the Closer's release (approved cards, the approved backlog,
// follow-ups), the editor's Send, the athlete's brand email and a new message
// from the inbox. tests/sendgate.js fails if a send path skips it.
//
// THE RULE. The address belongs to a named person and has a "valid" mailbox
// verification no older than 30 days:
//   - never a legal, counsel, privacy, careers, customer-service or other
//     department inbox (emailFinder.NEVER_LOCAL), and never a shared desk
//     (info@, hello@, contact@, ...): those are not a named person;
//   - the email names a person, and the address is theirs: their first or
//     last name, their initials, or a common nickname (services/nameMatch).
//     A single letter is theirs only on their own small business;
//   - valid in email_verification within 30 days, or re-verified right now
//     with Hunter (charged to the month's verification pool as 'send-gate').
// Not valid: the send is blocked and the card offers a call or a DM instead,
// saying why. A check that could not run (Hunter down, the month spent) is
// not a verdict: the email is held and checked again, never sent unchecked.
//
// OFF UNLESS SEND_GATE_ON=1, like every new behaviour. Off, every path sends
// as before; the verification status at send time is still recorded on the
// row (no spend), so admin script bounce-report has it either way.

const lc = (s) => String(s || '').trim().toLowerCase();
const ON = () => process.env.SEND_GATE_ON === '1';
const FRESH_DAYS = 30;
const DAY = 86400000;
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;

let _cols = null;
function ensureColumns(pool) {
  if (_cols) return _cols;
  _cols = (async () => {
    for (const sql of [
      // The named person the email was written to: what the gate checks the
      // address against. The editor sends it; a card's comes from its row.
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS contact_name TEXT`,
      // At the moment it left: the verification, and the path (card / hand).
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_verify_status TEXT`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_verified_at TIMESTAMPTZ`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS send_path TEXT`,
      // A blocked send: when, why, and the call or DM offered instead.
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS gate_blocked_at TIMESTAMPTZ`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS gate_reason TEXT`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS gate_offer JSONB`,
      // "This bounced", from the agent's own inbox (gmail.send sees nothing).
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ`,
      `ALTER TABLE outreach_logs ADD COLUMN IF NOT EXISTS bounced_by TEXT`,
    ]) await pool.query(sql).catch((e) => console.error('[send-gate] ' + e.message));
  })();
  return _cols;
}

// ── THE ADDRESS ITSELF. Pure. ───────────────────────────────────────────────
// -> null when it may be a named person's address, else { code, why }.
function addressProblem(email, contactName, opts = {}) {
  const EF = require('./emailFinder');
  const e = lc(email);
  if (!e || !EMAIL_RE.test(e)) return { code: 'no-address', why: 'there is no email address to send to' };
  const local = e.split('@')[0];
  if (EF.isNever(e)) {
    return { code: 'forbidden', why: `${local}@ is a department inbox (legal, counsel, privacy, careers, customer service and the like), and NILDash never emails one` };
  }
  if (EF.isDesk(e)) return { code: 'shared', why: `${local}@ is a shared inbox, not a named person` };
  if (opts.typed) return null;            // a new inbox message: no card, so no name to hold it to
  const name = String(contactName || '').trim();
  const n = name ? require('./emailPattern').splitName(name) : null;
  // The card's own rule for a person (a role, a business name, a sentence of
  // research or an honorific is not one).
  const notPerson = name ? require('./outreachQueue').personNameProblem(name, opts.brand || null) : 'no name';
  if (!n || !n.first || n.first.length < 2 || notPerson) {
    return { code: 'no-person', why: name ? `the email is not addressed to a named person (${notPerson || 'no first name'})` : 'the email does not name the person it is for' };
  }
  const m = require('./nameMatch').match(e, name, { brand: opts.brand || null, title: opts.title || null, lane: opts.lane || null, sizeBand: opts.sizeBand || null });
  if (!m.ok) return { code: 'not-theirs', why: m.why };
  return null;
}

// The card's business details, read only for a single-letter address
// (services/nameMatch: a single letter is a name only on the person's own
// small business). Anything not found stays unknown, and unknown blocks.
async function contextFor(pool, email, opts = {}) {
  if (!require('./nameMatch').needsContext(email)) return opts;
  if (opts.title && (opts.lane || opts.sizeBand)) return opts;
  const r = (await pool.query(
    `SELECT brand_name, contact_title, lane, size_band FROM outreach_queue
      WHERE LOWER(email) = $1 AND ($2::text IS NULL OR athlete_id = $2)
      ORDER BY created_at DESC LIMIT 1`, [lc(email), opts.athleteId || null]).catch(() => ({ rows: [] }))).rows[0];
  if (!r) return opts;
  return { ...opts, brand: opts.brand || r.brand_name || null, title: opts.title || r.contact_title || null,
    lane: opts.lane || r.lane || null, sizeBand: opts.sizeBand || r.size_band || null };
}

// ── WHAT THE VERIFIER SAID, AS ONE WORD ─────────────────────────────────────
// valid | catch-all | invalid | unverified (checked, no answer) | none.
// `at`: judged as of that moment -- a check made after it did not exist then.
function categoryOf(row, at) {
  if (!row || !row.result) return 'none';
  if (at && row.checked_at && new Date(row.checked_at).getTime() > new Date(at).getTime()) return 'none';
  const EV = require('./emailVerify');
  if (row.result === 'valid') return 'valid';
  if (row.result === 'invalid') return 'invalid';
  return EV.statusOf(row) === 'accept_all' ? 'catch-all' : 'unverified';
}

async function verificationOf(pool, email) {
  const r = await pool.query(
    `SELECT email, result, detail, source, status, checked_at FROM email_verification WHERE email = $1`, [lc(email)])
    .catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

function freshValid(row, now) {
  if (!row || row.result !== 'valid' || !row.checked_at) return false;
  return (now - new Date(row.checked_at).getTime()) <= FRESH_DAYS * DAY;
}

// ── THE VERIFIER, LIVE ──────────────────────────────────────────────────────
// Hunter, with every credit logged to email_verify_credit_log as 'send-gate'
// and refused once the month's verification pool is spent.
function liveVerifier(pool, { agentId, athleteId, business } = {}) {
  return async (email) => {
    const VB = require('./verifyBudget');
    const acct = await VB.accountStatus(pool).catch(() => ({ remaining: 0, unknown: true }));
    if (acct.unknown) return { ok: false, why: 'the verification credit log could not be read' };
    if (!(acct.remaining > 0)) return { ok: false, why: "this month's verification checks are used up" };
    const day = new Date().toISOString().slice(0, 10);
    const wrote = await VB.record(pool, { agentId, athleteId, business, email, day, source: 'send-gate' });
    if (!wrote) return { ok: false, why: 'the verification credit log is not writable, so nothing is being spent' };
    return require('./hunterLookup').verifyEmail(email);
  };
}

// ── THE GATE ────────────────────────────────────────────────────────────────
// args: { email, contactName, agentId, athleteId, business, typed, now }
// deps: { verifier(email) } (tests); live Hunter otherwise.
// -> { ok: true, status: 'valid', checkedAt, reverified }
//  | { ok: false, code, why, status, retry? }   retry: the check could not run
async function check(pool, args = {}, deps = {}) {
  const now = args.now ? new Date(args.now).getTime() : Date.now();
  const email = lc(args.email);
  const ctx = await contextFor(pool, email, { typed: !!args.typed, brand: args.business || null, athleteId: args.athleteId || null,
    title: args.title || null, lane: args.lane || null, sizeBand: args.sizeBand || null });
  const prob = addressProblem(email, args.contactName, ctx);
  const row = email ? await verificationOf(pool, email) : null;
  if (prob) return { ok: false, ...prob, status: categoryOf(row) };
  if (freshValid(row, now)) return { ok: true, status: 'valid', checkedAt: row.checked_at, reverified: false };

  // Older than 30 days, or never valid: verified again, now, before it goes.
  const EV = require('./emailVerify');
  const verifier = deps.verifier || liveVerifier(pool, args);
  let v = null;
  try {
    v = (await EV.verifyMany(pool, [email], { verifier, force: true, concurrency: 1, deadlineMs: args.deadlineMs || 20000 })).get(email);
  } catch (e) { v = { result: 'unknown', detail: e.message, notRun: true }; }
  if (v && v.result === 'valid') return { ok: true, status: 'valid', checkedAt: new Date(), reverified: true };
  const was = row ? ` (last checked ${new Date(row.checked_at).toISOString().slice(0, 10)}: ${categoryOf(row)})` : '';
  if (!v || v.notRun || v.source === 'deadline' || (v.source === 'mx' && v.result !== 'invalid' && !v.implicit) || v.source === 'error') {
    return { ok: false, code: 'not-run', retry: true, status: categoryOf(row),
      why: `${email} could not be verified right now (${(v && v.detail) || 'the check did not run'})${was}` };
  }
  if (v.result === 'invalid') return { ok: false, code: 'invalid', status: 'invalid', why: `${email} does not accept mail (${v.detail || 'the verifier says invalid'})` };
  if (String(v.status || '').toLowerCase() === 'accept_all') {
    return { ok: false, code: 'catch-all', status: 'catch-all', why: `${email} is on a domain that accepts any address, so it cannot be verified` };
  }
  return { ok: false, code: 'unverified', status: 'unverified', why: `${email} could not be confirmed as a working mailbox (${v.detail || 'unknown'})` };
}

// No spend: what the cache says now. For Verified / Not verified labels, the
// stop-unverified script and the record of a send made with the gate off.
async function peek(pool, email, contactName, opts = {}) {
  const e = lc(email);
  const prob = addressProblem(e, contactName, await contextFor(pool, e, opts));
  const row = e ? await verificationOf(pool, e) : null;
  const now = opts.now ? new Date(opts.now).getTime() : Date.now();
  const valid = !prob && freshValid(row, now);
  const stale = !prob && row && row.result === 'valid' && !valid;
  return {
    email: e || null, verified: valid, stale, status: categoryOf(row), checkedAt: row ? row.checked_at : null,
    code: prob ? prob.code : (valid ? null : stale ? 'stale' : categoryOf(row)),
    label: valid ? 'Verified' : 'Not verified',
    why: prob ? prob.why : valid ? null : stale
      ? `verified ${new Date(row.checked_at).toISOString().slice(0, 10)}; checked again before it sends`
      : row ? `the verifier says ${categoryOf(row)}` : 'never verified',
  };
}

// ── WHO THE EMAIL IS FOR ────────────────────────────────────────────────────
// The name on the row, else its card, else the contact it was written to,
// else (a follow-up) the first email's.
async function contactNameFor(pool, log) {
  if (log && String(log.contact_name || '').trim()) return String(log.contact_name).trim();
  if (!log || !log.id) return null;
  await ensureColumns(pool);
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(TRIM(l.contact_name), ''),
                     (SELECT q.contact_name FROM outreach_queue q WHERE q.outreach_log_id = l.id AND q.contact_name IS NOT NULL ORDER BY q.created_at DESC LIMIT 1),
                     (SELECT c.name FROM brand_contacts c WHERE c.id = l.contact_id),
                     NULLIF(TRIM(p.contact_name), ''),
                     (SELECT q.contact_name FROM outreach_queue q WHERE q.outreach_log_id = l.parent_id AND q.contact_name IS NOT NULL ORDER BY q.created_at DESC LIMIT 1),
                     (SELECT c.name FROM brand_contacts c WHERE c.id = p.contact_id)) AS name
       FROM outreach_logs l LEFT JOIN outreach_logs p ON p.id = l.parent_id
      WHERE l.id = $1`, [String(log.id)]).catch(() => ({ rows: [] }));
  return (r.rows[0] && r.rows[0].name) || null;
}

// ── THE PATH IT TOOK: a morning card, or by hand ────────────────────────────
// A card: written by the nightly queue (its address came from the email
// finder), or a follow-up to one, sent by the release. By hand: the editor's
// Send, and anything written from a Deal Scan, Write Outreach or the editor.
async function pathOf(pool, log, how) {
  if (how === 'hand') return 'hand';
  let src = log && log.source;
  if (log && log.parent_id) {
    const r = await pool.query(`SELECT source FROM outreach_logs WHERE id = $1`, [log.parent_id]).catch(() => ({ rows: [] }));
    if (r.rows[0]) src = r.rows[0].source;
  }
  return src === 'nightly-queue' ? 'card' : 'hand';
}

async function recordSend(pool, logId, { status, checkedAt, path }) {
  await ensureColumns(pool);
  await pool.query(
    `UPDATE outreach_logs SET send_verify_status = $2, send_verified_at = $3, send_path = $4 WHERE id = $1`,
    [String(logId), status || null, checkedAt ? new Date(checkedAt) : null, path || null])
    .catch((e) => console.error('[send-gate] record ' + logId + ': ' + e.message));
}

// ── THE CALL OR DM INSTEAD ──────────────────────────────────────────────────
// The card the email belongs to, and what else it can reach them by.
async function offerFor(pool, log) {
  const r = (await pool.query(
    `SELECT q.id, q.phone, q.instagram, q.dm_text, q.contact_name, q.state, q.channel, q.sent_at
       FROM outreach_queue q
      WHERE q.athlete_id = $2 AND (q.outreach_log_id = $1 OR LOWER(q.brand_name) = LOWER($3))
      ORDER BY (q.outreach_log_id = $1) DESC, q.created_at DESC LIMIT 1`,
    [String(log.id), log.athlete_id || null, log.brand_name || '']).catch(() => ({ rows: [] }))).rows[0] || null;
  let phone = r && r.phone, instagram = r && r.instagram;
  if (!phone) {
    const p = (await pool.query(
      `SELECT evidence->>'phone' AS phone FROM brand_evidence_cache
        WHERE lane = 'places' AND LOWER(brand) = LOWER($1) AND evidence->>'phone' IS NOT NULL
        ORDER BY refreshed_at DESC LIMIT 1`, [log.brand_name || '']).catch(() => ({ rows: [] }))).rows[0];
    if (p) phone = p.phone;
  }
  const CHN = require('./cardChannel');
  const channel = CHN.channelOf({ phone, instagram });
  return channel ? { channel, phone: channel === 'call' ? phone : (phone || null), instagram: instagram || null,
    cardId: r ? r.id : null, card: r } : null;
}

function offerSentence(offer, contactName) {
  if (!offer) return 'There is no phone or Instagram on file to use instead.';
  const who = String(contactName || '').trim().split(/\s+/)[0] || 'them';
  return offer.channel === 'call'
    ? `Call ${who} instead: ${offer.phone}.`
    : `Send ${who} an Instagram DM instead: @${String(offer.instagram).replace(/^@/, '')}.`;
}

// Blocked: the email stops, says why, and its card becomes the call or DM.
// Only the first email turns its card over; a follow-up just stops (its card
// was sent already). Never touches anything sent.
async function blockAndOffer(pool, log, verdict, opts = {}) {
  await ensureColumns(pool);
  const contactName = opts.contactName || null;
  const offer = await offerFor(pool, log).catch(() => null);
  const message = `Not sent: ${verdict.why}. ${offerSentence(offer, contactName)}`;
  await pool.query(
    `UPDATE outreach_logs SET cadence_stopped_at = COALESCE(cadence_stopped_at, NOW()), cadence_stop_reason = $2,
            send_error = $2, gate_blocked_at = NOW(), gate_reason = $3, gate_offer = $4::jsonb,
            send_claimed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND sent_at IS NULL`,
    [String(log.id), message.slice(0, 600), verdict.code || null,
      offer ? JSON.stringify({ channel: offer.channel, phone: offer.phone || null, instagram: offer.instagram || null }) : null]);
  let converted = false;
  const card = offer && offer.card;
  if (card && Number(log.touch_no || 1) <= 1 && !card.sent_at && ['queued', 'sending'].includes(card.state)) {
    const DC = require('./draftChannel');
    const dmText = offer.channel === 'dm' ? (String(card.dm_text || '').trim() || DC.dmFromEmail(log.subject, log.body_html, card.contact_name || contactName)) : null;
    const u = await pool.query(
      `UPDATE outreach_queue SET channel = $2, state = 'queued',
              dm_text = CASE WHEN $2 = 'dm' THEN COALESCE(NULLIF(dm_text, ''), $3) ELSE dm_text END,
              email_note = $4, outreach_log_id = NULL, updated_at = NOW()
        WHERE id = $1 AND sent_at IS NULL AND state IN ('queued', 'sending')`,
      [card.id, offer.channel, dmText, message.slice(0, 400)]).catch((e) => { console.error('[send-gate] offer ' + card.id + ': ' + e.message); return { rowCount: 0 }; });
    converted = (u.rowCount || 0) > 0;
  }
  console.log(`[send-gate] ${log.id} "${log.brand_name}" blocked (${verdict.code}): ${verdict.why}${converted ? `; card ${card.id} is a ${offer.channel} card now` : ''}`);
  return { message, offer: offer ? { channel: offer.channel, phone: offer.phone || null, instagram: offer.instagram || null } : null, converted };
}

module.exports = {
  ON, FRESH_DAYS, ensureColumns, addressProblem, contextFor, categoryOf, verificationOf, check, peek,
  contactNameFor, pathOf, recordSend, offerFor, offerSentence, blockAndOffer, liveVerifier,
};
