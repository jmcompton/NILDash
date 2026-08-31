#!/usr/bin/env node
'use strict';
// ── THE REGRESSION SET ──────────────────────────────────────────────────────
//
//   node tests/run.js                    every suite, compared to the baseline
//   node tests/run.js --only send        just the suites tagged `send`
//   node tests/run.js --file editsend    one suite by name
//   node tests/run.js --update-baseline  record the current state as expected
//
// WHY A BASELINE AND NOT A PASS/FAIL. These suites were written over months, in
// a scratchpad, against a live-ish database. Some of them have been failing for
// weeks for reasons that have nothing to do with the change in front of you --
// `.example` is a reserved TLD with no MX, a fixture drifted, a suite needs a
// network this box does not have. A runner that reports 40 red suites on day one
// is a runner nobody reads, and a runner nobody reads is worse than none,
// because it converts "the send path is covered" into a feeling.
//
// So this compares against tests/baseline.json and reports what CHANGED. A suite
// that was failing 3 and still fails 3 is not news. A suite that was green and
// is now red fails the run, loudly, with its output.
//
// THE BASELINE IS NOT A PLACE TO HIDE THINGS. Every entry records the count, so
// `git diff tests/baseline.json` shows exactly which suite got worse and by how
// much, and accepting a regression is a visible commit rather than a silence.
//
// ── ORDERING ────────────────────────────────────────────────────────────────
// The send-path suites run FIRST, and the run stops on a regression in one
// unless --keep-going is passed. Everything else can wait; an email going to the
// wrong business cannot.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const REPO = path.join(HERE, '..');
const BASELINE = path.join(HERE, 'baseline.json');

// ── WHAT TOUCHES THE SEND PATH ──────────────────────────────────────────────
// Approval, scheduling, the release loop, the provider call, suppression, the
// compliance gate, and the id namespacing that decides WHICH row gets approved.
// A regression in any of these can put a real email in front of a real business,
// so they run first and they stop the run.
const SEND_PATH = new Set([
  'editsend.js',        // an edited draft is what reaches the wire
  'editrender.js',      // the agent can still edit it at all
  'mixedqueue.js',      // a queue id fed to the email approve path throws
  'emailchannel.js',    // one send path, and approving frees the slot
  'closerroute.js', 'readytosend.js', 'closer.js',
  'compliance.js', 'mkhold.js', 'guard.js', 'caps.js',
  'replycapture.js', 'replyhandled.js', 'namedreply.js',
  'draftexpiry.js', 'homegate.js', 'verify.js', 'acctceiling.js',
  'creditfault.js',     // credits are counted before they are spent
  'sendscope.js',       // a mailbox that cannot send never claims it can
]);

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
const UPDATE = has('--update-baseline');
const KEEP_GOING = has('--keep-going');
const ONLY = val('--only');
const ONE = val('--file');
const PER_SUITE_TIMEOUT_MS = parseInt(process.env.TEST_TIMEOUT_MS, 10) || 300000;

function suites() {
  let all = fs.readdirSync(HERE)
    .filter((f) => f.endsWith('.js') && f !== 'run.js')
    .sort();
  if (ONE) all = all.filter((f) => f === ONE || f === ONE + '.js');
  if (ONLY === 'send') all = all.filter((f) => SEND_PATH.has(f));
  // Send path first, then the rest alphabetically.
  return all.sort((a, b) => {
    const sa = SEND_PATH.has(a) ? 0 : 1, sb = SEND_PATH.has(b) ? 0 : 1;
    return sa - sb || a.localeCompare(b);
  });
}

// Suites report in two shapes, both of which have been in use for months:
//   "12/14 passed"        (check())
//   "failures: 2"         (ok())
// Anything that prints neither, or dies first, is a FAULT rather than a count --
// a suite that cannot run is not a suite that passed.
function readResult(stdout, stderr, status) {
  const out = String(stdout || '') + '\n' + String(stderr || '');
  const m1 = out.match(/(\d+)\/(\d+) passed/);
  if (m1) return { failed: Number(m1[2]) - Number(m1[1]), total: Number(m1[2]) };
  const m2 = out.match(/failures:\s*(\d+)/);
  if (m2) {
    const total = (out.match(/^\s*(PASS|FAIL)\b/gm) || []).length;
    return { failed: Number(m2[1]), total: total || Number(m2[1]) };
  }
  return { failed: null, total: null, fault: /THREW/.test(out) ? 'threw' : 'no result line',
    status };
}

function run(file) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, file)], {
    cwd: REPO, encoding: 'utf8', timeout: PER_SUITE_TIMEOUT_MS,
    env: { ...process.env, NODE_PATH: path.join(REPO, 'node_modules') },
    maxBuffer: 64 * 1024 * 1024,
  });
  const res = readResult(r.stdout, r.stderr, r.status);
  res.ms = Date.now() - t0;
  if (r.error && r.error.code === 'ETIMEDOUT') { res.failed = null; res.fault = 'timed out'; }
  res.output = (String(r.stdout || '') + String(r.stderr || '')).split('\n').slice(-40).join('\n');
  return res;
}

const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : { suites: {} };
const list = suites();
const now = {};
const regressed = [];
const fixed = [];
const faults = [];

console.log(`\nRunning ${list.length} suite(s). Send-path suites first.\n`);
let i = 0;
for (const file of list) {
  i++;
  // NO SHORTCUT ON THE STARTUP WAIT. This lowered it to 1200ms after the first
  // suite on the theory that the schema was already migrated -- and editsend
  // dropped from 33/33 to 29/33, silently, because store.js's init had not
  // settled. A regression set that trades correctness for eight minutes is not a
  // regression set. Override TEST_INIT_WAIT_MS by hand if you know better.
  const res = run(file);
  now[file] = { failed: res.failed, total: res.total, fault: res.fault || null };
  const was = base.suites[file];
  const tag = SEND_PATH.has(file) ? 'SEND' : '    ';

  // A FAULT the baseline already records is not news -- closer.js and
  // compliance.js have thrown for weeks for reasons that predate any change in
  // front of you. Only a suite that could run before and cannot now stops a run.
  let mark = ' ok ';
  if (res.fault && was && was.fault) mark = 'known';
  else if (res.fault) { mark = 'FAULT'; faults.push({ file, res }); }
  else if (!was) mark = ' new';
  else if (was.fault) { mark = 'better'; fixed.push({ file, was: was.fault, now: res.failed }); }
  else if (res.failed > was.failed) { mark = 'WORSE'; regressed.push({ file, was: was.failed, now: res.failed, res }); }
  else if (res.failed < was.failed) { mark = 'better'; fixed.push({ file, was: was.failed, now: res.failed }); }

  const count = res.failed === null ? '  ?  ' : `${(res.total - res.failed)}/${res.total}`;
  console.log(`  ${tag} ${mark.padEnd(6)} ${file.padEnd(24)} ${String(count).padStart(8)}`
    + `  ${String(res.ms / 1000).slice(0, 4)}s`
    + (was && res.failed !== null && was.failed ? `   (baseline: ${was.failed} failing)` : ''));

  if (!KEEP_GOING && SEND_PATH.has(file) && (mark === 'WORSE' || mark === 'FAULT')) {
    console.log('\n── STOPPED. A SEND-PATH SUITE REGRESSED ──────────────────────');
    console.log(res.output);
    console.log('\nRe-run with --keep-going to see the rest anyway.');
    if (!UPDATE) process.exit(1);
  }
}

if (UPDATE) {
  fs.writeFileSync(BASELINE, JSON.stringify({
    recordedAt: new Date().toISOString().slice(0, 10),
    note: 'Expected state. A suite failing here is KNOWN, not accepted forever -- '
      + 'git diff this file to see what changed and why.',
    suites: now,
  }, null, 2) + '\n');
  console.log(`\nBaseline updated: ${Object.keys(now).length} suite(s) recorded.`);
  process.exit(0);
}

console.log('');
if (fixed.length) {
  console.log(`${fixed.length} suite(s) improved:`);
  for (const f of fixed) console.log(`  ${f.file}: ${f.was} -> ${f.now} failing`);
  console.log('  Run with --update-baseline to record that.');
}
if (faults.length) {
  console.log(`\n${faults.length} suite(s) could not report a result:`);
  for (const f of faults) console.log(`  ${f.file}: ${f.res.fault}`);
}
if (regressed.length) {
  console.log(`\n${regressed.length} REGRESSION(S):`);
  for (const r of regressed) console.log(`  ${r.file}: ${r.was} -> ${r.now} failing`);
  console.log('\n' + regressed[0].res.output);
  process.exit(1);
}
if (!faults.length) console.log('No regressions.');
process.exit(faults.length ? 1 : 0);
