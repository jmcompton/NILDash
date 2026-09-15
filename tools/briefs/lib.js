'use strict';
// ── SHARED BY THE FOUR OVERNIGHT BRIEFS ──────────────────────────────────────
//
// These run on a Mac, under cron. Every model call goes through `claude -p`
// with an Anthropic API KEY, read from ~/nildash-briefs/config.json
// (anthropicApiKey) first and from ANTHROPIC_API_KEY in the environment
// second; with neither, nothing runs and the error says what to set. The
// CLI's own login (the OAuth session) is not used: it expired once and every
// brief failed with "OAuth access token is invalid", so the briefs no longer
// depend on it. No key is written anywhere in this repository.
//
// Two guardrails are enforced here and cannot be forgotten by a caller:
//
//   1. The child's environment is rebuilt: the CLI's other credential paths
//      (bearer tokens, Bedrock, Vertex) are removed so the key chosen above is
//      the only way it can authenticate, and the key itself never appears in
//      a log, a footer or an error.
//   2. Every call carries --max-turns and a wall-clock kill, so a runaway
//      prompt cannot eat the day's budget.
//
// Nothing here sends mail on anyone's behalf except the brief itself, to the
// owner, through Resend. Nothing posts, replies, or touches a contact.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOME = os.homedir();
const ROOT = path.join(HOME, 'nildash-briefs');
const DIRS = {
  root: ROOT,
  inbox: path.join(ROOT, 'inbox'),
  state: path.join(ROOT, 'state'),
  logs: path.join(ROOT, 'logs'),
};
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });

const CONFIG_PATH = path.join(ROOT, 'config.json');
const DEFAULTS = {
  // Who the briefs go to, and who "I" am when reading sent mail.
  to: 'john@comptongroupllc.com',
  from: 'NILDash Briefs <noreply@mynildash.com>',
  myAddresses: [],                 // every address you send from, lowercase
  mailAccounts: [],                // Mail.app account names; [] = every account
  resendApiKey: '',                // same key NILDash uses on Railway
  anthropicApiKey: '',             // the key claude -p runs on; ANTHROPIC_API_KEY in the environment is the fallback
  // follow-ups
  lookbackDays: 60,
  silentDays: 7,
  // follow-ups: never listed, and listed apart
  skipDomains: ['comptonsales.com', 'comptongroupllc.com', 'mynildash.com', 'reply.mynildash.com', 'samford.edu'],
  nildashUsers: [],
  // prospecting
  prospectKeywords: ['agent', 'agency', 'nil', 'collective', 'athlete representation',
    'sports marketing', 'player management', 'athletic department', 'sports management'],
  prospectsPerRun: 20,
  aboutMe: 'I am JohnMark Compton, founder of NILDash, software that runs local NIL outreach for sports agents: '
    + 'it finds businesses near an athlete, writes the pitch, and keeps the agent compliant.',
  // news
  newsTerms: ['NIL platform', 'NIL agent software', 'Opendorse', 'Duffl', 'SponsorFlo', 'INFLCR', 'NIL collective technology'],
  newsLines: 10,
  // guardrails
  maxTurns: { followups: 2, news: 4, prospect: 5, strategy: 4 },
  // strategy-watch: written back by the script itself after each send
  strategyWatch: { lastSentAt: null, seen: {} },
  callTimeoutMin: 6,
  claudeBin: 'claude',
};

function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  const out = Object.assign({}, DEFAULTS, cfg);
  out.maxTurns = Object.assign({}, DEFAULTS.maxTurns, cfg.maxTurns || {});
  out.myAddresses = (out.myAddresses || []).map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  return out;
}

// ── DATES ────────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }
function dateOffset(days) { return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.floor((new Date(b) - new Date(a)) / 86400000); }

// ── THE ONE WAY TO CALL CLAUDE ───────────────────────────────────────────────
// claudeP(prompt, { label, maxTurns, tools, timeoutMin, cfg })
//   -> { text, json, sessionId, numTurns, ms, costReported }
//
// --output-format json gives one object with `result` (the text) plus the
// session id and turn count, which the brief's footer prints so a run can be
// audited. `json` is the first JSON value found in the text, or null.
// The credential paths the CLI honours BESIDES an API key. All of them are
// removed from the child's environment so the key resolved below is the one
// and only way it authenticates.
const OTHER_AUTH_ENV = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS'];
const API_ENV_KEYS = ['ANTHROPIC_API_KEY', ...OTHER_AUTH_ENV];

// ── WHICH KEY, AND FROM WHERE ────────────────────────────────────────────────
// config.json first, the environment second, a clear failure third. The key
// is returned to the caller that spawns claude and to nothing else; `masked`
// is the only form that ever reaches a log or an email.
function resolveApiKey(cfg) {
  const c = cfg || loadConfig();
  const fromConfig = String(c.anthropicApiKey || '').trim();
  const fromEnv = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const key = fromConfig || fromEnv;
  if (!key) {
    throw new Error('No Anthropic API key. Set "anthropicApiKey" in ' + CONFIG_PATH
      + ', or export ANTHROPIC_API_KEY in the environment that runs the briefs. Neither is set, so claude was not started.');
  }
  return { key, source: fromConfig ? 'config.json' : 'environment', masked: maskKey(key) };
}
function maskKey(k) {
  const s = String(k || '');
  if (s.length < 12) return '(short key)';
  return s.slice(0, 7) + '…' + s.slice(-4);
}

// ── CRON'S ENVIRONMENT IS NOT YOUR TERMINAL'S ──────────────────────────────
// cron hands a job PATH=/usr/bin:/bin, no HOME sometimes, and none of the
// shell profile. `claude` is a Node program installed under Homebrew, npm's
// global prefix, or a version manager (nvm, fnm, volta), and its `node` must
// be found too. Every one of those places is put on PATH here, so the same
// script that works in Terminal works at 5:30am.
function nodeBinDirs() {
  const dirs = [];
  const globs = [
    path.join(HOME, '.nvm', 'versions', 'node'),
    path.join(HOME, '.fnm', 'node-versions'),
    path.join(HOME, 'Library', 'Application Support', 'fnm', 'node-versions'),
  ];
  for (const g of globs) {
    try {
      for (const v of fs.readdirSync(g).sort().reverse()) {
        for (const sub of ['bin', path.join('installation', 'bin')]) {
          const d = path.join(g, v, sub);
          if (fs.existsSync(d)) dirs.push(d);
        }
      }
    } catch (_) { /* that manager is not installed */ }
  }
  return dirs;
}

function strippedEnv() {
  const env = Object.assign({}, process.env);
  for (const k of API_ENV_KEYS) delete env[k];
  if (!env.HOME) env.HOME = HOME;
  if (!env.USER) { try { env.USER = os.userInfo().username; } catch (_) {} }
  env.PATH = [env.PATH || '', '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin'),
    path.join(HOME, '.npm-global/bin'), path.join(HOME, '.claude/local'), path.join(HOME, '.volta/bin'),
    ...nodeBinDirs(), '/usr/bin', '/bin'].filter(Boolean).join(':');
  return env;
}

// The environment `claude` is spawned with: the cleaned one above, plus the
// one key. Throws (before anything is spawned) when there is no key.
function claudeEnv(cfg) {
  const k = resolveApiKey(cfg);
  const env = strippedEnv();
  env.ANTHROPIC_API_KEY = k.key;
  return { env, source: k.source, masked: k.masked };
}

// `node tools/briefs/lib.js --claude-test`: the exact spawn the briefs make,
// from whatever environment this is run in. Put it in cron once to see what
// cron sees. Prints the resolved PATH, where the key came from (never the
// key), the answer, and the error verbatim.
async function claudeTest() {
  const cfg = loadConfig();
  console.log('PATH the child will see:\n  ' + strippedEnv().PATH.split(':').join('\n  '));
  console.log(authAudit(cfg).line);
  try {
    const r = await claudeP('Reply with the single word OK and nothing else.', { cfg, label: 'claude-test', maxTurns: 1, tools: [], timeoutMin: 2 });
    console.log(`claude answered in ${r.ms}ms (session ${r.sessionId || '?'}, ${r.numTurns == null ? '?' : r.numTurns} turn): ${JSON.stringify(String(r.text).slice(0, 120))}`);
    console.log(/\bOK\b/i.test(r.text) ? `RESULT: PASS. claude -p runs from here on the API key from ${r.keySource}.` : 'RESULT: claude ran but did not answer as expected; read the text above.');
  } catch (e) {
    console.log('RESULT: FAILED: ' + e.message);
    if (/No Anthropic API key/.test(e.message)) console.log('  Add "anthropicApiKey": "<your key>" to config.json (the same key NILDash uses on Railway, or a new one from console.anthropic.com), or export ANTHROPIC_API_KEY.');
    else if (/could not start/.test(e.message)) console.log('  `claude` was not found on the PATH above. Run `which claude` in Terminal and add its directory to PATH in the crontab, or set claudeBin in config.json to the full path.');
    else if (/invalid.*api key|authentication_error|401|x-api-key/i.test(e.message)) console.log('  claude ran and used the key, and the API refused it. The key is wrong, revoked, or from another account: check it at console.anthropic.com.');
    else if (/OAuth/i.test(e.message)) console.log('  The CLI is still trying its own login. That should not happen with ANTHROPIC_API_KEY set; run `claude /logout` once so the stale session cannot be picked first.');
  }
}

// What the audit line in every brief reports: which key claude ran on and
// where it came from (masked, never the key), and which other credential
// paths were found in the environment and removed. With no key at all the
// line says so; the run itself has already failed by then.
function authAudit(cfg) {
  const removed = OTHER_AUTH_ENV.filter((k) => process.env[k]);
  let helper = 'none';
  for (const f of [path.join(HOME, '.claude', 'settings.json'), path.join(HOME, '.claude', 'settings.local.json')]) {
    try {
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (s && s.apiKeyHelper) helper = `SET in ${f} (${String(s.apiKeyHelper).slice(0, 60)})`;
    } catch (_) { /* absent or unreadable: nothing to report */ }
  }
  let key = null;
  try { key = resolveApiKey(cfg || loadConfig()); } catch (_) { key = null; }
  return {
    keySource: key ? key.source : null,
    keyMasked: key ? key.masked : null,
    removedEnv: removed,
    apiKeyHelper: helper,
    line: (key ? `auth: API key ${key.masked} from ${key.source}` : 'auth: NO API KEY (config.json anthropicApiKey and ANTHROPIC_API_KEY both unset)')
      + `; other credential env ${removed.length ? 'removed (' + removed.join(', ') + ')' : 'absent'}; apiKeyHelper ${helper}`,
  };
}

async function claudeP(prompt, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const maxTurns = Math.max(1, parseInt(opts.maxTurns, 10) || 1);
  const timeoutMs = Math.max(60000, (opts.timeoutMin || cfg.callTimeoutMin) * 60000);
  // Resolved BEFORE the spawn so a missing key fails with its own message,
  // not with whatever the CLI says about a login it cannot find.
  const ce = claudeEnv(cfg);
  const args = ['-p', '--output-format', 'json', '--max-turns', String(maxTurns)];
  if (opts.tools && opts.tools.length) args.push('--allowedTools', ...opts.tools);
  else args.push('--disallowedTools', 'Bash', 'Edit', 'Write', 'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task');
  if (opts.model) args.push('--model', opts.model);

  const t0 = Date.now();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(cfg.claudeBin, args, { env: ce.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const killer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(killer); reject(new Error(`could not start ${cfg.claudeBin}: ${e.message}`)); });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (signal === 'SIGKILL') return reject(new Error(`claude killed after ${timeoutMs / 60000} min (${opts.label || 'call'})`));
      if (code !== 0) return reject(new Error(`claude exited ${code} (${opts.label || 'call'}): ${(stderr.trim() || stdout.trim() || 'no output').slice(0, 400)}`));
      resolve(stdout);
    });
    child.stdin.end(prompt);
  });

  let obj = null;
  try { obj = JSON.parse(out); } catch (_) { obj = null; }
  const text = obj && typeof obj.result === 'string' ? obj.result : out;
  return {
    text,
    json: firstJson(text),
    sessionId: obj && obj.session_id || null,
    numTurns: obj && obj.num_turns || null,
    costReported: obj && (obj.total_cost_usd !== undefined ? obj.total_cost_usd : obj.cost_usd),
    ms: Date.now() - t0,
    keySource: ce.source,
  };
}

function firstJson(text) {
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const a = Math.min(...starts);
  const closer = s[a] === '[' ? ']' : '}';
  const b = s.lastIndexOf(closer);
  if (b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

// ── STATE, ARCHIVE, LOG ──────────────────────────────────────────────────────
function readState(name, dflt) {
  try { return JSON.parse(fs.readFileSync(path.join(DIRS.state, name), 'utf8')); } catch (_) { return dflt; }
}
function writeState(name, obj) {
  fs.writeFileSync(path.join(DIRS.state, name), JSON.stringify(obj, null, 2));
}
function writeBrief(kind, md) {
  const file = path.join(ROOT, `${today()}-${kind}.md`);
  fs.writeFileSync(file, md);
  return file;
}
function log(kind, msg) {
  const line = `${new Date().toISOString()} [${kind}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(DIRS.logs, `${kind}.log`), line + '\n'); } catch (_) {}
}

// ── THE EMAIL ────────────────────────────────────────────────────────────────
// Through Resend, the same SDK NILDash uses. The key comes from config.json
// (or RESEND_API_KEY in the environment). The markdown is the archive; the
// email is the same text, lightly rendered.
async function sendBrief(cfg, { subject, markdown, kind }) {
  const key = cfg.resendApiKey || process.env.RESEND_API_KEY;
  if (!key) throw new Error('no Resend key: set resendApiKey in ~/nildash-briefs/config.json');
  const { Resend } = require('resend');
  const resend = new Resend(key);
  const r = await resend.emails.send({
    from: cfg.from, to: cfg.to, subject,
    text: markdown,
    html: mdToHtml(markdown),
  });
  if (r && r.error) throw new Error(`Resend refused: ${r.error.message || JSON.stringify(r.error)}`);
  log(kind, `emailed "${subject}" to ${cfg.to} (resend id ${(r && r.data && r.data.id) || '?'})`);
  return r;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2">$2</a>');
}
function mdToHtml(md) {
  const lines = String(md).split('\n');
  const out = ['<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.45;color:#111;max-width:680px">'];
  let inList = false, inPre = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  for (const raw of lines) {
    if (/^```/.test(raw)) { closeList(); inPre = !inPre; out.push(inPre ? '<pre style="background:#f4f4f4;padding:10px;border-radius:6px;white-space:pre-wrap">' : '</pre>'); continue; }
    if (inPre) { out.push(esc(raw)); continue; }
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) { closeList(); const n = h[1].length + 1; out.push(`<h${n} style="margin:18px 0 6px">${inline(h[2])}</h${n}>`); continue; }
    const li = raw.match(/^\s*[-*]\s+(.*)$/);
    if (li) { if (!inList) { out.push('<ul style="margin:4px 0 8px 18px;padding:0">'); inList = true; } out.push(`<li style="margin:2px 0">${inline(li[1])}</li>`); continue; }
    if (/^---+$/.test(raw.trim())) { closeList(); out.push('<hr style="border:0;border-top:1px solid #ddd;margin:14px 0">'); continue; }
    if (!raw.trim()) { closeList(); continue; }
    closeList(); out.push(`<p style="margin:6px 0">${inline(raw)}</p>`);
  }
  closeList();
  if (inPre) out.push('</pre>');
  out.push('</div>');
  return out.join('\n');
}

// The footer every brief ends with: the audit line and the calls it made.
function footer(kind, calls, audit) {
  const L = ['', '---', `_${kind} · ${new Date().toString()}_`, `_${audit.line}_`];
  if (calls.length) {
    L.push(`_claude -p calls: ${calls.length}; sessions: ${calls.map((c) => c.sessionId || '?').join(', ')}; turns: ${calls.map((c) => c.numTurns == null ? '?' : c.numTurns).join(', ')}_`);
  } else {
    L.push('_claude -p calls: none_');
  }
  return L.join('\n');
}

if (require.main === module && process.argv.includes('--claude-test')) { claudeTest().then(() => process.exit(0)); }

module.exports = { DIRS, CONFIG_PATH, loadConfig, today, dateOffset, daysBetween, claudeP, firstJson, claudeTest,
  readState, writeState, writeBrief, log, sendBrief, mdToHtml, footer, authAudit, API_ENV_KEYS, OTHER_AUTH_ENV,
  resolveApiKey, claudeEnv, strippedEnv, maskKey };
