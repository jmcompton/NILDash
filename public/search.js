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
    var athletes = window.athletes || (typeof athletes !== 'undefined' ? athletes : []);
    // Try to get athletes from the app scope if not on window
    if (!athletes.length && typeof getAthletes === 'function') athletes = getAthletes();

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

// Dynamic AI Command prompts based on active client
function updateDynamicPrompts() {
  var container = document.getElementById('dynamic-prompts');
  if (!container) return;
  var athletes = window.athletes || [];
  var athleteId = window.selectedAthleteId;
  var ath = athletes.find(function(a) { return a.id === athleteId; });
  if (!ath) return;

  var deals = (window._pipelineDeals || []).filter(function(d) { return d.athleteId === athleteId; });
  var negotiating = deals.find(function(d) { return d.stage === 'Negotiating'; });
  var closing = deals.find(function(d) { return d.stage === 'Closing'; });
  var outreach = deals.find(function(d) { return d.stage === 'Outreach Sent'; });

  var prompts = [];

  // Context-aware prompts based on active deals
  if (negotiating) {
    prompts.push({ label: 'Counter ' + negotiating.brand, text: 'Give me word-for-word counter offer language for my ' + negotiating.brand + ' negotiation for ' + ath.name + '. Their offer is $' + (negotiating.value||0).toLocaleString() + '. What should I push back to?' });
  }
  if (closing) {
    prompts.push({ label: 'Close ' + closing.brand, text: 'What are the key terms I need to verify before signing the ' + closing.brand + ' deal for ' + ath.name + '?' });
  }
  if (outreach) {
    prompts.push({ label: 'Follow up ' + outreach.brand, text: 'Write a follow-up message to ' + outreach.brand + ' about ' + ath.name + '. We sent outreach and have not heard back.' });
  }

  // Always include sport-specific prompts
  prompts.push({ label: '10 Best Deals', text: 'What are the 10 best NIL deals for ' + ath.name + ', a ' + (ath.sport||'athlete') + ' at ' + (ath.school||'their school') + '? Rank by realistic close probability.' });
  prompts.push({ label: 'What To Charge', text: 'What should I charge for an IG Reel deal for ' + ath.name + '? They have ' + (ath.instagram||0).toLocaleString() + ' Instagram followers and ' + (ath.tiktok||0).toLocaleString() + ' TikTok followers with ' + (ath.engagement||0) + '% engagement.' });
  prompts.push({ label: 'Get Leverage', text: 'Give me word-for-word negotiation leverage I can use on a call today for ' + ath.name + '. Sport: ' + (ath.sport||'') + ', School: ' + (ath.school||'') + '.' });
  prompts.push({ label: 'Walk Away Analysis', text: 'Which deals should I walk away from for ' + ath.name + ' and why? Give me clear reasoning.' });

  container.innerHTML = prompts.slice(0, 5).map(function(p) {
    return '<span class="qb" onclick="setPrompt(' + JSON.stringify(p.text) + ')">' + p.label + '</span>';
  }).join('');
}

// Update prompts when athlete changes
var _origOnAthleteChange = window.onAthleteChange;
setTimeout(function() {
  var select = document.getElementById('activeAthlete');
  if (select) {
    select.addEventListener('change', function() {
      setTimeout(updateDynamicPrompts, 300);
    });
  }
  updateDynamicPrompts();
}, 1000);
