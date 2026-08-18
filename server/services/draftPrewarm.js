'use strict';
// Pre-warm the AI Outreach draft, so the message is already written when the agent
// opens a card.
//
// WHY THIS EXISTS. The draft was generated on CLICK, behind the full seven-step
// workflow, and the wait is where agents stopped: the most active one ran nine scans
// and sent zero outreach. The draft itself was never the slow part. It is one Sonnet
// call. What made it slow was everything the click had to finish FIRST: company
// enrichment (Sonnet + 3 web searches) and contact discovery (Sonnet + 4 web
// searches), serialised, before pitch generation could start.
//
// So this does not make that pipeline faster. It skips it. The Deal Scan card
// already carries the fit reasoning the email needs, rationale, evidence, matched
// tags, category, the recommended structure and why, because that is what the scan
// produced to justify showing the card at all. Writing from the card is ONE Sonnet
// call with no web search, which is what makes drafting all ten affordable rather
// than only the top few.
//
// WHAT THIS DELIBERATELY DOES NOT DO
//   - No CRM deal. The click path creates one (step 7). Pre-warming ten cards must
//     not silently create ten pipeline deals out of a scan the agent only looked at.
//   - No enrichment, no contact discovery, no deck. Those stay on the click path.
//   - No contact name. At scan time the card usually has a business phone and no
//     named person, because the deep contact ladder only runs when a card is
//     expanded. The draft is written contact-agnostic and the click path
//     personalises the greeting if a name has been found by then. Pre-warming the
//     ladder as well would cost roughly an order of magnitude more for "Hi Dana".
//
// The pre-warmed draft is a REAL outreach_logs draft, the same row the modal reads
// and the same row PATCH /logs/:id edits, so an agent's edit saves through the path
// that already existed.

const crypto = require('crypto');
const { pool } = require('../store');
const ai = require('../ai');

// Three at a time. This runs in the background off a scan the agent is already
// looking at, so there is no reason to hammer the same rate limiter the scan uses.
const CONCURRENCY = 3;
// One page of cards. The scan returns ten; this exists so a caller passing a larger
// array cannot turn one scan into an unbounded fan-out.
const MAX_CARDS = 12;
// Per-draft cap. A stalled model call must cost one card, not the batch.
const DRAFT_TIMEOUT_MS = 45000;

const SYSTEM = 'You write short, specific B2B outreach emails for a college athlete\'s agent. '
  + 'You write like a person who has actually looked at the business. '
  + 'You never use filler, never flatter, and never write a sentence that would be true of any other business. '
  + 'Output ONLY the JSON object asked for.';

// ── The rule the whole feature turns on ──────────────────────────────────────
// "Your business would be a great fit for this athlete" is what the old pitch
// produced and it is worthless: it could have been sent to any of the ten cards.
// The card already knows the actual reason. Say THAT.
//
// Phrases are stored WITHOUT a leading pronoun ("hope this email finds you", not
// "I hope this email finds you"), because a model writes both and a list with the
// pronoun only catches one of them. Matching is substring on a normalised copy, so
// "Hope this email finds you well." and "I hope this email finds you well" are the
// same phrase to this check.
const BANNED = [
  'would be a great fit', 'great fit', 'perfect fit', 'perfect partnership',
  'hope this email finds you', 'hope this finds you', 'hope you are doing well',
  "hope you're doing well", 'hope all is well', 'hope you are well',
  'wanted to reach out', 'reaching out to see', 'touch base', 'circle back',
  'synergy', 'win-win', 'exciting opportunity', 'unique opportunity',
  'passionate about', 'thrilled', 'leverage', 'game-changer', 'game changer',
  'take your business to the next level', 'mutually beneficial',
];

// Curly apostrophes and doubled whitespace must not let a banned phrase through.
function _norm(v) {
  return String(v || '')
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function _s(v) { return v == null ? '' : String(v).trim(); }

// Everything the card knows that could make the email specific. Assembled here so
// the prompt reads from ONE place and a missing field degrades to an omitted line
// rather than the string "undefined".
function cardFacts(card) {
  const c = card || {};
  const lines = [];
  const push = (label, v) => { const s = _s(v); if (s) lines.push(`- ${label}: ${s}`); };
  push('Business', c.brand || c.brand_name);
  push('Category', c.category);
  push('Website', c.website);
  push('Where they are', c.region || c.market);
  // THE FIT REASONING. This is the field that decides whether the email is specific
  // or generic, so it is stated first among the reasoning and named plainly.
  push('WHY THIS BUSINESS WAS FLAGGED FOR THIS ATHLETE', c.rationale);
  push('Evidence behind that', c.evidence);
  push('What the athlete and this business have in common',
    Array.isArray(c.matchedTags) && c.matchedTags.length ? c.matchedTags.join(', ') : '');
  push('Campaign concept', c.campaign);
  push('Recommended deal structure', c.recommendedPitch);
  push('Why that structure', c.recommendedWhy);
  push('Fit score', c.fitScore ? `${c.fitScore}/100` : '');
  return lines.join('\n');
}

function athleteFacts(athlete) {
  const a = athlete || {};
  const lines = [];
  const push = (label, v) => { const s = _s(v); if (s) lines.push(`- ${label}: ${s}`); };
  push('Name', a.name);
  push('Sport', a.sport);
  push('Position', a.position);
  push('School', a.school);
  push('Instagram followers', a.instagram);
  push('TikTok followers', a.tiktok);
  push('Engagement rate', a.engagement ? `${a.engagement}%` : '');
  push('Notable', a.stats);
  push('Background', a.notes);
  return lines.join('\n');
}

function buildPrompt(athlete, card, agentName, retryBecause) {
  // On a retry, the FIRST thing the model reads is what it just got wrong. A bare
  // "try again" with an unchanged prompt mostly reproduces the same draft, which is
  // why the old behaviour of dropping the card outright was not obviously worse.
  const retryHead = retryBecause
    ? `YOUR PREVIOUS ATTEMPT WAS REJECTED: ${retryBecause}.\nFix exactly that and keep everything else. Do not restate the rejection.\n\n`
    : '';
  return retryHead + `Write ONE short outreach email from ${_s(agentName) || 'an agent'} to the owner or manager of this business, proposing an NIL partnership with this athlete.

THE ATHLETE
${athleteFacts(athlete)}

THE BUSINESS, AND WHY IT WAS PICKED FOR THIS ATHLETE
${cardFacts(card)}

STRUCTURE. Three or four sentences TOTAL. A gym owner reads on a phone between clients and does not read more than that.
  1. Who the athlete is, in one sentence. Concrete: sport, school, and the one fact that matters here.
  2. Why THIS business specifically. Use the reasoning above. Not that they are a good fit, but the actual overlap: for example "your members are the same people who follow her training content", not "your business would be a great fit".
  3. What is being proposed, in plain words. Deliverables, not jargon. Never a dollar amount, price or rate.
  4. One clear ask, and only one. A short question that can be answered yes or no.

GREETING: exactly "Hi," on its own line. Do NOT invent a name, a title, or "Hi there" - the recipient is not known yet.
SIGN-OFF: none. Do not write a closing, a name, or a signature. The platform adds those.

BANNED. If the email contains any of these, rewrite it:
${BANNED.map((b) => `  "${b}"`).join('\n')}

THE TEST THIS MUST PASS: if this email could have been written without knowing which business it is, it is wrong. Every sentence except the greeting must be one that would NOT make sense sent to a different business.

Do not invent facts. If you do not know something about the business, leave it out rather than guessing. Never claim the athlete has used, visited or bought from the business.

Return ONLY this JSON:
{"subject":"short, plain, no exclamation points, names the athlete and the business","body":"the email, greeting on the first line, three or four sentences, blank line between paragraphs"}`;
}

// Did the model do what it was told? Checked rather than trusted, because the whole
// value of the feature is that the email is specific. A draft that failed this is
// dropped, not stored: the modal then falls back to generating on click, which is
// the same thing it does when pre-warming never ran.
function checkDraft(text, card) {
  const body = _s(text);
  if (!body) return { ok: false, why: 'empty body' };
  const lower = _norm(body);
  const hit = BANNED.find((b) => lower.includes(_norm(b)));
  if (hit) return { ok: false, why: `contains banned filler "${hit}"` };
  // It must at least name the business. A draft that never says who it is written
  // to cannot be the specific email this exists to produce.
  const brand = _s(card && (card.brand || card.brand_name));
  if (brand && !lower.includes(brand.toLowerCase().split(/\s+/)[0])) {
    return { ok: false, why: 'never names the business' };
  }
  // Four sentences was the instruction. Ten means it ignored the shape.
  const sentences = body.replace(/^hi,?\s*/i, '').split(/[.!?]+\s/).filter((s) => s.trim().length > 12);
  if (sentences.length > 7) return { ok: false, why: `${sentences.length} sentences, asked for 3-4` };
  return { ok: true };
}

function parse(raw) {
  const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    const subject = _s(o.subject);
    const body = _s(o.body);
    if (!subject || !body) return null;
    return { subject, body };
  } catch (_) { return null; }
}

// Plain text to the same HTML shape the click path stores, so the modal's
// htmlToEditableText round trip behaves identically for both.
function toHtml(body) {
  const paras = String(body || '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
    .map((p) => p.trim().replace(/\n/g, ' ')).filter(Boolean);
  return paras.map((p) => `<div>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`)
    .join('<div><br></div>');
}

// ── One draft ────────────────────────────────────────────────────────────────
async function draftOne({ agentId, athleteId, athlete, card, agentName, lane }) {
  const brand = _s(card && (card.brand || card.brand_name));
  if (!brand) return { skipped: 'no brand' };
  const brandKey = card.brandKey || ai.resolveBrandKey(card, lane);
  if (!brandKey) return { skipped: 'no brand key' };

  // ALREADY DRAFTED. Same athlete, same business: do not redraft. Scoped to
  // status='draft' so a SENT outreach never blocks a fresh one for the same brand.
  const existing = await pool.query(
    `SELECT id FROM outreach_logs
     WHERE athlete_id = $1 AND brand_key = $2 AND status = 'draft' LIMIT 1`,
    [athleteId, brandKey]);
  if (existing.rows[0]) return { skipped: 'cached', id: existing.rows[0].id };

  // ONE RETRY, AND IT SAYS WHAT WENT WRONG.
  //
  // A draft that trips checkDraft used to be discarded and never revisited: that
  // card stayed a permanent miss until the next scan, so one "great fit" cost the
  // agent the whole two-minute click path for that business. The retry names the
  // exact phrase or rule that failed, because "try again" with the same prompt
  // mostly reproduces the same draft.
  //
  // Only ONE retry, and only for a draft that came back and failed the check. A
  // timeout or an unparseable response is not retried: those are not the model
  // choosing bad words, and doubling the wait is the thing this feature exists to
  // avoid.
  let parsed = null;
  let lastWhy = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await _attemptDraft({ athlete, card, agentName, brand, retryBecause: lastWhy });
    if (r.parsed) { parsed = r.parsed; break; }
    if (r.hard) return { failed: r.hard };        // timeout / unparseable: do not retry
    lastWhy = r.why;
    if (attempt === 0) {
      console.log(`[prewarm] retry brand="${brand}": ${r.why}`);
    }
  }
  if (!parsed) return { failed: lastWhy + ' (after retry)' };

  const id = 'out_' + crypto.randomBytes(8).toString('hex');
  try {
    await pool.query(
      `INSERT INTO outreach_logs
         (id, agent_id, athlete_id, brand_name, brand_key, subject, body_html, status, source, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'draft','prewarm',NOW(),NOW())
       ON CONFLICT DO NOTHING`,
      [id, agentId, athleteId, brand, brandKey, parsed.subject, toHtml(parsed.body)]);
  } catch (e) {
    return { failed: 'store: ' + e.message };
  }
  return { drafted: true, id, brandKey, retried: !!lastWhy };
}

// One model call plus the check. Returns { parsed } on success, { why } for a
// retryable content failure, or { hard } for one that retrying cannot fix.
async function _attemptDraft({ athlete, card, agentName, brand, retryBecause }) {
  const prompt = buildPrompt(athlete, card, agentName, retryBecause);
  let raw;
  try {
    // Sonnet, same as the click path's pitch generation. Explicitly named rather
    // than relying on oneShot's default, so a change to that default cannot
    // silently move this to another model.
    raw = await ai.withDeadline(
      ai.oneShot(prompt, SYSTEM, 900, 'claude-sonnet-4-6'),
      DRAFT_TIMEOUT_MS, `prewarm draft for ${brand}`);
  } catch (e) {
    return { hard: e.message };            // timed out: retrying doubles the wait
  }

  const parsed = parse(raw);
  if (!parsed) return { hard: 'unparseable response' };
  const check = checkDraft(parsed.body, card);
  if (!check.ok) return { why: check.why };  // the model chose bad words: worth one retry
  return { parsed };
}

// The order the cards get drafted in: the agent's own reading order. `rank` when
// the scan set one, then fitScore descending, then the array order it arrived in.
// Stable, so two cards with the same score keep their relative positions.
function orderForPrewarm(cards) {
  const list = (Array.isArray(cards) ? cards : []).filter(Boolean);
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ar = Number(a.c.rank), br = Number(b.c.rank);
      const aHas = Number.isFinite(ar), bHas = Number.isFinite(br);
      if (aHas && bHas && ar !== br) return ar - br;
      if (aHas !== bHas) return aHas ? -1 : 1;
      const af = Number(a.c.fitScore) || 0, bf = Number(b.c.fitScore) || 0;
      if (af !== bf) return bf - af;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

// ── The batch ────────────────────────────────────────────────────────────────
// Called AFTER the scan response has been sent. Never awaited by the request, and
// every failure is contained: this cannot fail a scan, because by the time it runs
// the scan is already on the agent's screen.
async function prewarmScan({ agentId, athleteId, athlete, cards, agentName, lane }) {
  // TOP CARDS FIRST, and in the order the agent sees them.
  //
  // The workers pull off one shared list, so whatever is at the front is drafted
  // first. That was already the scan's own order -- but the scan sorts by rank and
  // the agent reads top-down, so the cards most likely to be clicked in the first
  // few seconds are exactly the ones worth having ready first. Sorting explicitly
  // by rank/fitScore makes that a property of this function rather than an accident
  // of what the caller happened to pass.
  //
  // This does not make the batch faster. It makes the RACE winnable: an agent who
  // clicks the top card five seconds after the scan lands now finds a draft, where
  // before the answer depended on where that card sat in an unordered array.
  const list = orderForPrewarm(cards).slice(0, MAX_CARDS);
  if (!list.length) return { drafted: 0, cached: 0, failed: 0, skipped: 0 };
  const t0 = Date.now();

  const results = new Array(list.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      try {
        results[i] = await draftOne({ agentId, athleteId, athlete, card: list[i], agentName, lane });
      } catch (e) {
        results[i] = { failed: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, worker));

  const drafted = results.filter((r) => r && r.drafted).length;
  const retried = results.filter((r) => r && r.retried).length;
  const cached  = results.filter((r) => r && r.skipped === 'cached').length;
  const failed  = results.filter((r) => r && r.failed).length;
  const skipped = results.filter((r) => r && r.skipped && r.skipped !== 'cached').length;
  // One line per scan, with the failures named. A silent pre-warm that quietly
  // drafts nothing would look exactly like a fast one.
  console.log(`[prewarm] athlete=${athleteId} lane=${lane || '?'} cards=${list.length} `
    + `drafted=${drafted} cached=${cached} failed=${failed} skipped=${skipped} retried=${retried} ms=${Date.now() - t0}`);
  for (const r of results) if (r && r.failed) console.warn(`[prewarm]   failed: ${r.failed}`);
  return { drafted, cached, failed, skipped, retried };
}

module.exports = {
  prewarmScan, draftOne, buildPrompt, checkDraft, parse, toHtml, cardFacts, athleteFacts, orderForPrewarm,
  BANNED, CONCURRENCY, MAX_CARDS, DRAFT_TIMEOUT_MS,
};
