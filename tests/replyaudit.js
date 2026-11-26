'use strict';
// node tests/replyaudit.js : services/replyAudit, the read-only breakdown of
// sent pitches. It counts, it never names a business, and only the admin gets it.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = require('./helpers/freshDb').freshDb('replyaudittest', { schema: true });
const WAIT = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
let F = 0, N = 0;
const ok = (n, c, g) => { N++; if (c) console.log('  PASS  ' + n); else { F++; console.log('  FAIL  ' + n + (g !== undefined ? '   got=' + JSON.stringify(g).slice(0, 600) : '')); } };
(async () => {
  await new Promise((r) => setTimeout(r, WAIT));
  const P = require(REPO + 'server/store').pool;
  const A = require(REPO + 'server/services/replyAudit');
  ok('an address is sorted by kind', A.addressKind('info@riverbendsports.com').startsWith('shared inbox') && A.addressKind('dana@riverbendsports.com') === 'named person at the business'
    && A.addressKind('dana.w@gmail.com').startsWith('personal mail') && A.addressKind('') === 'no address on file');
  ok('a pitch is read as text', A.text('<p>Hi Dana,</p><p>Quick&nbsp;idea &amp; a question?<br>Thanks</p>') === 'Hi Dana,\n\nQuick idea & a question?\nThanks');
  await P.query(`INSERT INTO users (id, email, name, password, role) VALUES ('ag1', 'a@x.com', 'An Agent', 'x', 'agent')`);
  await P.query(`INSERT INTO company_enrichment (id, agent_id, brand_name) VALUES ('e1', 'ag1', 'Riverbend Sports')`);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('a1', 'ag1', '{"name":"X"}')`);
  const contact = async (id, email, name, title) => { await P.query(`INSERT INTO brand_contacts (id, agent_id, enrichment_id, brand_name, email, name, title, source, confidence_score) VALUES ($1, 'ag1', 'e1', 'Riverbend Sports', $2, $3, $4, 'hunter', 90)`, [id, email, name, title]); };
  await contact('c1', 'dana@riverbendsports.com', 'Dana Whitfield', 'Owner');
  await contact('c2', 'info@riverbendsports.com', null, null);
  const log = async (id, cid, o = {}) => { await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, contact_id, subject, body_html, status, sent_at, opened_at, replied_at, follow_up_count)
    VALUES ($1, 'ag1', 'a1', 'Riverbend Sports', $2, $3, $4, $5, $6, $7, $8, $9)`, [id, cid, o.subject || 'A quick idea', o.body || '<p>Hi, would you be open to a quick chat? ' + 'word '.repeat(60) + '</p>', o.status || 'sent', o.sent === null ? null : (o.sent || '2026-10-13T15:30:00Z'), o.opened || null, o.replied || null, o.fu || 0]); };
  await log('l1', 'c1', { opened: '2026-10-13T16:00:00Z', replied: '2026-10-14T16:00:00Z' });
  await log('l2', 'c2', { opened: '2026-10-13T16:00:00Z', fu: 2 });
  await log('l3', 'c2', {});
  await log('l4', 'c2', { subject: 'Different', body: '<p>' + 'long '.repeat(220) + '</p>' });
  await log('l5', 'c1', { sent: null, status: 'draft' });
  const r = await A.report(P);
  ok('only pitches that went out are counted', r.total.sent === 4 && r.total.opened === 2 && r.total.replied === 1 && r.total.replyRate === 25, r.total);
  const by = (list, g) => list.find((x) => x.group.startsWith(g)) || {};
  ok('split by who it was addressed to', by(r.byAddress, 'named person').sent === 1 && by(r.byAddress, 'named person').replied === 1 && by(r.byAddress, 'shared inbox').sent === 3 && by(r.byAddress, 'shared inbox').replyRate === 0, r.byAddress);
  ok('  and by title, length, follow-ups and time sent', by(r.byTitle, 'owner').sent === 1 && by(r.byLength, '200 and up').sent === 1 && by(r.byFollowUps, '2 follow').sent === 1 && by(r.byHour, '8 to 11').sent === 4 && by(r.byDay, 'Tue').sent === 4, [r.byLength, r.byHour, r.byDay]);
  ok('reused subject lines are counted', r.subjectsReused === 1 && r.distinctSubjects === 2);
  const all = JSON.stringify({ ...r, sample: null, replied: null });
  ok('the breakdown names no business, person or address', !/riverbend|dana|whitfield|a@x\.com|An Agent/i.test(all), all.slice(0, 200));
  ok('the pitches to read carry the text and what happened, not who got them', r.sample.length === 3 && r.replied.length === 1 && r.replied[0].replied === true && !('to_email' in r.sample[0]) && /quick chat/.test(r.replied[0].body));
  const SRC = require('fs').readFileSync(REPO + 'server/index.js', 'utf8');
  const blk = SRC.slice(SRC.indexOf("app.get('/api/admin/reply-audit'"), SRC.indexOf("app.get('/api/admin/reply-audit'") + 400);
  ok('the route is the admin\'s alone', /requireAuth/.test(blk) && /_realAdmin\(req\)\)\) return res\.status\(403\)/.test(blk));
  console.log(`\n${N - F}/${N} passed`);
  await P.end().catch(() => {});
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
