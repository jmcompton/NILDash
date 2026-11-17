'use strict';
// Runs against the local test Postgres. No network: search, page and model are stubs.
//
//   node tests/schoolsponsors.js
//
// ── WHO ALREADY PAYS THE PROGRAM (services/schoolSponsors) ──────────────────
// The athletics site's partners page, read into school_sponsors. Only names
// that are on the page; never the school itself; once per 60 days; only
// schools where an active agent has an athlete. Fictional names.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('schoolsponsorstest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

const PAGE = `<html><body><nav><a href="/">Home</a><a title="Tickets" href="/tickets">Tickets</a></nav>
<h1>Corporate Partners</h1>
<div class="grid">
  <a href="https://www.pinecrestford.example/" title="Pinecrest Ford"><img src="a.png" alt="Pinecrest Ford logo"></a>
  <a href="https://smiledental.example/"><img src="b.png" alt="Smile Dental Group"></a>
  <img src="c.png" alt="Main Street Coffee">
  <a href="https://www.facebook.com/pinecrestathletics"><img alt="Facebook"></a>
  <img src="d.png" alt="Pinecrest State University">
  <a href="https://www.learfield.com/"><img alt="Learfield"></a>
</div><footer>Privacy Policy</footer></body></html>`;

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const SS = require(REPO + 'server/services/schoolSponsors.js');
  await SS.ensureTables(P);
  await P.query(`INSERT INTO program_source (school, sport, staff_url) VALUES ('Pinecrest State University','football','https://pinecreststatesports.example/staff-directory')`);
  await P.query(`INSERT INTO users (id, name, email, password, role, comped) VALUES ('ss-a','Avery Stone','avery@ss.test','x','agent',TRUE), ('ss-b','Quiet Agent','quiet@ss.test','x','agent',TRUE)`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('ss-1','ss-a','{"name":"Jordan Lake","school":"Pinecrest State University"}'::jsonb),
    ('ss-2','ss-b','{"name":"Riley Moss","school":"Quiet College"}'::jsonb), ('ss-3','ss-a','{"name":"Sam Vale","school":"No Site U"}'::jsonb)`);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, status, sent_at, created_at) VALUES ('l1','ss-a','ss-1','X','sent',NOW() - INTERVAL '3 days',NOW())`);

  ok('the athletics site comes from the staff directory we already read', (await SS.athleticsHost(P, 'pinecrest state university')) === 'pinecreststatesports.example');
  const str = SS.strings(PAGE, 'pinecreststatesports.example');
  ok('page strings: logo alt text cleaned, social sites, vendors and menu words dropped',
    str.includes('Pinecrest Ford') && str.includes('Smile Dental Group') && str.includes('Main Street Coffee') && !str.includes('Facebook') && !str.includes('Privacy Policy') && !str.some((s) => /learfield/i.test(s)), str);

  const searches = [];
  const search = async (q) => { searches.push(q); if (/partnership|official partner/.test(q)) return [
    { title: 'Pinecrest Athletics, Baumhower\'s Victory Grille establish partnership', snippet: 'The restaurant becomes the official watch party home.', url: 'https://pinecreststatesports.example/news/2026/1/2/football-pinecrest-athletics-baumhowers-victory-grille-establish-partnership' },
    { title: 'Pinecrest Athletics extends multimedia rights partnership with Learfield', url: 'https://pinecreststatesports.example/news/2025/4/1/learfield-extension' },
    { title: 'Big win Saturday', url: 'https://pinecreststatesports.example/news/2026/1/3/big-win' },
    { title: 'Elsewhere partners with someone', url: 'https://other.example/news/x' }]; return [
    { title: 'Pinecrest State news: big win', url: 'https://pinecreststatesports.example/news/2026/1/1/win' },
    { title: 'Corporate Partners - Pinecrest State', url: 'https://pinecreststatesports.example/sports/2021/6/1/corporate-partners.aspx' },
    { title: 'Partners', url: 'https://someone-else.example/partners' }]; };
  const fetched = [];
  const fetchStub = async (u) => { fetched.push(u); return { ok: true, text: async () => PAGE }; };
  let sawList = null;
  let sawNews = null;
  const chat = async (o) => {
    const c = o.messages[0].content;
    if (/Headlines and summaries/.test(c)) { sawNews = c; return { text: JSON.stringify({ businesses: ['Baumhower\'s Victory Grille', 'Learfield', 'Made Up Corp', 'Pinecrest Athletics'] }) }; }
    sawList = c; return { text: JSON.stringify({ businesses: ['Pinecrest Ford', 'Smile Dental Group', 'Main Street Coffee', 'Pinecrest State University', 'Invented Bank'] }) }; };
  const r = await SS.refresh(P, 'Pinecrest State University', { search, chat, fetch: fetchStub });
  const names = (await P.query(`SELECT business FROM school_sponsors ORDER BY business`)).rows.map((x) => x.business);
  ok('refresh: only the school\'s own partners page is fetched', fetched.length === 1 && /corporate-partners/.test(fetched[0]), fetched);
  ok('  the names stored are the ones on the page or in an announcement; the school, a vendor and invented names are dropped',
    names.join('|') === 'Baumhower\'s Victory Grille|Main Street Coffee|Pinecrest Ford|Smile Dental Group' && r.found === 4, { names, r });
  ok('  announcements: only partnership stories on the school\'s own site, never the rights holder', /Victory Grille/.test(sawNews || '') && !/Learfield/.test(sawNews || '') && !/Big win/.test(sawNews || '') && !/Elsewhere/.test(sawNews || ''), sawNews);
  ok('  each name keeps the page it came from', /establish-partnership/.test((await P.query(`SELECT source_url FROM school_sponsors WHERE business LIKE 'Baumhower%'`)).rows[0].source_url));
  ok('  the model was handed the page strings', /Pinecrest Ford/.test(sawList || ''));
  const again = await SS.refresh(P, 'Pinecrest State University', { search, chat, fetch: fetchStub });
  ok('read once per 60 days', again.skipped === 'fresh' && fetched.length === 1);
  const none = await SS.refresh(P, 'No Site U', { search, chat, fetch: fetchStub });
  ok('no athletics site on file: nothing guessed, noted', none.found === 0 && /no athletics site/.test(none.note));
  const nothing = await SS.refresh(P, 'Pinecrest State University', { force: true, search: async () => [{ title: 'News', url: 'https://pinecreststatesports.example/news/x' }], chat, fetch: fetchStub });
  ok('nothing new found: noted, earlier names kept', /no partners page/.test(nothing.note) && nothing.found === 4, nothing);

  await P.query(`DELETE FROM school_sponsor_runs`);
  const due = await SS.dueSchools(P);
  ok('due: schools of agents who sent something in 30 days; a quiet agent\'s school waits', due.includes('Pinecrest State University') && due.includes('No Site U') && !due.includes('Quiet College'), due);
  await SS.refresh(P, 'Pinecrest State University', { search, chat, fetch: fetchStub });
  ok('  and a school read today is not due', !(await SS.dueSchools(P)).includes('Pinecrest State University'));

  const ov = await SS.overview(P);
  const html = SS.renderHtml(ov);
  ok('the admin page lists the school, the page and the names', /Pinecrest State University/.test(html) && /corporate-partners/.test(html) && /Smile Dental Group/.test(html) && !/<script/i.test(html));
  process.env.SCHOOL_SPONSORS_OFF = '1';
  ok('SCHOOL_SPONSORS_OFF=1 stops the job', (await SS.tick(P)).skipped === 'off');
  delete process.env.SCHOOL_SPONSORS_OFF;

  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('wired: the daily job, the admin page and the one-school refresh', /require\('\.\/services\/schoolSponsors'\)\.start\(store\.pool\)/.test(idx)
    && /app\.get\('\/admin\/school-sponsors'/.test(idx) && /app\.post\('\/api\/admin\/school-sponsors\/refresh'/.test(idx));
  const src = fs.readFileSync(REPO + 'server/services/schoolSponsors.js', 'utf8');
  ok('collects only: nothing in the scout or the writer reads it yet', !/schoolSponsors/.test(fs.readFileSync(REPO + 'server/services/scout.js', 'utf8')) && !/schoolSponsors/.test(fs.readFileSync(REPO + 'server/services/writerEvidence.js', 'utf8')));
  ok('no em dashes in the new copy', !/—/.test(src.replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.log(OUT.join('\n')); console.error(e); process.exit(1); });
