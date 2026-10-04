'use strict';
// ── HOW LONG THE SEND BUTTONS TAKE, MEASURED ON THE REQUEST ITSELF ──────────
//
// An agent's "the app froze" is a duration nobody recorded. Each send-related
// request (Approve on Home, Send in the outreach editor, the Home reload that
// follows an approve) records its total and each step it took before
// answering, one row per request, so the question is answered from production
// rather than by reading code. scripts/send-timing.js prints them.
//
//   const T = sendTimings.start('closer/approve', agentId);
//   T.mark('guard'); ... T.mark('update');
//   T.done(pool, { status: 200, note: '1 scheduled' });   // never throws
//
// Also sent as a Server-Timing header when a response object is passed to
// header(), so the browser's network panel shows the same steps.

let _ready = null;
function ensureTable(pool) {
  if (!_ready) {
    _ready = pool.query(`
      CREATE TABLE IF NOT EXISTS send_request_timings (
        id        SERIAL PRIMARY KEY,
        at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        route     TEXT NOT NULL,
        agent_id  TEXT,
        ms        INTEGER NOT NULL,
        steps     JSONB,
        status    INTEGER,
        note      TEXT
      )`)
      .then(() => pool.query(`CREATE INDEX IF NOT EXISTS send_request_timings_agent_at ON send_request_timings (agent_id, at DESC)`))
      .catch((e) => { _ready = null; console.error('[sendTimings] ensureTable:', e.message); });
  }
  return _ready;
}

function start(route, agentId) {
  const t0 = Date.now();
  let last = t0;
  const steps = [];
  return {
    mark(name) { const now = Date.now(); steps.push([name, now - last]); last = now; },
    elapsed() { return Date.now() - t0; },
    steps() { return steps.slice(); },
    header(res) {
      try {
        res.set('Server-Timing', steps.map(([n, ms]) => `${String(n).replace(/[^a-z0-9_-]/gi, '_')};dur=${ms}`).join(', '));
      } catch (_) { /* headers already sent */ }
    },
    async done(pool, { status = 200, note = null } = {}) {
      const ms = Date.now() - t0;
      if (ms > 2000) console.warn(`[send-timing] ${route} agent=${agentId} took ${ms}ms: ${steps.map(([n, s]) => `${n}=${s}`).join(' ')}`);
      try {
        await ensureTable(pool);
        await pool.query(
          `INSERT INTO send_request_timings (route, agent_id, ms, steps, status, note) VALUES ($1,$2,$3,$4,$5,$6)`,
          [route, agentId || null, ms, JSON.stringify(Object.fromEntries(steps)), status, note ? String(note).slice(0, 300) : null]);
      } catch (e) { console.error('[sendTimings] record:', e.message); }
      return ms;
    },
  };
}

// Express middleware: req._T is the timer; the row is written when the
// response finishes, with the steps the handler marked (req._T.mark). minMs
// keeps only the slow ones for a route that is called far more than it is slow.
function middleware(route, { pool, minMs = 0 } = {}) {
  return (req, res, next) => {
    const agentId = (req.session && req.session.userId) || (req.principal && req.principal.id) || null;
    const T = start(route, agentId);
    req._T = T;
    const json = res.json.bind(res);
    res.json = (body) => { T.mark('respond'); T.header(res); return json(body); };
    res.on('finish', () => {
      if (T.elapsed() < minMs) return;
      const p = pool || require('../store').pool;
      T.done(p, { status: res.statusCode, note: res.locals && res.locals.timingNote });
    });
    next();
  };
}

module.exports = { start, ensureTable, middleware };
