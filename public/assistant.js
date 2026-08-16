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
// NO CACHED GUESS. This was a localStorage copy of the server's last answer, used
// optimistically because the real one arrived with the greeting. When the guess said
// no and the server said yes, the panel fell through to opening AFTER the response --
// which is the late-open bug it was added to fix, reappearing whenever the cache was
// stale. The flag now rides on /api/auth/me, which the page already awaits before
// bootApp, so the true answer is in hand before the decision is made.

function naEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function naBase() { return (typeof API_BASE === 'string') ? API_BASE : ''; }

// ── Shell ────────────────────────────────────────────────────────────────────
// A DOCKED SIDEBAR, not a floating bubble. The tab is the only control: it opens the
// panel, it closes it, and it rides along at the panel's left edge so the thing you
// press to close is where the panel actually is. There is no X anywhere, which is why
// the tab must never become unreachable.
//
// The panel is ALWAYS in the DOM and always display:flex. Open and closed are a
// transform, because display:none cannot be animated and the slide is the point.

var NA_W = 380;          // panel width, desktop
var NA_MOBILE = 900;     // below this the panel is full width and content does not shift
var NA_MS = 280;         // slide duration, both directions
var NA_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

function naStyles() {
  if (document.getElementById('na-styles')) return;
  var st = document.createElement('style');
  st.id = 'na-styles';
  st.textContent = [
    // ── NEVER ON A PUBLIC PAGE ──
    // body.app-active is added by bootApp and removed by showMarketingLanding, so
    // it means exactly "inside the logged-in portal". Signing out returns to the
    // marketing overlay WITHOUT a reload, which left the tab sitting on top of the
    // public site at z-index 9999 over the overlay's 700. A structural rule beats
    // remembering to tear the widget down on every exit path.
    'body:not(.app-active) #nil-assistant{display:none !important;}',

    // ── the panel ──
    '#na-panel{position:fixed;top:0;right:0;z-index:9998;width:' + NA_W + 'px;height:100vh;',
    '  display:flex;flex-direction:column;background:var(--surface,#141929);',
    '  border-left:1px solid var(--border,rgba(255,255,255,0.08));',
    '  box-shadow:-8px 0 32px rgba(0,0,0,0.28);',
    '  transform:translateX(100%);transition:transform ' + NA_MS + 'ms ' + NA_EASE + ';}',
    'body.na-open #na-panel{transform:translateX(0);}',

    // ── the tab ──
    // right: 0 closed, right: panel width open. Same duration and easing as the panel,
    // so they move as one object rather than two things that happen to both animate.
    // LOW AND RIGHT, not centred. Anchored to the bottom rather than to a
    // percentage of the viewport: at 58% it floated over the middle of whatever
    // card happened to be there, and on a long page that is content, not margin.
    // Above the fold on any normal window, and out of the way of the columns.
    '#na-tab{position:fixed;bottom:76px;right:0;z-index:9999;',
    '  display:flex;align-items:center;gap:8px;padding:10px 10px 10px 11px;',
    '  background:var(--accent,#84CC16);color:#0b0f0a;border:none;cursor:pointer;',
    '  border-radius:10px 0 0 10px;box-shadow:-2px 0 10px rgba(0,0,0,0.25);',
    '  font-family:inherit;font-size:12px;font-weight:700;line-height:1;',
    '  transition:right ' + NA_MS + 'ms ' + NA_EASE + ';}',
    'body.na-open #na-tab{right:' + NA_W + 'px;}',
    '#na-tab:hover{filter:brightness(1.06);}',
    // The N mark: a small dark square, the app's own brand shape at tab scale.
    '#na-tab .na-mark{width:20px;height:20px;flex-shrink:0;border-radius:4px;',
    '  background:#0b0f0a;color:var(--accent,#84CC16);display:flex;align-items:center;',
    '  justify-content:center;font-size:12px;font-weight:800;}',
    '#na-tab .na-chev{font-size:13px;line-height:1;transition:transform ' + NA_MS + 'ms ' + NA_EASE + ';}',
    // Closed the chevron points left (the panel comes in from the right); open it
    // points right (the panel goes back). One glyph, rotated, so they cannot disagree.
    'body.na-open #na-tab .na-chev{transform:rotate(180deg);}',

    // ── content shifts, it is not covered ──
    // MARGIN, NOT WIDTH. .main is flex:1, which means flex-basis:0 plus grow -- the
    // flex algorithm sizes it and the width property is ignored outright. Setting
    // width here looked correct in the CSS and did nothing on screen: the cards ran
    // straight under the panel. Margin is part of the flex item's outer size, so the
    // algorithm has to honour it.
    '.main{transition:margin-right ' + NA_MS + 'ms ' + NA_EASE + ';}',
    '@media (min-width:' + (NA_MOBILE + 1) + 'px){',
    '  body.na-open .main{margin-right:' + NA_W + 'px;}}',

    // ── header ──
    '#na-panel .na-head{flex-shrink:0;padding:16px 18px;background:var(--surface2,#1E2540);',
    '  border-bottom:1px solid var(--border,rgba(255,255,255,0.08));}',
    '#na-panel .na-title{font-size:14px;font-weight:700;color:var(--text,#F0F4FF);line-height:1.25;}',
    '#na-panel .na-sub{font-size:11.5px;color:var(--muted,rgba(240,244,255,0.45));line-height:1.4;margin-top:3px;}',

    // ── log ──
    '#na-log{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}',

    // ── messages ──
    // The squared corner is the tail: bottom-left on the assistant, bottom-right on
    // the agent, so which side spoke reads without colour.
    '.na-msg{max-width:88%;padding:10px 13px;font-size:13px;line-height:1.55;',
    '  white-space:pre-wrap;overflow-wrap:anywhere;}',
    '.na-msg.na-a{align-self:flex-start;background:var(--surface2,#1E2540);color:var(--text,#F0F4FF);',
    '  border:1px solid var(--border,rgba(255,255,255,0.08));border-radius:12px 12px 12px 2px;}',
    '.na-msg.na-u{align-self:flex-end;background:var(--accent,#84CC16);color:#0b0f0a;',
    '  font-weight:500;border-radius:12px 12px 2px 12px;}',

    // ── the running indicator ──
    // Three dots AND a line naming the work. "Scanning Tuscaloosa", never "Working".
    '.na-run{align-self:flex-start;display:flex;align-items:center;gap:10px;padding:10px 13px;',
    '  background:var(--surface2,#1E2540);border:1px solid var(--border,rgba(255,255,255,0.08));',
    '  border-radius:12px 12px 12px 2px;}',
    '.na-run .na-dots{display:flex;gap:4px;flex-shrink:0;}',
    '.na-run .na-dots i{width:6px;height:6px;border-radius:50%;background:var(--accent,#84CC16);',
    '  animation:na-pulse 1.2s ease-in-out infinite;}',
    '.na-run .na-dots i:nth-child(2){animation-delay:0.15s;}',
    '.na-run .na-dots i:nth-child(3){animation-delay:0.3s;}',
    '.na-run .na-what{font-size:12.5px;color:var(--muted,rgba(240,244,255,0.45));line-height:1.4;}',
    '@keyframes na-pulse{0%,80%,100%{opacity:0.25;transform:scale(0.8);}40%{opacity:1;transform:scale(1);}}',

    // ── confirmation card ──
    // A card, not a sentence: this is the one place the agent is agreeing to something
    // irreversible, and it should not look like chat.
    '.na-card{align-self:stretch;background:var(--surface2,#1E2540);',
    '  border:1px solid var(--border2,rgba(255,255,255,0.14));border-radius:12px;padding:14px;}',
    '.na-card .na-label{font-size:10px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;',
    '  color:var(--muted,rgba(240,244,255,0.45));}',
    '.na-card .na-what{font-size:13px;line-height:1.5;color:var(--text,#F0F4FF);margin:9px 0 13px;}',
    '.na-card .na-what strong{font-weight:700;color:var(--text,#F0F4FF);}',
    '.na-card .na-btns{display:flex;gap:8px;}',
    '.na-btn{padding:8px 14px;border-radius:8px;font-size:12.5px;font-weight:700;cursor:pointer;',
    '  font-family:inherit;line-height:1;}',
    '.na-btn.na-primary{background:var(--accent,#84CC16);border:none;color:#0b0f0a;}',
    '.na-btn.na-ghost{background:transparent;border:1px solid var(--border2,rgba(255,255,255,0.14));',
    '  color:var(--muted,rgba(240,244,255,0.45));font-weight:600;}',
    '.na-btn:hover{filter:brightness(1.08);}',

    // ── error ──
    '.na-err{align-self:stretch;background:var(--surface2,#1E2540);border:1px solid #f87171;',
    '  border-radius:12px;padding:13px;}',
    '.na-err .na-what{font-size:13px;color:#f87171;line-height:1.5;}',

    // ── composer ──
    '#na-panel .na-foot{flex-shrink:0;display:flex;gap:8px;padding:12px;',
    '  border-top:1px solid var(--border,rgba(255,255,255,0.08));}',
    '#na-input{flex:1;min-width:0;min-height:40px;padding:9px 12px;font-family:inherit;font-size:13.5px;',
    '  background:var(--bg,#0A0E1A);border:1px solid var(--border,rgba(255,255,255,0.08));',
    '  border-radius:9px;color:var(--text,#F0F4FF);outline:none;}',
    '#na-input:focus{border-color:var(--accent,#84CC16);}',

    // ── mobile ──
    // Full width, and the page does not shift because there is nowhere to shift to.
    // The tab stays pinned to the right edge ON TOP of the panel rather than riding to
    // the far left: it is the only way to close, so it must stay where a thumb is.
    '@media (max-width:' + NA_MOBILE + 'px){',
    '  #na-panel{width:100vw;}',
    '  body.na-open #na-tab{right:0;}',
    '  body.na-open .main{margin-right:0;}}',
  ].join('\n');
  document.head.appendChild(st);
}

function naBuild() {
  if (document.getElementById('nil-assistant')) return;
  naStyles();
  var wrap = document.createElement('div');
  wrap.id = 'nil-assistant';
  wrap.innerHTML =
    '<button id="na-tab" type="button" onclick="nilAssistant.toggle()"'
      + ' aria-controls="na-panel" aria-expanded="false" aria-label="Open the NILDash assistant">'
      + '<span class="na-mark" aria-hidden="true">N</span>'
      + '<span>Assistant</span>'
      + '<span class="na-chev" aria-hidden="true">&#10094;</span>'
    + '</button>'
    + '<aside id="na-panel" role="complementary" aria-label="NILDash assistant">'
      + '<div class="na-head">'
        + '<div class="na-title">NILDash assistant</div>'
        + '<div class="na-sub">Ask about the product, or tell me what to do</div>'
      + '</div>'
      + '<div id="na-log"></div>'
      + '<div class="na-foot">'
        + '<input id="na-input" type="text" placeholder="Ask me anything" autocomplete="off"'
          + ' onkeydown="if(event.key===\'Enter\'){nilAssistant.send();}">'
        + '<button type="button" class="na-btn na-primary" onclick="nilAssistant.send()">Send</button>'
      + '</div>'
    + '</aside>';
  document.body.appendChild(wrap);
  NA.el = wrap;
}

function naScroll() {
  var log = document.getElementById('na-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function naSay(role, text) {
  var log = document.getElementById('na-log');
  if (!log) return null;
  var d = document.createElement('div');
  d.className = 'na-msg ' + (role === 'user' ? 'na-u' : 'na-a');
  d.textContent = text;
  log.appendChild(d);
  naScroll();
  return d;
}

// THE INDICATOR NAMES THE WORK. A spinner that says nothing is indistinguishable from
// a hang, and this app's slow actions are slow enough to matter: a scan is a minute.
// Callers pass what is actually happening, not a generic word.
function naRunning(what) {
  var log = document.getElementById('na-log');
  if (!log) return null;
  var d = document.createElement('div');
  d.className = 'na-run';
  d.innerHTML = '<span class="na-dots" aria-hidden="true"><i></i><i></i><i></i></span>'
    + '<span class="na-what"></span>';
  d.querySelector('.na-what').textContent = what || 'Working on it';
  d.setAttribute('role', 'status');
  log.appendChild(d);
  naScroll();
  return d;
}

// "Scanning Tuscaloosa", from the roster the page already has. Falls back through
// school, then name, then a plain sentence: a wrong specific label would be worse
// than a general one.
function naScanLabel(athleteId) {
  try {
    var list = window.athletes || [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a && a.id === athleteId) {
        if (a.school) return 'Scanning ' + a.school;
        if (a.name) return 'Scanning for ' + a.name;
        break;
      }
    }
  } catch (_) {}
  return 'Running the deal scan';
}

// A confirmation is a CARD with the literal consequence on it. The assistant asked;
// the agent decides. Nothing has happened at this point.
//
// The subject is bolded by matching the server's `subject` string inside the ESCAPED
// sentence, so no markup ever crosses the wire. If it does not match, the sentence
// renders plain rather than half-marked-up.
function naConfirm(c) {
  var log = document.getElementById('na-log');
  if (!log) return;
  var d = document.createElement('div');
  d.className = 'na-card';

  var text = naEsc(c.text);
  if (c.subject) {
    var subj = naEsc(String(c.subject));
    var at = text.indexOf(subj);
    if (at !== -1) {
      text = text.slice(0, at) + '<strong>' + subj + '</strong>' + text.slice(at + subj.length);
    }
  }

  d.innerHTML = '<div class="na-label"></div>'
    + '<div class="na-what">' + text + '</div>'
    + '<div class="na-btns">'
      + '<button type="button" class="na-btn na-primary na-yes"></button>'
      + '<button type="button" class="na-btn na-ghost na-no">Not now</button>'
    + '</div>';
  d.querySelector('.na-label').textContent = c.label || 'Confirm before continuing';
  var yes = d.querySelector('.na-yes');
  yes.textContent = c.button || 'Confirm';
  yes.setAttribute('data-token', c.token || '');
  yes.addEventListener('click', function (e) {
    naRunConfirm(e.currentTarget.getAttribute('data-token'), d);
  });
  d.querySelector('.na-no').addEventListener('click', function () {
    d.remove();
    naSay('assistant', 'Left it alone.');
  });
  log.appendChild(d);
  naScroll();
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
          // AWAITED, so the dots stay up for the whole scan rather than blinking off
          // while it runs. finally, so a scan that throws still clears them.
          var run = naRunning(naScanLabel(d.athleteId));
          try { await window.nilRunDealScanFor(d.athleteId); }
          finally { if (run) run.remove(); }
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
  var eager = autoOpenAllowed && NA.autoOpen && !sessionStorage.getItem(NA_SESSION_KEY);
  if (eager) {
    try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
    naOpen();
  }
  // Always drawn, even if the panel is shut: an agent who opens the tab while the
  // greeting is still in flight finds the indicator rather than an empty log.
  var thinking = naRunning('Reading your dashboard');

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

    // A RESUMED conversation does not re-open by itself, and that is the one thing
    // only the greeting response can tell us. Everything else was decided before the
    // request went out. naClose, never naDismiss: the agent did not close this, so it
    // must not count against them.
    if (eager && j.resumed) naClose();
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
  d.className = 'na-err';
  d.innerHTML = '<div class="na-what"></div>'
    + '<button type="button" class="na-btn na-ghost na-retry" style="margin-top:10px">Retry</button>';
  d.querySelector('.na-what').textContent = msg;
  d.querySelector('.na-retry').addEventListener('click', function () {
    log.innerHTML = '';
    naStart(false);
  });
  log.appendChild(d);
}

// ONE CLASS DRIVES EVERYTHING. The panel slide, the tab's travel, the chevron flip
// and the page's width all key off body.na-open, so they cannot get out of step with
// each other or with NA.open.
function naOpen() {
  if (!document.getElementById('na-panel')) return;
  document.body.classList.add('na-open');
  naSyncTab(true);
  NA.open = true;
  var i = document.getElementById('na-input');
  if (i && window.innerWidth > NA_MOBILE) i.focus();
  naScroll();
}

function naClose() {
  document.body.classList.remove('na-open');
  naSyncTab(false);
  NA.open = false;
}

function naSyncTab(open) {
  var t = document.getElementById('na-tab');
  if (!t) return;
  t.setAttribute('aria-expanded', open ? 'true' : 'false');
  t.setAttribute('aria-label', open ? 'Close the NILDash assistant' : 'Open the NILDash assistant');
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
  var thinking = naRunning('Thinking');
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
// opts.autoOpen is the server's real answer, carried on /api/auth/me. Defaults to
// TRUE when absent so an older cached index.html still greets rather than going
// silent -- the failure mode of a missing flag should be a panel too many, not none.
function naInit(opts) {
  naBuild();
  NA.autoOpen = !(opts && opts.autoOpen === false);
  naStart(true);
}

window.nilAssistant = {
  init: naInit, open: naOpen, close: naClose, dismiss: naDismiss,
  send: naSend, toggle: naToggle, perform: naPerform,
  _state: NA, _unsavedOutreach: naUnsavedOutreach,
  // Render helpers, exposed so the shell can be driven into each visual state
  // without a server. They only draw; nothing here performs an action.
  _say: naSay, _running: naRunning, _confirm: naConfirm, _scanLabel: naScanLabel,
};

// Deliberately NOT auto-initialised. index.html calls nilAssistant.init() from
// bootApp(), which only runs after /api/auth/me confirms a session.
