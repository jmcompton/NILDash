'use strict';
// Runs from a checkout on any machine, no database, no network: the launchd
// installer is exercised through --print and its module, and the plists it
// would write are checked for the four slots, the paths and the environment.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/briefslaunchd.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const fs = require('fs');
const { spawnSync } = require('child_process');

// ── THE BRIEFS UNDER launchd ─────────────────────────────────────────────────
//
// cron skips a minute the Mac sleeps through. launchd's StartCalendarInterval
// runs the missed job on wake. Four agents, the same four times, the keys
// still in config.json and nowhere in the plist.

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const L = require(REPO + 'tools/briefs/launchd.js');

OUT.push('-- the schedule --');
ok('four briefs at 5:30, 5:45, 6:00 and 6:15', L.BRIEFS.map((b) => `${b.kind}@${b.hour}:${String(b.minute).padStart(2, '0')}`).join(' ') === 'follow-ups@5:30 news-watch@5:45 prospecting@6:00 strategy-watch@6:15');
ok('  the same four slots crontab.example has', ['30 5', '45 5', '0  6', '15 6'].every((t) => fs.readFileSync(REPO + 'tools/briefs/crontab.example', 'utf8').includes(t)));

OUT.push('', '-- the plists --');
const s = L.settings();
for (const b of L.BRIEFS) {
  const p = L.plistFor(b, Object.assign({}, s, { node: '/opt/homebrew/bin/node', repo: '/Users/jm/NILDash', home: '/Users/jm', logsDir: '/Users/jm/nildash-briefs/logs', pathEnv: '/opt/homebrew/bin:/usr/bin:/bin' }));
  ok(`${b.kind}: label, script, working directory`, new RegExp(`<string>com\\.nildash\\.briefs\\.${b.kind}</string>`).test(p) && p.includes(`<string>/Users/jm/NILDash/tools/briefs/${b.kind}.js</string>`) && /<key>WorkingDirectory<\/key>\s*<string>\/Users\/jm\/NILDash<\/string>/.test(p));
  ok(`  StartCalendarInterval ${b.hour}:${String(b.minute).padStart(2, '0')}, not RunAtLoad`, new RegExp(`<key>StartCalendarInterval</key>\\s*<dict>\\s*<key>Hour</key>\\s*<integer>${b.hour}</integer>\\s*<key>Minute</key>\\s*<integer>${b.minute}</integer>`).test(p) && /<key>RunAtLoad<\/key>\s*<false\/>/.test(p));
  ok('  stdout and stderr to the brief\'s own launchd log', (p.match(new RegExp(`<string>/Users/jm/nildash-briefs/logs/launchd-${b.kind}\\.log</string>`, 'g')) || []).length === 2);
  ok('  PATH and HOME set (launchd gives a job almost no environment); no key in the plist', /<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/.test(p) && /<key>HOME<\/key>\s*<string>\/Users\/jm<\/string>/.test(p) && !/sk-|re_|API_KEY/.test(p));
  ok('  well-formed XML: every opened tag closes', ['dict', 'array', 'string', 'key', 'integer', 'plist'].every((t) => (p.match(new RegExp(`<${t}[ >]`, 'g')) || []).length === (p.match(new RegExp(`</${t}>`, 'g')) || []).length));
}

OUT.push('', '-- the command --');
const pr = spawnSync(process.execPath, [REPO + 'tools/briefs/launchd.js', '--print', '--node', '/opt/homebrew/bin/node', '--repo', '/Users/jm/NILDash', '--home', '/Users/jm'], { encoding: 'utf8' });
ok('--print writes nothing and shows all four', pr.status === 0 && (pr.stdout.match(/<\?xml/g) || []).length === 4 && /# \/Users\/jm\/Library\/LaunchAgents\/com\.nildash\.briefs\.follow-ups\.plist/.test(pr.stdout), pr.stderr);
const inst = spawnSync(process.execPath, [REPO + 'tools/briefs/launchd.js', '--install', '--home', '/tmp/nildash-launchd-test-home'], { encoding: 'utf8' });
ok('--install refuses off macOS rather than writing agents that cannot load', process.platform === 'darwin' || (inst.status === 1 && /launchd is macOS only/.test(inst.stdout) && !fs.existsSync('/tmp/nildash-launchd-test-home/Library/LaunchAgents')), inst.stdout);
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
ok('--remove-cron keeps every non-brief line and saves the old crontab first', /filter\(\(l\) => !\/tools\\\/briefs\\\/\(follow-ups\|news-watch\|prospecting\|strategy-watch\)\\\.js\/\.test\(l\)\)/.test(src('tools/briefs/launchd.js')) && /crontab-before-launchd-/.test(src('tools/briefs/launchd.js')));
ok('--install reloads cleanly (bootout, write, bootstrap) into the gui domain', /launchctl\(\['bootout', domain, p\], \{ quiet: true \}\);\s*fs\.writeFileSync\(p, plistFor\(b, s\)\);\s*const r = launchctl\(\['bootstrap', domain, p\]\);/.test(src('tools/briefs/launchd.js')) && /const domain = `gui\/\$\{uid\(\)\}`;/.test(src('tools/briefs/launchd.js')));

OUT.push('', '-- the docs and the diagnosis --');
ok('the README sends a Mac to launchd, keeps cron as the fallback, and names the diagnosis script', /node tools\/briefs\/launchd\.js --install/.test(src('tools/briefs/README.md')) && /--remove-cron/.test(src('tools/briefs/README.md')) && /why-no-brief\.sh/.test(src('tools/briefs/README.md')) && /crontab\.example` is kept/.test(src('tools/briefs/README.md')));
ok('  crontab.example says why cron misses and points at launchd', /PREFER launchd/.test(src('tools/briefs/crontab.example')));
const why = src('tools/briefs/why-no-brief.sh');
ok('why-no-brief.sh checks sleep, the schedule, the 05:20-06:30 log lines, the keys (masked) and one test call', /pmset -g log/.test(why) && /crontab -l/.test(why) && /launchctl print/.test(why) && /0\(5:\[2-5\]\[0-9\]\|6:\[0-2\]\[0-9\]\)/.test(why) && /deepseekApiKey/.test(why) && /--api-test/.test(why) && /slice\(0, 4\) \+ "\.\.\." \+/.test(why));
ok('  and never prints a whole key', !/console\.log\([^)]*c\.deepseekApiKey\)/.test(why) && !/echo .*DEEPSEEK_API_KEY"/.test(why));
ok('no file in tools/briefs holds a real-looking key', ['launchd.js', 'why-no-brief.sh', 'README.md', 'crontab.example'].every((f) => !/sk-[A-Za-z0-9]{20,}|re_[A-Za-z0-9]{20,}/.test(src('tools/briefs/' + f))));

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
