(function() {
  window.NILAnalytics = {
    load: async function(athletes, apiBase) {
      var container = document.getElementById('analytics-body');
      if (!container) return;
      container.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:40px">Loading analytics...</div>';

      var allDeals = [];
      for (var i = 0; i < athletes.length; i++) {
        try {
          var r = await fetch(apiBase + '/api/athletes/' + athletes[i].id + '/deals');
          var deals = await r.json();
          deals.forEach(function(d) {
            d._athleteName = athletes[i].name;
            d._sport = athletes[i].sport;
            allDeals.push(d);
          });
        } catch(e) {}
      }

      var closed = allDeals.filter(function(d) { return d.stage === 'Closed'; });
      var active = allDeals.filter(function(d) { return d.stage !== 'Closed'; });
      var totalValue = allDeals.reduce(function(s,d) { return s + (d.value||0); }, 0);
      var closedValue = closed.reduce(function(s,d) { return s + (d.value||0); }, 0);
      var avgDeal = closed.length ? Math.round(closedValue / closed.length) : 0;
      var totalComm = closedValue * 0.15;

      // Stage breakdown
      var stages = ['Prospecting','Outreach Sent','Negotiating','Closing','Closed'];
      var stageCounts = {};
      stages.forEach(function(s) {
        stageCounts[s] = allDeals.filter(function(d) { return d.stage === s; }).length;
      });

      // Sport breakdown
      var sportMap = {};
      allDeals.forEach(function(d) {
        var sp = d._sport || 'Unknown';
        if (!sportMap[sp]) sportMap[sp] = { count: 0, value: 0 };
        sportMap[sp].count++;
        sportMap[sp].value += (d.value||0);
      });

      // Monthly closed deals
      var monthMap = {};
      closed.forEach(function(d) {
        var date = new Date(d.updatedAt || d.createdAt);
        var key = date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0');
        if (!monthMap[key]) monthMap[key] = { count: 0, value: 0 };
        monthMap[key].count++;
        monthMap[key].value += (d.value||0);
      });
      var months = Object.keys(monthMap).sort();

      container.innerHTML =
        // KPI cards
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px">' +
          kpi('Total Pipeline', '$' + (totalValue/1000).toFixed(0) + 'K', 'across all deals') +
          kpi('Closed Deals', closed.length, 'total closed') +
          kpi('Avg Deal Value', '$' + avgDeal.toLocaleString(), 'per closed deal') +
          kpi('Est. Commission', '$' + Math.round(totalComm).toLocaleString(), 'at 15% rate') +
        '</div>' +

        // Pipeline funnel
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">' +
          '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:16px">Pipeline Funnel</div>' +
            stages.map(function(s) {
              var count = stageCounts[s] || 0;
              var max = Math.max.apply(null, stages.map(function(st) { return stageCounts[st]||0; })) || 1;
              var pct = Math.round((count/max)*100);
              var colors = { 'Prospecting':'#6b7280','Outreach Sent':'#60a5fa','Negotiating':'#C8F135','Closing':'#4ade80','Closed':'#a78bfa' };
              return '<div style="margin-bottom:10px">' +
                '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);margin-bottom:4px">' +
                  '<span>' + s + '</span><span style="font-weight:700;color:var(--text)">' + count + '</span>' +
                '</div>' +
                '<div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden">' +
                  '<div style="height:100%;width:' + pct + '%;background:' + (colors[s]||'#6b7280') + ';border-radius:3px;transition:width 0.5s"></div>' +
                '</div></div>';
            }).join('') +
          '</div>' +

          // Sport breakdown
          '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:16px">Deals by Sport</div>' +
            (Object.keys(sportMap).length ? Object.entries(sportMap).sort(function(a,b) { return b[1].value-a[1].value; }).map(function(entry) {
              var sport = entry[0], data = entry[1];
              return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
                '<div><div style="font-size:12px;font-weight:600;color:var(--text)">' + sport + '</div>' +
                '<div style="font-size:10px;color:var(--muted)">' + data.count + ' deal' + (data.count!==1?'s':'') + '</div></div>' +
                '<div style="font-size:12px;font-weight:700;color:var(--accent)">$' + (data.value/1000).toFixed(0) + 'K</div>' +
              '</div>';
            }).join('') : '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px">No deals yet</div>') +
          '</div>' +
        '</div>' +

        // Monthly chart
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:20px">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:16px">Closed Deals Over Time</div>' +
          (months.length ? (function() {
            var maxVal = Math.max.apply(null, months.map(function(m) { return monthMap[m].value; })) || 1;
            return '<div style="display:flex;align-items:flex-end;gap:8px;height:120px;padding-bottom:24px;position:relative">' +
              months.map(function(m) {
                var pct = Math.round((monthMap[m].value/maxVal)*100);
                var label = m.split('-')[1] + '/' + m.split('-')[0].slice(2);
                return '<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">' +
                  '<div style="font-size:9px;color:var(--muted)">$' + (monthMap[m].value/1000).toFixed(0) + 'K</div>' +
                  '<div style="width:100%;background:var(--accent);border-radius:3px 3px 0 0;height:' + Math.max(pct,4) + '%" title="' + label + '"></div>' +
                  '<div style="font-size:9px;color:var(--muted)">' + label + '</div>' +
                '</div>';
              }).join('') +
            '</div>';
          })() : '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px">No closed deals yet — close some deals to see trends</div>') +
        '</div>';
    }
  };

  function kpi(label, value, sub) {
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px">' +
      '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:6px">' + label + '</div>' +
      '<div style="font-size:24px;font-weight:700;color:var(--accent);margin-bottom:2px">' + value + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + sub + '</div>' +
    '</div>';
  }
})();
