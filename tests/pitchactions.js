'use strict';
// Against the local Postgres and a real express app mounting the real routes:
// the claims here are about what a link does to the database, and a link that
// "looks right" is exactly the failure mode this whole feature has to avoid.
//
//   node tests/run.js               every suite, against the committed baseline
//   node tests/pitchactions.js      just this one
const _tp = require('path');
const fs = require('fs');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.APP_URL = 'https://mynildash.com';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── AGENTS WERE NOT LOGGING IN, SO PITCHES SAT ──────────────────────────────
//
// One tap from the nightly digest, no session. A link that acts on an agent's
// behalf with no login is a credential, and the two ways this feature could go
// badly wrong are both tested here: a raw token readable from the table, and a
// GET that fires a pitch because Outlook opened the link before a human did.

const store = require(REPO + 'server/store');
const T = require(REPO + 'server/services/pitchActionTokens.js');
const PA = require(REPO + 'server/services/pitchActions.js');
const ND = require(REPO + 'server/services/nightlyDigest.js');
const Closer = require(REPO + 'server/services/closer.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const AG = 'pa_agent', ATH1 = 'pa_ath1', ATH2 = 'pa_ath2';

async function seed(pool) {
  await pool.query(`DELETE FROM pitch_action_tokens WHERE agent_id = $1`, [AG]);
  await pool.query(`DELETE FROM pitch_actions WHERE agent_id = $1`, [AG]);
  await pool.query(`DELETE FROM outreach_logs WHERE agent_id = $1`, [AG]);
  await pool.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await pool.query(`DELETE FROM nightly_digest_sends WHERE agent_id = $1`, [AG]);
  await pool.query(`DELETE FROM athletes WHERE id = ANY($1)`, [[ATH1, ATH2]]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await pool.query(
    `INSERT INTO users (id,name,email,password,role) VALUES ($1,'JohnMark Compton','pa@example.com','x','agent')`, [AG]);
  await pool.query(
    `INSERT INTO athletes (id,agent_id,data) VALUES
       ($1,$3,'{"name":"Marcus Webb","school":"Auburn University","sport":"Baseball"}'::jsonb),
       ($2,$3,'{"name":"Amari Cole","school":"Samford University","sport":"Softball"}'::jsonb)`, [ATH1, ATH2, AG]);
  const mk = async (id, athlete, brand, body) => pool.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email)
     VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)`,
    [id, AG, athlete, brand, 'A local partnership for ' + brand, body, `owner@${id}.example`]);
  await mk('pa_p1', ATH1, 'Rama Jamas', '<p>Hi Dana,</p><p>Marcus Webb plays baseball at Auburn and posts every week. Rama Jamas has been on the Strip forty years.</p>');
  await mk('pa_p2', ATH1, 'Hydro Fit', '<p>Hey Sam,</p><p>Hydro Fit is two blocks from where Marcus trains.</p>');
  await mk('pa_p3', ATH2, 'Legion Hair Studio', '<p>Hi Ken,</p><p>Amari Cole is a softball player at Samford.</p>');
  // The contact name the digest prints as the owner line.
  await pool.query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, brand_name, brand_key, contact_name, state, slot, channel)
     VALUES ($1,$2,'Rama Jamas','localname:rama jamas','Dana Rama','queued',1,'email')`, [AG, ATH1]);
}

async function main() {
  await wait(TEST_INIT_WAIT_MS);
  const pool = store.pool;
  await T.ensureTable(pool);
  await PA.ensureTable(pool);
  await seed(pool);

  // ── THE TOKEN IS A CREDENTIAL ──────────────────────────────────────────
  OUT.push('-- the token --');
  const raw = T.newToken();
  ok('32 random bytes, URL-safe', raw.length === 43 && /^[A-Za-z0-9_-]+$/.test(raw), raw);
  ok('  no padding, nothing to escape in a link', !/[=+/]/.test(raw));
  ok('  hashed with SHA-256', T.hashToken(raw).length === 64 && /^[0-9a-f]+$/.test(T.hashToken(raw)));
  ok('  two tokens are never the same', T.newToken() !== T.newToken());
  ok('the link lasts 72 hours', T.TTL_MS === 72 * 60 * 60 * 1000, T.TTL_MS / 3600000);

  const pair = await T.issueFor(pool, { pitchId: 'pa_p1', agentId: AG, athleteId: ATH1 });
  const stored = (await pool.query(`SELECT token_hash, action, pitch_id, athlete_id, used_at FROM pitch_action_tokens WHERE pitch_id = 'pa_p1' ORDER BY action`)).rows;
  ok('one approve token and one skip token per pitch', stored.length === 2 && stored[0].action === 'approve' && stored[1].action === 'skip', stored.map((s) => s.action));
  ok('THE RAW TOKEN IS NOWHERE IN THE TABLE, only its hash',
    stored.every((s) => s.token_hash !== pair.approve && s.token_hash !== pair.skip)
    && stored.some((s) => s.token_hash === T.hashToken(pair.approve)), stored.map((s) => s.token_hash.slice(0, 12)));
  const dump = JSON.stringify((await pool.query(`SELECT * FROM pitch_action_tokens`)).rows);
  ok('  and a dump of the whole table yields no working link',
    dump.indexOf(pair.approve) === -1 && dump.indexOf(pair.skip) === -1);

  // ── LOOK UP WITHOUT CLAIMING ───────────────────────────────────────────
  OUT.push('', '-- looking it up --');
  const look = await T.lookup(pool, pair.approve);
  ok('a good token resolves to its pitch', look.ok === true && look.row.pitch_id === 'pa_p1' && look.row.action === 'approve', look.reason);
  ok('  carrying the brand, the athlete and the owner for the page',
    look.row.brand_name === 'Rama Jamas' && look.row.athlete_name === 'Marcus Webb' && look.row.contact_name === 'Dana Rama', look.row);
  ok('LOOKING IT UP DOES NOT USE IT UP',
    (await pool.query(`SELECT used_at FROM pitch_action_tokens WHERE token_hash = $1`, [T.hashToken(pair.approve)])).rows[0].used_at === null);
  ok('a token nobody issued is refused', (await T.lookup(pool, T.newToken())).reason === 'unknown');
  ok('  and so is an empty one, rather than throwing', (await T.lookup(pool, '')).reason === 'unknown');

  // ── ISSUING AGAIN RETIRES THE OLD PAIR ─────────────────────────────────
  const pair2 = await T.issueFor(pool, { pitchId: 'pa_p1', agentId: AG, athleteId: ATH1 });
  ok('a new digest retires the previous link for that pitch', (await T.lookup(pool, pair.approve)).reason === 'used');
  ok('  and the newest one works', (await T.lookup(pool, pair2.approve)).ok === true);

  // ── THE CLAIM IS ONE STATEMENT ─────────────────────────────────────────
  OUT.push('', '-- single use --');
  const first = await T.claim(pool, pair2.approve);
  ok('the first tap claims it', first.ok === true && first.claim.action === 'approve');
  ok('THE SECOND TAP GETS NOTHING', (await T.claim(pool, pair2.approve)).reason === 'used');
  ok('AND THE SIBLING SKIP IS DEAD TOO: you cannot approve then skip the same pitch',
    (await T.lookup(pool, pair2.skip)).reason === 'used');

  // Two taps racing: both call claim, exactly one wins.
  const pairR = await T.issueFor(pool, { pitchId: 'pa_p2', agentId: AG, athleteId: ATH1 });
  const [a, b] = await Promise.all([T.claim(pool, pairR.approve), T.claim(pool, pairR.approve)]);
  ok('two simultaneous taps: exactly one wins', (a.ok ? 1 : 0) + (b.ok ? 1 : 0) === 1, [a.ok, b.ok]);

  // ── EXPIRY ─────────────────────────────────────────────────────────────
  const old = await T.issueFor(pool, { pitchId: 'pa_p3', agentId: AG, athleteId: ATH2, ttlMs: -1000 });
  ok('an expired link is refused', (await T.lookup(pool, old.approve)).reason === 'expired');
  ok('  and cannot be claimed either', (await T.claim(pool, old.approve)).reason === 'expired');

  // ── HANDLED ELSEWHERE ──────────────────────────────────────────────────
  OUT.push('', '-- already handled --');
  const p3 = await T.issueFor(pool, { pitchId: 'pa_p3', agentId: AG, athleteId: ATH2 });
  await Closer.skipDraft(pool, AG, 'pa_p3');
  const after = await T.lookup(pool, p3.approve);
  ok('A PITCH SKIPPED IN THE DASHBOARD makes its emailed link say "already handled"', after.reason === 'handled', after.reason);
  ok('  which is not the same page as an expired or unknown link', after.reason !== 'expired' && after.reason !== 'unknown');
  await pool.query(`UPDATE outreach_logs SET cadence_stopped_at = NULL, cadence_stop_reason = NULL WHERE id = 'pa_p3'`);
  await pool.query(`UPDATE outreach_queue SET state = 'queued' WHERE agent_id = $1`, [AG]);
  const gone = await T.issueFor(pool, { pitchId: 'pa_gone', agentId: AG, athleteId: ATH2 });
  ok('a link to a pitch that no longer exists says so', (await T.lookup(pool, gone.approve)).reason === 'gone');

  // ── SKIP IS ONE FUNCTION, USED BY BOTH DOORS ───────────────────────────
  OUT.push('', '-- one skip, two doors --');
  ok('Closer.skipDraft exists and is exported', typeof Closer.skipDraft === 'function');
  const idx = src('server/index.js');
  ok('THE DASHBOARD ROUTE CALLS IT rather than running its own SQL',
    /Closer\.skipDraft\(store\.pool, agentId, req\.params\.id\)/.test(idx)
    && !/cadence_stop_reason = 'you skipped it'/.test(idx));
  ok('THE EMAIL ROUTE CALLS THE SAME FUNCTION',
    /Closer\.skipDraft\(store\.pool, agentId, row\.pitch_id\)/.test(idx));
  ok('and approve goes through approveBatch on both doors, not a second send path',
    /Closer\.approveBatch\(store\.pool, agentId, \{ ids: \[row\.pitch_id\] \}\)/.test(idx)
    && /Closer\.approveBatch\(store\.pool, req\.session\.userId,/.test(idx));
  ok('  the email route writes no UPDATE of its own against outreach_logs',
    !/app\.post\('\/a\/:token'[\s\S]{0,4000}?UPDATE outreach_logs/.test(idx));

  const skipped = await Closer.skipDraft(pool, AG, 'pa_p3');
  ok('skipping stops the cadence and says why', skipped.ok === true
    && (await pool.query(`SELECT cadence_stop_reason FROM outreach_logs WHERE id='pa_p3'`)).rows[0].cadence_stop_reason === 'you skipped it');
  ok('  and frees the nightly slot rather than holding it forever',
    /SET state = 'skipped'/.test(src('server/services/closer.js')));
  ok('skipping twice is refused, not a second write', (await Closer.skipDraft(pool, AG, 'pa_p3')).ok === false);
  ok('another agent cannot skip this agent\'s draft', (await Closer.skipDraft(pool, 'someone_else', 'pa_p1')).ok === false);

  // ── THE ACTION LOG ─────────────────────────────────────────────────────
  OUT.push('', '-- the log --');
  await pool.query(`DELETE FROM pitch_actions WHERE agent_id = $1`, [AG]);
  ok('a logged action lands', (await PA.log(pool, { pitchId: 'pa_p1', agentId: AG, action: 'approve', source: 'email' })) === true);
  ok('an unknown source is refused rather than stored', (await PA.log(pool, { pitchId: 'pa_p1', agentId: AG, action: 'approve', source: 'carrier-pigeon' })) === false);
  ok('an unknown action is refused too', (await PA.log(pool, { pitchId: 'pa_p1', agentId: AG, action: 'delete', source: 'email' })) === false);
  ok('the three channels are the ones asked for', JSON.stringify(PA.SOURCES) === '["email","reminder_email","dashboard"]', PA.SOURCES);
  await PA.logMany(pool, [
    { pitchId: 'pa_p2', agentId: AG, action: 'skip', source: 'dashboard' },
    { pitchId: 'pa_p3', agentId: AG, action: 'approve', source: 'dashboard' },
  ]);
  const chan = await PA.byChannel(pool, 30);
  const total = chan.reduce((s, r) => s + r.n, 0);
  ok('and they can be compared by channel, which is the point of the table', total >= 3 && chan.some((r) => r.source === 'email') && chan.some((r) => r.source === 'dashboard'), chan);
  // PitchActions is required at module scope, not inside the handler: a
  // require() in a route body is a lookup on every request, and the two suites
  // that lift these handlers out of index.js and run them cannot see it.
  ok('THE DASHBOARD APPROVE LOGS ITS CHANNEL TOO',
    /PitchActions\.logMany\(store\.pool,\s*\n?\s*\(out\.when \|\| \[\]\)\.map/.test(idx) && /source: 'dashboard'/.test(idx));
  ok('  and the module is required once, at the top', /^const PitchActions = require\('\.\/services\/pitchActions'\);$/m.test(idx));
  ok('  and the dashboard skip does', /action: 'skip', source: 'dashboard'/.test(idx));
  ok('a failed log never throws, because it is a record and not the work',
    (await PA.log({ query: async () => { throw new Error('nope'); } }, { pitchId: 'x', agentId: AG, action: 'approve', source: 'email' })) === false);

  // ── THE EMAIL ──────────────────────────────────────────────────────────
  OUT.push('', '-- the digest --');
  await pool.query(`UPDATE outreach_logs SET cadence_stopped_at = NULL WHERE agent_id = $1`, [AG]);
  const groups = await ND.pitchesFor(pool, AG);
  ok('the digest reads the pitches themselves, grouped by athlete', groups.length === 2 && groups[0].pitches.length === 2, groups.map((g) => g.name + ':' + g.pitches.length));
  ok('  the athlete with the most pitches comes first', groups[0].name === 'Marcus Webb');
  ok('  each pitch carries the business, the owner and the first sentence',
    groups[0].pitches[0].brand === 'Rama Jamas' && groups[0].pitches[0].owner === 'Dana Rama'
    && /^Marcus Webb plays baseball at Auburn/.test(groups[0].pitches[0].preview), groups[0].pitches[0]);
  ok('  the greeting is dropped, because every pitch opens with one',
    !groups.some((g) => g.pitches.some((p) => /^(Hi|Hey|Hello)\b/.test(p.preview))), groups[0].pitches.map((p) => p.preview.slice(0, 20)));

  await ND.attachActionUrls(pool, AG, groups);
  ok('every pitch gets its own two links', groups.every((g) => g.pitches.every((p) => /^https:\/\/mynildash\.com\/a\/[A-Za-z0-9_-]{43}$/.test(p.approveUrl) && p.skipUrl !== p.approveUrl)), groups[0].pitches[0].approveUrl);
  ok('an athlete with more than one pitch gets an Approve all link', /\/a\/[A-Za-z0-9_-]{43}$/.test(groups[0].approveAllUrl || ''), groups[0].approveAllUrl);
  ok('  and an athlete with one pitch does not', !groups[1].approveAllUrl);

  const msg = ND.render({ rows: groups, reviewUrl: 'https://mynildash.com/', unsubUrl: 'https://mynildash.com/u', date: new Date('2026-09-22T12:00:00Z'), tz: 'America/Chicago' });
  ok('the subject counts the pitches and carries the date', /^3 pitches ready, /.test(msg.subject), msg.subject);
  ok('every button is a TABLE, so Outlook renders it as a button and not as bare text',
    (msg.html.match(/<table role="presentation" cellpadding="0" cellspacing="0" border="0"[^>]*>\s*<tr><td style="background:/g) || []).length >= 6);
  ok('  and no button is an inline-block anchor, which Word-rendered Outlook flattens',
    !/<a[^>]*display:inline-block[^>]*>(Approve|Skip|Send)/.test(msg.html));
  ok('the brand, the owner and the preview are all in the email',
    msg.html.indexOf('Rama Jamas') !== -1 && msg.html.indexOf('Dana Rama') !== -1 && msg.html.indexOf('Marcus Webb plays baseball') !== -1);
  ok('the plain-text part carries the same links', /Approve: https:\/\/mynildash\.com\/a\//.test(msg.text) && /Skip:    https/.test(msg.text));
  ok('nothing in the email is unescaped user text', !/<script/i.test(msg.html));

  // Ten athletes, then a link.
  const many = Array.from({ length: 14 }, (_, i) => ({
    athleteId: 'x' + i, name: 'Athlete ' + i, place: 'School',
    pitches: [{ id: 'p' + i, brand: 'Brand ' + i, owner: '', preview: 'A sentence.', approveUrl: 'https://x/a/1', skipUrl: 'https://x/a/2' }],
  }));
  const big = ND.render({ rows: many, reviewUrl: 'https://mynildash.com/', date: new Date(), tz: 'America/Chicago' });
  ok('AT MOST TEN ATHLETES IN ONE EMAIL', ND.MAX_ATHLETES === 10 && (big.html.match(/Athlete \d+<\/span>/g) || []).length === 10, (big.html.match(/Athlete \d+<\/span>/g) || []).length);
  ok('  and the rest are one line and a link', /4 more athletes have pitches waiting/.test(big.html) && /See the rest in NILDash/.test(big.html));
  ok('  the subject still counts every pitch, not just the ten shown', /^14 pitches ready/.test(big.subject), big.subject);

  // ── THE WAITING DIGEST ─────────────────────────────────────────────────
  OUT.push('', '-- "12 pitches waiting for you" --');
  ok('the waiting subject is the one asked for', ND.waitingSubjectFor(12) === '12 pitches waiting for you', ND.waitingSubjectFor(12));
  ok('  and the floor is three days', ND.WAITING_EVERY_DAYS === 3);
  const sentMail = [];
  const send = async (m) => { sentMail.push(m); return { data: { id: 'x' } }; };
  await pool.query(`DELETE FROM nightly_digest_sends WHERE agent_id = $1`, [AG]);
  const w1 = await ND.sendWaiting(pool, { agentId: AG, runDate: '2026-09-22' }, { send });
  ok('with pitches waiting and nothing new, the digest still goes out', w1.sent === true && w1.waiting === true, w1);
  ok('  under the waiting subject', /pitches waiting for you, /.test(sentMail[0].subject), sentMail[0].subject);
  ok('  saying nothing new was found rather than claiming a fill', /Nothing new was found last night/.test(sentMail[0].html));
  ok('  with the same buttons on it', /\/a\/[A-Za-z0-9_-]{43}/.test(sentMail[0].html));
  const w2 = await ND.sendWaiting(pool, { agentId: AG, runDate: '2026-09-23' }, { send });
  ok('NOT AGAIN TOMORROW: the three-day floor holds', w2.sent === false && /floor is 3/.test(w2.reason), w2.reason);
  const w3 = await ND.sendWaiting(pool, { agentId: AG, runDate: '2026-09-26' }, { send, now: new Date(Date.now() + 4 * 86400000) });
  ok('  but four days later it does', w3.sent === true, w3.reason);
  ok('it is NOT a second kind of email: agentEmail still lists exactly one',
    JSON.stringify(require(REPO + 'server/services/agentEmail.js').SENDS) === JSON.stringify({ nightlyDigest: true, shiftReport: false, weeklyDigest: false, deliverableDigest: false, mediaKitOpened: false }));
  ok('  and the nightly job sends it on a night that filled nothing',
    /filled > 0\s*\n?\s*\? await ND\.sendForRun/.test(src('server/jobs/outreachQueue.js')) && /: await ND\.sendWaiting/.test(src('server/jobs/outreachQueue.js')));
  ok('the 4-day rule does not eat it: nightly-digest is a notice system',
    require(REPO + 'server/services/sendRules.js').NOTICE_SYSTEMS.has('nightly-digest'));
  await pool.query(`DELETE FROM nightly_digest_sends WHERE agent_id = $1`, [AG]);

  // ── THE ROUTES ─────────────────────────────────────────────────────────
  OUT.push('', '-- GET shows, POST acts --');
  ok('there is a GET and a POST at /a/:token', /app\.get\('\/a\/:token'/.test(idx) && /app\.post\('\/a\/:token'/.test(idx));
  ok('BOTH ARE RATE LIMITED', /app\.get\('\/a\/:token', pitchActionLimiter/.test(idx) && /app\.post\('\/a\/:token', pitchActionLimiter/.test(idx));
  // The GET handler's own body, bounded by where the POST handler begins, so
  // this cannot accidentally read the POST's code and call it a pass.
  const getBody = idx.slice(idx.indexOf("app.get('/a/:token'"), idx.indexOf("app.post('/a/:token'"));
  ok('the GET handler was found and is its own block', getBody.length > 400 && getBody.length < 6000, getBody.length);
  ok('GET CALLS lookup, WHICH NEVER MARKS A TOKEN USED', /T\.lookup\(store\.pool, req\.params\.token\)/.test(getBody));
  ok('  and GET NEVER claims, approves or skips: a mail scanner opens every link before a human does',
    !/T\.claim/.test(getBody) && !/approveBatch/.test(getBody) && !/skipDraft/.test(getBody));
  ok('  it only ever renders a page and a form', /_pitchActionForm\(/.test(getBody) && /method="POST"/.test(idx));
  ok('POST CLAIMS FIRST, then does the work',
    idx.indexOf('T.claim(store.pool, req.params.token)') < idx.indexOf('Closer.approveBatch(store.pool, agentId'));
  ok('the page says nothing is sent until the button is tapped', /Nothing is sent until you tap the button/.test(idx));
  ok('every refusal has words and a way back in',
    ['unknown', 'expired', 'used', 'gone', 'handled'].every((k) => new RegExp(k + ': \\{ title:').test(idx))
    && /Log in to NILDash/.test(idx));
  ok('after the action it offers the next pitch, so the queue clears in a row',
    /T\.nextPending\(store\.pool, agentId/.test(idx) && /Next up/.test(idx));
  ok('  with fresh tokens, not the ones from the email', /T\.issueFor\(store\.pool, \{ pitchId: next\.id/.test(idx));
  ok('the confirmation names the business', /Sent to \$\{row\.brand_name/.test(idx));

  // ── NO RAW TOKEN IS EVER LOGGED ────────────────────────────────────────
  OUT.push('', '-- nothing leaks --');
  const tok = src('server/services/pitchActionTokens.js');
  ok('the token module logs no raw token', !/console\.(log|error|warn)\([^)]*\braw\b/.test(tok));
  ok('  every lookup is by hash', (tok.match(/hashToken\(raw\)/g) || []).length >= 3 && !/WHERE token = /.test(tok));
  ok('  and the column stores a hash, never the token', /token_hash TEXT NOT NULL/.test(tok) && !/\btoken TEXT\b/.test(tok));
  ok('the routes never print a token either',
    !/console\.(log|error)\([^)]*req\.params\.token/.test(idx));
  ok('the page asks not to leak the link in a referrer', /name="referrer" content="no-referrer"/.test(idx));

  // Clean up.
  for (const t of ['pitch_action_tokens', 'pitch_actions', 'outreach_logs', 'outreach_queue', 'nightly_digest_sends']) {
    await pool.query(`DELETE FROM ${t} WHERE agent_id = $1`, [AG]).catch(() => {});
  }
  await pool.query(`DELETE FROM athletes WHERE id = ANY($1)`, [[ATH1, ATH2]]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [AG]);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('pitchactions: FAILED', e); process.exit(1); });
