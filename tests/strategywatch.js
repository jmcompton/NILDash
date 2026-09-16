'use strict';
// No database, no network, no claude: the brief's search and email calls are
// stubbed. HOME is pointed at a scratch directory BEFORE the briefs library
// loads, so the real ~/nildash-briefs is never touched.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/strategywatch.js      just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const SCRATCH = fs.mkdtempSync(_tp.join(os.tmpdir(), 'sw-test-'));
process.env.HOME = SCRATCH;
process.env.USERPROFILE = SCRATCH;

// ── STRATEGY WATCH SENDS ONLY WHEN SOMETHING MEANINGFUL CHANGED ─────────────
//
// Three Haiku searches, each item tagged meaningful or not; a quiet run sends
// nothing and changes nothing; a run with movement emails one page, writes
// the date and the URLs into config.json, and the next run repeats none of it.

const L = require(REPO + 'tools/briefs/lib.js');
const SW = require(REPO + 'tools/briefs/strategy-watch.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const CONFIG = _tp.join(SCRATCH, 'nildash-briefs', 'config.json');
const today = L.today();

function writeConfig(extra) {
  fs.writeFileSync(CONFIG, JSON.stringify(Object.assign({ to: 'me@x.com', from: 'Briefs <b@x.com>', resendApiKey: 're_x', keepMe: 'untouched' }, extra || {}), null, 2));
}
function makeStub(answers) {
  const calls = [];
  const claudeP = async (prompt, opts) => {
    calls.push({ prompt, opts });
    const a = answers(opts.label, prompt);
    return { text: typeof a === 'string' ? a : JSON.stringify(a), json: typeof a === 'string' ? null : a, sessionId: 's-' + calls.length, numTurns: 2, ms: 1200 };
  };
  const sent = [];
  const sendBrief = async (cfg, m) => { sent.push(m); return { data: { id: 'r1' } }; };
  return { claudeP, sendBrief, calls, sent };
}
const ITEMS = {
  'strategy:legislation': [
    { title: 'Senate Commerce schedules markup of S. 4668', url: 'https://example.com/leg/markup?utm_source=x', source: 'Sportico', published: today, kind: 'committee', meaningful: true, line: 'The Senate Commerce Committee scheduled a markup of the Protect College Sports Act for next week, which would preempt state NIL laws and set federal agent registration.' },
    { title: 'Explainer: what is NIL', url: 'https://example.com/leg/explainer', source: 'Blog', published: today, kind: 'other', meaningful: false, line: 'A general explainer.' },
    { title: 'Texas agent registration amendment adopted', url: 'https://example.com/leg/texas', source: 'Texas Tribune', published: today, kind: 'amendment', meaningful: true, line: 'Texas adopted an amendment requiring NIL agents to register with the state before representing a college athlete.' },
  ],
  'strategy:competitors': [
    { title: 'Basepath raises $12M', url: 'https://example.com/comp/basepath', source: 'TechCrunch', published: today, kind: 'funding', meaningful: true, line: 'Basepath raised $12M for collective and school NIL management; adjacent, it does not find businesses for agents.' },
    { title: 'AgentDesk launches NIL CRM for agents', url: 'https://example.com/comp/agentdesk', source: 'PRNewswire', published: today, kind: 'launch', meaningful: true, line: 'AgentDesk launched a CRM that finds local sponsors for an agent\'s athletes and drafts outreach; competes.' },
    { title: 'AgentDesk launches (syndicated)', url: 'https://EXAMPLE.com/comp/agentdesk/#top', source: 'Yahoo', published: today, kind: 'launch', meaningful: true, line: 'Same announcement.' },
    { title: 'Old news', url: 'https://example.com/comp/old', source: 'X', published: '2020-01-01', kind: 'launch', meaningful: true, line: 'Something from years ago.' },
    { title: 'No url', url: '', source: 'X', published: today, kind: 'launch', meaningful: true, line: 'Missing its link.' },
  ],
  'strategy:market': [
    { title: 'CSC publishes first quarterly NIL deal report', url: 'https://example.com/mkt/csc', source: 'College Sports Commission', published: today, kind: 'csc', meaningful: true, line: 'The College Sports Commission published its first quarterly report on cleared NIL deals, with median deal values by sport.' },
  ],
};
const PARA = 'The Senate Commerce Committee has scheduled a markup of S. 4668 for next week, and Texas adopted an amendment requiring NIL agents to register with the state before representing a college athlete. For agents, federal preemption would replace a patchwork of state rules with one registration regime, while the Texas change takes effect first.';

async function main() {
  fs.mkdirSync(_tp.dirname(CONFIG), { recursive: true });

  // ── 1. A QUIET RUN SENDS NOTHING AND CHANGES NOTHING ─────────────────────
  OUT.push('-- a quiet run --');
  writeConfig();
  const quiet = makeStub((label) => (label.startsWith('strategy:') && !label.includes('paragraph') ? [{ title: 'Explainer', url: 'https://example.com/e', source: 'Blog', published: today, kind: 'other', meaningful: false, line: 'nothing moved' }] : ''));
  const r1 = await SW.run({ claudeP: quiet.claudeP, sendBrief: quiet.sendBrief, configPath: CONFIG });
  ok('nothing meaningful: not sent', r1.sent === false && r1.total === 0 && quiet.sent.length === 0, r1);
  ok('  three searches ran, on the configured DeepSeek model, with web tools, capped in turns', quiet.calls.length === 3 && quiet.calls.every((c) => c.opts.model === null && c.opts.tools.includes('WebSearch') && c.opts.maxTurns === 4), quiet.calls.map((c) => c.opts.label));
  ok('  looking back 7 days on a first run', quiet.calls.every((c) => c.prompt.includes('since ' + L.dateOffset(-7))));
  ok('  each search asks for the meaningful flag and the fixed kinds', quiet.calls.every((c) => /"meaningful": true or false/.test(c.prompt)) && /"vote","amendment","committee"/.test(quiet.calls[0].prompt));
  const cfgAfter1 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  ok('  config.json untouched', cfgAfter1.keepMe === 'untouched' && !cfgAfter1.strategyWatch, cfgAfter1);
  ok('  no archive written', !fs.readdirSync(_tp.join(SCRATCH, 'nildash-briefs')).some((f) => /strategy-watch\.md$/.test(f)));

  // ── 2. MOVEMENT: ONE EMAIL, UNDER A PAGE, DATE AND URLS WRITTEN BACK ──────
  OUT.push('', '-- a run with movement --');
  const live = makeStub((label) => (label === 'strategy:legislation-paragraph' ? PARA : ITEMS[label] || []));
  const r2 = await SW.run({ claudeP: live.claudeP, sendBrief: live.sendBrief, configPath: CONFIG });
  ok('sent once', r2.sent === true && live.sent.length === 1, r2);
  ok('  five changes: 2 legislation, 2 competitors (dupe, old, no-url dropped), 1 market', r2.total === 5, r2.total);
  const m = live.sent[0];
  ok('  subject counts the changes', m.subject === 'Strategy watch: 5 changes', m.subject);
  ok('  legislation is one paragraph with the sources linked', /## Legislation\n\n[^\n]*Senate Commerce[^\n]*Sources: \[Sportico\]\(https:\/\/example\.com\/leg\/markup\?utm_source=x\), \[Texas Tribune\]\(https:\/\/example\.com\/leg\/texas\)\./.test(m.markdown), m.markdown.split('\n').slice(0, 8));
  ok('  competitors: one line per item, the competing one says so', /## Competitors\n\n- \*\*/.test(m.markdown) && /- \*\*AgentDesk launches NIL CRM for agents\*\* — [^\n]*competes/.test(m.markdown) && /- \*\*Basepath raises \$12M\*\* — [^\n]*adjacent/.test(m.markdown));
  ok('  the syndicated duplicate appears once', (m.markdown.match(/^- \*\*AgentDesk/gm) || []).length === 1 && !/syndicated/.test(m.markdown), (m.markdown.match(/^- \*\*AgentDesk/gm) || []).length);
  ok('  market: the CSC report', /## Market signals\n\n- \*\*CSC publishes first quarterly NIL deal report\*\*/.test(m.markdown));
  ok('  the explainer, the old item and the url-less item are out', !/Explainer/.test(m.markdown) && !/Old news/.test(m.markdown) && !/No url/.test(m.markdown));
  ok('  the counts line says what was dropped', /1 not meaningful/.test(m.markdown) && /0 already shown/.test(m.markdown), m.markdown.match(/_\d+ found[^\n]*/));
  const body = m.markdown.split('\n---')[0];
  ok('  under one page', body.split('\n').length <= 30 && body.length <= 3500, [body.split('\n').length, body.length]);
  ok('  the paragraph call ran on the configured model with no tools and one turn', live.calls.some((c) => c.opts.label === 'strategy:legislation-paragraph' && c.opts.model === null && !c.opts.tools && c.opts.maxTurns === 1));
  const cfgAfter2 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  ok('config.json now carries lastSentAt = today', cfgAfter2.strategyWatch && cfgAfter2.strategyWatch.lastSentAt === today, cfgAfter2.strategyWatch);
  ok('  and the five urls, canonical (no utm, no hash, lower-case host)', cfgAfter2.strategyWatch.seen['https://example.com/leg/markup'] === today && cfgAfter2.strategyWatch.seen['https://example.com/comp/agentdesk'] === today && Object.keys(cfgAfter2.strategyWatch.seen).length === 5, Object.keys(cfgAfter2.strategyWatch.seen));
  ok('  everything else in config.json survived', cfgAfter2.keepMe === 'untouched' && cfgAfter2.to === 'me@x.com');
  ok('  the archive was written', fs.readdirSync(_tp.join(SCRATCH, 'nildash-briefs')).some((f) => f === `${today}-strategy-watch.md`));

  // ── 3. THE NEXT RUN REPEATS NOTHING ──────────────────────────────────────
  OUT.push('', '-- the next run --');
  const again = makeStub((label) => (label === 'strategy:legislation-paragraph' ? PARA : ITEMS[label] || []));
  const r3 = await SW.run({ claudeP: again.claudeP, sendBrief: again.sendBrief, configPath: CONFIG });
  ok('the same items again: nothing sent', r3.sent === false && r3.total === 0 && again.sent.length === 0, r3);
  ok('  looked back only to the last send', again.calls.every((c) => c.prompt.includes('since ' + today)));
  ok('  counted as already shown (the syndicated copy counts too: same url)', r3.counts.alreadyShown === 6, r3.counts);
  // One new item on top of the old ones: only it goes out.
  const one = makeStub((label) => (label === 'strategy:market' ? ITEMS[label].concat([{ title: 'Agency X opens NIL division', url: 'https://example.com/mkt/agencyx', source: 'SBJ', published: today, kind: 'agency', meaningful: true, line: 'Agency X opened an NIL division and signed three quarterbacks.' }]) : label === 'strategy:legislation-paragraph' ? PARA : ITEMS[label] || []));
  const r4 = await SW.run({ claudeP: one.claudeP, sendBrief: one.sendBrief, configPath: CONFIG });
  ok('one new item: one email with only that item', r4.sent === true && r4.total === 1 && one.sent[0].subject === 'Strategy watch: 1 change' && /Agency X/.test(one.sent[0].markdown) && !/AgentDesk/.test(one.sent[0].markdown), r4.total);
  ok('  no legislation section when nothing moved there', !/## Legislation/.test(one.sent[0].markdown));

  // ── 4. THE PARAGRAPH FALLS BACK WHEN HAIKU RETURNS JUNK ──────────────────
  OUT.push('', '-- the paragraph --');
  writeConfig();
  const junk = makeStub((label) => (label === 'strategy:legislation-paragraph' ? '[{"x":1}]' : label === 'strategy:legislation' ? ITEMS[label] : []));
  const r5 = await SW.run({ claudeP: junk.claudeP, sendBrief: junk.sendBrief, configPath: CONFIG });
  ok('junk paragraph: the items\' own sentences are used, sources still linked', r5.sent && /The Senate Commerce Committee scheduled a markup[^\n]*Texas adopted an amendment[^\n]*Sources: \[Sportico\]/.test(junk.sent[0].markdown), junk.sent[0] && junk.sent[0].markdown.split('\n')[4]);
  writeConfig();
  const long = makeStub((label) => (label === 'strategy:legislation-paragraph' ? Array(200).fill('word').join(' ') : label === 'strategy:legislation' ? ITEMS[label] : []));
  await SW.run({ claudeP: long.claudeP, sendBrief: long.sendBrief, configPath: CONFIG });
  ok('a paragraph too long is not used either', long.sent.length === 1 && /Sources: \[Sportico\]/.test(long.sent[0].markdown) && !/word word word/.test(long.sent[0].markdown), long.sent[0] && long.sent[0].markdown.split('\n')[4]);

  // ── 5. FLAGS AND FAILURES ────────────────────────────────────────────────
  OUT.push('', '-- flags --');
  writeConfig({ strategyWatch: { lastSentAt: '2026-09-01', seen: {} } });
  const ne = makeStub((label) => (label === 'strategy:legislation-paragraph' ? PARA : ITEMS[label] || []));
  const r6 = await SW.run({ claudeP: ne.claudeP, sendBrief: ne.sendBrief, configPath: CONFIG, noEmail: true, since: '2026-08-15' });
  ok('--since overrides the look-back', ne.calls.filter((c) => c.opts.tools).every((c) => c.prompt.includes('since 2026-08-15')) && ne.calls.filter((c) => c.opts.tools).length === 3);
  ok('--no-email builds but does not send or move the date', r6.sent === false && r6.total === 5 && ne.sent.length === 0 && JSON.parse(fs.readFileSync(CONFIG, 'utf8')).strategyWatch.lastSentAt === '2026-09-01');
  const failing = makeStub((label) => { if (label === 'strategy:competitors') throw new Error('claude killed after 6 min'); return label === 'strategy:legislation-paragraph' ? PARA : ITEMS[label] || []; });
  writeConfig();
  const r7 = await SW.run({ claudeP: failing.claudeP, sendBrief: failing.sendBrief, configPath: CONFIG });
  ok('a failed search is named in the brief and does not stop the others', r7.sent && r7.errors.length === 1 && /Searches that failed[\s\S]*Competitors: claude killed/.test(failing.sent[0].markdown) && r7.total === 3, r7);
  const forced = makeStub(() => []);
  writeConfig();
  const r8 = await SW.run({ claudeP: forced.claudeP, sendBrief: forced.sendBrief, configPath: CONFIG, force: true });
  ok('--force sends a pipe test on a quiet day', r8.sent && /pipe test/.test(forced.sent[0].subject), forced.sent[0] && forced.sent[0].subject);

  // ── 6. THE WIRING ────────────────────────────────────────────────────────
  OUT.push('', '-- wiring --');
  const cron = fs.readFileSync(REPO + 'tools/briefs/crontab.example', 'utf8');
  ok('the cron line runs it like the other three', /^15 6 \* \* \*\s+\$NODE \$REPO\/tools\/briefs\/strategy-watch\.js/m.test(cron), cron.split('\n').filter((l) => /strategy-watch/.test(l)));
  ok('the library defaults carry maxTurns.strategy', L.loadConfig().maxTurns.strategy === 4);
  const ex = JSON.parse(fs.readFileSync(REPO + 'tools/briefs/config.example.json', 'utf8'));
  ok('the example config shows the state block', ex.strategyWatch && 'lastSentAt' in ex.strategyWatch && ex.maxTurns.strategy === 4);
  ok('the README lists it and says when it sends', /strategy-watch\.js/.test(fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8')) && /## Strategy watch: when it sends/.test(fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8')));
  const src = fs.readFileSync(REPO + 'tools/briefs/strategy-watch.js', 'utf8');
  ok('the recipient is the shared config (john@comptongroupllc.com by default), not hard-coded here', !/comptongroupllc/.test(src) && /to: 'john@comptongroupllc\.com'/.test(fs.readFileSync(REPO + 'tools/briefs/lib.js', 'utf8')));
  ok('nothing here is an API key', !/sk-ant|ANTHROPIC_API_KEY\s*=/.test(src));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
