'use strict';
// Runs against the local test Postgres.
//
//   node tests/agentaddress.js
//
// ── THE POSTAL ADDRESS ON AN AGENT'S EMAIL IS THE AGENT'S ───────────────────
// Every agent's outreach printed BUSINESS_MAILING_ADDRESS, which was the
// founder's home address, until an agent asked why it was on his emails.
// Now the footer carries the agent's own business address from Settings;
// BUSINESS_MAILING_ADDRESS is the NILDash fallback for an agent who has sent
// before; an agent with no address cannot send a first email.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const store = require(REPO + 'server/store.js');
  const CS = require(REPO + 'server/services/canSpam.js');
  const Closer = require(REPO + 'server/services/closer.js');
  const P = store.pool;
  const NEW = 'u-addr-new', OLD = 'u-addr-old', OWN = 'u-addr-own';
  const clean = async () => {
    await P.query(`DELETE FROM outreach_logs WHERE agent_id IN ($1,$2,$3)`, [NEW, OLD, OWN]);
    await P.query(`DELETE FROM athletes WHERE agent_id IN ($1,$2,$3)`, [NEW, OLD, OWN]);
    await P.query(`DELETE FROM users WHERE id IN ($1,$2,$3)`, [NEW, OLD, OWN]);
  };
  await clean();
  const saved = process.env.BUSINESS_MAILING_ADDRESS;
  process.env.BUSINESS_MAILING_ADDRESS = 'NILDash, PO Box 100, Birmingham, AL 35201';
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'New Agent','new@addr.example','x','agent'),
                  ($2,'Old Agent','old@addr.example','x','agent'), ($3,'Own Agent','own@addr.example','x','agent')`, [NEW, OLD, OWN]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('addr-ath-new',$1,'{"name":"N One","dob":"2003-01-01"}'::jsonb), ('addr-ath-old',$2,'{"name":"O One","dob":"2003-01-01"}'::jsonb)`, [NEW, OLD]);
  await P.query(`UPDATE users SET business_street = '200 Commerce St', business_city = 'Montgomery', business_state = 'AL', business_zip = '36104' WHERE id = $1`, [OWN]);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, sent_at)
                 VALUES ('addr-sent-1',$1,'addr-ath-old','Taco Spot','Hi','<p>x</p>','sent','owner@taco.example', NOW() - INTERVAL '3 days')`, [OLD]);

  // ── WHOSE ADDRESS ─────────────────────────────────────────────────────────
  const own = await CS.senderAddress(P, OWN);
  ok('AN AGENT WITH AN ADDRESS: their own on the footer', own.ok && own.source === 'agent' && own.address === '200 Commerce St, Montgomery, AL 36104', own);
  const old = await CS.senderAddress(P, OLD);
  ok('AN AGENT WHO HAS SENT, NO ADDRESS YET: the NILDash fallback from the env', old.ok && old.source === 'nildash' && /PO Box 100/.test(old.address), old);
  const neu = await CS.senderAddress(P, NEW);
  ok('AN AGENT WITH NO ADDRESS AND NO SENDS: refused, with why', !neu.ok && neu.code === 'NEEDS_BUSINESS_ADDRESS' && /business address in Settings/.test(neu.why) && /CAN-SPAM/.test(neu.why), neu);
  delete process.env.BUSINESS_MAILING_ADDRESS;
  ok('no fallback set: an agent without their own address is refused, never a made-up one', !(await CS.senderAddress(P, OLD)).ok && (await CS.senderAddress(P, OWN)).ok);
  ok('  and nothing in the code holds an address of its own', !/\d{2,5} [A-Z][a-z]+ (St|Ave|Rd|Dr|Blvd|Way|Ln)\b/.test(fs.readFileSync(REPO + 'server/services/canSpam.js', 'utf8')));
  process.env.BUSINESS_MAILING_ADDRESS = 'NILDash, PO Box 100, Birmingham, AL 35201';

  // ── THE FOOTER ────────────────────────────────────────────────────────────
  const html = CS.appendHtml('<p>Hello</p>', 'owner@shop.example', { senderName: 'Own Agent', address: own.address });
  ok('THE FOOTER PRINTS THE AGENT\'S ADDRESS, not the fallback', /200 Commerce St, Montgomery, AL 36104/.test(html) && !/PO Box 100/.test(html), html);

  // ── REQUIRED BEFORE THE FIRST SEND ────────────────────────────────────────
  const ab = await Closer.approveBatch(P, NEW, { ids: ['addr-x'] });
  ok('APPROVE IS REFUSED UP FRONT for a first send with no address, saying why', ab.blocked && ab.needsBusinessAddress && /business address/.test(ab.note), ab);
  await P.query(`INSERT INTO outreach_logs (id, agent_id, athlete_id, brand_name, subject, body_html, status, sent_to_email, approved_at, scheduled_send_at, touch_no)
                 VALUES ('addr-approved-1',$1,'addr-ath-new','Bake Shop','Hi','<p>x</p>','approved','owner@bake.example', NOW(), NOW() - INTERVAL '1 minute', 1)`, [NEW]);
  const sent = [];
  const rel = await Closer.releaseDue(P, { send: async (log) => { sent.push(log.id); return { providerMessageId: 'm1' }; }, sleep: async () => {} });
  const row = (await P.query(`SELECT status, sent_at, send_hold_reason FROM outreach_logs WHERE id = 'addr-approved-1'`)).rows[0];
  ok('THE RELEASE HOLDS IT with the reason on the card, and sends nothing', !sent.includes('addr-approved-1') && !row.sent_at && /business address in Settings/.test(row.send_hold_reason || ''), { row, rel: rel.detail });

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  ok('  all four are required', !CS.cleanAddress({ street: '1 Main', city: '', state: 'AL', zip: '35201' }).ok);
  ok('  a ZIP is five digits', !CS.cleanAddress({ street: '1 Main', city: 'X', state: 'AL', zip: '352' }).ok && CS.cleanAddress({ street: '1 Main', city: 'X', state: 'al', zip: '35201-1234' }).ok);
  const idx = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('saving the address releases what was held for it', /app\.post\('\/api\/agent\/business-address'/.test(idx) && /send_hold_reason = \$2`,\s*\[req\.session\.userId, CS\.FIRST_SEND_WHY\]/.test(idx));
  const page = fs.readFileSync(REPO + 'public/index.html', 'utf8');
  ok('THE PROMPT AT SIGN-IN: an agent with no address is asked for it, with why', /promptBusinessAddress/.test(page) && /setTimeout\(promptBusinessAddress, 400\)/.test(page)
    && /Add your business address\.<\/b> The law \(CAN-SPAM\)/.test(page) && /id="biz-address-card"/.test(page));
  if (saved === undefined) delete process.env.BUSINESS_MAILING_ADDRESS; else process.env.BUSINESS_MAILING_ADDRESS = saved;
  await clean();
}
main().then(() => { console.log(OUT.join('\n')); console.log(`\nfailures: ${F}`); process.exit(F ? 1 : 0); })
  .catch((e) => { console.log(OUT.join('\n')); console.log('FAIL threw: ' + (e && e.stack)); process.exit(1); });
