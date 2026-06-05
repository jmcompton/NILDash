// calendar.js — Master Agent Calendar (deliverables-only)
// Replaces the old deal-based NILCal engine.
// Source of truth: athlete_calendar_events (populated by contract ingestion pipeline).
// Color scheme: status-aware (overdue=red, upcoming=orange, completed=green, default=athlete color).

var NILCal = (function () {
  'use strict';

  // ── Athlete color palette (10 colors, deterministic by athlete ID hash) ──
  var ATHLETE_COLORS = [
    '#6366f1','#22c55e','#f97316','#06b6d4','#ec4899',
    '#eab308','#8b5cf6','#14b8a6','#ef4444','#3b82f6',
  ];
  function athleteColor(athleteId) {
    if (!athleteId) return ATHLETE_COLORS[0];
    var h = 0;
    for (var i = 0; i < athleteId.length; i++) h = ((h * 31) + athleteId.charCodeAt(i)) >>> 0;
    return ATHLETE_COLORS[h % ATHLETE_COLORS.length];
  }

  // ── Status-aware event color ───────────────────────────────────
  // Calendar pills always use the athlete's color for background/text (clean, readable).
  // Status is shown via the left border color so it's a subtle indicator, not overwhelming.
  // List view and drawer use statusColor() for the status badge text.
  function getEventColor(ev, today) {
    var ac = athleteColor(ev.athlete_id);
    var d  = ev.event_date ? ev.event_date.split('T')[0] : null;
    var border = ac; // default: athlete color border

    if (ev.status === 'completed') {
      border = '#22c55e'; // green border
    } else if (d && d < today) {
      border = '#ef4444'; // red border for overdue
    } else if (d) {
      var sevenDays = new Date();
      sevenDays.setDate(sevenDays.getDate() + 7);
      if (new Date(d + 'T00:00:00') <= sevenDays) {
        border = '#f97316'; // orange border for upcoming ≤7 days
      }
    }

    return { bg: ac + '18', fg: ac, border: border };
  }

  // Readable status label + color for list/drawer views
  function statusColor(ev, today) {
    var d = ev.event_date ? ev.event_date.split('T')[0] : null;
    if (ev.status === 'completed') return { label: 'Completed', color: '#22c55e' };
    if (d && d < today)           return { label: 'Overdue',   color: '#ef4444' };
    var sevenDays = new Date(); sevenDays.setDate(sevenDays.getDate() + 7);
    if (d && new Date(d + 'T00:00:00') <= sevenDays) return { label: 'Due Soon', color: '#f97316' };
    return { label: ev.status || 'Pending', color: 'var(--muted)' };
  }

  // ── State ─────────────────────────────────────────────────────
  var calYear  = new Date().getFullYear();
  var calMonth = new Date().getMonth();
  var allEvents = [];        // full dataset from server (filtered by server-side params)
  var filteredEvents = [];   // after applying client-side filters (e.g. 'overdue' pseudo-status)
  var athleteList = [];      // [{id, name}] for filter dropdown
  var listMode = false;
  var apiBase  = '';
  var _drawerEvent = null;

  var MONTHS = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  var MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'];

  // ── Filter state ───────────────────────────────────────────────
  function getFilters() {
    var sel = function(id) { var el = document.getElementById(id); return el ? el.value : ''; };
    return {
      athlete: sel('cal-filter-athlete'),
      brand:   sel('cal-filter-brand'),
      status:  sel('cal-filter-status'),
    };
  }

  // Client-side pass through (server already applied athlete/brand/status filters).
  // Only 'overdue' is a client-side concept requiring post-load filtering.
  function applyFilters() {
    var f = getFilters();
    var today = new Date().toISOString().split('T')[0];
    filteredEvents = allEvents.filter(function(ev) {
      if (f.status === 'overdue') {
        var d = ev.event_date ? ev.event_date.split('T')[0] : null;
        if (!d || d >= today || ev.status === 'completed') return false;
      }
      return true;
    });
  }

  // ── Populate filter dropdowns ─────────────────────────────────
  function populateFilters() {
    var athleteSel = document.getElementById('cal-filter-athlete');
    if (athleteSel) {
      var curA = athleteSel.value;
      athleteSel.innerHTML = '<option value="">All Athletes</option>' +
        athleteList.map(function(a) {
          return '<option value="' + a.id + '"' + (a.id === curA ? ' selected' : '') + '>' + (a.name || a.id) + '</option>';
        }).join('');
    }
    var brandSel = document.getElementById('cal-filter-brand');
    if (brandSel) {
      var brands = [];
      var seen = {};
      for (var i = 0; i < allEvents.length; i++) {
        var b = allEvents[i].brand;
        if (b && !seen[b]) { seen[b] = true; brands.push(b); }
      }
      brands.sort();
      var curB = brandSel.value;
      brandSel.innerHTML = '<option value="">All Brands</option>' +
        brands.map(function(b) {
          return '<option value="' + b + '"' + (b === curB ? ' selected' : '') + '>' + b + '</option>';
        }).join('');
    }
  }

  // ── Build events-by-date lookup (ISO date → array of events) ─
  function buildByDate() {
    var map = {};
    for (var i = 0; i < filteredEvents.length; i++) {
      var ev = filteredEvents[i];
      var d  = ev.event_date ? ev.event_date.split('T')[0] : null;
      if (!d) continue;
      if (!map[d]) map[d] = [];
      map[d].push(ev);
    }
    return map;
  }

  // ── Shared label setter — called by both renderGrid and renderList ──────────
  function setMonthLabel() {
    var labelEl = document.getElementById('cal-month-label');
    if (labelEl) labelEl.textContent = MONTHS[calMonth] + ' ' + calYear;
  }

  // ── Render monthly grid ───────────────────────────────────────
  function renderGrid() {
    setMonthLabel();
    var grid = document.getElementById('cal-grid');
    if (!grid) return;

    var firstDay    = new Date(calYear, calMonth, 1).getDay();
    var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    var today       = new Date().toISOString().split('T')[0];
    var byDate      = buildByDate();

    // Cell height is enforced by grid-auto-rows:110px on #cal-grid.
    // Cells use overflow:hidden so they never expand and break the grid uniformity.
    var CELL = 'border-right:1px solid var(--border);border-bottom:1px solid var(--border);overflow:hidden;position:relative;';
    var html = '';

    // Blank leading cells
    for (var i = 0; i < firstDay; i++) {
      html += '<div style="' + CELL + 'background:var(--surface2);opacity:0.4"></div>';
    }

    for (var d = 1; d <= daysInMonth; d++) {
      var dateStr = calYear + '-' + pad(calMonth + 1) + '-' + pad(d);
      var dayEvs  = byDate[dateStr] || [];
      var isToday = dateStr === today;
      html += '<div onclick="NILCal.selectDay(\'' + dateStr + '\')" style="' + CELL + 'padding:4px 5px 16px;cursor:pointer;' + (isToday ? 'background:rgba(99,102,241,0.05)' : '') + '">';
      // Date number
      html += '<div style="font-size:10px;font-weight:' + (isToday ? '700' : '500') + ';color:' + (isToday ? 'var(--accent)' : 'var(--muted)') + ';margin-bottom:3px;line-height:1">' + (isToday ? '<span style="background:var(--accent);color:#fff;border-radius:50%;width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;font-size:10px">' + d + '</span>' : d) + '</div>';
      // Show up to 3 events — compact single-line pills
      var shown = dayEvs.slice(0, 3);
      for (var e = 0; e < shown.length; e++) {
        var ev  = shown[e];
        var clr = getEventColor(ev, today);
        var label = (ev.athlete_name ? ev.athlete_name.split(' ').pop() + ' · ' : '') + ev.title;
        html += '<div onclick="event.stopPropagation();NILCal.openDrawer(\'' + (ev.id||'').replace(/'/g,"\\'") + '\')" ' +
          'title="' + (ev.athlete_name||'') + ': ' + ev.title + '" ' +
          'style="font-size:9px;line-height:1.4;padding:1px 4px;border-radius:3px;' +
            'background:' + clr.bg + ';color:' + clr.fg + ';border-left:2px solid ' + clr.border + ';' +
            'margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer">' +
          label + '</div>';
      }
      // "+N more" pinned to bottom of cell
      if (dayEvs.length > 3) {
        html += '<div style="position:absolute;bottom:3px;left:5px;font-size:9px;color:var(--muted)">+' + (dayEvs.length - 3) + ' more</div>';
      }
      html += '</div>';
    }

    // Trailing blank cells
    var total = firstDay + daysInMonth;
    var trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (var i = 0; i < trailing; i++) {
      html += '<div style="' + CELL + 'background:var(--surface2);opacity:0.4"></div>';
    }
    grid.innerHTML = html;

    // Empty state
    var emptyEl = document.getElementById('cal-empty-state');
    if (emptyEl) emptyEl.style.display = allEvents.length === 0 ? 'block' : 'none';
  }

  // ── Render list view ──────────────────────────────────────────
  // Columns: Athlete | Brand | Deliverable | Due Date | Status | Actions
  function renderList() {
    setMonthLabel();
    var wrap = document.getElementById('cal-list-wrap');
    if (!wrap) return;
    if (!filteredEvents.length) {
      wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:32px">' +
        (allEvents.length === 0 ? 'No deliverables yet — upload a contract in the PDF Scanner to populate this calendar.' : 'No events match your current filters.') + '</div>';
      return;
    }
    var today = new Date().toISOString().split('T')[0];
    var sorted = filteredEvents.slice().sort(function(a,b) {
      return (a.event_date||'').localeCompare(b.event_date||'');
    });

    var rows = sorted.map(function(ev) {
      var clr = getEventColor(ev, today);
      var sc  = statusColor(ev, today);
      var d   = ev.event_date ? ev.event_date.split('T')[0] : '—';
      var safeId = (ev.id||'').replace(/'/g,"\\'");
      return '<tr style="border-bottom:1px solid var(--border);cursor:pointer" onclick="NILCal.openDrawer(\'' + safeId + '\')">' +
        // Athlete
        '<td style="padding:9px 12px;white-space:nowrap">' +
          '<div style="display:flex;align-items:center;gap:7px">' +
            '<div style="width:3px;height:28px;border-radius:2px;background:' + athleteColor(ev.athlete_id) + ';flex-shrink:0"></div>' +
            '<span style="font-size:12px;font-weight:600;color:var(--fg)">' + (ev.athlete_name || '—') + '</span>' +
          '</div>' +
        '</td>' +
        // Brand
        '<td style="padding:9px 12px;font-size:12px;color:var(--muted);white-space:nowrap">' + (ev.brand || '—') + '</td>' +
        // Deliverable title
        '<td style="padding:9px 12px;font-size:12px;color:var(--fg);max-width:280px">' +
          '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + ev.title + '</div>' +
        '</td>' +
        // Due date
        '<td style="padding:9px 12px;font-size:12px;white-space:nowrap;color:' + sc.color + ';font-weight:600">' + d + '</td>' +
        // Status (inline dropdown)
        '<td style="padding:9px 12px" onclick="event.stopPropagation()">' +
          '<select onchange="NILCal.setStatus(\'' + safeId + '\', this.value)" style="font-size:11px;border:1px solid var(--border);border-radius:5px;padding:3px 6px;background:var(--surface);color:' + sc.color + ';cursor:pointer;font-weight:600">' +
            '<option value="pending"' + ((!ev.status || ev.status === 'pending') ? ' selected' : '') + '>Pending</option>' +
            '<option value="in_progress"' + (ev.status === 'in_progress' ? ' selected' : '') + '>In Progress</option>' +
            '<option value="completed"' + (ev.status === 'completed' ? ' selected' : '') + '>Completed</option>' +
          '</select>' +
        '</td>' +
        // Actions
        '<td style="padding:9px 12px" onclick="event.stopPropagation()">' +
          '<button onclick="NILCal.openDrawer(\'' + safeId + '\')" style="font-size:11px;border:1px solid var(--border);border-radius:5px;padding:4px 10px;background:transparent;color:var(--text);cursor:pointer">View</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    wrap.innerHTML =
      '<div style="overflow-x:auto">' +
      '<table style="width:100%;border-collapse:collapse">' +
        '<thead>' +
          '<tr style="border-bottom:2px solid var(--border)">' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap">Athlete</th>' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Brand</th>' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Deliverable</th>' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;white-space:nowrap">Due Date</th>' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Status</th>' +
            '<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Actions</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '</div>';
  }

  // ── Day-click handler ─────────────────────────────────────────
  function selectDay(dateStr) {
    var dayEvs = filteredEvents.filter(function(ev) {
      return ev.event_date && ev.event_date.split('T')[0] === dateStr;
    });
    var panel = document.getElementById('cal-selected-events');
    var lbl   = document.getElementById('cal-selected-label');
    var list  = document.getElementById('cal-selected-list');
    if (!panel || !list) return;
    if (!dayEvs.length) { panel.style.display = 'none'; return; }
    var parts = dateStr.split('-');
    lbl.textContent = MONTHS_SHORT[parseInt(parts[1],10)-1] + ' ' + parts[2] + ', ' + parts[0] + ' — ' + dayEvs.length + ' deliverable' + (dayEvs.length > 1 ? 's' : '');
    var today = new Date().toISOString().split('T')[0];
    list.innerHTML = dayEvs.map(function(ev) {
      var clr = getEventColor(ev, today);
      var sc  = statusColor(ev, today);
      return '<div onclick="NILCal.openDrawer(\'' + (ev.id||'').replace(/'/g,"\\'") + '\')" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);cursor:pointer">' +
        '<span style="width:10px;height:10px;border-radius:50%;background:' + clr.border + ';flex-shrink:0"></span>' +
        '<div style="flex:1">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + ev.title + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + (ev.athlete_name||'') + ' · ' + (ev.brand||'') + '</div>' +
        '</div>' +
        '<div style="font-size:11px;color:' + sc.color + ';font-weight:600">' + sc.label + '</div>' +
      '</div>';
    }).join('');
    panel.style.display = 'block';
  }

  // ── Right-side event drawer ────────────────────────────────────
  function openDrawer(eventId) {
    var ev = null;
    for (var i = 0; i < allEvents.length; i++) {
      if (allEvents[i].id === eventId) { ev = allEvents[i]; break; }
    }
    if (!ev) return;
    _drawerEvent = ev;

    var drawer = document.getElementById('cal-drawer');
    if (!drawer) {
      drawer = document.createElement('div');
      drawer.id = 'cal-drawer';
      drawer.style.cssText = 'position:fixed;top:0;right:0;width:360px;max-width:95vw;height:100vh;background:var(--surface);border-left:1px solid var(--border);z-index:500;overflow-y:auto;transition:transform 0.25s ease;transform:translateX(100%);padding:0';
      document.body.appendChild(drawer);
    }

    var today   = new Date().toISOString().split('T')[0];
    var clr     = getEventColor(ev, today);
    var sc      = statusColor(ev, today);
    var d       = ev.event_date ? ev.event_date.split('T')[0] : '—';

    drawer.innerHTML =
      '<div style="height:4px;background:' + clr.border + '"></div>' +
      '<div style="padding:20px 22px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
          '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">Deliverable Detail</div>' +
          '<button onclick="NILCal.closeDrawer()" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✕ Close</button>' +
        '</div>' +

        '<div style="font-size:15px;font-weight:700;color:var(--fg);margin-bottom:16px;line-height:1.4">' + ev.title + '</div>' +

        '<div style="display:flex;flex-direction:column;gap:12px;margin-bottom:20px">' +
          '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<span style="color:var(--muted)">Athlete</span>' +
            '<span style="font-weight:600;color:' + athleteColor(ev.athlete_id) + '">' + (ev.athlete_name||'—') + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<span style="color:var(--muted)">Brand / Sponsor</span>' +
            '<span style="font-weight:600;color:var(--fg)">' + (ev.brand||'—') + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<span style="color:var(--muted)">Due Date</span>' +
            '<span style="font-weight:600;color:' + sc.color + '">' + d + '</span>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px">' +
            '<span style="color:var(--muted)">Status</span>' +
            '<span id="cal-drawer-status-badge" style="font-weight:700;color:' + sc.color + ';text-transform:capitalize">' + sc.label + '</span>' +
          '</div>' +
          (ev.contract_id ? '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<span style="color:var(--muted)">Contract</span>' +
            '<span style="color:var(--muted);font-size:11px;max-width:200px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (ev.filename || ev.contract_id || '—') + '</span>' +
          '</div>' : '') +
          (ev.recurrence_instance ? '<div style="display:flex;justify-content:space-between;font-size:12px">' +
            '<span style="color:var(--muted)">Type</span>' +
            '<span style="color:var(--accent);font-size:11px;padding:1px 6px;background:rgba(99,102,241,0.1);border-radius:3px">Recurring ↻</span>' +
          '</div>' : '') +
        '</div>' +

        (ev.status !== 'completed' ?
          '<button onclick="NILCal.markComplete(\'' + ev.id + '\')" style="width:100%;padding:11px;background:#22c55e;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;margin-bottom:10px">✓ Mark Complete</button>' :
          '<button onclick="NILCal.markPending(\'' + ev.id + '\')" style="width:100%;padding:11px;background:transparent;color:var(--muted);border:1px solid var(--border);border-radius:8px;font-size:13px;cursor:pointer;margin-bottom:10px">↩ Mark Pending</button>'
        ) +
      '</div>';

    setTimeout(function() { drawer.style.transform = 'translateX(0)'; }, 10);
  }

  function closeDrawer() {
    var drawer = document.getElementById('cal-drawer');
    if (drawer) drawer.style.transform = 'translateX(100%)';
    _drawerEvent = null;
  }

  async function markComplete(eventId) {
    await _patchEventStatus(eventId, 'completed', true);
  }

  async function markPending(eventId) {
    await _patchEventStatus(eventId, 'pending', true);
  }

  // setStatus — called from inline list-view dropdown; updates without reopening drawer
  async function setStatus(eventId, newStatus) {
    await _patchEventStatus(eventId, newStatus, false);
  }

  async function _patchEventStatus(eventId, status, reopenDrawer) {
    var ev = null;
    for (var i = 0; i < allEvents.length; i++) {
      if (allEvents[i].id === eventId) { ev = allEvents[i]; break; }
    }
    if (!ev) return;

    try {
      var r = await fetch(apiBase + '/api/athletes/' + ev.athlete_id + '/calendar/' + eventId, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: status }),
      });
      if (!r.ok) throw new Error('Server error ' + r.status);
      // Update local state
      for (var i = 0; i < allEvents.length; i++) {
        if (allEvents[i].id === eventId) { allEvents[i].status = status; break; }
      }
      applyFilters();
      listMode ? renderList() : renderGrid();
      if (reopenDrawer) openDrawer(eventId);
    } catch(e) {
      console.error('[NILCal] Failed to update status', e);
    }
  }

  // ── Fetch ALL agent events from server, applying server-side filters ──────
  // Bug 2 fix: no longer month-scoped; filter params sent as query string.
  // Month navigation is now purely client-side (no re-fetch needed).
  async function loadData() {
    var f = getFilters();
    var url = apiBase + '/api/agent/calendar';
    var params = [];
    if (f.athlete) params.push('athlete_id=' + encodeURIComponent(f.athlete));
    if (f.brand)   params.push('brand='      + encodeURIComponent(f.brand));
    // 'overdue' is a client-side concept; don't send it to the server
    if (f.status && f.status !== 'overdue') params.push('status=' + encodeURIComponent(f.status));
    if (params.length) url += '?' + params.join('&');

    console.log('[NILCal] loadData', url);
    try {
      var r = await fetch(url, { credentials: 'include' });
      if (!r.ok) { console.error('[NILCal] load failed', r.status); return; }
      var data = await r.json();
      allEvents   = data.events || [];
      athleteList = data.athleteList || [];
      console.log('[NILCal] loaded', allEvents.length, 'events,', athleteList.length, 'athletes');
      populateFilters();
      applyFilters();

      // Auto-navigate to the most relevant month if the current month is empty.
      // Only ever navigate to the current month or a FUTURE month — never jump
      // backward to a past year (which would happen if stale 2025 data existed).
      // Priority: earliest upcoming event. Past events stay put; agent navigates back manually.
      if (!listMode && filteredEvents.length > 0) {
        var todayStr = new Date().toISOString().split('T')[0];
        var currentMonthHasEvents = filteredEvents.some(function(ev) {
          if (!ev.event_date) return false;
          var d = ev.event_date.split('T')[0];
          return d.startsWith(calYear + '-' + pad(calMonth + 1));
        });
        if (!currentMonthHasEvents) {
          // Find the first upcoming (future) event — never a past-year event
          var target = null;
          for (var i = 0; i < filteredEvents.length; i++) {
            var evDate = filteredEvents[i].event_date ? filteredEvents[i].event_date.split('T')[0] : null;
            if (!evDate) continue;
            if (evDate >= todayStr) { target = evDate; break; }  // first upcoming only
          }
          // Only navigate if the target is in the current year or later
          if (target) {
            var targetYear = parseInt(target.split('-')[0]);
            if (targetYear >= new Date().getFullYear()) {
              calYear  = targetYear;
              calMonth = parseInt(target.split('-')[1]) - 1;
              console.log('[NILCal] auto-navigated to', MONTHS[calMonth], calYear);
            }
          }
        }
      }

      listMode ? renderList() : renderGrid();
    } catch(e) {
      console.error('[NILCal] load error', e);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────
  function pad(n) { return String(n).padStart(2, '0'); }

  // ── Public API ────────────────────────────────────────────────
  return {
    load: function(athletes, base) {
      apiBase = base || apiBase;
      return loadData();
    },
    reload: function() { return loadData(); },

    // Month navigation — client-side only (no re-fetch); all events already loaded.
    prevMonth: function() {
      calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; }
      applyFilters(); listMode ? renderList() : renderGrid();
    },
    nextMonth: function() {
      calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; }
      applyFilters(); listMode ? renderList() : renderGrid();
    },
    today: function() {
      calYear = new Date().getFullYear(); calMonth = new Date().getMonth();
      applyFilters(); listMode ? renderList() : renderGrid();
    },

    // Bug 2 fix: applyFilter now re-fetches from server with current filter params
    // so athlete/brand/status dropdowns actually filter the data.
    applyFilter: function() { return loadData(); },

    toggleListMode: function() {
      listMode = !listMode;
      var btn = document.getElementById('cal-list-toggle');
      if (btn) btn.textContent = listMode ? '📅 Month View' : '☰ List View';
      var gridWrap = document.getElementById('cal-grid-wrap');
      var listWrap = document.getElementById('cal-list-wrap');
      if (gridWrap) gridWrap.style.display = listMode ? 'none' : 'block';
      if (listWrap) listWrap.style.display = listMode ? 'block' : 'none';
      listMode ? renderList() : renderGrid();
    },
    selectDay: selectDay,
    openDrawer: openDrawer,
    closeDrawer: closeDrawer,
    markComplete: markComplete,
    markPending: markPending,
    setStatus: setStatus,
    // Legacy shims (keep these so old references don't crash)
    openAddModal: function() {},
    saveEvent: function() {},
    deleteEvent: function() {},
    showEvents: selectDay,
    initLabel: setMonthLabel,
  };
})();
