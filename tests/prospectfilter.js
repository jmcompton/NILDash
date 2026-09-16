'use strict';
// No database, no network. `claude` is a stand-in script that answers by the
// person's name, so each filter reason is exercised once, and mail is sent
// nowhere (--no-email).
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/prospectfilter.js     just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const REPO = _tp.join(__dirname, '..') + _tp.sep;

// ── THE QUALITY FILTER AND --exclude ─────────────────────────────────────────
//
// A researched person is drafted or filtered: filtered when the research says
// not US-based, not in US sports markets, or when no opener came back. The
// brief says "N drafted, M filtered" and lists each reason. A research call
// that failed is filtered too but not recorded, so it is retried next run.
// --exclude skips people by name, URL or handle for one run, recording nothing.

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

// What the stand-in claude answers, by name. Dan's call fails outright.
const FAKE = `
  let stdin = ''; process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', () => {
    const name = (stdin.match(/PERSON: ([^,]+),/) || [])[1] || '';
    const by = {
      'Ann Lee': { summary: 'Runs Ridge Sports Agency in Dallas.', location: 'Dallas, TX', usBased: true, usSportsMarket: true, hook: 'agency', opener: 'Ann, I build NILDash. Would a look be useful?' },
      'Bob Ray': { summary: 'Assistant coach at Auburn.', location: 'Auburn, AL', usBased: true, usSportsMarket: true, hook: null, opener: '' },
      'Cara Diaz': { summary: 'Marketing director at a consumer brand in London.', location: 'London, UK', usBased: false, usSportsMarket: false, hook: null, opener: null },
      'Eve Sun': { summary: 'Nothing found beyond the LinkedIn title.', location: null, usBased: null, usSportsMarket: null, hook: null, opener: 'Eve, we are connected here and I build NILDash. Is compliance tooling on your radar?' },
      'Gus Ott': { summary: 'Consults for European football clubs from Denver.', location: 'Denver, CO', usBased: true, usSportsMarket: false, hook: null, opener: null },
    };
    if (name === 'Dan Fox') { process.stderr.write('boom'); process.exit(1); }
    process.stdout.write(JSON.stringify({ result: JSON.stringify(by[name] || { summary: 'unknown ' + name }), session_id: 'fake', num_turns: 2, total_cost_usd: 0.01 }));
  });`;

function setup(extra) {
  const home = fs.mkdtempSync(_tp.join(os.tmpdir(), 'pf-test-'));
  const root = _tp.join(home, 'nildash-briefs');
  fs.mkdirSync(_tp.join(root, 'inbox'), { recursive: true });
  const fake = _tp.join(home, 'fake-claude.js'); fs.writeFileSync(fake, FAKE);
  const wrapper = _tp.join(home, 'claude'); fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(_tp.join(root, 'config.json'), JSON.stringify(Object.assign({
    to: 'me@x.com', resendApiKey: 're_test', anthropicApiKey: 'sk-ant-test-0000000000', myAddresses: ['me@x.com'], aboutMe: 'me',
    prospectKeywords: ['sports', 'coach', 'marketing', 'owner', 'compliance'], claudeBin: wrapper,
  }, extra || {})));
  fs.writeFileSync(_tp.join(root, 'Connections.csv'), CSV);
  return { home, root };
}
function run(home, args) {
  const r = spawnSync(process.execPath, [REPO + 'tools/briefs/prospecting.js', ...args], { env: { ...process.env, HOME: home, USERPROFILE: home, BRIEFS_HOME: '', BRIEFS_MAIL_SOURCES: '' }, encoding: 'utf8', timeout: 120000 });
  return (r.stdout || '') + (r.stderr || '');
}
const briefOf = (root) => { const f = fs.readdirSync(root).find((x) => /prospecting\.md$/.test(x)); return f ? fs.readFileSync(_tp.join(root, f), 'utf8') : ''; };
const stateOf = (root) => { try { return JSON.parse(fs.readFileSync(_tp.join(root, 'state', 'prospecting-done.json'), 'utf8')); } catch (_) { return null; } };

async function main() {
  // ── 1. EACH REASON ONCE ──────────────────────────────────────────────────
  OUT.push('-- the quality filter --');
  const a = setup();
  const outA = run(a.home, ['--no-email']);
  const briefA = briefOf(a.root);
  ok('six researched: two drafted, four filtered', /drafted 2, filtered 4 \(/.test(outA), outA.split('\n').filter((l) => /drafted|filtered|FAILED/.test(l)));
  ok('  the breakdown names each reason once', /1 no opener generated/.test(outA) && /1 not US-based/.test(outA) && /1 not working in US sports markets/.test(outA) && /1 research failed/.test(outA));
  ok('  the subject carries both counts', /--no-email: "Prospects: 2 drafted, 4 filtered" archived, not sent/.test(outA));
  ok('the brief heads with both counts', /^# Prospects: 2 drafted, 4 filtered$/m.test(briefA));
  ok('  and says how many were researched', /6 researched this run: 2 drafted, 4 filtered \(/.test(briefA));
  ok('  a Filtered section lists each with the reason', /## Filtered \(4\)/.test(briefA) && /- \*\*Bob Ray\*\* · Assistant Coach, Auburn Athletics · https:\/\/www\.linkedin\.com\/in\/bobray: no opener generated/.test(briefA), briefA.split('\n').filter((l) => /^- \*\*/.test(l)));
  ok('  not US-based, with the place the research found', /- \*\*Cara Diaz\*\*.*: not US-based \(London, UK\) \| Marketing director/.test(briefA));
  ok('  not in US sports markets, even though US-based', /- \*\*Gus Ott\*\*.*: not working in US sports markets \(Denver, CO\)/.test(briefA));
  ok('  a failed call is filtered and marked for retry', /- \*\*Dan Fox\*\*.*: research failed: claude exited 1.*\(will be retried next run\)/.test(briefA));
  ok('the drafted two have their openers', /## Ann Lee · NIL Agent, Ridge Sports Agency/.test(briefA) && /Ann, I build NILDash\./.test(briefA) && /## Eve Sun/.test(briefA));
  ok('  unknown location and market do not filter (Eve)', /Eve, we are connected here/.test(briefA));
  ok('  the drafted row shows the place found', /\*\*Who:\*\* Runs Ridge Sports Agency in Dallas\. \(Dallas, TX\)/.test(briefA));
  ok('  nobody filtered gets a draft section or a "(no opener)" block', !/## Bob Ray/.test(briefA) && !/## Cara Diaz/.test(briefA) && !/\(no opener\)/.test(briefA));
  const stA = stateOf(a.root) || {};
  ok('the state records drafted and filtered people, with the reason', /^\d{4}-\d\d-\d\d$/.test(stA['https://www.linkedin.com/in/annlee'] || '') && /filtered: no opener generated/.test(stA['https://www.linkedin.com/in/bobray'] || '') && /filtered: not US-based/.test(stA['https://www.linkedin.com/in/caradiaz'] || ''), stA);
  ok('  but not the failed call, so Dan is retried', !('https://www.linkedin.com/in/danfox' in stA));
  ok('  the next run has only Dan left', /would research 1\./.test(run(a.home, ['--dry'])));

  // ── 2. --exclude ─────────────────────────────────────────────────────────
  OUT.push('', '-- --exclude --');
  const b = setup();
  const outB = run(b.home, ['--no-email', '--debug', '--exclude', 'Ann Lee,linkedin.com/in/caradiaz,GUSOTT', '--exclude=Nobody Real']);
  const briefB = briefOf(b.root);
  ok('a name, a bare URL and a handle each skip their person', /--exclude: 4 item\(s\), 3 skipped this run, 1 matched nobody/.test(outB), outB.split('\n').filter((l) => /exclude/.test(l)));
  ok('  --debug says who and by which item', /excluded this run: Ann Lee \(--exclude "Ann Lee"\)/.test(outB) && /excluded this run: Cara Diaz \(--exclude "linkedin\.com\/in\/caradiaz"\)/.test(outB) && /excluded this run: Gus Ott \(--exclude "GUSOTT"\)/.test(outB));
  ok('  an item matching nobody is a warning in the brief', /--exclude did not match any connection in the CSV: "Nobody Real"/.test(briefB));
  ok('  the rest are researched: one drafted, two filtered', /drafted 1, filtered 2/.test(outB) && /^# Prospects: 1 drafted, 2 filtered$/m.test(briefB));
  ok('  the brief reports the excluded separately, by name', /3 skipped by --exclude \(Ann Lee, Cara Diaz, Gus Ott\)/.test(briefB));
  const stB = stateOf(b.root) || {};
  ok('  nothing is recorded for excluded people', !('https://www.linkedin.com/in/annlee' in stB) && !('https://www.linkedin.com/in/caradiaz' in stB) && !('https://www.linkedin.com/in/gusott' in stB) && ('https://www.linkedin.com/in/evesun' in stB), Object.keys(stB));
  ok('  so they are back in the queue next run', /would research 4\./.test(run(b.home, ['--dry'])));
  const c = setup();
  const outC = run(c.home, ['--dry', '--exclude=https://www.linkedin.com/in/bobray/']);
  ok('--dry counts the excluded without researching', /--dry: 7 connections, 6 matches, 1 excluded by --exclude, 5 in the queue, would research 5\./.test(outC), outC.split('\n').filter((l) => /--dry/.test(l)));

  // ── 3. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = fs.readFileSync(REPO + 'tools/briefs/prospecting.js', 'utf8');
  ok('the prompt asks for location, usBased and usSportsMarket', /"usBased": true or false, or null/.test(src) && /"usSportsMarket": true when/.test(src) && /null when usBased or usSportsMarket is false/.test(src));
  ok('only a clear false filters; null is unknown and drafts', /if \(j\.usBased === false\)/.test(src) && /if \(j\.usSportsMarket === false\)/.test(src));
  const readme = fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8');
  ok('the README documents the filter and --exclude', /N drafted, M filtered/.test(readme) && /--exclude "Ann Lee/.test(readme));
  for (const x of [a, b, c]) fs.rmSync(x.home, { recursive: true, force: true });

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
