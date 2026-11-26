'use strict';
// ── WHY SO FEW REPLIES: THE NUMBERS, IN ONE READ ────────────────────────────
//
// ~290 pitches, 2 replies. Before changing anything, see where they went:
// who they were addressed to (a named person or info@), what kind of address,
// whether they were opened, how long they were, when they left, and how many
// got a follow-up. Read-only, admin only, and it names no business: counts,
// rates and a handful of anonymised pitch texts to read.
const FREE = /@(gmail|yahoo|hotmail|outlook|aol|icloud|me|live|msn|comcast|att|bellsouth|ymail|protonmail)\./i;
const GENERIC = /^(info|contact|hello|sales|support|admin|office|team|marketing|media|press|help|inquiries|enquiries|general|mail|customerservice|service|orders|booking|bookings|events|careers|hr|jobs|store|shop|web|webmaster|noreply|no-reply)[0-9]*@/i;

const text = (html) => String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*/g, '\n\n').trim();
const words = (t) => (t.match(/\S+/g) || []).length;

function addressKind(email) {
  const e = String(email || '').toLowerCase();
  if (!e || !e.includes('@')) return 'no address on file';
  if (GENERIC.test(e)) return 'shared inbox (info@, contact@...)';
  if (FREE.test(e)) return 'personal mail (gmail, yahoo...)';
  return 'named person at the business';
}

function tally(rows, keyOf) {
  const m = new Map();
  for (const r of rows) {
    const k = keyOf(r); if (k == null) continue;
    const t = m.get(k) || { group: k, sent: 0, opened: 0, replied: 0 };
    t.sent++; if (r.opened_at) t.opened++; if (r.replied_at || r.status === 'replied') t.replied++;
    m.set(k, t);
  }
  return [...m.values()].map((t) => ({ ...t, openRate: t.sent ? Math.round((t.opened / t.sent) * 100) : 0, replyRate: t.sent ? Math.round((t.replied / t.sent) * 1000) / 10 : 0 }))
    .sort((a, b) => b.sent - a.sent);
}

async function report(pool, { tz = 'America/Chicago' } = {}) {
  const rows = (await pool.query(`
    SELECT l.id, l.agent_id, l.status, l.subject, l.body_html, l.sent_at, l.opened_at, l.replied_at, l.follow_up_count, l.deck_id,
           COALESCE(l.touch_no, 1) AS touch, l.parent_id, (l.email_message_id IS NOT NULL) AS has_message_id,
           COALESCE(NULLIF(l.sent_to_email, ''), c.email) AS to_email,
           COALESCE(c.name, (SELECT q.contact_name FROM outreach_queue q WHERE q.outreach_log_id = COALESCE(l.parent_id, l.id) ORDER BY q.id DESC LIMIT 1)) AS to_name,
           c.title AS to_title, c.source AS contact_source, c.confidence_score, c.contact_type,
           EXTRACT(HOUR FROM (l.sent_at AT TIME ZONE $1))::int AS hr, EXTRACT(ISODOW FROM (l.sent_at AT TIME ZONE $1))::int AS dow
    FROM outreach_logs l LEFT JOIN brand_contacts c ON c.id = l.contact_id
    WHERE l.sent_at IS NOT NULL`, [tz])).rows;
  for (const r of rows) { r.text = text(r.body_html); r.words = words(r.text); }
  const agents = new Map((await pool.query(`SELECT id FROM users`)).rows.map((u, i) => [u.id, 'Agent ' + (i + 1)]));
  // A reply to any email in a thread is a reply to the business, so a thread
  // (the first email and its follow-ups) is what gets counted as answered.
  const rootOf = (r) => r.parent_id || r.id;
  const answered = new Set(rows.filter((r) => r.replied_at || r.status === 'replied').map(rootOf));
  const firsts = rows.filter((r) => Number(r.touch) === 1 && !r.parent_id);
  const blank = rows.filter((r) => r.words < 8);
  const total = tally(rows, () => 'all')[0] || { sent: 0, opened: 0, replied: 0, openRate: 0, replyRate: 0 };
  const band = (n, edges, labels) => { for (let i = 0; i < edges.length; i++) if (n < edges[i]) return labels[i]; return labels[labels.length - 1]; };
  // The same subject line reused many times reads as a mail merge.
  const subj = new Map(); for (const r of rows) { const k = String(r.subject || '').toLowerCase().replace(/\s+/g, ' ').trim(); subj.set(k, (subj.get(k) || 0) + 1); }
  const sample = (list, n) => list.slice().sort((a, b) => String(a.id).localeCompare(String(b.id))).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n)
    .map((r) => ({ subject: r.subject, words: r.words, opened: !!r.opened_at, replied: !!(r.replied_at || r.status === 'replied'), to: addressKind(r.to_email), toTitle: r.to_title || null, followUps: r.follow_up_count || 0, body: r.text.slice(0, 2500) }));
  return {
    total,
    businessesPitched: firsts.length,
    businessesThatReplied: firsts.filter((r) => answered.has(r.id)).length,
    byTouch: tally(rows, (r) => (Number(r.touch) === 1 ? 'first email' : 'follow-up ' + (Number(r.touch) - 1))),
    // Rows marked sent with nothing in them, and how many of those a mail
    // provider actually accepted (a message id came back).
    blankMarkedSent: blank.length,
    blankWithProviderId: blank.filter((r) => r.has_message_id).length,
    firstByAddress: tally(firsts, (r) => addressKind(r.to_email)),
    firstByHasName: tally(firsts, (r) => (String(r.to_name || '').trim() ? 'addressed to a person by name' : 'no name')),
    firstSent: rows.reduce((m, r) => (!m || r.sent_at < m ? r.sent_at : m), null),
    lastSent: rows.reduce((m, r) => (!m || r.sent_at > m ? r.sent_at : m), null),
    byAddress: tally(rows, (r) => addressKind(r.to_email)),
    byHasName: tally(rows, (r) => (String(r.to_name || '').trim() ? 'addressed to a person by name' : 'no name')),
    byTitle: tally(rows, (r) => { const t = String(r.to_title || '').toLowerCase(); if (!t) return 'no title known'; if (/owner|founder|ceo|president|partner|principal/.test(t)) return 'owner / founder / CEO'; if (/market|brand|commun|social|partnership|sponsor/.test(t)) return 'marketing / partnerships'; if (/manager|director|gm\b|general/.test(t)) return 'manager / director'; return 'other title'; }),
    byContactSource: tally(rows, (r) => r.contact_source || 'unknown'),
    byConfidence: tally(rows, (r) => (r.confidence_score == null ? 'no score' : band(Number(r.confidence_score), [50, 80], ['under 50', '50 to 79', '80 and up']))),
    byLength: tally(rows, (r) => band(r.words, [80, 130, 200], ['under 80 words', '80 to 129', '130 to 199', '200 and up'])),
    byHour: tally(rows, (r) => (r.hr == null ? null : band(r.hr, [8, 11, 14, 17], ['before 8 am', '8 to 11 am', '11 am to 2 pm', '2 to 5 pm', 'after 5 pm']))),
    byDay: tally(rows, (r) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][r.dow] || null),
    byFollowUps: tally(rows, (r) => String(r.follow_up_count || 0) + ' follow-ups'),
    byKit: tally(rows, (r) => (r.deck_id ? 'media kit attached' : 'no media kit')),
    byAgent: tally(rows, (r) => agents.get(r.agent_id) || 'Agent ?'),
    hasLink: tally(rows, (r) => (/https?:\/\//i.test(r.body_html || '') ? 'has a link' : 'no link')),
    hasQuestion: tally(rows, (r) => (/\?/.test(r.text) ? 'asks a question' : 'no question')),
    subjectsReused: [...subj.entries()].filter(([, n]) => n >= 3).length,
    distinctSubjects: subj.size,
    words: { median: rows.map((r) => r.words).sort((a, b) => a - b)[Math.floor(rows.length / 2)] || 0, max: rows.reduce((m, r) => Math.max(m, r.words), 0) },
    sample: sample(rows.filter((r) => !(r.replied_at || r.status === 'replied')), 12),
    replied: sample(rows.filter((r) => r.replied_at || r.status === 'replied'), 5),
  };
}

module.exports = { report, addressKind, text, tally };
