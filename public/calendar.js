var NILCal = (function() {
  var calYear = new Date().getFullYear();
  var calMonth = new Date().getMonth();
  var allDeals = [];
  var customEvents = [];
  var eventsByDate = {};
  var apiBase = '';

  var stageColors = { Closing: '#4ade80', Negotiating: '#C8F135', 'Outreach Sent': '#60a5fa', Prospecting: '#6b7280' };
  var stageProb = { Closing: 85, Negotiating: 50, 'Outreach Sent': 25, Prospecting: 10 };
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function buildEventsByDate() {
    eventsByDate = {};
    allDeals.forEach(function(deal) {
      var color = stageColors[deal.stage] || '#6b7280';
      var created = new Date(deal.updatedAt || deal.createdAt);
      var deadlines = [];
      if (deal.stage === 'Negotiating') {
        deadlines.push({ days: 2, label: 'Counter offer: ' + deal.brand, color: color, type: 'deal' });
        deadlines.push({ days: 7, label: 'Follow-up: ' + deal.brand, color: color, type: 'deal' });
      } else if (deal.stage === 'Closing') {
        deadlines.push({ days: 3, label: 'Contract due: ' + deal.brand, color: color, type: 'deal' });
      } else if (deal.stage === 'Outreach Sent') {
        deadlines.push({ days: 7, label: 'Follow-up: ' + deal.brand, color: color, type: 'deal' });
      }
      deadlines.forEach(function(dl) {
        var d = new Date(created.getTime() + dl.days * 86400000);
        var key = d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
        if (!eventsByDate[key]) eventsByDate[key] = [];
        eventsByDate[key].push({ label: dl.label, color: dl.color, type: 'deal', deal: deal });
      });
    });
    customEvents.forEach(function(ev) {
      var key = ev.date;
      if (!eventsByDate[key]) eventsByDate[key] = [];
      eventsByDate[key].push({ label: ev.title, color: '#a78bfa', type: 'custom', id: ev.id, notes: ev.notes });
    });
  }

  function renderGrid() {
    var labelEl = document.getElementById('cal-month-label');
    if (labelEl) labelEl.textContent = months[calMonth] + ' ' + calYear;
    var grid = document.getElementById('cal-grid');
    if (!grid) return;
    var firstDay = new Date(calYear, calMonth, 1).getDay();
    var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
    var today = new Date();
    var html = '';
    for (var i = 0; i < firstDay; i++) {
      html += '<div style="min-height:80px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--surface2);opacity:0.3"></div>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var key = calYear + '-' + (calMonth+1) + '-' + d;
      var isToday = (calYear === today.getFullYear() && calMonth === today.getMonth() && d === today.getDate());
      var events = eventsByDate[key] || [];
      var evHtml = '';
      var shown = events.slice(0, 2);
      for (var e = 0; e < shown.length; e++) {
        var ev = shown[e];
        evHtml += '<div data-key="' + key + '" onclick="event.stopPropagation();NILCal.showEvents(this.getAttribute(\'data-key\'))" style="font-size:9px;padding:2px 5px;border-radius:3px;background:' + ev.color + ';color:#000;margin-top:2px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600">' + ev.label + '</div>';
      }
      if (events.length > 2) evHtml += '<div style="font-size:9px;color:var(--muted);margin-top:2px">+' + (events.length-2) + ' more</div>';
      html += '<div onclick="NILCal.openAddModal(\'' + key + '\')" style="min-height:80px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px;cursor:pointer;' + (isToday ? 'background:rgba(200,241,53,0.05)' : '') + '">';
      html += '<div style="font-size:11px;font-weight:' + (isToday ? '700' : '400') + ';color:' + (isToday ? 'var(--accent)' : 'var(--muted)') + ';margin-bottom:2px">' + d + '</div>';
      html += evHtml + '</div>';
    }
    var total = firstDay + daysInMonth;
    var remaining = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (var i = 0; i < remaining; i++) {
      html += '<div style="min-height:80px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--surface2);opacity:0.3"></div>';
    }
    grid.innerHTML = html;
  }

  function showEvents(key) {
    var events = eventsByDate[key] || [];
    if (!events.length) return;
    var parts = key.split('-');
    var label = monthsShort[parseInt(parts[1])-1] + ' ' + parts[2] + ', ' + parts[0];
    var el = document.getElementById('cal-selected-label');
    var list = document.getElementById('cal-selected-list');
    var panel = document.getElementById('cal-selected-events');
    if (!el || !list || !panel) return;
    el.textContent = label;
    var html = '';
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      html += '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">';
      html += '<span style="width:10px;height:10px;border-radius:50%;background:' + ev.color + ';flex-shrink:0"></span>';
      html += '<div style="flex:1"><div style="font-size:12px;font-weight:600;color:var(--text)">' + ev.label + '</div>';
      if (ev.type === 'deal') {
        html += '<div style="font-size:11px;color:var(--muted)">' + ev.deal._athleteName + ' · ' + ev.deal.stage + ' · $' + (ev.deal.value||0).toLocaleString() + '</div>';
      } else if (ev.notes) {
        html += '<div style="font-size:11px;color:var(--muted)">' + ev.notes + '</div>';
      }
      html += '</div>';
      if (ev.type === 'custom') {
        html += '<button data-id="' + ev.id + '" onclick="NILCal.deleteEvent(this.getAttribute(\'data-id\'))" style="background:transparent;border:1px solid rgba(239,68,68,0.3);color:#ef4444;border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer">Delete</button>';
      }
      html += '</div>';
    }
    list.innerHTML = html;
    panel.style.display = 'block';
  }

  function renderDeadlines() {
    var deadlines = [];
    for (var i = 0; i < allDeals.length; i++) {
      var deal = allDeals[i];
      var color = stageColors[deal.stage] || '#6b7280';
      var prob = stageProb[deal.stage] || 10;
      var created = new Date(deal.updatedAt || deal.createdAt);
      if (deal.stage === 'Negotiating') {
        deadlines.push({ deal: deal, date: new Date(created.getTime()+2*86400000), label: 'Counter offer deadline', color: color, prob: prob });
        deadlines.push({ deal: deal, date: new Date(created.getTime()+7*86400000), label: 'Follow-up call', color: color, prob: prob });
      } else if (deal.stage === 'Closing') {
        deadlines.push({ deal: deal, date: new Date(created.getTime()+3*86400000), label: 'Contract due', color: color, prob: prob });
      } else if (deal.stage === 'Outreach Sent') {
        deadlines.push({ deal: deal, date: new Date(created.getTime()+7*86400000), label: 'Follow-up', color: color, prob: prob });
      }
    }
    deadlines.sort(function(a,b) { return a.date - b.date; });
    var now = new Date();
    var html = '';
    var shown = deadlines.slice(0, 8);
    for (var i = 0; i < shown.length; i++) {
      var dl = shown[i];
      var diff = Math.ceil((dl.date - now) / 86400000);
      var urgColor = diff < 0 ? '#ef4444' : diff === 0 ? '#f97316' : diff <= 2 ? '#f97316' : '#C8F135';
      var urgLabel = diff < 0 ? Math.abs(diff) + 'd overdue' : diff === 0 ? 'Today' : diff + 'd left';
      html += '<div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ' + dl.color + ';border-radius:var(--r-sm);padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px">';
      html += '<div style="flex:1"><div style="font-size:12px;font-weight:600;color:var(--text)">' + dl.label + '</div>';
      html += '<div style="font-size:11px;color:var(--muted)">' + dl.deal._athleteName + ' · ' + dl.deal.brand + ' · ' + dl.deal.stage + '</div></div>';
      html += '<div style="font-size:11px;font-weight:700;color:' + urgColor + '">' + urgLabel + '</div></div>';
    }
    var el = document.getElementById('cal-deadlines');
    if (el) el.innerHTML = html || '<div style="color:var(--muted);font-size:12px">No upcoming deadlines.</div>';
  }

  function openAddModal(key) {
    var existing = document.getElementById('cal-add-modal');
    if (existing) existing.remove();
    var parts = key.split('-');
    var label = monthsShort[parseInt(parts[1])-1] + ' ' + parts[2] + ', ' + parts[0];
    var modal = document.createElement('div');
    modal.id = 'cal-add-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = '<div style="background:#111110;border:1px solid rgba(255,255,255,0.12);border-radius:16px;padding:32px;width:100%;max-width:400px;position:relative">' +
      '<button onclick="document.getElementById(\'cal-add-modal\').remove()" style="position:absolute;top:12px;right:16px;background:transparent;border:none;color:rgba(240,237,230,0.4);font-size:20px;cursor:pointer">x</button>' +
      '<div style="font-size:11px;color:#C8F135;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.1em">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:#F0EDE6;margin-bottom:20px">Add Event</div>' +
      '<div style="margin-bottom:14px"><label style="font-size:10px;color:rgba(240,237,230,0.4);text-transform:uppercase;letter-spacing:0.1em;display:block;margin-bottom:6px">Event Title *</label>' +
      '<input id="cal-ev-title" type="text" placeholder="e.g. Call with Nike rep" style="width:100%;padding:10px 14px;background:#1A1A18;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#F0EDE6;font-size:13px;box-sizing:border-box"></div>' +
      '<div style="margin-bottom:20px"><label style="font-size:10px;color:rgba(240,237,230,0.4);text-transform:uppercase;letter-spacing:0.1em;display:block;margin-bottom:6px">Notes</label>' +
      '<input id="cal-ev-notes" type="text" placeholder="Optional notes" style="width:100%;padding:10px 14px;background:#1A1A18;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#F0EDE6;font-size:13px;box-sizing:border-box"></div>' +
      '<div style="margin-bottom:20px"><label style="font-size:10px;color:rgba(240,237,230,0.4);text-transform:uppercase;letter-spacing:0.1em;display:block;margin-bottom:6px">Alert Reminder</label>' +
      '<select id="cal-ev-reminder" style="width:100%;padding:10px 14px;background:#1A1A18;border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#F0EDE6;font-size:13px;box-sizing:border-box">' +
      '<option value="">No reminder</option>' +
      '<option value="0">On the day</option>' +
      '<option value="1">1 day before</option>' +
      '<option value="2">2 days before</option>' +
      '<option value="7">1 week before</option>' +
      '</select></div>' +
      '<button onclick="NILCal.saveEvent(\'' + key + '\')" style="width:100%;padding:13px;background:#C8F135;color:#000;border:none;border-radius:40px;font-size:13px;font-weight:700;cursor:pointer">Add Event</button>' +
    '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    setTimeout(function() { var t = document.getElementById('cal-ev-title'); if (t) t.focus(); }, 100);
  }

  async function saveEvent(key) {
    var title = document.getElementById('cal-ev-title').value.trim();
    var notes = document.getElementById('cal-ev-notes').value.trim();
    if (!title) { alert('Please enter an event title'); return; }
    try {
      var r = await fetch(apiBase + '/api/calendar/events', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        var reminderEl = document.getElementById('cal-ev-reminder');
        var reminderDays = reminderEl ? reminderEl.value : '';
        body: JSON.stringify({ title: title, date: key, notes: notes, reminderDays: reminderDays })
      });
      var data = await r.json();
      if (data.event) {
        customEvents.push(data.event);
        buildEventsByDate();
        renderGrid();
        document.getElementById('cal-add-modal').remove();
        checkCalendarNotifications();
      }
    } catch(e) { alert('Error saving event'); }
  }

  async function deleteEvent(id) {
    if (!confirm('Delete this event?')) return;
    try {
      await fetch(apiBase + '/api/calendar/events/' + id, { method: 'DELETE' });
      customEvents = customEvents.filter(function(e) { return String(e.id) !== String(id); });
      buildEventsByDate();
      renderGrid();
      document.getElementById('cal-selected-events').style.display = 'none';
    } catch(e) { alert('Error deleting event'); }
  }

  function checkCalendarNotifications() {
    var now = new Date();
    customEvents.forEach(function(ev) {
      if (!ev.reminderdays && ev.reminderdays !== 0) return;
      var parts = ev.date.split('-');
      var eventDate = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]));
      var reminderDate = new Date(eventDate.getTime() - parseInt(ev.reminderdays) * 86400000);
      var diff = Math.ceil((eventDate - now) / 86400000);
      var reminderDiff = Math.ceil((reminderDate - now) / 86400000);
      if (reminderDiff <= 0 && diff >= 0) {
        var urgency = diff === 0 ? 'today' : diff <= 2 ? 'urgent' : 'soon';
        if (typeof addNotification === 'function') {
          addNotification('cal-' + ev.id, ev.title, diff === 0 ? 'Today' : diff + ' days away', urgency);
        }
      }
    });
  }

  return {
    load: async function(athletes, base) {
      apiBase = base;
      allDeals = [];
      for (var i = 0; i < athletes.length; i++) {
        try {
          var r = await fetch(base + '/api/athletes/' + athletes[i].id + '/deals');
          var deals = await r.json();
          for (var j = 0; j < deals.length; j++) {
            deals[j]._athleteName = athletes[i].name;
            allDeals.push(deals[j]);
          }
        } catch(e) {}
      }
      try {
        var er = await fetch(base + '/api/calendar/events');
        var ed = await er.json();
        customEvents = ed.events || [];
      } catch(e) { customEvents = []; }
      buildEventsByDate();
      renderGrid();
      renderDeadlines();
      checkCalendarNotifications();
    },
    prevMonth: function() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderGrid(); },
    nextMonth: function() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderGrid(); },
    today: function() { calYear = new Date().getFullYear(); calMonth = new Date().getMonth(); renderGrid(); },
    showEvents: showEvents,
    openAddModal: openAddModal,
    saveEvent: saveEvent,
    deleteEvent: deleteEvent
  };
})();
