'use strict';
// No database, no network, no claude: --dry stops before any draft, and HOME
// is a scratch directory with a LinkedIn-format Connections.csv in it.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/prospectdebug.js      just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const REPO = _tp.join(__dirname, '..') + _tp.sep;

// ── PROSPECTING FINDS THE FILE WHERE IT IS, AND SAYS WHY IT DRAFTED ZERO ────
//
// The first live run had connectionsFile set to ~/nildash-briefs/Connections.csv
// and 1,741 rows in it, and drafted nothing: the script only ever looked in
// inbox/ and never read connectionsFile at all. Now the config path is honoured,
// the root is searched after the inbox, and --debug prints the config, every
// place it looked, the header line, the first rows, the count per keyword, the
// exclusions, and the reason for zero.

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

const CSV = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ann,Lee,https://www.linkedin.com/in/annlee,,Ridge Sports Agency,NIL Agent,12 Sep 2026
Bob,Ray,https://www.linkedin.com/in/bobray,bob@ray.com,Auburn Athletics,Assistant Coach,10 Sep 2026
Cara,Diaz,https://www.linkedin.com/in/caradiaz,,Big Brand Co,Director of Marketing,09 Sep 2026
Dan,Fox,https://www.linkedin.com/in/danfox,,Fox Plumbing,Owner,08 Sep 2026
Eve,Sun,https://www.linkedin.com/in/evesun,,State University,Athletic Department Compliance,07 Sep 2026
Gus,Ott,https://www.linkedin.com/in/gusott,,Ott Consulting,Sports Marketing Consultant,06 Sep 2026
Hal,Ng,https://www.linkedin.com/in/halng,,Ng Dental,Dentist,05 Sep 2026
`;

function run(home, args) {
  const r = spawnSync(process.execPath, [REPO + 'tools/briefs/prospecting.js', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, BRIEFS_HOME: '', BRIEFS_MAIL_SOURCES: '' }, encoding: 'utf8', timeout: 60000 });
  return (r.stdout || '') + (r.stderr || '');
}
function setup(config, where) {
  const home = fs.mkdtempSync(_tp.join(os.tmpdir(), 'pd-test-'));
  const root = _tp.join(home, 'nildash-briefs');
  fs.mkdirSync(_tp.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(_tp.join(root, 'config.json'), JSON.stringify(Object.assign({ to: 'me@x.com', resendApiKey: 're_test', anthropicApiKey: 'sk-ant-test-0000000000', myAddresses: ['me@x.com'], prospectKeywords: ['sports', 'coach', 'marketing'], aboutMe: 'me' }, config)));
  if (where) fs.writeFileSync(_tp.join(root, where), CSV);
  return { home, root };
}

async function main() {
  // ── 1. THE ORIGINAL LAYOUT: connectionsFile set, the file at the root ────
  OUT.push('-- connectionsFile is honoured --');
  const a = setup({ connectionsFile: '~/nildash-briefs/Connections.csv' }, 'Connections.csv');
  const outA = run(a.home, ['--debug', '--dry']);
  ok('the config path is looked at first and found', /looked FOUND\s+config connectionsFile: .*nildash-briefs[\\/]Connections\.csv/.test(outA), outA.split('\n').filter((l) => /looked/.test(l)));
  ok('  "~" is expanded', !/looked .*~\//.test(outA));
  ok('  the file is read and the LinkedIn preamble is skipped', /header row at line 4 \(after 3 line\(s\) of LinkedIn preamble\)/.test(outA));
  ok('  the config is printed with secrets masked', /"prospectKeywords"/.test(outA) && /"resendApiKey": "re_tes…est"/.test(outA) && !/sk-ant-test-0000000000/.test(outA));
  ok('  the first five rows are printed', (outA.match(/\[prospecting:debug\]\s+row: /g) || []).length === 5 && /"first":"Ann","last":"Lee"/.test(outA));
  ok('  the count per keyword', /"sports": 2 match\(es\)/.test(outA) && /"coach": 1 match\(es\)/.test(outA) && /"marketing": 2 match\(es\)/.test(outA));
  ok('  and the total', /4 of 7 match at least one keyword/.test(outA));
  ok('  the exclusions, counted', /exclusions: 0 drafted on an earlier run \(0 in prospecting-done\.json\), 0 already in sent mail by address, 0 by name/.test(outA));
  ok('  the queue is listed', /next: Ann Lee \| NIL Agent @ Ridge Sports Agency/.test(outA) && /next: Gus Ott/.test(outA));
  ok('--dry drafts and sends nothing', /--dry: 7 connections, 4 matches, 4 in the queue, would draft 4\. Nothing drafted or sent\./.test(outA) && !/turn\(s\)|FAILED|archived |EMAIL/.test(outA), outA.split('\n').filter((l) => /--dry|turn|FAILED|archived|EMAIL/.test(l)));
  ok('  and writes no archive', !fs.readdirSync(a.root).some((f) => /prospecting\.md$/.test(f)));

  // ── 2. NO connectionsFile, THE FILE STILL AT THE ROOT ────────────────────
  OUT.push('', '-- the root is searched after the inbox --');
  const b = setup({}, 'Connections.csv');
  const outB = run(b.home, ['--debug', '--dry']);
  ok('the inbox is looked at and found empty', /looked nothing .*[\\/]inbox[\\/]\*\.csv \(0 csv file\(s\)\)/.test(outB));
  ok('  then the root, where the file is', /looked FOUND\s+.*nildash-briefs[\\/]\*\.csv \(1 csv file\(s\): Connections\.csv\)/.test(outB));
  ok('  and it drafts the same four', /would draft 4/.test(outB));
  const c = setup({}, _tp.join('inbox', 'Connections.csv'));
  ok('the inbox still wins when the file is there', /looked FOUND\s+.*[\\/]inbox[\\/]\*\.csv/.test(run(c.home, ['--debug', '--dry'])));

  // ── 3. WHY ZERO, EACH REASON NAMED ───────────────────────────────────────
  OUT.push('', '-- why zero --');
  const d = setup({ connectionsFile: '~/nildash-briefs/missing.csv' }, null);
  const outD = run(d.home, ['--debug', '--dry']);
  ok('no file anywhere: every place tried is listed and the reason is said', /looked nothing\s+config connectionsFile: .*missing\.csv/.test(outD) && /looked nothing .*inbox/.test(outD) && /why 0: no CSV was found in any of the places above/.test(outD), outD.split('\n').filter((l) => /looked|why 0/.test(l)));
  const e = setup({ prospectKeywords: ['astronaut'] }, 'Connections.csv');
  const outE = run(e.home, ['--debug', '--dry']);
  ok('no keyword matches: the reason names the keywords and shows sample positions', /"astronaut": 0 match\(es\)/.test(outE) && /why 0: no position or company contains any keyword; sample positions: "NIL Agent"/.test(outE));
  const f = setup({}, 'Connections.csv');
  fs.mkdirSync(_tp.join(f.root, 'state'), { recursive: true });
  fs.writeFileSync(_tp.join(f.root, 'state', 'prospecting-done.json'), JSON.stringify({ 'https://www.linkedin.com/in/annlee': '2026-09-01', 'https://www.linkedin.com/in/bobray': '2026-09-01', 'https://www.linkedin.com/in/caradiaz': '2026-09-01', 'https://www.linkedin.com/in/gusott': '2026-09-01' }));
  const outF = run(f.home, ['--debug', '--dry']);
  ok('all matches already drafted: the reason says so and how to reset', /exclusions: 4 drafted on an earlier run \(4 in prospecting-done\.json\)/.test(outF) && /why 0: every keyword match was excluded/.test(outF) && /Delete state\/prospecting-done\.json/.test(outF));
  const g = setup({}, 'notes.csv');
  fs.writeFileSync(_tp.join(g.root, 'notes.csv'), 'a,b,c\n1,2,3\n');
  const outG = run(g.home, ['--debug', '--dry']);
  ok('a CSV that is not a LinkedIn export is named as such', /NO "First Name" HEADER FOUND/.test(outG) && /why 0: the parser returned no rows/.test(outG));

  // ── 4. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const L = require(REPO + 'tools/briefs/lib.js');
  ok('connectionsFile has a default and a variable', 'connectionsFile' in L.configFromEnv({ BRIEFS_CONNECTIONS_FILE: '/x/y.csv' }) && L.ENV_MAP.BRIEFS_CONNECTIONS_FILE === 'connectionsFile');
  const src = fs.readFileSync(REPO + 'tools/briefs/prospecting.js', 'utf8');
  ok('mail is read through mail-source, like follow-ups', /const \{ readMail \} = require\('\.\/mail-source'\)/.test(src) && !/dumpMail\(/.test(src));
  ok('--no-email archives without sending', /if \(NO_EMAIL\) \{ L\.log\(KIND, `--no-email/.test(src));
  const readme = fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8');
  ok('the README documents connectionsFile and the flags', /connectionsFile/.test(readme) && /--debug --dry/.test(readme));
  for (const x of [a, b, c, d, e, f, g]) fs.rmSync(x.home, { recursive: true, force: true });

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
