'use strict';
// ── THE FREE SAMPLE: 10 REAL LEADS IN THE IT COMPANY'S OWN AREA ─────────────
//
// The sales email offers it; the sample page sells the plans. A sample is a
// Prospector run in the IT company's area, with the emails signed from the IT
// company itself, behind an unguessable link (/s/<token>).
//
// Two ways in:
//   - our own outreach (admin): we already know the company, owner and area;
//   - the public sales page: an IT company asks for one. A sample spends real
//     Hunter credits (about 15), so the public road is limited: business email
//     only (no Gmail and friends), one per email domain a week, a few per IP a
//     day, and a daily cap for everyone (PROSPECTOR_PUBLIC_SAMPLES_PER_DAY).

const crypto = require('crypto');
const R = require('./run');
const Billing = require('./billing');

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|zoho|yandex)\./i;
const dailyCap = () => Math.max(0, parseInt(process.env.PROSPECTOR_PUBLIC_SAMPLES_PER_DAY, 10) || 10);
const PER_IP_PER_DAY = 3;

let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await R.ensureTables(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_samples (
    token TEXT PRIMARY KEY, company TEXT, first_name TEXT, last_name TEXT, email TEXT, email_domain TEXT, area TEXT,
    about TEXT, source TEXT NOT NULL DEFAULT 'admin', ip TEXT, status TEXT NOT NULL DEFAULT 'building', error TEXT,
    run_id INT, views INT NOT NULL DEFAULT 0, first_viewed_at TIMESTAMPTZ, last_viewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  _ensured = true;
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const domainOfEmail = (e) => (String(e || '').toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/) || [])[1] || null;

// Start one sample. Answers with the token at once; the run keeps going.
async function create(pool, input, deps = {}) {
  await ensureTables(pool);
  const company = clip(input.company, 160), area = clip(input.area, 120);
  if (!company) throw Object.assign(new Error('Company name is required.'), { status: 400 });
  if (!Billing.areaKey(area)) throw Object.assign(new Error('Which city? For example "Birmingham, AL".'), { status: 400 });
  const token = crypto.randomBytes(18).toString('base64url');
  const first = clip(input.first, 60), last = clip(input.last, 60), email = clip(input.email, 200).toLowerCase();
  await pool.query(`INSERT INTO prospector_samples (token, company, first_name, last_name, email, email_domain, area, about, source, ip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [token, company, first || null, last || null, email || null, domainOfEmail(email), area, clip(input.about, 400) || null,
    ['public', 'outreach'].includes(input.source) ? input.source : 'admin', input.ip ? clip(input.ip, 64) : null]);
  const sender = { name: [first, last].filter(Boolean).join(' ') || company, company, about: clip(input.about, 400) };
  const run = deps.run || R.run;
  const done = run(pool, { playbook: 'it-msp', area, limit: 10, sender,
    onStart: (runId) => { pool.query(`UPDATE prospector_samples SET run_id = $2 WHERE token = $1`, [token, runId]).catch(() => {}); } }, deps.runDeps || {})
    .then(async (out) => { await pool.query(`UPDATE prospector_samples SET status = 'ready', run_id = $2 WHERE token = $1`, [token, out.runId]); return out; })
    .catch(async (e) => {
      console.error('[prospector-sample] failed:', e.message);
      await pool.query(`UPDATE prospector_samples SET status = 'failed', error = $2 WHERE token = $1`, [token, clip(e.message, 300)]).catch(() => {});
    });
  return { token, done };
}

// The public road, with its limits. -> { token } or throws with a plain reason.
async function requestPublic(pool, input, deps = {}) {
  await ensureTables(pool);
  const email = clip(input.email, 200).toLowerCase();
  const dom = domainOfEmail(email);
  if (!dom) throw Object.assign(new Error('Enter your work email.'), { status: 400 });
  if (FREE_MAIL.test(email)) throw Object.assign(new Error('Use your company email, not a personal one.'), { status: 400 });
  const recentDomain = await pool.query(`SELECT token, status FROM prospector_samples WHERE email_domain = $1 AND created_at > NOW() - INTERVAL '7 days'
    ORDER BY created_at DESC LIMIT 1`, [dom]);
  if (recentDomain.rows[0]) return { token: recentDomain.rows[0].token, existing: true };
  if (input.ip) {
    const n = await pool.query(`SELECT COUNT(*)::int AS n FROM prospector_samples WHERE ip = $1 AND created_at > NOW() - INTERVAL '1 day'`, [clip(input.ip, 64)]);
    if (n.rows[0].n >= PER_IP_PER_DAY) throw Object.assign(new Error('Too many samples from here today. Try again tomorrow.'), { status: 429 });
  }
  const today = await pool.query(`SELECT COUNT(*)::int AS n FROM prospector_samples WHERE source = 'public' AND created_at > NOW() - INTERVAL '1 day'`);
  if (today.rows[0].n >= dailyCap()) throw Object.assign(new Error('We have built all the samples we can today. Leave your email and we will send yours tomorrow.'), { status: 429 });
  const held = await Billing.areaHolder(pool, input.area);
  if (held) throw Object.assign(new Error(`${held.area || input.area} is already taken by another IT company. Try a nearby city.`), { status: 409 });
  const r = await create(pool, { ...input, email, source: 'public' }, deps);
  return { token: r.token, done: r.done };
}

// What the sample page shows. Never the run's internals or a price id.
async function view(pool, token, opts = {}) {
  await ensureTables(pool);
  const r = await pool.query(`SELECT * FROM prospector_samples WHERE token = $1`, [String(token || '')]);
  const s = r.rows[0];
  if (!s) return null;
  if (opts.countView) {
    pool.query(`UPDATE prospector_samples SET views = views + 1, first_viewed_at = COALESCE(first_viewed_at, NOW()), last_viewed_at = NOW()
      WHERE token = $1`, [s.token]).catch(() => {});
  }
  let leads = [], summary = null;
  if (s.run_id) {
    const got = await R.get(pool, s.run_id);
    if (got) {
      summary = got.run.summary ? { checked: got.run.summary.checked, withGap: got.run.summary.withGap, high: got.run.summary.high } : null;
      leads = got.leads.map((l) => ({
        business: l.business, category: l.category, domain: l.domain, address: l.address, phone: l.phone, level: l.level,
        problem: l.finding && l.finding.problems ? l.finding.problems[0] : null, mail: l.finding ? l.finding.mail : null,
        person: l.person ? { first: l.person.first || '', last: l.person.last || '', title: l.person.title || '', email: l.person.email, kind: l.person.kind || null } : null,
        verified: !!l.verified, email: l.email ? { subject: l.email.subject, body: l.email.body } : null,
      }));
    }
  }
  const held = await Billing.areaHolder(pool, s.area);
  return { token: s.token, status: s.status, company: s.company, first: s.first_name, area: s.area, summary, leads,
    plans: Billing.publicPlans(), areaTaken: !!held, brand: Billing.BRAND(), createdAt: s.created_at };
}

module.exports = { create, requestPublic, view, ensureTables, FREE_MAIL, domainOfEmail, _reset() { _ensured = false; } };
