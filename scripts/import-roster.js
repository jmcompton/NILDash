#!/usr/bin/env node
'use strict';
// ── CREATE AGENT-MANAGED ATHLETES FROM A ROSTER CSV, FOR ONE AGENT ───────────
//
//   node scripts/import-roster.js --agent pliablemarketing@gmail.com --file ~/Desktop/greg-roster.csv
//   node scripts/import-roster.js --agent ... --file ... --cities "Caleb Manuel=Portland, ME; Kaylee Sakoda=Honolulu, HI"
//   node scripts/import-roster.js --agent ... --file ... --commit
//
// A DRY RUN BY DEFAULT. Without --commit nothing is written: every row is
// printed as it would be created, and every row that would be skipped is
// listed with the reason. --commit writes the athletes, stamps the agent's
// last login (an import is the agent at work, so the nightly skip lifts),
// and starts an on-demand fill for each new athlete in turn.
//
// The CSV lives wherever the agent keeps it; it is never in the repository.
// Columns: First, Last, Sport, School/Affiliation, Total followers,
// Instagram handle, Instagram followers, TikTok handle, TikTok followers.
// An optional City column fills in the town for a row with no school or team.
// The parsing lives in server/services/rosterImport.js so an upload button
// can reuse it.
//
// HOW A ROW BECOMES A RECORD
//   already on the roster   same first and last name as an athlete on this
//                           agent's account -> skipped
//   a school                a college athlete; the market is the school's
//                           town (known now, or geocoded on the first run)
//   a pro team              a pro athlete; the pro lookup (the same one the
//                           form's AI Lookup runs) finds the team's city
//   neither                 "Professional Golfer", "Team USA": nothing to
//                           place them by. A city from --cities or a City
//                           column makes them a pro in that town; otherwise
//                           skipped and listed
//
// Flags:  --cities "First Last=City, ST; ..."   towns for rows with no school or team
//         --tier <value>      school tier for college rows (default mid-mid)
//         --no-lookup         do not run the pro lookup (team rows then need --cities)
//         --no-fill           with --commit: create the athletes but do not fill
//         --commit            write
//
// Needs DATABASE_URL (or PG*), and for the pro lookup and the fills the same
// keys the server uses: ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY.

const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const RI = require('../server/services/rosterImport');
const { placeRow, recordFor } = RI;
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 4000;

process.exitCode = 1;
let settled = false;
process.on('beforeExit', () => { if (!settled) { console.log('import-roster: main() never settled. Exiting 1.'); process.exit(1); } });
function fail(where, e) { const m = `import-roster: FAILED (${where}): ${e && e.message ? e.message : e}`; console.log(m); console.error(m); settled = true; process.exit(1); }
function done(code) { settled = true; process.exit(code); }
function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i >= 0 && process.argv[i + 1] !== undefined && !/^--/.test(process.argv[i + 1]) ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes('--' + name); }
function target() {
  const url = process.env.DATABASE_URL;
  if (url) { try { const u = new URL(url); return `DATABASE_URL -> ${u.hostname}${u.pathname} (ssl)`; } catch (_) { return 'DATABASE_URL'; } }
  return `PG* env -> ${process.env.PGHOST || 'localhost'}:${process.env.PGPORT || '5432'}`;
}
const pad = (s, n) => String(s === null || s === undefined ? '' : s).padEnd(n);

// The seat rule is the server's (services/seats): the plan's limit unless an
// admin set an override for this account, so the import cannot seat what the
// form would not.
const Seats = require('../server/services/seats');

function printPlaced(p) {
  const who = `${p.name}`;
  const what = p.athleteType === 'pro'
    ? `PRO      ${p.sport.padEnd(16)} ${p.team || '(no team)'}  in ${p.market}  [${p.marketNote}]`
    : `COLLEGE  ${p.sport.padEnd(16)} ${p.school}  market ${p.market || '(geocoded on first run)'}`;
  const social = [
    p.instagramHandle ? `IG @${p.instagramHandle} ${p.instagram || '?'}` : 'IG none',
    p.instagramHandleAlt ? `(alt @${p.instagramHandleAlt} ${p.instagramAlt || '?'})` : '',
    p.tiktokHandle ? `TT @${p.tiktokHandle} ${p.tiktok || '?'}` : 'TT none',
    p.tiktokHandleAlt ? `(alt @${p.tiktokHandleAlt} ${p.tiktokAlt || '?'})` : '',
  ].filter(Boolean).join('  ');
  console.log(`  line ${String(p.line).padStart(3)}  ${pad(who, 22)} ${what}`);
  console.log(`            ${''.padEnd(22)} ${social}`);
  for (const n of p.notes) console.log(`            ${''.padEnd(22)} note: ${n}`);
}

async function main() {
  const who = arg('agent', null);
  const file = arg('file', null);
  if (!who || !file) return fail('args', new Error('give --agent <email or id> and --file <path to the CSV>'));
  const commit = flag('commit');
  const noLookup = flag('no-lookup');
  const noFill = flag('no-fill');
  const tier = arg('tier', 'mid-mid');
  const cities = RI.parseCities(arg('cities', ''));

  let text;
  try { text = fs.readFileSync(path.resolve(file), 'utf8'); } catch (e) { return fail('file', e); }
  const parsed = RI.parseRoster(text, { cities });
  if (!parsed.rows.length) return fail('file', new Error('no data rows in ' + file));
  const missing = ['first', 'last', 'sport'].filter((k) => parsed.columns[k] === undefined && parsed.columns.name === undefined);
  if (missing.length) return fail('columns', new Error(`the header has no ${missing.join(', ')} column; found: ${Object.keys(parsed.columns).join(', ') || 'nothing recognisable'}`));

  console.log(`import-roster: ${commit ? 'COMMIT' : 'DRY RUN'}  agent=${who}  file=${file}  rows=${parsed.rows.length}  via ${target()}`);
  console.log(`   columns recognised: ${Object.keys(parsed.columns).join(', ')}`);
  if (Object.keys(cities).length) console.log(`   --cities: ${Object.entries(cities).map(([k, v]) => k + ' -> ' + v).join('; ')}`);
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;

  let u;
  try {
    u = (await P.query(`SELECT id, name, email, role, archived, last_login, plan, plan_tier, seat_override FROM users
                         WHERE id = $1 OR LOWER(TRIM(email)) = LOWER(TRIM($1)) LIMIT 1`, [who])).rows[0];
  } catch (e) { return fail('user', e); }
  if (!u) return fail('user', new Error(`no user matches "${who}"`));
  if (!['agent', 'admin'].includes(u.role)) return fail('user', new Error(`${u.email} is role=${u.role}; only an agent or admin can hold athletes`));
  const existingRows = (await P.query(`SELECT id, data->>'name' AS name FROM athletes WHERE agent_id = $1 ORDER BY created_at`, [u.id])).rows;
  const existing = existingRows.map((r) => r.name || '');
  const lastLoginDays = u.last_login ? Math.floor((Date.now() - new Date(u.last_login).getTime()) / 86400000) : null;
  console.log(`\nAGENT ${u.email} (${u.id})  ${u.name || ''}  role=${u.role}  plan=${u.plan_tier || u.plan || 'basic'}  athletes now=${existing.length}  last login ${lastLoginDays === null ? 'never' : lastLoginDays + 'd ago'}`);
  console.log(`   on the roster: ${existing.join(', ') || '(none)'}`);

  // The lookups, injected. The school map is instant and offline; the pro
  // lookup is a web search and costs a few cents a row.
  let ai = null, AL = null;
  try { ai = require('../server/ai'); } catch (e) { console.log(`   (server/ai unavailable: ${e.message}; school markets will show as geocoded-later)`); }
  try { AL = require('../server/services/athleteLookup'); } catch (e) { console.log(`   (athleteLookup unavailable: ${e.message})`); }
  const wantLookup = !noLookup && parsed.rows.some((r) => r.affiliationKind === 'team' && !r.city && !r.problems.length);
  if (wantLookup && !process.env.ANTHROPIC_API_KEY) console.log('   WARNING: ANTHROPIC_API_KEY is not set; the pro lookup will fail and team rows will be skipped');
  const ctx = {
    existing,
    existingName: (n) => existing.find((x) => RI.sameName(x, n)) || n,
    // The resolver the nightly job uses: case, spacing, aliases and one-typo
    // matches with a floor, never a guess between two schools.
    schoolLocation: (() => { try { return require('../server/services/schoolResolver').resolveSchool; } catch (_) { return ai && ai.lookupSchoolLocation ? ai.lookupSchoolLocation : null; } })(),
    proLookup: (!noLookup && AL && ai) ? (q) => AL.resolveAthlete(ai, q) : null,
    nameScore: AL ? AL.nameMatchScore : (a, b) => (RI.sameName(a, b) ? 35 : 0),
  };

  const placed = [], skipped = [];
  const seen = [];
  for (const row of parsed.rows) {
    // A name twice in the file is created once.
    if (seen.some((n) => RI.sameName(n, row.name))) { skipped.push({ ...row, skip: 'listed twice in the file; the first row is used' }); continue; }
    seen.push(row.name);
    if (row.affiliationKind === 'team' && !row.city && ctx.proLookup) console.log(`   looking up ${row.name} on ${row.affiliation}...`);
    const p = await placeRow(row, ctx);
    if (p.skip) skipped.push(p); else placed.push(p);
  }

  console.log(`\nWOULD CREATE ${placed.length}`);
  for (const p of placed) printPlaced(p);
  console.log(`\nSKIPPED ${skipped.length}`);
  for (const s of skipped) console.log(`  line ${String(s.line).padStart(3)}  ${pad(s.name || '(no name)', 22)} ${s.skip}`);

  const seats = Seats.seatLimitFor(u);
  const limit = seats.limit;
  const after = existing.length + placed.length;
  console.log(`\nSEATS  ${existing.length} now + ${placed.length} new = ${after}${limit === null ? ' (no limit: ' + seats.source + ')' : ' of ' + Seats.describeSeats(seats)}`);
  if (limit !== null && after > limit) {
    console.log(`   over the limit by ${after - limit}. The form would refuse these; so does this. ${seats.source === 'override' ? 'Raise the override on the admin page' : 'Raise the plan, or set a seat override on the admin page,'} or trim the file.`);
    if (commit) return done(1);
  }

  if (!commit) {
    console.log(`\nDry run: nothing written. Re-run with --commit to create the ${placed.length} above.`);
    return done(0);
  }
  if (!placed.length) { console.log('\nNothing to create.'); return done(0); }

  // ── WRITE ───────────────────────────────────────────────────────────────
  const created = [];
  const base = Date.now();
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const id = 'ath-' + (base + i);
    try {
      const rec = recordFor(p, u.id, id, { tier });
      await store.saveAthlete(id, rec);
      created.push({ id, p });
      console.log(`  created ${id}  ${p.name}  (${rec.athleteType}${rec.athleteType === 'pro' ? ', ' + rec.city : ', ' + rec.school})`);
    } catch (e) {
      console.log(`  FAILED  ${p.name}: ${e.message}`);
    }
  }
  // An import is the agent at work: the dormant clock resets so tonight's
  // run does not skip them, and the Getting Started checklist ticks.
  await P.query('UPDATE users SET last_login = NOW() WHERE id = $1', [u.id]).catch((e) => console.log(`  (last_login not updated: ${e.message})`));
  if (store.markChecklistItem) await store.markChecklistItem(u.id, 'add_athlete').catch(() => {});
  console.log(`\nCREATED ${created.length} of ${placed.length}. last_login set to now for ${u.email}.`);

  if (noFill) { console.log('--no-fill: no on-demand fill started.'); return done(created.length === placed.length ? 0 : 1); }
  if (!created.length) return done(1);

  // ── FILL EACH NEW ATHLETE NOW, ONE AT A TIME ────────────────────────────
  // The same path the add-athlete form runs (fillOnDemand), claimed per
  // athlete per day, so a second --commit today does not run it twice.
  const job = require('../server/jobs/outreachQueue');
  if (!job.ENABLED) console.log('\nOUTREACH_QUEUE_ENABLED is not 1 in this environment; the fill runs anyway because you asked for it here.');
  for (const k of ['ANTHROPIC_API_KEY', 'GOOGLE_PLACES_API_KEY']) if (!process.env[k]) console.log(`   WARNING: ${k} is not set; the fill will find little or nothing`);
  console.log(`\nFILLING ${created.length} athlete(s) on demand...`);
  let totalFilled = 0, totalSpent = 0;
  for (const c of created) {
    const aths = await job.loadAthletesForQueue(P, u.id, c.id);
    if (!aths.length) { console.log(`  ${c.p.name}: row not found for the fill`); continue; }
    const t0 = Date.now();
    const r = await job.fillOnDemand(P, aths[0]).catch((e) => ({ filled: 0, spent: 0, error: e.message }));
    totalFilled += r.filled || 0; totalSpent += r.spent || 0;
    console.log(`  ${pad(c.p.name, 22)} filled=${r.filled || 0} spent=$${(r.spent || 0).toFixed(2)} took=${((Date.now() - t0) / 1000).toFixed(1)}s${r.claimed === false ? ' (already filled today)' : ''}${r.note ? '  ' + r.note : ''}${r.error ? '  ERROR ' + r.error : ''}`);
  }
  console.log(`\nFILLED ${totalFilled} card(s), spent $${totalSpent.toFixed(2)}. Home shows the cards for ${u.email} now; the nightly run takes it from here.`);
  done(created.length === placed.length ? 0 : 1);
}

module.exports = {};
if (require.main === module) main().catch((e) => fail('main', e));
