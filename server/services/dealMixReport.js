'use strict';
// ── THE DEAL MIX DRY RUN, PRINTED (scripts/market-mix-dryrun.js) ────────────
// Pure: one athlete's score, tier and the cards the night would place, and
// the run's totals. The script gathers; this formats.

const MS = require('./marketScore');
const DM = require('./dealMix');

const LANE_W = 9;
function cardLine(c, i) {
  const lane = DM.laneOf(c);
  const size = c.brandSize ? ` (${c.brandSize})` : '';
  const who = c.contactName ? `${c.contactName}${c.contactTitle ? ` (${c.contactTitle})` : ''}` : 'nobody named';
  let how;
  if (c.channel === 'email') how = `email to ${who} <${c.email || 'no address'}>${c.emailVerified ? ', verified' : ', NOT verified'}`;
  else if (c.channel === 'program') how = `program application ${c.programUrl || '(no page)'}, greeting ${who}`;
  else how = `${c.channel} to ${who}`;
  // A local card filling a backfilled brand seat says which seat.
  const tag = c.mixBackfill ? `[local, ${c.mixBackfill.seat} seat]` : '[' + lane + ']';
  const L = [`    ${String(i + 1)}. ${tag.padEnd(LANE_W)} ${c.brandName}${size}: ${how}`];
  const fit = Array.isArray(c.fitReasons) && c.fitReasons.length ? c.fitReasons : null;
  if (fit) L.push(`         Why they fit: ${fit.slice(0, 4).join('; ')}`);
  if (c.fitLine) L.push(`         The pitch states: "${c.fitLine}"`);
  return L.join('\n');
}

const TURNED = new Set(['rejected', 'no_name', 'no_angle', 'error', 'skipped']);
function turnedDown(tried) {
  const by = {};
  for (const t of tried || []) {
    if (!t || !TURNED.has(t.result)) continue;
    const lane = DM.laneOf(t);
    const why = String(t.reason || t.result).replace(/\s+/g, ' ')
      .replace(/^(.{0,90}).*$/, '$1');
    by[lane] = by[lane] || { n: 0, reasons: new Map() };
    by[lane].n++;
    by[lane].reasons.set(why, (by[lane].reasons.get(why) || 0) + 1);
  }
  return by;
}

function formatAthlete({ name, score, cards, result, error, spend, ms }) {
  const L = [];
  const s = score || {};
  L.push(`=== ${name}: ${s.score}/100, ${s.tierLabel || MS.TIER_LABEL[s.tier]} (confidence ${Math.round((Number(s.confidence) || 0) * 100)}%) ===`);
  L.push(`  Mix: ${DM.describe(s.tier)}`);
  L.push('  What drove the score:');
  for (const r of (s.reasons || [])) L.push('    ' + r);
  if ((s.missing || []).length) L.push(`    Missing (scored 0, lowers confidence): ${[...new Set(s.missing)].join(', ')}`);
  const list = cards || [];
  L.push(`  Cards it would place (${list.length} of ${require('./outreachQueue').SLOTS_PER_ATHLETE}):`);
  if (!list.length) L.push('    none');
  // Lane order: local, social, national, as the mix reads.
  const order = { local: 0, social: 1, national: 2 };
  list.slice().sort((a, b) => order[DM.laneOf(a)] - order[DM.laneOf(b)]).forEach((c, i) => L.push(cardLine(c, i)));
  if (error) L.push(`  The fill failed on our side: ${error.message || error}`);
  const loop = (result && result.loop) || {};
  // THE BACKFILL: each social or national seat nobody passed the bar for,
  // filled from the local lane, and why (jobs/outreachQueue backfillMix).
  const bf = (loop.mix && loop.mix.backfilled) || [];
  if (bf.length) {
    L.push(`  Backfilled from the local lane (${bf.length} seat${bf.length === 1 ? '' : 's'}):`);
    for (const b of bf) L.push(`    ${b.seat} seat -> ${b.brand}${b.contact ? `, ${b.contact}` : ''}${b.email ? ` <${b.email}>` : ''}, verified. Why: ${b.why}`);
  }
  if (loop.mix && loop.mix.short && loop.mix.short.length) L.push(`  Short: ${loop.mix.short.join(', ')}`);
  if (result && result.note && !list.length) L.push(`  Note: ${result.note}`);
  const td = turnedDown(result && result.tried);
  const lanes = Object.keys(td);
  if (lanes.length) {
    L.push('  Turned down, by lane:');
    for (const lane of DM.LANES.filter((l) => td[l])) {
      const top = [...td[lane].reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      L.push(`    ${lane} ${td[lane].n}: ` + top.map(([w, n]) => `${n}x ${w}`).join(' | '));
    }
  }
  const sp = spend || {};
  L.push(`  Spent: $${(Number(sp.usd) || 0).toFixed(2)} on the model and web searches (${sp.calls || 0} call(s), ${sp.searches || 0} search(es))`
    + `${loop.stop ? `; stopped by ${loop.stop}` : ''}; ${Math.round((ms || 0) / 1000)}s. Mailbox checks come out of Hunter's monthly pool.`);
  return L.join('\n');
}

function formatTotals(t) {
  const L = [];
  L.push(`TOTAL: ${t.athletes} athlete(s), ${t.cards} card(s) of ${t.athletes * 5}; $${(t.usd || 0).toFixed(2)} spent on the model and searches.`);
  L.push('  By tier: ' + (Object.entries(t.byTier || {}).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'));
  L.push('  By lane, placed of the seats the mix opens: ' + DM.LANES.map((l) => `${l} ${t.byLane[l] || 0} of ${t.seats[l] || 0}`).join(', '));
  if (t.backfilled) L.push(`  Brand seats backfilled from the local lane: ${t.backfilled}${t.backfilledBy ? ` (${Object.entries(t.backfilledBy).map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`);
  return L.join('\n');
}

module.exports = { formatAthlete, formatTotals, turnedDown, cardLine };
