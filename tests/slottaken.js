'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/slottaken.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE SLOT IS CONFIRMED AFTER THE WRITER, NOT BEFORE IT ───────────────────
//
// The open slots were listed once, before the candidates were worked; a slot
// could be filled by another fill while Sonnet wrote, and the insert's unique
// index then threw the pitch away while the run row counted a tried business.
// Now the slot is re-checked immediately before each insert, after the writer
// returns. A slot found taken is logged on the run row as "slot taken after
// write", withdrawn from `tried`, and counted by spend-breakdown as a writer
// call that bought nothing.

const store = require(REPO + 'server/store.js');
const Job = require(REPO + 'server/jobs/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const ATH = 'st-ath-1', AG = 'st-agent';

async function main() {
  // ── 1. THE CHECK ─────────────────────────────────────────────────────────
  OUT.push('-- slotStillOpen --');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => { await P().query(`DELETE FROM outreach_queue WHERE athlete_id = $1`, [ATH]).catch(() => {}); };
  await clean();
  ok('an empty slot is open', await Job.slotStillOpen(P(), ATH, 1) === true);
  await P().query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, channel, state, identity_key)
     VALUES ($1,$2,1,'k-1','Some Cafe','why','dm','queued','id-1')`, [AG, ATH]);
  ok('a queued row in the slot means taken', await Job.slotStillOpen(P(), ATH, 1) === false);
  ok('  the next slot is still open', await Job.slotStillOpen(P(), ATH, 2) === true);
  await P().query(`UPDATE outreach_queue SET state = 'sent' WHERE athlete_id = $1 AND slot = 1`, [ATH]);
  ok('a slot whose card was sent (not queued) is open again, like the unique index says', await Job.slotStillOpen(P(), ATH, 1) === true);
  await clean();
  ok('the reason text is fixed', Job.SLOT_TAKEN_REASON === 'slot taken after write');

  // ── 2. WHERE THE CHECK SITS ──────────────────────────────────────────────
  OUT.push('', '-- placement --');
  const src = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  const sites = src.match(/if \(!\(await slotStillOpen\(pool, athleteId, slot\)\)\) \{[\s\S]*?\n\s*\}\n\s*(const pins = await insertCard|if \(await insertCard)/g) || [];
  ok('the check sits immediately before the insert at both write sites', sites.length === 2, sites.length);
  // Program / lifted site: after the writer (ppitch) and the card is built.
  const pro = src.slice(src.indexOf('const pcard = Q.buildProgramCard'), src.indexOf('const pins = await insertCard'));
  ok('  program site: after the writer returned and the card was built, before insertCard', /slotStillOpen/.test(pro) && /loseSlot\(cand\.brand_name, slot, cand\.lane, ppitch\)/.test(pro));
  const local = src.slice(src.indexOf('const card = Q.buildCard({'), src.indexOf('if (await insertCard(pool, { agentId, athleteId, slot, card }))'));
  ok('  local site: after the writer returned and the card was built, before insertCard', /slotStillOpen/.test(local) && /loseSlot\(cand\.brand_name, slot, card\.lane, pitch\)/.test(local));
  const beforeWriterLocal = src.slice(src.indexOf("tried.push({ brand: cand.brand_name, result: 'queued', reason: null,\n        places: facts"), src.indexOf('const card = Q.buildCard({'));
  ok('  and NOT before the writer runs', !/slotStillOpen/.test(beforeWriterLocal));
  ok('the up-front slot list is unchanged', /let open = Q\.slotsToFill\(heldRows\);/.test(src) && /if \(ctx\.maxSlots && open\.length > ctx\.maxSlots\) open = open\.slice\(0, ctx\.maxSlots\);/.test(src));
  ok('a taken slot ends that slot and moves on (break), not the athlete', (src.match(/slotLost = true; break;/g) || []).length === 2);
  ok('  and is not reported as "nothing passed the bar"', /if \(!placed && !slotLost\) say\(`slot \$\{slot\}: nothing passed the bar`\);/.test(src));

  // ── 3. NOT A TRIED BUSINESS; ON THE RUN ROW; IN THE BREAKDOWN ────────────
  OUT.push('', '-- the record --');
  ok('the queued attempt is withdrawn from tried', /tried\[i\]\.result === 'queued'\) \{ tried\.splice\(i, 1\); break; \}/.test(src));
  ok('  and recorded on slotTaken with the reason, the slot, the lane and the writer retry flag', /slotTaken\.push\(\{ brand, slot, lane: lane \|\| null, reason: SLOT_TAKEN_REASON,\s*writerRetried/.test(src));
  ok('fillAthlete returns slotTaken', /return \{ filled, open: open\.length, tried, slotTaken, note, spendLog, faults, emptyReason,/.test(src));
  ok('the run row carries it per athlete', /slotTaken: r\.slotTaken \|\| \[\],/.test(src));
  ok('the note and emptyReason still key on tried alone', /tried\.length\s*\? `\$\{tried\.length\} business/.test(src) && /: tried\.length \? Scout\.EMPTY\.BELOW_BAR : Scout\.EMPTY\.MARKET_EXHAUSTED;/.test(src));
  ok('insertCard\'s own conflict handling is untouched as the last line of defence', /ON CONFLICT DO NOTHING RETURNING id/.test(src) && /the queue slot was taken before this card was written/.test(src));
  const sb = fs.readFileSync(REPO + 'scripts/spend-breakdown.js', 'utf8');
  ok('spend-breakdown counts the lost pitch as a writer call', /const lost = Array\.isArray\(d\.slotTaken\) \? d\.slotTaken : \[\];/.test(sb) && /\+ lost\.length;/.test(sb));
  ok('  and lists them under "slot taken after write"', /slot taken after write: \$\{lostAll\.length\} pitch\(es\) written/.test(sb) && /slot taken after write: none/.test(sb));

  // The loseSlot bookkeeping, exercised on a stand-in list.
  const tried = [{ brand: 'A', result: 'rejected' }, { brand: 'B', result: 'queued' }, { brand: 'B', result: 'no_angle' }];
  const fnSrc = src.slice(src.indexOf('const loseSlot = (brand, slot, lane, pitchObj) => {'), src.indexOf('  };', src.indexOf('const loseSlot = (brand, slot, lane, pitchObj) => {')) + 4);
  const slotTaken = [];
  const SLOT_TAKEN_REASON = Job.SLOT_TAKEN_REASON;
  // eslint-disable-next-line no-new-func
  const loseSlot = new Function('tried', 'slotTaken', 'SLOT_TAKEN_REASON', fnSrc + ' return loseSlot;')(tried, slotTaken, SLOT_TAKEN_REASON);
  loseSlot('B', 3, 'local', { retried: true });
  ok('loseSlot withdraws only the queued entry for that business', tried.length === 2 && !tried.some((t) => t.brand === 'B' && t.result === 'queued') && tried.some((t) => t.brand === 'B' && t.result === 'no_angle'), tried);
  ok('  and records the loss', slotTaken.length === 1 && slotTaken[0].brand === 'B' && slotTaken[0].slot === 3 && slotTaken[0].lane === 'local' && slotTaken[0].reason === 'slot taken after write' && slotTaken[0].writerRetried === true, slotTaken);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
