#!/usr/bin/env node
'use strict';
// ── THE FOUR BRIEFS UNDER launchd, NOT cron ──────────────────────────────────
//
//   node tools/briefs/launchd.js --install       write four LaunchAgents and load them
//   node tools/briefs/launchd.js --uninstall     unload and remove them
//   node tools/briefs/launchd.js --status        what launchd has, and the last run of each
//   node tools/briefs/launchd.js --print         the plists, without writing anything
//   node tools/briefs/launchd.js --remove-cron   take the four brief lines out of the crontab
//
// WHY launchd. cron skips a job whose minute passes while the Mac is asleep;
// the 5:30 brief on a lid-closed laptop simply never runs. launchd's
// StartCalendarInterval is different: a run missed during sleep fires as
// soon as the Mac wakes, and several missed runs collapse into one. The four
// times stay 5:30, 5:45, 6:00 and 6:15 local.
//
// WHAT EACH AGENT IS. One plist per brief in ~/Library/LaunchAgents, label
// com.nildash.briefs.<kind>, running `node <repo>/tools/briefs/<kind>.js`
// with the repo as the working directory, PATH set (launchd gives a job
// almost no environment), and stdout and stderr appended to
// ~/nildash-briefs/logs/launchd-<kind>.log. The keys stay in
// ~/nildash-briefs/config.json, which the scripts read themselves; nothing
// is put in the plist. Options: --node <path> (default: this node),
// --repo <path> (default: this checkout), --home <path>.
//
// MAIL.APP PERMISSION. follow-ups reads Sent through Mail.app (osascript). A
// job under launchd is its own process for macOS's Automation permission,
// so the first launchd run may log "osascript failed" until node is allowed
// to control Mail: System Settings > Privacy & Security > Automation. Run
// `node tools/briefs/follow-ups.js` once by hand first so the prompt appears.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const val = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const has = (k) => args.includes(k);

// The schedule, the same four slots crontab.example had.
const BRIEFS = [
  { kind: 'follow-ups', hour: 5, minute: 30 },
  { kind: 'news-watch', hour: 5, minute: 45 },
  { kind: 'prospecting', hour: 6, minute: 0 },
  { kind: 'strategy-watch', hour: 6, minute: 15 },
];
const LABEL = (kind) => `com.nildash.briefs.${kind}`;

function settings() {
  const home = val('--home') || os.homedir();
  const repo = path.resolve(val('--repo') || path.join(__dirname, '..', '..'));
  const node = val('--node') || process.execPath;
  return {
    home, repo, node,
    agentsDir: path.join(home, 'Library', 'LaunchAgents'),
    logsDir: path.join(home, 'nildash-briefs', 'logs'),
    pathEnv: [path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter((p, i, a) => a.indexOf(p) === i).join(':'),
  };
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The plist for one brief. StartCalendarInterval fires at the wall-clock
// minute, and fires once on wake for a minute that passed during sleep.
function plistFor(b, s) {
  const script = path.join(s.repo, 'tools', 'briefs', `${b.kind}.js`);
  const log = path.join(s.logsDir, `launchd-${b.kind}.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL(b.kind)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(s.node)}</string>
    <string>${esc(script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(s.repo)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${b.hour}</integer>
    <key>Minute</key>
    <integer>${b.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(s.pathEnv)}</string>
    <key>HOME</key>
    <string>${esc(s.home)}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(log)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function plistPath(b, s) { return path.join(s.agentsDir, `${LABEL(b.kind)}.plist`); }
function uid() { try { return String(process.getuid()); } catch (_) { return null; } }
function launchctl(argv, opts = {}) {
  const r = spawnSync('launchctl', argv, { encoding: 'utf8' });
  if (r.error) { if (opts.quiet) return { ok: false, out: '', err: r.error.message }; throw r.error; }
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}

function install() {
  const s = settings();
  if (process.platform !== 'darwin') { console.log(`launchd is macOS only; this is ${process.platform}. Use --print to see the plists.`); process.exit(1); }
  for (const b of BRIEFS) {
    const script = path.join(s.repo, 'tools', 'briefs', `${b.kind}.js`);
    if (!fs.existsSync(script)) { console.log(`missing: ${script} (pass --repo <path to the NILDash checkout>)`); process.exit(1); }
  }
  if (!fs.existsSync(s.node)) { console.log(`node not found at ${s.node} (pass --node $(which node))`); process.exit(1); }
  fs.mkdirSync(s.agentsDir, { recursive: true });
  fs.mkdirSync(s.logsDir, { recursive: true });
  const domain = `gui/${uid()}`;
  for (const b of BRIEFS) {
    const p = plistPath(b, s);
    // Reload cleanly: bootout ignores "not loaded".
    launchctl(['bootout', domain, p], { quiet: true });
    fs.writeFileSync(p, plistFor(b, s));
    const r = launchctl(['bootstrap', domain, p]);
    console.log(`${r.ok ? ' ok ' : 'FAIL'}  ${LABEL(b.kind).padEnd(34)} ${String(b.hour).padStart(2, '0')}:${String(b.minute).padStart(2, '0')}  ${p}${r.ok ? '' : '  ' + (r.err || r.out).trim()}`);
    if (!r.ok) process.exitCode = 1;
  }
  console.log(`\nnode ${s.node}\nrepo ${s.repo}\nlogs ${s.logsDir}/launchd-<kind>.log\n`);
  console.log('Missed runs (Mac asleep at the minute) fire on wake. Remove the cron lines so each brief arrives once:');
  console.log('  node tools/briefs/launchd.js --remove-cron');
  console.log('Then run follow-ups once by hand so Mail.app asks for Automation permission:');
  console.log('  node tools/briefs/follow-ups.js');
}

function uninstall() {
  const s = settings();
  const domain = `gui/${uid()}`;
  for (const b of BRIEFS) {
    const p = plistPath(b, s);
    const r = launchctl(['bootout', domain, p], { quiet: true });
    if (fs.existsSync(p)) fs.unlinkSync(p);
    console.log(`removed ${LABEL(b.kind)}${r.ok ? '' : ' (was not loaded)'}`);
  }
}

function status() {
  const s = settings();
  const domain = `gui/${uid()}`;
  for (const b of BRIEFS) {
    const p = plistPath(b, s);
    const present = fs.existsSync(p);
    const r = launchctl(['print', `${domain}/${LABEL(b.kind)}`], { quiet: true });
    const loaded = r.ok;
    const last = (r.out.match(/last exit code = (\S+)/) || [])[1];
    const log = path.join(s.logsDir, `launchd-${b.kind}.log`);
    let tail = '';
    try { const lines = fs.readFileSync(log, 'utf8').trim().split('\n'); tail = lines.slice(-1)[0] || ''; } catch (_) { tail = '(no log yet)'; }
    console.log(`${LABEL(b.kind).padEnd(34)} ${String(b.hour).padStart(2, '0')}:${String(b.minute).padStart(2, '0')}  plist ${present ? 'present' : 'MISSING'}  ${loaded ? 'loaded' : 'NOT LOADED'}${last !== undefined ? '  last exit ' + last : ''}\n    ${tail.slice(0, 160)}`);
  }
}

// The four brief lines out of the crontab, the rest kept, the old crontab
// saved beside the logs first.
function removeCron() {
  const s = settings();
  const r = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  const current = r.status === 0 ? (r.stdout || '') : '';
  if (!current.trim()) { console.log('crontab is empty; nothing to remove.'); return; }
  const keep = current.split('\n').filter((l) => !/tools\/briefs\/(follow-ups|news-watch|prospecting|strategy-watch)\.js/.test(l));
  const removed = current.split('\n').length - keep.length;
  if (!removed) { console.log('no brief lines in the crontab.'); return; }
  fs.mkdirSync(s.logsDir, { recursive: true });
  const backup = path.join(s.logsDir, `crontab-before-launchd-${new Date().toISOString().slice(0, 10)}.txt`);
  fs.writeFileSync(backup, current);
  const w = spawnSync('crontab', ['-'], { input: keep.join('\n').replace(/\n*$/, '\n'), encoding: 'utf8' });
  if (w.status !== 0) { console.log('crontab write failed: ' + (w.stderr || '').trim()); process.exit(1); }
  console.log(`removed ${removed} brief line(s) from the crontab; the old crontab is saved at ${backup}`);
}

function print() {
  const s = settings();
  for (const b of BRIEFS) console.log(`# ${plistPath(b, s)}\n${plistFor(b, s)}`);
}

if (require.main === module) {
  if (has('--install')) install();
  else if (has('--uninstall')) uninstall();
  else if (has('--status')) status();
  else if (has('--remove-cron')) removeCron();
  else if (has('--print')) print();
  else { console.log('usage: node tools/briefs/launchd.js --install | --uninstall | --status | --print | --remove-cron  [--node <path>] [--repo <path>]'); process.exit(1); }
}

module.exports = { BRIEFS, LABEL, plistFor, settings };
void execFileSync;
