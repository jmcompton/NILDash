'use strict';
// ── RESEND, WITH ITS ERRORS TURNED INTO ERRORS ──────────────────────────────
//
// resend.emails.send() does not throw on an API error. It resolves to
// { data: null, error: { name, message } } -- a revoked key, an unverified
// domain, a rejected address all "succeed". The audit found call sites that
// awaited it and carried on as sent: the shift report and the deliverable
// digest marked the day sent, the weekly digest called markSent, the growth
// sequence recorded the send and then refused to resend the subject.
//
// ONE RULE, NOT A PATCH PER CALLER (services/ourFault): every place that makes
// a Resend client makes it through this, and a { error } result throws with
// Resend's own words, so each caller's existing failure path runs. It is also
// recorded as a fault for the morning alert and the status page.
function checked(client) {
  if (!client || !client.emails || typeof client.emails.send !== 'function') return client;
  const send = client.emails.send.bind(client.emails);
  client.emails.send = async (...args) => {
    const r = await send(...args);
    if (r && r.error) {
      const why = r.error.message || r.error.name || JSON.stringify(r.error);
      try { require('./ourFault').record('resend', why, 'resend.emails.send'); } catch (_) { /* never mask the send error */ }
      const e = new Error('Resend refused the email: ' + why);
      e.resend = r.error;
      e.ourFault = true;
      e.service = 'resend';
      throw e;
    }
    return r;
  };
  return client;
}

// new Resend(key), checked. The key is read by the caller's environment only.
function makeResend(apiKey) {
  const { Resend } = require('resend');
  return checked(new Resend(apiKey));
}

module.exports = { checked, makeResend };
