#!/usr/bin/env node
'use strict';
// ── THE RAILWAY ENTRYPOINT: ONE CRON, FOUR BRIEFS, THE SAME FOUR TIMES ───────
//
// Railway gives a service one cron schedule and runs the start command on it.
// The Mac ran four cron lines at 5:30, 5:45, 6:00 and 6:15 Central. To keep
// those times without four services, the schedule fires every fifteen
// minutes across the hours that cover them in both Central offsets
// (`*/15 10-12 * * *`, UTC), and this picks the brief whose Central slot is
// now. A firing that lands on no slot exits at once and costs nothing.
//
//   node tools/briefs/run-slot.js              the cron run: the brief for this slot, if any
//   node tools/briefs/run-slot.js --all        every brief in order (a manual run)
//   node tools/briefs/run-slot.js --brief news-watch
//   node tools/briefs/run-slot.js --dry        say which brief this slot would run
//
// BRIEFS_TZ (default America/Chicago) and BRIEFS_SLOT_TOLERANCE_MIN (default
// 7: Railway's cron can start a job a minute or two late) shape the match.

const path = require('path');
const { spawn } = require('child_process');

const SLOTS = [
  { brief: 'follow-ups', at: '05:30' },
  { brief: 'news-watch', at: '05:45' },
  { brief: 'prospecting', at: '06:00' },
  { brief: 'strategy-watch', at: '06:15' },
];
const TZ = process.env.BRIEFS_TZ || 'America/Chicago';
const TOLERANCE = Math.max(0, parseInt(process.env.BRIEFS_SLOT_TOLERANCE_MIN, 10) || 7);

// "HH:MM" in a time zone, 24-hour, for a Date.
function localHM(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '00';
  const h = get('hour') === '24' ? '00' : get('hour');
  return `${h}:${get('minute')}`;
}
const toMin = (hm) => { const [h, m] = String(hm).split(':').map((x) => parseInt(x, 10)); return h * 60 + m; };

// The slot within `tolerance` minutes of `hm`, nearest first, or null.
function pickSlot(hm, tolerance = TOLERANCE, slots = SLOTS) {
  const now = toMin(hm);
  let best = null;
  for (const s of slots) {
    const d = Math.abs(now - toMin(s.at));
    if (d <= tolerance && (!best || d < best.d)) best = { ...s, d };
  }
  return best;
}

function runBrief(name) {
  const script = path.join(__dirname, `${name}.js`);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env });
    child.on('error', (e) => { console.error(`[run-slot] ${name}: could not start: ${e.message}`); resolve(1); });
    child.on('close', (code) => { console.log(`[run-slot] ${name}: exit ${code} after ${Math.round((Date.now() - t0) / 1000)}s`); resolve(code == null ? 1 : code); });
  });
}

async function main(argv) {
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const now = new Date();
  const hm = localHM(now, TZ);
  console.log(`[run-slot] ${now.toISOString()} = ${hm} ${TZ}; BRIEFS_HOME=${process.env.BRIEFS_HOME || '(default ~/nildash-briefs)'}`);

  let names;
  if (has('--all')) names = SLOTS.map((s) => s.brief);
  else if (val('--brief')) {
    const n = val('--brief');
    if (!SLOTS.some((s) => s.brief === n)) { console.error(`[run-slot] unknown brief "${n}"; one of ${SLOTS.map((s) => s.brief).join(', ')}`); return 2; }
    names = [n];
  } else {
    const slot = pickSlot(hm);
    if (!slot) { console.log(`[run-slot] no brief within ${TOLERANCE} min of ${hm} ${TZ} (slots: ${SLOTS.map((s) => s.at + ' ' + s.brief).join(', ')}); nothing to do`); return 0; }
    names = [slot.brief];
    console.log(`[run-slot] slot ${slot.at} ${TZ}: ${slot.brief}`);
  }
  if (has('--dry')) { console.log(`[run-slot] would run: ${names.join(', ')}`); return 0; }

  let worst = 0;
  for (const n of names) {
    const code = await runBrief(n);
    if (code > worst) worst = code;
  }
  return worst;
}

module.exports = { SLOTS, localHM, pickSlot, runBrief, main };
if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => { console.error('[run-slot] FAILED', e); process.exit(1); });
