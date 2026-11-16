'use strict';
// Runs against the local test Postgres.
//
//   node tests/universitytoday.js
//
// ── TODAY AND IN PROGRESS (services/universityToday) ────────────────────────
// The university portal's home screen and its deal board, built only from the
// department's own tables. Fictional names only.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('universitytodaytest', { schema: true });
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = require(REPO + 'server/store.js').pool;
  const UT = require(REPO + 'server/services/universityToday.js');
  await require(REPO + 'server/services/campusPool').ensureTables(P);
  await require(REPO + 'server/services/teamScan').ensureTables(P);

  // ── AN EMPTY DEPARTMENT ────────────────────────────────────────────────
  await P.query(`INSERT INTO universities (id, name, short_name, location) VALUES ('univ-pine','Pinecrest State University','Pinecrest','Pinecrest, GA'), ('univ-else','Elsewhere College','Elsewhere','Elsewhere, GA')`);
  const empty = await UT.today(P, 'univ-pine');
  ok('an empty department: no leads, no deals, nothing waiting', empty.leads.waiting === 0 && empty.deals.count === 0 && empty.replies.length === 0 && empty.teams.length === 0, empty);
  const emptyP = await UT.progress(P, 'univ-pine');
  ok('  and an empty board with the four stages', emptyP.stages.map((s) => s.key).join(',') === 'contacted,replied,in_talks,deal_signed' && emptyP.stages.every((s) => s.total === 0) && emptyP.deals.length === 0, emptyP);

  // ── A DEPARTMENT WITH A NIGHT OF PITCHES, REPLIES AND DEALS ─────────────
  const team = (id, uni, name, n) => P.query(`INSERT INTO university_teams (id, university_id, name, sport, roster_size) VALUES ($1,$2,$3,$3,$4)`, [id, uni, name, n]);
  await team('t-vb', 'univ-pine', "Women's Volleyball", 17);
  await team('t-bb', 'univ-pine', 'Baseball', 36);
  await team('t-golf', 'univ-pine', "Women's Golf", 9);
  await team('t-x', 'univ-else', 'Football', 100);
  const draft = (id, uni, teamId, brand, night, sentAt) => P.query(
    `INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, subject, body, kind, night, sent_at, status)
     VALUES ($1,$2,$3,$4,$5,'A team idea','Hi there',$6,$7,$8,'awaiting_approval')`, [id, uni, teamId, brand.toLowerCase(), brand, 'pitch', night, sentAt]);
  await draft('d0', 'univ-pine', 't-vb', 'Old Night Dental', '2026-11-01', null);
  await draft('d1', 'univ-pine', 't-vb', 'Harbor Lane Dental', '2026-11-16', null);
  await draft('d2', 'univ-pine', 't-bb', 'Riverside Motors', '2026-11-16', null);
  await draft('d3', 'univ-pine', 't-bb', 'Corner Grill', '2026-11-16', '2026-11-16T15:00:00Z');
  await draft('d4', 'univ-pine', 't-golf', 'Fairway Shop', '2026-11-16', null);
  await draft('dx', 'univ-else', 't-x', 'Elsewhere Tires', '2026-11-16', null);
  const crm = (uni, brand, stage, at) => P.query(`INSERT INTO university_crm (university_id, brand, stage, last_touch_at) VALUES ($1,$2,$3,$4)`, [uni, brand, stage, at]);
  await crm('univ-pine', 'Fairway Shop', 'contacted', '2026-11-16T16:00:00Z');   // pitched by phone, card not marked sent
  await crm('univ-pine', 'Corner Grill', 'contacted', '2026-11-01T16:00:00Z');
  await crm('univ-pine', 'Magnolia Coffee', 'replied', '2026-11-15T16:00:00Z');
  await crm('univ-pine', 'Coastal Therapy', 'in_talks', '2026-11-14T16:00:00Z');
  await crm('univ-pine', 'Riverside Ford', 'deal_signed', '2026-11-10T16:00:00Z');
  await crm('univ-pine', 'Nope Pizza', 'declined', '2026-11-09T16:00:00Z');
  await crm('univ-else', 'Elsewhere Tires', 'replied', '2026-11-16T16:00:00Z');
  const touch = (uni, brand, dir, summary, teamId) => P.query(
    `INSERT INTO university_touches (university_id, brand, direction, channel, summary, team_id) VALUES ($1,$2,$3,'email',$4,$5)`, [uni, brand, dir, summary, teamId]);
  await touch('univ-pine', 'Magnolia Coffee', 'out', 'Pitched by email', 't-vb');
  await touch('univ-pine', 'Magnolia Coffee', 'in', 'Wants a soccer player from town', null);
  await touch('univ-pine', 'Coastal Therapy', 'out', 'Sent team post idea', 't-vb');
  await touch('univ-else', 'Elsewhere Tires', 'in', 'Other school reply', 't-x');
  const deal = (uni, brand, teamId, athlete, cents, on) => P.query(
    `INSERT INTO university_deals (university_id, brand, team_id, athlete_name, value_cents, description, signed_on) VALUES ($1,$2,$3,$4,$5,'Team appearance',$6)`, [uni, brand, teamId, athlete, cents, on]);
  const thisMonth = new Date(); const ym = thisMonth.toISOString().slice(0, 8) + '05';
  await deal('univ-pine', 'Riverside Ford', 't-bb', null, 540000, ym);
  await deal('univ-pine', 'Harbor Lane Dental', 't-vb', 'Riley Stone', 40000, '2025-10-01');
  await deal('univ-else', 'Elsewhere Tires', 't-x', null, 999900, ym);

  const T = await UT.today(P, 'univ-pine');
  ok('leads: the latest night only, 4 pitches across 3 teams', T.leads.night && String(T.leads.night.toISOString ? T.leads.night.toISOString() : T.leads.night).slice(0, 10) === '2026-11-16' && T.leads.total === 4 && T.leads.teams === 3, T.leads);
  ok('  waiting = not sent and the business not already pitched another way (2: Harbor Lane, Riverside Motors)', T.leads.waiting === 2, T.leads);
  ok('pipeline counts by stage', T.pipeline.contacted === 2 && T.pipeline.replied === 1 && T.pipeline.inTalks === 1 && T.pipeline.dealSigned === 1 && T.pipeline.declined === 1, T.pipeline);
  ok('replies: replied and working out terms, newest first', T.replies.map((r) => r.brand).join('|') === 'Magnolia Coffee|Coastal Therapy', T.replies);
  ok('  with what they said (their own words first) and the team', T.replies[0].said === 'Wants a soccer player from town' && T.replies[0].team === "Women's Volleyball" && T.replies[0].stageLabel === 'Replied', T.replies[0]);
  ok('deals: count, total, this month, athletes named', T.deals.count === 2 && T.deals.cents === 580000 && T.deals.monthCount === 1 && T.deals.monthCents === 540000 && T.deals.athletes === 1, T.deals);
  ok('teams: fewest deals first, then the biggest roster', T.teams.map((t) => t.name).join('|') === "Women's Golf|Baseball|Women's Volleyball", T.teams.map((t) => [t.name, t.deals, t.athletes]));
  ok('  each with how many pitches still wait', T.teams.find((t) => t.name === 'Baseball').waiting === 1 && T.teams.find((t) => t.name === "Women's Golf").waiting === 1, T.teams);
  ok('nothing from the other university', !JSON.stringify(T).includes('Elsewhere') && T.deals.cents < 999900);

  const PR = await UT.progress(P, 'univ-pine');
  const st = (k) => PR.stages.find((s) => s.key === k);
  ok('board: each business in its stage', st('contacted').total === 2 && st('replied').rows[0].brand === 'Magnolia Coffee' && st('in_talks').rows[0].brand === 'Coastal Therapy' && st('deal_signed').rows[0].brand === 'Riverside Ford', PR.stages);
  ok('  declined is left off the board', !PR.stages.some((s) => s.key === 'declined'));
  ok('  a pitch quiet for 7+ days says how long', st('contacted').rows.find((r) => r.brand === 'Corner Grill').daysQuiet >= 7);
  ok('  last touch and team on the card', st('in_talks').rows[0].last === 'Sent team post idea' && st('in_talks').rows[0].team === "Women's Volleyball", st('in_talks').rows[0]);
  ok('deals, newest first, with team or athlete', PR.deals.map((d) => d.brand).join('|') === 'Riverside Ford|Harbor Lane Dental' && PR.deals[1].athlete === 'Riley Stone' && PR.deals[0].team === 'Baseball', PR.deals);
  ok('  nothing from the other university', !JSON.stringify(PR).includes('Elsewhere'));

  // ── ROUTES, THE WALL, THE PAGE ─────────────────────────────────────────
  const campus = fs.readFileSync(REPO + 'server/routes/campus.js', 'utf8');
  ok('routes behind the staff guard, scoped by the session', /app\.get\('\/api\/university\/market\/today', guard/.test(campus) && /app\.get\('\/api\/university\/market\/progress', guard/.test(campus)
    && /UT\.today\(pool, req\.staff\.university_id\)/.test(campus) && /UT\.progress\(pool, req\.staff\.university_id\)/.test(campus));
  const MG = require(REPO + 'server/middleware/modeGuard.js');
  ok('the wall lets a university session reach them (under /market/)', MG.allowedForUniversity('GET /api/university/market/today') && MG.allowedForUniversity('GET /api/university/market/progress'));
  const page = fs.readFileSync(REPO + 'public/university.html', 'utf8');
  ok('the portal opens on Today, with Approve, Athlete Deals and In progress', /let view = "today";/.test(page)
    && /\["today","Today"\], \["home","Approve"\], \["athletes","Athlete Deals"\], \["progress","In progress"\]/.test(page)
    && /today:vToday, home:vHome, athletes:vAthletes, progress:vProgress/.test(page));
  ok('  the menu highlights the open screen', /class="\$\{id===view\?"on active":""\}"/.test(page));
  ok('  Today and In progress read their routes', /getJson\("\/api\/university\/market\/today"\)/.test(page) && /getJson\("\/api\/university\/market\/progress"\)/.test(page));
  ok('  viewing as admin shows no move buttons', /nx && !\(ME && ME\.me && ME\.me\.viewingAsAdmin\)/.test(page));
  ok('  says NILDash never signs or negotiates', /NILDash never signs or negotiates for anyone/.test(page));
  ok('no em dashes in the new screens', !/[—]/.test(page.slice(page.indexOf('/* ===================== TODAY'), page.indexOf('/* ===================== ATHLETE DEALS'))));
  const svc = fs.readFileSync(REPO + 'server/services/universityToday.js', 'utf8');
  const sqlTables = [...svc.replace(/\/\/.*$/gm, '').matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+)/gi)].map((m) => m[1].toLowerCase());
  ok('only university tables in its SQL', sqlTables.every((t) => /^university_|^universities$/.test(t)), [...new Set(sqlTables)]);
  ok('reads only: no INSERT, UPDATE or DELETE', !/\b(INSERT|UPDATE|DELETE)\b/.test(svc.replace(/\/\/.*$/gm, '')));

  console.log(OUT.join('\n'));
  console.log(`\n${OUT.length - F}/${OUT.length} passed`);
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
