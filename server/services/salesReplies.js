'use strict';
// ── REPLIES TO THE SALES AUTOPILOT (services/salesAutopilot) ─────────────────
//
// Every few minutes it reads JohnMark's inbox (salesMailbox) since the last
// look and handles what came back from a prospect:
//   - a REPLY stops the sequence at once, is tagged interested, not now,
//     wrong person or unsubscribe, and moves to the "NILDash Prospects"
//     folder so his main inbox stays clean. Nothing is answered for him.
//     Interested: he is emailed right away with the thread and a suggested
//     answer. Unsubscribe: the address goes on the suppression list.
//   - an AUTO-REPLY (out of office) is moved, and changes nothing.
//   - a BOUNCE stops the sequence, suppresses the address, and counts toward
//     the 2% hard stop.
//   - a SPAM COMPLAINT, or any MICROSOFT WARNING that the mailbox was
//     limited, stops the autopilot (salesAutopilot.pause), which emails him why.
//   - a DEMO BOOKED (on his calendar, or a scheduler's notice in his inbox)
//     stops the sequence.

const MB = require('./salesMailbox');
const lc = (s) => String(s || '').trim().toLowerCase();

// ── WHAT A MESSAGE IS ──────────────────────────────────────────────────────
function header(m, name) {
  const h = (m && m.internetMessageHeaders) || [];
  const x = h.find((y) => lc(y.name) === lc(name));
  return x ? String(x.value || '') : '';
}
const BOUNCE_FROM = /^(postmaster|mailer-daemon|microsoftexchange[a-z0-9]*|mail-?delivery|mdaemon)@/i;
const BOUNCE_SUBJECT = /^(undeliverable|undelivered|delivery (status notification|has failed|failure)|mail delivery (failed|failure|subsystem)|returned mail|failure notice|message not delivered|could not be delivered)/i;
function isBounce(m) {
  const from = MB.fromOf(m);
  return BOUNCE_FROM.test(from) || BOUNCE_SUBJECT.test(String(m.subject || '').trim());
}
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?(reply|response)|out of (the )?office|ooo\b|away from (my|the) (desk|office)|on vacation|i am (out|away))/i;
function isAutoReply(m) {
  const auto = lc(header(m, 'auto-submitted'));
  if (auto && auto !== 'no') return true;
  if (header(m, 'x-autoreply') || header(m, 'x-autorespond')) return true;
  return AUTO_SUBJECT.test(String(m.subject || '').trim());
}
// Microsoft telling the mailbox it was limited or restricted.
const MS_FROM = /@(microsoft\.com|microsoftonline\.com|office365\.com|outlook\.com|email\.microsoft\.com|accountprotection\.microsoft\.com)$/i;
const MS_WARNING = /(sending limit|send(ing)? (has been )?(restricted|blocked|suspended)|restricted from sending|blocked from sending|exceeded (the|your) (daily )?(sending|recipient|message) limit|unusual (sending|activity)|suspicious (sending|activity)|outbound spam|account (has been )?(restricted|suspended|locked))/i;
function isMicrosoftWarning(m, text) {
  return MS_FROM.test(MB.fromOf(m)) && MS_WARNING.test(`${m.subject || ''}\n${text || ''}`);
}
// A bounce that is about OUR sending (Microsoft limited the mailbox), not the
// prospect's address.
const NDR_LIMIT = /(5\.2\.0[^\n]{0,80}(quota|outboundspam|submission)|OutboundSpamException|SubmissionQuotaExceeded|5\.1\.90|5\.7\.708|550 5\.1\.8|sending limit|exceeded the (daily )?(recipient|message|sending) limit|message rate limit|throttl)/i;

// Their words only: the quoted email below them cut off.
function ownWords(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) break;
    if (/^\s*(On .{4,200} wrote:|From:\s|-----\s*Original Message|_{8,}|Sent from my )/i.test(l)) break;
    out.push(l);
  }
  return out.join('\n').trim();
}

// ── TAGS ───────────────────────────────────────────────────────────────────
const COMPLAINT = /\b(spam|spamming|spammer|reported (you|this)|report(ing)? (you|this) (as|to)|harass\w*|how did you get (my|this) (email|address)|unsolicited|attorney general|ftc|can-?spam violation)\b/i;
const UNSUB = /\b(unsubscribe|remove me|take me off|stop (emailing|e-?mailing|contacting|sending|messaging)|do not (email|e-?mail|contact)|don'?t (email|e-?mail|contact) me|opt(ed)?[- ]?out|no more emails?)\b/i;
const WRONG = /\b(wrong (person|contact|guy|email)|not the (right )?(person|contact)|no longer (with|at|work|employed)|(i|i've|i have) (left|retired)|(reach out|speak|talk) (to|with) (my|our|the)|you'?ll want (to (talk|speak) (to|with))?|best person (to|is|would be)|forward(ed|ing)? (this|your (note|email|message)))\b/i;
const NOT_NOW = /\b(not (right )?now|not at this time|maybe (later|next)|next (month|quarter|year|season|semester)|check back|circle back|reach (back )?out (again )?(in|after|next)|after (the|our) season|too busy|not interested|no thanks|no thank you|we'?re (all )?set|pass for now|not a fit|not for us|not a priority)\b/i;
const INTERESTED = /\b(interested|let'?s (talk|chat|connect|meet|set)|sounds (good|great|interesting)|tell me more|more (info|information|details)|send (me )?(more|details|info)|book(ed|ing)?|schedul\w*|set up a (call|time|demo|meeting)|what times|when are you (free|available)|i'?m (free|available)|call me|give me a call|demo|happy to (chat|talk|look|hop)|would love to|how much|pricing|cost|price)\b/i;

// classifyRule(text) -> { tag, complaint }. The unsubscribe and complaint
// rules always stand, whatever a model says.
function classifyRule(text) {
  const t = ownWords(text) || String(text || '');
  const complaint = COMPLAINT.test(t);
  // A complaint is a "never again" too.
  if (complaint || UNSUB.test(t)) return { tag: 'unsubscribe', complaint };
  if (WRONG.test(t)) return { tag: 'wrong person', complaint };
  if (NOT_NOW.test(t)) return { tag: 'not now', complaint };
  if (INTERESTED.test(t)) return { tag: 'interested', complaint };
  // A reply that says none of those (a question, a "who is this?") is a
  // conversation JohnMark should see: interested, so he is told.
  return { tag: 'interested', complaint };
}
const TAGS = ['interested', 'not now', 'wrong person', 'unsubscribe'];
async function classify(text, p, deps = {}) {
  const rule = classifyRule(text);
  let tag = rule.tag;
  if (rule.tag !== 'unsubscribe' && !rule.complaint) {
    try {
      let j = null;
      if (typeof deps.classify === 'function') j = await deps.classify(text, p);
      else if (deps.classify !== false && !deps.offline) {
        const ai = require('../ai');
        const raw = await require('../scanMeter').label({ site: 'sales.replies', agentId: 'nildash-sales', brand: p.email },
          () => ai.oneShot(`A prospect answered a sales email from NILDash. Tag their reply as exactly one of: interested, not now, wrong person, unsubscribe.
"interested" includes any question about the product or a request to talk. "not now" includes a polite no. "wrong person" means they point elsewhere or have left.
Their reply: ${JSON.stringify(ownWords(text).slice(0, 2000))}
Return ONLY JSON: {"tag":"..."}`, 'You classify email replies. You return strict JSON.', 60, ai.MODEL_FAST));
        j = require('./salesFind').firstJson(raw);
      }
      if (j && TAGS.includes(lc(j.tag))) tag = lc(j.tag);
    } catch (_) { /* the rule's tag stands */ }
  }
  return { tag, complaint: rule.complaint };
}

// A suggested answer for an interested reply: short, his voice, the booking
// link. A suggestion only; nothing is sent to the prospect.
function bookingUrl() { return String(process.env.SALES_BOOKING_URL || '').trim() || require('./salesAutopilot').link(); }
function suggestTemplate(p, text) {
  const first = String(p.person || '').trim().split(/\s+/)[0] || 'there';
  const asksPrice = /\b(price|pricing|cost|how much)\b/i.test(text || '');
  return [`Thanks, ${first}.`, '',
    asksPrice ? 'Happy to walk through pricing on a short call, and you can see it working on your own roster.' : 'Happy to show you. It takes 15 minutes and you see it working on your own roster.',
    `Here is my calendar: ${bookingUrl()}`, 'Or send me two times that suit you and I will send the invite.', '',
    require('./salesAutopilot').senderName().split(/\s+/)[0]].join('\n');
}
async function suggest(p, text, deps = {}) {
  if (typeof deps.suggest === 'function') return deps.suggest(p, text);
  return suggestTemplate(p, text);
}

// ── THE SCAN ───────────────────────────────────────────────────────────────
let _scanning = false;
async function scan(pool, { now, deps = {} } = {}) {
  const SA = require('./salesAutopilot');
  if (_scanning) return { skipped: 'a scan is already going' };
  _scanning = true;
  const out = { read: 0, replies: 0, interested: 0, autoReplies: 0, bounces: 0, booked: 0, moved: 0, notMoved: 0, warnings: [] };
  try {
    await SA.ensureTables(pool);
    await SA.syncStops(pool);
    const mb = deps.mailbox || await MB.account(pool);
    if (!mb.ok) { out.warnings.push(mb.why); return out; }
    if (!mb.canRead) { out.warnings.push(`${mb.address} was connected without permission to read mail; reconnect it at /admin/sales/connect-mailbox`); return out; }
    const gdeps = deps.graph ? { graph: deps.graph } : {};
    const at = now ? new Date(now) : new Date();
    const st = await SA.getState(pool);
    const since = st.inbox_checked_at ? new Date(new Date(st.inbox_checked_at).getTime() - 10 * 60000) : new Date(at.getTime() - 3 * 86400000);
    const msgs = await MB.inboxSince(mb, since, gdeps);
    out.read = msgs.length;
    const prospects = (await pool.query(`SELECT * FROM sales_prospects WHERE first_sent_at IS NOT NULL`)).rows;
    const byEmail = new Map(prospects.map((p) => [p.email, p]));
    const byConv = new Map(prospects.filter((p) => p.conversation_id).map((p) => [p.conversation_id, p]));
    let folderId = st.folder_id || null;
    const moveIt = async (m) => {
      if (!mb.canMove) { out.notMoved++; return; }
      try {
        if (!folderId) {
          folderId = await MB.ensureFolder(mb, gdeps);
          await pool.query(`UPDATE sales_state SET folder_id = $1 WHERE id = 1`, [folderId]);
        }
        await MB.move(mb, m.id, folderId, gdeps);
        out.moved++;
      } catch (e) { out.notMoved++; out.warnings.push('could not move a message: ' + String(e.message).slice(0, 120)); }
    };
    let newest = st.inbox_checked_at ? new Date(st.inbox_checked_at) : since;
    for (const m of msgs) {
      const rcv = new Date(m.receivedDateTime || at);
      if (rcv > newest) newest = rcv;
      const from = MB.fromOf(m);
      if (!from || from === mb.address) continue;
      const text = MB.textOf(m);
      // Microsoft warning the mailbox: stop now.
      if (isMicrosoftWarning(m, text)) {
        if (await SA.event(pool, { kind: 'send_limit', messageId: m.id, detail: { subject: m.subject } })) {
          await SA.pause(pool, `Microsoft warned the mailbox: "${String(m.subject || '').slice(0, 120)}"`, deps);
        }
        continue;
      }
      // A bounce: whose address, and was it about our sending?
      if (isBounce(m)) {
        const hay = lc(`${text}\n${m.subject || ''}`);
        const p = prospects.find((x) => hay.includes(x.email));
        if (NDR_LIMIT.test(`${m.subject || ''}\n${text}`)) {
          if (await SA.event(pool, { prospectId: p ? p.id : null, kind: 'send_limit', messageId: m.id, detail: { subject: m.subject } })) {
            await SA.pause(pool, `Microsoft refused a send for a sending limit: "${(text.match(NDR_LIMIT) || [''])[0]}"`, deps);
          }
          if (p) await moveIt(m);
          continue;
        }
        if (!p) continue;
        if (await SA.event(pool, { prospectId: p.id, kind: 'bounce', messageId: m.id, detail: { subject: m.subject } })) {
          out.bounces++;
          await require('./suppression').suppress(pool, p.email, { reason: 'sales autopilot: the address bounced', kind: 'bounce' });
          await SA.stopProspect(pool, p.id, 'bounced', 'the address bounced');
        }
        await moveIt(m);
        continue;
      }
      const p = byEmail.get(from) || (m.conversationId && byConv.get(m.conversationId)) || null;
      if (!p) continue;
      if (isAutoReply(m)) {
        if (await SA.event(pool, { prospectId: p.id, kind: 'auto_reply', messageId: m.id, detail: { subject: m.subject } })) out.autoReplies++;
        await moveIt(m);
        continue;
      }
      const c = await classify(text, p, deps);
      const fresh = await SA.event(pool, { prospectId: p.id, kind: 'reply', tag: c.tag, messageId: m.id,
        detail: { subject: m.subject, from, words: ownWords(text).slice(0, 1000) } });
      if (fresh) {
        out.replies++;
        await SA.stopProspect(pool, p.id, c.tag === 'unsubscribe' ? 'unsubscribed' : 'replied', `they replied (${c.tag})`, { tag: c.tag, repliedAt: rcv });
        if (c.tag === 'unsubscribe') await require('./suppression').suppress(pool, p.email, { reason: 'sales autopilot: asked to be removed', kind: 'unsubscribe' });
        if (c.complaint) {
          await SA.event(pool, { prospectId: p.id, kind: 'complaint', messageId: m.id, detail: { words: ownWords(text).slice(0, 500) } });
          await require('./suppression').suppress(pool, p.email, { reason: 'sales autopilot: a spam complaint', kind: 'unsubscribe' });
          await SA.pause(pool, `a spam complaint from ${p.email}: "${ownWords(text).slice(0, 160)}"`, deps);
        }
        if (c.tag === 'interested') {
          out.interested++;
          await tellInterested(pool, p, m, text, deps).catch((e) => out.warnings.push('could not email the interested reply: ' + e.message));
        }
      }
      await moveIt(m);
    }
    // A demo booked: on his calendar, or a scheduler's notice in the inbox.
    out.booked += await bookings(pool, mb, msgs, at, gdeps);
    await pool.query(`UPDATE sales_state SET inbox_checked_at = $1, updated_at = NOW() WHERE id = 1`, [newest]);
    if (out.bounces) await SA.bounceCheck(pool, deps);
    return out;
  } finally {
    _scanning = false;
  }
}

const SCHEDULER = /(calendly\.com|acuityscheduling\.com|savvycal\.com|cal\.com|zcal\.co|youcanbook\.me|hubspot\.com|chilipiper\.com|bookings\.microsoft|outlook\.office365\.com\/owa\/calendar)/i;
async function bookings(pool, mb, msgs, at, gdeps) {
  const SA = require('./salesAutopilot');
  const open = (await pool.query(`SELECT id, email FROM sales_prospects WHERE status IN ('drafted', 'active')`)).rows;
  if (!open.length) return 0;
  const byEmail = new Map(open.map((p) => [p.email, p]));
  const hits = new Map();
  for (const m of msgs) {
    const blob = `${MB.fromOf(m)} ${m.subject || ''} ${MB.textOf(m)}`;
    if (!SCHEDULER.test(blob) && !/\b(new event|invitation|scheduled|booked)\b/i.test(String(m.subject || ''))) continue;
    for (const p of open) if (lc(blob).includes(p.email)) hits.set(p.id, { via: 'a booking notice in the inbox', subject: m.subject });
  }
  if (mb.canCalendar) {
    try {
      const evs = await MB.calendar(mb, new Date(at.getTime() - 86400000), new Date(at.getTime() + 45 * 86400000), gdeps);
      for (const ev of evs) {
        if (ev.isCancelled) continue;
        for (const a of (ev.attendees || [])) {
          const p = byEmail.get(lc(a.emailAddress && a.emailAddress.address));
          if (p) hits.set(p.id, { via: 'his calendar', subject: ev.subject, start: ev.start && ev.start.dateTime });
        }
      }
    } catch (_) { /* the calendar is optional */ }
  }
  let n = 0;
  for (const [id, d] of hits) {
    await SA.event(pool, { prospectId: id, kind: 'booked', detail: d });
    if (await SA.stopProspect(pool, id, 'booked', 'booked a demo (' + d.via + ')')) n++;
  }
  return n;
}

// ── "INTERESTED": TELL JOHNMARK NOW ─────────────────────────────────────────
async function tellInterested(pool, p, m, text, deps = {}) {
  const SA = require('./salesAutopilot');
  const sent = (await pool.query(`SELECT step, subject, body_text, sent_at FROM sales_emails WHERE prospect_id = $1 AND state = 'sent' ORDER BY step`, [p.id])).rows;
  const suggestion = await suggest(p, text, deps);
  const thread = sent.map((e) => [`--- ${e.step === 1 ? 'Your email' : `Your follow-up ${e.step - 1}`}, ${new Date(e.sent_at).toISOString().slice(0, 16).replace('T', ' ')} UTC ---`, e.body_text].join('\n'));
  const msg = {
    subject: `Interested: ${p.person}${p.org ? `, ${p.org}` : ''}`,
    text: [`${p.person}${p.title ? ` (${p.title})` : ''}${p.org ? ` at ${p.org}` : ''} replied and sounds interested. Nothing was sent to them; answer from your Outlook. The reply is in the NILDash Prospects folder.`, '',
      `Their email: ${p.email}`, '',
      '--- Their reply ---', ownWords(text) || text, '',
      ...thread, '',
      '--- A suggested answer (edit it, then send it yourself) ---', suggestion].join('\n'),
  };
  await (deps.alert || SA.alert)(msg);
  return msg;
}

module.exports = { scan, classify, classifyRule, ownWords, isBounce, isAutoReply, isMicrosoftWarning, tellInterested, suggestTemplate, bookings,
  NDR_LIMIT, COMPLAINT, UNSUB, TAGS };
