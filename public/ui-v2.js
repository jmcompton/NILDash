// ── NILDASH UI V2: the switch and the eight-place sidebar ────────────────────
//
// THE SWITCH. html[data-ui="v2"] turns on public/ui-v2.css and the sidebar
// below. The tiny inline script in index.html's <head> sets it before paint so
// there is no flash:
//   On for everyone (the default is 'v2').
//   ?ui=v1  brings back the old look for this browser (remembered in localStorage)
//   ?ui=v2  turns the new look back on
//
// THE SIDEBAR. Agent mode only (athletes and universities keep theirs). Eighteen
// entries become eight places plus Settings. Nothing is deleted: every old view
// still exists and is reached from a tab row at the top of the place it now
// belongs to, by clicking its original (now hidden) nav button, so each view's
// own loaders run exactly as before.
(function () {
  'use strict';
  if (document.documentElement.getAttribute('data-ui') !== 'v2') return;

  var ICON = {
    today: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    roster: '<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c.6-3.3 3-5 6-5s5.4 1.7 6 5"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.6c2 .5 3.2 2 3.6 4.9"/>',
    find: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    pipeline: '<rect x="3.5" y="4" width="4.5" height="16" rx="1.2"/><rect x="9.8" y="4" width="4.5" height="11" rx="1.2"/><rect x="16" y="4" width="4.5" height="7" rx="1.2"/>',
    deliv: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8.5 14.5l2 2 4-4"/>',
    inbox: '<path d="M3.5 13.5l2.6-7.2A2 2 0 0 1 8 5h8a2 2 0 0 1 1.9 1.3l2.6 7.2"/><path d="M3.5 13.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-4.5h-5l-1.5 2.5h-4L8.5 13.5z"/>',
    portal: '<path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5"/>',
    reports: '<path d="M4 20h16"/><path d="M7 16.5v-5M12 16.5V7M17 16.5v-8"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
    growth: '<path d="M4 16l5-5 4 4 7-7"/><path d="M15 8h5v5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
  };
  var svg = function (k) { return '<svg class="v2-ic" viewBox="0 0 24 24" aria-hidden="true">' + ICON[k] + '</svg>'; };

  // view id -> the place it lives in
  var PLACE = {
    home: 'home', command: 'home', 'shift-detail': 'home',
    roster: 'roster', marketing: 'roster', 'add-athlete': 'roster', 'athlete-portals': 'roster',
    deals: 'deals', brands: 'deals', outreach: 'deals', programs: 'deals', rate: 'deals', negotiate: 'deals',
    pipeline: 'pipeline', 'deal-close': 'pipeline',
    calendar: 'calendar', contract: 'calendar',
    'email-inbox': 'email-inbox',
    analytics: 'analytics', commission: 'analytics',
    settings: 'settings', growth: 'growth',
  };
  // the tab row each place shows: [view id, label]
  var TABS = {
    deals: [['deals', 'Search'], ['brands', 'Saved brands'], ['outreach', 'Outreach']],
    roster: [['roster', 'Athletes'], ['marketing', 'Media kits'], ['add-athlete', 'Add athlete']],
    calendar: [['calendar', 'Deliverables'], ['contract', 'Contracts']],
    analytics: [['analytics', 'Overview'], ['commission', 'Commission']],
  };
  // the sidebar, in order: [view id or 'portal', label, icon]
  var NAV = [['home', 'Today', 'today'], ['roster', 'Roster', 'roster'], ['deals', 'Find brands', 'find'],
    ['pipeline', 'Pipeline', 'pipeline'], ['calendar', 'Deliverables', 'deliv'], ['email-inbox', 'Inbox', 'inbox'],
    ['portal', 'Portal Room', 'portal'], ['analytics', 'Reports', 'reports'], ['growth', 'Growth', 'growth']];

  // Breadcrumb and page-title names for the new places.
  var CRUMB = { home: 'Today', roster: 'Roster', marketing: 'Media kits', 'add-athlete': 'Add athlete', deals: 'Find brands',
    brands: 'Saved brands', outreach: 'Outreach', pipeline: 'Pipeline', calendar: 'Deliverables', contract: 'Contracts',
    'email-inbox': 'Inbox', analytics: 'Reports', commission: 'Commission', settings: 'Settings', command: 'Assistant' };
  var TITLE = { 'My Roster': 'Roster', 'Deliverables Calendar': 'Deliverables', 'Email Inbox': 'Inbox', 'Add Client': 'Add athlete',
    'Media Kit': 'Media kits', 'Outreach Tracker': 'Outreach' };
  var SUB = { 'Your clients \u2014 click any card to make them active': 'Click a row to make that athlete your active client.',
    'All contract deliverables across your roster \u2014 single source of truth': 'What each athlete owes each brand, and when. Upload a contract and the dates fill in.',
    'Everything already sent \u2014 to whom, when, on which channel, and whether it replied. Cards are worked on Home.': 'Everything already sent: to whom, when, on which channel, and whether it got a reply.',
    'Add a new athlete to your roster': 'Add an athlete. Research starts tonight.',
    'Admin-only · Automated outreach to NIL agents and schools': 'Admin only. Outreach to agents and schools.' };
  // Button and label copy: NILDash is sold as software, not as an AI product.
  // Exact, whole-label matches only; disclaimers about generated contracts stay.
  var COPY = { 'Scan Deals with AI': 'Search', 'AI Lookup': 'Look up', 'AI Generate Bio': 'Write bio', '✨ AI Draft': 'Draft',
    'Extract Athletes with AI': 'Import athletes', 'AI Roster Import': 'Roster import', 'AI Outreach Emails': 'Outreach emails',
    'Generating posts with AI...': 'Writing posts...', 'AI is mapping your roster…': 'Reading your roster…',
    'Enter a real athlete. AI Lookup can fill the profile for you.': 'Enter a real athlete. Look up fills the profile for you.' };
  function recopy(root) {
    if (!root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), n;
    while ((n = w.nextNode())) {
      var t = n.nodeValue.trim();
      if (t && Object.prototype.hasOwnProperty.call(COPY, t)) n.nodeValue = n.nodeValue.replace(t, COPY[t]);
      else if (t && Object.prototype.hasOwnProperty.call(TITLE, t) && n.parentElement && n.parentElement.classList.contains('page-title')) n.nodeValue = TITLE[t];
      else if (t && Object.prototype.hasOwnProperty.call(SUB, t) && n.parentElement && n.parentElement.classList.contains('page-sub')) n.nodeValue = SUB[t];
    }
  }

  function navBtn(id) {
    if (id === 'portal') return document.querySelector('.sidebar-nav .nav-item[onclick*="/portal-room"]');
    var all = document.querySelectorAll('.sidebar-nav .nav-item');
    for (var i = 0; i < all.length; i++) {
      if ((all[i].getAttribute('onclick') || '').indexOf("showView('" + id + "'") >= 0) return all[i];
    }
    return null;
  }
  function isAgent() {
    try { if (typeof isAthleteMode === 'function' && isAthleteMode()) return false; } catch (e) {}
    var l = document.getElementById('sidebarRoleLabel');
    return !l || /agent/i.test(l.textContent || '');
  }
  function setLabel(btn, text, icon) {
    if (!btn || btn.getAttribute('data-v2')) return;
    btn.setAttribute('data-v2', '1');
    for (var i = 0; i < btn.childNodes.length; i++) {
      var n = btn.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) { n.nodeValue = text; break; }
    }
    btn.insertAdjacentHTML('afterbegin', svg(icon));
  }


  // ── ROSTER: a table instead of cards with nine buttons each ──────────────
  // Row click still makes the athlete the active client (selectAthlete), as the
  // card did. Open and Media kit are the two everyday actions; everything the
  // card offered is still one click away in the row's menu.
  function rosterRow(a) {
    var esc = window.escHtml || function (t) { return String(t == null ? '' : t); };
    var id = String(a.id).replace(/'/g, '');
    var nm = (a.name || '').replace(/'/g, '');
    var ini = (a.name || '?').split(/\s+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    var where = a.athleteType === 'pro' ? (a.team || 'Team not set') : (a.school || 'School not set');
    var meta = [a.sport, a.position, where].filter(Boolean).join(' · ');
    var igMap = typeof igStatus !== 'undefined' ? igStatus : window.igStatus;
    var ig = (igMap && igMap[a.id]) || null;
    var fmt = window.igFmt || function (n) { return Number(n).toLocaleString(); };
    var fol, eng;
    if (ig && ig.status === 'connected' && ig.followers != null) {
      fol = '<div class="v2-num">' + fmt(ig.followers) + '<small>Instagram, connected</small></div>';
    } else if (Number(a.followers) > 0) {
      fol = '<div class="v2-num">' + fmt(a.followers) + '<small>Entered by hand</small></div>';
    } else {
      fol = '<div class="v2-num" style="color:#8B8B92">Not connected<br><button type="button" class="v2-b link" onclick="event.stopPropagation();igInvite(\'' + id + '\',\'copy\',this)">Copy Instagram link</button></div>';
    }
    var er = ig && ig.status === 'connected' && ig.engagementRate != null ? (ig.engagementRate * 100).toFixed(1) + '%'
      : (a.engagement ? esc(String(a.engagement).replace(/%?$/, '%')) : '<span style="color:#8B8B92">-</span>');
    eng = '<div class="v2-num">' + er + '</div>';
    var sel = typeof selectedAthleteId !== 'undefined' && a.id === selectedAthleteId;
    var status = sel ? '<span class="v2-pill on">Active client</span>' : '<span class="v2-pill">' + esc(a.year || 'On roster') + '</span>';
    var note = a.agentNote ? '<div class="v2-note">' + esc(a.agentNote) + '</div>' : '';
    return '<div class="v2-rr' + (sel ? ' sel' : '') + '" role="row" onclick="selectAthlete(\'' + id + '\')">'
      + '<div class="v2-ath"><span class="v2-av">' + esc(ini) + '</span><div style="min-width:0"><div class="v2-nm">' + esc(a.name) + '</div><div class="v2-mt">' + esc(meta) + (a.year ? ' · ' + esc(a.year) : '') + '</div>' + note + '</div></div>'
      + fol + eng + '<div>' + status + '</div>'
      + '<div class="v2-acts" onclick="event.stopPropagation()">'
      + '<button type="button" class="v2-b" onclick="openClientProfile(\'' + id + '\')">Open</button>'
      + '<button type="button" class="v2-b" onclick="openBrandKitModal(\'' + id + '\',\'' + nm + '\')">Media kit</button>'
      + '<details class="v2-more"><summary aria-label="More actions for ' + esc(a.name) + '"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" style="fill:currentColor"><circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/></svg></summary>'
      + '<div class="v2-menu" role="menu">'
      + '<button type="button" onclick="editAthlete(\'' + id + '\')">Edit profile</button>'
      + '<button type="button" onclick="openOutreachModal(\'' + id + '\',\'' + nm + '\')">Write outreach</button>'
      + '<button type="button" onclick="generateReport(\'' + id + '\')">Weekly report</button>'
      + '<button type="button" onclick="v2Note(\'' + id + '\')">Notes</button>'
      + '<button type="button" onclick="openAthleteTool(\'' + id + '\',\'rate\')">Rate calculator</button>'
      + '<button type="button" onclick="openAthleteTool(\'' + id + '\',\'athlete-portals\')">Athlete portal</button>'
      + '<button type="button" onclick="openAthleteTool(\'' + id + '\',\'compliance\')">Compliance</button>'
      + '<button type="button" onclick="igInvite(\'' + id + '\',\'copy\',this)">Copy Instagram link</button>'
      + '<hr><button type="button" class="danger" onclick="deleteAthlete(\'' + id + '\')">Delete</button>'
      + '</div></details></div></div>';
  }
  window.v2Note = function (id) {
    var a = (typeof athletes !== 'undefined' ? athletes : []).find(function (x) { return x.id === id; });
    var v = window.prompt('Notes for ' + (a ? a.name : 'this athlete'), a && a.agentNote ? a.agentNote : '');
    if (v === null) return;
    try { saveAthleteNote(id, v); if (a) a.agentNote = v; window.renderRoster(); } catch (e) {}
  };
  function installRoster() {
    if (window.renderRoster && window.renderRoster.__v2) return;
    var orig = window.renderRoster;
    var v2 = function () {
      var grid = document.getElementById('rosterGrid');
      var list = typeof athletes !== 'undefined' ? athletes : [];
      if (!grid || !list.length || !built) return orig && orig.apply(this, arguments);
      grid.classList.add('v2-roster');
      var old = document.getElementById('igCountLine'); if (old) old.remove();
      grid.innerHTML = '<div class="v2-rt"><div class="v2-rt-in" role="table" aria-label="Roster">'
        + '<div class="v2-rr head" role="row"><span>Athlete</span><span>Followers</span><span>Engagement</span><span>Status</span><span></span></div>'
        + list.map(rosterRow).join('') + '</div></div>';
    };
    v2.__v2 = true;
    window.renderRoster = v2;
    // one open menu at a time; a click elsewhere closes it
    document.addEventListener('click', function (e) {
      document.querySelectorAll('.v2-more[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
    });
  }

  var built = false;
  function build() {
    if (built || !isAgent()) return;
    var nav = document.querySelector('.sidebar-nav');
    if (!nav) return;
    built = true;
    var keep = [];
    NAV.forEach(function (n) {
      var b = navBtn(n[0]);
      if (!b) return;
      setLabel(b, n[1], n[2]);
      keep.push(b);
    });
    // everything else in the nav is reached from a tab row instead
    Array.prototype.forEach.call(nav.children, function (el) { el.classList.add('v2-hide'); });
    keep.forEach(function (b) { nav.appendChild(b); b.classList.remove('v2-hide'); });
    // Settings sits apart, at the foot of the list
    var s = navBtn('settings');
    if (s) { setLabel(s, 'Settings', 'settings'); s.classList.remove('v2-hide'); s.style.marginTop = '12px'; nav.appendChild(s); }
    // "Add athlete" in the top bar
    var top = document.querySelector('.topbar > div:last-child');
    if (top && !document.getElementById('v2AddAthlete')) {
      var a = document.createElement('button');
      a.type = 'button'; a.id = 'v2AddAthlete'; a.className = 'v2-add';
      a.innerHTML = svg('plus') + 'Add athlete';
      a.addEventListener('click', function () { var b = document.getElementById('addAthleteNavBtn'); if (b) b.click(); });
      top.appendChild(a);
    }
    recopy(document.getElementById('appScreen'));
    installRoster();
    try { window.renderRoster(); } catch (e) {}
    mark(currentView());
  }

  function currentView() {
    var v = document.querySelector('.view.active');
    return v ? v.id.replace(/^view-/, '') : 'home';
  }

  function mark(id) {
    if (!built) return;
    var place = PLACE[id] || id;
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(function (n) { n.classList.remove('active'); });
    var lead = navBtn(place);
    if (lead) lead.classList.add('active');
    var bc = document.getElementById('breadcrumb');
    if (bc && CRUMB[id]) bc.textContent = CRUMB[id];
    recopy(document.getElementById('view-' + id));
    // tab row
    var old = document.getElementById('v2Tabs');
    if (old) old.remove();
    var tabs = TABS[place];
    var view = document.getElementById('view-' + id);
    if (!tabs || !view) return;
    var row = document.createElement('div');
    row.id = 'v2Tabs'; row.className = 'v2-tabs'; row.setAttribute('role', 'tablist');
    tabs.forEach(function (t) {
      if (t[0] === 'programs' && !navBtn('programs')) return;
      var b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t[0] === id));
      b.textContent = t[1];
      b.addEventListener('click', function () { var o = navBtn(t[0]); if (o) o.click(); else if (window.showView) window.showView(t[0]); });
      row.appendChild(b);
    });
    view.insertBefore(row, view.firstChild);
  }

  // Follow every view change. showView is the app's only router.
  function hook() {
    if (typeof window.showView !== 'function' || window.showView.__v2) return false;
    var orig = window.showView;
    var wrapped = function (id) {
      var r = orig.apply(this, arguments);
      try { build(); mark(currentView()); } catch (e) {}
      Promise.resolve(r).then(function () { try { mark(currentView()); } catch (e) {} });
      return r;
    };
    wrapped.__v2 = true;
    window.showView = wrapped;
    return true;
  }

  function start() {
    hook();
    // the role label is filled in after sign-in; try until the app has booted
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      hook();
      var app = document.getElementById('appScreen');
      if (app && getComputedStyle(app).display !== 'none') build();
      if (built || tries > 120) clearInterval(t);
    }, 250);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
