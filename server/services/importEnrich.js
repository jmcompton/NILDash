'use strict';
// ── FILL THE BLANK COLUMNS FROM THE LOOKUP, AFTER AN IMPORT ─────────────────
//
// A roster sheet usually has a name, a sport and a school and not much else.
// After the rows are saved, each athlete goes through the same lookup the
// Add Client button and the assistant use (services/athleteLookup, cached,
// so a pro the preview already looked up costs nothing here). Only blank
// fields are filled, only from the best candidate when the name and the
// school agree, and every filled field keeps its source URL on the record
// (data.lookupSources). The sheet's own values are never overwritten.

const store = require('../store');

const MAX = parseInt(process.env.IMPORT_ENRICH_MAX, 10) || 50;
const FIELDS = ['position', 'year', 'hometown', 'instagramHandle', 'tiktokHandle', 'instagram', 'tiktok', 'jerseyNumber', 'height', 'weight', 'stats'];
// The lookup's name for a record field, where they differ.
const SRC_KEY = { jerseyNumber: 'jersey', stats: 'highlight' };

// What a record would take from a candidate: the blank fields with a source.
function patchFor(a, best, AL) {
  if (!best) return null;
  if (AL.nameMatchScore(a.name, best.name) < 25) return null;
  if (a.athleteType !== 'pro' && a.school && best.school && !AL.schoolsMatch(best.school, a.school)) return null;
  const from = { position: best.position, year: a.athleteType === 'pro' ? null : best.year, hometown: best.hometown,
    instagramHandle: best.instagramHandle, tiktokHandle: best.tiktokHandle, instagram: best.instagram, tiktok: best.tiktok,
    jerseyNumber: best.jersey, height: best.height, weight: best.weight, stats: best.highlight };
  const patch = {}, src = {};
  for (const f of FIELDS) {
    const cur = a[f];
    const blank = cur === undefined || cur === null || cur === '' || cur === 0;
    const v = from[f];
    if (!blank || v === null || v === undefined || v === '' || v === 0) continue;
    const s = best.sources && best.sources[SRC_KEY[f] || f];
    if (!s) continue;   // a field with no source is not filled
    patch[f] = v; src[f] = s;
  }
  if (!Object.keys(patch).length) return null;
  if ((patch.instagram || patch.tiktok) && !a.igStatsSource) {
    patch.igStatsSource = 'web_estimate'; patch.igStatsFetchedAt = new Date().toISOString();
    patch.reachSource = 'lookup'; patch.reachAsOf = best.followersAsOf || new Date().toISOString().slice(0, 10);
  }
  patch.lookupSources = Object.assign({}, a.lookupSources || {}, src);
  patch.lookupAt = new Date().toISOString();
  return patch;
}

// enrichImportedAthletes(agentId, created: [{ id }]) -> { lookedUp, filled, touched, cost }
async function enrichImportedAthletes(agentId, created, opts = {}) {
  const AL = opts.lookup || require('./athleteLookup');
  const rows = [];
  for (const c of (created || []).slice(0, opts.max || MAX)) {
    const a = await store.getAthlete(c.id).catch(() => null);
    if (a && a.agentId === agentId) rows.push(a);
  }
  const queries = rows.map((a) => ({ name: a.name, school: a.school || '', sport: a.sport || '', athleteType: a.athleteType === 'pro' ? 'pro' : 'college', team: a.team || '', city: a.city || '' }));
  const results = await AL.resolveMany(null, queries, { agentId });
  let filled = 0, touched = 0, cost = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i], r = results[i];
    cost += (r && r.costUsd) || 0;
    const best = r && r.found && r.candidates && r.candidates[0];
    const patch = patchFor(a, best, AL);
    if (!patch) continue;
    filled += Object.keys(patch).filter((k) => FIELDS.includes(k)).length;
    const { id, agentId: owner, ...data } = a;
    await store.saveAthlete(id, Object.assign({ agentId: owner }, data, patch)).catch((e) => console.error(`[import/enrich] ${a.name}: ${e.message}`));
    touched++;
  }
  console.log(`[import/enrich] agent=${agentId} looked up ${rows.length}, filled ${filled} field(s) on ${touched} athlete(s), $${cost.toFixed(4)}`);
  return { lookedUp: rows.length, filled, touched, cost };
}

module.exports = { enrichImportedAthletes, patchFor, FIELDS, MAX };
