// NILDash Calendar — standalone module
var NILCal = (function() {
  var calYear = new Date().getFullYear();
  var calMonth = new Date().getMonth();
  var allDeals = [];
  var eventsByDate = {};

  var stageColors = { Closing: '#4ade80', Negotiating: '#C8F135', 'Outreach Sent': '#60a5fa', Prospecting: '#6b7280' };
  var stageProb = { Closing: 85, Negotiating: 50, 'Outreach Sent': 25, Prospecting: 10 };
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function buildEventsByDate(deals) {
    eventsByDate = {};
    deals.forEach(function(deal) {
      var color = stageColors[deal.stage] || '#6b7280';
      var created = new Date(deal.updatedAt || deal.createdAt);
      var deadlines = [];
      if (deal.stage === 'Negotiating') {
        deadlines.push({ days: 2, label: 'Counter offer: ' + deal.brand, color: color });
        deadlines.push({ days: 7, label: 'Follow-up: ' + deal.brand, color: color });
      } else if (deal.stage === 'Closing') {
        deadlines.push({ days: 3, label: 'Contract due: ' + deal.brand, color: color });
      } else if (deal.stage === 'Outreach Sent') {
        deadlines.push({ days: 7, label: 'Follow-up: ' + deal.brand, color: color });
      }
      deadlines.forEach(function(dl) {
        var d = new Date(created.getTime() + dl.days * 86400000);
        var key = d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
        if (!eventsByDate[key]) eventsByDate[key] = [];
        eventsByDate[key].push({ label: dl.label, color: dl.color, deal: deal });
      });
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
        evHtml += '<div data-key="' + key + '" onclick="NILCal.showEvents(this.getAttribute(\'data-key\'))" style="font-size:9px;padding:2px 5px;border-radius:3px;background:' + ev.color + ';color:#000;margin-top:2px;cursor:pointer;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-weight:600">' + ev.label + '</div>';
      }
      if (events.length > 2) evHtml += '<div style="font-size:9px;color:var(--muted);margin-top:2px">+' + (events.length-2) + ' more</div>';
      html += '<div style="min-height:80px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);padding:6px;' + (isToday ? 'background:rgba(200,241,53,0.05)' : '') + '">';
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
      html += '<div><div style="font-size:12px;font-weight:600;color:var(--text)">' + ev.label + '</div>';
      html += '<div style="font-size:11px;color:var(--muted)">' + ev.deal._athleteName + ' · ' + ev.deal.stage + ' · $' + (ev.deal.value||0).toLocaleString() + '</div></div></div>';
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

  return {
    load: async function(athletes, apiBase) {
      allDeals = [];
      for (var i = 0; i < athletes.length; i++) {
        try {
          var r = await fetch(apiBase + '/api/athletes/' + athletes[i].id + '/deals');
          var deals = await r.json();
          for (var j = 0; j < deals.length; j++) {
            deals[j]._athleteName = athletes[i].name;
            allDeals.push(deals[j]);
          }
        } catch(e) {}
      }
      buildEventsByDate(allDeals);
      renderGrid();
      renderDeadlines();
    },
    prevMonth: function() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderGrid(); },
    nextMonth: function() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderGrid(); },
    today: function() { calYear = new Date().getFullYear(); calMonth = new Date().getMonth(); renderGrid(); },
    showEvents: showEvents
  };
})();
