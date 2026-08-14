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
  greeted: false,
  autoOpen: false,
  replied: false,     // did the agent say anything this open
  el: null,
};

var NA_SESSION_KEY = 'nildash.assistant.opened';

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
    '<button id="na-bubble" type="button" onclick="nilAssistant.toggle()" aria-label="NILDash assistant"' +
      ' style="position:fixed;right:18px;bottom:18px;z-index:9998;width:52px;height:52px;border-radius:50%;' +
      'background:var(--accent,#84CC16);border:none;color:#0b0f0a;font-size:22px;font-weight:800;cursor:pointer;' +
      'box-shadow:0 6px 20px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center">?</button>' +
    '<div id="na-panel" role="dialog" aria-label="NILDash assistant"' +
      ' style="display:none;position:fixed;right:18px;bottom:80px;z-index:9999;width:min(380px,calc(100vw - 36px));' +
      'max-height:min(560px,calc(100vh - 120px));background:var(--surface,#1a1a1a);border:1px solid var(--border,#333);' +
      'border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,0.5);display:none;flex-direction:column;overflow:hidden">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid var(--border,#333);flex-shrink:0">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#fff)">NILDash assistant</div>' +
        '<button type="button" onclick="nilAssistant.dismiss()" aria-label="Close"' +
          ' style="background:none;border:none;color:var(--muted,#888);font-size:20px;cursor:pointer;line-height:1">&times;</button>' +
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
        if (typeof window.nilRunDealScanFor === 'function') {
          naSay('assistant', 'Running it now.');
          window.nilRunDealScanFor(d.athleteId, d.lane);
        } else {
          if (typeof showView === 'function') showView('deal-scan', null);
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
async function naStart(autoOpenAllowed) {
  if (NA.greeted) return;
  NA.greeted = true;
  try {
    var r = await fetch(naBase() + '/api/assistant/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sessionId: NA.sessionId }),
    });
    if (!r.ok) return;
    var j = await r.json();
    NA.sessionId = j.sessionId;
    NA.autoOpen = !!j.autoOpen;
    var log = document.getElementById('na-log');
    if (log) log.innerHTML = '';
    (j.messages || []).forEach(function (m) { naSay(m.role, m.content); });
    // Auto-open ONCE per browser session, and only if the server still allows it for
    // this agent. A resumed conversation does not re-open by itself.
    if (autoOpenAllowed && NA.autoOpen && !j.resumed && !sessionStorage.getItem(NA_SESSION_KEY)) {
      try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
      naOpen();
    }
  } catch (e) { /* the bubble stays available; the greeting simply did not load */ }
}

function naOpen() {
  var p = document.getElementById('na-panel');
  if (!p) return;
  p.style.display = 'flex';
  NA.open = true;
  var i = document.getElementById('na-input');
  if (i && window.innerWidth > 700) i.focus();
}

function naClose() {
  var p = document.getElementById('na-panel');
  if (p) p.style.display = 'none';
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
// Agent portal only. The athlete pages and the admin page do not load this file.
function naInit() {
  naBuild();
  naStart(true);
}

window.nilAssistant = {
  init: naInit, open: naOpen, close: naClose, dismiss: naDismiss,
  send: naSend, toggle: naToggle, perform: naPerform,
  _state: NA, _unsavedOutreach: naUnsavedOutreach,
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', naInit);
  else naInit();
}
