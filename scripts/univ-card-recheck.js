'use strict';
// WHICH OF A UNIVERSITY'S CARDS TODAY'S RULES WOULD DROP. Read only.
//
// Every pitch card not yet worked (not sent, not moved along in the CRM),
// judged again the way the night judges a business and a contact at pick
// time:
//   DROPPED          the business is refused (teamScan.blockedFor: a national
//                    chain or hotel brand, an incumbent, a school, a
//                    restricted category); no card for it from tonight
//   CONTACT REMOVED  the business stays, the named person on the card is
//                    refused (campusQuality.refusedTitle / refusedName: a
//                    junior manager, a non-marketing department); tonight's
//                    card for it goes to the business, not to them
// Nothing is changed.
//
//   node scripts/univ-card-recheck.js --university univ-cypress
//   /api/admin/scripts/univ-card-recheck?university=univ-cypress&text=1
const path = require('path');
const ROOT = path.join(__dirname, '..') + path.sep;
const store = require(ROOT + 'server/store.js');
const INIT_WAIT_MS = parseInt(process.env.INIT_WAIT_MS, 10) || 8000;
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : null; };

async function run(pool, universityId) {
  const TS = require(ROOT + 'server/services/teamScan.js');
  const QC = require(ROOT + 'server/services/campusQuality.js');
  const CP = require(ROOT + 'server/services/campusPool.js');
  const u = await CP.universityOf(pool, universityId);
  if (!u) return { ok: false, lines: [`no university "${universityId}"`] };
  const cards = (await pool.query(
    `SELECT d.id, d.night, d.brand_name, d.contact_name, d.contact_title, d.lane, t.name AS team,
            m.types, m.primary_type, m.primary_type_label
       FROM university_drafts d
       LEFT JOIN university_teams t ON t.id = d.team_id
       LEFT JOIN university_market_seen m ON m.market_key = $2 AND m.brand = d.brand_name
      WHERE d.university_id = $1 AND d.kind = 'pitch' AND d.sent_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM university_crm r WHERE r.university_id = d.university_id AND r.brand = d.brand_name AND r.stage <> 'not_contacted')
      ORDER BY d.night DESC, t.name, d.brand_name`, [u.id, u.marketKey])).rows;
  const dropped = [], removed = [];
  for (const c of cards) {
    const b = TS.blockedFor({ name: c.brand_name, types: c.types || [], primary_type: c.primary_type, primary_type_label: c.primary_type_label });
    if (b) { dropped.push({ ...c, why: `${b.key}: ${b.why}` }); continue; }
    if (c.lane !== 'social' && c.contact_name) {
      const why = QC.refusedName(c.contact_name) || QC.refusedTitle(c.contact_title);
      if (why) removed.push({ ...c, why });
    }
  }
  const nightOf = (x) => String(x.night instanceof Date ? x.night.toISOString() : x.night || '').slice(0, 10);
  const L = [`${u.name}: ${cards.length} card(s) not yet worked, judged by today's rules (read only)`, '',
    `DROPPED (the business is refused; no card for it from tonight): ${dropped.length}`];
  for (const x of dropped) L.push(`  ${nightOf(x)}  ${String(x.team || '-').padEnd(24)} ${String(x.brand_name).padEnd(36)} ${x.why}`);
  L.push('', `CONTACT REMOVED (the business stays; the card goes to the business, not this person): ${removed.length}`);
  for (const x of removed) L.push(`  ${nightOf(x)}  ${String(x.team || '-').padEnd(24)} ${String(x.brand_name).padEnd(36)} ${x.contact_name} (${x.contact_title || 'no title'}): ${x.why}`);
  L.push('', 'Nothing was changed. The night applies these rules at pick time from tonight.');
  return { ok: true, lines: L, dropped, removed, cards: cards.length };
}

if (require.main === module) {
  (async () => {
    await new Promise((r) => setTimeout(r, INIT_WAIT_MS));
    const out = await run(store.pool, String(arg('university') || 'univ-cypress'));
    console.log(out.lines.join('\n'));
    process.exit(out.ok ? 0 : 1);
  })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { run };
