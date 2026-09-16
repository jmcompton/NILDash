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
  // ── FIRST LOGIN ──
  // An agent with no athletes gets the assistant full screen instead of an
  // empty dashboard, and it stays until the first athlete exists. Same
  // component, same endpoints: the server sends the fixed opening and the
  // three choices, and the page hides everything else until finish_onboarding
  // arrives (or the agent chooses to open the dashboard once they have one).
  onboarding: false,
  athleteCount: 0,
  importWatch: null,  // the timer polling for a spreadsheet import to land
  importTold: false,  // the model has been told about the import
  importClosedTold: false,  // the model has been told the import window closed empty
  lookupPath: false,  // the agent chose "look them up": turns may run a web search
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

    // ── first login: the panel IS the screen ──
    // The same panel, stretched over the whole viewport and centred, no tab,
    // no page shift. z-index sits BELOW the app's modals (.modal-overlay is
    // 200) so the spreadsheet import opens on top of it, and above the
    // sidebar and main content, which stay in the DOM untouched underneath.
    'body.na-onboarding #na-tab{display:none !important;}',
    'body.na-onboarding #na-panel{transform:none;width:100vw;left:0;right:0;z-index:150;',
    '  background:var(--bg,#0A0E1A);border-left:none;box-shadow:none;transition:none;}',
    'body.na-onboarding #na-panel .na-head{background:transparent;border-bottom:none;padding:28px 24px 8px;}',
    'body.na-onboarding #na-panel .na-title{font-size:20px;}',
    'body.na-onboarding #na-panel .na-sub{font-size:13px;margin-top:6px;}',
    'body.na-onboarding #na-panel .na-head,body.na-onboarding #na-log,body.na-onboarding #na-panel .na-foot{',
    '  width:100%;max-width:720px;margin:0 auto;box-sizing:border-box;}',
    'body.na-onboarding #na-log{padding:16px 24px 24px;gap:14px;}',
    'body.na-onboarding .na-msg{font-size:15px;line-height:1.6;max-width:92%;padding:12px 16px;}',
    'body.na-onboarding #na-panel .na-foot{border-top:none;padding:12px 24px 28px;}',
    'body.na-onboarding #na-input{min-height:46px;font-size:15px;}',
    'body.na-onboarding .main{margin-right:0 !important;}',
    // The three choices under the opening, and any later chip: buttons that
    // send a plain sentence as the agent's own words.
    '.na-choices{display:flex;flex-wrap:wrap;gap:8px;align-self:flex-start;max-width:92%;}',
    '.na-chip{padding:10px 14px;border-radius:20px;border:1px solid var(--accent,#84CC16);',
    '  background:transparent;color:var(--accent,#84CC16);font-family:inherit;font-size:13.5px;',
    '  font-weight:600;cursor:pointer;line-height:1;}',
    '.na-chip:hover{background:var(--accent,#84CC16);color:#0b0f0a;}',
    '.na-chip.na-chip-ghost{border-color:var(--border2,rgba(255,255,255,0.14));color:var(--muted,rgba(240,244,255,0.45));}',
    '.na-chip.na-chip-ghost:hover{background:var(--surface2,#1E2540);color:var(--text,#F0F4FF);}',
    // A note: something the page did (an import landed), not something either
    // side said. Small, centred, no tail.
    '.na-note{align-self:center;font-size:12px;color:var(--muted,rgba(240,244,255,0.45));text-align:center;}',
    // A profile card: what the lookup found, each line plain, sources as links.
    '.na-card{align-self:flex-start;max-width:92%;border:1px solid var(--border2,rgba(240,244,255,0.14));border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:1.45;}',
    '.na-card-name{font-weight:700;font-size:14px;}',
    '.na-card-where{color:var(--muted,rgba(240,244,255,0.6));}',
    '.na-card-line{}',
    '.na-card-src{font-size:11px;color:var(--muted,rgba(240,244,255,0.45));}',
    '.na-card-src a{color:inherit;text-decoration:underline;text-underline-offset:2px;}',
    '.na-card-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;}',
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

// A row of chips. Each sends its sentence as the agent's own message and the
// row goes away, so a choice is made once. `opts.ghost` draws a quieter chip;
// `opts.onClick` replaces the send (the dashboard button).
function naChips(items, opts) {
  var log = document.getElementById('na-log');
  if (!log || !items || !items.length) return null;
  naClearChips();
  var row = document.createElement('div');
  row.className = 'na-choices';
  items.forEach(function (it) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'na-chip' + (it.ghost ? ' na-chip-ghost' : '');
    b.textContent = it.label;
    b.addEventListener('click', function () {
      row.remove();
      if (it.onClick) it.onClick(); else naSendText(it.text || it.label);
    });
    row.appendChild(b);
  });
  log.appendChild(row);
  naScroll();
  return row;
}
function naClearChips() {
  var log = document.getElementById('na-log');
  if (!log) return;
  Array.prototype.forEach.call(log.querySelectorAll('.na-choices'), function (n) { n.remove(); });
}
function naNote(text) {
  var log = document.getElementById('na-log');
  if (!log) return null;
  var d = document.createElement('div');
  d.className = 'na-note';
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
        if (d.then === 'reload_athletes') naRosterChanged();
        if (d.then === 'media_kit_built') naSay('assistant', 'Media kit built.');
      } else if (d.kind === 'reload_athletes') {
        // add_athlete saved the row on the server and said so to the model;
        // the page only has to catch up. Nothing is said here: the model's
        // sentence already reports what the tool returned.
        if (typeof loadAthletes === 'function') { try { await loadAthletes(); } catch (_) {} }
        naRosterChanged();
      } else if (d.kind === 'open_import') {
        // The same import window the Add Client page opens. It sits above the
        // takeover; the page watches for the athletes to land (naWatchImport).
        if (typeof impOpen === 'function') { NA.importClosedTold = false; impOpen(); naWatchImport(); }
        else naSay('assistant', 'The import window is not available on this page. Open Add Client and press Import from spreadsheet.');
      } else if (d.kind === 'profile_cards') {
        naProfileCards(Array.isArray(d.cards) ? d.cards : []);
      } else if (d.kind === 'finish_onboarding') {
        naFinishOnboarding(d.summary || '');
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

// ── Profile cards ────────────────────────────────────────────────────────────
// One card per candidate the lookup returned: everything it found, each
// field traceable to its source, and an Add button that sends the agent's
// own words ("Add Ann Lee as shown") so the model saves exactly the card.
// A correction is typed in plain words; the model applies it and saves.
function naFmtCount(n) {
  n = Number(n) || 0;
  if (!n) return '';
  if (n >= 1000000) return (Math.round(n / 100000) / 10) + 'M';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'K';
  return String(n);
}
function naDomain(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }
function naProfileCards(cards) {
  var log = document.getElementById('na-log');
  if (!log || !cards.length) return;
  cards.forEach(function (c) {
    var d = document.createElement('div');
    d.className = 'na-card';
    var where = c.athleteType === 'pro' ? [c.team, c.league, c.city].filter(Boolean).join(' · ') : (c.school || '');
    var line2 = [c.sport, c.position, c.year, c.jersey ? '#' + c.jersey : ''].filter(Boolean).join(' · ');
    var line3 = [c.hometown, [c.height, c.weight].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    var socials = [];
    if (c.instagramHandle) socials.push('IG @' + c.instagramHandle + (c.instagram ? ' ~' + naFmtCount(c.instagram) : ''));
    if (c.tiktokHandle) socials.push('TikTok @' + c.tiktokHandle + (c.tiktok ? ' ~' + naFmtCount(c.tiktok) : ''));
    var socialLine = socials.join(' · ') + ((c.instagram || c.tiktok) && c.followersAsOf ? ' (approx., checked ' + c.followersAsOf + ')' : '');
    var srcs = {};
    Object.keys(c.sources || {}).forEach(function (k) { var u = c.sources[k]; if (/^https?:/.test(u)) srcs[naDomain(u)] = u; });
    var levelLabel = c.level === 'high_school' ? 'High school' : (c.level === 'pro' ? 'Pro' : 'College');
    var html = '<div class="na-card-name"></div><div class="na-card-where"></div>';
    d.innerHTML = html;
    d.querySelector('.na-card-name').textContent = c.name + (c.confidence != null ? '  ·  ' + levelLabel + ', ' + c.confidence + '% match' : '  ·  ' + levelLabel);
    d.querySelector('.na-card-where').textContent = where;
    [line2, line3, socialLine, c.highlight].forEach(function (t) {
      if (!t) return;
      var p = document.createElement('div'); p.className = 'na-card-line'; p.textContent = t; d.appendChild(p);
    });
    var keys = Object.keys(srcs);
    if (keys.length) {
      var s = document.createElement('div'); s.className = 'na-card-src'; s.textContent = 'Sources: ';
      keys.forEach(function (k, i) {
        var a = document.createElement('a'); a.href = srcs[k]; a.target = '_blank'; a.rel = 'noopener'; a.textContent = k;
        if (i) s.appendChild(document.createTextNode(', '));
        s.appendChild(a);
      });
      d.appendChild(s);
    }
    var row = document.createElement('div'); row.className = 'na-card-actions';
    var add = document.createElement('button'); add.type = 'button'; add.className = 'na-chip';
    add.textContent = 'Add ' + (String(c.name || '').split(' ')[0] || 'them');
    add.addEventListener('click', function () { naSendText('Add ' + c.name + ' as shown.'); });
    row.appendChild(add);
    var no = document.createElement('button'); no.type = 'button'; no.className = 'na-chip na-chip-ghost';
    no.textContent = 'Not them';
    no.addEventListener('click', function () { naSendText('That is not the right ' + c.name + '.'); });
    row.appendChild(no);
    d.appendChild(row);
    log.appendChild(d);
  });
  naScroll();
}

// ── First login ──────────────────────────────────────────────────────────────
// The takeover is a body class and nothing else: the panel's own styles do
// the rest, and removing the class gives the ordinary docked assistant back.
function naEnterOnboarding() {
  NA.onboarding = true;
  document.body.classList.add('na-onboarding');
  var t = document.querySelector('#na-panel .na-title');
  var s = document.querySelector('#na-panel .na-sub');
  if (t) t.textContent = "Let's get you set up";
  if (s) s.textContent = 'A few minutes, and your first pitches are on the way. Ask me anything about NILDash at any point.';
  NA.open = true;
}

// Back to the ordinary assistant, closed. `toHome` opens the dashboard, where
// Home shows "Finding businesses" for the new athlete until the cards land.
function naLeaveOnboarding(toHome) {
  NA.onboarding = false;
  document.body.classList.remove('na-onboarding');
  if (NA.importWatch) { clearInterval(NA.importWatch); NA.importWatch = null; }
  var t = document.querySelector('#na-panel .na-title');
  var s = document.querySelector('#na-panel .na-sub');
  if (t) t.textContent = 'NILDash assistant';
  if (s) s.textContent = 'Ask about the product, or tell me what to do';
  naClose();
  // The ordinary assistant does not auto-open on top of the dashboard the
  // agent has just been handed; the tab is there when they want it.
  try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
  if (toHome) {
    try { if (typeof loadAthletes === 'function') loadAthletes(); } catch (_) {}
    try { if (typeof showView === 'function') showView('home', document.getElementById('homeNavBtn')); } catch (_) {}
  }
}

// The finish: the overnight plan in the assistant's words, then the dashboard.
// A button opens it at once; otherwise it opens by itself after a few seconds,
// long enough to read the summary.
function naFinishOnboarding(summary) {
  if (summary) naSay('assistant', summary);
  // The first-run flow is over for this agent: recorded on the account so it
  // is never shown as unfinished (the server records it too when it issues
  // the finish, so a tab closed on this summary still counts).
  fetch(naBase() + '/api/agent/onboarding-complete', { method: 'POST', credentials: 'include' }).catch(function () {});
  naChips([{ label: 'Open my dashboard', onClick: function () { naLeaveOnboarding(true); } }]);
  clearTimeout(NA._finishTimer);
  NA._finishTimer = setTimeout(function () { if (NA.onboarding) naLeaveOnboarding(true); }, 9000);
}

// The roster changed under the takeover (an athlete was added, by any path).
// Once there is one, the agent can leave whenever they like; the assistant
// keeps offering to add another until they say they are done.
function naRosterChanged() {
  var n = 0;
  try { n = (window.athletes || []).length; } catch (_) { n = 0; }
  NA.athleteCount = n;
  if (NA.onboarding && n > 0) naDashboardChip();
}
function naDashboardChip() {
  var log = document.getElementById('na-log');
  if (!log || log.querySelector('.na-dash')) return;
  var row = document.createElement('div');
  row.className = 'na-choices na-dash';
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'na-chip na-chip-ghost'; b.textContent = 'Open my dashboard';
  b.addEventListener('click', function () { naLeaveOnboarding(true); });
  row.appendChild(b);
  var foot = document.querySelector('#na-panel .na-foot');
  if (foot) foot.parentNode.insertBefore(row, foot); else log.appendChild(row);
}

// A spreadsheet import lands inside the app's own modal, which knows nothing
// about the assistant. So while the modal is open the roster is polled, and
// the first time it is not empty the modal is closed, the model is told (as a
// user turn, shown here as a note rather than as words the agent typed), and
// it finishes the flow.
function naWatchImport() {
  if (NA.importWatch) clearInterval(NA.importWatch);
  var started = Date.now();
  NA.importWatch = setInterval(async function () {
    if (!NA.onboarding || NA.importTold) { clearInterval(NA.importWatch); NA.importWatch = null; return; }
    if (Date.now() - started > 20 * 60000) { clearInterval(NA.importWatch); NA.importWatch = null; return; }
    var modal = document.getElementById('importModal');
    var open = !!(modal && modal.classList.contains('open'));
    var list = [];
    try {
      var r = await fetch(naBase() + '/api/athletes', { credentials: 'include' });
      list = r.ok ? await r.json() : [];
    } catch (_) { list = []; }
    if (!Array.isArray(list) || !list.length) {
      if (!open) {
        // Closed without importing. The model is told, once, so it can ask
        // what they want to do instead of waiting for an import that is not
        // coming. Said as a note here, not as words the agent typed.
        clearInterval(NA.importWatch); NA.importWatch = null;
        if (!NA.importClosedTold && NA.onboarding) {
          NA.importClosedTold = true;
          naNote('The import window was closed with nothing imported.');
          naSendText('(The import window was closed without importing anything.)', { silent: true });
        }
      }
      return;
    }
    clearInterval(NA.importWatch); NA.importWatch = null;
    NA.importTold = true;
    window.athletes = list;
    NA.athleteCount = list.length;
    if (open && typeof impClose === 'function') { try { impClose(false); } catch (_) {} }
    var names = list.slice(0, 6).map(function (a) { return a.name; }).filter(Boolean);
    naNote('Spreadsheet import landed: ' + list.length + ' athlete' + (list.length === 1 ? '' : 's') + '.');
    naSendText('(The spreadsheet import has landed: ' + list.length + ' athlete' + (list.length === 1 ? '' : 's') + ' on the roster now'
      + (names.length ? ': ' + names.join(', ') + (list.length > names.length ? ' and more' : '') : '') + '.)', { silent: true });
  }, 4000);
}

// The one greeting that opens the panel AFTER the response: the overnight plan
// owed to an agent who added an athlete and left before finishing. Every other
// open happens before the fetch (see naStart); this is deliberately the
// exception, and it is not a dismissal-counted auto-open.
function naRevealOwed() {
  if (!NA.open) naOpen();
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
  var eager = !NA.onboarding && autoOpenAllowed && NA.autoOpen && !sessionStorage.getItem(NA_SESSION_KEY);
  if (eager) {
    try { sessionStorage.setItem(NA_SESSION_KEY, '1'); } catch (_) {}
    naOpen();
  }
  // Always drawn, even if the panel is shut: an agent who opens the tab while the
  // greeting is still in flight finds the indicator rather than an empty log.
  var thinking = naRunning(NA.onboarding ? 'One moment' : 'Reading your dashboard');

  try {
    var r = await fetch(naBase() + '/api/assistant/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sessionId: NA.sessionId, mode: NA.onboarding ? 'onboarding' : undefined }),
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

    // THE SERVER DECIDES WHETHER THIS IS A FIRST LOGIN. The page asked because the
    // roster count said so; if the server disagrees (an athlete appeared from
    // another tab, or this is not an agent), the takeover comes down and the
    // ordinary assistant carries on.
    if (NA.onboarding && !j.onboarding) {
      naLeaveOnboarding(false);
    } else if (j.finishSummary) {
      // They added an athlete and left before finishing. The overnight plan
      // they never saw is this greeting, and it is shown even when the panel
      // would otherwise stay shut: it is the one message they are owed.
      naRevealOwed();
    } else if (NA.onboarding && j.onboarding) {
      naChips((j.choices || []).map(function (c) { return { label: c.label, text: c.text }; }));
      var i2 = document.getElementById('na-input');
      if (i2 && window.innerWidth > NA_MOBILE) i2.focus();
    }

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
  // A first login must never be a dead end: if the assistant cannot start, the
  // ordinary Add Client form is one click away.
  if (NA.onboarding) {
    var alt = document.createElement('button');
    alt.type = 'button'; alt.className = 'na-btn na-ghost'; alt.style.cssText = 'margin-top:10px;margin-left:8px';
    alt.textContent = 'Add an athlete the usual way instead';
    alt.addEventListener('click', function () {
      naLeaveOnboarding(false);
      try { if (typeof showView === 'function') showView('add-athlete', document.getElementById('addAthleteNavBtn')); } catch (_) {}
    });
    d.appendChild(alt);
  }
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
  var input = document.getElementById('na-input');
  var text = input ? input.value.trim() : '';
  if (!text) return;
  if (input) input.value = '';
  await naSendText(text);
}

// One turn. `opts.silent` sends the text without drawing it as the agent's
// bubble (the page speaking for an import that landed).
async function naSendText(text, opts) {
  if (NA.busy || !text) return;
  NA.replied = true;
  naClearChips();
  if (!(opts && opts.silent)) naSay('user', text);
  NA.busy = true;
  // THE INDICATOR SAYS WHAT IS SLOW. On the lookup path a turn may run the
  // same web search the Add Client button runs, 10 to 30 seconds, and dots
  // that say "one moment" for that long read as a hang. The page cannot see
  // inside the turn, so it goes by the path the agent chose: once they have
  // asked to be looked up, a turn still running after a couple of seconds is
  // almost certainly the search, and the line says so.
  if (NA.onboarding && /\blook(?:ing)? (?:them|her|him|it|the athletes?|(?:my )?athletes?)? ?up\b/i.test(text)) NA.lookupPath = true;
  var thinking = naRunning(NA.onboarding ? 'One moment' : 'Thinking');
  var searching = (NA.onboarding && NA.lookupPath) ? setTimeout(function () {
    var w = thinking && thinking.querySelector('.na-what');
    if (w && thinking.parentNode) w.textContent = 'Searching, this takes about 20 seconds';
  }, 2500) : null;
  try {
    var r = await fetch(naBase() + '/api/assistant/message', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ sessionId: NA.sessionId, text: text, mode: NA.onboarding ? 'onboarding' : undefined }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (thinking) thinking.remove();
    if (!r.ok) { naSay('assistant', (j && j.error) || 'Something went wrong. Try again?'); return; }
    NA.sessionId = j.sessionId || NA.sessionId;
    if (j.reply) naSay('assistant', j.reply);
    (j.confirms || []).forEach(naConfirm);
    if (j.directives && j.directives.length) await naPerform(j.directives);
    // The roster count rides on every onboarding reply, so the dashboard
    // button appears as soon as there is a roster to open.
    if (NA.onboarding && typeof j.athletes === 'number' && j.athletes > 0) { NA.athleteCount = j.athletes; naDashboardChip(); }
  } catch (e) {
    if (thinking) thinking.remove();
    naSay('assistant', 'Something went wrong. Try again?');
  } finally {
    if (searching) clearTimeout(searching);
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
// opts.onboarding: the page has confirmed (from /api/auth/me) that this is an
// agent with no athletes. The takeover goes up BEFORE the request so nothing of
// the empty dashboard shows; the server confirms or the takeover comes down.
function naInit(opts) {
  naBuild();
  NA.autoOpen = !(opts && opts.autoOpen === false);
  if (opts && opts.onboarding === true) naEnterOnboarding();
  naStart(true);
}

window.nilAssistant = {
  init: naInit, open: naOpen, close: naClose, dismiss: naDismiss,
  send: naSend, sendText: naSendText, toggle: naToggle, perform: naPerform,
  rosterChanged: naRosterChanged, leaveOnboarding: naLeaveOnboarding,
  _state: NA, _unsavedOutreach: naUnsavedOutreach,
  // Render helpers, exposed so the shell can be driven into each visual state
  // without a server. They only draw; nothing here performs an action.
  _say: naSay, _running: naRunning, _confirm: naConfirm, _scanLabel: naScanLabel,
  _chips: naChips, _note: naNote, _enterOnboarding: naEnterOnboarding, _finish: naFinishOnboarding,
};

// Deliberately NOT auto-initialised. index.html calls nilAssistant.init() from
// bootApp(), which only runs after /api/auth/me confirms a session.
