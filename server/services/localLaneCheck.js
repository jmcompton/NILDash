'use strict';
// ── AN ATHLETE THE LOCAL LANE CANNOT PLACE ──────────────────────────────────
//
// The local lane works in the town the athlete lives in: their school's town,
// or for a pro the city they play in (services/athleteRecord). When that
// cannot be worked out, the night still runs social and national, but the
// local lane is silent -- and that silence used to be invisible to the agent.
// This names the problem, says what fixes it, and Home shows it.
//
//   problemFor(athleteRow, { noMarketLastNight }) -> null | { code, text, fix? }
//     no-school       a college athlete with nothing in the school field
//     team-in-school  the school field holds a pro team ("New York Mets"):
//                     the athlete is a pro; fix = { athleteType: 'pro', team, city }
//     pro-no-city     a pro with no city (and no team that names one)
//     unresolved      a school we could not find on the map (last night's run
//                     had no market for them)
//   applyFix(pool, agentId, athleteId) -> the one-click fix for team-in-school
//     and a pro whose team names the city. Nothing else is guessed: a missing
//     school is the agent's to type.
const PT = require('./proTeams');

const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const str = (v) => (typeof v === 'string' ? v.trim() : '');

// A FULL team name only. A nickname that a school could carry is not enough to
// call someone a pro.
function teamNamedIn(text) {
  const t = PT.findTeam(text);
  return t && fold(text).includes(fold(t.name)) ? t : null;
}

function problemFor(row, opts = {}) {
  const d = (row && row.data) || row || {};
  const name = str(d.name) || 'This athlete';
  const isPro = str(d.athleteType) === 'pro' || str(row && row.athlete_type) === 'pro';
  if (isPro) {
    if (str(d.city)) return null;
    const t = str(d.team) ? teamNamedIn(d.team) : null;
    if (t) return { code: 'pro-no-city', text: `${name} plays for the ${t.name} but has no city on file, so no local businesses can be found.`,
      fix: { athleteType: 'pro', team: t.name, city: `${t.city}, ${t.state}` }, fixLabel: `Set city to ${t.city}, ${t.state}` };
    return { code: 'pro-no-city', text: `${name} is a pro with no city on file, so no local businesses can be found. Add the city they play in.` };
  }
  const school = str(d.school);
  if (!school) return { code: 'no-school', text: `${name} has no school on file, so no local businesses can be found. Add their school (or mark them a pro with a city).` };
  const t = teamNamedIn(school);
  if (t) return { code: 'team-in-school', text: `${name} has "${school}" as their school. That is a pro team, so the local lane has no school to work from.`,
    fix: { athleteType: 'pro', team: t.name, city: `${t.city}, ${t.state}` }, fixLabel: `Make pro: ${t.name}, ${t.city}, ${t.state}` };
  // MORE THAN ONE REAL SCHOOL BY THIS NAME: the agent picks; nothing is built
  // until they do.
  const amb = require('./schoolResolver').ambiguity(school, { state: d.state });
  if (amb && amb.candidates) {
    return { code: 'ambiguous-school', text: `Which school is this? "${school}" could be ${amb.candidates.length} schools, so ${name} gets no cards until you pick.`,
      choices: amb.candidates.map((c) => ({ school: c.name, label: `${c.name} (${c.city}, ${c.state})` })) };
  }
  if (opts.noMarketLastNight) return { code: 'unresolved', text: `We could not find where "${school}" is, so ${name} got no local businesses last night. Check the school name.` };
  return null;
}

// The agent's roster with what is wrong, worst first. noMarket comes from the
// last finished night's details (the run is what actually tried the school).
async function forAgent(pool, agentId) {
  const aths = (await pool.query(`SELECT id, data FROM athletes WHERE agent_id = $1 ORDER BY created_at ASC`, [agentId])).rows;
  const last = (await pool.query(
    `SELECT details FROM outreach_queue_runs WHERE agent_id = $1 AND finished_at IS NOT NULL
        AND jsonb_typeof(details) = 'array' AND jsonb_array_length(details) > 0
      ORDER BY run_date DESC LIMIT 1`, [agentId]).catch(() => ({ rows: [] }))).rows[0];
  const noMarket = new Set(((last && last.details) || []).filter((x) => x && x.noMarket).map((x) => x.athleteId));
  const out = [];
  for (const a of aths) {
    const p = problemFor(a, { noMarketLastNight: noMarket.has(a.id) });
    if (p) out.push({ athleteId: a.id, name: (a.data && a.data.name) || '', ...p });
  }
  return out;
}

async function applyFix(pool, agentId, athleteId, opts = {}) {
  const a = (await pool.query(`SELECT id, data FROM athletes WHERE id = $1 AND agent_id = $2`, [athleteId, agentId])).rows[0];
  if (!a) return { ok: false, status: 404, error: 'Athlete not found' };
  const p = problemFor(a);
  // The agent's pick, and only one of the schools offered.
  if (p && p.code === 'ambiguous-school') {
    const pick = (p.choices || []).find((c) => c.school === opts.choice);
    if (!pick) return { ok: false, status: 400, error: 'Pick one of the schools listed.' };
    await pool.query(`UPDATE athletes SET data = data || $3::jsonb, updated_at = NOW() WHERE id = $1 AND agent_id = $2`,
      [athleteId, agentId, JSON.stringify({ school: pick.school })]);
    return { ok: true, applied: { school: pick.school }, was: p.code };
  }
  if (!p || !p.fix) return { ok: false, status: 409, error: 'Nothing to fix automatically for this athlete; edit their profile.' };
  const patch = { ...p.fix };
  if (p.code === 'team-in-school') patch.school = null;
  await pool.query(`UPDATE athletes SET data = data || $3::jsonb, updated_at = NOW() WHERE id = $1 AND agent_id = $2`,
    [athleteId, agentId, JSON.stringify(patch)]);
  return { ok: true, applied: patch, was: p.code };
}

module.exports = { problemFor, forAgent, applyFix, teamNamedIn };
