'use strict';
// No database, no network, no claude, no Mail.app. BRIEFS_HOME is pointed at a
// scratch directory BEFORE the briefs library loads, exactly as Railway sets
// it, and the mail doors are stubbed.
//
//   node tests/run.js                every suite, against the committed baseline
//   node tests/briefsrailway.js      just this one
const _tp = require('path');
const fs = require('fs');
const os = require('os');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const SCRATCH = fs.mkdtempSync(_tp.join(os.tmpdir(), 'br-test-'));
process.env.HOME = _tp.join(SCRATCH, 'home');
process.env.BRIEFS_HOME = _tp.join(SCRATCH, 'data', 'briefs');
for (const k of Object.keys(process.env)) if (/^BRIEFS_(TO|FROM|MY_ADDRESSES|NEWS_TERMS|MAX_TURNS|LOOKBACK_DAYS|CONFIG_JSON|MAIL_SOURCES|GMAIL_USER|GMAIL_APP_PASSWORD)$/.test(k)) delete process.env[k];

// ── THE BRIEFS ON RAILWAY: SETTINGS FROM VARIABLES, ONE CRON, FOUR SLOTS,
//    MAIL THROUGH THE PROVIDERS ─────────────────────────────────────────────

const L = require(REPO + 'tools/briefs/lib.js');
const RS = require(REPO + 'tools/briefs/run-slot.js');
const MS = require(REPO + 'tools/briefs/mail-source.js');
const SW = require(REPO + 'tools/briefs/strategy-watch.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

async function main() {
  // ── 1. BRIEFS_HOME ───────────────────────────────────────────────────────
  OUT.push('-- BRIEFS_HOME --');
  ok('the root is BRIEFS_HOME, not ~/nildash-briefs', L.ROOT === process.env.BRIEFS_HOME && L.DIRS.state.startsWith(process.env.BRIEFS_HOME));
  ok('  and its directories exist', ['inbox', 'state', 'logs'].every((d) => fs.existsSync(_tp.join(process.env.BRIEFS_HOME, d))));
  ok('  config.json is looked for there', L.CONFIG_PATH === _tp.join(process.env.BRIEFS_HOME, 'config.json'));

  // ── 2. SETTINGS FROM VARIABLES ───────────────────────────────────────────
  OUT.push('', '-- config from the environment --');
  const env = {
    BRIEFS_TO: 'me@x.com', BRIEFS_MY_ADDRESSES: 'John@Example.com, j@other.com', BRIEFS_LOOKBACK_DAYS: '45',
    BRIEFS_NEWS_TERMS: '["NIL platform","Opendorse"]', BRIEFS_PROSPECT_KEYWORDS: 'agent,nil', BRIEFS_MAX_TURNS: '{"news":6}',
    RESEND_API_KEY: 're_env', BRIEFS_ABOUT_ME: 'I sell NIL software.', BRIEFS_CONNECTIONS_URL: 'https://example.com/c.csv',
    BRIEFS_MAIL_SOURCES: 'gmail-imap, outlook-graph',
  };
  const fe = L.configFromEnv(env);
  ok('strings, numbers, comma lists, JSON lists and JSON objects are read', fe.to === 'me@x.com' && fe.lookbackDays === 45 && JSON.stringify(fe.newsTerms) === '["NIL platform","Opendorse"]' && JSON.stringify(fe.prospectKeywords) === '["agent","nil"]' && fe.maxTurns.news === 6 && fe.resendApiKey === 're_env' && fe.aboutMe === 'I sell NIL software.' && fe.connectionsUrl === 'https://example.com/c.csv', fe);
  ok('  mail sources as a list', JSON.stringify(fe.mailSources) === '["gmail-imap","outlook-graph"]', fe.mailSources);
  ok('  an unset variable is absent, not empty', !('silentDays' in fe) && !('newsLines' in fe));
  ok('  every config key in the request has a variable', ['to', 'from', 'resendApiKey', 'myAddresses', 'lookbackDays', 'silentDays', 'prospectKeywords', 'prospectsPerRun', 'aboutMe', 'newsTerms', 'newsLines', 'maxTurns', 'callTimeoutMin', 'anthropicApiKey'].every((k) => Object.values(L.ENV_MAP).includes(k)), Object.values(L.ENV_MAP));
  ok('BRIEFS_CONFIG_JSON carries the whole object', L.configFromEnv({ BRIEFS_CONFIG_JSON: '{"to":"a@b.c","newsLines":3}' }).newsLines === 3);
  let bad = null; try { L.configFromEnv({ BRIEFS_CONFIG_JSON: '{nope' }); } catch (e) { bad = e; }
  ok('  and says so when it is not JSON', bad && /BRIEFS_CONFIG_JSON is not valid JSON/.test(bad.message));
  // Merged: defaults, then the file, then the environment.
  fs.writeFileSync(L.CONFIG_PATH, JSON.stringify({ to: 'file@x.com', newsLines: 4, myAddresses: ['file@x.com'], maxTurns: { prospect: 9 } }));
  Object.assign(process.env, env);
  const cfg = L.loadConfig();
  ok('a variable wins over config.json', cfg.to === 'me@x.com' && cfg.lookbackDays === 45, [cfg.to, cfg.lookbackDays]);
  ok('  a key only in the file survives', cfg.newsLines === 4);
  ok('  addresses are lower-cased', JSON.stringify(cfg.myAddresses) === '["john@example.com","j@other.com"]', cfg.myAddresses);
  ok('  maxTurns merges defaults, file and environment', cfg.maxTurns.followups === 2 && cfg.maxTurns.prospect === 9 && cfg.maxTurns.news === 6 && cfg.maxTurns.strategy === 4, cfg.maxTurns);
  ok('  and the config says where it came from', cfg._source.file === true && cfg._source.env.includes('to') && cfg._source.env.includes('mailSources'), cfg._source);
  fs.unlinkSync(L.CONFIG_PATH);
  const cfg2 = L.loadConfig();
  ok('with no file at all the defaults and the variables are enough', cfg2._source.file === false && cfg2.to === 'me@x.com' && cfg2.silentDays === 7 && cfg2.from === 'NILDash Briefs <noreply@mynildash.com>');
  for (const k of Object.keys(env)) delete process.env[k];

  // ── 3. ONE CRON, FOUR SLOTS, BOTH CENTRAL OFFSETS ────────────────────────
  OUT.push('', '-- the slot runner --');
  ok('the four slots are the four Mac times', JSON.stringify(RS.SLOTS.map((s) => s.at + ' ' + s.brief)) === JSON.stringify(['05:30 follow-ups', '05:45 news-watch', '06:00 prospecting', '06:15 strategy-watch']));
  ok('05:31 is follow-ups, 06:17 is strategy-watch, 06:23 is nothing', RS.pickSlot('05:31').brief === 'follow-ups' && RS.pickSlot('06:17').brief === 'strategy-watch' && RS.pickSlot('06:23') === null);
  ok('05:52 goes to the nearer slot', RS.pickSlot('05:52').brief === 'news-watch');
  ok('the tolerance is a parameter, and the nearer slot wins', RS.pickSlot('05:40', 3) === null && RS.pickSlot('05:40', 10).brief === 'news-watch');
  const rj = JSON.parse(fs.readFileSync(REPO + 'tools/briefs/railway.json', 'utf8'));
  const cron = rj.deploy.cronSchedule;
  ok('railway.json fires every fifteen minutes across 10:00-12:59 UTC', cron === '*/15 10-12 * * *', cron);
  // Every slot, in CDT (UTC-5) and CST (UTC-6), lands on a firing that picks it.
  const fires = (utcH, utcM) => utcH >= 10 && utcH <= 12 && utcM % 15 === 0;
  const covered = [];
  for (const [label, day] of [['CDT', '2026-07-01'], ['CST', '2026-01-15']]) {
    for (const s of RS.SLOTS) {
      let hit = false;
      for (let h = 9; h <= 13 && !hit; h++) for (let m = 0; m < 60 && !hit; m += 15) {
        const d = new Date(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
        if (fires(h, m) && RS.pickSlot(RS.localHM(d, 'America/Chicago'), 7, RS.SLOTS) && RS.pickSlot(RS.localHM(d, 'America/Chicago'), 7, RS.SLOTS).brief === s.brief) hit = true;
      }
      covered.push([label, s.brief, hit]);
    }
  }
  ok('every brief has a firing in both Central offsets', covered.every((c) => c[2]), covered);
  ok('a firing between slots runs nothing', RS.pickSlot(RS.localHM(new Date('2026-07-01T12:45:00Z'), 'America/Chicago')) === null);
  ok('the start command is the slot runner and a run never restarts', rj.deploy.startCommand === 'node tools/briefs/run-slot.js' && rj.deploy.restartPolicyType === 'NEVER' && rj.build.dockerfilePath === 'tools/briefs/Dockerfile');
  const df = fs.readFileSync(REPO + 'tools/briefs/Dockerfile', 'utf8');
  ok('the Dockerfile installs the Claude CLI, sets BRIEFS_HOME on the volume, copies only what the briefs need', /npm install -g @anthropic-ai\/claude-code/.test(df) && /BRIEFS_HOME=\/data\/briefs/.test(df) && /COPY server \.\/server/.test(df) && /COPY tools\/briefs \.\/tools\/briefs/.test(df) && !/COPY \. /.test(df) && /CMD \["node", "tools\/briefs\/run-slot\.js"\]/.test(df));
  ok('  no key in it', !/sk-ant/.test(df) && !/sk-ant/.test(JSON.stringify(rj)));

  // ── 4. THE MAIL DOORS ────────────────────────────────────────────────────
  OUT.push('', '-- mail on a server --');
  ok('macOS reads Mail.app unless told otherwise', JSON.stringify(MS.chooseSources({ mailSources: [] }, { platform: 'darwin', env: {} })) === '["mac"]');
  ok('Linux with nothing set has no source', MS.chooseSources({ mailSources: [] }, { platform: 'linux', env: {} }).length === 0);
  ok('Linux picks the doors whose variables are set', JSON.stringify(MS.chooseSources({ mailSources: [] }, { platform: 'linux', env: { BRIEFS_GMAIL_USER: 'a', BRIEFS_GMAIL_APP_PASSWORD: 'b', DATABASE_URL: 'p', OUTLOOK_CLIENT_ID: 'c', OUTLOOK_CLIENT_SECRET: 'd' } })) === '["gmail-imap","outlook-graph"]');
  ok('  Gmail only when only Gmail is set', JSON.stringify(MS.chooseSources({ mailSources: [] }, { platform: 'linux', env: { BRIEFS_GMAIL_USER: 'a', BRIEFS_GMAIL_APP_PASSWORD: 'b' } })) === '["gmail-imap"]');
  ok('BRIEFS_MAIL_SOURCES forces the choice', JSON.stringify(MS.chooseSources({ mailSources: ['outlook-graph', 'bogus'] }, { platform: 'darwin', env: {} })) === '["outlook-graph"]');
  const parsed = { messageId: '<m1@x>', subject: 'Hello', date: new Date('2026-09-10T12:00:00Z'), from: { value: [{ name: 'JM', address: 'jm@x.com' }] }, to: { value: [{ name: 'Ann', address: 'ann@y.com' }] }, cc: { value: [] }, text: 'Hi Ann, following up.', html: '<p>Hi Ann</p>' };
  const a = MS.fromParsed(parsed, 'Gmail (IMAP)', '[Gmail]/Sent Mail', 'sent');
  ok('an IMAP message becomes the brief shape', a.account === 'Gmail (IMAP)' && a.mailbox === '[Gmail]/Sent Mail' && a.subject === 'Hello' && a.date === '2026-09-10T12:00:00.000Z' && a.from === 'JM <jm@x.com>' && a.to[0] === 'Ann <ann@y.com>' && a.content === 'Hi Ann, following up.', a);
  const a2 = MS.fromParsed(parsed, 'Gmail (IMAP)', 'INBOX', 'received');
  ok('  received messages carry no content', a2.content === undefined && a2.kind === 'received');
  const g = MS.fromGraph({ id: 'g1', internetMessageId: '<g1@o>', subject: 'Re: Deal', from: { emailAddress: { name: 'Bob', address: 'bob@z.com' } }, toRecipients: [{ emailAddress: { name: 'JM', address: 'jm@o.com' } }], body: { contentType: 'html', content: '<div>Thanks <b>JM</b></div>' }, sentDateTime: '2026-09-11T08:00:00Z' }, 'Outlook (jm@o.com)', 'Sent Items', 'sent');
  ok('a Graph message becomes the brief shape, html stripped', g.from === 'Bob <bob@z.com>' && g.to[0] === 'JM <jm@o.com>' && g.date === '2026-09-11T08:00:00.000Z' && g.content === 'Thanks JM' && g.id === '<g1@o>', g);
  // readMail merges the doors, caches per day, and filters to the window.
  const cfgM = { myAddresses: ['jm@x.com', 'jm@o.com'], lookbackDays: 30, mailSources: ['gmail-imap', 'outlook-graph'], mailAccounts: [] };
  const old = new Date(Date.now() - 40 * 86400000).toISOString(), recent = new Date(Date.now() - 2 * 86400000).toISOString();
  const stubG = async () => ({ sent: [{ account: 'Gmail (IMAP)', mailbox: 'S', kind: 'sent', id: '1', subject: 'a', date: recent, from: 'JM <jm@x.com>', to: ['Ann <ann@y.com>'], cc: [], content: 'x' }, { account: 'Gmail (IMAP)', mailbox: 'S', kind: 'sent', id: '0', subject: 'old', date: old, from: 'JM <jm@x.com>', to: ['Old <old@y.com>'], cc: [], content: 'x' }], received: [], accounts: [{ name: 'Gmail (IMAP)', addresses: ['jm@x.com'], skipped: false }], mailboxes: [{ account: 'Gmail (IMAP)', mailbox: 'S', kind: 'sent', count: 2 }], warnings: [] });
  const stubO = async () => ({ sent: [], received: [{ account: 'Outlook', mailbox: 'Inbox', kind: 'received', id: '2', subject: 'Re: a', date: recent, from: 'Ann <ann@y.com>', to: ['JM <jm@o.com>'], cc: [] }], accounts: [{ name: 'Outlook', addresses: ['jm@o.com'], skipped: false }], mailboxes: [], warnings: ['w1'] });
  const mail = await MS.readMail(cfgM, { readGmailImap: stubG, readOutlookGraph: stubO, fresh: true });
  ok('both doors are merged', mail.sent.length === 1 && mail.received.length === 1 && mail.accounts.length === 2 && mail.warnings[0] === 'w1', { s: mail.sent.length, r: mail.received.length });
  ok('  a message outside the look-back is dropped', !mail.sent.some((m) => m.subject === 'old'));
  ok('  and the day\'s read is cached', fs.existsSync(_tp.join(L.DIRS.state, `mail-${L.today()}.json`)));
  const failing = await MS.readMail(cfgM, { readGmailImap: async () => { throw new Error('IMAP login failed'); }, readOutlookGraph: stubO, fresh: true });
  ok('a door that fails is a warning, and the other door still reads', failing.received.length === 1 && failing.warnings.some((w) => /gmail-imap: IMAP login failed/.test(w)), failing.warnings);
  const none = await MS.readMail({ myAddresses: [], lookbackDays: 30, mailSources: [] }, { fresh: true, platform: 'linux', env: {} });
  ok('no door at all says which variables to set', none.warnings.some((w) => /BRIEFS_GMAIL_USER/.test(w) && /OUTLOOK_CLIENT_ID/.test(w)), none.warnings);
  const fu = fs.readFileSync(REPO + 'tools/briefs/follow-ups.js', 'utf8');
  ok('follow-ups reads through mail-source', /const \{ readMail \} = require\('\.\/mail-source'\)/.test(fu) && /await readMail\(cfg, \{ debug \}\)/.test(fu) && !/dumpMail\(/.test(fu));
  const src = fs.readFileSync(REPO + 'tools/briefs/mail-source.js', 'utf8');
  ok('only mailboxes in myAddresses are opened on the Outlook door', /mine\.has\(String\(row\.email_address \|\| ''\)\.toLowerCase\(\)\)/.test(src));
  ok('  and the token is never written back', !/UPDATE email_accounts/.test(src) && !/updateAccountTokens/.test(src));
  ok('Gmail is IMAP with an app password, not OAuth', /imap\.gmail\.com/.test(src) && /BRIEFS_GMAIL_APP_PASSWORD/.test(src) && !/gmail\.readonly/.test(src.replace(/\/\/.*$/gm, '')));

  // ── 5. PROSPECTING AND STRATEGY WATCH OFF THE MAC ────────────────────────
  OUT.push('', '-- the other two --');
  const pr = fs.readFileSync(REPO + 'tools/briefs/prospecting.js', 'utf8');
  ok('prospecting fetches the LinkedIn CSV from BRIEFS_CONNECTIONS_URL into the inbox', /async function fetchConnectionsIfConfigured/.test(pr) && /await fetchConnectionsIfConfigured\(cfg, warnings\);\s*const csvPath = findCsv\(\);/.test(pr) && /'Connections\.csv'/.test(pr));
  ok('  and a failed fetch keeps the last copy', /Using the last copy/.test(pr));
  // strategy-watch: no config.json on Railway, so the record goes to the state dir.
  const stub = async (prompt, opts) => ({ text: '[]', json: [{ title: 'Vote set', url: 'https://example.com/v', source: 'S', published: L.today(), kind: 'vote', meaningful: true, line: 'A vote was scheduled.' }], sessionId: 's', numTurns: 1, ms: 1 });
  process.env.RESEND_API_KEY = 're_x';
  const sent = [];
  const r = await SW.run({ cfg: L.loadConfig(), claudeP: stub, sendBrief: async (c, m) => { sent.push(m); }, });
  const stateFile = _tp.join(L.DIRS.state, 'strategy-watch.json');
  ok('strategy-watch writes its record to state/strategy-watch.json when there is no config.json', r.sent && fs.existsSync(stateFile) && JSON.parse(fs.readFileSync(stateFile, 'utf8')).strategyWatch.lastSentAt === L.today(), fs.existsSync(stateFile));
  ok('  and does not invent a config.json', !fs.existsSync(L.CONFIG_PATH));
  const r2 = await SW.run({ cfg: L.loadConfig(), claudeP: stub, sendBrief: async (c, m) => { sent.push(m); } });
  ok('  the next run reads it back and repeats nothing', r2.sent === false && sent.length === 1);
  delete process.env.RESEND_API_KEY;

  // ── 6. THE README NAMES THE VARIABLES ────────────────────────────────────
  OUT.push('', '-- the README --');
  const readme = fs.readFileSync(REPO + 'tools/briefs/README.md', 'utf8');
  ok('a Running on Railway section', /## Running on Railway/.test(readme));
  for (const v of ['RESEND_API_KEY', 'ANTHROPIC_API_KEY', 'BRIEFS_MY_ADDRESSES', 'BRIEFS_ABOUT_ME', 'BRIEFS_GMAIL_APP_PASSWORD', 'DATABASE_URL', 'OUTLOOK_CLIENT_ID', 'EMAIL_ENCRYPTION_KEY', 'BRIEFS_CONNECTIONS_URL', 'BRIEFS_TZ']) ok(`  names ${v}`, readme.includes('`' + v + '`'));
  ok('  says why Gmail is IMAP and Outlook is Graph', /gmail\.readonly/.test(readme) && /Mail\.ReadWrite/.test(readme) && /app password/i.test(readme));
  ok('  says the volume is required', /\/data\/briefs/.test(readme) && /Without it every deploy starts from nothing/.test(readme));

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
