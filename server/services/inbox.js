'use strict';
// ── THE INBOX: every reply a business sent, with the pitch it answered ──────
//
// The Inbox tab used to say "inbox viewing inside NILDash is on the roadmap",
// so agents read and answered replies in Gmail and the app never saw them do
// it. Reply capture already stores what a business wrote back on the outreach
// row (reply_text, reply_from, reply_subject, replied_at; see store.js "Reply
// capture"). This reads those rows, newest first, needs-reply before handled,
// and pairs each with the pitch it answered.
//
// READ ONLY. Answering happens in the agent's own mailbox: openUrl() is a link
// to that exact thread (Gmail searches by the Message-ID we set on send), so
// the reply goes out threaded, from their address, and nothing here touches the
// send path. Handled / Not interested / Signed reuse the endpoints Home uses.

const LIMIT = 100;
const DAYS = 120;

// HTML to readable text. The pitch was written by us, the reply by a business;
// both are shown as text and escaped by the page, never as markup.
function toText(html) {
  return String(html || '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The quoted pitch under a reply ("On Tue, ... wrote:") is the pitch again.
function trimQuoted(text) {
  const t = String(text || '').replace(/\r/g, '');
  const cut = t.search(/\n\s*(On .{4,200}wrote:|-{2,}\s*Original Message|From:\s.+\n\s*Sent:)/i);
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

// A link that opens this conversation in the agent's own mailbox.
function openUrl(row) {
  const mid = String(row.message_id || '').trim().replace(/^<|>$/g, '');
  const provider = String(row.provider || '').toLowerCase();
  if (provider === 'gmail' && mid) {
    return 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent('rfc822msgid:' + mid);
  }
  if ((provider === 'outlook' || provider === 'microsoft365') && row.reply_from) {
    return 'https://outlook.office.com/mail/search?q=' + encodeURIComponent(String(row.reply_from));
  }
  if (row.reply_from) {
    const subj = row.subject ? (/^re:/i.test(row.subject) ? row.subject : 'Re: ' + row.subject) : '';
    return 'mailto:' + encodeURIComponent(String(row.reply_from)) + (subj ? '?subject=' + encodeURIComponent(subj) : '');
  }
  return null;
}

async function list(pool, agentId, opts = {}) {
  const limit = Math.min(Number(opts.limit) || LIMIT, LIMIT);
  const { rows } = await pool.query(
    `SELECT l.id, l.athlete_id, l.brand_name, l.subject, l.body_html, l.sent_at, l.sent_to_email, l.message_id,
            l.replied_at, l.reply_from, l.reply_subject, l.reply_text, l.reply_handled_at,
            a.data->>'name' AS athlete_name, qc.id AS card_id, qc.outcome, ea.provider
       FROM outreach_logs l
       JOIN athletes a ON a.id = l.athlete_id
       LEFT JOIN email_accounts ea ON ea.id = l.email_account_id
       LEFT JOIN LATERAL (SELECT q.id, q.outcome FROM outreach_queue q
                           WHERE q.agent_id = l.agent_id AND q.athlete_id = l.athlete_id
                             AND (q.outreach_log_id = l.id OR q.outreach_log_id = l.parent_id OR LOWER(q.brand_name) = LOWER(l.brand_name))
                           ORDER BY (q.outreach_log_id = COALESCE(l.parent_id, l.id)) DESC, q.id DESC LIMIT 1) qc ON TRUE
      WHERE l.agent_id = $1 AND l.replied_at IS NOT NULL
        AND l.replied_at > NOW() - ($2 || ' days')::interval
      ORDER BY (l.reply_handled_at IS NULL AND COALESCE(qc.outcome, '') NOT IN ('closed', 'declined', 'dead')) DESC,
               l.replied_at DESC
      LIMIT $3`, [agentId, String(DAYS), limit]);
  const items = rows.map((r) => {
    const done = !!r.reply_handled_at || ['closed', 'declined', 'dead'].includes(String(r.outcome || ''));
    return {
      logId: r.id, cardId: r.card_id || null, outcome: r.outcome || null,
      athleteId: r.athlete_id, athlete: r.athlete_name || null,
      business: r.brand_name || null,
      from: r.reply_from || null, to: r.sent_to_email || null,
      subject: r.reply_subject || r.subject || null,
      reply: r.reply_text ? trimQuoted(r.reply_text).slice(0, 4000) : null,
      pitch: r.body_html ? toText(r.body_html).slice(0, 4000) : null,
      pitchSubject: r.subject || null,
      sentAt: r.sent_at, repliedAt: r.replied_at, handledAt: r.reply_handled_at,
      needsReply: !done,
      openUrl: openUrl(r),
    };
  });
  return { items, needsReply: items.filter((i) => i.needsReply).length };
}

module.exports = { list, toText, trimQuoted, openUrl, LIMIT, DAYS };
