'use strict';
// ── EVERY SCHOOL RESOLVES TO A TOWN, AND NOBODY SEES "WE COULD NOT MATCH" ───
//
// The resolver (services/schoolResolver) answers from lists: the shipped map,
// the curated list, every D1, D2, D3 and NAIA school. Lists end. Junior
// colleges, high schools and the next school we missed are still real places
// with a town, and an agent typing one should not be told the app cannot
// match it. So when the lists have nothing, this LOOKS IT UP, right away:
//
//   1. the lists, instantly (and the schools already found, see 4)
//   2. a shared name ("Bethel University") is offered with each town, never
//      guessed
//   3. Google Places, by name and state; the answer must be a school whose
//      name agrees with what was typed and whose address has a town
//   4. DeepSeek with a Serper search; the town is accepted ONLY when a search
//      result names the school, the city and the state, in its own words
//   5. nothing: one short question, "What city is it in?", and the agent's
//      answer is kept as the town
//
// EVERY CONFIRMED ANSWER IS SAVED (school_lookups) and learned into the
// resolver's map, so the next agent, the nightly run, compliance and the
// import all get it instantly and it never costs twice. Saved rows are
// status 'auto' until the admin page confirms or rejects them; a rejected row
// is unlearned everywhere at once.
//
// One entry point for the form, the chat and the spreadsheet import.
//
//   findSchool(name, { state, city, agentId })
//     -> { ok: true,  status: 'matched', name, city, state, market, source, message }
//     -> { ok: false, status: 'ambiguous', options: [{ name, city, state }], message }
//     -> { ok: false, status: 'unknown', ask, message }
//     -> { ok: false, status: 'empty' }

const R = require('./schoolResolver');

const NEGATIVE_TTL_MS = 10 * 60 * 1000;   // a miss is remembered ten minutes: typing must not re-spend
const FIND_BUDGET_MS = 9000;              // the whole lookup; Places first, the web with what is left
const WEB_MIN_MS = 3500;
const SOURCES = ['places', 'web', 'agent'];

// Words that name no school in particular. The resolver's GENERIC covers
// institution words; these are the direction and level words too.
const EXTRA_GENERIC = new Set(['high', 'school', 'hs', 'prep', 'academy', 'junior', 'senior', 'community', 'technical', 'career', 'campus',
  'north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'upper', 'lower', 'new', 'saint', 'st', 'mount', 'mt', 'the', 'of', 'at', 'and', 'for']);
// A state's name counts as distinctive here: "New Mexico Junior College" is
// a name, and Places has to echo it.
function words(s) { return R.normalize(s).split(/[^a-z0-9]+/).filter(Boolean); }
function distinctive(s) { return words(s).filter((w) => !R.GENERIC.has(w) && !EXTRA_GENERIC.has(w)); }
function nameKey(s) { return R.normalize(s); }
function stateName(code) { const c = String(code || '').toUpperCase(); for (const [k, v] of Object.entries(R.US_STATES)) if (v === c) return k.replace(/\b\w/g, (m) => m.toUpperCase()); return c; }

// Does the place Places returned carry the name that was typed? "Bentley
// University" must not be a car dealership, and "Western New Mexico
// University" must not be "Western University". Every distinctive word of the
// shorter name has to be in the longer one.
const DIRECTIONS = new Set(['north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'upper', 'lower', 'northeast', 'northwest', 'southeast', 'southwest']);
function namesAgree(typed, found) {
  const a = distinctive(typed), b = distinctive(found);
  if (!a.length || !b.length) return false;
  // A direction word is not distinctive on its own, but two different ones
  // are two different schools: Eastern New Mexico is not Western New Mexico.
  const da = words(typed).filter((w) => DIRECTIONS.has(w)), db = words(found).filter((w) => DIRECTIONS.has(w));
  if (da.length && db.length && !da.some((w) => db.includes(w))) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const set = new Set(long);
  return short.every((w) => set.has(w));
}

// "Silver City, NM" / "Silver City, New Mexico" / "Silver City NM" -> { city, state }
function parseCityState(text, stateHint) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  const codes = Object.values(R.US_STATES);
  const clean = (c) => c.trim().replace(/,$/, '').trim();
  // "City, ST" / "City ST": the last word is a code.
  let m = s.match(/^(.+?)[,\s]+([A-Za-z]{2})\.?$/);
  if (m && codes.includes(m[2].toUpperCase())) return { city: clean(m[1]), state: m[2].toUpperCase() };
  // "City, New Mexico" / "City New Mexico": the tail is a state's name.
  const low = s.toLowerCase();
  for (const [full, code] of Object.entries(R.US_STATES)) {
    if (low.endsWith(' ' + full) || low.endsWith(',' + full) || low.endsWith(', ' + full)) {
      const city = clean(s.slice(0, s.length - full.length));
      if (city) return { city, state: code };
    }
  }
  if (stateHint) { const st = R.stateCode(stateHint); if (st && codes.includes(st)) return { city: clean(s), state: st }; }
  return null;
}

// Does a search result name the school, the city and the state, itself?
function resultSupports(res, school, city, state) {
  const text = R.normalize(`${res.title || ''} ${res.snippet || ''}`);
  const toks = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));
  const need = distinctive(school);
  if (!need.length || !need.every((w) => toks.has(w))) return false;
  const c = R.normalize(city);
  if (!c || !(' ' + text + ' ').includes(' ' + c + ' ')) return false;
  const st = String(state || '').toUpperCase();
  const full = stateName(st).toLowerCase();
  return new RegExp('(^|[^a-z])' + st.toLowerCase() + '([^a-z]|$)').test(text) || (full.length > 2 && text.includes(full));
}

// ── The two lookups, injectable ─────────────────────────────────────────────
let _deps = null;
function deps() {
  if (_deps) return _deps;
  return {
    lookupPlaceResult: (q) => require('./placesLookup').lookupPlaceResult(q, ''),
    searchLoop: (o) => require('./webSearchTool').searchLoop(o),
    searchProvider: () => { const WST = require('./webSearchTool'); const s = WST.PROVIDERS && WST.PROVIDERS.serper; return (s && s.key && s.key()) ? s : WST.provider(); },
    webRouted: () => require('./deepseek').route('lookup', { needsSearch: true }).provider !== 'anthropic',
    store: require('../store'),
  };
}
function _setDepsForTests(d) { _deps = d ? Object.assign({ store: null, searchProvider: () => ({ name: 'test' }), webRouted: () => true }, d) : null; _negatives.clear(); _loaded = null; }

async function fromPlaces(name, stateHint) {
  const Geo = require('./schoolGeocode');
  const q = stateHint ? `${name}, ${stateName(stateHint)}` : name;
  let r = null;
  try { r = await deps().lookupPlaceResult(q); } catch (e) { return { miss: 'error:' + e.message }; }
  if (!r || !r.ok) return { miss: (r && r.reason) || 'unavailable' };
  const place = r.place;
  if (!place) return { miss: 'not-found' };
  if (!Geo.looksLikeSchool(place)) return { miss: 'not-a-school', placeName: place.name || null };
  if (!namesAgree(name, place.name || '')) return { miss: 'name-differs', placeName: place.name || null };
  const cs = Geo.cityStateFromAddress(place.address || place.formattedAddress);
  if (!cs) return { miss: 'no-town' };
  if (stateHint && cs.state !== stateHint) return { miss: 'wrong-state', placeName: place.name || null };
  return { city: cs.city, state: cs.state, evidence: { placeName: place.name || null, address: place.address || null, mapsUrl: place.mapsUrl || null, types: place.types || [] } };
}

async function fromWeb(name, stateHint, timeoutMs, ctx) {
  const d = deps();
  if (typeof d.webRouted === 'function' && !d.webRouted()) return { miss: 'web-not-routed' };
  const system = 'You find which city a school is in. You answer only from search results, never from memory, and you answer with JSON only.';
  const prompt = `Which city and state is the school "${name}"${stateHint ? ` in ${stateName(stateHint)}` : ''} in? It may be a college, a junior college or a high school. Search at most twice. Reply with only this JSON: {"school":"the school's name as the result gives it","city":"city","state":"two-letter state code"}. If the results do not say where it is, reply {"city":null}.`;
  let r;
  try {
    r = await d.searchLoop({ prompt, system, maxSearches: 2, maxFetches: 0, maxTokens: 300, temperature: 0, timeoutMs, ctx, provider: d.searchProvider() });
  } catch (e) { return { miss: 'error:' + e.message }; }
  let parsed = null;
  try { const m = String(r.text || '').match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; } catch (_) { parsed = null; }
  if (!parsed || !parsed.city) return { miss: 'no-answer' };
  const city = String(parsed.city).trim();
  const state = R.stateCode(parsed.state || stateHint || '');
  if (!city || !state || !Object.values(R.US_STATES).includes(state)) return { miss: 'no-state' };
  if (stateHint && state !== stateHint) return { miss: 'wrong-state' };
  // The model said a town. A result has to say it too, or it is not taken.
  const support = (r.results || []).find((x) => resultSupports(x, name, city, state) || (parsed.school && resultSupports(x, parsed.school, city, state) && namesAgree(name, parsed.school)));
  if (!support) return { miss: 'unsourced', said: `${city}, ${state}` };
  return { city, state, evidence: { url: support.url, title: support.title, snippet: support.snippet, school: parsed.school || null, searches: r.searches || 0 } };
}

// ── What was found, kept ────────────────────────────────────────────────────
let _loaded = null;
async function loadLearned() {
  const st = deps().store;
  if (!st || !st.pool) return 0;
  const r = await st.pool.query(`SELECT name, city, state FROM school_lookups WHERE status <> 'rejected' AND city IS NOT NULL`);
  let n = 0;
  for (const row of r.rows) if (R.learn(row.name, { city: row.city, state: row.state })) n++;
  return n;
}
function ensureLoaded() {
  if (!_loaded) _loaded = loadLearned().catch((e) => { console.error('[schoolFind] load:', e.message); _loaded = null; return 0; });
  return _loaded;
}

async function saveLookup(row) {
  const st = deps().store;
  if (!st || !st.pool) return null;
  const r = await st.pool.query(
    `INSERT INTO school_lookups (name_key, name, city, state, source, evidence, status, found_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'auto', $7)
     ON CONFLICT (name_key) DO UPDATE SET uses = school_lookups.uses + 1
     RETURNING id, name, city, state, source, status, uses`,
    [nameKey(row.name), row.name, row.city, row.state, row.source, JSON.stringify(row.evidence || {}), row.foundBy || null]);
  return r.rows[0] || null;
}
async function bumpUse(name) {
  const st = deps().store;
  if (!st || !st.pool) return;
  try { await st.pool.query(`UPDATE school_lookups SET uses = uses + 1 WHERE name_key = $1`, [nameKey(name)]); } catch (_) {}
}
async function rejectedNames() {
  const st = deps().store;
  if (!st || !st.pool) return new Set();
  try { const r = await st.pool.query(`SELECT name_key FROM school_lookups WHERE status = 'rejected'`); return new Set(r.rows.map((x) => x.name_key)); } catch (_) { return new Set(); }
}

const _negatives = new Map();
function negativeFor(key) { const n = _negatives.get(key); return n && Date.now() - n.at < NEGATIVE_TTL_MS ? n : null; }

const matched = (name, loc, source, method, confidence, extra) => ({
  ok: true, status: 'matched', matched: name, name,
  city: loc.city, state: loc.state || null,
  market: loc.state ? `${loc.city}, ${loc.state}` : loc.city,
  source, method: method || source, confidence: confidence == null ? 1 : confidence,
  message: `Local businesses will be found around ${loc.city}${loc.state ? ', ' + loc.state : ''}.`,
  suggestions: [], ...(extra || {}),
});
const ambiguous = (name, options) => ({
  ok: false, status: 'ambiguous', matched: null, market: null, options,
  suggestions: options.map((o) => ({ name: o.name, city: o.city, state: o.state })),
  message: `Which ${name}? Tap the right one.`,
});
const unknown = (name, why) => ({
  ok: false, status: 'unknown', matched: null, market: null, suggestions: [], options: [],
  ask: `What city is ${name} in? (City, ST)`,
  message: `What city is ${name} in?`,
  why: why || null,
});

async function findSchool(raw, opts = {}) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, status: 'empty', matched: null, market: null, suggestions: [], message: 'Add a school so the local lane has a town to work in.' };
  const stateHint = opts.state ? R.stateCode(opts.state) : null;
  const t0 = Date.now();
  const budget = Number(opts.timeoutMs) || FIND_BUDGET_MS;
  await ensureLoaded();

  // The agent answered the one question: their town is the town.
  if (opts.city) {
    const cs = parseCityState(opts.city, stateHint);
    if (!cs) return unknown(name, 'city-unparsed');
    if (!R.resolveSchool(name) || opts.override) {
      R.learn(name, cs);
      let saved = null;
      try { saved = await saveLookup({ name, city: cs.city, state: cs.state, source: 'agent', evidence: { typed: String(opts.city) }, foundBy: opts.agentId || null }); } catch (e) { console.error('[schoolFind] save:', e.message); }
      return matched(name, cs, 'agent', 'agent', 1, { saved: !!saved, learned: true });
    }
  }

  // 1. The lists, and what was learned: instant.
  const hit = R.resolveSchool(stateHint ? `${name} (${stateHint})` : name);
  if (hit && hit.city) {
    const entry = R.EXTRA_SCHOOLS[hit.matched];
    const learned = !!(entry && entry.learned);
    if (learned) bumpUse(hit.matched);
    return matched(hit.matched, { city: hit.city, state: R.stateCode(hit.state) || hit.state }, learned ? 'learned' : 'list', hit.method, hit.confidence);
  }

  // 2. A shared name: every town, the agent picks.
  const cands = R.candidatesFor(name);
  if (cands.length >= 2) return ambiguous(name, cands);

  // Junk never reaches a paid lookup: "State", "TBD", a single letter.
  if (name.length < 3 || !/[a-z]/i.test(name) || !R.isIdentityLike(name) || !distinctive(name).length) return unknown(name, 'not-a-name');
  // The keystroke check: the lists only, no spend. The form asks again with
  // the lookup once the agent stops typing.
  if (opts.instantOnly) return { ok: false, status: 'unresolved', matched: null, market: null, suggestions: [], options: [], message: 'Finding the school…' };
  const key = nameKey(name) + (stateHint ? '|' + stateHint : '');
  const neg = negativeFor(key);
  if (neg) return unknown(name, neg.why);
  if ((await rejectedNames()).has(nameKey(name))) return unknown(name, 'rejected');

  const ctx = { site: 'lookup.school', brand: name, agentId: opts.agentId || null };
  const tried = {};

  // 3. Places.
  const p = await fromPlaces(name, stateHint);
  tried.places = p.miss || 'found';
  let found = p.city ? { ...p, source: 'places' } : null;

  // 4. The web, checked against its own source.
  if (!found) {
    const left = budget - (Date.now() - t0);
    const w = await fromWeb(name, stateHint, Math.max(WEB_MIN_MS, left), ctx);
    tried.web = w.miss || 'found';
    if (w.city) found = { ...w, source: 'web' };
  }

  if (!found) {
    _negatives.set(key, { at: Date.now(), why: tried });
    console.log(`[schoolFind] "${name}" not found (${JSON.stringify(tried)}) in ${Date.now() - t0}ms`);
    return unknown(name, tried);
  }

  R.learn(name, { city: found.city, state: found.state });
  let saved = null;
  try { saved = await saveLookup({ name, city: found.city, state: found.state, source: found.source, evidence: found.evidence, foundBy: opts.agentId || null }); } catch (e) { console.error('[schoolFind] save:', e.message); }
  console.log(`[schoolFind] "${name}" -> ${found.city}, ${found.state} (${found.source}) in ${Date.now() - t0}ms`);
  return matched(name, { city: found.city, state: found.state }, found.source, found.source, 1, { saved: !!saved, learned: true, tried, ms: Date.now() - t0 });
}

// Several at once (the import): distinct names, a few in flight, the
// resolver learning as each returns.
async function findMany(names, opts = {}) {
  const uniq = [...new Set((names || []).map((n) => String(n || '').trim()).filter(Boolean))];
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < uniq.length) { const n = uniq[i++]; out.set(n, await findSchool(n, opts).catch((e) => unknown(n, 'error:' + e.message))); }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(6, opts.concurrency || 4)) }, worker));
  return out;
}

// ── The admin page ──────────────────────────────────────────────────────────
async function listLookups(opts = {}) {
  const st = deps().store;
  if (!st || !st.pool) return [];
  const r = await st.pool.query(
    `SELECT l.id, l.name, l.city, l.state, l.source, l.evidence, l.status, l.found_by, l.uses, l.created_at, l.reviewed_at, l.note,
            u.email AS found_by_email,
            (SELECT COUNT(*) FROM athletes a WHERE LOWER(TRIM(a.data->>'school')) = LOWER(l.name)) AS athletes
       FROM school_lookups l LEFT JOIN users u ON u.id = l.found_by
      ${opts.status ? 'WHERE l.status = $1' : ''}
      ORDER BY (l.status = 'auto') DESC, l.created_at DESC LIMIT 500`, opts.status ? [opts.status] : []);
  return r.rows;
}

// Confirm, correct or reject one row; the resolver changes in the same call.
async function reviewLookup(id, patch = {}) {
  const st = deps().store;
  if (!st || !st.pool) throw new Error('no database');
  const cur = (await st.pool.query(`SELECT * FROM school_lookups WHERE id = $1`, [id])).rows[0];
  if (!cur) return null;
  const status = ['confirmed', 'rejected', 'auto'].includes(patch.status) ? patch.status : cur.status;
  let city = cur.city, state = cur.state;
  if (patch.city !== undefined || patch.state !== undefined) {
    // The state is typed, never inherited: a correction that only names a
    // city is the very mistake this page exists to catch.
    const cs = patch.state
      ? { city: String(patch.city || cur.city || '').trim(), state: R.stateCode(patch.state) }
      : parseCityState(patch.city, null);
    if (!cs || !cs.city || !cs.state || !Object.values(R.US_STATES).includes(cs.state)) throw Object.assign(new Error('Give the town as "City, ST".'), { status: 400 });
    city = cs.city; state = cs.state;
  }
  const r = await st.pool.query(
    `UPDATE school_lookups SET status = $2, city = $3, state = $4, note = COALESCE($5, note), reviewed_at = NOW() WHERE id = $1
     RETURNING id, name, city, state, source, status, uses`, [id, status, city, state, patch.note || null]);
  const row = r.rows[0];
  R.unlearn(row.name);
  if (status !== 'rejected' && row.city) R.learn(row.name, { city: row.city, state: row.state });
  return row;
}

module.exports = {
  findSchool, findMany, loadLearned, ensureLoaded, listLookups, reviewLookup,
  parseCityState, namesAgree, resultSupports, distinctive, nameKey,
  SOURCES, NEGATIVE_TTL_MS, FIND_BUDGET_MS, _setDepsForTests,
};
