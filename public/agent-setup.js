/* ── THE FIRST SESSION: THREE STEPS BEFORE HOME (AGENT_SETUP_ON) ──────────
 *
 * services/agentSetup decides who sees this and where they are; this file
 * only draws it. One screen per step, plain words, "2 of 3 done", and no skip
 * button, because nothing on Home works without any of the three:
 *
 *   1  Connect your email      Gmail or Outlook, back here after the provider
 *   2  Your business address   the same save as Settings
 *   3  Add your athletes       the existing add-athlete form and roster
 *                              import, or the assistant as a helper panel
 *
 * The state is read from the server every time, so leaving and coming back
 * (closing the tab, signing out, an OAuth round trip) resumes at the right
 * step. While the agent is in the add-athlete form or the import, the screen
 * steps aside and checks back every few seconds; going anywhere else brings
 * it back until the athlete exists.
 */
(function () {
  'use strict';
  // shownStep: the step on screen now. The screen is rebuilt only when the
  // step changes, never on a repeat draw of the same one (see draw()).
  var S = { state: null, hidden: false, poll: null, el: null, shownStep: null };
  var esc = function (x) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  function css() {
    if (document.getElementById('as-style')) return;
    var st = document.createElement('style');
    st.id = 'as-style';
    st.textContent = [
      '#agentSetup{position:fixed;inset:0;z-index:9000;background:#0A0A0A;color:#F0EDE6;overflow-y:auto;display:none;padding:32px 16px}',
      '#agentSetup .as-box{max-width:520px;margin:0 auto}',
      '#agentSetup .as-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px;gap:12px}',
      '#agentSetup .as-progress{font-size:13px;color:rgba(240,237,230,0.6)}',
      '#agentSetup .as-dots{display:flex;gap:6px;margin-top:8px}',
      '#agentSetup .as-dot{height:6px;flex:1;border-radius:3px;background:rgba(240,237,230,0.12)}',
      '#agentSetup .as-dot.done{background:#C8F135}',
      '#agentSetup .as-dot.now{background:rgba(200,241,53,0.45)}',
      '#agentSetup h1{font-size:24px;margin:6px 0 10px}',
      '#agentSetup p{font-size:15px;line-height:1.55;color:rgba(240,237,230,0.75);margin:0 0 20px}',
      '#agentSetup .as-btn{display:block;width:100%;text-align:center;padding:14px 18px;border-radius:40px;font-weight:700;font-size:15px;margin-bottom:12px;cursor:pointer;border:1px solid rgba(240,237,230,0.25);background:transparent;color:#F0EDE6}',
      '#agentSetup .as-btn.go{background:#C8F135;color:#000;border-color:#C8F135}',
      '#agentSetup label{display:block;font-size:12px;color:rgba(240,237,230,0.6);margin:12px 0 6px}',
      '#agentSetup input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:8px;border:1px solid rgba(240,237,230,0.18);background:#141414;color:#F0EDE6;font-size:15px}',
      '#agentSetup .as-row{display:flex;gap:10px}#agentSetup .as-row>div{flex:1;min-width:0}',
      '#agentSetup .as-err{color:#ef4444;font-size:13px;margin:10px 0}',
      '#agentSetup .as-note{font-size:13px;color:rgba(240,237,230,0.5);margin-top:18px;line-height:1.5}',
      '#agentSetup .as-link{color:rgba(240,237,230,0.6);font-size:13px;background:none;border:none;cursor:pointer;text-decoration:underline;padding:0}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function root() {
    if (S.el) return S.el;
    css();
    S.el = document.createElement('div');
    S.el.id = 'agentSetup';
    S.el.setAttribute('role', 'dialog');
    S.el.setAttribute('aria-modal', 'true');
    S.el.setAttribute('aria-label', 'Set up NILDash');
    document.body.appendChild(S.el);
    return S.el;
  }

  function stepBody(st) {
    var k = st.current;
    if (k === 'mailbox') {
      return '<h1>Connect your email</h1>'
        + '<p>Your pitches go out from your own inbox, so replies come straight to you. Pick the one you use for work.</p>'
        + '<div class="as-err" id="as-mbx-note"' + (st.mailboxCannotSend ? '' : ' style="display:none"') + '>Your inbox is connected, but we did not get permission to send from it. Connect it again and allow sending.</div>'
        + '<button class="as-btn go" onclick="agentSetup.connect(\'gmail\')">Connect Gmail</button>'
        + '<button class="as-btn" onclick="agentSetup.connect(\'outlook\')">Connect Outlook</button>'
        + '<div class="as-note">You will go to Google or Microsoft to say yes, then come straight back here. We only send what you approve.</div>';
    }
    if (k === 'address') {
      return '<h1>Your business address</h1>'
        + '<p>The law requires a postal address at the bottom of every pitch email. It is yours, not ours.</p>'
        + '<label for="as-street">Street</label><input id="as-street" autocomplete="street-address">'
        + '<div class="as-row"><div><label for="as-city">City</label><input id="as-city" autocomplete="address-level2"></div>'
        + '<div><label for="as-state">State</label><input id="as-state" autocomplete="address-level1" maxlength="2" placeholder="AL" style="text-transform:uppercase"></div>'
        + '<div><label for="as-zip">ZIP</label><input id="as-zip" autocomplete="postal-code" maxlength="10" inputmode="numeric"></div></div>'
        + '<div class="as-err" id="as-err" style="display:none"></div>'
        + '<button class="as-btn go" style="margin-top:20px" onclick="agentSetup.saveAddress(this)">Save and continue</button>';
    }
    return '<h1>Add your athletes</h1>'
      + '<p>Every night we find businesses for each athlete on your roster. Add one now, or bring in your whole roster from a spreadsheet.</p>'
      + '<button class="as-btn go" onclick="agentSetup.addAthlete()">Add an athlete</button>'
      + '<button class="as-btn" onclick="agentSetup.importRoster()">Import a roster</button>'
      + '<button class="as-btn" onclick="agentSetup.askAssistant()">Have the assistant look them up</button>';
  }

  function dotsHtml(st) {
    return (st.steps || []).map(function (s) {
      return '<div class="as-dot' + (s.done ? ' done' : (s.key === st.current ? ' now' : '')) + '" title="' + esc(s.label) + '"></div>';
    }).join('');
  }

  // NEVER OVER WHAT THEY TYPED. The same step can be drawn twice in a row --
  // boot draws it, and coming back from Google or Microsoft asks the server
  // again a moment later -- and rebuilding the screen the second time wiped
  // an address being typed, so Save said every field was missing. The screen
  // is rebuilt only when the STEP changes; a repeat draw of the step on
  // screen updates the progress line and nothing else.
  function draw(st) {
    var el = root();
    var same = S.shownStep === st.current && !!el.firstChild;
    if (same) {
      var pr = document.getElementById('as-progress'); if (pr) pr.textContent = st.progress || '';
      var dt = document.getElementById('as-dots'); if (dt) dt.innerHTML = dotsHtml(st);
      var mn = document.getElementById('as-mbx-note'); if (mn) mn.style.display = st.mailboxCannotSend ? 'block' : 'none';
    } else {
      el.innerHTML = '<div class="as-box">'
        + '<div class="as-top"><div style="flex:1"><div class="as-progress" id="as-progress">' + esc(st.progress || '') + '</div><div class="as-dots" id="as-dots">' + dotsHtml(st) + '</div></div>'
        + '<img src="/images/nildash-logo-header.png" alt="NILDash" style="height:26px;width:auto"></div>'
        + stepBody(st)
        + '<div class="as-note">You can leave and come back; we will pick up where you left off. '
        + '<button class="as-link" onclick="doLogout()">Sign out</button></div>'
        + '</div>';
      S.shownStep = st.current;
      if (st.current === 'address') {
        // A field they have typed in (or cleared) is theirs from then on.
        ['as-street', 'as-city', 'as-state', 'as-zip'].forEach(function (id) {
          var i = document.getElementById(id);
          if (i) i.addEventListener('input', function () { i.setAttribute('data-touched', '1'); });
        });
        prefillAddress();
      }
    }
    el.style.display = 'block';
    S.hidden = false;
    stopPoll();
  }

  // What is already on the account, in the fields they have not touched.
  // Arrives whenever the server answers, so it checks each field at that
  // moment: never one they typed in, cleared, or that already has a value.
  function prefillAddress() {
    fetch('/api/agent/business-address').then(function (r) { return r.json(); }).then(function (d) {
      if (!d) return;
      [['as-street', d.street], ['as-city', d.city], ['as-state', d.state], ['as-zip', d.zip]].forEach(function (p) {
        var i = document.getElementById(p[0]);
        if (i && p[1] && !i.value && i.getAttribute('data-touched') !== '1' && document.activeElement !== i) i.value = p[1];
      });
    }).catch(function () {});
  }

  function stopPoll() { if (S.poll) { clearInterval(S.poll); S.poll = null; } }
  // Step aside for the app's own screens (step 3), and check back.
  function stepAside() {
    if (S.el) S.el.style.display = 'none';
    S.hidden = true;
    stopPoll();
    S.poll = setInterval(function () { refresh({ quiet: true }); }, 5000);
  }

  function finish() {
    if (S.offering) return;
    stopPoll();
    S.shownStep = null;
    var was = !!(S.el && (S.el.style.display === 'block' || S.hidden));
    S.hidden = false;
    var home = function () {
      S.offering = false;
      if (S.el) S.el.style.display = 'none';
      if (!was) return;
      try { if (typeof showToast === 'function') showToast("You're set up. Your first businesses come tonight."); } catch (e) {}
      try { if (typeof showView === 'function') showView('home', document.getElementById('homeNavBtn')); if (typeof loadAgentHome === 'function') loadAgentHome(); } catch (e) {}
    };
    if (!was) { home(); return; }
    offerAutoSend(home);
  }

  // ── THE LAST SCREEN: SEND MY PITCHES EVERY MORNING (services/autoSend) ──
  // ON BY DEFAULT, AND THEY SEE IT. A ticked box they can untick, never a
  // silent switch: the emails go out from their own inbox under their name.
  // Shown only when it is available, not already on, and ready (mailbox and
  // address, which the steps before this just did). Any failure goes Home.
  function offerAutoSend(done) {
    S.offering = true;
    fetch('/api/agent/settings/auto-send', { credentials: 'include' }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.available || d.on || !d.ready) { done(); return; }
      var el = root();
      el.innerHTML = '<div class="as-box">'
        + '<div class="as-top"><div style="flex:1"><div class="as-progress">Last step</div></div>'
        + '<img src="/images/nildash-logo-header.png" alt="NILDash" style="height:26px;width:auto"></div>'
        + '<h1>Send my pitches every morning</h1>'
        + '<p>Every weekday at 9:00 am Central, NILDash sends that morning\'s email pitches for your athletes from your inbox. You don\'t have to log in. You get one short email listing what went out, and replies come straight to you.</p>'
        + '<label style="display:flex;gap:10px;align-items:center;font-size:15px;margin:18px 0;cursor:pointer"><input type="checkbox" id="as-auto" checked style="width:20px;height:20px"> Yes, send them for me</label>'
        + '<button class="as-btn go" onclick="agentSetup.autoContinue(this)">Continue</button>'
        + '<div class="as-note">You can change this any time in Settings.</div>'
        + '</div>';
      el.style.display = 'block';
      S.autoDone = done;
    }).catch(function () { done(); });
  }

  // Still in one of the app's own screens for step 3: the add-athlete form,
  // the roster import, or the assistant's panel.
  function busyAdding() {
    var v = document.getElementById('view-add-athlete');
    var imp = document.getElementById('importModal');
    return !!((v && v.offsetParent !== null) || (imp && imp.classList.contains('open')) || document.body.classList.contains('na-open'));
  }

  // quiet: a background check while the agent is adding. Done -> Home; still
  // adding -> leave them be; wandered off without an athlete -> back here.
  function refresh(opts) {
    opts = opts || {};
    return fetch('/api/agent/setup').then(function (r) { return r.json(); }).then(function (st) {
      S.state = st;
      if (!st || !st.required) { finish(); return st; }
      if (opts.quiet && S.hidden && st.current === 'athlete' && busyAdding()) return st;
      draw(st);
      return st;
    }).catch(function () { return null; });
  }

  // The boot hook: index.html bootApp has already asked; draw it if needed.
  function start(st) {
    S.state = st;
    if (st && st.required) draw(st);
  }

  window.agentSetup = {
    start: start,
    refresh: refresh,
    active: function () { return !!(S.state && S.state.required); },
    on: function () { return !!(S.state && S.state.on); },
    connect: function (provider) {
      // returnTo carries a # so the page sees the "connected" marker and comes
      // back here (email.js handleEmailOAuthRedirect -> agentSetupRefresh).
      window.location.href = '/api/email/oauth/' + (provider === 'outlook' ? 'outlook' : 'gmail') + '?returnTo=' + encodeURIComponent('/#setup');
    },
    saveAddress: function (btn) {
      var v = function (id) { var i = document.getElementById(id); return i ? i.value.trim() : ''; };
      var err = document.getElementById('as-err');
      btn.disabled = true; btn.textContent = 'Saving...';
      fetch('/api/agent/business-address', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ street: v('as-street'), city: v('as-city'), state: v('as-state'), zip: v('as-zip') }) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (x) {
          if (!x.ok) { err.textContent = (x.d && x.d.error) || 'That address could not be saved.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Save and continue'; return; }
          refresh();
        }).catch(function () { err.textContent = 'Could not reach the server. Try again.'; err.style.display = 'block'; btn.disabled = false; btn.textContent = 'Save and continue'; });
    },
    autoContinue: function (btn) {
      var box = document.getElementById('as-auto');
      var go = function () { var d = S.autoDone; S.autoDone = null; if (d) d(); };
      if (btn) btn.disabled = true;
      if (!box || !box.checked) { go(); return; }
      fetch('/api/agent/settings/auto-send', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: true }) })
        .then(go, go);
    },
    addAthlete: function () {
      stepAside();
      try { if (typeof resetAthleteForm === 'function') resetAthleteForm(); } catch (e) {}
      if (typeof showView === 'function') showView('add-athlete', document.getElementById('addAthleteNavBtn'));
    },
    importRoster: function () {
      stepAside();
      if (typeof impOpen === 'function') impOpen();
    },
    askAssistant: function () {
      stepAside();
      try { if (window.nilAssistant && window.nilAssistant.open) window.nilAssistant.open(); } catch (e) {}
    },
  };
  // email.js calls this when the provider sends them back to #setup.
  window.agentSetupRefresh = function () { return refresh(); };

  // ANYWHERE ELSE BRINGS IT BACK. While the screen has stepped aside for the
  // add-athlete form, any other view (the add form's own "go to roster" on
  // success included) asks the server again: done -> Home, not done -> back.
  var _sv = window.showView;
  if (typeof _sv === 'function') {
    window.showView = function (id) {
      var r = _sv.apply(this, arguments);
      try { if (S.hidden && S.state && S.state.required && id !== 'add-athlete') refresh(); } catch (e) {}
      return r;
    };
  }
})();
