'use strict';
// HOME IS ONE JOB: APPROVE TODAY'S OUTREACH.
//
// Athlete tabs, that athlete's cards, one approve. A card is three lines --
// the business, the person, and one sentence on why this pairing. Everything
// else that used to live on Home moved or went: the shift-report headline,
// coverage counts, the ready-to-send list, the weekly floor, the admin
// dropdown, the fill button. The rule they went by: if an agent who has never
// seen the codebase cannot understand it in three seconds, it does not belong.
//
// ── THE WHY SENTENCE IS DERIVED, NEVER GENERATED ────────────────────────────
//
// There is no model call anywhere in this file, and that is a decision rather
// than an optimisation. Two reasons:
//
//   PAYING TWICE. The reasoning already exists. brand_match_scores.reasoning is
//   why the Scout paired this brand with this athlete; outreach_queue.why is why
//   the card was built; the pitch body is that reasoning already written out for
//   a human. Asking a model to summarise them buys nothing we do not hold.
//
//   DRIFT. A generated summary is a second, independent statement about the
//   pairing. It can disagree with the pitch it sits above -- and the agent
//   approves on the strength of the summary while the business receives the
//   pitch. A derived sentence cannot drift from its source because it IS its
//   source, trimmed.
//
// PREFERENCE ORDER, richest first:
//   1. the pitch's opening line   -- what the business will actually read
//   2. the stored match reasoning -- why the pairing was made
//   3. the card's own `why`       -- why the card was built
// Two and three are combined when neither is substantial alone. Nothing is
// invented: a card with no usable source shows two lines, not a filled-in one.

const MIN_USEFUL = 40;       // shorter than this says nothing an agent can act on
const MAX_LEN = 220;         // longer than this is not a three-second read

// Openers that are throat-clearing rather than a reason. If the first sentence
// is one of these the next one is taken instead.
const FILLER_RE = /^(hi|hey|hello|dear|good (morning|afternoon|evening))\b|^i hope\b|^hope (you|this)\b|^my name is\b|^i'?m reaching out\b|^just reaching out\b|^i wanted to reach\b/i;

function stripHtml(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// Split on sentence ends, but not on the dot in "Liquid I.V." or "Mr. Horn".
function sentences(text) {
  return String(text || '')
    .split(/(?<![A-Z])(?<!\b[A-Z][a-z])(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tidy(s) {
  let out = String(s || '').replace(/\s+/g, ' ').trim();
  if (!out) return null;
  if (out.length > MAX_LEN) {
    // Cut at the last sentence end inside the limit, else the last word. Never
    // mid-word, and never with an ellipsis pretending there is more to read.
    const slice = out.slice(0, MAX_LEN);
    const stop = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
    out = stop > MIN_USEFUL ? slice.slice(0, stop + 1) : slice.slice(0, slice.lastIndexOf(' ')) + '…';
  }
  if (!/[.!?…]$/.test(out)) out += '.';
  return out;
}

// The first sentence of the pitch that is actually about the business.
//
// LINES FIRST, THEN SENTENCES. A greeting ends in a COMMA, not a full stop, so
// splitting the pitch on sentence punctuation alone glues "Hi Chris," onto the
// first real sentence -- the whole thing then trips the filler test and a
// perfectly good pitch line falls through to the weaker stored `why`. stripHtml
// already turns each <p> into its own line, which is exactly the boundary a
// greeting sits on.
function fromPitch(bodyHtml) {
  const text = stripHtml(bodyHtml);
  if (!text) return null;
  const units = text.split('\n').flatMap((line) => sentences(line));
  for (const s of units.slice(0, 6)) {
    if (s.length < MIN_USEFUL) continue;
    if (FILLER_RE.test(s)) continue;
    return tidy(s);
  }
  return null;
}

// why + reasoning, whichever carries more. Combined only when neither stands up
// on its own, and only when they are not saying the same thing twice.
function fromStored(why, reasoning) {
  const a = tidy(why), b = tidy(reasoning);
  if (a && b) {
    const overlap = a.toLowerCase().slice(0, 30) === b.toLowerCase().slice(0, 30);
    if (overlap) return a.length >= b.length ? a : b;
    if (Math.max(a.length, b.length) >= MIN_USEFUL * 2) return a.length >= b.length ? a : b;
    return tidy(a.replace(/[.!?]$/, '') + '. ' + b);
  }
  return a || b || null;
}

// { text, from } -- `from` names the source so a bad sentence is traceable to
// the row that produced it rather than guessed at.
function deriveWhy(card) {
  const c = card || {};
  const pitch = fromPitch(c.body_html);
  if (pitch) return { text: pitch, from: 'pitch' };
  const stored = fromStored(c.why, c.reasoning);
  if (stored) return { text: stored, from: c.why && c.reasoning ? 'why+match' : (c.why ? 'why' : 'match') };
  return { text: null, from: null };
}

// ── The payload Home renders ────────────────────────────────────────────────
// One query per concern, no per-card work. Athletes carry their own count so the
// tabs need nothing else; cards are only built for the athlete being shown.
async function buildHome(pool, agentId, opts = {}) {
  const q = async (sql, params) => {
    try { return (await pool.query(sql, params)).rows; } catch (e) {
      console.error('[home] ' + e.message); return [];
    }
  };

  const athletes = await q(
    `SELECT a.id, a.data->>'name' AS name, a.data->>'school' AS school,
            a.data->>'dob' AS dob,
            COUNT(l.id) FILTER (
              WHERE l.status = 'draft' AND l.approved_at IS NULL
                AND l.cadence_stopped_at IS NULL)::int AS pending
       FROM athletes a
       LEFT JOIN outreach_logs l ON l.athlete_id = a.id AND l.agent_id = $1
      WHERE a.agent_id = $1
      GROUP BY a.id, a.data
      ORDER BY a.created_at ASC`, [agentId]);

  const selected = opts.athleteId
    || (athletes.find((a) => a.pending > 0) || athletes[0] || {}).id
    || null;

  let cards = [];
  if (selected) {
    cards = await q(
      `SELECT l.id, l.brand_name, l.body_html,
              q.contact_name, q.contact_title, q.why,
              m.reasoning
         FROM outreach_logs l
         LEFT JOIN LATERAL (
           SELECT contact_name, contact_title, why FROM outreach_queue q2
            WHERE q2.athlete_id = l.athlete_id
              AND LOWER(q2.brand_name) = LOWER(l.brand_name)
            ORDER BY q2.created_at DESC LIMIT 1
         ) q ON TRUE
         LEFT JOIN LATERAL (
           SELECT reasoning FROM brand_match_scores m2
            WHERE m2.agent_id = l.agent_id AND m2.athlete_id = l.athlete_id
              AND LOWER(m2.brand_name) = LOWER(l.brand_name)
            ORDER BY m2.created_at DESC LIMIT 1
         ) m ON TRUE
        WHERE l.agent_id = $1 AND l.athlete_id = $2
          AND l.status = 'draft' AND l.approved_at IS NULL
          AND l.cadence_stopped_at IS NULL
        ORDER BY l.created_at ASC`, [agentId, selected]);
  }

  const who = athletes.find((a) => a.id === selected) || null;

  // THE ONLY BLOCKING LINE ON THE PAGE, and only when it blocks. The compliance
  // gate needs a date of birth to decide anything, so without one nothing for
  // this athlete can be approved. Named as the thing to fix, not as a status.
  const blocked = !!(who && !who.dob);

  return {
    athletes: athletes.map((a) => ({ id: a.id, name: a.name, count: a.pending })),
    selected,
    athlete: who ? { id: who.id, name: who.name, school: who.school } : null,
    // Written without a pronoun. We do not hold one for an athlete, and a
    // blocking line on the one page an agent reads every morning is the last
    // place to guess at one.
    blocker: blocked
      ? { text: `${(who.name || 'This athlete').split(' ')[0]} has no date of birth on file, `
          + 'so nothing can be approved yet.', cta: 'Add it', href: '/?view=athletes' }
      : null,
    cards: cards.map((c) => {
      const w = deriveWhy(c);
      return {
        id: c.id,
        business: c.brand_name,
        contact: c.contact_name || null,
        role: c.contact_title || null,
        why: w.text,
        whyFrom: w.from,
      };
    }),
    canApprove: !blocked && cards.length > 0,
  };
}

module.exports = { buildHome, deriveWhy, fromPitch, fromStored, stripHtml, sentences, MAX_LEN };
