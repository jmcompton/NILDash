(function() {
  function init() {
    var topbar = document.getElementById('aiStatus');
    if (!topbar) return;

    // Create search container
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;margin-right:8px';

    var input = document.createElement('input');
    input.id = 'global-search';
    input.type = 'text';
    input.placeholder = 'Search...';
    input.style.cssText = 'padding:6px 12px 6px 28px;background:var(--surface2);border:1px solid var(--border);border-radius:40px;color:var(--text);font-size:11px;font-family:var(--mono);width:180px;outline:none';

    var icon = document.createElement('span');
    icon.innerHTML = '&#128269;';
    icon.style.cssText = 'position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:11px;pointer-events:none';

    var dropdown = document.createElement('div');
    dropdown.id = 'search-results';
    dropdown.style.cssText = 'display:none;position:absolute;top:36px;left:0;width:280px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);box-shadow:0 8px 24px rgba(0,0,0,0.3);z-index:300;max-height:320px;overflow-y:auto';

    wrap.appendChild(icon);
    wrap.appendChild(input);
    wrap.appendChild(dropdown);

    // Insert before aiStatus
    topbar.parentNode.insertBefore(wrap, topbar);

    input.addEventListener('input', function() { doSearch(this.value, dropdown); });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { this.value = ''; dropdown.style.display = 'none'; }
    });

    document.addEventListener('click', function(e) {
      if (!wrap.contains(e.target)) dropdown.style.display = 'none';
    });
  }

  function doSearch(query, dropdown) {
    if (!query || query.length < 2) { dropdown.style.display = 'none'; return; }
    var q = query.toLowerCase();
    var hits = [];
    var athletes = window.athletes || [];

    athletes.forEach(function(a) {
      if ((a.name||'').toLowerCase().includes(q) ||
          (a.sport||'').toLowerCase().includes(q) ||
          (a.school||'').toLowerCase().includes(q) ||
          (a.position||'').toLowerCase().includes(q)) {
        hits.push({ icon: '👤', label: a.name, sub: (a.sport||'') + (a.position ? ' · ' + a.position : '') + ' · ' + (a.school||''), action: function() {
          if (window.setActiveAthlete) setActiveAthlete(a.id);
        }});
      }
    });

    var deals = window._pipelineDeals || [];
    deals.forEach(function(d) {
      if ((d.brand||'').toLowerCase().includes(q) ||
          (d.athleteName||'').toLowerCase().includes(q) ||
          (d.stage||'').toLowerCase().includes(q)) {
        hits.push({ icon: '💼', label: (d.brand||'Deal') + ' — ' + (d.athleteName||''), sub: (d.stage||'') + ' · $' + (d.value||0).toLocaleString(), action: function() {
          if (window.showView) showView('pipeline', document.querySelectorAll('.nav-item')[4]);
        }});
      }
    });

    if (!hits.length) {
      dropdown.innerHTML = '<div style="padding:16px;font-size:12px;color:var(--muted);text-align:center">No results for "' + query + '"</div>';
      dropdown.style.display = 'block';
      return;
    }

    dropdown.innerHTML = '';
    hits.slice(0, 8).forEach(function(h) {
      var row = document.createElement('div');
      row.style.cssText = 'padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px';
      row.innerHTML = '<span style="font-size:14px">' + h.icon + '</span>' +
        '<div><div style="font-size:12px;font-weight:600;color:var(--text)">' + h.label + '</div>' +
        '<div style="font-size:10px;color:var(--muted)">' + h.sub + '</div></div>';
      row.addEventListener('mouseover', function() { this.style.background = 'var(--surface2)'; });
      row.addEventListener('mouseout', function() { this.style.background = ''; });
      row.addEventListener('click', function() {
        dropdown.style.display = 'none';
        document.getElementById('global-search').value = '';
        h.action();
      });
      dropdown.appendChild(row);
    });
    dropdown.style.display = 'block';
  }

  // Wait for app to load then init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 500); });
  } else {
    setTimeout(init, 500);
  }
})();
