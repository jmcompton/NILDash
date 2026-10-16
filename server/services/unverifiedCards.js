'use strict';
// ── HOW AN UNVERIFIED EMAIL CARD WAS PLACED (admin script unverified-cards) ──
//
// For one night (America/Chicago), every email card the nightly queue placed
// and every email draft written that day outside a card, each with the path
// its address came from and what was known about that address. Read only.
//
// EMAIL_FIVE_ON guarded the nightly finder's own verdict, and nothing else.
// The paths an address reached an email card or a sendable draft without it:
//
//   linked-draft   the card linked to a draft written earlier (a Deal Scan
//                  pre-warm) and the DRAFT -- what sends -- kept its own
//                  address: the card said verified, the draft was not.
//   scan-prewarm   a Deal Scan wrote the draft with the site-scraped address
//                  (draftAddress.lookupOne), never verified.
//   attached       Home or the Closer stamped a scraped address on a draft
//                  with no address (draftAddress.attach): anything but a
//                  definite "invalid" attached, catch-all and unchecked too.
//   write-outreach Write Outreach stored the address a web search suggested.
//   catch-all      the finder passed a catch-all address built from a
//                  confirmed pattern: flagged verified, never "valid".
//   general-inbox  EMAIL_SMART_PICK's verified info@ / hello@ card: valid, but
//                  not a named person.
//   not-flagged    an email card placed without the verified flag.
//
// Each is closed in this change; the line says by what.

const SG = require('./sendGate');
const lc = (s) => String(s || '').trim().toLowerCase();

const CLOSED_BY = {
  'linked-draft': 'closed: a verified card now readdresses the draft it links to (jobs/outreachQueue insertCard)',
  'scan-prewarm': 'closed: under EMAIL_FIVE_ON or SEND_GATE_ON a Deal Scan draft is written with no address',
  'attached': 'closed: under EMAIL_FIVE_ON only a valid verdict attaches; under SEND_GATE_ON nothing does',
  'write-outreach': 'closed: under SEND_GATE_ON Write Outreach takes only the email finder\'s address',
  'catch-all': 'closed: under SEND_GATE_ON the nightly finder runs valid-only, and the gate blocks a catch-all at send',
  'general-inbox': 'closed: under SEND_GATE_ON no general-inbox card is placed, and the gate blocks a shared inbox at send',
  'not-flagged': 'the nightly job drops these under EMAIL_FIVE_ON; one here means FIVE was off for that run',
  'follow-up': 'closed: under SEND_GATE_ON no follow-up goes to an address never verified, or invalid since',
  'valid': null,
};

async function gather(pool, { date, agentId = null }) {
  const params = [date];
  const scopeQ = agentId ? (params.push(String(agentId)), ` AND q.agent_id = $${params.length}`) : '';
  const cards = (await pool.query(
    `SELECT q.id, q.agent_id, q.athlete_id, q.brand_name, q.email, q.email_verified, q.email_label, q.email_kind, q.email_note,
            q.contact_name, q.created_at, q.outreach_log_id,
            l.sent_to_email AS draft_email, l.source AS draft_source, l.created_at AS draft_created, l.email_kind AS draft_kind,
            l.status AS draft_status, l.sent_at AS draft_sent,
            v.result, v.status, v.detail, v.checked_at,
            u.name AS agent_name, a.data->>'name' AS athlete_name
       FROM outreach_queue q
       LEFT JOIN outreach_logs l ON l.id = q.outreach_log_id
       LEFT JOIN email_verification v ON v.email = LOWER(TRIM(COALESCE(NULLIF(l.sent_to_email, ''), q.email)))
       LEFT JOIN users u ON u.id = q.agent_id
       LEFT JOIN athletes a ON a.id = q.athlete_id
      WHERE q.channel = 'email' AND to_char((q.created_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') = $1${scopeQ}
      ORDER BY u.name NULLS LAST, q.created_at`, params)).rows;
  const scopeL = agentId ? ` AND l.agent_id = $2` : '';
  const drafts = (await pool.query(
    `SELECT l.id, l.agent_id, l.athlete_id, l.brand_name, l.sent_to_email, l.source, l.contact_id, l.email_kind, l.touch_no,
            l.status, l.sent_at, l.created_at, l.send_verify_status,
            v.result, v.status AS v_status, v.detail, v.checked_at,
            u.name AS agent_name, a.data->>'name' AS athlete_name
       FROM outreach_logs l
       LEFT JOIN email_verification v ON v.email = LOWER(TRIM(l.sent_to_email))
       LEFT JOIN users u ON u.id = l.agent_id
       LEFT JOIN athletes a ON a.id = l.athlete_id
      WHERE COALESCE(TRIM(l.sent_to_email), '') <> ''
        AND to_char((l.created_at AT TIME ZONE 'America/Chicago')::date, 'YYYY-MM-DD') = $1${scopeL}
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.outreach_log_id = l.id)
      ORDER BY u.name NULLS LAST, l.created_at`, params)).rows;
  const runs = (await pool.query(
    `SELECT agent_id, details FROM outreach_queue_runs WHERE to_char(run_date, 'YYYY-MM-DD') = $1`, [date]).catch(() => ({ rows: [] }))).rows;
  const tried = new Map();
  for (const r of runs) for (const d of (Array.isArray(r.details) ? r.details : [])) {
    for (const t of ((d && d.tried) || [])) if (t && t.result === 'queued' && t.brand) tried.set(`${r.agent_id}|${d.athleteId}|${lc(t.brand)}`, t);
  }
  return { cards, drafts, tried };
}

function category(row) { return SG.categoryOf(row && row.result ? { ...row, status: row.status || row.v_status } : null); }

// Pure. One placed email card -> { cause, detail }.
function classifyCard(c, t) {
  const f = (t && t.why && t.why.finder) || null;
  const draftAddr = lc(c.draft_email);
  if (draftAddr && draftAddr !== lc(c.email)) {
    return { cause: 'linked-draft', detail: `card ${c.email || '(none)'}; the linked ${c.draft_source || ''} draft of ${c.draft_created ? new Date(c.draft_created).toISOString().slice(0, 10) : '?'} sends to ${draftAddr} (${category(c)})` };
  }
  if (c.email_verified !== true) return { cause: 'not-flagged', detail: f ? `finder: ${f.verify ? f.verify.verdict : 'no check'}; ${f.finder && f.finder.stop ? f.finder.stop : ''}` : 'no finder record for this card' };
  if (c.email_label === 'General inbox' || (f && f.generalInbox)) return { cause: 'general-inbox', detail: `${c.email}: a verified shared inbox, not a named person` };
  if ((f && f.finder && f.finder.catchAllPass) || (f && f.verify && f.verify.pass && f.verify.verdict === 'catch-all') || category(c) === 'catch-all') {
    return { cause: 'catch-all', detail: `${c.email}: catch-all, passed as built from a confirmed pattern` };
  }
  const cat = category(c);
  if (cat !== 'valid') return { cause: 'not-flagged', detail: `${c.email}: flagged verified, but the verification on record says ${cat}` };
  return { cause: 'valid', detail: `${c.email}: valid` };
}

// Pure. One email draft written outside a card -> { cause, detail }.
function classifyDraft(d) {
  const cat = d.send_verify_status || category(d);
  const at = `${lc(d.sent_to_email)} (${cat})`;
  if (Number(d.touch_no || 1) > 1) return { cause: cat === 'valid' ? 'valid' : 'follow-up', detail: `follow-up to ${at}` };
  if (cat === 'valid') return { cause: 'valid', detail: at };
  if (d.source === 'prewarm' && !['personal', 'generic', 'corporate'].includes(d.email_kind)) return { cause: 'scan-prewarm', detail: `Deal Scan draft: ${at}` };
  if (d.source === 'prewarm') return { cause: 'scan-prewarm', detail: `Deal Scan draft, site-scraped address: ${at}` };
  if (['personal', 'generic', 'corporate'].includes(d.email_kind)) return { cause: 'attached', detail: `scraped address attached by Home or the Closer: ${at}` };
  if (d.contact_id) return { cause: 'write-outreach', detail: `Write Outreach draft: ${at}` };
  return { cause: 'attached', detail: `address of unknown provenance: ${at}` };
}

async function run(pool, opts = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : new Date().toISOString().slice(0, 10);
  const g = await gather(pool, { date, agentId: opts.agentId || null });
  const items = [];
  for (const c of g.cards) items.push({ kind: 'card', agent: c.agent_name || c.agent_id, athlete: c.athlete_name || c.athlete_id, brand: c.brand_name,
    ...classifyCard(c, g.tried.get(`${c.agent_id}|${c.athlete_id}|${lc(c.brand_name)}`)) });
  for (const d of g.drafts) items.push({ kind: 'draft', agent: d.agent_name || d.agent_id, athlete: d.athlete_name || d.athlete_id, brand: d.brand_name,
    status: d.status, sent: !!d.sent_at, ...classifyDraft(d) });
  const by = {};
  for (const it of items) by[it.cause] = (by[it.cause] || 0) + 1;
  return { date, items, by, cards: g.cards.length, drafts: g.drafts.length };
}

function format(r) {
  const L = [];
  const bad = r.items.filter((x) => x.cause !== 'valid');
  L.push(`UNVERIFIED EMAIL CARDS, ${r.date} (America/Chicago): ${r.cards} email card(s) placed by the nightly queue, ${r.drafts} email draft(s) written outside a card.`);
  L.push(`${bad.length} not a named person's valid address, by the path the address took:`);
  for (const [k, n] of Object.entries(r.by).sort((a, b) => b[1] - a[1])) {
    if (k === 'valid') continue;
    L.push(`  ${String(n).padStart(4)}  ${k}`);
    if (CLOSED_BY[k]) L.push(`        ${CLOSED_BY[k]}`);
  }
  L.push('');
  for (const it of bad) {
    L.push(`  [${it.cause}] ${it.kind === 'card' ? 'card ' : 'draft'} ${it.agent} / ${it.athlete} -> ${it.brand}${it.kind === 'draft' ? ` (${it.sent ? 'sent' : it.status})` : ''}`);
    L.push(`        ${it.detail}`);
  }
  if (!bad.length) L.push('  none');
  return L.join('\n');
}

module.exports = { gather, classifyCard, classifyDraft, run, format, CLOSED_BY };
