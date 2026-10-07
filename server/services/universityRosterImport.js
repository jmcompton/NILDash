'use strict';
// ── A UNIVERSITY'S TEAMS AND ROSTERS, FROM ITS ATHLETICS SITE ───────────────
//
// importRosters(pool, { universityId, siteUrl }) reads the athletics site's
// home page for its sports, then each sport's roster page, and writes:
//   university_teams     one per sport found with a roster (an existing team
//                        of the same name is reused, never duplicated)
//   university_athletes  one per player, id `<teamId>:<name-slug>`, so a
//                        second import updates rather than duplicates
// Read-only on the site, no AI and no paid API: it costs nothing.
//
// THE TWO PLATFORMS college sites run on, and a fallback:
//   PrestoSports  /sports/<code>/<season>/roster, a <table> of players
//                 (California community colleges, cypresschargers.com)
//   Sidearm       /sports/<sport>/roster, .sidearm-roster-player cards or
//                 the newer .s-person-card layout
//   anything else a <table> whose header has a Name column
// Coaches are left out: a coaching-staff table has a Title column and no
// position or year.
//
// Every team says what happened: the URL tried, how many players landed, or
// why none did. Nothing is guessed: a team with no roster page found is
// reported and not created.

const cheerio = require('cheerio');

const UA = 'Mozilla/5.0 (compatible; NILDashRosterImport/1.0; +https://mynildash.com)';
const MAX_TEAMS = 40;

const lc = (s) => String(s || '').trim().toLowerCase();
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const slug = (s) => lc(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

async function getPage(url, deps = {}) {
  if (deps.fetch) return deps.fetch(url);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: ctl.signal });
    return { ok: r.ok, status: r.status, url: r.url || url, text: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, url, text: '', error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally { clearTimeout(t); }
}

// ── WHICH SPORTS THE SITE HAS ───────────────────────────────────────────────
// Every link of the form /sports/<code>/... on the home page, with the best
// label the page gives it. /sports/<code>/<season>/... (Presto) keeps the
// season the site itself links to.
const NOT_TEAMS = /^(all-sports|sports|schedule|news|tickets|facilities|staff|directory|camps|recruits|composite|calendar|archives?|landing|general|athletics)$/i;
function discoverTeams(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);
  const teams = new Map();
  $('a[href]').each((_, a) => {
    let u;
    try { u = new URL($(a).attr('href'), base); } catch (_) { return; }
    if (u.host.replace(/^www\./, '') !== base.host.replace(/^www\./, '')) return;
    const m = u.pathname.match(/^\/sports\/([a-z0-9-]+)(?:\/(\d{4}(?:-\d{2})?))?(?:\/|$)/i);
    if (!m || NOT_TEAMS.test(m[1])) return;
    const code = m[1].toLowerCase();
    const label = squash($(a).text()) || squash($(a).attr('title')) || squash($(a).attr('aria-label'));
    const t = teams.get(code) || { code, labels: [], seasons: new Set() };
    if (label && label.length <= 40 && !/^(roster|schedule|news|stats|coaches|home|more|results|tickets)$/i.test(label)) t.labels.push(label);
    if (m[2]) t.seasons.add(m[2]);
    teams.set(code, t);
  });
  // ONE TEAM PER SPORT, NOT PER CODE: two codes whose names are the same team
  // (teamNames.teamKey) collapse into one, keeping every code to try for the
  // roster and every season the site links.
  const TN = require('./teamNames');
  const byKey = new Map();
  for (const t of teams.values()) {
    const name = bestName(t.labels, t.code);
    const k = TN.teamKey(name);
    const seen = byKey.get(k);
    if (seen) { seen.codes.push(t.code); for (const x of t.seasons) seen.seasons.add(x); continue; }
    byKey.set(k, { code: t.code, codes: [t.code], name, seasons: new Set(t.seasons) });
  }
  return [...byKey.values()].map((t) => ({ code: t.code, codes: t.codes, name: t.name, seasons: [...t.seasons].sort().reverse() })).slice(0, MAX_TEAMS);
}

// The label a person would use: "Men's Basketball" over "Basketball" over the code.
const CODE_NAMES = {
  mbkb: "Men's Basketball", wbkb: "Women's Basketball", bsb: 'Baseball', sball: 'Softball', fball: 'Football',
  wvball: "Women's Volleyball", mvball: "Men's Volleyball", bvball: 'Beach Volleyball', wbvball: 'Beach Volleyball',
  msoc: "Men's Soccer", wsoc: "Women's Soccer", mxc: "Men's Cross Country", wxc: "Women's Cross Country", xc: 'Cross Country',
  mtrack: "Men's Track & Field", wtrack: "Women's Track & Field", track: 'Track & Field',
  mwpolo: "Men's Water Polo", wwpolo: "Women's Water Polo", mswimdive: "Men's Swimming & Diving", wswimdive: "Women's Swimming & Diving",
  mgolf: "Men's Golf", wgolf: "Women's Golf", mten: "Men's Tennis", wten: "Women's Tennis", wbad: 'Badminton', wrest: 'Wrestling',
  wflag: 'Flag Football', wflagfb: 'Flag Football',
};
function bestName(labels, code) {
  return require('./teamNames').canonicalName(bestLabel(labels, code));
}
function bestLabel(labels, code) {
  const gendered = labels.find((l) => /\b(men|women)'?s\b/i.test(l) && /[a-z]/i.test(l));
  if (gendered) return gendered.replace(/\s+/g, ' ');
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (labels.length) return labels.sort((a, b) => b.length - a.length)[0];
  return code.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ').replace(/^Mens /, "Men's ").replace(/^Womens /, "Women's ");
}

function seasonOf(name) {
  const n = lc(name);
  if (/football|volleyball(?!.*beach)|water polo|cross country|soccer/.test(n) && !/beach|flag/.test(n)) return 'Fall';
  if (/basketball|wrestling/.test(n)) return 'Winter';
  return 'Spring';
}
function sportOf(name) {
  return squash(String(name).replace(/\b(men|women)'?s\b/i, '')) || name;
}

// The roster URLs to try for a team, best first.
function rosterUrls(baseUrl, team, now = new Date()) {
  const base = new URL(baseUrl).origin;
  const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
  const academic = m >= 7 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`;
  const seasons = [...new Set([...team.seasons, academic, String(m >= 7 ? y : y), String(m >= 7 ? y + 1 : y - 1)])];
  return [...new Set([
    ...seasons.map((s) => `${base}/sports/${team.code}/${s}/roster`),
    `${base}/sports/${team.code}/roster`,
  ])];
}

// ── READING A ROSTER PAGE ───────────────────────────────────────────────────
const NAME_OK = (n) => /^[A-Za-z][A-Za-z.'’\- ]+[A-Za-z.]$/.test(n) && n.split(/\s+/).length >= 2 && n.length <= 60
  && !/\b(name|roster|coach|staff|position|year|hometown|jersey|player)\b/i.test(n);

function parseRoster(html) {
  const $ = cheerio.load(html);
  const out = [];
  // Sidearm, classic.
  $('.sidearm-roster-player').each((_, el) => {
    const e = $(el);
    const name = squash(e.find('.sidearm-roster-player-name a').first().text() || e.find('.sidearm-roster-player-name h3').first().text() || e.find('.sidearm-roster-player-name').first().text());
    out.push({ name, jersey: squash(e.find('.sidearm-roster-player-jersey-number').first().text()),
      position: squash(e.find('.sidearm-roster-player-position .text-bold, .sidearm-roster-player-position-long-short').first().text() || e.find('.sidearm-roster-player-position').first().text()),
      year: squash(e.find('.sidearm-roster-player-academic-year').first().text()),
      height: squash(e.find('.sidearm-roster-player-height').first().text()),
      hometown: squash(e.find('.sidearm-roster-player-hometown').first().text()),
      highSchool: squash(e.find('.sidearm-roster-player-highschool, .sidearm-roster-player-previous-school').first().text()) });
  });
  // Sidearm, newer cards (players only: a staff card has a title, no position).
  if (!out.length) {
    $('.s-person-card').each((_, el) => {
      const e = $(el);
      if (e.closest('[class*="staff"], [id*="staff"], [id*="coach"]').length) return;
      const name = squash(e.find('.s-person-details__personal-single-line, h3').first().text());
      const bio = e.find('.s-person-details__bio-stats-item').map((i, x) => squash($(x).text())).get();
      const pick = (re) => (bio.find((b) => re.test(b)) || '').replace(re, '').trim();
      out.push({ name, jersey: squash(e.find('.s-stamp__text').first().text()),
        position: pick(/^position\s*/i), year: pick(/^academic year\s*/i), height: pick(/^height\s*/i),
        hometown: squash(e.find('.s-person-card__content__person__location-item').first().text()), highSchool: '' });
    });
  }
  // Presto and anything else: a table with a Name column. A staff table has
  // a Title column and no position or year: skipped.
  if (!out.length) {
    $('table').each((_, tbl) => {
      const t = $(tbl);
      const heads = t.find('thead th, tr:first-child th, tr:first-child td').map((i, h) => lc(squash($(h).text()))).get();
      const at = (re) => heads.findIndex((h) => re.test(h));
      const iName = at(/^(full )?name$|^player$/);
      if (iName < 0) return;
      const iPos = at(/^(pos|pos\.|position)$/), iYr = at(/^(yr|yr\.|year|cl|cl\.|class|elig)/), iTitle = at(/^title$/);
      if (iTitle >= 0 && iPos < 0 && iYr < 0) return;
      const caption = lc(t.find('caption').text() + ' ' + (t.attr('class') || '') + ' ' + t.prevAll('h2,h3').first().text());
      if (/coach|staff/.test(caption) && iPos < 0 && iYr < 0) return;
      const iNo = at(/^(no|no\.|#|num|number|jersey)$/), iHt = at(/^(ht|ht\.|height)$/);
      const iHome = at(/hometown/), iHs = at(/high school|previous school|last school|prev/);
      t.find('tbody tr, tr').each((j, tr) => {
        const cells = $(tr).find('td, th');
        if (!cells.length || $(tr).find('th').length === cells.length) return;
        const cell = (i) => (i >= 0 && cells.eq(i).length ? squash(cells.eq(i).text()) : '');
        let name = cell(iName);
        // Presto writes "Last, First" in some layouts.
        if (/^[^,]+,\s*[^,]+$/.test(name)) name = name.replace(/^([^,]+),\s*(.+)$/, '$2 $1');
        let home = cell(iHome), hs = cell(iHs);
        if (iHome >= 0 && iHome === iHs && home.includes('/')) { const [h, s] = home.split('/'); home = squash(h); hs = squash(s); }
        out.push({ name, jersey: cell(iNo), position: cell(iPos), year: cell(iYr), height: cell(iHt), hometown: home, highSchool: hs });
      });
    });
  }
  const seen = new Set();
  return out.map((p) => ({ ...p, name: squash(p.name.replace(/\s*\(.*?\)\s*/g, ' ')) }))
    .filter((p) => NAME_OK(p.name) && !seen.has(lc(p.name)) && seen.add(lc(p.name)));
}

// ── WRITE ───────────────────────────────────────────────────────────────────
async function ensureColumns(pool) {
  await pool.query(`ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS source TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS roster_url TEXT`).catch(() => {});
  await pool.query(`ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS roster_imported_at TIMESTAMPTZ`).catch(() => {});
}

async function importRosters(pool, { universityId, siteUrl, now } = {}, deps = {}) {
  const uni = (await pool.query(`SELECT id, name, location FROM universities WHERE id = $1`, [universityId])).rows[0];
  if (!uni) return { ok: false, error: `No university "${universityId}".` };
  let site;
  try { site = new URL(/^https?:\/\//i.test(siteUrl) ? siteUrl : 'https://' + siteUrl); } catch (_) { return { ok: false, error: 'That is not a site URL.' }; }
  await ensureColumns(pool);
  const marketKey = require('./regionKey').marketPoolKey(uni.location || '') || null;
  const home = await getPage(site.href, deps);
  if (!home.ok) return { ok: false, error: `Could not read ${site.href}: ${home.error || 'HTTP ' + home.status}` };
  const found = discoverTeams(home.text, home.url || site.href);
  if (!found.length) return { ok: false, error: `No /sports/<team> links on ${site.href}; is this the athletics site?` };
  const existing = (await pool.query(`SELECT id, name FROM university_teams WHERE university_id = $1`, [uni.id])).rows;
  const teams = [], skipped = [];
  let athletes = 0;
  for (const t of found) {
    let roster = null, tried = [];
    const urls = (t.codes || [t.code]).flatMap((code) => rosterUrls(site.href, { ...t, code }, now));
    for (const url of urls) {
      const r = await getPage(url, deps);
      tried.push(`${url} (${r.ok ? r.status : (r.error || r.status)})`);
      if (!r.ok) continue;
      const players = parseRoster(r.text);
      if (players.length) { roster = { url: r.url || url, players }; break; }
    }
    if (!roster) { skipped.push({ name: t.name, code: t.code, why: 'no roster with players found', tried }); continue; }
    // The same team already on file under any spelling (teamNames.teamKey).
    const TN = require('./teamNames');
    const same = existing.find((e) => TN.teamKey(e.name) === TN.teamKey(t.name));
    const teamId = same ? same.id : `${uni.id}:${t.code}`;
    await pool.query(
      `INSERT INTO university_teams (id, university_id, name, sport, season, roster_size, market_key, source, roster_url, roster_imported_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'roster-import',$8,NOW())
       ON CONFLICT (id) DO UPDATE SET roster_size = EXCLUDED.roster_size, roster_url = EXCLUDED.roster_url,
         roster_imported_at = NOW(), market_key = COALESCE(university_teams.market_key, EXCLUDED.market_key),
         source = COALESCE(university_teams.source, EXCLUDED.source), updated_at = NOW()`,
      [teamId, uni.id, t.name, sportOf(t.name), seasonOf(t.name), roster.players.length, marketKey, roster.url]);
    for (const p of roster.players) {
      const parts = p.name.split(/\s+/);
      await pool.query(
        `INSERT INTO university_athletes (id, university_id, first_name, last_name, name, sport, position, year, jersey_number, source, data, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'roster-import',$10,NOW())
         ON CONFLICT (id) DO UPDATE SET position = EXCLUDED.position, year = EXCLUDED.year, jersey_number = EXCLUDED.jersey_number,
           sport = EXCLUDED.sport, data = EXCLUDED.data, updated_at = NOW()`,
        [`${teamId}:${slug(p.name)}`, uni.id, parts[0], parts.slice(1).join(' '), p.name, t.name, p.position || null, p.year || null,
          p.jersey || null, JSON.stringify({ teamId, team: t.name, hometown: p.hometown || null, highSchool: p.highSchool || null, height: p.height || null, rosterUrl: roster.url })]);
    }
    athletes += roster.players.length;
    teams.push({ id: teamId, name: t.name, season: seasonOf(t.name), athletes: roster.players.length, url: roster.url, reused: !!same });
  }
  console.log(`[roster-import] ${uni.name}: ${teams.length} team(s), ${athletes} athlete(s) from ${site.host}; ${skipped.length} skipped`);
  return { ok: true, university: uni.name, universityId: uni.id, site: site.href, teams, athletes, skipped,
    teamCount: teams.length, sportsOnSite: found.length };
}

module.exports = { importRosters, discoverTeams, parseRoster, rosterUrls, bestName, seasonOf, sportOf, ensureColumns };
