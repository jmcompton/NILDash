(function () {
  // NILDash Assistant. Phase 1: first-client onboarding only.
  // Replaces the old free-text help widget. No AI calls here; every prompt is
  // hard-coded. The only cost is the Deal Scan in step 7, a normal scan.

  var ACCENT = '#84CC16';
  var sparkSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="' + ACCENT + '"><path d="M12 2l1.9 5.1L19 9l-5.1 1.9L12 16l-1.9-5.1L5 9l5.1-1.9z"/></svg>';

  // Same sport list the Add Client form uses (value, label).
  var SPORTS = [
    ['baseball', 'Baseball'], ['basketball', 'Basketball'], ['cheer', 'Cheer'], ['cross country', 'Cross Country'],
    ['field hockey', 'Field Hockey'], ['football', 'Football'], ['golf', 'Golf'], ['gymnastics', 'Gymnastics'],
    ['ice hockey', 'Ice Hockey'], ['lacrosse', 'Lacrosse'], ['mens golf', "Men's Golf"], ['mens ice hockey', "Men's Ice Hockey"],
    ['rowing', 'Rowing'], ['soccer', 'Soccer'], ['softball', 'Softball'], ['swimming', 'Swimming'], ['tennis', 'Tennis'],
    ['track', 'Track & Field'], ['volleyball', 'Volleyball'], ['water polo', 'Water Polo'],
    ['womens basketball', "Women's Basketball"], ['womens golf', "Women's Golf"], ['womens ice hockey', "Women's Ice Hockey"],
    ['womens soccer', "Women's Soccer"], ['wrestling', 'Wrestling']
  ];

  // ---- Floating assistant button (same corner as the old help button) ----
  var btn = document.createElement('button');
  btn.id = 'assistant-btn';
  btn.setAttribute('aria-label', 'Open NILDash Assistant');
  btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M9.5 9.5l.01 0M14.5 9.5l.01 0"/></svg>';
  btn.style.cssText = 'position:fixed;bottom:24px;right:24px;width:52px;height:52px;border-radius:50%;background:' + ACCENT + ';color:#0A0E1A;border:none;cursor:pointer;z-index:500;box-shadow:0 4px 16px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;transition:transform 0.15s';
  btn.onmouseenter = function () { btn.style.transform = 'scale(1.06)'; };
  btn.onmouseleave = function () { btn.style.transform = ''; };
  document.body.appendChild(btn);

  // ---- Panel anchored to the same corner ----
  var panel = document.createElement('div');
  panel.id = 'assistant-panel';
  panel.style.cssText = 'position:fixed;bottom:88px;right:24px;width:380px;max-width:calc(100vw - 48px);max-height:min(560px, calc(100vh - 120px));background:#141929;border:1px solid rgba(255,255,255,0.12);border-radius:14px;z-index:501;display:none;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,0.5);overflow:hidden;font-family:"DM Sans",Inter,system-ui,sans-serif';
  panel.innerHTML =
    '<div style="padding:15px 18px;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">' +
      '<div style="display:flex;align-items:center;gap:9px">' +
        '<div style="width:26px;height:26px;border-radius:7px;background:rgba(132,204,22,0.16);display:flex;align-items:center;justify-content:center">' + sparkSvg + '</div>' +
        '<div style="font-size:13px;font-weight:700;color:#F0F4FF">NILDash Assistant</div>' +
      '</div>' +
      '<button id="assistant-close" aria-label="Close" style="background:transparent;border:none;color:rgba(240,244,255,0.45);font-size:20px;cursor:pointer;line-height:1">×</button>' +
    '</div>' +
    '<div id="assistant-body" style="flex:1;overflow-y:auto;padding:18px;display:flex;flex-direction:column;gap:14px"></div>';
  document.body.appendChild(panel);

  var body = panel.querySelector('#assistant-body');
  var mode = null;               // null until content chosen: 'onboarding' | 'simple' | 'done'
  var draft = { name: '', sport: '', school: '', instagramHandle: '' };

  // ---- Small style + markup helpers ----
  var S_INPUT = 'width:100%;padding:10px 12px;background:#1E2540;border:1px solid rgba(255,255,255,0.12);border-radius:9px;color:#F0F4FF;font-size:13px;outline:none;font-family:inherit;box-sizing:border-box';
  var S_PRIMARY = 'padding:10px 16px;background:' + ACCENT + ';color:#0A0E1A;border:none;border-radius:9px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
  var S_GHOST = 'padding:10px 16px;background:transparent;border:1px solid rgba(255,255,255,0.14);color:rgba(240,244,255,0.7);border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit';
  var S_LINK = 'background:none;border:none;color:' + ACCENT + ';font-size:12px;cursor:pointer;text-decoration:underline;padding:0;font-family:inherit';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function bubble(text) {
    return '<div style="background:rgba(132,204,22,0.08);border:1px solid rgba(132,204,22,0.18);border-radius:12px;padding:12px 14px;font-size:13px;color:#F0F4FF;line-height:1.6">' + text + '</div>';
  }
  function setBody(html) { body.innerHTML = html; body.scrollTop = 0; }
  function openPanel() { panel.style.display = 'flex'; }
  function closePanel() { panel.style.display = 'none'; }

  // ---- Onboarding flow ----
  function startOnboarding() {
    mode = 'onboarding';
    draft = { name: '', sport: '', school: '', instagramHandle: '' };
    renderName();
  }

  function renderName() {
    setBody(
      bubble("Let's get your first client in. Takes about a minute.") +
      bubble("What's your athlete's name?") +
      '<input id="ob-name" type="text" value="' + esc(draft.name) + '" placeholder="e.g. Paige Briggs" style="' + S_INPUT + '">' +
      '<div style="display:flex;justify-content:flex-end"><button id="ob-name-next" style="' + S_PRIMARY + '">Next</button></div>'
    );
    var input = body.querySelector('#ob-name');
    input.focus();
    var go = function () {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      draft.name = v;
      renderSport();
    };
    body.querySelector('#ob-name-next').onclick = go;
    input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  function renderSport() {
    var buttons = SPORTS.map(function (s) {
      return '<button class="ob-sport" data-v="' + esc(s[0]) + '" style="padding:7px 12px;background:#1E2540;border:1px solid rgba(255,255,255,0.12);color:#F0F4FF;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit">' + esc(s[1]) + '</button>';
    }).join('');
    setBody(
      bubble('Which sport does ' + esc(draft.name) + ' play?') +
      '<div style="display:flex;flex-wrap:wrap;gap:8px">' + buttons + '</div>'
    );
    body.querySelectorAll('.ob-sport').forEach(function (b) {
      b.onclick = function () { draft.sport = b.getAttribute('data-v'); renderSchool(); };
    });
  }

  function renderSchool() {
    // Add Client's school field is a plain text input (no autocomplete), so this mirrors it.
    setBody(
      bubble('Which school? You can leave this blank if you are not sure.') +
      '<input id="ob-school" type="text" value="' + esc(draft.school) + '" placeholder="e.g. Duke University" style="' + S_INPUT + '">' +
      '<div style="display:flex;justify-content:flex-end"><button id="ob-school-next" style="' + S_PRIMARY + '">Next</button></div>'
    );
    var input = body.querySelector('#ob-school');
    input.focus();
    var go = function () { draft.school = input.value.trim(); renderInstagram(); };
    body.querySelector('#ob-school-next').onclick = go;
    input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  function renderInstagram() {
    setBody(
      bubble("Last one. What's their Instagram handle?") +
      '<input id="ob-ig" type="text" value="' + esc(draft.instagramHandle) + '" placeholder="@handle" style="' + S_INPUT + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<button id="ob-ig-skip" style="' + S_LINK + '">Skip</button>' +
        '<button id="ob-ig-next" style="' + S_PRIMARY + '">Create client</button>' +
      '</div>'
    );
    var input = body.querySelector('#ob-ig');
    input.focus();
    var go = function () {
      draft.instagramHandle = input.value.trim().replace(/^@+/, '').toLowerCase();
      createAthlete();
    };
    body.querySelector('#ob-ig-next').onclick = go;
    body.querySelector('#ob-ig-skip').onclick = function () { draft.instagramHandle = ''; createAthlete(); };
    input.onkeydown = function (e) { if (e.key === 'Enter') go(); };
  }

  function loadingBubble(text) {
    return '<div style="display:flex;align-items:center;gap:10px;background:rgba(255,255,255,0.05);border-radius:12px;padding:12px 14px;font-size:13px;color:rgba(240,244,255,0.7);line-height:1.5">' +
      '<span style="width:14px;height:14px;border:2px solid rgba(132,204,22,0.3);border-top-color:' + ACCENT + ';border-radius:50%;display:inline-block;animation:spin 0.7s linear infinite;flex-shrink:0"></span>' +
      '<span>' + text + '</span></div>';
  }

  async function createAthlete() {
    setBody(loadingBubble('Creating ' + esc(draft.name) + "'s profile…"));
    try {
      // SAME endpoint the Add Client form posts to. No parallel creation path.
      var r = await fetch('/api/athletes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({
          name: draft.name,
          sport: draft.sport,
          school: draft.school,
          instagramHandle: draft.instagramHandle,
          igStatsSource: 'manual'
        })
      });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) { return renderCreateError(data && data.error ? data.error : ('Request failed (' + r.status + ')')); }
      // Keep the main app roster in sync so the new client shows in the bar/roster.
      if (window.loadAthletes) { try { await window.loadAthletes(); } catch (e) {} }
      runScan(data.id, data.name || draft.name);
    } catch (e) {
      renderCreateError(e.message || 'Network error');
    }
  }

  function renderCreateError(msg) {
    // Do not trap the user, and do not mark onboarding complete on a failed create.
    setBody(
      bubble("I couldn't create that client: " + esc(msg) + '.') +
      '<div style="display:flex;gap:10px;align-items:center">' +
        '<button id="ob-retry" style="' + S_GHOST + '">Try again</button>' +
        '<button id="ob-fullform" style="' + S_LINK + '">Use the full Add Client form</button>' +
      '</div>'
    );
    body.querySelector('#ob-retry').onclick = function () { renderInstagram(); };
    body.querySelector('#ob-fullform').onclick = function () {
      closePanel();
      if (window.showView) window.showView('add-athlete');
    };
  }

  function markComplete() {
    // Fire-and-forget; a logging failure must not block the UI. Also stops this
    // session from re-auto-opening.
    mode = 'done';
    try { fetch('/api/agent/onboarding-complete', { method: 'POST', credentials: 'include' }); } catch (e) {}
  }

  async function runScan(athleteId, name) {
    setBody(loadingBubble('Scanning ' + esc(name) + "'s local market for brand fits. This takes a moment…"));
    var opportunities = [];
    try {
      var r = await fetch('/api/agent/deal-scan', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ athleteId: athleteId, lane: 'local', exclude_brands: [] })
      });
      var data = await r.json().catch(function () { return {}; });
      if (r.ok && data && Array.isArray(data.opportunities)) opportunities = data.opportunities;
    } catch (e) { /* fall through to the no-results state */ }

    markComplete(); // onboarding is complete whether or not the scan found anything

    if (opportunities.length) renderTopResult(athleteId, name, opportunities[0]);
    else renderNoResults(athleteId, name);
  }

  function renderTopResult(athleteId, name, opp) {
    var bizName = opp.brand || opp.name || opp.business || 'A local business';
    var why = opp.evidence || opp.whyFits || opp.reason || opp.pitch || opp.rationale || '';
    setBody(
      bubble('Done. Here is a strong local fit for ' + esc(name) + ':') +
      '<div style="background:#1E2540;border:1px solid rgba(132,204,22,0.25);border-radius:12px;padding:14px">' +
        '<div style="font-size:15px;font-weight:700;color:#F0F4FF;margin-bottom:6px">' + esc(bizName) + '</div>' +
        (why ? '<div style="font-size:12px;color:rgba(240,244,255,0.7);line-height:1.6">' + esc(why) + '</div>' : '') +
      '</div>' +
      '<button id="ob-open-deals" style="' + S_PRIMARY + ';width:100%">See all deals for ' + esc(name) + '</button>'
    );
    body.querySelector('#ob-open-deals').onclick = function () { goToDeals(athleteId); };
  }

  function renderNoResults(athleteId, name) {
    setBody(
      bubble("The scan didn't surface a local match right now, which happens in smaller markets. " + esc(name) + ' is on your roster, and you can run a full Deal Scan any time.') +
      '<button id="ob-open-deals" style="' + S_PRIMARY + ';width:100%">Open Deal Scan</button>'
    );
    body.querySelector('#ob-open-deals').onclick = function () { goToDeals(athleteId); };
  }

  function goToDeals(athleteId) {
    closePanel();
    if (window.selectAthlete) { try { window.selectAthlete(athleteId); } catch (e) {} }
    if (window.showView) window.showView('deals');
  }

  // ---- Agents who already have clients (phase 2 will fill this in) ----
  function renderAlreadyHasClients() {
    mode = 'simple';
    setBody(
      bubble("You're all set. I'll be able to help with your clients and answer questions here soon.") +
      '<div style="display:flex;justify-content:flex-end"><button id="ob-simple-close" style="' + S_GHOST + '">Close</button></div>'
    );
    body.querySelector('#ob-simple-close').onclick = closePanel;
  }

  // ---- Decide what the panel shows the first time it opens ----
  async function ensureContent() {
    if (mode) return; // a flow is already in progress or finished this session
    setBody(loadingBubble('One sec…'));
    try {
      var r = await fetch('/api/athletes', { credentials: 'include' });
      var list = r.ok ? await r.json() : null;
      if (Array.isArray(list) && list.length === 0) startOnboarding();
      else renderAlreadyHasClients();
    } catch (e) {
      renderAlreadyHasClients();
    }
  }

  // ---- Wiring ----
  panel.querySelector('#assistant-close').onclick = closePanel;
  btn.onclick = function () {
    if (panel.style.display === 'flex') { closePanel(); return; }
    openPanel();
    ensureContent();
  };

  // Auto-open for a brand-new agent: zero athletes AND onboarding not completed.
  setTimeout(function autoOpen() {
    if (mode) return;
    fetch('/api/athletes', { credentials: 'include' }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (list) {
      if (!Array.isArray(list) || list.length > 0) return; // has clients or not logged in -> no auto-open
      fetch('/api/auth/me', { credentials: 'include' }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (me) {
        if (me && me.onboardingCompleted) return;
        openPanel();
        startOnboarding();
      }).catch(function () {});
    }).catch(function () {});
  }, 1600);

  // Spinner keyframes (scoped id so we don't collide with app CSS).
  if (!document.getElementById('assistant-kf')) {
    var st = document.createElement('style');
    st.id = 'assistant-kf';
    st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
  }
})();
