'use strict';
// No database, no network. HOME is pointed at a scratch directory BEFORE the
// briefs library loads, and `claude` is replaced by a small script that
// reports the environment it was spawned with, so this proves what the real
// binary would receive without calling anything.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/briefsauth.js       just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const SCRATCH = fs.mkdtempSync(_tp.join(os.tmpdir(), 'ba-test-'));
process.env.HOME = SCRATCH;
process.env.USERPROFILE = SCRATCH;
delete process.env.ANTHROPIC_API_KEY;

// ── THE BRIEFS RUN ON AN API KEY: CONFIG.JSON FIRST, THE ENVIRONMENT SECOND,
//    A CLEAR FAILURE THIRD ──────────────────────────────────────────────────
//
// The CLI's own OAuth login expired once and every brief failed. Now the key
// is resolved before claude is spawned, from ~/nildash-briefs/config.json
// (anthropicApiKey) or ANTHROPIC_API_KEY, and the child gets exactly that
// key and no other credential path. Nothing prints the key.

const L = require(REPO + 'tools/briefs/lib.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const CONFIG = _tp.join(SCRATCH, 'nildash-briefs', 'config.json');
const FAKE_CLAUDE = _tp.join(SCRATCH, 'fake-claude.js');
const CFG_KEY = 'sk-ant-api03-FROM-CONFIG-0000000000000000000000000000000000000000cfg1';
const ENV_KEY = 'sk-ant-api03-FROM-ENV-000000000000000000000000000000000000000000env2';

function writeConfig(o) { fs.writeFileSync(CONFIG, JSON.stringify(Object.assign({ to: 'me@x.com', claudeBin: process.execPath }, o || {}), null, 2)); }

async function main() {
  fs.mkdirSync(_tp.dirname(CONFIG), { recursive: true });
  // The stand-in for `claude`: prints, as the CLI's JSON envelope, the key it
  // was handed and which other credential variables reached it.
  fs.writeFileSync(FAKE_CLAUDE, `
    let stdin = ''; process.stdin.on('data', (d) => { stdin += d; }); process.stdin.on('end', () => {
      const seen = ['ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_USE_BEDROCK','AWS_ACCESS_KEY_ID'].filter((k) => process.env[k]);
      const result = JSON.stringify({ key: process.env.ANTHROPIC_API_KEY || null, others: seen, args: process.argv.slice(2), prompt: stdin.slice(0, 40) });
      process.stdout.write(JSON.stringify({ result, session_id: 'fake-1', num_turns: 1, total_cost_usd: 0 }));
    });`);

  // ── 1. RESOLUTION ORDER ──────────────────────────────────────────────────
  OUT.push('-- where the key comes from --');
  writeConfig({});
  let threw = null;
  try { L.resolveApiKey(L.loadConfig()); } catch (e) { threw = e; }
  ok('no key anywhere: a clear error naming both places', !!threw && /No Anthropic API key/.test(threw.message) && threw.message.includes(CONFIG) && /ANTHROPIC_API_KEY/.test(threw.message) && /claude was not started/.test(threw.message), threw && threw.message);
  process.env.ANTHROPIC_API_KEY = ENV_KEY;
  const fromEnv = L.resolveApiKey(L.loadConfig());
  ok('environment only: the environment key', fromEnv.key === ENV_KEY && fromEnv.source === 'environment', fromEnv.source);
  writeConfig({ anthropicApiKey: CFG_KEY });
  const fromCfg = L.resolveApiKey(L.loadConfig());
  ok('both set: config.json wins', fromCfg.key === CFG_KEY && fromCfg.source === 'config.json', fromCfg.source);
  writeConfig({ anthropicApiKey: '   ' });
  ok('a blank config value falls through to the environment', L.resolveApiKey(L.loadConfig()).source === 'environment');
  ok('the masked form shows a prefix and four characters, never the key', fromCfg.masked === 'sk-ant-…cfg1' && !fromCfg.masked.includes('FROM-CONFIG'), fromCfg.masked);

  // ── 2. WHAT THE CHILD RECEIVES ───────────────────────────────────────────
  OUT.push('', '-- the spawn --');
  process.env.ANTHROPIC_AUTH_TOKEN = 'oauth-stale-token';
  process.env.ANTHROPIC_BASE_URL = 'https://proxy.example';
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  writeConfig({ anthropicApiKey: CFG_KEY, claudeBin: process.execPath });
  // claudeBin is node itself; the fake script rides in as the first argument
  // through a tiny wrapper so the library's argv is untouched.
  const wrapper = _tp.join(SCRATCH, 'claude');
  fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`); fs.chmodSync(wrapper, 0o755);
  writeConfig({ anthropicApiKey: CFG_KEY, claudeBin: wrapper });
  const r = await L.claudeP('ping', { cfg: L.loadConfig(), label: 't', maxTurns: 3, tools: [] });
  const got = JSON.parse(r.text);
  ok('the child gets the config.json key in ANTHROPIC_API_KEY', got.key === CFG_KEY, got.key && got.key.slice(0, 12));
  ok('  and none of the other credential paths', got.others.length === 0, got.others);
  ok('  with --max-turns and the json format as before', got.args.includes('--max-turns') && got.args.includes('3') && got.args.includes('json'), got.args);
  ok('  the prompt still arrives on stdin', got.prompt === 'ping');
  ok('the result says where the key came from', r.keySource === 'config.json', r.keySource);
  writeConfig({ claudeBin: wrapper });
  const r2 = await L.claudeP('ping', { cfg: L.loadConfig(), label: 't', maxTurns: 1, tools: [] });
  ok('with no config key the environment key is handed over', JSON.parse(r2.text).key === ENV_KEY && r2.keySource === 'environment');
  delete process.env.ANTHROPIC_API_KEY;
  let spawnErr = null;
  try { await L.claudeP('ping', { cfg: L.loadConfig(), label: 't', maxTurns: 1, tools: [] }); } catch (e) { spawnErr = e; }
  ok('with no key at all claude is never spawned', !!spawnErr && /No Anthropic API key/.test(spawnErr.message), spawnErr && spawnErr.message);

  // ── 3. THE AUDIT LINE ────────────────────────────────────────────────────
  OUT.push('', '-- the audit line --');
  writeConfig({ anthropicApiKey: CFG_KEY });
  const a = L.authAudit(L.loadConfig());
  ok('names the source and the masked key', /^auth: API key sk-ant-…cfg1 from config\.json;/.test(a.line), a.line);
  ok('  never the key', !a.line.includes('FROM-CONFIG'));
  ok('  lists the credential variables it removed', /other credential env removed \([^)]*ANTHROPIC_AUTH_TOKEN[^)]*ANTHROPIC_BASE_URL[^)]*CLAUDE_CODE_USE_BEDROCK/.test(a.line) && a.removedEnv.includes('ANTHROPIC_AUTH_TOKEN'), a.line);
  writeConfig({});
  ok('with no key the line says so', /^auth: NO API KEY/.test(L.authAudit(L.loadConfig()).line));

  // ── 4. NOTHING HARD-CODED, AND THE WIRING ────────────────────────────────
  OUT.push('', '-- the wiring --');
  const files = ['lib.js', 'follow-ups.js', 'news-watch.js', 'prospecting.js', 'strategy-watch.js', 'mail-dump.js', 'config.example.json', 'crontab.example', 'README.md'];
  const realKey = /sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/;
  ok('no file in tools/briefs holds a real-looking key', files.every((f) => !realKey.test(fs.readFileSync(REPO + 'tools/briefs/' + f, 'utf8'))), files.filter((f) => realKey.test(fs.readFileSync(REPO + 'tools/briefs/' + f, 'utf8'))));
  const ex = JSON.parse(fs.readFileSync(REPO + 'tools/briefs/config.example.json', 'utf8'));
  ok('the example config shows the field with a placeholder', /^sk-ant-PASTE/.test(ex.anthropicApiKey));
  const cron = fs.readFileSync(REPO + 'tools/briefs/crontab.example', 'utf8');
  ok('the crontab no longer strips ANTHROPIC_API_KEY', !/env -u ANTHROPIC_API_KEY/.test(cron) && /strategy-watch\.js/.test(cron));
  const readme = fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8');
  ok('the README explains the order and the failure', /config\.json.*first.*environment.*second/i.test(readme.replace(/\n/g, ' ')) && /No Anthropic API key/.test(readme));
  const lib = fs.readFileSync(REPO + 'tools/briefs/lib.js', 'utf8');
  ok('the key is resolved before the spawn in claudeP', /const ce = claudeEnv\(cfg\);[\s\S]*?spawn\(cfg\.claudeBin, args, \{ env: ce\.env/.test(lib));
  ok('--claude-test prints the source, not the key', /RESULT: PASS\. claude -p runs from here on the API key from \$\{r\.keySource\}/.test(lib) && !/console\.log\([^)]*\.key\b/.test(lib));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
