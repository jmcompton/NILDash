// public/assistant.js
// The NILDash assistant bubble. Bottom right, every page of the agent portal.
//
// WHAT THE CLIENT IS TRUSTED WITH: performing directives the SERVER issued. It never
// decides what may happen. A confirm-tier action arrives as a token and a sentence,
// and the only way it becomes a directive is a POST /confirm the human triggered by
// clicking, which the server validates again.
//
// AUTO-OPEN. Once per browser session on first load, and only if the server says
// this agent still has auto-open on. Dismissing without replying tells the server;
// two in a row and it never auto-opens for them again.

'use strict';

var NA = {
  sessionId: null,
  open: false,
  busy: false,
  greeted: false,     // set only on a SUCCESSFUL greeting, so a failure can retry
  greeting: false,    // a request is in flight
  autoOpen: false,
  replied: false,     // did the agent say anything this open
  el: null,
};

var NA_SESSION_KEY = 'nildash.assistant.opened';
// The server owns the auto-open decision, but it arrives WITH the greeting, and
// waiting for it was the whole delay. So the last answer is cached and used
// optimistically on the next load; every response rewrites it, and a response that
// disagrees closes the panel again. The only agent who sees a panel flash is one who
// just turned auto-open off, and only on the one load after they did.
var NA_AUTOOPEN_KEY = 'nildash.assistant.autoopen';
function naAutoOpenCached() {
  try { return localStorage.getItem(NA_AUTOOPEN_KEY) !== '0'; } catch (_) { return true; }
}
function naRememberAutoOpen(v) {
  try { localStorage.setItem(NA_AUTOOPEN_KEY, v ? '1' : '0'); } catch (_) {}
}

function naEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function naBase() { return (typeof API_BASE === 'string') ? API_BASE : ''; }

// ── Shell ────────────────────────────────────────────────────────────────────
function naBuild() {
  if (document.getElementById('nil-assistant')) return;
  var wrap = document.createElement('div');
  wrap.id = 'nil-assistant';
  wrap.innerHTML =
    // ONE control at a time. The bubble is hidden while the panel is open, so the
    // panel's own header close button is the only thing to click. Two buttons stacked
    // in the same corner read as a broken layout.
    '<button id="na-bubble" type="button" onclick="nilAssistant.toggle()" aria-label="Open the NILDash assistant"' +
      ' style="position:fixed;right:20px;bottom:20px;z-index:9998;width:54px;height:54px;border-radius:50%;' +
      'background:var(--accent,#84CC16);border:none;color:#0b0f0a;font-size:22px;font-weight:800;cursor:pointer;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center">?</button>' +
    // Anchored to the corner with the same 20px gutter as the bubble, and tall: 70%
    // of the viewport rather than a 560px box floating mid-air.
    '<div id="na-panel" role="dialog" aria-label="NILDash assistant" aria-modal="false"' +
      ' style="display:none;position:fixed;right:20px;bottom:20px;z-index:9999;' +
      'width:min(400px,calc(100vw - 40px));height:min(70vh,640px);max-height:calc(100vh - 40px);' +
      'background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);' +
      'border-radius:14px;box-shadow:0 16px 48px rgba(0,0,0,0.55);flex-direction:column;overflow:hidden">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;' +
        'padding:14px 16px;border-bottom:1px solid var(--border,#333);flex-shrink:0;background:var(--surface2,#222)">' +
        '<div style="display:flex;align-items:center;gap:9px;min-width:0">' +
          '<span style="width:26px;height:26px;flex-shrink:0;border-radius:50%;background:var(--accent,#84CC16);' +
            'color:#0b0f0a;font-size:14px;font-weight:800;display:flex;align-items:center;justify-content:center">?</span>' +
          '<div style="min-width:0">' +
            '<div style="font-size:14px;font-weight:700;color:var(--text,#fff);line-height:1.2">NILDash assistant</div>' +
            '<div style="font-size:11px;color:var(--muted,#888);line-height:1.3">Ask about the product, or tell me what to do</div>' +
          '</div>' +
        '</div>' +
        '<button type="button" onclick="nilAssistant.dismiss()" aria-label="Close the assistant"' +
          ' style="background:none;border:none;color:var(--muted,#888);font-size:24px;cursor:pointer;line-height:1;' +
          'padding:0 4px;flex-shrink:0">&times;</button>' +
      '</div>' +
      '<div id="na-log" style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px"></div>' +
      '<div style="padding:10px 12px;border-top:1px solid var(--border,#333);flex-shrink:0;display:flex;gap:8px">' +
        '<input id="na-input" type="text" placeholder="Ask me anything" autocomplete="off"' +
          ' onkeydown="if(event.key===\'Enter\'){nilAssistant.send();}"' +
          ' style="flex:1;min-height:40px;padding:8px 12px;background:var(--surface2,#222);border:1px solid var(--border,#333);' +
          'border-radius:8px;color:var(--text,#fff);font-size:14px;outline:none;font-family:inherit">' +
        '<button type="button" onclick="nilAssistant.send()"' +
          ' style="min-height:40px;padding:8px 14px;background:var(--accent,#84CC16);border:none;border-radius:8px;' +
          'color:#0b0f0a;font-size:13px;font-weight:700;cursor:pointer">Send</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  NA.el = wrap;
}

function naSay(role, text) {
  var log = document.getElementById('na-log');
  if (!log) return null;
  var mine = role === 'user';
  var d = document.createElement('div');
  d.style.cssText = 'max-width:88%;padding:9px 12px;border-radius:10px;font-size:13px;line-height:1.55;white-space:pre-wrap;'
    + (mine
      ? 'align-self:flex-end;background:var(--accent,#84CC16);color:#0b0f0a'
      : 'align-self:flex-start;background:var(--surface2,#222);color:var(--text,#fff);border:1px solid var(--border,#333)');
  d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

// A confirmation is a BUTTON with the literal consequence on it. The assistant asked;
// the agent decides. Nothing has happened at this point.
function naConfirm(c) {
  var log = document.getElementById('na-log');
  if (!log) return;
  var d = document.createElement('div');
  d.style.cssText = 'align-self:flex-start;max-width:88%;padding:11px 12px;border-radius:10px;'
    + 'background:var(--surface2,#222);border:1px solid #fbbf24';
  d.innerHTML = '<div style="font-size:13px;color:var(--text,#fff);line-height:1.5;margin-bottom:9px">' + naEsc(c.text) + '</div>'
    + '<div style="display:flex;gap:8px">'
    + '<button type="button" data-token="' + naEsc(c.token) + '" class="na-yes"'
    + ' style="padding:6px 14px;background:var(--accent,#84CC16);border:none;border-radius:6px;color:#0b0f0a;font-size:12px;font-weight:700;cursor:pointer">'
    + naEsc(c.button || 'Confirm') + '</button>'
    + '<button type="button" class="na-no"'
    + ' style="padding:6px 14px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--muted,#888);font-size:12px;cursor:pointer">No</button>'
    + '</div>';
  d.querySelector('.na-yes').addEventListener('click', function (e) {
    naRunConfirm(e.currentTarget.getAttribute('data-token'), d);
  });
  d.querySelector('.na-no').addEventListener('click', function () {
    d.remove();
    naSay('assistant', 'Left it alone.');
  });
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
}

async function naRunConfirm(token, node) {
  if (!token) return;
  try {
    var r = await fetch(naBase() + '/api/assistant/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ token: token, sessionId: NA.sessionId }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (node) node.remove();
    if (!r.ok || !j.directive) { naSay('assistant', (j && j.error) || 'That did not go through.'); return; }
    await naPerform([j.directive]);
  } catch (e) {
    naSay('assistant', 'That did not go through: ' + (e && e.message ? e.message : e));
  }
}

// ── Performing directives ────────────────────────────────────────────────────
// Everything here calls an endpoint or a UI function that ALREADY existed. The
// assistant introduces no new way to change data.
async function naPerform(directives) {
  for (var i = 0; i < (directives || []).length; i++) {
    var d = directives[i];
    try {
      if (d.kind === 'open_tab') {
        // THE ONE DIRECTIVE THE CLIENT MAY REFUSE. Navigating away from an outreach
        // draft with unsaved edits would lose the agent's typing, and no assistant
        // convenience is worth that.
        if (naUnsavedOutreach()) {
          naSay('assistant', 'You have an outreach draft open with unsaved edits, so I have not navigated away. Save or close it and ask me again.');
          continue;
        }
        if (typeof showView === 'function') showView(d.tab, null);
      } else if (d.kind === 'connect_gmail') {
        var back = window.location.pathname + window.location.search + window.location.hash;
        window.location.href = '/api/email/oauth/gmail?returnTo=' + encodeURIComponent(back);
      } else if (d.kind === 'run_deal_scan') {
        // NOTHING IS SAID HERE. The server already reported the scan to the model as
        // a tool result, and the model wrote a sentence about it. A second line from
        // the client made the assistant say the same thing twice.
        if (typeof window.nilRunDealScanFor === 'function') {
          window.nilRunDealScanFor(d.athleteId);
        } else {
          if (typeof showView === 'function') showView('deals', null);
          naSay('assistant', 'Deal Scan is open. Press Scan and it will run for them.');
        }
      } else if (d.kind === 'lookup_program') {
        if (typeof showView === 'function') showView('programs', null);
        if (typeof progSetSport === 'function' && d.sport) { try { progSetSport(d.sport); } catch (_) {} }
        if (typeof progSelect === 'function') { try { await progSelect(d.school); } catch (_) {} }
      } else if (d.kind === 'post') {
        var r = await fetch(naBase() + d.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(d.body || {}),
        });
        var j = await r.json().catch(function () { return {}; });
        if (!r.ok) { naSay('assistant', 'That did not work: ' + ((j && j.error) || ('error ' + r.status))); continue; }
        if (d.then === 'reload_athletes' && typeof loadAthletes === 'function') { try { await loadAthletes(); } catch (_) {} }
        if (d.then === 'media_kit_built') naSay('assistant', 'Media kit built.');
      } else if (d.kind === 'send_outreach' || d.kind === 'update_deal' || d.kind === 'delete_athlete') {
        // These only ever arrive from /confirm, which means a human already clicked.
        await naPerformConfirmed(d);
      }
    } catch (e) {
      naSay('assistant', 'That did not work: ' + (e && e.message ? e.message : e));
    }
  }
}

async function naPerformConfirmed(d) {
  var url = null, method = 'POST', body = {};
  if (d.kind === 'send_outreach') {
    // Reuses the same endpoint the Send button uses, including its own checks.
    url = '/api/outreach/logs/' + encodeURIComponent(d.outreachId) + '/send';
    var accSel = document.getElementById('outreach-from-account');
    body = { emailAccountId: accSel ? accSel.value : null, toEmail: d.toEmail };
    if (!body.emailAccountId) {
      naSay('assistant', 'There is no mailbox selected to send from. Open the outreach panel and connect Gmail first.');
      return;
    }
  } else if (d.kind === 'update_deal') {
    url = '/api/deals/' + encodeURIComponent(d.dealId); method = 'PATCH'; body = { stage: d.stage };
  } else if (d.kind === 'delete_athlete') {
    url = '/api/athletes/' + encodeURIComponent(d.athleteId); method = 'DELETE';
  }
  if (!url) return;
  var r = await fetch(naBase() + url, {
    method: method, headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  });
  var j = await r.json().catch(function () { return {}; });
  if (!r.ok) { naSay('assistant', 'That did not go through: ' + ((j && j.error) || ('error ' + r.status))); return; }
  naSay('assistant', 'Done.');
  if (d.kind === 'delete_athlete' && typeof loadAthletes === 'function') { try { await loadAthletes(); } catch (_) {} }
}

// Is there an outreach draft on screen with edits that have not been saved? Compared
// against what was loaded, so merely opening the panel does not count.
function naUnsavedOutreach() {
  var modal = document.getElementById('outreach-engine-modal');
  if (!modal || modal.style.display === 'none') return false;
  var body = document.getElementById('outreach-body-input');
  var subj = document.getElementById('outreach-subject-input');
  if (!body && !subj) return false;
  if (typeof window._naOutreachSnapshot !== 'string') return true;  // cannot tell: assume unsaved
  return (String(body ? body.value : '') + ' ' + String(subj ? subj.value : '')) !== window._naOutreachSnapshot;
}

// ── Conversation ─────────────────────────────────────────────────────────────
// NA.greeted is only set on SUCCESS. The first version set it before the request and
// swallowed every failure with `if (!r.ok) return;`, so one 500 left the panel empty
// for the rest of the page's life with no retry and nothing on screen: opening the
// bubble found greeted already true and never asked again. That is the same silent
// failure as the outreach dropdown stuck on "Loading accounts".
async function naStart(autoOpenAllowed) {
  if (NA.greeted || NA.greeting) return;
  NA.greeting = true;

  // THE PANEL OPENS NOW, NOT WHEN THE GREETING ARRIVES. naOpen() used to be called
  // after the round trip, so for the whole time the server was working there was
  // nothing on screen at all and the assistant read as broken rather than as busy.
  var eager = autoOpenAllowed && naAutoOpenCached() && !sessionStorage.getItem(NA_SESSION_KEY);
  if (eager) {
    try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
    naOpen();
  }
  // Always drawn, even if the panel is shut: an agent who clicks the bubble while the
  // greeting is still in flight finds the indicator rather than an empty log.
  var thinking = naSay('assistant', '…');

  try {
    var r = await fetch(naBase() + '/api/assistant/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sessionId: NA.sessionId }),
    });
    NA.greeting = false;
    if (r.status === 401) {
      // Not signed in yet. Stay quiet and stay retryable: the portal calls init()
      // again once it has booted. Undo the optimistic open completely, INCLUDING the
      // session flag, or the real greeting a moment later would find it already spent
      // and never open.
      if (thinking) thinking.remove();
      if (eager) {
        naClose();
        try { sessionStorage.removeItem(NA_SESSION_KEY); } catch (_) {}
      }
      return;
    }
    if (!r.ok) {
      var e1 = await r.json().catch(function () { return {}; });
      naFailed((e1 && e1.error) || ('The assistant could not start (error ' + r.status + ').'));
      return;
    }
    var j = await r.json();
    NA.greeted = true;
    NA.sessionId = j.sessionId;
    NA.autoOpen = !!j.autoOpen;
    var log = document.getElementById('na-log');
    if (log) log.innerHTML = '';
    var msgs = (j.messages || []).filter(function (m) { return m && m.content; });
    if (!msgs.length) {
      // The request worked and produced nothing. Say so rather than showing a blank
      // panel that looks broken.
      naFailed('The assistant started but had nothing to say. That is a bug worth reporting.');
      return;
    }
    msgs.forEach(function (m) { naSay(m.role, m.content); });

    // The server has now answered on auto-open, so the cached guess is replaced by
    // the real thing for next time.
    naRememberAutoOpen(NA.autoOpen);
    if (eager) {
      // Opened on a guess. If the server disagrees, shut it again. naClose, never
      // naDismiss: the agent did not close this, so it must not count against them.
      if (!NA.autoOpen || j.resumed) naClose();
    } else if (autoOpenAllowed && NA.autoOpen && !j.resumed && !sessionStorage.getItem(NA_SESSION_KEY)) {
      // Auto-open ONCE per browser session. Reached when the cache said no and the
      // server says yes, which is the load after an agent's dismissals were reset.
      try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
      naOpen();
    }
  } catch (e) {
    NA.greeting = false;
    naFailed('Could not reach the assistant: ' + (e && e.message ? e.message : e));
  }
}

// A failed greeting is visible and retryable. greeted stays false so Retry actually
// re-requests rather than short-circuiting.
function naFailed(msg) {
  var log = document.getElementById('na-log');
  if (!log) return;
  log.innerHTML = '';
  var d = document.createElement('div');
  d.style.cssText = 'align-self:flex-start;max-width:92%;padding:11px 12px;border-radius:10px;'
    + 'background:var(--surface2,#222);border:1px solid #f87171';
  d.innerHTML = '<div style="font-size:13px;color:#f87171;line-height:1.5">' + naEsc(msg) + '</div>'
    + '<button type="button" class="na-retry" style="margin-top:8px;padding:5px 12px;background:transparent;'
    + 'border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-size:12px;cursor:pointer">Retry</button>';
  d.querySelector('.na-retry').addEventListener('click', function () {
    log.innerHTML = '';
    naStart(false);
  });
  log.appendChild(d);
}

function naOpen() {
  var p = document.getElementById('na-panel');
  if (!p) return;
  p.style.display = 'flex';
  var b = document.getElementById('na-bubble');
  if (b) b.style.display = 'none';   // one control at a time
  NA.open = true;
  var i = document.getElementById('na-input');
  if (i && window.innerWidth > 700) i.focus();
}

function naClose() {
  var p = document.getElementById('na-panel');
  if (p) p.style.display = 'none';
  var b = document.getElementById('na-bubble');
  if (b) b.style.display = 'flex';
  NA.open = false;
}

// Closing without having said anything is a dismissal. Two in a row and the server
// stops auto-opening for this agent for good.
function naDismiss() {
  naClose();
  if (NA.replied) return;
  fetch(naBase() + '/api/assistant/dismiss', { method: 'POST', credentials: 'include' }).catch(function () {});
}

async function naSend() {
  if (NA.busy) return;
  var input = document.getElementById('na-input');
  var text = input ? input.value.trim() : '';
  if (!text) return;
  if (input) input.value = '';
  NA.replied = true;
  naSay('user', text);
  NA.busy = true;
  var thinking = naSay('assistant', '…');
  try {
    var r = await fetch(naBase() + '/api/assistant/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sessionId: NA.sessionId, text: text }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (thinking) thinking.remove();
    if (!r.ok) { naSay('assistant', (j && j.error) || 'Something went wrong. Try again?'); return; }
    NA.sessionId = j.sessionId || NA.sessionId;
    if (j.reply) naSay('assistant', j.reply);
    (j.confirms || []).forEach(naConfirm);
    if (j.directives && j.directives.length) await naPerform(j.directives);
  } catch (e) {
    if (thinking) thinking.remove();
    naSay('assistant', 'Something went wrong. Try again?');
  } finally {
    NA.busy = false;
  }
}

function naToggle() {
  if (NA.open) { naDismiss(); return; }
  naOpen();
  if (!NA.greeted) naStart(false);
}

// ── Boot ─────────────────────────────────────────────────────────────────────
// index.html is served to EVERYONE, signed in or not, and the SPA decides which it
// is client side. So this cannot mount itself on DOMContentLoaded: on the logged-out
// page it put a bubble on the marketing view and fired a request that 401ed.
// bootApp() calls init() once the session is confirmed.
function naInit() {
  naBuild();
  naStart(true);
}

window.nilAssistant = {
  init: naInit, open: naOpen, close: naClose, dismiss: naDismiss,
  send: naSend, toggle: naToggle, perform: naPerform,
  _state: NA, _unsavedOutreach: naUnsavedOutreach,
};

// Deliberately NOT auto-initialised. index.html calls nilAssistant.init() from
// bootApp(), which only runs after /api/auth/me confirms a session.
