'use strict';
// ── EVERY UNSENT DRAFT, CHECKED FOR A PLACEHOLDER ───────────────────────────
//
// A DM reached the queue reading "https://www.instagram.com/[athlete_handle]".
// New drafts drop such a line (services/placeholders). This finds the ones
// already stored and not yet sent:
//
//   outreach_queue.dm_text          cards still on an agent's screen
//   outreach_logs subject/body_html drafts awaiting approval or approved, unsent
//   university_drafts subject/body  asks awaiting approval
//   email_drafts subject/body_html  mailbox drafts
//   growth_sequences                stored templates (sent as written)
//
// Report only by default. --apply removes the lines that hold a placeholder
// from DM text and bodies (the same rule as new drafts). A subject or a stored
// template is only reported: a person should rewrite those.
//
//   node scripts/placeholder-audit.js           report
//   node scripts/placeholder-audit.js --apply
//   /api/admin/scripts/placeholder-audit?text=1  (&apply=1)
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const PH = require(ROOT + 'server/services/placeholders.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const APPLY = process.argv.includes('--apply');

const textOf = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const safe = async (P, sql, args) => { try { return (await P.query(sql, args || [])).rows; } catch (e) { return { error: e.message }; } };

async function main() {
  await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
  const P = store.pool;
  const found = [];   // { where, id, who, field, slots, fixable }
  const skipped = [];

  const cards = await safe(P, `SELECT q.id, q.dm_text, q.brand_name, a.data->>'name' AS athlete, u.name AS agent
       FROM outreach_queue q LEFT JOIN athletes a ON a.id = q.athlete_id LEFT JOIN users u ON u.id = q.agent_id
      WHERE q.sent_at IS NULL AND q.state NOT IN ('retired','sent','expired') AND q.dm_text IS NOT NULL`);
  if (cards.error) skipped.push('outreach_queue: ' + cards.error);
  else for (const r of cards) {
    const s = PH.find(r.dm_text);
    if (s.length) found.push({ where: 'card DM', table: 'outreach_queue', col: 'dm_text', id: r.id, who: `${r.agent || '?'} / ${r.athlete || '?'} -> ${r.brand_name}`, slots: s, fixable: true, value: r.dm_text });
  }

  const logs = await safe(P, `SELECT l.id, l.subject, l.body_html, l.brand_name, l.status, a.data->>'name' AS athlete, u.name AS agent
       FROM outreach_logs l LEFT JOIN athletes a ON a.id = l.athlete_id LEFT JOIN users u ON u.id = l.agent_id
      WHERE l.sent_at IS NULL AND l.status IN ('draft','approved')`);
  if (logs.error) skipped.push('outreach_logs: ' + logs.error);
  else for (const r of logs) {
    const who = `${r.agent || '?'} / ${r.athlete || '?'} -> ${r.brand_name} (${r.status})`;
    const sb = PH.find(textOf(r.body_html));
    if (sb.length) found.push({ where: 'email draft body', table: 'outreach_logs', col: 'body_html', html: true, id: r.id, who, slots: sb, fixable: true, value: r.body_html });
    const ss = PH.find(r.subject);
    if (ss.length) found.push({ where: 'email draft subject', id: r.id, who, slots: ss, fixable: false });
  }

  const uni = await safe(P, `SELECT d.id, d.subject, d.body, d.brand_name, d.team_id FROM university_drafts d WHERE d.status = 'awaiting_approval'`);
  if (uni.error) skipped.push('university_drafts: ' + uni.error);
  else for (const r of uni) {
    const sb = PH.find(r.body);
    if (sb.length) found.push({ where: 'university ask body', table: 'university_drafts', col: 'body', id: r.id, who: `team ${r.team_id} -> ${r.brand_name}`, slots: sb, fixable: true, value: r.body });
    const ss = PH.find(r.subject);
    if (ss.length) found.push({ where: 'university ask subject', id: r.id, who: `team ${r.team_id} -> ${r.brand_name}`, slots: ss, fixable: false });
  }

  const mail = await safe(P, `SELECT id, subject, body_html FROM email_drafts`);
  if (mail.error) skipped.push('email_drafts: ' + mail.error);
  else for (const r of mail) {
    const s = PH.find(textOf(r.body_html)).concat(PH.find(r.subject));
    if (s.length) found.push({ where: 'mailbox draft', id: r.id, who: 'mailbox draft', slots: s, fixable: false });
  }

  const seq = await safe(P, `SELECT type, subject1, body1, subject2, body2, subject3, body3 FROM growth_sequences`);
  if (seq.error) skipped.push('growth_sequences: ' + seq.error);
  else for (const r of seq) {
    for (const f of ['subject1', 'body1', 'subject2', 'body2', 'subject3', 'body3']) {
      const s = PH.find(textOf(r[f]));
      if (s.length) found.push({ where: 'growth sequence template', id: `${r.type}.${f}`, who: `sequence "${r.type}"`, slots: s, fixable: false });
    }
  }

  const byWhere = {};
  for (const f of found) byWhere[f.where] = (byWhere[f.where] || 0) + 1;
  const slotCount = {};
  for (const f of found) for (const s of f.slots) slotCount[s] = (slotCount[s] || 0) + 1;
  console.log(`UNSENT DRAFTS HOLDING A PLACEHOLDER  ${APPLY ? 'APPLY' : 'report only (add --apply to remove the lines)'}`);
  console.log(`checked: ${Array.isArray(cards) ? cards.length : 0} card DM(s), ${Array.isArray(logs) ? logs.length : 0} unsent email draft(s), `
    + `${Array.isArray(uni) ? uni.length : 0} university ask(s), ${Array.isArray(mail) ? mail.length : 0} mailbox draft(s), `
    + `${Array.isArray(seq) ? seq.length : 0} growth sequence(s)`);
  console.log(`${found.length} found` + (found.length ? ': ' + Object.entries(byWhere).map(([k, n]) => `${n} ${k}`).join(', ') : ''));
  if (Object.keys(slotCount).length) console.log('placeholders: ' + Object.entries(slotCount).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join(', '));
  for (const f of found) console.log(`  ${f.where}  ${f.id}  ${f.who}: ${f.slots.join(', ')}${f.fixable ? '' : '  (report only: rewrite by hand)'}`);
  for (const s of skipped) console.log(`  could not read ${s}`);

  if (APPLY) {
    let n = 0;
    for (const f of found.filter((x) => x.fixable)) {
      const next = f.html ? PH.dropLinesHtml(f.value).html : PH.dropLines(f.value).text;
      // Only if it has not changed since it was read, and only while unsent.
      const guard = f.table === 'university_drafts' ? `AND status = 'awaiting_approval'` : 'AND sent_at IS NULL';
      const u = await P.query(`UPDATE ${f.table} SET ${f.col} = $2 WHERE id = $1 AND ${f.col} = $3 ${guard}`, [f.id, next, f.value]);
      n += u.rowCount;
    }
    console.log(`\nremoved the placeholder line(s) from ${n} draft(s)`);
  }
}

main().catch((e) => { console.error('placeholder-audit failed:', e && e.stack || e); process.exitCode = 1; })
  .finally(async () => { try { await store.pool.end(); } catch (_) {} });
