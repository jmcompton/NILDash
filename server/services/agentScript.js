'use strict';
// ── THE AGENT'S OWN SCRIPT ────────────────────────────────────────────────────
//
// Agents asked to pitch in their own words. An agent pastes the pitch they
// already use into Settings; "Improve it" hands back a cleaned-up version in
// their voice plus a few ideas; they keep theirs, take ours, or mix the two,
// and save. From then on the pitch writer is told to follow THEIR script
// (wording, order, the ask) for every business, changing only what has to
// change for that business and that athlete.
//
// What it does NOT change: every rule the writer enforces after the model
// runs (no price, no invented fact, the greeting, the sign-off, the
// placeholder backstop, the send gate) still applies. A script is a voice
// and a shape, never a way round a guard.
//
// The script belongs to one agent and is only ever read for that agent.

const MAX_LEN = 2000;
const MIN_LEN = 40;
const MODEL = 'claude-sonnet-4-6'; // the writer's model; never changed

let _ensured = false;
async function ensureColumns(pool) {
  if (_ensured) return;
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pitch_script TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pitch_script_on BOOLEAN NOT NULL DEFAULT TRUE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pitch_script_at TIMESTAMPTZ`);
  _ensured = true;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The quick read of a script the agent typed, shown before and after
// "Improve it", so they can see why a line would be changed. Plain words.
function check(script) {
  const s = clean(script);
  const out = [];
  if (!s) return out;
  const PW = require('./pitchWriter');
  if (PW.containsPrice(s)) out.push('It names a price. Pitches never do; the price comes up on the call.');
  if (/[—–]/.test(s)) out.push('It uses long dashes. They are swapped for commas when the pitch is written.');
  if (/!/.test(s)) out.push('It uses exclamation marks. They are swapped for periods.');
  const words = s.split(/\s+/).filter(Boolean).length;
  if (words > 160) out.push(`It is ${words} words. Owners read about 100; shorter gets more replies.`);
  if (!/\?/.test(s)) out.push('It does not ask a question. Ending on one easy question gets more replies.');
  return out;
}

async function get(pool, agentId) {
  await ensureColumns(pool);
  const r = await pool.query(`SELECT pitch_script, pitch_script_on, pitch_script_at FROM users WHERE id = $1`, [agentId]);
  const row = r.rows[0] || {};
  const script = row.pitch_script || '';
  return { script, on: row.pitch_script_on !== false, updatedAt: row.pitch_script_at || null, notes: check(script), maxLength: MAX_LEN };
}

async function save(pool, agentId, body) {
  await ensureColumns(pool);
  const b = body || {};
  const script = clean(b.script);
  if (script.length > MAX_LEN) return { ok: false, error: `Keep it under ${MAX_LEN} characters.` };
  if (script && script.length < MIN_LEN) return { ok: false, error: 'That is too short to pitch from. Paste the whole message you send.' };
  const on = b.on === undefined ? true : !!b.on;
  await pool.query(`UPDATE users SET pitch_script = $2, pitch_script_on = $3, pitch_script_at = NOW() WHERE id = $1`,
    [agentId, script || null, on]);
  _cache.delete(String(agentId));
  return { ok: true, ...(await get(pool, agentId)) };
}

// What the nightly writer reads: the script, or null when there is none or
// the agent switched it off. Cached for a few minutes because one run writes
// many cards for the same agent.
const _cache = new Map();
const TTL_MS = 5 * 60 * 1000;
async function forAgent(pool, agentId) {
  if (!agentId) return null;
  const k = String(agentId);
  const hit = _cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  let v = null;
  try {
    await ensureColumns(pool);
    const r = await pool.query(`SELECT pitch_script, pitch_script_on FROM users WHERE id = $1`, [agentId]);
    const row = r.rows[0];
    if (row && row.pitch_script_on !== false && clean(row.pitch_script).length >= MIN_LEN) v = clean(row.pitch_script);
  } catch (e) { console.error('[agent-script] read failed:', e.message); v = null; }
  _cache.set(k, { at: Date.now(), v });
  return v;
}

// ── IMPROVE IT ────────────────────────────────────────────────────────────────
const IMPROVE_SYSTEM = `You help a sports agent improve the pitch email they send to local business owners, proposing a partnership with an athlete they represent. You are an editor, not a ghostwriter: the result must still sound like this agent wrote it.`;

function improvePrompt(script, opts) {
  const o = opts || {};
  return `THE AGENT'S SCRIPT
"""
${script}
"""
${o.agentFirst ? `The agent's first name: ${o.agentFirst}\n` : ''}
Improve it. Keep their voice: their phrases, their warmth or bluntness, their sign-off style, and their ask unless the ask is weak. Change only what makes it stronger for a busy owner who gives it thirty seconds.

Rules for the improved version:
- Four to five short sentences, under 110 words, plus a greeting line first and the sign-off last.
- One clear reason this athlete fits this business, near the top.
- End on one easy question (a short call, or "would you be open to it").
- Never name a price, a fee, a rate or any dollar figure.
- No long dashes and no exclamation marks.
- Where a detail changes for each business or athlete, write a blank in square brackets: [Owner], [Business], [Athlete], [Sport], [Position], [School], [City], [Why it fits]. Keep the agent's own fixed details as they wrote them.

Then give up to three short ideas the agent could try, each one sentence, specific to THIS script (not generic advice).

Return ONLY JSON:
{
  "improved": "the improved script, with line breaks as \\n",
  "changes": ["what you changed and why, one short line each, at most four"],
  "ideas": ["idea one", "idea two", "idea three"]
}`;
}

function parse(raw) {
  try {
    const s = String(raw || '').replace(/```json/gi, '').replace(/```/g, '');
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    return JSON.parse(s.slice(a, b + 1));
  } catch (_) { return null; }
}

const tidy = (t) => clean(String(t || '').replace(/\s*[—–]\s*/g, ', ').replace(/!+/g, '.'));
const lines = (x, n) => (Array.isArray(x) ? x : []).map((v) => tidy(v)).filter(Boolean).slice(0, n);

// deps.oneShot stands in for tests. -> { ok, improved, changes, ideas, notes }
async function improve(script, opts = {}, deps = {}) {
  const s = clean(script);
  if (s.length < MIN_LEN) return { ok: false, error: 'Paste the whole message you send, then tap Improve.' };
  if (s.length > MAX_LEN) return { ok: false, error: `Keep it under ${MAX_LEN} characters.` };
  const oneShot = deps.oneShot || require('../ai').oneShot;
  let j = null;
  try { j = parse(await oneShot(improvePrompt(s, opts), IMPROVE_SYSTEM, 1200, MODEL, { prose: false })); } catch (e) {
    console.error('[agent-script] improve failed:', e.message);
    return { ok: false, error: 'Could not improve it just now. Try again in a minute.' };
  }
  if (!j || !String(j.improved || '').trim()) return { ok: false, error: 'Could not improve it just now. Try again in a minute.' };
  let improved = tidy(j.improved);
  // The one hard rule a script can break that the writer could not later
  // hide: a price. If the edit still names one, it is not offered.
  const PW = require('./pitchWriter');
  if (PW.containsPrice(improved)) return { ok: false, error: 'The improved version named a price, so it was not used. Take any price out of yours and try again.' };
  return { ok: true, original: s, improved, changes: lines(j.changes, 4), ideas: lines(j.ideas, 3), notes: check(s) };
}

// The block the pitch writer adds to its prompt when the agent has a script.
function promptBlock(script) {
  const s = clean(script);
  if (!s) return '';
  return `
THE AGENT'S OWN SCRIPT
The agent pitches in their own words. This is the message they wrote:
"""
${s.slice(0, MAX_LEN)}
"""
Write THIS message for this business and this athlete. Keep the agent's wording, phrases, order and ask as closely as you can, and change only what has to change for this business and this athlete. Words in square brackets are blanks: fill each from THE BUSINESS and THE ATHLETE above, and if you do not have the value, rewrite that part without it. Never leave a bracket, a blank or a placeholder in the message. Where the script conflicts with a rule in your instructions (a price, a fact not listed above, a long dash, an exclamation mark, the length, the greeting or the sign-off), the rule wins; keep everything else the agent's.
`;
}

module.exports = { ensureColumns, get, save, forAgent, improve, check, promptBlock, improvePrompt, clean, MAX_LEN, MIN_LEN, MODEL,
  _reset() { _cache.clear(); _ensured = false; } };
