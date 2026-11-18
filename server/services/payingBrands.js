'use strict';
// ── BRANDS ALREADY PAYING ATHLETES ON SOCIAL (services/payingBrands) ─────────
//
// The social lane (social_brands) is brands with an ambassador PROGRAM page:
// they say they take athletes. This is the other half, and the stronger lead:
// brands with public proof that they PAID an athlete. A brand that has paid a
// softball player at the school down the road has a budget, has done the
// paperwork once, and knows what a post is worth.
//
// TWO SOURCES, both public or consented:
//
//   1. SEARCH, per school, at most once every REFRESH_DAYS. Two searches: NIL
//      deal announcements (news, the school's own site, local press) and
//      athlete posts marked as paid (#ad, "paid partnership", #NILdeal). Each
//      result is a line: title, snippet, the address. The fast model names
//      the brand and the athlete in each line that shows a deal; a brand it
//      names that is not in that line's own words is dropped, and so is an
//      athlete. Every row keeps the address that proves it.
//
//   2. CONNECTED ATHLETES (services/instagramConnect, by the athlete's own
//      consent): their recent captions. A caption marked as paid (#ad,
//      #sponsored, "paid partnership", "use my code", #ambassador) names the
//      brand by its @handle. No model, no cost.
//
// WHAT IS NOT A PAYING BRAND: the school, its athletics department or
// conference, a collective, an NIL platform or marketplace, media, and the
// compliance blocks (alcohol, betting, cannabis, tobacco, firearms, adult).
// National brands ARE kept: a national brand that pays small-school athletes
// is exactly the lead.
//
// WHO GETS THEM (read side, no cost):
//   forAthlete   brands that paid athletes in the same sport in the same
//                state first, then the same sport anywhere. For the agent.
//   forSchool    brands that paid athletes at other schools in the school's
//                state, and not yet at this one. For the university side.
//
// COLLECT FIRST, as with school sponsors: stored and shown (admin page, the
// agent API). Nothing here writes a pitch or emails a business.
//
// COST: two searches and one fast-model call per school, DAILY_SCHOOLS a day.
// PAYING_BRANDS_OFF=1 stops the job.

const DAY = 86400000;
const REFRESH_DAYS = 30;
const DAILY_SCHOOLS = Math.max(1, Math.min(200, parseInt(process.env.PAYING_BRANDS_DAILY, 10) || 40));
const MAX_LINES = 24;

const OFF = () => String(process.env.PAYING_BRANDS_OFF || '').trim() === '1';
const keyOf = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[@#]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

async function ensureTables(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS paying_brands (
    brand_key  TEXT PRIMARY KEY,
    brand      TEXT NOT NULL,
    handle     TEXT,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS paying_brand_proof (
    id           SERIAL PRIMARY KEY,
    brand_key    TEXT NOT NULL,
    school       TEXT,
    school_key   TEXT,
    school_state TEXT,
    athlete      TEXT,
    sport        TEXT,
    kind         TEXT NOT NULL,
    source_url   TEXT NOT NULL,
    title        TEXT,
    found_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (brand_key, source_url)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_paying_brand_proof_state ON paying_brand_proof (school_state, sport)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS paying_brand_runs (
    school_key TEXT PRIMARY KEY,
    school     TEXT NOT NULL,
    ran_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    found      INTEGER NOT NULL DEFAULT 0,
    note       TEXT
  )`);
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; } }
function stateOf(school) {
  try { const hit = require('./usColleges').find(String(school || '').trim()); return hit ? hit.state : null; } catch (_) { return null; }
}
const SPORTS = ['football', 'basketball', 'baseball', 'softball', 'volleyball', 'soccer', 'track', 'cross country', 'golf', 'tennis', 'swimming', 'wrestling', 'gymnastics', 'lacrosse', 'hockey', 'rowing', 'cheer', 'beach volleyball'];
function sportOf(s) {
  const k = keyOf(s);
  if (!k) return null;
  return SPORTS.find((x) => (' ' + k + ' ').includes(' ' + x + ' ')) || k.split(' ').slice(-1)[0] || null;
}

// ── WHAT IS NOT A PAYING BRAND ──────────────────────────────────────────────
const NOT_A_BRAND = /\b(pliable|marketing agency|sports agency|nil agency|sports management|talent management|collective|athletics?|athletic department|conference|ncaa|naia|njcaa|opendorse|inflcr|teamworks|learfield|playfly|nil club|nilclub|marketpryce|dreamfield|icon source|nil store|basepath|influxer|espn|on3|247sports|rivals|sports illustrated|the athletic|instagram|tiktok|youtube|facebook|twitter|linkedin)\b/i;
function refused(brand, school) {
  const k = keyOf(brand);
  if (!k || k.length < 2) return 'empty';
  if (NOT_A_BRAND.test(k)) return 'not a brand';
  const sw = new Set(keyOf(school).split(' ').concat(['university', 'college', 'state', 'the', 'of', 'u']));
  if (school && k.split(' ').every((w) => sw.has(w))) return 'the school';
  try {
    const { hits } = require('./compliance').classifyBusiness(brand, {});
    const h = hits.find((x) => ['alcohol', 'cannabis', 'tobacco', 'firearms', 'gambling', 'adult', 'collective', 'not-a-sponsor'].includes(x.key));
    if (h) return h.key;
  } catch (_) { /* the classifier is advisory here */ }
  return null;
}

async function saveProof(pool, p) {
  const bk = keyOf(p.brand);
  await pool.query(`INSERT INTO paying_brands (brand_key, brand, handle) VALUES ($1,$2,$3)
    ON CONFLICT (brand_key) DO UPDATE SET last_seen = NOW(), handle = COALESCE(paying_brands.handle, EXCLUDED.handle)`, [bk, String(p.brand).trim().slice(0, 120), p.handle || (/^@[A-Za-z0-9._]{2,30}$/.test(String(p.brand).trim()) ? String(p.brand).trim().slice(1).toLowerCase() : null)]);
  const r = await pool.query(`INSERT INTO paying_brand_proof (brand_key, school, school_key, school_state, athlete, sport, kind, source_url, title)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (brand_key, source_url) DO NOTHING RETURNING id`,
  [bk, p.school || null, p.school ? keyOf(p.school) : null, p.state || null, p.athlete || null, p.sport || null, p.kind, p.url, p.title ? String(p.title).slice(0, 300) : null]);
  return r.rows.length > 0;
}

// ── 1. SEARCH ───────────────────────────────────────────────────────────────
const DEAL_WORDS = /\bnil\b|#ad\b|paid partnership|sponsored|#nildeal|partners? with|signs?\b|signed|ambassador|deal\b|endorse/i;
function queriesFor(school) {
  return [`"${school}" NIL deal athlete signs with`, `"${school}" athlete "#ad" OR "paid partnership" OR "#NILdeal"`];
}
// Search results to lines the model reads: only ones that name the school and
// read like a deal. -> [{ line, url, host }]
function linesFrom(rows, school) {
  const words = keyOf(school).split(' ').filter((w) => w.length > 3 && !['university', 'college', 'state', 'community'].includes(w));
  const out = [], seen = new Set();
  for (const r of rows) {
    if (!r || !r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    let slug = '';
    try { slug = decodeURIComponent(new URL(r.url).pathname.split('/').filter(Boolean).pop() || '').replace(/\.aspx?$/i, '').replace(/[-_]+/g, ' '); } catch (_) { slug = ''; }
    const line = [r.title, r.snippet, slug].filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 420);
    const lk = ' ' + keyOf(line) + ' ';
    if (words.length && !words.some((w) => lk.includes(' ' + w + ' '))) continue;
    if (!DEAL_WORDS.test(line)) continue;
    out.push({ line, url: r.url, host: hostOf(r.url) });
  }
  return out.slice(0, MAX_LINES);
}

const SYSTEM = 'You read search results about college athletes. For each numbered line that shows a business or brand PAYING or PARTNERING WITH a named athlete or the athletes of a team (an NIL deal, a paid or sponsored post, an ambassador signing), return the brand and, if named, the athlete and the sport. Never return the school, its athletics department, its conference, a collective, an NIL platform or marketplace, a sports or NIL marketing agency or management firm, a media outlet, or a line that only mentions NIL in general. Copy the brand and athlete exactly as written in that line. Answer with JSON: {"deals": [{"line": 1, "brand": "", "athlete": "", "sport": ""}]}.';

async function pickDeals(school, lines, chat) {
  const res = await chat({ system: SYSTEM, jsonMode: true, maxTokens: 1500, temperature: 0,
    messages: [{ role: 'user', content: `School: ${school}\n` + lines.map((l, i) => `${i + 1}. ${l.line}`).join('\n') }],
    ledger: { site: 'paying-brands' } });
  let j = null;
  try { j = JSON.parse(String(res && res.text || '').replace(/^```(json)?|```$/g, '')); } catch (_) { j = null; }
  const out = [];
  for (const d of (j && Array.isArray(j.deals) ? j.deals : [])) {
    const l = lines[Number(d.line) - 1];
    if (!l || !d.brand) continue;
    const hay = ' ' + keyOf(l.line) + ' ';
    const bk = keyOf(d.brand);
    if (!bk || !hay.includes(' ' + bk + ' ')) continue;                 // the brand is in the line, or it is dropped
    const ak = keyOf(d.athlete);
    const athlete = ak && ak.split(' ').length >= 2 && hay.includes(' ' + ak + ' ') ? String(d.athlete).trim() : null;
    out.push({ brand: String(d.brand).trim(), athlete, sport: sportOf(d.sport), url: l.url, title: l.line.split(' | ')[0],
      kind: /instagram\.com|tiktok\.com|(^|\.)x\.com|twitter\.com|facebook\.com/.test(l.host || '') ? 'post' : 'announcement' });
  }
  return out;
}

// One school. deps: { search, chat, force }. -> { school, found, added, refused, note }
async function refresh(pool, school, deps = {}) {
  await ensureTables(pool);
  const sk = keyOf(school);
  if (!sk) return { school, note: 'no school' };
  if (!deps.force) {
    const last = (await pool.query(`SELECT ran_at FROM paying_brand_runs WHERE school_key = $1`, [sk])).rows[0];
    if (last && Date.now() - new Date(last.ran_at).getTime() < REFRESH_DAYS * DAY) return { school, skipped: 'fresh' };
  }
  const search = deps.search || ((q, n) => { const p = require('./webSearchTool').provider(); if (!p) throw new Error('no search provider'); return p.search(q, n); });
  const chat = deps.chat || ((o) => require('./deepseek').chat(o));
  const done = async (found, note, extra) => {
    await pool.query(`INSERT INTO paying_brand_runs (school_key, school, ran_at, found, note) VALUES ($1,$2,NOW(),$3,$4)
      ON CONFLICT (school_key) DO UPDATE SET school = EXCLUDED.school, ran_at = NOW(), found = EXCLUDED.found, note = EXCLUDED.note`, [sk, school, found, note]);
    return Object.assign({ school, found, note }, extra || {});
  };
  let rows = [];
  for (const q of queriesFor(school)) {
    try { rows = rows.concat(await search(q, 10) || []); } catch (e) { console.warn('[paying-brands] search:', e.message); }
  }
  const lines = linesFrom(rows, school);
  if (!lines.length) return done(await countFor(pool, sk), 'no deal announcements or paid posts found');
  let deals = [];
  try { deals = await pickDeals(school, lines, chat); } catch (e) { return done(await countFor(pool, sk), 'model failed: ' + e.message); }
  const state = stateOf(school);
  let added = 0; const no = [];
  for (const d of deals) {
    const why = refused(d.brand, school);
    if (why) { no.push({ brand: d.brand, why }); continue; }
    if (await saveProof(pool, Object.assign({ school, state }, d))) added++;
  }
  return done(await countFor(pool, sk), added ? null : (deals.length ? 'only refused names' : 'no deals named in the results'), { added, refused: no });
}
async function countFor(pool, sk) {
  return (await pool.query(`SELECT COUNT(DISTINCT brand_key)::int n FROM paying_brand_proof WHERE school_key = $1`, [sk])).rows[0].n;
}

// ── 2. CONNECTED ATHLETES' OWN POSTS ────────────────────────────────────────
const PAID_MARK = /#ad\b|#sponsored\b|paid partnership|#partner\b|#ambassador\b|#nil\b|#nildeal\b|use (my )?code\b|\bcode [A-Z0-9]{3,}\b/i;
const NOT_A_HANDLE = /athletic|football|basketball|baseball|softball|volleyball|soccer|track|xc$|golf|tennis|swim|wrestl|cheer|nil$|_nil|collective|^ncaa|sports?$/i;
function brandsInCaption(caption, ownHandle) {
  if (!caption || !PAID_MARK.test(caption)) return [];
  const out = [];
  for (const m of String(caption).matchAll(/(^|[^\w.])@([A-Za-z0-9._]{2,30})/g)) {
    const h = m[2].replace(/\.+$/, '').toLowerCase();
    if (!h || h === String(ownHandle || '').toLowerCase() || NOT_A_HANDLE.test(h)) continue;
    if (!out.includes(h)) out.push(h);
  }
  return out.slice(0, 3);
}
async function fromConnected(pool) {
  await ensureTables(pool);
  const r = await pool.query(
    `SELECT DISTINCT ON (s.athlete_id) s.athlete_id, s.username, s.posts, a.data
       FROM instagram_stats s JOIN athletes a ON a.id = s.athlete_id
      WHERE s.posts IS NOT NULL ORDER BY s.athlete_id, s.fetched_at DESC`).catch(() => ({ rows: [] }));
  let added = 0;
  for (const row of r.rows) {
    const d = row.data || {};
    for (const p of (Array.isArray(row.posts) ? row.posts : [])) {
      if (!p || !p.permalink) continue;
      for (const h of brandsInCaption(p.caption, row.username)) {
        if (refused(h, d.school)) continue;
        if (await saveProof(pool, { brand: '@' + h, handle: h, school: d.school || null, state: stateOf(d.school), athlete: d.name || null,
          sport: sportOf(d.sport), kind: 'connected', url: p.permalink, title: String(p.caption).slice(0, 200) })) added++;
      }
    }
  }
  return { athletes: r.rows.length, added };
}

// ── WHO GETS THEM ───────────────────────────────────────────────────────────
// Brands grouped with their proof. where: SQL on paying_brand_proof p.
async function _grouped(pool, where, params, limit) {
  const r = await pool.query(
    `SELECT b.brand_key, b.brand, b.handle, COUNT(*)::int proofs, COUNT(DISTINCT COALESCE(p.athlete, p.source_url))::int athletes,
            COUNT(DISTINCT p.school_key)::int schools, MAX(p.found_at) last_seen,
            (ARRAY_AGG(json_build_object('athlete', p.athlete, 'school', p.school, 'sport', p.sport, 'kind', p.kind, 'url', p.source_url) ORDER BY p.found_at DESC))[1:3] AS proof
       FROM paying_brand_proof p JOIN paying_brands b ON b.brand_key = p.brand_key
      WHERE ${where}
      GROUP BY b.brand_key, b.brand, b.handle
      ORDER BY athletes DESC, schools DESC, last_seen DESC LIMIT $${params.length + 1}`, params.concat([limit]));
  return r.rows.map((x) => ({ brand: x.brand, handle: x.handle, athletes: x.athletes, schools: x.schools, lastSeen: x.last_seen, proof: x.proof }));
}

// For one athlete: same sport and state, then same sport anywhere. -> { state, sport, nearby, elsewhere }
async function forAthlete(pool, athlete, { limit = 10 } = {}) {
  await ensureTables(pool);
  const state = stateOf(athlete.school);
  const sport = sportOf(athlete.sport);
  const sk = keyOf(athlete.school);
  const sportOk = `(p.sport IS NULL OR $1::text IS NULL OR p.sport = $1)`;
  const nearby = state ? await _grouped(pool, `${sportOk} AND p.school_state = $2`, [sport, state], limit) : [];
  const seen = new Set(nearby.map((x) => x.brand));
  const elsewhere = nearby.length < limit
    ? (await _grouped(pool, `p.sport = $1 AND COALESCE(p.school_state, '') <> COALESCE($2, '')`, [sport, state], limit)).filter((x) => !seen.has(x.brand)).slice(0, limit - nearby.length)
    : [];
  return { state, sport, school: athlete.school || null, schoolKey: sk, nearby, elsewhere };
}

// For a school: brands that paid athletes at other schools in its state, not yet here.
async function forSchool(pool, school, { limit = 25 } = {}) {
  await ensureTables(pool);
  const state = stateOf(school);
  if (!state) return { school, state: null, brands: [] };
  const sk = keyOf(school);
  const brands = await _grouped(pool,
    `p.school_state = $1 AND COALESCE(p.school_key, '') <> $2 AND NOT EXISTS (SELECT 1 FROM paying_brand_proof q WHERE q.brand_key = p.brand_key AND q.school_key = $2)`,
    [state, sk], limit);
  return { school, state, brands };
}

// ── INTO THE SOCIAL LANE (services/scout socialCandidates) ──────────────────
// The brands that paid athletes like this one, as slate candidates: nearby
// (same state) first, then the same sport anywhere. Each carries the one
// public fact the writer may use, and signingEvidence turns its proof into the
// card's note. A brand known only by its handle is pitched by that handle.
async function candidatesFor(pool, athlete, { limit = 6 } = {}) {
  if (String(process.env.PAYING_BRANDS_LANE || '').trim() === '0') return [];
  const a = athlete || {};
  if (!a.school && !a.sport) return [];
  const m = await forAthlete(pool, { school: a.school, sport: a.sport }, { limit });
  const out = [];
  for (const b of m.nearby.concat(m.elsewhere)) {
    const p = (b.proof || [])[0] || {};
    const name = String(b.brand || '').replace(/^@/, '').trim();
    if (!name) continue;
    const where = [p.school, p.sport].filter(Boolean).join(' ');
    out.push({
      brand_key: keyOf(b.brand), brand_name: name, lane: 'social', pool: 'paying-proof',
      instagram: b.handle || null,
      why: `Paid ${b.athletes === 1 ? 'a college athlete' : b.athletes + ' college athletes'}${where ? ' (' + where + ')' : ''}`,
      // What the writer may say about them: a public fact, no names.
      evidence_text: `Has partnered with ${where ? 'a ' + where + ' athlete' : 'college athletes'} on social`,
      paidProofUrl: p.url || null,
    });
  }
  return out.slice(0, limit);
}

// ── THE DAILY JOB ───────────────────────────────────────────────────────────
// Schools where an active agent has an athlete, and every university account's school, stalest first.
async function dueSchools(pool, { limit = DAILY_SCHOOLS } = {}) {
  await ensureTables(pool);
  const r = await pool.query(
    `SELECT s.school FROM (
        SELECT DISTINCT TRIM(a.data->>'school') AS school
          FROM athletes a JOIN users u ON u.id = a.agent_id AND u.role = 'agent' AND COALESCE(u.archived, false) = false
         WHERE COALESCE(TRIM(a.data->>'school'), '') <> ''
           AND EXISTS (SELECT 1 FROM outreach_logs l WHERE l.agent_id = u.id AND l.sent_at > NOW() - INTERVAL '30 days')
        UNION
        SELECT DISTINCT TRIM(name) FROM universities WHERE COALESCE(TRIM(name), '') <> '') s
       LEFT JOIN paying_brand_runs x ON x.school_key = LOWER(TRIM(regexp_replace(replace(s.school, '&', ' and '), '[^a-zA-Z0-9]+', ' ', 'g')))
      WHERE x.ran_at IS NULL OR x.ran_at < NOW() - ($1::int || ' days')::interval
      ORDER BY x.ran_at NULLS FIRST, s.school LIMIT $2`, [REFRESH_DAYS, limit]).catch((e) => { console.warn('[paying-brands] due:', e.message); return { rows: [] }; });
  const due = r.rows.map((x) => x.school);
  if (due.length >= limit) return due;
  // ── AND THE SCHOOLS AROUND THEM ──────────────────────────────────────────
  // A brand that paid an athlete at the school down the road is the lead for
  // our athlete, so the rest of the day's reads go to other athletic programs
  // (program_source, every athletics site we read) in the states our athletes
  // and universities are in, never read or read longest ago.
  try {
    const states = new Set();
    for (const s of (await pool.query(
      `SELECT DISTINCT TRIM(a.data->>'school') AS school FROM athletes a JOIN users u ON u.id = a.agent_id AND u.role = 'agent' AND COALESCE(u.archived, false) = false
        WHERE COALESCE(TRIM(a.data->>'school'), '') <> ''
       UNION SELECT DISTINCT TRIM(name) FROM universities WHERE COALESCE(TRIM(name), '') <> ''`).catch(() => ({ rows: [] }))).rows) {
      const st = stateOf(s.school); if (st) states.add(st);
    }
    if (!states.size) return due;
    const have = new Set(due.map(keyOf));
    const read = new Map((await pool.query(`SELECT school_key, ran_at FROM paying_brand_runs`)).rows.map((x) => [x.school_key, new Date(x.ran_at).getTime()]));
    const near = [];
    for (const x of (await pool.query(`SELECT DISTINCT TRIM(school) AS school FROM program_source WHERE COALESCE(TRIM(school), '') <> ''`).catch(() => ({ rows: [] }))).rows) {
      const k = keyOf(x.school);
      if (have.has(k)) continue;
      const at = read.get(k);
      if (at && Date.now() - at < REFRESH_DAYS * DAY) continue;
      if (!states.has(stateOf(x.school))) continue;
      near.push({ school: x.school, at: at || 0 });
    }
    near.sort((a, b) => a.at - b.at || a.school.localeCompare(b.school));
    return due.concat(near.slice(0, limit - due.length).map((x) => x.school));
  } catch (e) { console.warn('[paying-brands] nearby schools:', e.message); return due; }
}

let _busy = false;
async function tick(pool, deps = {}) {
  if (OFF() || _busy) return { skipped: OFF() ? 'off' : 'busy' };
  _busy = true;
  try {
    const out = [];
    for (const s of await dueSchools(pool)) {
      try { out.push(await refresh(pool, s, deps)); } catch (e) { out.push({ school: s, error: e.message }); }
    }
    let connected = null;
    try { connected = await fromConnected(pool); } catch (e) { connected = { error: e.message }; }
    if (out.length || (connected && connected.added)) console.log('[paying-brands]', JSON.stringify({ schools: out.map((x) => ({ school: x.school, found: x.found, added: x.added, note: x.note || x.error || null })), connected }));
    return { ran: out, connected };
  } finally { _busy = false; }
}
function start(pool) {
  if (OFF()) { console.log('[paying-brands] off (PAYING_BRANDS_OFF)'); return; }
  const go = () => tick(pool).catch((e) => console.error('[paying-brands] tick:', e.message));
  setTimeout(go, 20 * 60 * 1000).unref?.();
  const t = setInterval(go, 24 * 60 * 60 * 1000); if (t.unref) t.unref();
}

// ── THE ADMIN PAGE ──────────────────────────────────────────────────────────
async function overview(pool) {
  await ensureTables(pool);
  const brands = await _grouped(pool, 'TRUE', [], 300);
  const runs = (await pool.query(`SELECT school, ran_at, found, note FROM paying_brand_runs ORDER BY ran_at DESC LIMIT 200`)).rows;
  return { brands, runs };
}
function renderHtml(ov) {
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const KIND = { announcement: 'announced', post: 'paid post', connected: 'connected athlete\'s post' };
  const brands = ov.brands.map((b) => `<div class="s"><div class="h">${esc(b.brand)} <span class="n">${b.athletes} athlete${b.athletes === 1 ? '' : 's'}, ${b.schools} school${b.schools === 1 ? '' : 's'}</span></div>
    ${(b.proof || []).map((p) => `<div class="m">${esc([p.athlete, p.sport, p.school].filter(Boolean).join(', ') || 'athletes')} (${esc(KIND[p.kind] || p.kind)}): <a href="${esc(p.url)}" rel="noopener" target="_blank">${esc(p.url)}</a></div>`).join('')}</div>`).join('')
    || '<p class="m">Nothing collected yet. Schools are read a few a day.</p>';
  const runs = ov.runs.map((r) => `<div class="m">${esc(r.school)}: ${r.found} brand${r.found === 1 ? '' : 's'}${r.note ? ', ' + esc(r.note) : ''}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Paying brands</title>
<style>body{margin:0;background:#0F1A14;color:#E8EFEA;font:14px/1.5 system-ui,Arial,sans-serif}.w{max-width:960px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 6px}
.s{border-bottom:1px solid #24382B;padding:12px 0}.h{font-weight:700}.n{color:#C8F135;font-weight:600;margin-left:6px}.m{color:#9FB1A6;font-size:12px;word-break:break-all}a{color:#9FB1A6}</style></head>
<body><div class="w"><h1>Brands paying athletes</h1><div class="m">Public proof that a brand paid or partnered with an athlete, with the link. Collected, not used in pitches yet.</div>
${brands}<h2>Schools read</h2>${runs || '<p class="m">None yet.</p>'}</div></body></html>`;
}

module.exports = { candidatesFor, ensureTables, refresh, linesFrom, pickDeals, refused, brandsInCaption, fromConnected, forAthlete, forSchool, dueSchools, tick, start, overview, renderHtml, keyOf, sportOf, stateOf, queriesFor, REFRESH_DAYS, DAILY_SCHOOLS };
