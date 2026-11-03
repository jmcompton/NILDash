'use strict';
// ── THE PROTECT COLLEGE SPORTS ACT RULE SET (S. 4668) ───────────────────────
//
// One national rule set, built as if the bill becomes law. It passed the Senate
// 77-22 on Sept 28, 2026 and waits on the House; if the House does not pass it
// before the 119th Congress ends (Jan 3, 2027) it dies. So every rule here says
// where it comes from, and PCSA_STATUS says whether it is the law yet:
//
//   pending (default)  every finding is a WARNING the agent sees; nothing blocks
//   law                the same findings, worded as requirements
//
// Like services/compliance.js these are lookups, never judgments: a fee is over
// 5% or it is not; a contract ends after eligibility or it does not. Where we
// hold no data (no birth date, no deliverables) the finding says UNKNOWN, never
// "fine". Not legal advice.
//
// What it checks, and the section of the bill:
//   agentFee          fees capped at 5% of an endorsement contract's value
//   agencyContract    in writing, and never past the athlete's eligibility
//   agentProfile      registered with a state, certified to the association
//   eligibility       5 calendar years; first transfer free, a second costs a
//                     year unless an exception applies (§112, §113)
//   disclosure        Division I: NIL over $600 in 12 months reported within 5
//                     days of signing or 30 days of payment (§101)
//   nilPurpose        a valid business purpose for every deal not with the
//                     school; pay commensurate with non-athletes when the payer
//                     is a collective, a booster (>$50,000 lifetime) or a
//                     conference/school employee
//   checkDeal         all of the above for one deal

const DAY = 86400000;
const FEE_CAP = 0.05;
const DISCLOSE_OVER = 600;
const DISCLOSE_SIGNED_DAYS = 5;
const DISCLOSE_PAID_DAYS = 30;
const ELIGIBILITY_YEARS = 5;
const BOOSTER_LIFETIME = 50000;
const TRANSFER_EXCEPTIONS = {
  sport_discontinued: 'the sport was discontinued',
  head_coach_departed: 'the head coach left',
  sexual_assault_or_harassment: 'sexual assault or harassment',
  graduate_study: 'graduate study',
};
const ASSOCIATED = new Set(['collective', 'booster', 'conference', 'school_employee']);

const STATUS = () => (String(process.env.PCSA_STATUS || 'pending').trim().toLowerCase() === 'law' ? 'law' : 'pending');
const SOURCE = 'Protect College Sports Act of 2026 (S. 4668)';
function source() {
  return STATUS() === 'law' ? SOURCE : `${SOURCE}, passed the Senate Sept 28, 2026, pending in the House`;
}

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const toDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v).length === 10 ? v + 'T12:00:00Z' : v);
  return Number.isNaN(d.getTime()) ? null : d;
};
const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');
// The academic year a date falls in, named by its starting year: Aug 1 onward is
// the next academic year.
const academicYear = (d) => (d.getUTCMonth() >= 7 ? d.getUTCFullYear() : d.getUTCFullYear() - 1);

function finding(rule, level, text, extra = {}) {
  // level: ok | warn | flag | unknown. Under 'pending' a flag reads as a warning.
  return { rule, level, text, source: source(), ...extra };
}

// ── AGENT FEE: 5% OF AN ENDORSEMENT CONTRACT ────────────────────────────────
function agentFee({ dealValue, feePct, feeAmount } = {}) {
  const v = num(dealValue);
  if (!v || v <= 0) return finding('agentFee', 'unknown', 'No deal value on file, so the 5% fee cap cannot be checked.');
  let fee = num(feeAmount);
  const pct = num(feePct);
  if (fee == null && pct != null) fee = v * (pct > 1 ? pct / 100 : pct);
  if (fee == null) return finding('agentFee', 'unknown', `No agent fee on file. The most an agent can charge on this ${money(v)} deal is ${money(v * FEE_CAP)}.`, { maxFee: Math.floor(v * FEE_CAP) });
  const share = fee / v;
  if (share > FEE_CAP + 1e-9) {
    return finding('agentFee', 'flag', `Agent fee ${money(fee)} is ${(share * 100).toFixed(1)}% of the deal. The cap is 5% (${money(v * FEE_CAP)}).`, { fee, maxFee: Math.floor(v * FEE_CAP), share });
  }
  return finding('agentFee', 'ok', `Agent fee ${money(fee)} is ${(share * 100).toFixed(1)}% of the deal, within the 5% cap.`, { fee, maxFee: Math.floor(v * FEE_CAP), share });
}

// ── ELIGIBILITY: 5 CALENDAR YEARS; ONE FREE TRANSFER ────────────────────────
// The clock starts with the academic year after the 19th birthday or the
// first full-time enrollment, whichever comes first.
function eligibility({ birthDate, firstEnrollment, transfers = [], now = new Date() } = {}) {
  const dob = toDate(birthDate), enr = toDate(firstEnrollment), at = toDate(now) || new Date();
  const out = { rule: 'eligibility', source: source(), findings: [] };
  let startYear = null;
  if (dob || enr) {
    const fromDob = dob ? academicYear(new Date(Date.UTC(dob.getUTCFullYear() + 19, dob.getUTCMonth(), dob.getUTCDate()))) + 1 : null;
    const fromEnr = enr ? academicYear(enr) : null;
    startYear = [fromDob, fromEnr].filter((x) => x != null).reduce((a, b) => Math.min(a, b));
  }
  if (startYear == null) {
    out.findings.push(finding('eligibility', 'unknown', 'No birth date or first enrollment on file, so the 5-year clock cannot be counted.'));
  } else {
    const lastYear = startYear + ELIGIBILITY_YEARS - 1;
    out.clockStart = `${startYear}-${String(startYear + 1).slice(2)}`;
    out.lastYear = `${lastYear}-${String(lastYear + 1).slice(2)}`;
    out.yearsLeft = Math.max(0, lastYear - academicYear(at) + 1);
    out.eligibilityEnds = `${lastYear + 1}-07-31`;
    out.findings.push(finding('eligibility', out.yearsLeft > 0 ? 'ok' : 'flag',
      out.yearsLeft > 0 ? `${out.yearsLeft} year${out.yearsLeft === 1 ? '' : 's'} left in his 5-year window (through ${out.lastYear}).` : `His 5-year window ended with ${out.lastYear}.`));
  }
  const list = (Array.isArray(transfers) ? transfers : []).filter(Boolean);
  out.transfers = list.length;
  if (list.length >= 2) {
    const second = list[1];
    const ex = second && TRANSFER_EXCEPTIONS[second.exception];
    if (ex) {
      out.findings.push(finding('transfer', 'ok', `Second transfer, but an exception applies (${ex}), so no year is lost.`));
    } else {
      out.lostYear = true;
      if (out.yearsLeft != null) out.yearsLeft = Math.max(0, out.yearsLeft - 1);
      out.findings.push(finding('transfer', 'flag', 'This is his second transfer: he loses a year of eligibility unless an exception applies (sport cut, head coach left, sexual assault or harassment, or graduate study).'));
    }
  } else if (list.length === 1) {
    out.findings.push(finding('transfer', 'warn', 'He has used his one free transfer. Another one would cost a year unless an exception applies.'));
  } else {
    out.findings.push(finding('transfer', 'ok', 'First transfer: no eligibility lost.'));
  }
  return out;
}

// ── AN AGENCY OR ENDORSEMENT CONTRACT: NEVER PAST ELIGIBILITY ───────────────
function contractTerm({ endDate, eligibilityEnds, inWriting } = {}) {
  const out = [];
  if (inWriting === false) out.push(finding('agencyContract', 'flag', 'The agency contract has to be in writing.'));
  const end = toDate(endDate), elig = toDate(eligibilityEnds);
  if (!end) out.push(finding('contractTerm', 'unknown', 'No end date on file, so it cannot be checked against his eligibility.'));
  else if (!elig) out.push(finding('contractTerm', 'unknown', `Ends ${iso(end)}. Add his eligibility dates to check it does not run past them.`));
  else if (end > elig) out.push(finding('contractTerm', 'flag', `Runs to ${iso(end)}, past his eligibility (${iso(elig)}). Contracts cannot extend beyond eligibility.`));
  else out.push(finding('contractTerm', 'ok', `Ends ${iso(end)}, within his eligibility.`));
  return out;
}

// ── DISCLOSURE: OVER $600 IN 12 MONTHS, 5 DAYS FROM SIGNING / 30 FROM PAYMENT ─
function disclosure({ value, signedAt, paidAt, priorTwelveMonths = 0, division = 'I', now = new Date() } = {}) {
  const v = num(value) || 0, prior = num(priorTwelveMonths) || 0;
  if (String(division).toUpperCase() !== 'I') {
    return finding('disclosure', 'ok', 'The bill\'s reporting rule covers Division I athletes. Check the school\'s own policy.', { required: false });
  }
  if (v + prior <= DISCLOSE_OVER) {
    return finding('disclosure', 'ok', `${money(v + prior)} in NIL over 12 months is not over ${money(DISCLOSE_OVER)}, so no report is triggered yet.`, { required: false });
  }
  const s = toDate(signedAt), p = toDate(paidAt), at = toDate(now) || new Date();
  const dues = [s && new Date(s.getTime() + DISCLOSE_SIGNED_DAYS * DAY), p && new Date(p.getTime() + DISCLOSE_PAID_DAYS * DAY)].filter(Boolean);
  if (!dues.length) {
    return finding('disclosure', 'warn', `Over ${money(DISCLOSE_OVER)} in 12 months: report it within 5 days of signing or 30 days of being paid. Add the signing date to set the deadline.`, { required: true, dueBy: null });
  }
  const due = dues.reduce((a, b) => (a < b ? a : b));
  // Calendar days in Chicago, not hours: due the 6th means due the 6th, all
  // day, and late on the 7th.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
  const daysLeft = Math.round((Date.parse(iso(due) + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / DAY);
  const level = daysLeft < 0 ? 'flag' : daysLeft <= 2 ? 'warn' : 'ok';
  const text = daysLeft < 0 ? `Report was due ${iso(due)}: ${-daysLeft} day${daysLeft === -1 ? '' : 's'} late.`
    : `Report due by ${iso(due)} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).`;
  return finding('disclosure', level, text, { required: true, dueBy: iso(due), daysLeft });
}

// ── A VALID BUSINESS PURPOSE, AND NORMAL PAY FROM ASSOCIATED PAYERS ─────────
// payerType: business | collective | booster | conference | school_employee | school
// boosterLifetime: what the payer has given the school or a collective, if known.
function nilPurpose({ payerType, deliverables, value, comparableHigh, boosterLifetime } = {}) {
  const out = [];
  let type = String(payerType || 'business').toLowerCase();
  if (type === 'business' && num(boosterLifetime) > BOOSTER_LIFETIME) type = 'booster';
  if (type === 'school') {
    out.push(finding('nilPurpose', 'ok', 'A deal with the school itself is revenue sharing; the business-purpose test does not apply.'));
    return out;
  }
  const work = Array.isArray(deliverables) ? deliverables.filter((d) => String(d || '').trim()) : String(deliverables || '').split(/[;,\n]/).map((x) => x.trim()).filter(Boolean);
  if (!work.length) out.push(finding('nilPurpose', 'flag', 'No promotional work is named. Every NIL deal needs a valid business purpose: list the posts, appearances or other work.'));
  else out.push(finding('nilPurpose', 'ok', `Promotional work named: ${work.slice(0, 4).join(', ')}${work.length > 4 ? '...' : ''}.`));
  if (ASSOCIATED.has(type)) {
    const v = num(value), hi = num(comparableHigh);
    const who = type === 'booster' ? `a booster (over ${money(BOOSTER_LIFETIME)} given)` : `a ${type.replace('_', ' ')}`;
    if (v != null && hi != null && v > hi) {
      out.push(finding('commensurate', 'flag', `Paid by ${who}: ${money(v)} is above what comparable players get (${money(hi)}). Pay from associated payers must match what non-athletes are paid for the same work.`));
    } else if (v != null && hi != null) {
      out.push(finding('commensurate', 'ok', `Paid by ${who}: ${money(v)} is within what comparable players get.`));
    } else {
      out.push(finding('commensurate', 'warn', `Paid by ${who}: the pay has to match what non-athletes get for the same work. Check it against comparable deals.`));
    }
  }
  return out;
}

// ── THE AGENT: REGISTERED AND CERTIFIED ─────────────────────────────────────
function agentProfile({ registeredState, registrationNumber, associationCertified, proAssociation } = {}) {
  const reg = !!(String(registeredState || '').trim() || String(proAssociation || '').trim());
  const cert = associationCertified === true;
  const ready = reg && cert;
  const missing = [];
  if (!reg) missing.push('register as an athlete agent with a state (or hold a players association certification)');
  if (!cert) missing.push('certify that registration to the NCAA');
  return {
    rule: 'agentProfile', source: source(), ready,
    level: ready ? 'ok' : 'warn',
    text: ready ? `PCSA-ready: registered${registeredState ? ' in ' + String(registeredState).toUpperCase() : ''}${registrationNumber ? ' (#' + registrationNumber + ')' : ''} and certified to the NCAA.`
      : 'Not PCSA-ready yet: ' + missing.join(', and ') + '.',
    missing,
  };
}

// ── ONE DEAL, EVERY RULE ────────────────────────────────────────────────────
// deal: { value, feePct|feeAmount, endDate, inWriting, signedAt, paidAt, payerType,
//         deliverables, comparableHigh, boosterLifetime, priorTwelveMonths }
// athlete: { birthDate|dob, firstEnrollment, transfers, division }
function checkDeal(deal = {}, athlete = {}, opts = {}) {
  const now = opts.now || new Date();
  const elig = eligibility({ birthDate: athlete.birthDate || athlete.dob, firstEnrollment: athlete.firstEnrollment, transfers: athlete.transfers, now });
  const findings = [
    agentFee({ dealValue: deal.value, feePct: deal.feePct, feeAmount: deal.feeAmount }),
    ...contractTerm({ endDate: deal.endDate, eligibilityEnds: elig.eligibilityEnds, inWriting: deal.inWriting }),
    disclosure({ value: deal.value, signedAt: deal.signedAt, paidAt: deal.paidAt, priorTwelveMonths: deal.priorTwelveMonths, division: athlete.division || 'I', now }),
    ...nilPurpose({ payerType: deal.payerType, deliverables: deal.deliverables, value: deal.value, comparableHigh: deal.comparableHigh, boosterLifetime: deal.boosterLifetime }),
  ];
  const flags = findings.filter((f) => f.level === 'flag').length;
  const warns = findings.filter((f) => f.level === 'warn').length;
  return {
    status: STATUS(), source: source(), findings, eligibility: elig,
    summary: flags ? `${flags} issue${flags === 1 ? '' : 's'} to fix${STATUS() === 'pending' ? ' if the bill becomes law' : ''}` : warns ? `${warns} thing${warns === 1 ? '' : 's'} to check` : 'Clean under the PCSA rules',
    flags, warns,
    disclaimer: 'Educational information, not legal advice. The Protect College Sports Act is not law until the House passes it and the President signs it.',
  };
}

// ── THE AGENT PROFILE, KEPT ─────────────────────────────────────────────────
let _ensured = false;
async function ensureTable(pool) {
  if (_ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS pcsa_agent_profiles (
    user_id TEXT PRIMARY KEY, registered_state TEXT, registration_number TEXT, pro_association TEXT,
    association_certified BOOLEAN NOT NULL DEFAULT FALSE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  _ensured = true;
}
const clip = (v, n) => (v == null ? null : String(v).trim().slice(0, n) || null);
async function getProfile(pool, userId) {
  await ensureTable(pool);
  const r = (await pool.query(`SELECT * FROM pcsa_agent_profiles WHERE user_id = $1`, [String(userId)])).rows[0];
  const p = r ? { registeredState: r.registered_state, registrationNumber: r.registration_number, proAssociation: r.pro_association, associationCertified: !!r.association_certified, updatedAt: r.updated_at } : { associationCertified: false };
  return { ...p, check: agentProfile(p) };
}
async function saveProfile(pool, userId, body = {}) {
  await ensureTable(pool);
  const st = clip(body.registeredState, 20);
  if (st && !/^[A-Za-z]{2}$/.test(st)) throw Object.assign(new Error('Use the two-letter state code, like AL.'), { status: 400 });
  await pool.query(`INSERT INTO pcsa_agent_profiles (user_id, registered_state, registration_number, pro_association, association_certified, updated_at)
    VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (user_id) DO UPDATE SET registered_state = EXCLUDED.registered_state,
    registration_number = EXCLUDED.registration_number, pro_association = EXCLUDED.pro_association,
    association_certified = EXCLUDED.association_certified, updated_at = NOW()`,
  [String(userId), st ? st.toUpperCase() : null, clip(body.registrationNumber, 60), clip(body.proAssociation, 80), body.associationCertified === true]);
  return getProfile(pool, userId);
}

function rules() {
  return {
    status: STATUS(), source: source(),
    rules: [
      { key: 'agentFee', text: 'Agent fees are capped at 5% of an endorsement contract\'s value.' },
      { key: 'agencyContract', text: 'Agency contracts must be in writing and cannot extend beyond the athlete\'s eligibility.' },
      { key: 'agentProfile', text: 'Agents register with a state (or hold a players association certification) and certify it to the NCAA, which keeps a public list.' },
      { key: 'eligibility', text: 'Athletes get 5 calendar years. The first transfer is free; a second costs a year unless the sport was cut, the head coach left, there was sexual assault or harassment, or it is for graduate study.' },
      { key: 'disclosure', text: 'Division I athletes report NIL over $600 in 12 months within 5 days of signing or 30 days of payment.' },
      { key: 'nilPurpose', text: 'Every NIL deal not with the school needs a valid business purpose. Deals paid by collectives, boosters (over $50,000 given), conferences or school staff must pay what non-athletes get for the same work.' },
    ],
    disclaimer: 'Educational information, not legal advice.',
  };
}

module.exports = {
  STATUS, SOURCE, FEE_CAP, DISCLOSE_OVER, TRANSFER_EXCEPTIONS, BOOSTER_LIFETIME,
  agentFee, eligibility, contractTerm, disclosure, nilPurpose, agentProfile, checkDeal, rules,
  ensureTable, getProfile, saveProfile, _reset() { _ensured = false; },
};
