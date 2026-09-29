#!/usr/bin/env node
'use strict';
// ── SEED CYPRESS COLLEGE ────────────────────────────────────────────────────
//
//   node scripts/seed-cypress.js            write (idempotent)
//   node scripts/seed-cypress.js --dry-run  print what it would write
//
// A ONE-OFF, NOT A MIGRATION: migrations run on every boot for every tenant,
// and this is one tenant's data. Creates the Cypress College university row if
// it is absent, then its 13 teams and their sponsorship inventory.
//
// EVERY VALUE COMES FROM public/athletics.html, the signed-off demo. The TEAMS
// array and the ASSETS and DEPT_ASSETS price tables are read out of that file
// and evaluated as written, so nothing here is retyped and nothing can drift
// from the approved numbers. Prices there are whole dollars; stored as cents.
//
// SAFE TO RUN TWICE. Every row has a fixed id derived from the demo's own ids
// (univ-cypress:msoc, univ-cypress:msoc:1, univ-cypress:dept:1) and is written
// with ON CONFLICT DO NOTHING, so a second run adds nothing and never overwrites
// a price or a status someone has since changed in the portal.
//
// UNIVERSITY TABLES ONLY (see migrations/007). Nothing here touches athletes or
// any other agent table.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { Pool } = require('pg');

const REPO = path.join(__dirname, '..');
const DEMO = path.join(REPO, 'public', 'athletics.html');
const MIGRATION = path.join(REPO, 'server', 'migrations', '013_university_teams_inventory.sql');

const UNIVERSITY = {
  id: 'univ-cypress',
  name: 'Cypress College',
  short_name: 'Cypress',
  location: '9200 Valley View St, Cypress, CA 90630',
};

// Lift one top-level `const NAME = ...;` out of the demo and evaluate it alone.
function liftConst(src, name) {
  const start = src.indexOf('const ' + name + ' =');
  if (start < 0) throw new Error(`public/athletics.html has no "const ${name} ="`);
  let i = src.indexOf('=', start) + 1, depth = 0, inStr = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) break;
  }
  return vm.runInNewContext('(' + src.slice(src.indexOf('=', start) + 1, i) + ')', {}, { timeout: 1000 });
}

// The demo, read as data: teams, and inventory rows in the demo's own order
// (every team's ASSETS for its kind, then the department-wide items).
function readDemo(file) {
  const src = fs.readFileSync(file || DEMO, 'utf8');
  const TEAMS = liftConst(src, 'TEAMS');
  const ASSETS = liftConst(src, 'ASSETS');
  const DEPT_ASSETS = liftConst(src, 'DEPT_ASSETS');
  const marketKey = require(path.join(REPO, 'server', 'services', 'regionKey.js')).marketPoolKey(UNIVERSITY.location);
  const teams = TEAMS.map((t) => ({
    id: `${UNIVERSITY.id}:${t.id}`,
    name: t.name, sport: t.sport, season: t.season, roster_size: t.roster,
    venue: t.venue, home_dates: t.dates, market_key: marketKey,
  }));
  const inventory = [];
  TEAMS.forEach((t) => (ASSETS[t.kind] || []).forEach(([name, price], i) => inventory.push({
    id: `${UNIVERSITY.id}:${t.id}:${i + 1}`, team_id: `${UNIVERSITY.id}:${t.id}`, name, price_cents: Math.round(price * 100),
  })));
  DEPT_ASSETS.forEach(([name, price], i) => inventory.push({
    id: `${UNIVERSITY.id}:dept:${i + 1}`, team_id: null, name, price_cents: Math.round(price * 100),
  }));
  return { teams, inventory, marketKey };
}

// The migration's statements, so a seed run before the next boot still has its
// tables. Every one is IF NOT EXISTS.
function migrationStatements() {
  return fs.readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '')
    .split(';').map((s) => s.trim()).filter(Boolean);
}

async function seed(pool, opts = {}) {
  const { teams, inventory, marketKey } = readDemo(opts.demoFile);
  for (const stmt of migrationStatements()) await pool.query(stmt);
  const out = { university: 0, teams: 0, inventory: 0, marketKey, teamCount: teams.length, inventoryCount: inventory.length };
  // By id, or by name: migration 002 made universities.name UNIQUE on some
  // databases, so an existing "Cypress College" row under another id is used,
  // not duplicated.
  const existing = (await pool.query(
    `SELECT id FROM universities WHERE id = $1 OR LOWER(name) = LOWER($2) ORDER BY (id = $1) DESC LIMIT 1`,
    [UNIVERSITY.id, UNIVERSITY.name])).rows[0];
  let uid = existing ? existing.id : UNIVERSITY.id;
  if (!existing) {
    const r = await pool.query(
      `INSERT INTO universities (id, name, short_name, location) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      [UNIVERSITY.id, UNIVERSITY.name, UNIVERSITY.short_name, UNIVERSITY.location]);
    out.university = r.rowCount;
  }
  out.universityId = uid;
  const idFor = (id) => (uid === UNIVERSITY.id ? id : id.replace(UNIVERSITY.id + ':', uid + ':'));
  for (const t of teams) {
    const r = await pool.query(
      `INSERT INTO university_teams (id, university_id, name, sport, season, roster_size, venue, home_dates, market_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [idFor(t.id), uid, t.name, t.sport, t.season, t.roster_size, t.venue, t.home_dates, t.market_key]);
    out.teams += r.rowCount;
  }
  for (const it of inventory) {
    const r = await pool.query(
      `INSERT INTO university_inventory (id, university_id, team_id, name, price_cents, status)
       VALUES ($1,$2,$3,$4,$5,'available') ON CONFLICT (id) DO NOTHING`,
      [idFor(it.id), uid, it.team_id ? idFor(it.team_id) : null, it.name, it.price_cents]);
    out.inventory += r.rowCount;
  }
  return out;
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    const { teams, inventory, marketKey } = readDemo();
    console.log(`Cypress College (${UNIVERSITY.id}), market_key "${marketKey}"`);
    console.log(`${teams.length} teams, ${inventory.length} inventory items, `
      + `$${inventory.reduce((s, i) => s + i.price_cents, 0) / 100} total`);
    for (const t of teams) console.log(`  ${t.id}  ${t.name}  ${t.season}  roster ${t.roster_size}  ${t.home_dates} home dates  ${t.venue}`);
    for (const i of inventory) console.log(`  ${i.id}  ${i.name}  $${i.price_cents / 100}  ${i.team_id || 'department wide'}`);
    return;
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  });
  try {
    const r = await seed(pool);
    console.log(`Cypress College (${r.universityId}): university row ${r.university ? 'created' : 'already there'}; `
      + `${r.teams} of ${r.teamCount} teams added, ${r.inventory} of ${r.inventoryCount} inventory items added `
      + `(the rest already existed); market_key "${r.marketKey}".`);
  } finally { await pool.end(); }
}

if (require.main === module) main().catch((e) => { console.error('seed-cypress: FAILED', e.message); process.exit(1); });

module.exports = { seed, readDemo, liftConst, UNIVERSITY };
