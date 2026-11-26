'use strict';
// ── THE FOLLOW-UP, WRITTEN BY THE WRITER WHO KNOWS THE SITUATION ────────────
//
// Follow-ups were fill-in-the-blank lines. The writer now gets the whole
// picture: who the agent is, the athlete as we hold them, the business, who it
// is addressed to, every email already sent in the thread, and which touch
// this is. It writes one short email for that business and no other.
//
// The same model as the pitch writer (claude-sonnet-4-6). What it writes is
// held to the same rules as before (services/followUps.checkFollowUp) plus two
// of its own: every number in it is one we gave it, and it names no business
// but the one it is written to. Fail any of them twice and the fixed wording
// is used instead, so a follow-up is never missing and never wrong.
// And nothing it writes goes anywhere until the founder approves it
// (services/founderReview).
const MODEL = 'claude-sonnet-4-6';
const ON = () => process.env.FOLLOWUP_AI !== 'off';

const SYSTEM = `You write one short follow-up email for a sports agent to a local business about a college athlete they represent. The business did not answer the earlier email(s). You write as the agent, first person, plain and warm, the way a busy person writes to another busy person.

Hard rules:
- 40 to 75 words in the body. Short paragraphs. No bullet points, no bold, no emoji, no links.
- Never say or imply you are following up, checking in, circling back, bumping, or that they missed or did not answer an email. Do not mention the earlier email at all.
- Bring ONE thing the earlier emails did not say. Choose from what you are given: a concrete, countable idea that fits this kind of business, or a fact about the athlete from the record.
- Use only the facts given. Never invent a statistic, award, follower count, hometown, schedule, event, date, or a detail about the business. If the record is thin, keep it simple.
- No prices, rates, budgets or dollar figures. No discounts.
- Do not mention any other business, brand, team sponsor or person. Only this business, this athlete and the agent.
- Do not mention seasons, dates, months, weekdays or deadlines.
- No hype words (excited, thrilled, amazing, incredible, unlock, leverage, game-changing, opportunity of a lifetime). Do not start with "I hope".
- Never use a dash as punctuation. Use commas or full stops.
- End with one easy question, unless this is the last email.
- If this is the LAST email: say plainly it is the last note, offer a smaller way to start (one post and one visit), and end with exactly this sentence: "If this is not for {BUSINESS}, tell me and I will stop."

Return only JSON: {"body": "the email body, starting with the greeting and ending before the sign-off name"}. Do not include the agent's name or a signature; it is added for you.`;

function promptFor(m, touch, earlierTexts) {
  const a = m.athlete || {};
  const lines = [
    `This is email ${touch} of 3 to this business.${touch >= 3 ? ' It is the LAST email.' : ''}`,
    '',
    `BUSINESS: ${m.brand}`,
    `KIND OF BUSINESS: ${m.category || 'not known'}`,
    `ADDRESSED TO: ${m.contactFirst ? m.contactFirst + ' (start with "Hi ' + m.contactFirst + ',")' : 'no name known (start with "Hi,")'}`,
    '',
    `ATHLETE: ${a.name || 'the athlete'}`,
    `SPORT: ${a.sport || 'not on record'}`, `POSITION: ${a.position || 'not on record'}`, `SCHOOL: ${a.school || 'not on record'}`,
    `ON RECORD: ${a.stats || 'nothing'}`, `KNOWN FOR: ${a.knownFor || 'nothing'}`,
    '',
    `AN IDEA THAT FITS THIS KIND OF BUSINESS (use it, or a smaller version of it, if the earlier emails did not already): ${m.deliverable}`,
    '',
    'ALREADY SENT IN THIS THREAD (do not repeat any sentence or idea from these):',
  ];
  (earlierTexts || []).forEach((t, i) => { lines.push(`--- email ${i + 1} ---`, String(t || '').slice(0, 1800)); });
  if (!(earlierTexts || []).length) lines.push('(nothing on file)');
  return lines.join('\n').replace(/\{BUSINESS\}/g, m.brand);
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const numbersIn = (t) => (String(t || '').match(/\d[\d,.]*/g) || []).map((n) => n.replace(/[,.]$/, '')).filter(Boolean);

// What only this writer can get wrong.
function ownProblems(body, m, earlierTexts) {
  const out = [];
  const wc = (body.match(/\S+/g) || []).length;
  if (wc < 25) out.push('too short to say anything');
  if (wc > 110) out.push('too long');
  if (/https?:\/\/|www\./i.test(body)) out.push('has a link');
  if (/[—–]| - /.test(body)) out.push('uses a dash');
  if (/\$\s?\d|\b\d+\s?(dollars|bucks|usd)\b/i.test(body)) out.push('names a price');
  // Every number is one we gave it: the idea, the athlete record, or an earlier email.
  const given = new Set(numbersIn([m.deliverable, m.athlete && m.athlete.stats, m.athlete && m.athlete.knownFor, m.brand, ...(earlierTexts || [])].join(' ')));
  const made = numbersIn(body).filter((n) => !given.has(n) && !['1', '2', '3', '10'].includes(n));
  if (made.length) out.push('a number we did not give it: ' + made.join(', '));
  if (/\b(january|february|april|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(body)) out.push('names a date');
  return out;
}

// -> { html, text, material: ['ai'], model } or null (the caller falls back).
// deps: { oneShot } for tests; check(html) -> problems[] from followUps.
async function write(m, touch, earlierTexts, deps = {}) {
  if (!ON() && !deps.oneShot) return null;
  const oneShot = deps.oneShot || require('../ai').oneShot;
  const SIG = require('./signature');
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try { raw = await oneShot(promptFor(m, touch, earlierTexts) + feedback, SYSTEM.replace(/\{BUSINESS\}/g, m.brand), 500, MODEL, { prose: true }); }
    catch (e) { console.error('[followUpWriter] model call failed:', e.message); return null; }
    let body = null;
    try { const j = JSON.parse(String(raw || '').replace(/^[^{]*/, '').replace(/[^}]*$/, '')); body = String(j.body || '').trim(); } catch (_) { body = null; }
    if (!body) { feedback = '\n\nYour last answer was not the JSON asked for. Return only {"body": "..."}'; continue; }
    body = body.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    let text = [body, m.agentFirst || ''].filter(Boolean).join('\n\n');
    text = SIG.appendText(text, m.signature);
    const html = text.split(/\n\n/).map((p) => '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>').join('');
    const problems = ownProblems(body, m, earlierTexts).concat(deps.check ? deps.check(html) : []);
    if (!problems.length) return { html, text, material: ['ai'], model: MODEL };
    feedback = '\n\nYour last draft was refused: ' + problems.join('; ') + '. Write it again and fix exactly that.';
    if (attempt === 1) console.warn(`[followUpWriter] refused twice for ${m.brand}: ${problems.join('; ')}`);
  }
  return null;
}

module.exports = { write, promptFor, ownProblems, SYSTEM, MODEL, ON };
