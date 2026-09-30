'use strict';
// Runs against the local test Postgres and a headless Chromium. No network:
// every request the pages make is answered here.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/agencybrand.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── ONE RULE: THE DOCUMENTS ARE THE AGENCY'S ────────────────────────────────
// The media kit, the pitch deck page, the one-page deck PDF, the rate sheet,
// the contract PDF and the share-link report. NILDash appears once, as
// "Powered by NILDash" in the footer: not the header, the title, the favicon
// or a label. With no brand set, the agent's own name and email, never NILDash.
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execSync } = require('child_process');
const AB = require(REPO + 'server/services/agencyBrand.js');
const store = require(REPO + 'server/store.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
// Every "NILDash" left once each "Powered by NILDash" is taken out.
const stray = (text) => (String(text).replace(/Powered by\s*NILDash/g, '').match(/NILDash/g) || []).length;
const poweredCount = (text) => (String(text).match(/Powered by\s*NILDash/g) || []).length;

const AGENT = { id: 'ab-agent', name: 'Jordan Reyes', email: 'jordan@reyes.test' };
const BRANDED = { ...AGENT, agency_name: 'Summit Sports Group', agency_contact_email: 'team@summit.test',
  agency_contact_phone: '555-0100', agency_primary_color: '#1E3A8A',
  agency_logo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==' };

// Text drawn in a pdfkit PDF: inflate each stream, decode the hex runs in TJ.
function pdfText(buf) {
  const src = buf.toString('latin1');
  const out = [];
  const re = /stream\r?\n/g; let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    const end = src.indexOf('endstream', start);
    if (end < 0) break;
    let body = Buffer.from(src.slice(start, end), 'latin1');
    try { body = zlib.inflateSync(body); } catch (_) {}
    const s = body.toString('latin1');
    for (const tj of s.match(/\[([^\]]*)\]\s*TJ/g) || []) {
      out.push((tj.match(/<([0-9a-fA-F]*)>/g) || []).map((h) => Buffer.from(h.slice(1, -1), 'hex').toString('latin1')).join(''));
    }
  }
  return out;
}

async function main() {
  // ── 1. THE RESOLVER ───────────────────────────────────────────────────────
  OUT.push('-- brandFor --');
  const plain = AB.brandFor(AGENT);
  ok('no brand set: the agent\'s own name and email', plain.name === 'Jordan Reyes' && plain.contactEmail === 'jordan@reyes.test' && !plain.hasBrand, plain);
  ok('  and NILDash nowhere but poweredBy', stray(JSON.stringify({ ...plain, poweredBy: '' })) === 0 && plain.poweredBy === 'Powered by NILDash');
  const none = AB.brandFor(null);
  ok('no account at all: empty, still never NILDash', none.name === '' && stray(JSON.stringify({ ...none, poweredBy: '' })) === 0, none);
  const br = AB.brandFor(BRANDED);
  ok('a brand set: the agency name and its contact email', br.name === 'Summit Sports Group' && br.contactEmail === 'team@summit.test' && br.contactName === 'Jordan Reyes');
  ok('validate refuses an SVG logo (it can carry script)', !AB.validate({ logo: 'data:image/svg+xml;base64,PHN2Zz4=' }).ok);
  ok('  and a bad color, email or website', !AB.validate({ primaryColor: 'blue' }).ok && !AB.validate({ contactEmail: 'x' }).ok && !AB.validate({ website: 'nope' }).ok);

  // ── 2. SERVER-BUILT SURFACES, IN SOURCE ───────────────────────────────────
  OUT.push('', '-- contract PDF, rate sheet, data APIs --');
  const IDX = read('server/index.js');
  const routeSrc = (sig) => { const i = IDX.indexOf(sig); return i < 0 ? '' : IDX.slice(i, IDX.indexOf('\n});', i)); };
  const contract = stripComments(routeSrc("app.post('/api/ai/contract/pdf'"));
  ok('contract PDF: no NILDash literal; the footer is POWERED_BY', contract && stray(contract) === 0 && /agencyBrand\.POWERED_BY/.test(contract), contract.match(/.*NILDash.*/g));
  ok('  prepared by the agency (or the agent), from brandForUser, the sending mailbox as contact', /Prepared by ' \+ agency\.name/.test(contract) && /brandForUser\(await store\.getUser\(req\.session\.userId\)\)/.test(contract));
  const H = read('public/index.html');
  const rs0 = H.indexOf('async function exportRateSheet()');
  const rate = stripComments(H.slice(rs0, H.indexOf('\nasync function getRateScript', rs0)));
  ok('rate sheet: NILDash only as "Powered by NILDash"', rs0 > 0 && stray(rate) === 0 && poweredCount(rate) === 1, rate.match(/.*NILDash.*/g));
  ok('  header and "Represented by" are the agency', /\$\{agName \? agName \+ ' · ' : ''\}Rate Sheet/.test(rate) && /Represented by ' \+ agName/.test(rate));
  ok('  the window opens before the brand is fetched (pop-up blockers)', rate.indexOf("window.open(") < rate.indexOf('await loadAgencyBrand()'));
  ok('report API returns the agency', /_agency = await agencyBrand\.brandForUser\(agent\)/.test(routeSrc("app.get('/api/reports/:token'")) && /agency: _agency/.test(routeSrc("app.get('/api/reports/:token'")));
  ok('pitch-data and media-kit APIs return the agency', /agency: await require\('\.\/services\/agencyBrand'\)\.brandForUser\(/.test(IDX) && /const agency = await require\('\.\/services\/agencyBrand'\)\.brandForUser\(_owner/.test(IDX));

  // ── 3. THE ONE-PAGE DECK PDF, RENDERED ────────────────────────────────────
  OUT.push('', '-- deck PDF --');
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  const clean = async () => {
    await P.query(`DELETE FROM pitch_decks WHERE agent_id LIKE 'ab-%'`).catch(() => {});
    await P.query(`DELETE FROM users WHERE id LIKE 'ab-%'`).catch(() => {});
  };
  await clean();
  const insertUser = (u) => P.query(
    `INSERT INTO users (id, name, email, password, role, agency_name, agency_contact_email, agency_contact_phone, agency_primary_color, agency_logo)
     VALUES ($1,$2,$3,'x','agent',$4,$5,$6,$7,$8)`,
    [u.id, u.name, u.email, u.agency_name || null, u.agency_contact_email || null, u.agency_contact_phone || null, u.agency_primary_color || null, u.agency_logo || null]);
  await insertUser(AGENT);
  await insertUser({ ...BRANDED, id: 'ab-branded', email: 'jordan2@reyes.test' });
  process.env.ANTHROPIC_API_KEY = '';                 // the fallback one-pager: no network
  const deckSvc = require(REPO + 'server/services/deckGeneration.js');
  const deckInputs = (agentId) => ({ agentId, athleteId: 'ab-ath',
    athlete: { name: 'Maya Torres', sport: 'Basketball', school: 'Cypress College', instagram_followers: 12000, engagement_rate: 6.1 },
    enrichment: { id: null, brand_name: 'Joe\'s Pizza' }, matchScore: { id: null, total_score: 80 }, pitch: {} });
  for (const [label, id, want] of [['unbranded', AGENT.id, ['Jordan Reyes', 'jordan@reyes.test']],
    ['branded', 'ab-branded', ['Summit Sports Group', 'team@summit.test']]]) {
    let deck = null, err = null;
    try { deck = await deckSvc.generateDeck(deckInputs(id)); } catch (e) { err = e.message; }
    const lines = deck && deck.file_path && fs.existsSync(deck.file_path) ? pdfText(fs.readFileSync(deck.file_path)) : [];
    const all = lines.join('\n');
    ok(`${label} deck: rendered`, lines.length > 5, err || lines.length);
    ok(`  NILDash once, as "Powered by NILDash"`, stray(all) === 0 && poweredCount(all) === 1, lines.filter((l) => /NILDash/.test(l)));
    ok(`  the footer carries ${want.join(' and ')}`, want.every((w) => all.includes(w)), lines.slice(-3));
  }

  // ── 4. THE PUBLIC PAGES, RENDERED ─────────────────────────────────────────
  OUT.push('', '-- rendered pages --');
  let chromium;
  try { chromium = require(execSync('npm root -g').toString().trim() + '/playwright').chromium; } catch (_) {}
  if (!chromium) { ok('playwright is available to render the pages', false); }
  else {
    const browser = await chromium.launch();
    const fixtures = {
      media: (agency, theme) => ({ athlete_name: 'Maya Torres', sport: 'Basketball', school: 'Cypress College', position: 'Guard',
        instagram_followers: 12000, theme, primary_color: '#8B0000', agency }),
      pitch: (agency) => ({ name: 'Maya Torres', sport: 'Basketball', school: 'Cypress College', instagram: 12000, tiktok: 3000,
        engagement: 6.1, agency }),
      report: (agency) => ({ athlete: { name: 'Maya Torres', sport: 'Basketball', school: 'Cypress College', instagram_followers: 12000 },
        agent: { name: AGENT.name, email: AGENT.email }, agency, deals: [], rate: { low: 100, high: 300 },
        agentMessage: '', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() }),
    };
    const visit = async (url, apiRe, body) => {
      const page = await browser.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', (route) => {
        const u = new URL(route.request().url());
        if (u.hostname !== 'nildash.local') {
          if (/chart\.js|chart\.umd/.test(u.pathname)) return route.fulfill({ contentType: 'application/javascript',
            body: 'window.Chart=function(){return{destroy(){}}};Chart.defaults={font:{}};' });
          return route.fulfill({ status: 204, body: '' });
        }
        if (apiRe.test(u.pathname)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        const file = { '/media-kit/maya': 'media-kit.html', '/pitch/ab-ath': 'pitch.html', '/report/abtoken': 'report.html' }[u.pathname];
        if (file) return route.fulfill({ contentType: 'text/html', body: read('public/' + file) });
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://nildash.local' + url);
      await page.waitForTimeout(1500);
      const got = await page.evaluate(() => {
        const icons = [...document.querySelectorAll('link[rel~="icon"],link[rel="apple-touch-icon"]')].map((l) => l.getAttribute('href'));
        const imgs = [...document.querySelectorAll('img')].map((i) => (i.getAttribute('src') || '') + ' ' + (i.alt || ''));
        const all = [...document.body.querySelectorAll('*')].filter((e) => e.children.length === 0 || e.childNodes.length);
        // The last element whose own text says NILDash, and the page height it sits at.
        const hits = [];
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let n; while ((n = walk.nextNode())) if (/NILDash/.test(n.textContent) && !n.parentElement.closest('script,style,noscript,template')) {
          const el = n.parentElement.closest('div,footer,p') || n.parentElement;
          hits.push({ text: el.innerText, bottom: el.getBoundingClientRect().bottom + scrollY });
        }
        return { title: document.title, icons, imgs, text: document.body.innerText, hits,
          height: document.documentElement.scrollHeight, n: all.length };
      });
      await page.close();
      return { ...got, errors };
    };
    const check = (label, g, want) => {
      ok(`${label}: rendered without a script error`, g.errors.length === 0 && !/is not defined|Cannot read prop/.test(g.text), g.errors.concat(g.text.slice(0, 80)));
      ok(`  NILDash once in the visible text, as "Powered by NILDash"`, stray(g.text) === 0 && poweredCount(g.text) === 1, g.hits);
      ok(`  and that line is the footer (bottom of the page)`, g.hits.length === 1 && g.hits[0].bottom >= g.height - 400, g.hits.map((h) => [h.bottom, g.height]));
      ok(`  not in the title, the favicon or an image`, !/nildash/i.test(g.title) && !g.icons.some((i) => /nildash/i.test(i || '')) && !g.imgs.some((i) => /nildash/i.test(i)), [g.title, g.icons, g.imgs]);
      ok(`  shows ${want.join(' and ')}`, want.every((w) => g.text.includes(w)), g.text.slice(0, 300));
    };
    for (const [label, agency, want] of [['unbranded', AB.brandFor(AGENT), ['Jordan Reyes', 'jordan@reyes.test']],
      ['branded', AB.brandFor(BRANDED), ['Summit Sports Group', 'team@summit.test']]]) {
      for (const theme of ['agency', 'nildash', 'school']) {
        check(`media kit, ${label}, theme ${theme}`, await visit('/media-kit/maya', /^\/api\/media-kit\//, fixtures.media(agency, theme)), want);
      }
      const pg = await visit('/pitch/ab-ath', /^\/api\/pitch-data\//, fixtures.pitch(agency));
      check(`pitch page, ${label}`, pg, want);
      ok('  no "NILDash Score", "NILDash Rating" or "NILDash Representation" label', !/NILDash (Score|Rating|Representation|Representative)/.test(pg.text));
      check(`report, ${label}`, await visit('/report/abtoken', /^\/api\/reports\//, fixtures.report(agency)), want);
    }
    const brandedKit = await visit('/media-kit/maya', /^\/api\/media-kit\//, fixtures.media(AB.brandFor(BRANDED), 'agency'));
    ok('a branded kit uses the agency logo as the favicon', brandedKit.icons.some((i) => /^data:image\/png/.test(i || '')), brandedKit.icons);
    await browser.close();
  }

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('agencybrand: FAILED', e); process.exit(1); });
