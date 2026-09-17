'use strict';
// Runs from a checkout on any machine against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/mybrands.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── MY BRANDS: EVERY BUSINESS FOUND FOR AN AGENT'S ATHLETES, READ-ONLY ─────
//
// One row per athlete per business, from the cards, the engagement ledger
// and the Deal Scan's contacts. The status is derived from the outreach
// records, never guessed. An agent sees only their own athletes' businesses.
// The CSV is exactly the current view plus the date found.

const store = require(REPO + 'server/store.js');
const MB = require(REPO + 'server/services/myBrands.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
const P = () => store.pool;
const A = 'mb-agent-a', B = 'mb-agent-b';
const A1 = 'mb-ath-a1', A2 = 'mb-ath-a2', B1 = 'mb-ath-b1';

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const clean = async () => {
    for (const t of ['outreach_logs', 'outreach_queue', 'brand_engagement', 'brand_contacts', 'deals']) await P().query(`DELETE FROM ${t} WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P().query(`DELETE FROM company_enrichment WHERE id LIKE 'mb-enr-%'`).catch(() => {});
    await P().query(`DELETE FROM brand_evidence_cache WHERE brand LIKE 'MB %'`).catch(() => {});
    await P().query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [[A, B]]).catch(() => {});
    await P().query(`DELETE FROM users WHERE id = ANY($1)`, [[A, B]]).catch(() => {});
  };
  await clean();
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Agent A','mb-a@x.com','x','agent'), ($2,'Agent B','mb-b@x.com','x','agent')`, [A, B]);
  await P().query(`INSERT INTO athletes (id,agent_id,data) VALUES ($1,$2,$3::jsonb), ($4,$2,$5::jsonb), ($6,$7,$8::jsonb)`,
    [A1, A, JSON.stringify({ name: 'Messiah Mickens', school: 'Auburn University', sport: 'football' }),
     A2, JSON.stringify({ name: 'Ann Lee', school: 'Western New Mexico University', sport: 'softball' }),
     B1, B, JSON.stringify({ name: 'Other Agents Kid', school: 'Auburn University', sport: 'football' })]);
  const card = (agent, ath, slot, brand, over) => P().query(
    `INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, why, contact_name, contact_title, email, phone, instagram, instagram_scope, category_key, lane, channel, state, outcome, replied_at, sent_at, created_at, identity_key)
     VALUES ($1,$2,$3,$4,$5,'why',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [agent, ath, slot, 'name:' + brand.toLowerCase(), brand, over.contact || null, over.title || null, over.email || null, over.phone || null, over.instagram || null, over.scope || null,
     over.category || null, over.lane || 'local', over.channel || 'dm', over.state || 'queued', over.outcome || null, over.replied || null, over.sent || null, over.created || new Date().toISOString(), 'name:' + brand.toLowerCase() + '|' + ath]);
  // Agent A, athlete 1: four businesses at four statuses, found on four days.
  await card(A, A1, 1, 'MB Legion Hair Studio', { contact: 'Dana Roberts', title: 'Owner', email: 'dana@legion.example', category: 'salon', created: '2026-09-10T02:00:00Z' });
  await card(A, A1, 2, 'MB Trak Shak', { contact: 'Jeff Martinez', title: 'Owner', phone: '205-555-0100', category: 'running', state: 'sent', sent: '2026-09-12T02:00:00Z', created: '2026-09-11T02:00:00Z' });
  await card(A, A1, 3, 'MB Hoover Cycles', { contact: 'Kim Ito', instagram: 'hoovercycles', scope: 'business', category: 'bike shop', state: 'sent', sent: '2026-09-13T02:00:00Z', outcome: 'replied', replied: '2026-09-14T02:00:00Z', created: '2026-09-12T02:00:00Z' });
  await card(A, A1, 4, 'MB Iron Tribe', { contact: 'Owner', category: 'gym', state: 'sent', sent: '2026-09-13T02:00:00Z', created: '2026-09-13T02:00:00Z' });
  await P().query(`INSERT INTO deals (id, athlete_id, agent_id, data) VALUES ('mb-deal-1', $1, $2, $3::jsonb)`, [A1, A, JSON.stringify({ brand: 'MB Iron Tribe', stage: 'closed', value: 500 })]);
  // The same salon, found for athlete 2 on a later night: its own row.
  await card(A, A2, 1, 'MB Legion Hair Studio', { contact: 'Dana Roberts', title: 'Owner', email: 'dana@legion.example', category: 'salon', created: '2026-09-15T02:00:00Z' });
  // Retired and expired cards still count as found.
  await card(A, A2, 2, 'MB Old Shop', { contact: 'Lee Park', state: 'retired', outcome: 'no_name', created: '2026-09-01T02:00:00Z' });
  // A Deal Scan business that never became a card, with a contact from the scan.
  await P().query(`INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state, first_shown_at) VALUES ($1,$2,'name:mb scan brand','MB Scan Brand','local','shown','2026-09-16T02:00:00Z')`, [A, A2]);
  await P().query(`INSERT INTO company_enrichment (id, agent_id, brand_name) VALUES ('mb-enr-1', $1, 'MB Scan Brand')`, [A]).catch(() => {});
  await P().query(`INSERT INTO brand_contacts (id, enrichment_id, agent_id, brand_name, name, title, email, priority_rank) VALUES ('mb-ct-1','mb-enr-1',$1,'MB Scan Brand','Sam Cole','Marketing Director','sam@scan.example',1)`, [A]).catch((e) => console.log('brand_contacts insert:', e.message));
  // The town from Places for the salon.
  await P().query(`INSERT INTO brand_evidence_cache (brand_key, lane, brand, evidence, outcome, refreshed_at) VALUES ('mb legion','places','MB Legion Hair Studio',$1::jsonb,'OK',NOW()) ON CONFLICT (brand_key, lane) DO UPDATE SET evidence = EXCLUDED.evidence`,
    [JSON.stringify({ address: '123 College St, Auburn, AL 36830, USA' })]);
  // Agent B: one business of their own.
  await card(B, B1, 1, 'MB Secret Bakery', { contact: 'Pat Doe', email: 'pat@secret.example', created: '2026-09-16T02:00:00Z' });

  OUT.push('-- the list --');
  const page = await MB.pageFor(P(), A, {});
  ok('one row per athlete per business, every state included', page.total === 7 && page.rows.length === 7, page.rows.map((r) => [r.athlete, r.brand, r.status]));
  const row = (brand, athlete) => page.rows.find((r) => r.brand === brand && r.athlete === athlete);
  ok('the same salon found for two athletes is two rows', !!row('MB Legion Hair Studio', 'Messiah Mickens') && !!row('MB Legion Hair Studio', 'Ann Lee'));
  ok('the columns: business, town, owner, contact, category, athlete, status', (() => { const r = row('MB Legion Hair Studio', 'Messiah Mickens'); return r.town === 'Auburn, AL' && r.ownerName === 'Dana Roberts' && r.contact === 'dana@legion.example' && r.category === 'salon' && r.status === 'not pitched'; })(), row('MB Legion Hair Studio', 'Messiah Mickens'));
  ok('  the town falls back to the athlete\'s school town when Places has no address', row('MB Trak Shak', 'Messiah Mickens').town === 'Auburn, AL' && row('MB Old Shop', 'Ann Lee').town === 'Silver City, NM');
  ok('  a phone or an Instagram handle is the contact when there is no email', row('MB Trak Shak', 'Messiah Mickens').contact === '205-555-0100' && row('MB Hoover Cycles', 'Messiah Mickens').contact === '@hoovercycles');
  ok('  a role on the card ("Owner") is not an owner name', row('MB Iron Tribe', 'Messiah Mickens').ownerName === null);
  ok('  a Deal Scan business with no card is listed, with the scan\'s contact', row('MB Scan Brand', 'Ann Lee') && row('MB Scan Brand', 'Ann Lee').ownerName === 'Sam Cole' && row('MB Scan Brand', 'Ann Lee').contact === 'sam@scan.example', row('MB Scan Brand', 'Ann Lee'));
  ok('sorted newest found first by default', page.sort === 'newest' && page.rows[0].brand === 'MB Scan Brand' && page.rows[page.rows.length - 1].brand === 'MB Old Shop');

  OUT.push('', '-- status is derived, never guessed --');
  ok('not pitched: a queued card', row('MB Legion Hair Studio', 'Messiah Mickens').status === 'not pitched');
  ok('pitched: a card marked sent', row('MB Trak Shak', 'Messiah Mickens').status === 'pitched');
  ok('replied: a card with replied_at', row('MB Hoover Cycles', 'Messiah Mickens').status === 'replied');
  ok('deal signed: a closed deal for that athlete and brand', row('MB Iron Tribe', 'Messiah Mickens').status === 'deal signed');
  ok('  a retired card is still "not pitched", not invented', row('MB Old Shop', 'Ann Lee').status === 'not pitched');
  ok('the four counts: businesses, owners, replied (includes signed), deals', JSON.stringify(page.counts) === JSON.stringify({ businesses: 7, owners: 6, replied: 2, deals: 1 }), page.counts);

  OUT.push('', '-- filters, athlete, search, sort, paging --');
  ok('filter replied shows replied and signed', (await MB.pageFor(P(), A, { filter: 'replied' })).rows.map((r) => r.brand).sort().join('|') === 'MB Hoover Cycles|MB Iron Tribe');
  ok('filter pitched', (await MB.pageFor(P(), A, { filter: 'pitched' })).rows.map((r) => r.brand).join('|') === 'MB Trak Shak');
  ok('filter not pitched', (await MB.pageFor(P(), A, { filter: 'not pitched' })).rows.length === 4);
  ok('  the counts at the top do not move with the filter', (await MB.pageFor(P(), A, { filter: 'pitched' })).counts.businesses === 7);
  ok('the athlete dropdown narrows to one athlete', (await MB.pageFor(P(), A, { athleteId: A2 })).rows.every((r) => r.athlete === 'Ann Lee') && (await MB.pageFor(P(), A, { athleteId: A2 })).rows.length === 3);
  ok('  and lists this agent\'s athletes', page.athletes.map((a) => a.name).join('|') === 'Ann Lee|Messiah Mickens');
  ok('search matches business, owner and town', (await MB.pageFor(P(), A, { q: 'legion' })).rows.length === 2 && (await MB.pageFor(P(), A, { q: 'jeff' })).rows.length === 1 && (await MB.pageFor(P(), A, { q: 'silver city' })).rows.every((r) => r.town === 'Silver City, NM') && (await MB.pageFor(P(), A, { q: 'silver city' })).rows.length === 2);
  ok('sort by business', (await MB.pageFor(P(), A, { sort: 'business' })).rows.map((r) => r.brand)[0] === 'MB Hoover Cycles');
  ok('sort by athlete', (await MB.pageFor(P(), A, { sort: 'athlete' })).rows[0].athlete === 'Ann Lee');
  ok('sort by status: signed, replied, pitched, then not pitched', (await MB.pageFor(P(), A, { sort: 'status' })).rows.map((r) => r.status).join('|') === 'deal signed|replied|pitched|not pitched|not pitched|not pitched|not pitched');
  const p1 = await MB.pageFor(P(), A, { pageSize: 3 });
  const p3 = await MB.pageFor(P(), A, { pageSize: 3, page: 3 });
  ok('paged: 3 pages of 3 for 7 rows, the last page holds one', p1.pages === 3 && p1.rows.length === 3 && p3.page === 3 && p3.rows.length === 1);
  ok('  fifty a page by default', MB.PAGE_SIZE === 50 && page.pageSize === 50);

  OUT.push('', '-- the spreadsheet --');
  const csv = await MB.csvForAgent(P(), A, { filter: 'replied' });
  const lines = csv.trim().split(/\r?\n/);
  ok('the CSV is the current filter: header plus the two replied rows', lines.length === 3 && lines[0] === 'Business,Town,Owner,Contact,Category,Athlete,Status,Date found', lines);
  ok('  with the same columns plus the date found', lines.slice(1).every((l) => /,(replied|deal signed),2026-09-1\d$/.test(l)), lines.slice(1));
  ok('  a comma in a value is quoted', /"/.test(MB.csvFor([{ brand: 'A, B', town: '', ownerName: '', contact: '', category: '', athlete: 'X', status: 'not pitched', foundAt: null }])));

  OUT.push('', '-- strict isolation --');
  const pb = await MB.pageFor(P(), B, {});
  ok('agent A never sees agent B\'s business', !page.rows.some((r) => r.brand === 'MB Secret Bakery') && !JSON.stringify(page).includes('pat@secret.example'));
  ok('agent B sees only their own', pb.total === 1 && pb.rows[0].brand === 'MB Secret Bakery' && !JSON.stringify(pb).includes('legion'));
  ok('  the athlete dropdown is theirs alone', pb.athletes.length === 1 && pb.athletes[0].name === 'Other Agents Kid');
  ok('  asking for another agent\'s athlete by id returns nothing', (await MB.pageFor(P(), B, { athleteId: A1 })).rows.length === 0);
  ok('  the CSV is bound the same way', !(await MB.csvForAgent(P(), B, {})).includes('Legion') && (await MB.csvForAgent(P(), B, {})).includes('MB Secret Bakery'));
  ok('every query in the service is bound to the agent id', (() => { const s = src('server/services/myBrands.js').slice(0, src('server/services/myBrands.js').indexOf('async function adminSummary')); const froms = s.match(/FROM (outreach_queue|brand_engagement|brand_contacts|deals|outreach_logs|athletes)\b/g) || []; const bound = (s.match(/agent_id = \$1/g) || []).length; return froms.length === 6 && bound === 6; })());
  const idx = src('server/index.js');
  ok('the routes take the agent from the session, never from a parameter', /app\.get\('\/api\/agent\/brands', requireAuth/.test(idx) && /MB\.pageFor\(store\.pool, req\.session\.userId/.test(idx) && /MB\.csvForAgent\(store\.pool, req\.session\.userId/.test(idx) && !/pageFor\(store\.pool, req\.query/.test(idx));

  OUT.push('', '-- admin: counts only --');
  const adm = await MB.adminSummary(P());
  ok('the admin summary counts businesses and owners across every agent', adm.businesses >= 8 && adm.owners >= 6 && adm.agentsWithCards >= 2, adm);
  ok('  and carries no name, address or contact', !/legion|secret|dana|pat@/i.test(JSON.stringify(adm)));
  ok('  behind the admin email check', /app\.get\('\/api\/admin\/brands-summary', requireAuth[\s\S]{0,300}user\.email !== ADMIN_EMAIL/.test(idx));
  ok('  on the admin page', /Businesses found, all agents/.test(src('public/admin.html')) && /\/api\/admin\/brands-summary/.test(src('public/admin.html')));

  OUT.push('', '-- the page --');
  const html = src('public/index.html');
  ok('a My Brands tab in the sidebar, right below Deal Scan', /Deal Scan\s*<\/button>\s*<button class="nav-item" id="brandsNavBtn" onclick="showView\('brands',this\)">/.test(html));
  ok('  a view with the four counts, the filters, the athlete dropdown, the search box and the sort', /id="view-brands"/.test(html) && /id="mb-k-businesses"/.test(html) && /id="mb-k-owners"/.test(html) && /id="mb-k-replied"/.test(html) && /id="mb-k-deals"/.test(html) && /data-filter="not pitched"/.test(html) && /id="mb-athlete"/.test(html) && /id="mb-q"/.test(html) && /id="mb-sort"/.test(html));
  ok('  the columns', /<th[^>]*>Business<\/th><th>Town<\/th><th>Owner<\/th><th>Contact<\/th><th>Category<\/th>\s*<th[^>]*>Found for<\/th><th[^>]*>Status<\/th>/.test(html));
  ok('  the download button exports the current view', /function mbDownload\(\) \{ window\.location\.href = API_BASE \+ '\/api\/agent\/brands\.csv\?' \+ mbQuery\(\); \}/.test(html));
  ok('  the empty state says pitches come after the first nightly run, with an add-athlete button', /Pitches start appearing after the first nightly run/.test(html) && /id="mb-empty"[\s\S]{0,900}showView\('add-athlete'/.test(html));
  ok('  paged with previous and next', /id="mb-prev"/.test(html) && /id="mb-next"/.test(html) && /function mbPage\(delta\)/.test(html));
  ok('  loaded when the tab opens, and titled', /if \(id === 'brands'\) \{ try \{ mbLoad\(\); \} catch \(e\) \{\} \}/.test(html) && /brands:'My Brands'/.test(html));
  ok('  no search and no model call anywhere on the page path', !/lookupPlace|searchLoop|DS\.chat|anthropic/i.test(src('server/services/myBrands.js')));
  ok('the assistant can open it and knows what it is', /'deals', 'brands', 'pipeline'/.test(src('server/services/assistantActions.js')) && /brands: 'My Brands'/.test(src('server/services/assistantActions.js')) && /MY BRANDS \(tab: brands\)/.test(src('server/services/assistantKnowledge.js')));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P().end(); } catch (_) {}
  process.exit(F ? 1 : 0);
})().catch(async (e) => { console.error('mybrands: FAILED', e); try { await P().end(); } catch (_) {} process.exit(1); });
