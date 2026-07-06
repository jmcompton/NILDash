/* NILDash onboarding helpers: Getting Started checklist (Part C),
 * teaching empty states (Part D), first-visit tooltips + help popovers (Part E).
 *
 * Self-contained. Loaded after the main app script, it wraps window.showView so
 * every view switch can render the right empty state, tooltip, and help icon.
 * Everything degrades quietly: any failure here must never block a tool. All UI
 * copy is plain and direct, no em dashes. */
(function () {
  'use strict';
  var API = window.location.origin;

  // ── Onboarding state cache (from /api/onboarding) ─────────────────────────
  var _state = null;
  var _statePromise = null;
  function getState(force) {
    if (_state && !force) return Promise.resolve(_state);
    if (_statePromise && !force) return _statePromise;
    _statePromise = fetch(API + '/api/onboarding', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) { _state = s; _statePromise = null; return s; })
      .catch(function () { _statePromise = null; return null; });
    return _statePromise;
  }

  // currentUser is a top-level `let` in the main script, which lives in the
  // shared global lexical environment (reachable by bare name from this classic
  // script) but is NOT a property of window. Read it defensively.
  function curUser() {
    try { return (typeof currentUser !== 'undefined') ? currentUser : (window.currentUser || null); }
    catch (e) { return window.currentUser || null; }
  }
  function isAgent() {
    var u = curUser();
    return !!(u && (u.role === 'agent' || u.role === 'admin'));
  }

  // ── Tool config: copy is used verbatim by both the empty state and the "?" ──
  var TOOLS = {
    deals: {
      name: 'Deal Scan', needs: 'athlete', primary: '#deals-run-btn',
      text: 'Deal Scan finds brands worth pitching for each athlete: local businesses, social-first brands, and top NIL spenders. Pick an athlete to run your first scan.',
      btn: 'Run a Deal Scan',
      tip: 'Pick an athlete, then run your first scan.',
    },
    rate: {
      name: 'Rate Calculator', needs: 'athlete', primary: '#view-rate .run-btn',
      text: 'Get a starting rate for any athlete based on followers, engagement, and live NIL comp data.',
      btn: 'Calculate a rate',
      tip: 'Pick an athlete and calculate a starting rate.',
    },
    marketing: {
      name: 'Media Kit', needs: 'athlete', primary: '#mk-save-btn',
      text: 'Turn any athlete profile into a brand-ready one-pager in about 30 seconds. Headshot, stats, bio, and rates included.',
      btn: 'Generate a media kit',
      tip: 'Pick an athlete to build their media kit.',
    },
    outreach: {
      name: 'AI Outreach', needs: 'athlete', primary: null,
      text: "AI writes the pitch email for you using the athlete's profile and the brand you pick, then sends from your own Gmail.",
      btn: 'Draft your first outreach',
      tip: 'Draft a pitch email from an athlete profile.',
    },
    'pdf-scan': {
      name: 'Contract Scanner', needs: 'athlete', primary: null,
      text: 'Upload a contract PDF and the AI pulls out deliverables, dates, and payment terms, then adds deliverables to your calendar.',
      btn: 'Scan a contract',
      tip: 'Pick an athlete and upload a contract PDF.',
    },
    commission: {
      name: 'Commission Tracker', needs: 'deal', primary: null,
      text: "Track every deal's commission in one place so nothing slips at payout time.",
      btn: 'Log a deal',
      tip: 'Log a deal to start tracking commission.',
    },
    pipeline: {
      name: 'Pipeline', needs: 'deal', primary: '#view-pipeline .run-btn',
      text: 'See every deal from first contact to signed, in one board.',
      btn: 'Add a deal',
      tip: 'Add a deal to start your pipeline.',
    },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ── "No data yet" detection ───────────────────────────────────────────────
  function hasAthletes() {
    var list = window.athletes;
    if (!list) { try { list = (typeof athletes !== 'undefined') ? athletes : []; } catch (e) { list = []; } }
    return (list || []).length > 0;
  }

  var _dealsCache = null, _dealsCacheAt = 0;
  function hasDeals() {
    var now = Date.now();
    if (_dealsCache !== null && now - _dealsCacheAt < 15000) return Promise.resolve(_dealsCache);
    return fetch(API + '/api/agent/deals', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (d) {
        var arr = Array.isArray(d) ? d : (d && d.deals) || [];
        _dealsCache = arr.length > 0; _dealsCacheAt = now; return _dealsCache;
      })
      .catch(function () { _dealsCache = true; _dealsCacheAt = now; return true; }); // fail-open
  }
  function invalidateDeals() { _dealsCache = null; }

  function isEmptyFor(viewId) {
    var t = TOOLS[viewId];
    if (!t) return Promise.resolve(false);
    if (t.needs === 'athlete') return Promise.resolve(!hasAthletes());
    if (t.needs === 'deal') return hasDeals().then(function (h) { return !h; });
    return Promise.resolve(false);
  }

  // ── Part D: reusable teaching empty state ─────────────────────────────────
  function renderEmptyHTML(viewId) {
    var t = TOOLS[viewId];
    return '' +
      '<div style="max-width:480px;margin:44px auto;text-align:center;padding:34px 26px;background:var(--surface);border:1px solid var(--border);border-radius:16px">' +
        '<div style="font-family:var(--head);font-size:18px;font-weight:700;color:var(--text);margin-bottom:10px">' + esc(t.name) + '</div>' +
        '<div style="font-size:13px;color:var(--muted);line-height:1.7;margin-bottom:24px">' + esc(t.text) + '</div>' +
        '<button id="nil-es-btn-' + viewId + '" onclick="NILOnboard.emptyAction(\'' + viewId + '\')" ' +
          'style="background:var(--accent);color:#000;border:none;border-radius:40px;padding:12px 26px;font-family:var(--head);font-size:13px;font-weight:700;cursor:pointer">' +
          esc(t.btn) + '</button>' +
      '</div>';
  }

  function applyEmpty(viewId, empty) {
    var view = document.getElementById('view-' + viewId);
    if (!view) return;
    var panel = view.querySelector(':scope > .nil-empty-state');
    if (empty) {
      if (!panel) {
        panel = document.createElement('div');
        panel.className = 'nil-empty-state';
        panel.innerHTML = renderEmptyHTML(viewId);
        view.insertBefore(panel, view.firstChild);
      }
      // Hide the real tool content while empty; remember prior display so we can
      // restore it exactly once data exists.
      Array.prototype.forEach.call(view.children, function (ch) {
        if (ch === panel) return;
        if (!ch.hasAttribute('data-nil-hidden')) {
          ch.setAttribute('data-nil-prev', ch.style.display || '');
          ch.setAttribute('data-nil-hidden', '1');
          ch.style.display = 'none';
        }
      });
    } else {
      if (panel) panel.parentNode.removeChild(panel);
      Array.prototype.forEach.call(view.children, function (ch) {
        if (ch.hasAttribute('data-nil-hidden')) {
          ch.style.display = ch.getAttribute('data-nil-prev') || '';
          ch.removeAttribute('data-nil-hidden');
          ch.removeAttribute('data-nil-prev');
        }
      });
    }
  }

  // The empty-state primary button funnels the user to the prerequisite action.
  function emptyAction(viewId) {
    var t = TOOLS[viewId];
    if (t && t.needs === 'deal') {
      var m = document.getElementById('addDealModal');
      if (m) { m.classList.add('open'); return; }
    }
    // Athlete-dependent tools with an empty roster: send them to Add Client.
    if (typeof window.showView === 'function') {
      window.showView('add-athlete', document.getElementById('addAthleteNavBtn'));
    }
  }

  // ── Part E: help "?" icon in each tool header ─────────────────────────────
  function injectHelp(viewId) {
    var view = document.getElementById('view-' + viewId);
    if (!view || view.querySelector('.nil-help-icon')) return;
    var icon = document.createElement('button');
    icon.className = 'nil-help-icon';
    icon.id = 'nil-help-' + viewId;
    icon.type = 'button';
    icon.textContent = '?';
    icon.setAttribute('aria-label', 'What is this tool');
    icon.setAttribute('onclick', "NILOnboard.openHelp('" + viewId + "')");
    icon.style.cssText = 'flex-shrink:0;width:22px;height:22px;border-radius:50%;border:1px solid var(--border2);background:var(--surface2);color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;line-height:1;padding:0';
    var title = view.querySelector(':scope > .page-title');
    if (title) {
      title.style.display = 'flex';
      title.style.alignItems = 'center';
      title.style.gap = '10px';
      var wrap = document.createElement('span');
      wrap.style.cssText = 'margin-left:auto';
      wrap.appendChild(icon);
      title.appendChild(wrap);
    } else {
      var row = document.createElement('div');
      row.className = 'nil-help-row';
      row.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:8px';
      row.appendChild(icon);
      view.insertBefore(row, view.firstChild);
    }
  }

  function openHelp(viewId) {
    closePopover();
    var t = TOOLS[viewId];
    if (!t) return;
    var anchor = document.getElementById('nil-help-' + viewId);
    var pop = document.createElement('div');
    pop.className = 'nil-popover';
    pop.style.cssText = 'position:fixed;z-index:600;max-width:300px;background:var(--surface);border:1px solid var(--border2);border-radius:12px;padding:16px;box-shadow:0 8px 32px rgba(0,0,0,0.4)';
    pop.innerHTML =
      '<div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:6px">' + esc(t.name) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:12px">' + esc(t.text) + '</div>' +
      '<button onclick="NILOnboard.closePopover()" style="background:var(--accent);color:#000;border:none;border-radius:8px;padding:6px 14px;font-size:11px;font-weight:700;cursor:pointer">Got it</button>';
    document.body.appendChild(pop);
    positionNear(pop, anchor);
    setTimeout(function () { document.addEventListener('click', _outside, true); }, 0);
  }
  function _outside(e) {
    var pop = document.querySelector('.nil-popover');
    if (pop && !pop.contains(e.target) && !/nil-help-icon/.test(e.target.className || '')) closePopover();
  }
  function closePopover() {
    document.removeEventListener('click', _outside, true);
    var pop = document.querySelector('.nil-popover');
    if (pop) pop.parentNode.removeChild(pop);
  }

  function positionNear(el, anchor) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    el.style.visibility = 'hidden';
    var w = el.offsetWidth, h = el.offsetHeight;
    var top, left;
    if (r && r.width) {
      top = r.bottom + 8;
      left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
      if (top + h > vh - 8) top = Math.max(8, r.top - h - 8);
    } else {
      top = Math.max(8, vh / 2 - h / 2);
      left = Math.max(8, vw / 2 - w / 2);
    }
    el.style.top = top + 'px';
    el.style.left = left + 'px';
    el.style.visibility = 'visible';
  }

  // ── Part E: first-visit tooltip pointing at the primary action ────────────
  function tooltipAnchor(viewId) {
    var t = TOOLS[viewId];
    var el = null;
    if (t.primary) { el = document.querySelector(t.primary); if (el && el.offsetParent === null) el = null; }
    if (!el) el = document.getElementById('nil-es-btn-' + viewId);
    if (!el) el = document.getElementById('nil-help-' + viewId);
    return el;
  }

  function showTooltip(viewId) {
    removeTooltip();
    var t = TOOLS[viewId];
    var anchor = tooltipAnchor(viewId);
    if (!anchor) return;
    var tip = document.createElement('div');
    tip.className = 'nil-tooltip';
    tip.style.cssText = 'position:fixed;z-index:590;max-width:260px;background:var(--accent);color:#0A0A08;border-radius:10px;padding:12px 14px;box-shadow:0 6px 24px rgba(0,0,0,0.35)';
    tip.innerHTML =
      '<div style="font-size:12px;font-weight:600;line-height:1.5;margin-bottom:8px">' + esc(t.tip) + '</div>' +
      '<button onclick="NILOnboard.dismissTooltip(\'' + viewId + '\')" style="background:rgba(0,0,0,0.15);color:#0A0A08;border:none;border-radius:6px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer">Got it</button>';
    document.body.appendChild(tip);
    positionNear(tip, anchor);
  }
  function removeTooltip() {
    var tt = document.querySelector('.nil-tooltip');
    if (tt) tt.parentNode.removeChild(tt);
  }
  function dismissTooltip(viewId) {
    removeTooltip();
    if (_state && _state.tooltipsSeen) _state.tooltipsSeen[viewId] = true;
    fetch(API + '/api/onboarding/tooltip/' + encodeURIComponent(viewId), { method: 'POST', credentials: 'same-origin' }).catch(function () {});
  }

  // ── Part C: Getting Started checklist card ────────────────────────────────
  var CHECK = [
    { key: 'add_athlete',   label: 'Add an athlete',                      view: 'add-athlete' },
    { key: 'deal_scan',     label: 'Run a Deal Scan',                     view: 'deals' },
    { key: 'media_kit',     label: 'Generate a media kit',                view: 'marketing' },
    { key: 'ai_outreach',   label: 'Send an AI outreach email',           view: 'outreach' },
    { key: 'contract_scan', label: 'Scan a contract PDF',                 view: 'pdf-scan' },
    { key: 'rate_calc',     label: 'Calculate a rate with Rate Calculator', view: 'rate' },
    { key: 'log_deal',      label: 'Log your first deal',                 view: 'pipeline' },
  ];

  function deepLink(item) {
    closePopover();
    if (item.key === 'log_deal') {
      if (typeof window.showView === 'function') window.showView('pipeline', document.querySelector('.nav-item[onclick*=pipeline]'));
      var m = document.getElementById('addDealModal');
      if (m) setTimeout(function () { m.classList.add('open'); }, 60);
      return;
    }
    if (typeof window.showView === 'function') {
      var navSel = item.view === 'add-athlete' ? '#addAthleteNavBtn' : '.nav-item[onclick*=' + item.view + ']';
      var nav = document.querySelector(navSel);
      window.showView(item.view, nav);
    }
  }

  function collapsedKey() { var u = curUser() || {}; return 'nil-gs-collapsed-' + (u.id || ''); }
  function doneSeenKey() { var u = curUser() || {}; return 'nil-gs-complete-seen-' + (u.id || ''); }

  function renderChecklist() {
    var home = document.getElementById('view-home');
    if (!home || !isAgent()) return;
    var host = document.getElementById('nil-getting-started');

    getState().then(function (st) {
      var checklist = (st && st.checklist) || {};
      if (st && st.checklistDismissed) { if (host) host.remove(); return; }

      var done = CHECK.filter(function (i) { return !!checklist[i.key]; }).length;
      var total = CHECK.length;

      // All done: show one celebration, then auto-hide on the next visit.
      var seenComplete = false;
      try { seenComplete = !!localStorage.getItem(doneSeenKey()); } catch (e) {}
      if (done >= total && seenComplete) { if (host) host.remove(); return; }

      if (!host) {
        host = document.createElement('div');
        host.id = 'nil-getting-started';
        host.style.cssText = 'margin-bottom:12px';
        home.insertBefore(host, home.firstChild);
      }

      var collapsed = false;
      try { collapsed = localStorage.getItem(collapsedKey()) === '1'; } catch (e) {}

      if (done >= total) {
        try { localStorage.setItem(doneSeenKey(), '1'); } catch (e) {}
        host.innerHTML =
          '<div style="background:#0D1520;border:1px solid rgba(132,204,22,0.35);border-radius:10px;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px">' +
            '<div>' +
              '<div style="font-size:13px;font-weight:700;color:var(--accent)">You know the whole platform</div>' +
              '<div style="font-size:11px;color:#9CA3AF;margin-top:2px">All 7 tools done. This card hides itself from here on.</div>' +
            '</div>' +
            '<button onclick="NILOnboard.hideChecklist()" style="background:transparent;border:1px solid #1e2a3a;color:#9CA3AF;border-radius:6px;padding:6px 12px;font-size:11px;cursor:pointer">Hide</button>' +
          '</div>';
        return;
      }

      var pct = Math.round((done / total) * 100);
      var rows = CHECK.map(function (i) {
        var isDone = !!checklist[i.key];
        return '' +
          '<button onclick="NILOnboard.deepLink(' + JSON.stringify(i.key ? CHECK.indexOf(i) : 0) + ')" ' +
            'style="width:100%;text-align:left;display:flex;align-items:center;gap:10px;padding:8px 10px;background:transparent;border:none;border-radius:6px;cursor:pointer" ' +
            'onmouseover="this.style.background=\'#111827\'" onmouseout="this.style.background=\'transparent\'">' +
            '<span style="width:18px;height:18px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;' +
              (isDone ? 'background:var(--accent);color:#000' : 'background:#111827;border:1px solid #1e2a3a;color:#4B5563') + '">' + (isDone ? '✓' : '') + '</span>' +
            '<span style="flex:1;font-size:12px;color:' + (isDone ? '#4B5563' : 'var(--text)') + ';' + (isDone ? 'text-decoration:line-through' : '') + '">' + esc(i.label) + '</span>' +
            (isDone ? '' : '<span style="font-size:11px;color:var(--accent)">Start</span>') +
          '</button>';
      }).join('');

      host.innerHTML =
        '<div style="background:#0D1520;border:1px solid #1e2a3a;border-radius:10px;overflow:hidden">' +
          '<div style="padding:14px 16px;display:flex;align-items:center;gap:12px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;align-items:center;gap:8px">' +
                '<span style="font-size:13px;font-weight:700;color:var(--text)">Getting Started</span>' +
                '<span style="font-size:11px;color:#9CA3AF">' + done + ' of ' + total + ' done</span>' +
              '</div>' +
              '<div style="height:5px;background:#111827;border-radius:3px;margin-top:8px;overflow:hidden">' +
                '<div style="height:100%;width:' + pct + '%;background:var(--accent);border-radius:3px;transition:width 0.3s"></div>' +
              '</div>' +
            '</div>' +
            '<button onclick="NILOnboard.toggleChecklist()" style="background:transparent;border:none;color:#9CA3AF;font-size:16px;cursor:pointer;line-height:1;padding:2px 6px" title="Collapse">' + (collapsed ? '▾' : '▴') + '</button>' +
          '</div>' +
          '<div id="nil-gs-body" style="padding:0 8px 8px;' + (collapsed ? 'display:none' : '') + '">' + rows +
            '<div style="text-align:center;padding:6px 0 4px">' +
              '<button onclick="NILOnboard.hideChecklist()" style="background:transparent;border:none;color:#4B5563;font-size:11px;cursor:pointer;text-decoration:underline;text-underline-offset:2px">Hide checklist</button>' +
            '</div>' +
          '</div>' +
        '</div>';
    });
  }

  function toggleChecklist() {
    var body = document.getElementById('nil-gs-body');
    if (!body) return;
    var nowCollapsed = body.style.display !== 'none';
    body.style.display = nowCollapsed ? 'none' : '';
    try { localStorage.setItem(collapsedKey(), nowCollapsed ? '1' : '0'); } catch (e) {}
    var host = document.getElementById('nil-getting-started');
    var btn = host && host.querySelector('button[title="Collapse"]');
    if (btn) btn.textContent = nowCollapsed ? '▾' : '▴';
  }

  function hideChecklist() {
    var host = document.getElementById('nil-getting-started');
    if (host) host.remove();
    if (_state) _state.checklistDismissed = true;
    fetch(API + '/api/onboarding/checklist/dismiss', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dismissed: true }),
    }).catch(function () {});
  }

  function refreshChecklist() { invalidateDeals(); getState(true).then(renderChecklist); }

  // ── View hook ─────────────────────────────────────────────────────────────
  function onView(viewId) {
    if (!isAgent()) return;
    removeTooltip();
    closePopover();
    if (viewId === 'home') { renderChecklist(); return; }
    if (!TOOLS[viewId]) return;

    injectHelp(viewId);
    isEmptyFor(viewId).then(function (empty) {
      applyEmpty(viewId, empty);
      // First-visit tooltip: once per tool per user.
      getState().then(function (st) {
        var seen = st && st.tooltipsSeen && st.tooltipsSeen[viewId];
        if (!seen) setTimeout(function () { showTooltip(viewId); }, 400);
      });
    });
  }

  // onView is invoked from the main app's showView wrapper (index.html), which
  // is the single definitive wrapper. We do not wrap showView here to avoid
  // double invocation and load-order races.

  function init() {
    // If we boot straight into home (agents land here), render the checklist
    // once state is known. Retry briefly in case currentUser is set slightly
    // after this script's first tick.
    var tries = 0;
    var iv = setInterval(function () {
      if (isAgent()) {
        clearInterval(iv);
        getState().then(function () {
          var home = document.getElementById('view-home');
          if (home && home.classList.contains('active')) renderChecklist();
        });
      } else if (++tries > 60) { clearInterval(iv); }
    }, 200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.NILOnboard = {
    onView: onView,
    emptyAction: emptyAction,
    openHelp: openHelp,
    closePopover: closePopover,
    dismissTooltip: dismissTooltip,
    deepLink: function (idx) { deepLink(CHECK[idx]); },
    toggleChecklist: toggleChecklist,
    hideChecklist: hideChecklist,
    refreshChecklist: refreshChecklist,
    renderChecklist: renderChecklist,
    _state: function () { return _state; },
  };
})();
