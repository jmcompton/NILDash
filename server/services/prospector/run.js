'use strict';
// ── ONE PROSPECTING RUN: AREA IN, READY-TO-SEND OPPORTUNITIES OUT ───────────
//
// 1. Places: businesses of the playbook's kinds in the area, with a website.
// 2. Signal: the email security check on every one (free, public DNS).
// 3. Only businesses with a finding go on, worst first, up to `limit`.
// 4. Hunter: the right person at each, then verify the address (credits).
// 5. The writer: one email per opportunity, from the customer.
//
// Credits are spent only in step 4 and only on businesses that already have a
// finding, so `limit` caps the cost: about 1 search + 0.5 verify each.
// Saved to prospector_runs / prospector_leads so a run can be reopened.

const PB = require('./playbooks');
const Places = require('./places');
const Sec = require('./emailSecurity');
const Contacts = require('./contacts');
const Writer = require('./writer');

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_runs (
    id SERIAL PRIMARY KEY, playbook TEXT NOT NULL, area TEXT NOT NULL, sender JSONB, status TEXT NOT NULL DEFAULT 'running',
    summary JSONB, error TEXT, created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_leads (
    id SERIAL PRIMARY KEY, run_id INT NOT NULL REFERENCES prospector_runs(id) ON DELETE CASCADE,
    business TEXT, domain TEXT, category TEXT, address TEXT, phone TEXT, level TEXT, finding JSONB,
    person JSONB, verified BOOLEAN, verify_status TEXT, email JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  // Every business with a gap, not only the ones built into leads: the rest of
  // the territory, and the free sample a sales email can name. Kept out of
  // recent() so the runs list stays small.
  await pool.query(`ALTER TABLE prospector_runs ADD COLUMN IF NOT EXISTS gaps JSONB`);
  _ensured = true;
}

const ORDER = { high: 0, medium: 1 };

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

async function run(pool, input, deps = {}) {
  const playbook = PB.get(input.playbook);
  if (!playbook) throw Object.assign(new Error('unknown playbook'), { status: 400 });
  const area = String(input.area || '').trim();
  if (!area) throw Object.assign(new Error('area is required, e.g. "Birmingham, AL"'), { status: 400 });
  const sender = { name: String((input.sender && input.sender.name) || '').trim() || 'JohnMark Compton',
    company: String((input.sender && input.sender.company) || '').trim() || 'your IT team',
    about: String((input.sender && input.sender.about) || '').trim() };
  const limit = Math.max(1, Math.min(25, parseInt(input.limit, 10) || 10));
  const maxBusinesses = Math.max(10, Math.min(200, parseInt(input.maxBusinesses, 10) || 150));

  await ensureTables(pool);
  const runRow = (await pool.query(`INSERT INTO prospector_runs (playbook, area, sender, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
    [playbook.key, area, JSON.stringify(sender), input.userId || null])).rows[0];
  const runId = runRow.id;
  if (typeof input.onStart === 'function') input.onStart(runId);
  const summary = { found: 0, skipped: 0, checked: 0, withGap: 0, high: 0, medium: 0, protected: 0, noMail: 0, dnsErrors: 0,
    contacted: 0, reachable: 0, people: 0, inboxes: 0, verified: 0, written: 0, placesErrors: [], skippedWhy: {} };
  try {
    const places = deps.places || Places;
    const sec = deps.emailSecurity || Sec;
    const terms = input.terms && input.terms.length ? input.terms : playbook.targets;
    const found = await places.find(terms, area, { max: maxBusinesses });
    summary.found = found.businesses.length;
    summary.placesErrors = found.errors.slice(0, 3);
    const fits = found.businesses.filter((b) => {
      const why = PB.skipReason(playbook, b);
      if (why) { summary.skipped++; const k = why.replace(/\s*\(.*\)$/, ''); summary.skippedWhy[k] = (summary.skippedWhy[k] || 0) + 1; }
      return !why;
    });

    const checked = await mapLimit(fits, 8, async (b) => ({ b, f: await sec.check(b.domain) }));
    summary.checked = checked.length;
    for (const { f } of checked) {
      if (f.level === 'high') summary.high++; else if (f.level === 'medium') summary.medium++;
      else if (f.level === 'none') summary.protected++; else if (f.level === 'skip') summary.noMail++; else summary.dnsErrors++;
    }
    const gaps = checked.filter((x) => x.f.level === 'high' || x.f.level === 'medium')
      .sort((a, z) => ORDER[a.f.level] - ORDER[z.f.level] || (z.b.ratings || 0) - (a.b.ratings || 0));
    summary.withGap = gaps.length;
    await pool.query(`UPDATE prospector_runs SET gaps = $2 WHERE id = $1`, [runId, JSON.stringify(gaps.slice(0, 300).map(({ b, f }) => ({
      business: b.name, domain: b.domain, category: b.category, address: b.address, phone: b.phone, term: b.term,
      ratings: b.ratings || 0, level: f.level, mail: f.mail || null, problem: (f.problems || [])[0] || null })))]);

    // A mix of kinds of business: worst first within each kind, then one from
    // each kind in turn (the kinds that have the most high-risk gaps first).
    const byKind = new Map();
    for (const g of gaps) { const k = g.b.term || g.b.category || ''; if (!byKind.has(k)) byKind.set(k, []); byKind.get(k).push(g); }
    const kinds = [...byKind.values()];
    const chosen = [];
    for (let i = 0; chosen.length < limit && kinds.some((l) => i < l.length); i++) {
      for (const l of kinds) if (i < l.length && chosen.length < limit) chosen.push(l[i]);
    }
    chosen.sort((a, z) => ORDER[a.f.level] - ORDER[z.f.level]);
    summary.contacted = chosen.length;
    const leads = await mapLimit(chosen, 3, async ({ b, f }) => {
      const c = await Contacts.findPerson(playbook, b.domain, deps.contacts || {}, { website: b.website, name: b.name });
      const person = c.ok ? c.person : null;
      if (person) summary.reachable++;
      if (c.ok && c.kind === 'named') summary.people++;
      if (c.ok && c.kind === 'inbox') summary.inboxes++;
      if (c.ok && c.verified) summary.verified++;
      const email = await Writer.write({ business: b.name, domain: b.domain, category: b.category, address: b.address, area,
        finding: f, person, sender }, playbook, deps.writer || {});
      summary.written++;
      await pool.query(`INSERT INTO prospector_leads (run_id, business, domain, category, address, phone, level, finding, person, verified, verify_status, email)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [runId, b.name, b.domain, b.category, b.address, b.phone, f.level, JSON.stringify(f), person ? JSON.stringify({ ...person, kind: c.kind, source: c.source }) : null,
          !!(c.ok && c.verified), c.ok ? c.verifyStatus : c.why, JSON.stringify(email)]);
      return { business: b, finding: f, contact: c, email };
    });
    await pool.query(`UPDATE prospector_runs SET status = 'done', summary = $2, finished_at = NOW() WHERE id = $1`, [runId, JSON.stringify(summary)]);
    return { runId, playbook: playbook.key, area, sender, summary, leads };
  } catch (e) {
    await pool.query(`UPDATE prospector_runs SET status = 'failed', error = $2, summary = $3, finished_at = NOW() WHERE id = $1`,
      [runId, e.message, JSON.stringify(summary)]).catch(() => {});
    throw e;
  }
}

async function get(pool, runId) {
  await ensureTables(pool);
  const r = (await pool.query(`SELECT * FROM prospector_runs WHERE id = $1`, [runId])).rows[0];
  if (!r) return null;
  const leads = (await pool.query(`SELECT * FROM prospector_leads WHERE run_id = $1 ORDER BY (level = 'high') DESC, verified DESC, id`, [runId])).rows;
  return { run: r, leads };
}

async function recent(pool, n = 10) {
  await ensureTables(pool);
  return (await pool.query(`SELECT id, playbook, area, status, summary, created_at FROM prospector_runs ORDER BY id DESC LIMIT $1`, [n])).rows;
}

module.exports = { run, get, recent, ensureTables, _reset() { _ensured = false; } };
