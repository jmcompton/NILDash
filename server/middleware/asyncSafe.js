'use strict';
// ── AN ERROR IN ONE REQUEST MUST NOT TAKE THE SERVER DOWN ───────────────────
//
// Express 4 calls a route and ignores what it returns. An async route that
// throws therefore rejects a promise nobody is holding, and Node ends the
// process on an unhandled rejection: one bad page and every agent gets
// "Application failed to respond" until the host restarts it. /admin/inbound
// did exactly that on Nov 25, 2026 (it read a name that was never defined),
// twice, in the middle of the day.
//
// install() makes every route's rejection that request's problem only: it is
// logged with its path, and the request is answered 500 in plain words if it
// has not been answered already. Synchronous throws were already handled by
// Express. The process-level handler is the backstop for a rejection that did
// not come from a route (a timer, a background job): logged, never fatal.
function answer(req, res, e) {
  console.error(`[route-error] ${req.method} ${String(req.originalUrl || '').split('?')[0]}: ${(e && e.stack) || e}`);
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  const api = String(req.originalUrl || '').startsWith('/api/');
  try {
    if (api) res.status(500).json({ error: 'Something went wrong on our side. Try again.' });
    else res.status(500).type('text').send('Something went wrong on our side. Try again.');
  } catch (_) {}
}

let _installed = false;
function install() {
  if (_installed) return;
  _installed = true;
  const Layer = require('express/lib/router/layer');
  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();          // an error handler, not a route
    try {
      const out = fn(req, res, next);
      if (out && typeof out.then === 'function') out.then(null, (e) => answer(req, res, e || new Error('rejected with no reason')));
    } catch (err) { next(err); }
  };
  process.on('unhandledRejection', (e) => { console.error('[unhandled-rejection] not from a route, server kept up:', (e && e.stack) || e); });
}

module.exports = { install, _answer: answer };
