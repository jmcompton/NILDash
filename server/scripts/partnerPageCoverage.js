'use strict';
// ── DOES A SCHOOL PARTNER PAGE EXIST? MEASURE BEFORE BUILDING. ───────────────
//
// This answers ONE question: what share of the schools actually on our roster
// have a findable athletics partner/sponsor listing page. It does not scrape
// partners, does not write anything, and is not wired into any job. If the
// answer is 20%, the scrape is not worth building, and that is the point of
// running this first.
//
//   node server/scripts/partnerPageCoverage.js            # roster schools
//   node server/scripts/partnerPageCoverage.js --limit 40
//   node server/scripts/partnerPageCoverage.js --json out.json
//
// WHY IT COULD NOT BE RUN WHERE IT WAS WRITTEN: the development sandbox's egress
// proxy denies outbound HTTP to everything (example.com returns 403 the same as
// auburntigers.com), so no measurement taken there would mean anything. Run this
// from an environment that can reach the open web.
//
// WHAT COUNTS AS FOUND, and why the bar is not "the URL returned 200":
// Sidearm Sports runs the sites for ~800 NCAA programs and serves a soft 200
// with a styled "page not found" for unknown paths, so status alone proves
// nothing. A page counts only if it is large enough to be real AND either says
// something a partner index says, or carries enough images to be a logo wall.
// The check is deliberately strict: over-reporting coverage here would send us
// off to build a scrape against pages that do not exist.

const store = require('../store');

const PATHS = [
  '/sponsors', '/corporate-partners', '/partners', '/sponsorship',
  '/our-partners', '/corporate-sponsors', '/sponsors/index', '/corporate-partnerships',
];
const TIMEOUT_MS = 10000;
const PARTNER_WORDS = /official (partner|sponsor)|corporate partner|proud (partner|sponsor)|our partners|partner with (us|auburn|the)|sponsorship opportunit/i;
const NOT_FOUND_WORDS = /page not found|404 error|we can'?t find|does not exist/i;

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? (process.argv[i + 1] || true) : dflt;
}

// The athletics host, from what program_source already holds. staff_url is the
// staff directory on the athletics domain, which is the only athletics URL we
// hold for most schools -- athletics_contact_url is a CONTACT page and is often
// null. Neither is a partner page; both give us the host to look on.
function hostFrom(row) {
  const u = row.staff_url || row.athletics_contact_url;
  if (!u) return null;
  try { return new URL(u).origin; } catch (_) { return null; }
}

async function look(url) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: c.signal, redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NILDash-coverage/1.0)' } });
    clearTimeout(t);
    if (!r.ok) return { ok: false, status: r.status };
    const html = await r.text();
    if (NOT_FOUND_WORDS.test(html.slice(0, 6000))) return { ok: false, status: 'soft-404' };
    const imgs = (html.match(/<img[^>]+>/gi) || []).length;
    const links = (html.match(/<a[^>]+href="https?:\/\/(?!(?:www\.)?[a-z]*\.?edu)/gi) || []).length;
    const words = PARTNER_WORDS.test(html);
    // Real page, and it looks like a partner index rather than merely resolving.
    const looksRight = html.length > 8000 && (words || imgs >= 15 || links >= 25);
    return { ok: looksRight, status: r.status, bytes: html.length, imgs, links, words, finalUrl: r.url };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, status: e.name === 'AbortError' ? 'timeout' : (e.message || 'error').slice(0, 60) };
  }
}

async function main() {
  const limit = Number(arg('limit', 0)) || 0;
  // THE ROSTER, not a convenient sample. The question is about the schools we
  // actually have athletes at, and a curated list would answer a different one.
  const rows = (await store.pool.query(
    `SELECT s.school, COUNT(DISTINCT a.id)::int AS athletes,
            MAX(ps.staff_url) AS staff_url, MAX(ps.athletics_contact_url) AS athletics_contact_url
       FROM (SELECT DISTINCT TRIM(data->>'school') AS school FROM athletes
              WHERE COALESCE(TRIM(data->>'school'),'') <> '') s
       LEFT JOIN athletes a ON TRIM(a.data->>'school') = s.school
       LEFT JOIN program_source ps ON LOWER(ps.school) = LOWER(s.school)
      GROUP BY s.school
      ORDER BY athletes DESC`)).rows;

  const list = limit ? rows.slice(0, limit) : rows;
  console.log(`${rows.length} distinct school(s) on the roster; probing ${list.length}.\n`);

  const out = { total: list.length, noHost: 0, found: 0, notFound: 0, rows: [] };
  for (const row of list) {
    const host = hostFrom(row);
    if (!host) {
      out.noHost++;
      out.rows.push({ school: row.school, athletes: row.athletes, result: 'no athletics url on file' });
      console.log(String(row.school).slice(0, 34).padEnd(36) + `(${row.athletes})`.padEnd(6)
        + 'NO ATHLETICS URL ON FILE');
      continue;
    }
    let hit = null;
    for (const p of PATHS) {
      const r = await look(host + p);
      if (r.ok) { hit = Object.assign({ path: p }, r); break; }
    }
    if (hit) out.found++; else out.notFound++;
    out.rows.push({ school: row.school, athletes: row.athletes, host,
      result: hit ? 'found' : 'not found', path: hit ? hit.path : null,
      imgs: hit ? hit.imgs : null, words: hit ? hit.words : null });
    console.log(String(row.school).slice(0, 34).padEnd(36) + `(${row.athletes})`.padEnd(6)
      + (hit ? `FOUND ${hit.path}  imgs=${hit.imgs} links=${hit.links} kw=${hit.words}` : 'not found'));
  }

  const pct = (n) => (out.total ? Math.round((n / out.total) * 100) : 0);
  console.log('\n' + '='.repeat(64));
  console.log(`findable partner page : ${out.found}/${out.total}  (${pct(out.found)}%)`);
  console.log(`no page found         : ${out.notFound}/${out.total}  (${pct(out.notFound)}%)`);
  console.log(`no athletics url held : ${out.noHost}/${out.total}  (${pct(out.noHost)}%)`);
  console.log('='.repeat(64));
  console.log('\nThe last line is a ceiling, not a gap to ignore: a school whose athletics');
  console.log('URL we do not hold cannot be probed at all, so real coverage is at best');
  console.log(`${pct(out.found)}% and at worst that same figure with the ${pct(out.noHost)}% never resolving.`);

  const jsonPath = arg('json', null);
  if (jsonPath && typeof jsonPath === 'string') {
    require('fs').writeFileSync(jsonPath, JSON.stringify(out, null, 2));
    console.log('\nwrote ' + jsonPath);
  }
  await store.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
