

function openClientProfile(id) {
  const a = window.athletes ? window.athletes.find(x => x.id === id) : null;
  if (!a) return;

  const deals = JSON.parse(localStorage.getItem('nilDashDeals') || '[]')
    .filter(d => d.athleteId === id || d.athlete === a.name);

  const contracts = JSON.parse(localStorage.getItem('nilDashContracts') || '[]')
    .filter(c => c.athleteId === id || c.athlete === a.name);

  const totalNIL = deals.reduce((sum, d) => {
    return sum + (parseFloat((d.value||'').toString().replace(/[^0-9.]/g,'')) || 0);
  }, 0);

  const commission = deals.reduce((sum, d) => {
    const val = parseFloat((d.value||'').toString().replace(/[^0-9.]/g,'')) || 0;
    const rate = parseFloat(d.commissionRate || 15) / 100;
    return sum + (val * rate);
  }, 0);

  const activeDealCount = deals.filter(d => d.stage && d.stage !== 'closed').length;

  const initials = (a.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase();

  const dealRows = deals.length ? deals.map(d => {
    const val = parseFloat((d.value||'').toString().replace(/[^0-9.]/g,'')) || 0;
    const stage = (d.stage||'active').toLowerCase();
    const badgeColor = stage === 'closed'
      ? 'background:var(--surface2);color:var(--muted);border:1px solid var(--border)'
      : stage === 'negotiating' || stage === 'expiring'
      ? 'background:rgba(245,158,11,0.12);color:#f59e0b'
      : 'background:rgba(74,222,128,0.12);color:#4ade80';
    const label = stage === 'closed' ? 'Closed' : stage === 'negotiating' ? 'Negotiating' : stage === 'expiring' ? 'Expiring' : 'Active';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface2);border-radius:6px">
      <div>
        <div style="font-size:13px;font-weight:600;color:var(--text)">${d.brand || 'Unknown'} — ${d.dealType || d.type || ''}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">${d.date ? 'Added ' + d.date : ''}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:13px;font-weight:600;color:#4ade80">${val ? '$' + val.toLocaleString() : '—'}</div>
        <span style="font-size:10px;padding:1px 7px;border-radius:4px;${badgeColor}">${label}</span>
      </div>
    </div>`;
  }).join('') : '<div style="color:var(--muted);font-size:12px;padding:8px 0">No deals yet</div>';

  const contractRows = contracts.length ? contracts.map(c => {
    const signed = c.signed || c.status === 'signed';
    return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">
      <div>
        <div style="font-size:13px;color:var(--text)">${c.filename || c.brand + '_contract.pdf'}</div>
        <div style="font-size:11px;color:var(--muted)">Generated ${c.date || ''}</div>
      </div>
      <span style="font-size:10px;padding:1px 7px;border-radius:4px;${signed ? 'background:rgba(74,222,128,0.12);color:#4ade80' : 'background:rgba(245,158,11,0.12);color:#f59e0b'}">${signed ? 'Signed' : 'Unsigned'}</span>
    </div>`;
  }).join('') : '<div style="color:var(--muted);font-size:12px;padding:8px 0">No contracts yet</div>';

  const html = `<div style="font-family:var(--mono)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
      <div style="display:flex;align-items:center;gap:14px">
        <div style="width:52px;height:52px;border-radius:50%;background:rgba(74,222,128,0.15);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;color:#4ade80">${initials}</div>
        <div>
          <div style="font-size:18px;font-weight:700;color:var(--text)">${a.name}</div>
          <div style="font-size:13px;color:var(--muted)">${a.position || ''} · ${a.school || ''} · ${a.year || ''}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button onclick="selectAthlete('${a.id}');closeProfileModal()" style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:7px 14px;cursor:pointer">Set Active</button>
        <button onclick="closeProfileModal();setTimeout(()=>showView('contract',document.querySelectorAll('.nav-item')[8]),100)" style="background:rgba(200,241,53,0.1);border:1px solid rgba(200,241,53,0.3);border-radius:6px;color:var(--accent);font-size:12px;padding:7px 14px;cursor:pointer">Generate Contract</button>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:18px">
      <div style="background:var(--surface2);border-radius:8px;padding:12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px">NIL Earned</div>
        <div style="font-size:20px;font-weight:700;color:#4ade80">${totalNIL >= 1000 ? '$' + (totalNIL/1000).toFixed(1) + 'K' : '$' + totalNIL.toFixed(0)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">Lifetime total</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px">Active Deals</div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">${activeDealCount}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">In progress</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px">Commission</div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">${commission >= 1000 ? '$' + (commission/1000).toFixed(1) + 'K' : '$' + commission.toFixed(0)}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">Earned</div>
      </div>
      <div style="background:var(--surface2);border-radius:8px;padding:12px">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:5px">IG Followers</div>
        <div style="font-size:20px;font-weight:700;color:var(--text)">${(a.instagram||0).toLocaleString()}</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">${a.engagement || 0}% engagement</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px">
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:10px">Deals</div>
          <div style="display:flex;flex-direction:column;gap:7px">${dealRows}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:10px">Contracts</div>
          ${contractRows}
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:10px">Client Info</div>
          <div style="display:flex;flex-direction:column;gap:7px;font-size:12px">
            ${[['Sport', a.sport],['Position', a.position],['School', a.school],['Year', a.year],['IG', (a.instagram||0).toLocaleString()],['TikTok', (a.tiktok||0).toLocaleString()],['Engagement', (a.engagement||0) + '%']].map(([k,v]) =>
              `<div style="display:flex;justify-content:space-between"><span style="color:var(--muted)">${k}</span><span style="color:var(--text)">${v||'—'}</span></div>`
            ).join('')}
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">
          <div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:8px">Notes</div>
          <div style="font-size:12px;color:var(--muted);line-height:1.6">${a.agentNote || 'No notes yet.'}</div>
        </div>
      </div>
    </div>
  </div>`;

  document.getElementById('profileModalBody').innerHTML = html;
  document.getElementById('profileModal').style.display = 'flex';
}

function closeProfileModal() {
  document.getElementById('profileModal').style.display = 'none';
}

document.addEventListener('DOMContentLoaded', function() {
  const modal = document.createElement('div');
  modal.id = 'profileModal';
  modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:20px';
  modal.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:820px;max-height:90vh;overflow-y:auto;padding:24px;position:relative">
    <button onclick="closeProfileModal()" style="position:absolute;top:14px;right:14px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:4px 10px;cursor:pointer">Close</button>
    <div id="profileModalBody"></div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeProfileModal(); });

  if (typeof calcTotalNilEarned === 'function') calcTotalNilEarned();
});


// ── ATHLETE PORTALS ──────────────────────────────────────────

async function loadAthletePortals() {
  var list = document.getElementById("athlete-portals-list");
  if (!list) return;
  await new Promise(function(r){
    var tries = 0;
    var check = setInterval(function(){
      tries++;
      if ((window.athletes && window.athletes.length > 0) || tries > 20) {
        clearInterval(check); r();
      }
    }, 200);
  });
  var athletes = window.athletes || [];
  if (!athletes.length) {
    list.innerHTML = "<div style='color:var(--muted);text-align:center;padding:40px'>No clients yet. Add a client first.</div>";
    return;
  }
  var html = "";
  for (var i = 0; i < athletes.length; i++) {
    var a = athletes[i];
    var initials = (a.name||"?").split(" ").map(function(n){return n[0];}).join("").substring(0,2).toUpperCase();
    var visControls = ["rate","deals","contracts","brands","compliance"].map(function(key){
      var labelMap = {rate:"NIL rate estimate",deals:"Deal values",contracts:"Contracts",brands:"Brand opportunities",compliance:"Compliance status"};
      return "<div style='display:flex;justify-content:space-between;align-items:center;padding:7px 10px;background:var(--surface2);border-radius:6px'>" +
        "<span style='font-size:12px;color:var(--text)'>" + labelMap[key] + "</span>" +
        "<input type='checkbox' id='vis-" + a.id + "-" + key + "' onchange='updatePortalVisibility(" + JSON.stringify(a.id) + ")' style='width:16px;height:16px;accent-color:var(--accent);cursor:pointer'>" +
        "</div>";
    }).join("");
    html += "<div style='background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px' id='portal-card-" + a.id + "'>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:12px'>" +
        "<div style='display:flex;align-items:center;gap:10px'>" +
          "<div style='width:36px;height:36px;border-radius:50%;background:rgba(74,222,128,0.15);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#4ade80'>" + initials + "</div>" +
          "<div>" +
            "<div style='font-size:13px;font-weight:600;color:var(--text)'>" + a.name + "</div>" +
            "<div style='font-size:11px;color:var(--muted)'>" + (a.sport||"") + " · " + (a.school||"School not set") + "</div>" +
          "</div>" +
        "</div>" +
        "<span id='portal-status-" + a.id + "' style='font-size:10px;padding:3px 10px;border-radius:40px;background:rgba(255,255,255,0.06);color:var(--muted)'>Loading...</span>" +
      "</div>" +
      "<div id='portal-controls-" + a.id + "' style='display:none'>" +
        "<div style='font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px'>Visibility controls</div>" +
        "<div style='display:flex;flex-direction:column;gap:6px;margin-bottom:12px'>" + visControls + "</div>" +
        "<div id='portal-invite-section-" + a.id + "'></div>" +
      "</div>" +
      "<button onclick='togglePortalCard(" + JSON.stringify(a.id) + ")' style='width:100%;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;padding:7px;cursor:pointer;margin-top:8px' id='portal-expand-btn-" + a.id + "'>Manage portal</button>" +
    "</div>";
  }
  list.innerHTML = html;
  for (var j = 0; j < athletes.length; j++) {
    loadPortalStatus(athletes[j].id);
  }
}

async function loadPortalStatus(athleteId) {
  try {
    var API_BASE = window.API_BASE || "";
    var r = await fetch(API_BASE + "/api/athlete-portal/invite/" + athleteId).then(function(r){return r.json();});
    var statusEl = document.getElementById("portal-status-" + athleteId);
    if (!statusEl) return;
    if (!r.invited) {
      statusEl.textContent = "Not invited";
      statusEl.style.cssText = "font-size:10px;padding:3px 10px;border-radius:40px;background:rgba(255,255,255,0.06);color:var(--muted)";
    } else if (r.hasAccount) {
      statusEl.textContent = "Active";
      statusEl.style.cssText = "font-size:10px;padding:3px 10px;border-radius:40px;background:rgba(74,222,128,0.12);color:#4ade80";
    } else {
      statusEl.textContent = "Invited";
      statusEl.style.cssText = "font-size:10px;padding:3px 10px;border-radius:40px;background:rgba(245,158,11,0.12);color:#f59e0b";
    }
    if (r.invited && r.visibility) {
      ["rate","deals","contracts","brands","compliance"].forEach(function(key){
        var el = document.getElementById("vis-" + athleteId + "-" + key);
        if (el) el.checked = r.visibility[key] || false;
      });
      var invSection = document.getElementById("portal-invite-section-" + athleteId);
      if (invSection) {
        if (r.hasAccount) {
          invSection.innerHTML = "<div style='font-size:12px;color:#4ade80;padding:8px 10px;background:rgba(74,222,128,0.08);border-radius:6px'>Athlete has created their account and can log in.</div>";
        } else {
          invSection.innerHTML = "<div style='font-size:12px;color:var(--muted);margin-bottom:8px'>Share this link with the athlete:</div>" +
            "<div style='display:flex;gap:6px'>" +
              "<input style='flex:1;font-size:11px;padding:7px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text)' readonly value='" + r.inviteUrl + "' id='invite-url-" + athleteId + "'>" +
              "<button onclick='copyInviteLink(" + JSON.stringify(athleteId) + ")' style='padding:7px 12px;background:var(--accent);border:none;border-radius:6px;color:#000;font-size:11px;font-weight:700;cursor:pointer'>Copy</button>" +
            "</div>";
        }
      }
    } else {
      var invSection = document.getElementById("portal-invite-section-" + athleteId);
      if (invSection) invSection.innerHTML = "<button onclick='sendAthleteInvite(" + JSON.stringify(athleteId) + ")' style='width:100%;padding:9px;background:var(--accent);border:none;border-radius:6px;color:#000;font-size:12px;font-weight:700;cursor:pointer'>Send Invite</button>";
    }
  } catch(e) { console.error("Portal status error:", e); }
}

function togglePortalCard(athleteId) {
  var controls = document.getElementById("portal-controls-" + athleteId);
  var btn = document.getElementById("portal-expand-btn-" + athleteId);
  if (!controls) return;
  var isOpen = controls.style.display !== "none";
  controls.style.display = isOpen ? "none" : "block";
  btn.textContent = isOpen ? "Manage portal" : "Close";
}

async function sendAthleteInvite(athleteId) {
  var API_BASE = window.API_BASE || "";
  var visibility = { rate: true, deals: true, contracts: true, brands: false, compliance: true };
  try {
    var r = await fetch(API_BASE + "/api/athlete-portal/invite", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ athleteId: athleteId, visibilitySettings: visibility })
    }).then(function(r){return r.json();});
    if (r.ok) { showToast("Invite created for " + r.athleteName); loadPortalStatus(athleteId); }
    else showToast("Error: " + r.error);
  } catch(e) { showToast("Error creating invite"); }
}

async function updatePortalVisibility(athleteId) {
  var API_BASE = window.API_BASE || "";
  var visibility = {};
  ["rate","deals","contracts","brands","compliance"].forEach(function(key){
    var el = document.getElementById("vis-" + athleteId + "-" + key);
    if (el) visibility[key] = el.checked;
  });
  await fetch(API_BASE + "/api/athlete-portal/visibility/" + athleteId, {
    method: "PATCH", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ visibility: visibility })
  });
  showToast("Visibility updated");
}

function copyInviteLink(athleteId) {
  var el = document.getElementById("invite-url-" + athleteId);
  if (el) { navigator.clipboard.writeText(el.value); showToast("Invite link copied!"); }
}

async function loadAthleteDashboard() {
  const API_BASE = window.API_BASE || '';
  try {
    const data = await fetch(API_BASE + '/api/athlete-portal/dashboard').then(function(r){return r.json();});
    if (data.error) return;
    var a = data.athlete;
    var deals = data.deals || [];
    var vis = data.visibility || {};
    var rate = data.rate || {};
    var content = document.getElementById('ath-dash-content');
    var greeting = document.getElementById('ath-dash-greeting');
    if (greeting) greeting.textContent = 'Hey, ' + (a.name ? a.name.split(' ')[0] : 'there');
    var html = '<div style="display:flex;flex-direction:column;gap:16px">';

    if (vis.rate) {
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">' +
          '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Your NIL rate</div>' +
          '<div style="font-size:22px;font-weight:700;color:var(--accent)">$' + (rate.low ? rate.low.toLocaleString() + '–$' + rate.high.toLocaleString() : '—') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px">Per IG Reel estimate</div>' +
        '</div>' +
        '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">' +
          '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">Active deals</div>' +
          '<div style="font-size:22px;font-weight:700;color:var(--text)">' + deals.filter(function(d){return d.stage!=='Closed';}).length + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px">In progress</div>' +
        '</div>' +
      '</div>';
    }

    if (vis.deals && deals.length) {
      html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:10px">Your deals</div>' +
        '<div style="display:flex;flex-direction:column;gap:7px">' +
        deals.map(function(d) {
          var isClosed = d.stage === 'Closed';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface2);border-radius:6px">' +
            '<div>' +
              '<div style="font-size:13px;font-weight:600;color:var(--text)">' + (d.brand||'Brand') + '</div>' +
              '<div style="font-size:11px;color:var(--muted)">' + (d.stage||'Active') + '</div>' +
            '</div>' +
            '<div style="text-align:right">' +
              '<div style="font-size:13px;font-weight:600;color:' + (isClosed?'var(--muted)':'#4ade80') + '">$' + ((d.value||0)).toLocaleString() + '</div>' +
              '<span style="font-size:10px;padding:1px 7px;border-radius:4px;background:' + (isClosed?'rgba(255,255,255,0.06)':'rgba(74,222,128,0.12)') + ';color:' + (isClosed?'var(--muted)':'#4ade80') + '">' + (isClosed?'Closed':'Active') + '</span>' +
            '</div>' +
          '</div>';
        }).join('') +
        '</div></div>';
    }

    if (vis.compliance) {
      html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text);margin-bottom:10px">Compliance</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface2);border-radius:6px">' +
          '<span style="font-size:13px;color:var(--text)">SPARTA status</span>' +
          '<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(74,222,128,0.12);color:#4ade80">Clear</span>' +
        '</div>' +
      '</div>';
    }

    html += '<div style="font-size:11px;color:var(--muted);text-align:center;padding:8px">Questions about your deals? Contact your agent.</div>';
    html += '</div>';
    if (content) content.innerHTML = html;
  } catch(e) { console.error('Athlete dashboard error:', e); }
}


// ─────────────────────────────────────────────────────────────────────────────
// NILViewVal v4 Scores Panel
// ─────────────────────────────────────────────────────────────────────────────
async function showNILViewValScores(athleteId, containerEl) {
  if (!containerEl) return;
  containerEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">Loading NIL scores...</div>';
  try {
    const r = await fetch('/api/nilviewval/' + athleteId);
    const data = await r.json();
    if (data.error) { containerEl.innerHTML = '<div style="color:#f87171;padding:12px">' + data.error + '</div>'; return; }

    const s = data.scores;
    const cats = (data.sponsorCategories || []).slice(0, 3);
    const pts = (data.brandPartnershipTypes || []).slice(0, 3);

    function scoreColor(n) {
      if (n >= 80) return '#4ade80';
      if (n >= 60) return '#f59e0b';
      return '#f87171';
    }
    function scoreBar(n) {
      const color = scoreColor(n);
      return '<div style="background:var(--surface2);border-radius:4px;height:6px;margin-top:4px"><div style="width:' + n + '%;background:' + color + ';height:6px;border-radius:4px;transition:width 0.5s"></div></div>';
    }

    containerEl.innerHTML = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">' +
      ['Marketability','Sponsorship Readiness','Audience Quality','Confidence'].map((label, i) => {
        const vals = [s.marketabilityScore, s.sponsorshipReadiness, s.audienceQuality, s.confidenceScore];
        const val = vals[i] || 0;
        return '<div style="background:var(--surface2);border-radius:8px;padding:12px">' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:2px">' + label + '</div>' +
          '<div style="font-size:20px;font-weight:700;color:' + scoreColor(val) + '">' + val + '<span style="font-size:12px;color:var(--muted)">/100</span></div>' +
          scoreBar(val) +
        '</div>';
      }).join('') +
    '</div>' +

    (cats.length ? '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Top Sponsorship Categories</div>' +
      cats.map(c => '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--surface2);border-radius:6px;margin-bottom:4px">' +
        '<span style="font-size:12px;color:var(--text)">' + c.name + '</span>' +
        '<span style="font-size:10px;padding:1px 7px;border-radius:4px;background:rgba(74,222,128,0.12);color:#4ade80">' + (c.fit||'Good') + '</span>' +
      '</div>').join('') +
    '</div>' : '') +

    (pts.length ? '<div><div style="font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Ideal Deal Types</div>' +
      pts.map(p => '<div style="padding:6px 10px;background:var(--surface2);border-radius:6px;margin-bottom:4px">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' + p.type + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + p.description + '</div>' +
      '</div>').join('') +
    '</div>' : '');
  } catch(e) {
    containerEl.innerHTML = '<div style="color:#f87171;padding:12px">Failed to load NIL scores</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Athlete Brand Kit Modal
// ─────────────────────────────────────────────────────────────────────────────
async function openBrandKitModal(athleteId, athleteName) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:700px;max-height:90vh;overflow-y:auto;padding:24px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
      '<div>' +
        '<div style="font-size:16px;font-weight:700;color:var(--text)">🎯 Brand Kit — ' + (athleteName||'Athlete') + '</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:2px">AI-generated marketing materials</div>' +
      '</div>' +
      '<button onclick="this.closest('div[style*=fixed]').remove()" style="background:var(--surface2);border:none;color:var(--muted);cursor:pointer;padding:6px 12px;border-radius:6px;font-size:12px">✕ Close</button>' +
    '</div>' +
    '<div id="brandKitContent" style="color:var(--muted);text-align:center;padding:30px">Generating brand kit... <br><small>This takes about 15 seconds</small></div>' +
  '</div>';
  document.body.appendChild(overlay);

  try {
    const r = await fetch('/api/ai/brand-kit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId })
    });
    const kit = await r.json();
    if (kit.error) throw new Error(kit.error);

    const content = document.getElementById('brandKitContent');
    if (!content) return;

    function section(title, content, icon) {
      return '<div style="margin-bottom:16px;padding:14px;background:var(--surface2);border-radius:8px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' + icon + ' ' + title + '</div>' +
        '<div style="font-size:13px;color:var(--text);line-height:1.6">' + content + '</div>' +
      '</div>';
    }
    function bullets(arr) {
      if (!Array.isArray(arr)) return '<p>' + arr + '</p>';
      return '<ul style="margin:0;padding-left:16px">' + arr.map(i => '<li style="margin-bottom:4px">' + i + '</li>').join('') + '</ul>';
    }

    content.innerHTML =
      section('Brand Summary', kit.brandSummary || '—', '✨') +
      section('Sponsorship Positioning', kit.sponsorshipPositioning || '—', '🎯') +
      section('Athlete Bio (Media Kit)', kit.athleteBio || '—', '📋') +
      section('Outreach Talking Points', bullets(kit.outreachTalkingPoints), '💬') +
      section('Social Content Strategy', (kit.socialContentStrategy || '—') + (kit.contentPillars ? '<br><br><strong>Content Pillars:</strong><br>' + bullets(kit.contentPillars) : ''), '📱') +
      section('Campaign Suggestions', bullets(kit.campaignSuggestions), '🚀') +
      section('Ideal Sponsorship Categories', bullets(kit.idealSponsorshipCategories), '🏷️') +
      '<button onclick="navigator.clipboard.writeText(document.getElementById('brandKitContent').innerText).then(()=>alert('Copied to clipboard!'))" style="width:100%;padding:10px;background:var(--accent);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;margin-top:4px">📋 Copy Full Brand Kit</button>';
  } catch(e) {
    const c = document.getElementById('brandKitContent');
    if (c) c.innerHTML = '<div style="color:#f87171">Error generating brand kit: ' + e.message + '</div>';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate Outreach Modal
// ─────────────────────────────────────────────────────────────────────────────
async function openOutreachModal(athleteId, athleteName) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px';
  overlay.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:680px;max-height:90vh;overflow-y:auto;padding:24px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
      '<div>' +
        '<div style="font-size:16px;font-weight:700;color:var(--text)">📨 Generate Outreach — ' + (athleteName||'Athlete') + '</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:2px">AI-generated sponsorship emails, DMs, and proposals</div>' +
      '</div>' +
      '<button onclick="this.closest('div[style*=fixed]').remove()" style="background:var(--surface2);border:none;color:var(--muted);cursor:pointer;padding:6px 12px;border-radius:6px;font-size:12px">✕ Close</button>' +
    '</div>' +
    '<div style="display:grid;gap:10px;margin-bottom:16px">' +
      '<div>' +
        '<label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Brand/Company Name</label>' +
        '<input id="outreachBrand" placeholder="e.g. Celsius, Jim Hudson Toyota, Ghost Energy" style="width:100%;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;box-sizing:border-box">' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Category</label>' +
          '<select id="outreachCategory" style="width:100%;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px">' +
            '<option value="nutrition">Nutrition / Supplements</option>' +
            '<option value="apparel">Apparel / Footwear</option>' +
            '<option value="food">Food / Restaurant</option>' +
            '<option value="auto">Automotive</option>' +
            '<option value="finance">Finance / Banking</option>' +
            '<option value="tech">Tech / Gaming</option>' +
            '<option value="grooming">Grooming / Beauty</option>' +
            '<option value="general">General</option>' +
          '</select>' +
        '</div>' +
        '<div><label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Deal Goal ($)</label>' +
          '<input id="outreachGoal" type="number" placeholder="e.g. 2500" style="width:100%;padding:8px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;box-sizing:border-box">' +
        '</div>' +
      '</div>' +
      '<button onclick="runOutreachGeneration('' + athleteId + '')" style="padding:10px;background:var(--accent);color:#000;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Generate Outreach →</button>' +
    '</div>' +
    '<div id="outreachResult"></div>' +
  '</div>';
  document.body.appendChild(overlay);
}

async function runOutreachGeneration(athleteId) {
  const brand = document.getElementById('outreachBrand')?.value?.trim();
  const category = document.getElementById('outreachCategory')?.value;
  const goal = document.getElementById('outreachGoal')?.value;
  const resultEl = document.getElementById('outreachResult');
  if (!brand) { alert('Enter a brand name'); return; }
  if (resultEl) resultEl.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted);font-size:13px">Generating outreach... takes ~15 seconds</div>';

  try {
    const r = await fetch('/api/ai/generate-outreach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId, brand, category, outreachType: 'full', goal })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    function outreachBox(title, icon, content) {
      const id = 'ob-' + Math.random().toString(36).substr(2,6);
      return '<div style="margin-bottom:12px;padding:14px;background:var(--surface2);border-radius:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
          '<span style="font-size:12px;font-weight:700;color:var(--accent)">' + icon + ' ' + title + '</span>' +
          '<button onclick="navigator.clipboard.writeText(document.getElementById('' + id + '').innerText).then(()=>alert('Copied!'))" style="font-size:10px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer">Copy</button>' +
        '</div>' +
        '<div id="' + id + '" style="font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap">' + content + '</div>' +
      '</div>';
    }

    let html = '';
    if (data.sponsorshipEmail) {
      html += outreachBox('Sponsorship Email', '📧',
        'SUBJECT: ' + (data.sponsorshipEmail.subject || '') + '

' + (data.sponsorshipEmail.body || ''));
    }
    if (data.instagramDm) html += outreachBox('Instagram DM', '📲', data.instagramDm);
    if (data.partnershipProposal) html += outreachBox('Partnership Proposal', '📄', data.partnershipProposal);
    if (data.followUpEmail) {
      html += outreachBox('Follow-up Email', '🔁',
        'SUBJECT: ' + (data.followUpEmail.subject || '') + '

' + (data.followUpEmail.body || ''));
    }

    if (resultEl) resultEl.innerHTML = html;
  } catch(e) {
    if (resultEl) resultEl.innerHTML = '<div style="color:#f87171;padding:12px">Error: ' + e.message + '</div>';
  }
}

// Make functions globally accessible
window.showNILViewValScores = showNILViewValScores;
window.openBrandKitModal = openBrandKitModal;
window.openOutreachModal = openOutreachModal;
window.runOutreachGeneration = runOutreachGeneration;
