'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/placeholder.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── REAL BUSINESS NAMES ONLY ─────────────────────────────────────────────────
//
// "Local Harrisburg Barber/Salon (independent)" and "Local Virginia Tech Fan
// Business (independent)" reached cards. The market pool's writer already
// refused placeholders; the scan's "shown" ledger did not, the knowledge path
// that wrote them did not, and neither the slate nor the card writer checked
// a name. Now every writer and every reader refuses them, by the same rule.

const store = require(REPO + 'server/store.js');
const Scout = require(REPO + 'server/services/scout.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'ph-agent', ATH = 'ph-ath';

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const why = store.placeholderReason;

  OUT.push('-- the rule --');
  for (const n of ['Local Harrisburg Barber/Salon (independent)', 'Local Virginia Tech Fan Business (independent)', 'Local Auburn Gym', 'Local Harrisburg Restaurant', 'Auburn Fan Business', 'Independent Coffee Shop (locally owned)', '[Business Name]', 'A local pizzeria near campus', 'Sample Boutique']) {
    ok(`refused: ${n}`, !!why(n), why(n));
  }
  for (const n of ['Deep Water Brazilian Jiu Jitsu', "Maxie's Pizza (Auburn)", 'Harrisburg Barber Co', 'Local Motion Fitness', 'The Local Taco', 'Independent Brewing Co', 'Family Owned Diner', 'Localhost Coffee', 'Bfitamazing', 'Fox Bros. Bar-B-Q']) {
    ok(`kept: ${n}`, !why(n), why(n));
  }

  OUT.push('', '-- the writers --');
  await P().query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'P','ph@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb)`, [ATH, AG, JSON.stringify({ name: 'Ph Athlete', school: 'Auburn University', sport: 'football' })]);
  const n = await store.upsertShownBrands(AG, ATH, 'local', [
    { brandKey: 'ph-real', brandName: 'Harrisburg Barber Co' },
    { brandKey: 'ph-fake', brandName: 'Local Harrisburg Barber/Salon (independent)' },
  ]);
  const ledger = (await P().query(`SELECT brand_name FROM brand_engagement WHERE athlete_id = $1 ORDER BY brand_name`, [ATH])).rows.map((r) => r.brand_name);
  ok('the shown ledger takes the real name and refuses the placeholder', n === 1 && ledger.length === 1 && ledger[0] === 'Harrisburg Barber Co', ledger);
  const mk = 'ph-market-' + Date.now();
  await store.markMarketNewcomers(mk, ['Harrisburg Barber Co', 'Local Virginia Tech Fan Business (independent)']);
  const seen = (await P().query(`SELECT brand FROM market_business_seen WHERE market_key = $1`, [mk])).rows.map((r) => r.brand);
  ok('the market pool refuses it too (as before), and records why', seen.length === 1 && seen[0] === 'Harrisburg Barber Co' && (await P().query(`SELECT reason FROM market_business_rejected WHERE market_key = $1`, [mk])).rows.length === 1);

  OUT.push('', '-- the readers --');
  // A placeholder already in the ledger from before the gate: the slate refuses it by name.
  await P().query(`INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state, shown_count, first_shown_at, last_shown_at)
                   VALUES ($1,$2,'ph-old-fake','Local Auburn Gym (independent)','local','shown',1,NOW(),NOW())`, [AG, ATH]);
  const local = await Scout.localCandidates(P(), { agentId: AG, athlete: { id: ATH, school: 'Auburn University', marketKey: null, hasLocalMarket: true }, limit: 10 });
  ok('the slate drops a placeholder already in the ledger and keeps the real one', local.rows.length === 1 && local.rows[0].brand_name === 'Harrisburg Barber Co', local.rows.map((r) => r.brand_name));

  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const ai = src('server/ai.js'), job = src('server/jobs/outreachQueue.js'), st = src('server/store.js');
  ok('addCandidate refuses placeholders from every source', /if \(store\.placeholderReason\(nm\)\) \{ _placeholdersDropped\+\+; return; \}/.test(ai));
  ok('the knowledge path refuses them and an all-placeholder answer is an empty one', /model-knowledge refused \$\{fake\.length\} placeholder name\(s\)/.test(ai) && /throw new Error\('model knowledge returned only placeholder names'\)/.test(ai));
  ok('the job refuses a placeholder before the Places lookup, and records it', /not a real business name \(\$\{ph\}\)/.test(job) && job.indexOf('store.placeholderReason(cand.brand_name)') < job.indexOf('place = await lookupPlace(cand.brand_name'));
  ok('  and insertCard is the last gate', /const ph = store\.placeholderReason \? store\.placeholderReason\(card && card\.brandName\) : null;\s*if \(ph\) \{[\s\S]*?return false;/.test(job));
  ok('the social pool is a per-athlete spread, not the same first brand for everyone', /ORDER BY \(brand_size = 'small'\) DESC NULLS LAST, md5\(\$\$\{params\.length \+ 1\}::text \|\| brand\)/.test(st));
  ok('the scripts exist: purge the placeholders, inspect a social brand', /outcome = 'placeholder'/.test(src('scripts/purge-placeholder-brands.js')) && /DELETE FROM brand_engagement WHERE id = ANY\(\$1::int\[\]\) AND state = 'shown'/.test(src('scripts/purge-placeholder-brands.js')) && /--deactivate/.test(src('scripts/inspect-social-brand.js')));

  await P().query(`DELETE FROM brand_engagement WHERE athlete_id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM market_business_seen WHERE market_key = $1`, [mk]).catch(() => {});
  await P().query(`DELETE FROM market_business_rejected WHERE market_key = $1`, [mk]).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE id = $1`, [ATH]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
