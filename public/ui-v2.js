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
  var COPY = { 'Scan Deals with AI': 'Search', 'Write Outreach': 'Write pitch', '+ Pipeline': 'Add to pipeline', '\u26a1 AI Outreach': 'Draft email',
    'Outreach Sent': 'Pitched', '\u2192 Outreach Sent': '\u2192 Pitched', 'AI Lookup': 'Look up', 'AI Generate Bio': 'Write bio', '✨ AI Draft': 'Draft',
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


  // ── TODAY: a greeting and four numbers above the cards ───────────────────
  // Every number comes from the same /api/agent/home answer the cards do
  // (HQ.data), so the strip and the page can never disagree.
  function todayHead() {
    var view = document.getElementById('view-home');
    var d = (typeof HQ !== 'undefined' && HQ) ? HQ.data : null;
    if (!view || !d || !built) return;
    var el = document.getElementById('v2TodayHead');
    if (!el) { el = document.createElement('div'); el.id = 'v2TodayHead'; view.insertBefore(el, view.firstChild); }
    var s = d.sinceYesterday || {};
    var ready = (d.athletes || []).reduce(function (n, a) { return n + (Number(a.pending) || 0); }, 0);
    var withWork = (d.athletes || []).filter(function (a) { return Number(a.pending) > 0; }).length;
    var reps = (d.replies || []).length;
    var h = new Date().getHours();
    var hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    var who = (typeof currentUser !== 'undefined' && currentUser && currentUser.name) ? String(currentUser.name).split(/\s+/)[0] : '';
    var esc = window.escHtml || function (t) { return String(t); };
    var date = new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    var lede = ready ? ready + ' pitch' + (ready === 1 ? ' is' : 'es are') + ' ready across ' + withWork + ' athlete' + (withWork === 1 ? '' : 's') + '.'
      : 'Nothing to approve right now. Tonight’s research fills this page by morning.';
    var stat = function (label, n, note, hi) {
      return '<div class="v2-stat"><div class="l">' + label + '</div><div class="n' + (hi ? ' hi' : '') + '">' + n + '</div><div class="s">' + note + '</div></div>';
    };
    var news = document.getElementById('home-news');
    view.classList.toggle('v2-rail', !!(news && news.querySelector('.hq-replies, .hq-todo, .hq-faults')));
    el.innerHTML = '<div class="v2-today-h"><h1>' + hello + (who ? ', ' + esc(who) : '') + '</h1><p>' + date + '. ' + lede + '</p></div>'
      + '<div class="v2-stats">'
      + stat('Ready to approve', ready, withWork ? 'Across ' + withWork + ' athlete' + (withWork === 1 ? '' : 's') : 'All caught up', ready > 0)
      + stat('Replies waiting', reps, reps ? 'Answer these first' : 'None waiting', false)
      + stat('Follow-ups ready', Number(s.followUpsReady) || 0, 'Go out when you approve', false)
      + stat('Sent since yesterday', Number(s.sent) || 0, (Number(s.signed) ? s.signed + ' deal' + (s.signed === 1 ? '' : 's') + ' signed' : 'From your inbox'), false)
      + '</div>';
  }
  function installToday() {
    if (typeof window.hqRender !== 'function' || window.hqRender.__v2) return;
    var orig = window.hqRender;
    var v2 = function () { var r = orig.apply(this, arguments); try { todayHead(); } catch (e) {} return r; };
    v2.__v2 = true;
    window.hqRender = v2;
  }


  // ── INBOX: every reply, with the pitch it answered (GET /api/agent/inbox) ──
  // Read here, answered in the agent's own mailbox (openUrl), so the reply goes
  // out threaded and from their address. Handled / Not interested / Signed are
  // Home's own actions (hqReplyHandled, hqReplyNo, hqReplyDeal).
  var IB = { items: [], sel: null, filter: 'needs', mode: 'replies', loading: false };
  function ibEsc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ibWhen(d) {
    if (!d) return '';
    var t = new Date(d), now = new Date();
    if (t.toDateString() === now.toDateString()) return t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return t.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  function ibBadge(n) {
    var b = navBtn('email-inbox'); if (!b) return;
    var el = b.querySelector('.v2-badge');
    if (!el) { el = document.createElement('span'); el.className = 'v2-badge'; b.appendChild(el); }
    el.textContent = n > 0 ? String(n) : '';
    el.hidden = !(n > 0);
  }
  function ibLoad() {
    if (IB.loading) return;
    IB.loading = true;
    fetch('/api/agent/inbox', { credentials: 'same-origin' }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (x) {
        IB.loading = false;
        if (!x.ok) { IB.error = x.d.error || 'Could not load your replies.'; }
        else { IB.error = null; IB.items = x.d.items || []; ibBadge(x.d.needsReply || 0); }
        ibRender();
      }).catch(function () { IB.loading = false; IB.error = 'Could not load your replies. Try again in a minute.'; ibRender(); });
  }
  function ibAfter() { setTimeout(ibLoad, 900); }
  window.v2Inbox = {
    pick: function (id) { IB.sel = id; ibRender(); },
    filter: function (f) { IB.filter = f; IB.sel = null; ibRender(); },
    mode: function (m) { IB.mode = m; ibRender(); },
    handled: function (btn, id) { try { hqReplyHandled(btn, id); } catch (e) {} ibAfter(); },
    no: function (btn, card) { try { hqReplyNo(btn, card); } catch (e) {} ibAfter(); },
    deal: function (card, ath) { try { hqReplyDeal(card, ath); } catch (e) {} ibAfter(); },
    reload: ibLoad,
  };
  function ibRender() {
    var view = document.getElementById('view-email-inbox');
    if (!view || !built) return;
    var box = document.getElementById('v2Inbox');
    if (!box) { box = document.createElement('div'); box.id = 'v2Inbox'; }
    var tabs = document.getElementById('v2Tabs');
    if (tabs && tabs.parentNode === view) view.insertBefore(box, tabs.nextSibling); else view.insertBefore(box, view.firstChild);
    // the old Inbox (mailboxes, compose, athlete emails) lives under "Compose"
    Array.prototype.forEach.call(view.children, function (c) {
      if (c === box || c.id === 'v2Tabs') return;
      c.classList.toggle('v2-hide', IB.mode === 'replies');
    });
    var modeTabs = '<div class="v2-tabs" role="tablist" aria-label="Inbox">'
      + '<button type="button" role="tab" aria-selected="' + (IB.mode === 'replies') + '" onclick="v2Inbox.mode(\'replies\')">Replies</button>'
      + '<button type="button" role="tab" aria-selected="' + (IB.mode === 'compose') + '" onclick="v2Inbox.mode(\'compose\')">Compose and mailboxes</button></div>';
    if (IB.mode !== 'replies') { box.innerHTML = modeTabs; return; }
    var head = '<div class="v2-ib-head"><div><h1 class="v2-h1">Inbox</h1><p class="v2-sub">Replies from businesses, tied to the athlete and the pitch they answered.</p></div>'
      + '<button type="button" class="v2-b" onclick="v2Inbox.reload()">Refresh</button></div>';
    if (IB.error) { box.innerHTML = modeTabs + head + '<div class="v2-ib-empty">' + ibEsc(IB.error) + '</div>'; return; }
    var all = IB.items || [];
    var list = IB.filter === 'needs' ? all.filter(function (i) { return i.needsReply; }) : all;
    var waiting = all.filter(function (i) { return i.needsReply; }).length;
    if (!all.length) {
      box.innerHTML = modeTabs + head + '<div class="v2-ib-empty"><b>No replies yet.</b><br>When a business answers a pitch, it shows up here with the pitch it answered.</div>';
      return;
    }
    if (!IB.sel || !list.some(function (i) { return i.logId === IB.sel; })) IB.sel = list.length ? list[0].logId : null;
    var rows = list.map(function (i) {
      var sel = i.logId === IB.sel;
      return '<button type="button" class="v2-ib-row' + (sel ? ' sel' : '') + '" onclick="v2Inbox.pick(\'' + ibEsc(i.logId) + '\')">'
        + '<span class="dot' + (i.needsReply ? ' on' : '') + '"></span>'
        + '<span class="tx"><span class="top"><b>' + ibEsc(i.business || 'A business') + '</b><span>' + ibEsc(ibWhen(i.repliedAt)) + '</span></span>'
        + '<span class="who">' + ibEsc([i.from, i.athlete ? 'for ' + i.athlete : null].filter(Boolean).join(' · ')) + '</span>'
        + '<span class="snip">' + ibEsc((i.reply || 'Reply received. Open it in your mailbox.').slice(0, 140)) + '</span></span></button>';
    }).join('') || '<div class="v2-ib-empty" style="margin:12px">Nothing waiting on you.</div>';
    var c = list.filter(function (i) { return i.logId === IB.sel; })[0];
    var detail = '';
    if (c) {
      var state = c.needsReply ? '<span class="v2-pill on">Needs a reply</span>'
        : c.outcome === 'closed' ? '<span class="v2-pill on">Deal signed</span>'
        : c.outcome === 'declined' || c.outcome === 'dead' ? '<span class="v2-pill">Not interested</span>' : '<span class="v2-pill">Handled</span>';
      var acts = (c.openUrl ? '<a class="v2-b p" href="' + ibEsc(c.openUrl) + '" target="_blank" rel="noopener">Reply in your mailbox</a>' : '')
        + (c.needsReply && c.cardId ? '<button type="button" class="v2-b" onclick="v2Inbox.deal(' + Number(c.cardId) + ',\'' + ibEsc(c.athleteId) + '\')">Mark deal signed</button>'
          + '<button type="button" class="v2-b" onclick="v2Inbox.no(this,' + Number(c.cardId) + ')">Not interested</button>' : '')
        + (c.needsReply ? '<button type="button" class="v2-b" onclick="v2Inbox.handled(this,\'' + ibEsc(c.logId) + '\')">Handled</button>' : '');
      detail = '<div class="v2-ib-dh"><div><div class="v2-ib-biz">' + ibEsc(c.business || 'A business') + '</div>'
        + '<div class="v2-sub">' + ibEsc([c.athlete ? 'For ' + c.athlete : null, c.subject].filter(Boolean).join(' · ')) + '</div></div>' + state + '</div>'
        + '<div class="v2-ib-body">'
        + '<div class="v2-ib-msg them"><div class="m">' + ibEsc(c.from || 'Their reply') + ' · ' + ibEsc(ibWhen(c.repliedAt)) + '</div>'
        + '<div class="t">' + (c.reply ? ibEsc(c.reply) : '<i>The reply is in your mailbox; its text was not captured.</i>') + '</div></div>'
        + (c.pitch ? '<details class="v2-ib-msg you"><summary><span class="m">Your pitch · ' + ibEsc(ibWhen(c.sentAt)) + '</span></summary><div class="t">' + ibEsc(c.pitch) + '</div></details>' : '')
        + '</div><div class="v2-ib-acts">' + acts + '</div>';
    }
    box.innerHTML = modeTabs + head
      + '<div class="v2-ib">'
      + '<div class="v2-ib-list"><div class="v2-ib-filter">'
      + '<button type="button" aria-pressed="' + (IB.filter === 'needs') + '" onclick="v2Inbox.filter(\'needs\')">Needs reply <span>' + waiting + '</span></button>'
      + '<button type="button" aria-pressed="' + (IB.filter === 'all') + '" onclick="v2Inbox.filter(\'all\')">All <span>' + all.length + '</span></button></div>'
      + rows + '</div>'
      + '<div class="v2-ib-detail">' + (detail || '<div class="v2-ib-empty">Pick a reply on the left.</div>') + '</div>'
      + '</div>';
  }


  // ── PIPELINE: tidy the board after every draw ───────────────────────────
  function installPipeline() {
    var P = window.NILPipeline;
    if (!P || !P.render || P.render.__v2) return;
    var orig = P.render;
    var v2 = function (deals, board) { var r = orig.apply(this, arguments); try { if (board) { board.classList.add('v2-board'); recopy(board); } } catch (e) {} return r; };
    v2.__v2 = true;
    P.render = v2;
  }

  // ── SETTINGS: a list of sections beside one long page ───────────────────
  function settingsNav() {
    var view = document.getElementById('view-settings');
    if (!view || view.querySelector('.v2-set')) return;
    var secs = [];
    Array.prototype.forEach.call(view.children, function (c) {
      if (c.classList.contains('page-title') || c.classList.contains('page-sub') || c.id === 'v2Tabs' || c.tagName === 'SCRIPT' || c.tagName === 'STYLE') return;
      var h = c.querySelector('div[style*="font-weight:700"]');
      var t = h ? (h.textContent || '').trim() : '';
      secs.push({ el: c, title: t && t.length < 48 ? t : '' });
    });
    if (secs.length < 3) return;
    var wrap = document.createElement('div'); wrap.className = 'v2-set';
    var nav = document.createElement('nav'); nav.className = 'v2-set-nav'; nav.setAttribute('aria-label', 'Settings sections');
    var body = document.createElement('div'); body.className = 'v2-set-body';
    secs.forEach(function (x) {
      body.appendChild(x.el);
      if (!x.title) return;
      var b = document.createElement('button'); b.type = 'button'; b.textContent = x.title;
      b.addEventListener('click', function () {
        nav.querySelectorAll('button').forEach(function (y) { y.removeAttribute('aria-current'); });
        b.setAttribute('aria-current', 'true');
        x.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      nav.appendChild(b);
    });
    if (nav.firstChild) nav.firstChild.setAttribute('aria-current', 'true');
    wrap.appendChild(nav); wrap.appendChild(body);
    view.appendChild(wrap);
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
    installToday();
    installPipeline();
    ibLoad();
    // Views draw their content after showView returns (scans, boards, lists),
    // so new copy is renamed as it arrives. childList only: renaming a text
    // node is a characterData change and does not wake this again.
    var content = document.querySelector('#appScreen .content');
    if (content && window.MutationObserver) {
      var pend = null;
      new MutationObserver(function () {
        if (pend) return;
        pend = setTimeout(function () { pend = null; try { recopy(document.querySelector('.view.active')); } catch (e) {} }, 120);
      }).observe(content, { childList: true, subtree: true });
    }
    try { todayHead(); } catch (e) {}
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
    if (id === 'email-inbox') { ibRender(); ibLoad(); }
    if (id === 'settings') settingsNav();
    if (id === 'pipeline') installPipeline();
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
