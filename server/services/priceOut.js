'use strict';
// ── NO PRICE IN AN EMAIL THAT GOES TO A BUSINESS ────────────────────────────
//
// For a few weeks (OFFER_ON) the first pitch named a starting figure: "and
// we'd start the conversation at $250". The founder's rule (Nov 25, 2026): the
// pitch is the FIRST OUTREACH and nothing more. It opens the conversation; it
// never names a number. Some agencies' athletes would not take a $250 deal at
// all, and a figure in a cold email sets the ceiling before the agent has said
// a word. Price is the agent's to handle, after the business replies.
//
// The suggested offer still exists on the card, for the agent's eyes
// (services/offerSuggest). It is the EMAIL that never carries it:
//
//   offerSuggest.forPitch()   what a writer may be told: nothing, unless
//                             OFFER_IN_PITCH=1 turns the old behavior back on.
//   strip(body)               takes a price out of a body that already has one.
//                             Hundreds of pitches written under the old rule
//                             are still waiting to be approved.
//   backfill(pool)            runs strip over every unsent draft and card, once
//                             at startup. Safe to run again: a clean body is
//                             not touched.
//   The send itself runs strip one last time (jobs/closerRelease,
//   routes/outreach), so a body that reached the send with a figure in it
//   still leaves without one.
//
// HOW A PRICE IS TAKEN OUT. The writer put the figure in one of two shapes:
//   a clause on the end of a sentence   "..., and we'd start the conversation at $250."
//   a sentence of its own               "We'd open at $500 in product."
// The clause is cut and the sentence keeps its full stop; a sentence that is
// about the figure is dropped whole. Nothing is rewritten and nothing is added.

const PW = () => require('./pitchWriter');
const IN_PITCH = () => process.env.OFFER_IN_PITCH === '1';

const MONEY = /\$\s?\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s+(?:in|of|worth of)\s+(?:product|gear|merchandise|store credit|credit))?/;
// ", and we'd start the conversation at $250" up to (not including) the full stop.
const CLAUSE = new RegExp(
  '(?:,|;|\\s+[-–—])?\\s*(?:and|so|with|where)?\\s*(?:we|i)(?:[\'’]d|[\'’]ll| would| could| can| will)?\\s+(?:like to\\s+|love to\\s+|be glad to\\s+|want to\\s+)?'
  + '(?:start|open|begin|kick off|kick things off|put)\\b[^.!?<]*?' + MONEY.source + '[^.!?<]*', 'i');
// ", starting at $250" / " at a starting point of $250" / ", for $250"
const TAIL = new RegExp('(?:,|;)?\\s*(?:starting|beginning|priced|valued)?\\s*(?:at|from|around|for|of)\\s+(?:a\\s+)?(?:starting (?:point|offer|figure|rate) of\\s+|about\\s+|roughly\\s+)?' + MONEY.source + '(?=\\s*[.!?<]|\\s*$)', 'i');

function tidy(s) {
  return s.replace(/[ \t]+([.,!?;])/g, '$1').replace(/,\s*([.!?])/g, '$1')
    // A sentence that was only the offer leaves its full stop behind the one
    // before it: one stop, not two. An ellipsis is left alone.
    .replace(/(?<![.])([.!?])[ \t]*\.(?![.])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
}

// One run of text (no tags in it).
function stripText(t) {
  if (!MONEY.test(t)) return t;
  let out = t;
  for (let i = 0; i < 4 && CLAUSE.test(out); i++) out = out.replace(CLAUSE, '');
  for (let i = 0; i < 4 && TAIL.test(out); i++) out = out.replace(TAIL, '');
  if (MONEY.test(out)) {
    // Still there: the sentence is about the figure. Drop the sentence.
    const parts = out.match(/[^.!?]*(?:[.!?]+(?=\s|$)|$)/g) || [out];
    out = parts.filter((p) => !MONEY.test(p)).join('');
  }
  return tidy(out);
}

// -> { body, changed, left }   left: a price still in it (null when clean)
function strip(body) {
  const src = String(body == null ? '' : body);
  if (!MONEY.test(src)) return { body: src, changed: false, left: null };
  // Text between tags only: an href or a style never holds the offer.
  let out = src.split(/(<[^>]+>)/).map((tok) => (tok.startsWith('<') && tok.endsWith('>') ? tok : stripText(tok))).join('');
  out = out.replace(/<p>\s*<\/p>/gi, '').replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  let left = null;
  try { left = PW().containsPrice(out.replace(/<[^>]+>/g, ' ')); } catch (_) { left = MONEY.test(out) ? (out.match(MONEY) || [null])[0] : null; }
  return { body: out, changed: out !== src, left };
}

// What goes on the wire. With the old behavior switched back on, untouched.
function forSend(body) {
  if (IN_PITCH()) return String(body == null ? '' : body);
  return strip(body).body;
}

// Every pitch written under the old rule and not yet sent. -> { logs, cards, left }
async function backfill(pool) {
  if (IN_PITCH()) return { skipped: 'OFFER_IN_PITCH is on' };
  const out = { logs: 0, cards: 0, left: 0 };
  const run = async (table, col, where) => {
    let rows = [];
    try { rows = (await pool.query(`SELECT id, ${col} AS body FROM ${table} WHERE ${where} AND ${col} ~ '\\$\\s?[0-9]'`)).rows; }
    catch (e) { if (e && (e.code === '42P01' || e.code === '42703')) return 0; throw e; }
    let n = 0;
    for (const r of rows) {
      const s = strip(r.body);
      if (s.left) out.left++;
      if (!s.changed) continue;
      await pool.query(`UPDATE ${table} SET ${col} = $2, updated_at = NOW() WHERE id = $1`, [r.id, s.body]);
      n++;
    }
    return n;
  };
  out.logs = await run('outreach_logs', 'body_html', `sent_at IS NULL AND COALESCE(status,'draft') NOT IN ('sent','replied','expired','bounced','failed')`);
  out.cards = await run('outreach_queue', 'dm_text', `sent_at IS NULL AND COALESCE(state,'queued') = 'queued'`);
  return out;
}

module.exports = { strip, forSend, backfill, IN_PITCH, _stripText: stripText };
