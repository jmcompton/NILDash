'use strict';
// ── HUNTER'S BILLING PERIOD: THE ONE WINDOW EVERY COUNT USES ────────────────
//
// Our Hunter plan resets on the 20th, not the 1st. The counters counted from
// date_trunc('month', NOW()), so on the 21st of October they still held every
// search since October 1st, ten days of them from the period that had already
// reset: "hunter: search budget spent (1800/1800)" 52 times in one night,
// Domain Search blocked, while Hunter's own account showed 135 of 2,000 used.
//
// Hunter's account endpoint (/v2/account, free) gives the next reset date. The
// period began one month before it (the 20th of the month before). Every
// count of what we spent (hunterLookup's search and verification counters,
// verifyBudget, pacing's own-count estimate, the morning email, the
// email-finder-report and the admin status page) reads from here.
//
// WHEN IT IS READ. Never by a counter on its own: a counter is on every
// lookup's path, and the account call is a network call. It is read at boot
// and every few hours (index.js), and whenever pacing reads the account anyway
// (services/hunterPace). A counter asked while that first read is still on its
// way waits for it, a few seconds at most; a counter asked before any read
// was ever started uses the calendar month.
//
// THE FALLBACK. The calendar month only when the account call fails and no
// earlier answer still covers today. A period read a few hours ago is still
// the right period until its reset date passes, so a single failed call does
// not throw the count back to the 1st.

const DAY = 86400000;
const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : d; };
// How long an answer from the account is trusted before it is read again.
const REFRESH_MS = () => num(process.env.HUNTER_PERIOD_REFRESH_HOURS, 3) * 3600000;
// How long a counter waits for a read that is already on its way.
const WAIT_MS = 4000;

let _clock = null;     // tests only: a fixed "now"
const nowMs = (now) => (now != null ? new Date(now).getTime() : (_clock ? _clock() : Date.now()));
let _good = null;      // the last period read from Hunter: { start, resetDate, at }
let _failed = null;    // { at, error } of the last failed read
let _inflight = null;  // the read on its way, if any

const ymd = (t) => new Date(t).toISOString().slice(0, 10);

// One month before a date, the day clamped to the month's length
// (a reset on March 31st began on February 28th or 29th).
function monthBefore(resetDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(resetDate || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();   // the month before's length
  return new Date(Date.UTC(y, mo - 1, Math.min(d, lastDay)));
}

// The calendar month's first day, UTC: what date_trunc('month', NOW()) gave.
function calendarStart(now) {
  const d = new Date(nowMs(now));
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function calendarReset(now) {
  const d = new Date(nowMs(now));
  return ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

// A period from an account answer, or null when it does not give one we can
// trust (no reset date, or one that puts the period's start in the future).
function fromAccount(account, now) {
  if (!account || !account.ok || !account.resetDate) return null;
  const start = monthBefore(account.resetDate);
  if (!start || start.getTime() > nowMs(now)) return null;
  return { start, resetDate: String(account.resetDate).slice(0, 10) };
}

// Pacing and the report read the account anyway: their answer sets the
// period too, free. -> the period it set, or null.
function noteAccount(account, now) {
  const p = fromAccount(account, now);
  if (p) { _good = { ...p, at: Date.now() }; _failed = null; }
  else if (account && !account.ok) _failed = { at: Date.now(), error: account.error || 'no answer' };
  return p;
}

// Read the account now (boot, the timer, a test). -> current()
async function refresh(opts = {}) {
  if (_inflight) { await _inflight; return current(opts); }
  _inflight = (async () => {
    const read = opts.reader || require('./hunterPace').readAccount;
    let account;
    try { account = await read(opts.fetchImpl); } catch (e) { account = { ok: false, error: e.message }; }
    if (!noteAccount(account, opts.now) && account && account.ok) {
      _failed = { at: Date.now(), error: 'the account gave no usable reset date' };
    }
  })().finally(() => { _inflight = null; });
  await _inflight;
  return current(opts);
}

// The window, now. Sync, never a network call.
// -> { start: Date, resetDate: 'YYYY-MM-DD', from: 'hunter' | 'calendar', error? }
function current(opts = {}) {
  const now = nowMs(opts.now);
  // An answer from Hunter holds until its reset date passes.
  if (_good && now < Date.parse(_good.resetDate + 'T00:00:00Z')) {
    return { start: _good.start, resetDate: _good.resetDate, from: 'hunter', readAt: new Date(_good.at) };
  }
  const why = [_good ? 'the last answer from Hunter is past its reset date' : null, _failed ? _failed.error : null].filter(Boolean).join('; ');
  return { start: calendarStart(now), resetDate: calendarReset(now), from: 'calendar', error: why || 'the account has not been read yet' };
}

// For a counter: waits for a read already on its way (never starts one).
async function forCount(opts = {}) {
  if (_inflight) await Promise.race([_inflight.catch(() => {}), new Promise((r) => setTimeout(r, WAIT_MS))]);
  return current(opts);
}

// Read again when the answer is older than REFRESH_MS (the timer's check).
function stale() { return !_good || Date.now() - _good.at >= REFRESH_MS(); }

// "since 2026-10-20 (Hunter resets 2026-11-20)", for every surface that says it.
function describe(w) {
  const p = w || current();
  return p.from === 'hunter'
    ? `since ${ymd(p.start)} (Hunter's billing period; resets ${p.resetDate})`
    : `since ${ymd(p.start)} (the calendar month: Hunter's account could not be read${p.error ? ', ' + p.error : ''})`;
}

module.exports = {
  monthBefore, calendarStart, calendarReset, fromAccount, noteAccount, refresh, current, forCount, stale, describe,
  REFRESH_MS, DAY,
  _reset: () => { _good = null; _failed = null; _inflight = null; },
  _setClock: (fn) => { _clock = fn || null; },
};
