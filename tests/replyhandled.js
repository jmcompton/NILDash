'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// The reply that would not go away, and the expiry that said nothing.
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const SR = require(ROOT + 'server/services/shiftReport.js');
const SE = require(ROOT + 'server/services/shiftEmail.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d ? '   ' + d : '')); };

const AG = 'rh-agent', ATH = 'rh-ath';
const q = async (P) => async (label, sql, params) => (await P.query(sql, params)).rows;

// The route's UPDATE, verbatim, so the test exercises what ships.
async function markHandled(P, id, agentId, handled) {
  return (await P.query(
    `UPDATE outreach_logs
        SET reply_handled_at = CASE WHEN $3 THEN NOW() ELSE NULL END, updated_at = NOW()
      WHERE id = $1 AND agent_id = $2 AND replied_at IS NOT NULL
      RETURNING id, replied_at, reply_handled_at`, [id, agentId, handled])).rows[0] || null;
}

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const Q = await q(P);

  for (const t of ['outreach_logs', 'outreach_queue', 'brand_match_scores', 'athletes'])
    await P.query(`DELETE FROM ${t} WHERE agent_id=$1`, [AG]).catch(() => {});
  await P.query(`DELETE FROM users WHERE id=$1`, [AG]).catch(() => {});
  await P.query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'J','rh@x.com','x','agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3)`,
    [ATH, AG, JSON.stringify({ name: 'Kaden House', school: 'Maryland', dob: '2005-04-11' })]);

  const mkReply = async (id, brand, daysAgo) => {
    await P.query(
      `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html,
                                  status, sent_at, replied_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'A partnership idea','<p>x</p>','replied',
               NOW() - ($5 || ' days')::interval, NOW() - ($5 || ' days')::interval,
               NOW() - ($5 || ' days')::interval, NOW() - ($5 || ' days')::interval)`,
      [id, AG, ATH, brand, String(daysAgo)]);
  };

  console.log('\n1. The Ourisman case: a reply seven days old');
  await mkReply('log-ourisman', 'Ourisman Ford', 7);
  let n = await SR.buildNeedsYou(P, AG, Q, null);
  let replies = n.items.filter((i) => i.kind === 'reply');
  check('a week-old reply is still surfacing before the fix is applied to it',
    replies.length === 1 && /Ourisman/.test(replies[0].line), replies[0] && replies[0].line);

  const subj1 = SE.renderShiftEmail({ run: { ran: true }, sentence: 'x', needsYou: n,
    moving: null, closer: null, roles: [] }, {}).subject;
  check('and it owns the subject line', /Ourisman/.test(subj1), subj1);

  console.log('\n2. Handled clears it — and nothing else does');
  // Prove the old exit really is dead: setting status to the value the query
  // used to filter on changes nothing.
  await P.query(`UPDATE outreach_logs SET status='closed' WHERE id='log-ourisman'`);
  n = await SR.buildNeedsYou(P, AG, Q, null);
  check("status='closed' no longer has any effect (it never was written by anything)",
    n.items.filter((i) => i.kind === 'reply').length === 1);
  await P.query(`UPDATE outreach_logs SET status='replied' WHERE id='log-ourisman'`);

  const res = await markHandled(P, 'log-ourisman', AG, true);
  check('the route stamps reply_handled_at', res && res.reply_handled_at, res && String(res.reply_handled_at));
  n = await SR.buildNeedsYou(P, AG, Q, null);
  check('the reply is gone from NEEDS YOU', n.items.filter((i) => i.kind === 'reply').length === 0);

  const subj2 = SE.renderShiftEmail({ run: { ran: true }, sentence: 'x', needsYou: n,
    moving: null, closer: null, roles: [] }, {}).subject;
  check('and out of the subject line', !/Ourisman/.test(subj2), subj2);

  console.log('\n3. Reversible, and scoped');
  await markHandled(P, 'log-ourisman', AG, false);
  n = await SR.buildNeedsYou(P, AG, Q, null);
  check('un-handling brings it back — a misclick cannot hide a live reply forever',
    n.items.filter((i) => i.kind === 'reply').length === 1);
  await markHandled(P, 'log-ourisman', AG, true);

  check('another agent cannot mark it handled', (await markHandled(P, 'log-ourisman', 'someone-else', true)) === null);

  await P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, created_at)
     VALUES ('log-neverreplied',$1,$2,'Never Replied','s','<p>x</p>','sent', NOW())`, [AG, ATH]);
  check('an outreach with no reply cannot be marked handled',
    (await markHandled(P, 'log-neverreplied', AG, true)) === null);

  console.log('\n4. A second reply still comes through');
  await mkReply('log-fresh', 'Vigilante Coffee', 0);
  n = await SR.buildNeedsYou(P, AG, Q, null);
  replies = n.items.filter((i) => i.kind === 'reply');
  check('handling one reply does not suppress the next',
    replies.length === 1 && /Vigilante/.test(replies[0].line), replies[0] && replies[0].line);

  console.log('\n5. Expiry says what it took');
  await P.query(
    `INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, created_at, updated_at)
     VALUES ('log-exp1',$1,$2,'Gone One','s','<p>kept</p>','expired', NOW() - INTERVAL '9 days', NOW() - INTERVAL '2 hours'),
            ('log-exp2',$1,$2,'Gone Two','s','<p>kept</p>','expired', NOW() - INTERVAL '9 days', NOW() - INTERVAL '3 hours'),
            ('log-old', $1,$2,'Long Gone','s','<p>kept</p>','expired', NOW() - INTERVAL '40 days', NOW() - INTERVAL '20 days')`,
    [AG, ATH]);
  const audit = await SR.buildDraftAudit(P, AG, Q);
  check('counts only what expired in the last day', audit.expiredRecent === 2, 'expiredRecent=' + audit.expiredRecent);
  check('the lifetime count is still separate', audit.expired === 3, 'expired=' + audit.expired);

  const mail = SE.renderShiftEmail({ run: { ran: true }, sentence: 'x', needsYou: n,
    moving: null, closer: null, roles: [], draftAudit: audit }, {});
  check('the email says how many went', /2 drafts\s*\n?\s*expired in the last day/.test(mail.html.replace(/\s+/g, ' '))
    || /2 drafts expired in the last day/.test(mail.html.replace(/\s+/g, ' ')), 'html');
  check('it names the window that took them', /7 days with no send/.test(mail.html.replace(/\s+/g, ' ')));
  check('it says nothing was deleted', /Nothing was deleted/.test(mail.html));
  check('the plain text carries the same line', /2 drafts expired in the last day/.test(mail.text.replace(/\s+/g, ' ')));

  const quiet = SE.renderShiftEmail({ run: { ran: true }, sentence: 'x', needsYou: n,
    moving: null, closer: null, roles: [], draftAudit: { ...audit, expiredRecent: 0 } }, {});
  check('and says nothing on a day when nothing expired', !/expired in the last day/.test(quiet.html + quiet.text));

  console.log('\n6. Still no MOVING');
  check('no dollar figure anywhere', !/\$\d/.test(mail.html + mail.text),
    (mail.html + mail.text).match(/\$\d[\d.,KM]*/g) || '(none)');

  const bad = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - bad.length) + '/' + out.length + ' passed');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
