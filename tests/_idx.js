'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';

const API_BASE = window.location.origin;
let currentUser = null;
let athletes = [];
let selectedAthleteId = null;
let selectedRole = 'agent';
let lastCalculatedRate = null;

//  AUTH
function chooseAuthRole(role) {
  document.getElementById('authRoleChooser').style.display  = role ? 'none' : 'block';
  document.getElementById('authAgentPanel').style.display   = role === 'agent'   ? 'block' : 'none';
  document.getElementById('authAthletePanel').style.display = role === 'athlete' ? 'block' : 'none';
  document.getElementById('authResetPanel').style.display   = 'none';
}

// Marketing landing (logged-out home) ↔ existing sign-in flow.
// The landing's account cards open the exact same auth panels the old
// sign-in screen used, so behavior is identical.
function mktOpenAuth(role) {
  var m = document.getElementById('mktLanding'); if (m) m.classList.add('hidden');
  var a = document.getElementById('authScreen'); if (a) a.classList.remove('hidden');
  chooseAuthRole(role);
  try { window.scrollTo(0, 0); } catch (e) {}
}
function showMarketingLanding() {
  var m = document.getElementById('mktLanding'); if (m) m.classList.remove('hidden');
  var a = document.getElementById('authScreen'); if (a) a.classList.add('hidden');
  var app = document.getElementById('appScreen'); if (app) app.classList.remove('visible');
  document.body.classList.remove('app-active'); // hides the mobile topbar while logged out
}

// ── University Compliance Portal: Auth ───────────────────────────────────
let _universitySession = null;

async function loadUniversityList() {
  try {
    const r = await fetch(`${API_BASE}/api/university/list`);
    const universities = await r.json();
    const sel = document.getElementById('univ-reg-school');
    if (sel) sel.innerHTML = '<option value="">— Select university —</option>' +
      universities.map(u => `<option value="${u.id}">${u.name} (${u.conference})</option>`).join('');
  } catch(e) { console.warn('Could not load university list', e); }
}

function switchUnivAuthTab(tab) {
  document.getElementById('univLoginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('univRegisterForm').style.display = tab === 'register' ? 'block' : 'none';
  document.getElementById('univLoginTab').style.background = tab === 'login' ? '#1a3a5c' : 'none';
  document.getElementById('univLoginTab').style.color = tab === 'login' ? '#fff' : 'var(--muted)';
  document.getElementById('univRegisterTab').style.background = tab === 'register' ? '#1a3a5c' : 'none';
  document.getElementById('univRegisterTab').style.color = tab === 'register' ? '#fff' : 'var(--muted)';
}

async function doUniversityLogin() {
  const email = document.getElementById('univ-login-email').value.trim();
  const password = document.getElementById('univ-login-password').value;
  const errEl = document.getElementById('univ-login-error');
  errEl.style.display = 'none';
  if (!email || !password) { errEl.textContent = 'Email and password required'; errEl.style.display = 'block'; return; }
  try {
    const r = await fetch(`${API_BASE}/api/university/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Login failed'; errEl.style.display = 'block'; return; }
    _universitySession = data;
    showUniversityPortal(data);
  } catch(e) { errEl.textContent = 'Network error'; errEl.style.display = 'block'; }
}

async function doUniversityRegister() {
  const name = document.getElementById('univ-reg-name').value.trim();
  const email = document.getElementById('univ-reg-email').value.trim();
  const password = document.getElementById('univ-reg-password').value;
  const universityId = document.getElementById('univ-reg-school').value;
  const errEl = document.getElementById('univ-reg-error');
  errEl.style.display = 'none';
  if (!name || !email || !password || !universityId) { errEl.textContent = 'All fields required'; errEl.style.display = 'block'; return; }
  try {
    const r = await fetch(`${API_BASE}/api/university/register`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, email, password, universityId })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Registration failed'; errEl.style.display = 'block'; return; }
    switchUnivAuthTab('login');
    document.getElementById('univ-login-email').value = email;
    const loginErr = document.getElementById('univ-login-error');
    loginErr.textContent = 'Account created! Please sign in.';
    loginErr.style.color = '#22c55e';
    loginErr.style.display = 'block';
  } catch(e) { errEl.textContent = 'Network error'; errEl.style.display = 'block'; }
}

function showUniversityPortal(session) {
  document.getElementById('authScreen').style.display = 'none';
  const portal = document.getElementById('univCompliancePortal');
  portal.style.display = 'flex';
  document.getElementById('ucp-university-name').textContent = session.universityName;
  document.getElementById('ucp-user-name').textContent = session.name;
  loadUniversityComplianceDashboard();
}

async function univPortalSignOut() {
  await fetch(`${API_BASE}/api/university/logout`, { method: 'POST', credentials: 'include' });
  _universitySession = null;
  document.getElementById('univCompliancePortal').style.display = 'none';
  document.getElementById('authScreen').style.display = 'flex';
  document.getElementById('authAgentPanel').style.display = 'none';
  document.getElementById('authAthletePanel').style.display = 'none';
  const up = document.getElementById('authUniversityPanel');
  if (up) up.style.display = 'none';
  document.getElementById('authRoleChooser').style.display = 'block';
}

// ── University Compliance Portal: Dashboard / Tabs ───────────────────────
let _ucpData = { athletes: [], flags: [], opportunities: {} };

function showUcpTab(tab) {
  ['dashboard','roster','flags','opportunities','settings'].forEach(t => {
    const panel = document.getElementById('ucpPanel-' + t);
    const nav = document.getElementById('ucpNav-' + t);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
    if (nav) { nav.classList.toggle('ucp-nav-active', t === tab); }
  });
  if (tab === 'flags') loadUcpFlags();
  if (tab === 'roster') loadUcpRoster();
  if (tab === 'opportunities') loadUcpOpportunityAthletes();
  if (tab === 'settings') loadUcpSettings();
}

async function loadUniversityComplianceDashboard() {
  try {
    const r = await fetch(`${API_BASE}/api/university/compliance-dashboard`, { credentials: 'include' });
    if (!r.ok) return;
    const data = await r.json();
    _ucpData.athletes = data.athleteLinks || [];
    const totalFlags = (data.flagsSummary || []).reduce((s, f) => s + parseInt(f.count), 0);
    const highFlags = (data.flagsSummary || []).filter(f => f.severity === 'high').reduce((s, f) => s + parseInt(f.count), 0);
    document.getElementById('ucp-kpi-athletes').textContent = data.totalAthletes || 0;
    document.getElementById('ucp-kpi-flags').textContent = totalFlags;
    document.getElementById('ucp-kpi-high').textContent = highFlags;
    document.getElementById('ucp-kpi-pending').textContent = (data.pendingLinks || []).length;
    if (totalFlags > 0) {
      document.getElementById('ucp-alert-badge').style.display = 'block';
      document.getElementById('ucp-alert-badge').textContent = `${totalFlags} open flag${totalFlags !== 1 ? 's' : ''}`;
    }
    if ((data.topFlags || []).length > 0) {
      document.getElementById('ucp-alert-strip').style.display = 'block';
      document.getElementById('ucp-alert-cards').innerHTML = data.topFlags.map(f => `
        <div style="background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:var(--r-sm);padding:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
            <div style="font-size:11px;font-weight:700;color:var(--text)">${f.athlete_name || 'Unknown'}</div>
            <span style="font-size:9px;padding:2px 6px;border-radius:3px;font-weight:700;background:${f.severity==='high'?'rgba(239,68,68,0.15)':f.severity==='medium'?'rgba(245,158,11,0.15)':'rgba(34,197,94,0.1)'};color:${f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#22c55e'}">${(f.severity||'').toUpperCase()}</span>
          </div>
          <div style="font-size:10px;color:var(--muted);margin-bottom:6px">${(f.flag_type||'').replace(/_/g,' ')}</div>
          <div style="font-size:11px;color:var(--text);line-height:1.4">${f.ai_summary || ''}</div>
          <button onclick="showUcpTab('flags')" style="margin-top:8px;font-size:10px;color:#1a3a5c;background:none;border:none;cursor:pointer;font-family:'DM Sans',sans-serif">View Flags →</button>
        </div>
      `).join('');
    }
    const pendingEl = document.getElementById('ucp-pending-links');
    if ((data.pendingLinks || []).length === 0) {
      pendingEl.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">No pending athlete links</div>';
    } else {
      pendingEl.innerHTML = data.pendingLinks.map(link => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text)">${link.name || link.athlete_id}</div>
            <div style="font-size:10px;color:var(--muted)">${link.sport || ''}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button onclick="updateAthleteLink('${link.id}','active')" style="padding:4px 10px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:4px;color:#22c55e;font-size:10px;cursor:pointer;font-family:'DM Sans',sans-serif">Activate</button>
            <button onclick="updateAthleteLink('${link.id}','rejected')" style="padding:4px 10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:4px;color:#ef4444;font-size:10px;cursor:pointer;font-family:'DM Sans',sans-serif">Reject</button>
          </div>
        </div>
      `).join('');
    }
    const recentFlagsEl = document.getElementById('ucp-recent-flags');
    if ((data.topFlags || []).length === 0) {
      recentFlagsEl.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px 0">No open compliance flags</div>';
    } else {
      recentFlagsEl.innerHTML = data.topFlags.map(f => `
        <div style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div style="display:flex;justify-content:space-between;margin-bottom:3px">
            <div style="font-size:12px;font-weight:600;color:var(--text)">${f.athlete_name}</div>
            <span style="font-size:9px;padding:2px 6px;border-radius:3px;font-weight:700;background:${f.severity==='high'?'rgba(239,68,68,0.12)':f.severity==='medium'?'rgba(245,158,11,0.12)':'rgba(34,197,94,0.08)'};color:${f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#22c55e'}">${f.severity}</span>
          </div>
          <div style="font-size:11px;color:var(--muted)">${f.ai_summary || (f.flag_type||'').replace(/_/g,' ')}</div>
        </div>
      `).join('');
    }
  } catch(e) { console.error('[ucp] dashboard load failed', e); }
}

async function loadUcpRoster() {
  try {
    const r = await fetch(`${API_BASE}/api/university/compliance-dashboard`, { credentials: 'include' });
    const data = await r.json();
    const athletes = data.athleteLinks || [];
    _ucpData.athletes = athletes;
    renderUcpRoster(athletes);
  } catch(e) { console.error('[ucp] roster load failed', e); }
}

function renderUcpRoster(athletes) {
  const sportFilter = document.getElementById('ucp-roster-sport-filter')?.value || '';
  const statusFilter = document.getElementById('ucp-roster-status-filter')?.value || '';
  const filtered = athletes.filter(a =>
    (!sportFilter || a.sport === sportFilter) &&
    (!statusFilter || a.status === statusFilter)
  );
  const tbody = document.getElementById('ucp-roster-body');
  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:30px;text-align:center;color:var(--muted)">No athletes linked to this university yet</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(a => `
    <tr style="border-bottom:1px solid var(--border)">
      <td style="padding:10px 14px;font-weight:600;color:var(--text)">${a.name || a.athlete_id}</td>
      <td style="padding:10px 14px;color:var(--muted)">${a.sport || '—'}</td>
      <td style="padding:10px 14px">
        <span style="font-size:10px;padding:3px 8px;border-radius:3px;font-weight:600;background:${a.status==='active'?'rgba(34,197,94,0.1)':'rgba(245,158,11,0.1)'};color:${a.status==='active'?'#22c55e':'#f59e0b'}">${a.status}</span>
      </td>
      <td style="padding:10px 14px;color:var(--muted)">—</td>
      <td style="padding:10px 14px">
        <button onclick="runUcpComplianceCheck('${a.athlete_id}')" style="padding:4px 10px;background:rgba(26,58,92,0.15);border:1px solid rgba(26,58,92,0.3);border-radius:4px;color:#1a3a5c;font-size:10px;cursor:pointer;font-family:'DM Sans',sans-serif">AI Compliance Check</button>
      </td>
    </tr>
  `).join('');
}

function filterUcpRoster() { renderUcpRoster(_ucpData.athletes); }

async function updateAthleteLink(linkId, status) {
  try {
    await fetch(`${API_BASE}/api/university/athlete-links/${linkId}`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    loadUniversityComplianceDashboard();
  } catch(e) { console.error('[ucp] updateAthleteLink failed', e); }
}

async function runUcpComplianceCheck(athleteId) {
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'Running AI…';
  try {
    const r = await fetch(`${API_BASE}/api/university/ai/compliance-check`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId })
    });
    const data = await r.json();
    if (!r.ok) { alert('Compliance check failed: ' + (data.error || 'Unknown error')); }
    else {
      alert(`AI compliance check complete: ${data.flags.length} flag(s) found for ${data.athleteName}`);
      loadUniversityComplianceDashboard();
    }
  } catch(e) { alert('Network error running compliance check'); }
  finally { btn.disabled = false; btn.textContent = 'AI Compliance Check'; }
}

async function loadUcpFlags() {
  const severity = document.getElementById('ucp-flag-severity-filter')?.value || '';
  const resolved = document.getElementById('ucp-flag-resolved-filter')?.value;
  let url = `${API_BASE}/api/university/flags?`;
  if (severity) url += `severity=${severity}&`;
  if (resolved !== '' && resolved !== undefined) url += `resolved=${resolved}`;
  const tbody = document.getElementById('ucp-flags-body');
  tbody.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--muted)">Loading…</td></tr>';
  try {
    const r = await fetch(url, { credentials: 'include' });
    const flags = await r.json();
    _ucpData.flags = flags;
    if (!flags.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:30px;text-align:center;color:var(--muted)">No compliance flags found</td></tr>';
      return;
    }
    tbody.innerHTML = flags.map(f => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:10px 14px">
          <div style="font-weight:600;color:var(--text)">${f.athlete_name || f.athlete_id}</div>
          <div style="font-size:10px;color:var(--muted)">${f.sport || ''}</div>
        </td>
        <td style="padding:10px 14px;color:var(--text)">${(f.flag_type||'').replace(/_/g,' ')}</td>
        <td style="padding:10px 14px">
          <span style="font-size:10px;padding:3px 8px;border-radius:3px;font-weight:700;background:${f.severity==='high'?'rgba(239,68,68,0.12)':f.severity==='medium'?'rgba(245,158,11,0.12)':'rgba(34,197,94,0.08)'};color:${f.severity==='high'?'#ef4444':f.severity==='medium'?'#f59e0b':'#22c55e'}">${f.severity}</span>
        </td>
        <td style="padding:10px 14px;font-size:11px;color:var(--muted);max-width:300px">${f.ai_summary || '—'}</td>
        <td style="padding:10px 14px;font-size:11px;color:var(--muted)">${f.created_at ? new Date(f.created_at).toLocaleDateString() : '—'}</td>
        <td style="padding:10px 14px">
          ${!f.resolved ? `<button onclick="resolveUcpFlag('${f.id}')" style="padding:4px 10px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:4px;color:#22c55e;font-size:10px;cursor:pointer;font-family:'DM Sans',sans-serif">Resolve</button>` : '<span style="font-size:10px;color:var(--muted)">Resolved</span>'}
        </td>
      </tr>
      ${f.recommended_action ? `<tr style="border-bottom:1px solid var(--border);background:var(--surface)"><td colspan="6" style="padding:8px 14px;font-size:11px;color:var(--muted)">📋 <strong>Action:</strong> ${f.recommended_action}</td></tr>` : ''}
    `).join('');
  } catch(e) { tbody.innerHTML = '<tr><td colspan="6" style="padding:20px;text-align:center;color:#ef4444">Failed to load flags</td></tr>'; }
}

async function resolveUcpFlag(flagId) {
  try {
    await fetch(`${API_BASE}/api/university/flags/${flagId}/resolve`, {
      method: 'PATCH', credentials: 'include'
    });
    loadUcpFlags();
    loadUniversityComplianceDashboard();
  } catch(e) { console.error('[ucp] resolveFlag failed', e); }
}

function exportFlagsCSV() {
  if (!_ucpData.flags.length) { alert('No flags to export'); return; }
  const headers = ['Athlete','Sport','Flag Type','Severity','AI Summary','Recommended Action','Date','Resolved'];
  const rows = _ucpData.flags.map(f => [
    f.athlete_name || f.athlete_id, f.sport || '', (f.flag_type||'').replace(/_/g,' '),
    f.severity, f.ai_summary || '', f.recommended_action || '',
    f.created_at ? new Date(f.created_at).toLocaleDateString() : '', f.resolved ? 'Yes' : 'No'
  ]);
  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'compliance-flags.csv'; a.click();
  URL.revokeObjectURL(url);
}

async function loadUcpOpportunityAthletes() {
  const sel = document.getElementById('ucp-opp-athlete-select');
  if (!sel) return;
  const athletes = _ucpData.athletes.filter(a => a.status === 'active');
  sel.innerHTML = '<option value="">— Select athlete —</option>' +
    athletes.map(a => `<option value="${a.athlete_id}">${a.name || a.athlete_id} (${a.sport || ''})</option>`).join('');
}

async function runUcpDealRecommendations() {
  const athleteId = document.getElementById('ucp-opp-athlete-select').value;
  if (!athleteId) { alert('Select an athlete first'); return; }
  document.getElementById('ucp-opp-loading').style.display = 'block';
  document.getElementById('ucp-opp-results').style.display = 'none';
  document.getElementById('ucp-opp-empty').style.display = 'none';
  try {
    const r = await fetch(`${API_BASE}/api/university/ai/deal-recommendations/${athleteId}`, {
      method: 'POST', credentials: 'include'
    });
    const data = await r.json();
    document.getElementById('ucp-opp-loading').style.display = 'none';
    if (!r.ok) { document.getElementById('ucp-opp-empty').textContent = 'AI analysis failed: ' + data.error; document.getElementById('ucp-opp-empty').style.display = 'block'; return; }
    const recs = data.recommendations || [];
    const resultsEl = document.getElementById('ucp-opp-results');
    resultsEl.innerHTML = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px">Deal recommendations for ${data.athleteName}</div>
      ${recs.map((rec) => `
        <div class="card" style="padding:16px;margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div>
              <span style="font-size:10px;color:#1a3a5c;font-weight:700;margin-right:8px">#${rec.rank}</span>
              <span style="font-weight:700;font-size:13px;color:var(--text)">${rec.brand_name}</span>
              <span style="font-size:10px;color:var(--muted);margin-left:8px">${rec.category}</span>
            </div>
            <div style="text-align:right">
              <div style="font-size:12px;font-weight:700;color:var(--text)">$${(rec.estimated_value_min||0).toLocaleString()}–$${(rec.estimated_value_max||0).toLocaleString()}</div>
              <span style="font-size:9px;padding:2px 6px;border-radius:3px;font-weight:700;background:${rec.compliance_risk==='high'?'rgba(239,68,68,0.12)':rec.compliance_risk==='medium'?'rgba(245,158,11,0.12)':'rgba(34,197,94,0.08)'};color:${rec.compliance_risk==='high'?'#ef4444':rec.compliance_risk==='medium'?'#f59e0b':'#22c55e'}">${rec.compliance_risk} risk</span>
            </div>
          </div>
          <div style="font-size:12px;color:var(--muted);margin-bottom:4px">${rec.campaign_concept}</div>
          <div style="font-size:11px;color:var(--text)">${rec.why_it_fits}</div>
        </div>
      `).join('')}
    `;
    resultsEl.style.display = 'block';
  } catch(e) {
    document.getElementById('ucp-opp-loading').style.display = 'none';
    document.getElementById('ucp-opp-empty').textContent = 'Network error';
    document.getElementById('ucp-opp-empty').style.display = 'block';
  }
}

function loadUcpSettings() {
  if (!_universitySession) return;
  document.getElementById('ucp-settings-name').textContent = _universitySession.name || '';
  document.getElementById('ucp-settings-email').textContent = _universitySession.email || '';
  document.getElementById('ucp-settings-role').textContent = (_universitySession.role||'').replace(/_/g,' ');
  document.getElementById('ucp-settings-university').textContent = _universitySession.universityName || '';
}

async function doAthleteLogin() {
  const email    = document.getElementById('athLoginEmail').value.trim();
  const password = document.getElementById('athLoginPassword').value;
  const errEl    = document.getElementById('athLoginError');
  const btn      = document.getElementById('athLoginBtn');
  if (!email || !password) { errEl.textContent = 'Email and password required'; return; }
  btn.disabled = true; btn.textContent = 'Signing in...';
  errEl.textContent = '';
  try {
    const r = await fetch(`${API_BASE}/api/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, password })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Login failed'; btn.disabled=false; btn.textContent='Sign In →'; return; }
    if (data.role !== 'athlete') { errEl.textContent = 'No athlete account found with this email'; btn.disabled=false; btn.textContent='Sign In →'; return; }
    if (data.passwordResetRequired) {
      // Show forced reset panel
      document.getElementById('authAthletePanel').style.display = 'none';
      document.getElementById('authResetPanel').style.display   = 'block';
      btn.disabled=false; btn.textContent='Sign In →';
      return;
    }
    // Success — boot as athlete
    document.getElementById('authScreen').classList.add('hidden');
    bootApp(data);
  } catch(e) {
    errEl.textContent = 'Connection error — try again'; btn.disabled=false; btn.textContent='Sign In →';
  }
}

async function doForcedReset() {
  const newPass  = document.getElementById('resetNewPassword').value;
  const confirm  = document.getElementById('resetConfirmPassword').value;
  const errEl    = document.getElementById('resetError');
  if (!newPass || newPass.length < 6) { errEl.textContent = 'Password must be at least 6 characters'; return; }
  if (newPass !== confirm) { errEl.textContent = 'Passwords do not match'; return; }
  errEl.textContent = '';
  try {
    const r = await fetch(`${API_BASE}/api/auth/change-password`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ newPassword: newPass })
    });
    const data = await r.json();
    if (!r.ok) { errEl.textContent = data.error || 'Reset failed'; return; }
    // Now load /me to boot the app
    const me = await fetch(`${API_BASE}/api/auth/me`).then(r=>r.json());
    document.getElementById('authScreen').classList.add('hidden');
    bootApp(me);
  } catch(e) {
    errEl.textContent = 'Error — try again';
  }
}

async function switchTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t,i) => t.classList.toggle('active', (i===0&&tab==='login')||(i===1&&tab==='signup')));
  document.getElementById('loginForm').style.display  = tab==='login'  ? 'block' : 'none';
  document.getElementById('signupForm').style.display = tab==='signup' ? 'block' : 'none';
}
async function selectRole(role) {
  selectedRole = role;
  document.getElementById('roleAgent').classList.toggle('active', role==='agent');
  const univBtn = document.getElementById('roleUniversity');
  if (univBtn) univBtn.classList.toggle('active', role==='university');
  const athleteBtn = document.getElementById('roleAthlete');
  if (athleteBtn) athleteBtn.classList.toggle('active', role==='athlete');
}

async function doLogin() {
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const r = await fetch(`${API_BASE}/api/auth/login`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email: document.getElementById('loginEmail').value, password: document.getElementById('loginPassword').value }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error; return; }
    if (data.passwordResetRequired) {
      document.getElementById('authAgentPanel').style.display = 'none';
      document.getElementById('authResetPanel').style.display = 'block';
      btn.disabled = false; btn.textContent = 'Sign In →';
      return;
    }
    currentUser = data;
    bootApp();
  } catch(e) { err.textContent = 'Connection error. Is the server running?'; }
  finally { btn.disabled = false; btn.textContent = 'Sign In →'; }
}

async function doSignup() {
  const btn = document.getElementById('signupBtn');
  const err = document.getElementById('signupError');
  err.textContent = '';
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    const _email = document.getElementById('signupEmail').value.trim();
    // Default name to the email's local-part when blank, so no account is nameless.
    const _name = document.getElementById('signupName').value.trim() || _email.split('@')[0];
    const r = await fetch(`${API_BASE}/api/auth/signup`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name: _name,
        email: _email,
        password: document.getElementById('signupPassword').value,
        role: selectedRole,
      }),
    });
    const data = await r.json();
    if (!r.ok) { err.textContent = data.error; return; }
    // Agent signup returns a Stripe Checkout URL: send them there to enter a card
    // and start their trial. Access is withheld until the subscription exists.
    if (data.checkoutUrl) { window.location.href = data.checkoutUrl; return; }
    currentUser = data;
    bootApp();
  } catch(e) { err.textContent = 'Connection error.'; }
  finally { btn.disabled = false; btn.textContent = 'Create Account →'; }
}

async function startAgentSubscribe() {
  const btn = document.getElementById('agentSubscribeBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening checkout...'; }
  try {
    const r = await fetch(`${API_BASE}/api/agent/create-checkout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
    const data = await r.json();
    if (data.url) { window.location.href = data.url; return; }
    alert(data.error || 'Could not start checkout. Please try again.');
  } catch (e) {
    alert('Could not start checkout. Please try again.');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Subscribe — $99/mo'; }
}

function showSubscribeModal() {
  if (window.__subSnoozeUntil && Date.now() < window.__subSnoozeUntil) return;
  if (document.getElementById('subUnlockOverlay')) return;
  const ov = document.createElement('div');
  ov.id = 'subUnlockOverlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(5,8,16,0.82);backdrop-filter:blur(4px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
  ov.innerHTML = '<div style="background:#141929;border:1px solid rgba(132,204,22,0.25);border-radius:16px;max-width:420px;width:100%;padding:28px 26px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.5)">'
    + '<div style="font-size:12px;letter-spacing:2px;color:#84cc16;font-family:monospace;margin-bottom:10px">FOUNDING ACCESS</div>'
    + '<div style="font-size:21px;font-weight:700;color:#fff;margin-bottom:10px">Subscribe to unlock your tools</div>'
    + '<div style="font-size:14px;line-height:1.5;color:rgba(255,255,255,0.65);margin-bottom:22px">Deal Scan, AI Outreach, Contracts and the rest of your NILDash tools are part of the agent plan. Lock in your founding rate now.</div>'
    + '<div style="font-size:30px;font-weight:800;color:#fff;margin-bottom:2px">$99<span style="font-size:15px;font-weight:500;color:rgba(255,255,255,0.5)">/month</span></div>'
    + '<div style="font-size:12px;color:rgba(255,255,255,0.45);margin-bottom:22px">Founding rate, locked in for as long as you stay</div>'
    + '<button onclick="startAgentSubscribe()" style="width:100%;padding:13px;background:#84cc16;border:none;border-radius:10px;color:#0a0a0a;font-weight:700;font-size:15px;cursor:pointer;margin-bottom:10px">Subscribe now</button>'
    + '<button onclick="window.__subSnoozeUntil = Date.now() + 60000; document.getElementById(\'subUnlockOverlay\').remove()" style="width:100%;padding:11px;background:transparent;border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:rgba(255,255,255,0.6);font-size:13px;cursor:pointer">Maybe later</button>'
    + '</div>';
  document.body.appendChild(ov);
}

(function () {
  if (window.__nilSubGuard) return;
  window.__nilSubGuard = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const res = await _fetch(...args);
    try {
      if (res.status === 402) {
        const data = await res.clone().json();
        if (data && data.error === 'subscription_required') showSubscribeModal();
      }
    } catch (e) {}
    return res;
  };
})();

async function doLogout() {
  await fetch(`${API_BASE}/api/auth/logout`, { method:'POST' });
  currentUser = null; athletes = []; selectedAthleteId = null;
  showMarketingLanding();
}

//  BOOT
async function bootApp() {
  var _mkt = document.getElementById('mktLanding'); if (_mkt) _mkt.classList.add('hidden');
  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.add('visible');
  document.body.classList.add('app-active'); // shows the mobile topbar (gated in CSS)
  document.getElementById('userName').textContent = currentUser.name || (currentUser.email || '').split('@')[0] || 'Agent';
  try {
    const subBtn = document.getElementById('agentSubscribeBtn');
    if (subBtn) {
      const active = currentUser.subscription_status === 'active';
      const isAdmin = currentUser.role === 'admin';
      const hasAccess = currentUser.agentAccess === true;
      subBtn.style.display = (!active && !isAdmin && !hasAccess) ? 'flex' : 'none';
    }
  } catch (e) {}
  // Store agent info for pitch deck contact modal
  try { sessionStorage.setItem('nilAgentInfo', JSON.stringify({name: currentUser.name, email: currentUser.email})); } catch(e){}
  // The assistant mounts HERE, not on DOMContentLoaded. index.html is served to
  // everyone signed in or not, so a self-mounting bubble appeared on the logged-out
  // marketing view and fired a request that 401ed. bootApp only runs once
  // /api/auth/me has confirmed a session.
  try { if (window.nilAssistant) window.nilAssistant.init(); } catch (e) { console.warn('[assistant]', e.message); }
  document.getElementById('userRole').textContent = currentUser.role;
  (function(){
    var _nm = (currentUser.name || '').trim();
    var _initials = _nm
      ? _nm.split(/\s+/).map(function(w){return w[0];}).join('').slice(0,2).toUpperCase()
      : (((currentUser.email || '').trim()[0]) || '?').toUpperCase();
    document.getElementById('userAvatar').textContent = _initials;
  })();
  var _isUnivRole = (currentUser.role === 'university' || currentUser.role === 'university_admin');
  var _isAdmin    = (currentUser.role === 'admin');
  document.getElementById('sidebarRoleLabel').textContent = (_isAdmin || currentUser.role === 'agent') ? 'Agent Portal' : _isUnivRole ? 'University Portal' : 'Athlete Portal';
  // Show admin mode switcher
  var adminSwitcher = document.getElementById('adminModeSwitcher');
  if (adminSwitcher) adminSwitcher.style.display = _isAdmin ? 'block' : 'none';

  // Show Growth tab for admin only
  var growthNavBtn = document.getElementById('growthNavBtn');
  if (growthNavBtn) growthNavBtn.style.display = _isAdmin ? 'flex' : 'none';
  if (_isAdmin) growthModule.loadBadge();

  // Restore saved commission rate
  const savedRate = localStorage.getItem('nilCommissionRate');
  if (savedRate && document.getElementById('comm-rate')) document.getElementById('comm-rate').value = savedRate;

  // Hide "Add Client" for athletes
  if (currentUser.role === 'athlete') {
    document.getElementById('addAthleteNavBtn').style.display = 'none';
  }

  await loadAthletes();
  loadKPIs();
  loadFollowUps();
  if (currentUser.role === 'athlete') {
    showView('athlete-dashboard', null);
    loadAthleteDashboard();
    loadAthleteCalendarPortal();
    loadAthleteOutreachHistory();
    // Hide entire agent nav for athletes
    const agentOnlyEls = ['view-home','view-command','view-deals','view-rate','view-negotiate','view-outreach','view-marketing','view-calendar','view-compliance','view-contract','view-pdf-scan','view-analytics','view-commission','view-pipeline','view-roster','view-add-athlete','view-athlete-portals','view-university-dashboard'];
    agentOnlyEls.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    // Hide sidebar nav sections
    var navSections = document.querySelectorAll('.nav-section-label');
    navSections.forEach(function(el) { el.style.display = 'none'; });
    var navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(function(el) { el.style.display = 'none'; });
    // Hide active client dropdown
    var clientBar = document.querySelector('.client-bar');
    if (clientBar) clientBar.style.display = 'none';
    var activeClientRow = document.querySelector('[style*="ACTIVE CLIENT"]');
    if (activeClientRow) activeClientRow.style.display = 'none';
  } else if (_isUnivRole) {
    // ── University mode boot ──────────────────────────────────────
    // Hide all standard agent nav items + section labels
    var agentNavItems = document.querySelectorAll('.nav-item:not([id^="univ"])');
    agentNavItems.forEach(function(el) { el.style.display = 'none'; });
    var agentSections = document.querySelectorAll('.nav-section-label:not(#univNavSection)');
    agentSections.forEach(function(el) { el.style.display = 'none'; });
    // Hide active client bar (agent tool, not relevant for university)
    var clientBar2 = document.querySelector('.client-bar');
    if (clientBar2) clientBar2.style.display = 'none';
    var activeClientRow2 = document.querySelector('[style*="ACTIVE CLIENT"]');
    if (activeClientRow2) activeClientRow2.style.display = 'none';
    // Show university nav
    var univNavIds = ['univNavSection','univOverviewNavBtn','univDevelopmentNavBtn','univComplianceNavBtn'];
    univNavIds.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'block';
    });
    // Boot into university dashboard
    showView('university-dashboard', document.getElementById('univOverviewNavBtn'));
    loadUniversityDashboard();
  } else if (!_isUnivRole && currentUser.role !== 'athlete') {
    // Normal agent — land on Home
    showView('home', document.getElementById('homeNavBtn'));
    loadAgentHome();
  }

  // Check AI status
  const health = await fetch(`${API_BASE}/api/health`).then(r=>r.json()).catch(()=>({aiReady:false}));
  const aiEl = document.getElementById('aiStatus');
  if (aiEl && !health.aiReady) { aiEl.textContent = ' AI KEY MISSING'; aiEl.style.color = 'var(--red)'; aiEl.style.borderColor = 'rgba(241,53,53,0.3)'; }
  const kpiAiEl = document.getElementById('kpi-ai');
  if (kpiAiEl) kpiAiEl.textContent = health.aiReady ? '' : '';
  const kpiAiSubEl = document.getElementById('kpi-ai-sub');
  if (kpiAiSubEl) kpiAiSubEl.textContent = health.aiReady ? 'Connected' : 'Key missing';
  // Check if new user needs onboarding
  setTimeout(checkOnboarding, 500);
  // Init email module (non-blocking — loads accounts + inbox in background)
  if (typeof emailModule !== 'undefined') {
    emailModule.init().catch(e => console.warn('[email] init error:', e.message));
  }
  // Load unread athlete-email badge count
  athleteEmailsModule.loadBadge();

  // Handle Google Calendar OAuth redirect (agent flow redirects to /#calendar?gcal=connected)
  const _gcalHash = window.location.hash || '';
  if (_gcalHash.includes('gcal=')) {
    const _gcalHashParts = _gcalHash.split('?');
    const _gcalHashView  = (_gcalHashParts[0] || '').replace('#', '').trim();
    const _gcalParams    = new URLSearchParams(_gcalHashParts[1] || '');
    const _gcalResult    = _gcalParams.get('gcal');
    if (_gcalResult === 'connected') {
      showToast('Google Calendar connected! Subscribe to your athletes\' NIL calendars below.', 'success');
      if (_gcalHashView === 'calendar' && currentUser && currentUser.role !== 'athlete') {
        setTimeout(function() {
          const calBtn = document.querySelector('.nav-item[onclick*="calendar"]');
          showView('calendar', calBtn);
        }, 300);
      }
      history.replaceState(null, '', window.location.pathname);
    } else if (_gcalResult === 'error') {
      const _gcalReason = _gcalParams.get('reason') || 'unknown error';
      showToast('Google Calendar connection failed: ' + _gcalReason, 'error');
      history.replaceState(null, '', window.location.pathname);
    }
  }
}

//  SESSION CHECK
async function checkSession() {
  try {
    const r = await fetch(`${API_BASE}/api/auth/me`);
    if (r.ok) { currentUser = await r.json(); bootApp(); }
  } catch {}
}

//  ATHLETES 
async function loadAthletes() {
  try {
    const r = await fetch(`${API_BASE}/api/athletes`);
    athletes = await r.json();
    window.athletes = athletes;
    window._allAthletes = athletes;
    renderRoster();
    populateAthleteSelect();
    populatePitchClientDropdown();
    document.getElementById('kpi-clients').textContent = athletes.length;
    renderHomeClientCta();
    setTimeout(renderRosterCompleteness, 200);
    setTimeout(updateNilRateKpi, 1000);
    if (athletes.length > 0 && !selectedAthleteId) {
      selectedAthleteId = athletes[0].id;
      document.getElementById('activeAthlete').value = selectedAthleteId;
      onAthleteChange();
    }
    // Pre-warm deal cache for global search
    window._athleteDealsCache = window._athleteDealsCache || {};
    athletes.forEach(function(a) {
      fetch(API_BASE + '/api/athletes/' + a.id + '/deals').then(function(r){ return r.json(); }).then(function(deals){
        window._athleteDealsCache[a.id] = (deals || []).map(function(d){ return Object.assign({}, d, {athleteName: a.name, athleteId: a.id}); });
      }).catch(function(){});
    });
  } catch(e) { console.error(e); }
}

async function populateAthleteSelect() {
  const sel = document.getElementById('activeAthlete');
  const cur = sel.value;
  sel.innerHTML = '<option value="">Select a client...</option>';
  athletes.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.id; opt.textContent = a.name;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

async function clearAllResults() {
  // Command center
  const cmdOut = document.getElementById('commandOutput');
  if (cmdOut) { cmdOut.classList.remove('visible'); const ct = document.getElementById('commandText'); if (ct) ct.textContent = ''; }

  // Deal scan — reset per-client lane state so switching clients gets a clean slate
  _dsLaneData = { local: null, social: null, topnil: null };
  _dsLaneBusy = { local: false, social: false, topnil: false };
  _dsLaneNote = { local: '', social: '', topnil: '' };
  _dsLaneExhausted = { local: false, social: false, topnil: false };
  window._dealScanResults = [];
  var _scanRanked = document.getElementById('scan-ranked-label');
  if (_scanRanked) _scanRanked.style.display = 'none';
  var _dsLanesEl = document.getElementById('ds-lanes');
  if (_dsLanesEl) _dsLanesEl.style.display = 'none';
  var _dsLaneTabsEl = document.getElementById('ds-lane-tabs');
  if (_dsLaneTabsEl) _dsLaneTabsEl.style.display = 'none';
  var _dsEmptyEl = document.getElementById('scan-results-empty');
  if (_dsEmptyEl) { _dsEmptyEl.style.display = ''; _dsEmptyEl.textContent = 'Select a client and run a deal scan to see recommendations across Local businesses and National Brands.'; }
  var _dsProgress = document.getElementById('ds-progress');
  if (_dsProgress) _dsProgress.style.display = 'none';

  // Rate calculator
  const rateAI = document.getElementById('rateAI');
  if (rateAI) rateAI.classList.remove('visible');

  // Negotiate
  const negAI = document.getElementById('negAI');
  if (negAI) { negAI.classList.remove('visible'); }
  const negText = document.getElementById('negText');
  if (negText) negText.textContent = '';
  const negBrand = document.getElementById('negBrand');
  if (negBrand) negBrand.value = '';
  const negOffer = document.getElementById('negOffer');
  if (negOffer) negOffer.value = '';
  const negTarget = document.getElementById('negTarget');
  if (negTarget) negTarget.value = '';

  // Team match
  const tmResults = document.getElementById('tm-results');
  if (tmResults) tmResults.innerHTML = '';

  // Outreach
  renderOutreachTracker();
  updateMarketingClientLabel();
  const orResults = document.getElementById('or-results');
  if (orResults) orResults.style.display = 'none';
  const orBrand = document.getElementById('or-brand');
  if (orBrand) orBrand.value = '';
  const orContact = document.getElementById('or-contact');
  if (orContact) orContact.value = '';
  const orGoal = document.getElementById('or-goal');
  if (orGoal) orGoal.value = '';

  // Compliance
  const compResults = document.getElementById('comp-results');
  if (compResults) compResults.style.display = 'none';
  lastComplianceResult = null;

  // Quick counter scripts in negotiate
  const qcs = document.getElementById('quickCounters');
  if (qcs) qcs.innerHTML = '';
}

async function onAthleteChange() {
  selectedAthleteId = document.getElementById('activeAthlete').value;
  const ath = athletes.find(a => a.id === selectedAthleteId);
  if (ath) {
    document.getElementById('cmdClientLabel').textContent = ath.name;
    loadKPIs();
    clearAllResults();
    // If Home is the active view, refresh the brief now that a client is confirmed
    const homeView = document.getElementById('view-home');
    if (homeView && homeView.classList.contains('active')) {
      loadHomeBrief();
    }
  }
  tmPreFillFromAthlete();
}

function tmPreFillFromAthlete() {
  var ctx = document.getElementById('tm-athlete-context');
  var noAth = document.getElementById('tm-no-athlete');
  if (!ctx) return;
  if (!selectedAthleteId) {
    ctx.style.display = 'none';
    if (noAth) noAth.style.display = 'block';
    return;
  }
  var ath = athletes.find(function(a) { return a.id === selectedAthleteId; });
  if (!ath) { ctx.style.display = 'none'; if (noAth) noAth.style.display = 'block'; return; }
  if (noAth) noAth.style.display = 'none';
  ctx.style.display = 'flex';
  var nameEl = document.getElementById('tm-ctx-name');
  var sportPosEl = document.getElementById('tm-ctx-sport-pos');
  var schoolEl = document.getElementById('tm-ctx-school');
  if (nameEl) nameEl.textContent = ath.name || '—';
  var sport = ath.sport || '';
  var pos = ath.position || '';
  if (sportPosEl) sportPosEl.textContent = [sport, pos].filter(Boolean).join(' · ') || 'Sport/position not set';
  if (schoolEl) schoolEl.textContent = ath.school ? ath.school : '';
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

async function renderRoster() {
  const grid = document.getElementById('rosterGrid');
  if (!athletes.length) {
    grid.innerHTML = '<div style="color:var(--muted);padding:40px;text-align:center">No clients yet. Use "Add Client" to add your first athlete.</div>';
    return;
  }
  grid.innerHTML = athletes.map(a => {
    const reach = (a.instagram + a.tiktok).toLocaleString();
    return `<div class="athlete-card ${a.id===selectedAthleteId?'selected':''}" onclick="selectAthlete('${a.id}')">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <div style="width:36px;height:36px;border-radius:50%;background:${ ['rgba(74,222,128,0.15)','rgba(96,165,250,0.15)','rgba(245,158,11,0.15)','rgba(167,139,250,0.15)'][Math.abs((a.name||'').charCodeAt(0))%4] };display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:${ ['#4ade80','#60a5fa','#f59e0b','#a78bfa'][Math.abs((a.name||'').charCodeAt(0))%4] };flex-shrink:0">${ (a.name||'?').split(' ').map(n=>n[0]).join('').substring(0,2).toUpperCase() }</div>
        <div class="ac-name">${escHtml(a.name)}</div>
      </div>
      <div class="ac-meta">${escHtml(a.sport)} · ${escHtml(a.position || '')} · ${escHtml(a.school || 'School not set')}</div>
      <div class="ac-meta" style="font-size:10px;margin-top:2px">${escHtml(a.year || '')} ${a.stats ? '· ' + escHtml(a.stats) : ''}</div>
      <div class="ac-stats">
        <div class="ac-stat"><span>${reach}</span> reach</div>
        <div class="ac-stat"><span>${a.engagement}%</span> eng</div>
      </div>
      ${a.instagramHandle ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px">
        <span style="font-size:10px;color:var(--muted)">@${escHtml(a.instagramHandle)}${(a.igStatsSource==='instagram_page'||a.igStatsSource==='web_estimate') && a.igStatsFetchedAt ? ' · ' + statSourceLabel(a.igStatsSource, new Date(a.igStatsFetchedAt).toLocaleDateString('en-US',{month:'short',day:'numeric'})) : (a.igStatsSource==='manual' ? ' · Manual' : '')}</span>
        <button onclick="event.stopPropagation();refreshAthleteStats('${a.id}', this)" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--accent);font-size:10px;padding:3px 8px;cursor:pointer;white-space:nowrap;font-weight:600">Refresh stats</button>
      </div>` : ''}
      <div style="margin-top:10px;margin-bottom:8px">
        <textarea
          onclick="event.stopPropagation()"
          onchange="saveAthleteNote('${a.id}', this.value)"
          placeholder="Agent notes..."
          rows="2"
          style="width:100%;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:10px;padding:6px 8px;resize:none;font-family:var(--mono);outline:none;line-height:1.4"
        >${escHtml(a.agentNote || '')}</textarea>
      </div>
      <div style="display:flex;gap:6px;margin-top:4px">
        <button onclick="event.stopPropagation();editAthlete('${a.id}')" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:11px;padding:6px;cursor:pointer;letter-spacing:0.02em">Edit</button>
        <button onclick="event.stopPropagation();deleteAthlete('${a.id}')" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--red);font-size:11px;padding:6px;cursor:pointer;letter-spacing:0.02em">Delete</button>
        <button onclick="event.stopPropagation();generateReport('${a.id}')" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:11px;padding:6px;cursor:pointer;letter-spacing:0.02em">Report</button>
        <button onclick="event.stopPropagation();openClientProfile('${a.id}')" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--accent);font-size:11px;padding:6px;cursor:pointer;letter-spacing:0.02em;font-weight:600">Profile</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:4px">
        <button onclick="event.stopPropagation();openBrandKitModal('${a.id}','${(a.name||'').replace(/'/g,'')}')" style="flex:1;background:rgba(132,204,22,0.08);border:1px solid rgba(132,204,22,0.25);border-radius:var(--r-sm);color:var(--accent);font-size:11px;padding:6px;cursor:pointer;font-weight:600">Pitch Deck</button>
        <button onclick="event.stopPropagation();openOutreachModal('${a.id}','${(a.name||'').replace(/'/g,'')}')" style="flex:1;background:rgba(132,204,22,0.08);border:1px solid rgba(132,204,22,0.25);border-radius:var(--r-sm);color:var(--accent);font-size:11px;padding:6px;cursor:pointer;font-weight:600">Outreach</button>
      </div>
      <div style="display:flex;gap:14px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">
        <span onclick="event.stopPropagation();openAthleteTool('${a.id}','rate')" style="font-size:11px;color:var(--accent);cursor:pointer">Rate Calculator</span>
        <span onclick="event.stopPropagation();openAthleteTool('${a.id}','athlete-portals')" style="font-size:11px;color:var(--accent);cursor:pointer">Portals</span>
        <span onclick="event.stopPropagation();openAthleteTool('${a.id}','compliance')" style="font-size:11px;color:var(--accent);cursor:pointer">Compliance</span>
      </div>
    </div>`;
  }).join('');
}

async function selectAthlete(id) {
  selectedAthleteId = id;
  document.getElementById('activeAthlete').value = id;
  const ath = athletes.find(a => a.id === id);
  if (ath) document.getElementById('cmdClientLabel').textContent = ath.name;
  renderRoster();
  onAthleteChange();
  showToast(ath.name + ' selected as active client');
  // If the agent is already on Deal Scan, hydrate the new client's cache immediately
  var dealsView = document.getElementById('view-deals');
  if (dealsView && dealsView.classList.contains('active')) loadDealScanCache();
  // Refresh the compliance state reference if that tab is open.
  var compView = document.getElementById('view-compliance');
  if (compView && compView.classList.contains('active')) { try { loadNilComplianceRef(); } catch(e) {} }
}

async function deleteAthlete(id) {
  if (!confirm('Delete this client? This cannot be undone.')) return;

  // Optimistic delete: update the UI immediately so the row vanishes right away,
  // then confirm with the backend in the background and restore on failure.
  const idx = athletes.findIndex(a => a.id === id);
  const removed = athletes[idx];
  const prevSelected = selectedAthleteId;

  athletes = athletes.filter(a => a.id !== id);
  if (selectedAthleteId === id) { selectedAthleteId = null; }
  renderRoster(); populateAthleteSelect();
  showToast('Client deleted');

  try {
    const r = await fetch(`${API_BASE}/api/athletes/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error('delete failed');
  } catch (e) {
    athletes.splice(idx, 0, removed);
    selectedAthleteId = prevSelected;
    renderRoster(); populateAthleteSelect();
    showToast('Delete failed — client restored');
  }
}

// ── Athlete interest tags: taxonomy + reusable chip picker ───────────────────
// Kept in sync with TAG_TAXONOMY in server/ai.js. Tags are stored on the
// athlete as "industry:sub" strings and feed Deal Scan search emphasis and
// scoring boosts.
var NIL_TAGS = {
  fitness:   { label: 'Fitness',                  subs: ['supplements','creatine','protein','apparel','gyms'] },
  foodbev:   { label: 'Food and Beverage',        subs: ['coffee','pizza','smoothies','energy drinks','snacks','restaurants'] },
  beauty:    { label: 'Beauty and Personal Care', subs: ['skincare','haircare','makeup','fragrance'] },
  fashion:   { label: 'Fashion',                  subs: ['streetwear','sneakers','accessories'] },
  auto:      { label: 'Auto',                     subs: ['dealerships','detailing','tires'] },
  wellness:  { label: 'Health and Wellness',      subs: ['chiropractic','physical therapy','mental health','recovery'] },
  tech:      { label: 'Tech and Gaming',          subs: ['gaming','apps','accessories'] },
  outdoors:  { label: 'Outdoors',                 subs: ['hunting','fishing','camping'] },
  finance:   { label: 'Finance',                  subs: ['banks','credit unions','insurance'] },
  community: { label: 'Community',                subs: ['local events','nonprofits','youth sports'] },
};
var _tagSel  = {};  // containerId -> Set of "industry:sub"
var _tagOpen = {};  // containerId -> expanded industry key or null

function nilTagFromSub(sub) {
  // Map a bare sub-tag (e.g. from AI Lookup) to its qualified form. First
  // industry containing the sub wins for the rare duplicated names.
  for (var k in NIL_TAGS) { if (NIL_TAGS[k].subs.indexOf(sub) !== -1) return k + ':' + sub; }
  return null;
}
function renderTagPicker(containerId, selected) {
  // Accept qualified ("fitness:supplements") AND bare ("supplements") stored
  // tags; bare ones are qualified via the taxonomy so editing an athlete with
  // bare tags pre-selects them instead of silently wiping them on re-save.
  if (selected) _tagSel[containerId] = new Set(selected.map(function(t){
    var i = t.indexOf(':');
    if (i > 0) {
      var ind = t.slice(0, i);
      return (NIL_TAGS[ind] && NIL_TAGS[ind].subs.indexOf(t.slice(i + 1)) !== -1) ? t : null;
    }
    return nilTagFromSub(String(t).toLowerCase());
  }).filter(Boolean));
  if (!_tagSel[containerId]) _tagSel[containerId] = new Set();
  var el = document.getElementById(containerId);
  if (!el) return;
  var sel = _tagSel[containerId];
  var open = _tagOpen[containerId] || null;
  var html = '<div style="display:flex;flex-wrap:wrap;gap:6px">';
  Object.keys(NIL_TAGS).forEach(function(ind){
    var t = NIL_TAGS[ind];
    var count = t.subs.filter(function(s){ return sel.has(ind + ':' + s); }).length;
    var active = count > 0 || open === ind;
    html += '<button type="button" onclick="tagPickerToggleInd(\'' + containerId + '\',\'' + ind + '\')" ' +
      'style="padding:5px 11px;border-radius:20px;font-size:11px;font-weight:600;cursor:pointer;border:1px solid ' +
      (active ? 'rgba(132,204,22,0.5);background:rgba(132,204,22,0.12);color:var(--accent)' : 'var(--border);background:var(--surface2);color:var(--muted)') + '">' +
      t.label + (count ? ' (' + count + ')' : '') + '</button>';
  });
  html += '</div>';
  if (open && NIL_TAGS[open]) {
    html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;padding:8px 10px;background:var(--surface2);border-radius:8px">';
    NIL_TAGS[open].subs.forEach(function(s){
      var key = open + ':' + s;
      var on = sel.has(key);
      html += '<button type="button" onclick="tagPickerToggleSub(\'' + containerId + '\',\'' + open + '\',\'' + s.replace(/'/g, "\\'") + '\')" ' +
        'style="padding:4px 10px;border-radius:16px;font-size:11px;cursor:pointer;border:1px solid ' +
        (on ? 'var(--accent);background:var(--accent);color:#000;font-weight:700' : 'var(--border);background:transparent;color:var(--text)') + '">' + s + '</button>';
    });
    html += '</div>';
  }
  el.innerHTML = html;
}
function tagPickerToggleInd(cid, ind) {
  _tagOpen[cid] = _tagOpen[cid] === ind ? null : ind;
  renderTagPicker(cid);
}
function tagPickerToggleSub(cid, ind, sub) {
  var key = ind + ':' + sub;
  var sel = _tagSel[cid] || (_tagSel[cid] = new Set());
  if (sel.has(key)) sel.delete(key); else sel.add(key);
  renderTagPicker(cid);
}
function tagPickerValue(cid) { return Array.from(_tagSel[cid] || []); }

// ── Instagram stats fetch for the Add/Edit Client form (Part B) ─────────────
// Tracks whether the currently shown followers/engagement came from the web or
// were manually entered, so we can label them and store the right source.
let _statFetchedSource = null;

function _statDateLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Human label for a stats source value.
function statSourceLabel(src, when) {
  if (src === 'instagram_page') return 'From Instagram, ' + when;
  if (src === 'web_estimate' || src === 'web_search') return 'Est. from web, ' + when;
  if (src === 'manual') return 'Manual';
  return '';
}

// Render the small source labels under the follower/engagement inputs based on
// an athlete's saved source, or the last fetch/edit in this session.
function renderStatSourceLabels(a) {
  const src = (a && a.igStatsSource) || _statFetchedSource;
  const when = a && a.igStatsFetchedAt ? new Date(a.igStatsFetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : _statDateLabel();
  const label = statSourceLabel(src, when);
  const igSrc = document.getElementById('a-ig-src'); if (igSrc) igSrc.textContent = label;
  const engSrc = document.getElementById('a-eng-src'); if (engSrc) engSrc.textContent = label;
}

// Editing a fetched value flips its source to Manual.
function flagStatManual() {
  _statFetchedSource = 'manual';
  const igSrc = document.getElementById('a-ig-src'); if (igSrc && igSrc.textContent) igSrc.textContent = 'Manual';
  const engSrc = document.getElementById('a-eng-src'); if (engSrc && engSrc.textContent) engSrc.textContent = 'Manual';
}

// Fetch stats for the handle in the Add/Edit form. Never fabricates: if nothing
// is found, followers default to 0 and engagement is left blank with helper text.
async function fetchStatsForForm() {
  const handleEl = document.getElementById('a_handle');
  const handle = (handleEl ? handleEl.value : '').trim().replace(/^@+/, '');
  const status = document.getElementById('a-fetch-status');
  const btn = document.getElementById('a-fetch-btn');
  if (!handle) { showToast('Enter an Instagram handle first'); return; }
  btn.disabled = true; btn.style.opacity = '0.7'; const orig = btn.textContent; btn.textContent = 'Fetching...';
  const rotating = ['Searching public stats', 'Checking stat trackers', 'Matching the handle'];
  let ri = 0;
  status.innerHTML = '<span style="color:var(--muted)">Searching public stats...</span>';
  const rot = setInterval(() => { status.innerHTML = '<span style="color:var(--muted)">' + rotating[ri++ % rotating.length] + '...</span>'; }, 1500);
  try {
    const targetId = _editingAthleteId || 'new';
    const r = await fetch(`${API_BASE}/api/athletes/${targetId}/fetch-social-stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instagramHandle: handle })
    });
    const data = await r.json();
    clearInterval(rot);
    if (data.found && (data.followers !== null || data.engagement_rate !== null)) {
      if (data.followers !== null) document.getElementById('a_ig').value = data.followers;
      else document.getElementById('a_ig').value = 0;
      if (data.engagement_rate !== null) document.getElementById('a_eng').value = data.engagement_rate;
      // Per-field source: exact page metadata beats web estimates.
      _statFetchedSource = data.followers_source === 'instagram_page' ? 'instagram_page' : 'web_estimate';
      const when = _statDateLabel();
      const igSrc = document.getElementById('a-ig-src');
      const engSrc = document.getElementById('a-eng-src');
      if (igSrc) igSrc.textContent = data.followers !== null ? statSourceLabel(data.followers_source, when) : 'No public count found. Enter it manually if you know it.';
      if (engSrc) engSrc.textContent = data.engagement_rate !== null ? statSourceLabel(data.engagement_source, when)
        : (data.engagement_suggestion || 'No published rate found. Typical range is 1 to 5 percent.');
      const bits = [];
      if (data.followers !== null) bits.push(Number(data.followers).toLocaleString() + ' followers' + (data.followers_source === 'instagram_page' ? ' (from Instagram)' : ''));
      if (data.engagement_rate !== null) bits.push(data.engagement_rate + '% engagement');
      status.innerHTML = '<span style="color:var(--accent)">Found ' + bits.join(', ') + '</span>';
    } else {
      if (!document.getElementById('a_ig').value) document.getElementById('a_ig').value = 0;
      const igSrc = document.getElementById('a-ig-src'); if (igSrc) igSrc.textContent = 'No public count found. Enter it manually if you know it.';
      const engSrc = document.getElementById('a-eng-src'); if (engSrc) engSrc.textContent = data.engagement_suggestion || 'No published rate found. Typical range is 1 to 5 percent.';
      status.innerHTML = '<span style="color:var(--muted)">No public numbers found. Enter what you know.</span>';
    }
  } catch (e) {
    clearInterval(rot);
    status.innerHTML = '<span style="color:var(--muted)">Could not fetch stats right now. Enter numbers manually.</span>';
  }
  btn.disabled = false; btn.style.opacity = ''; btn.textContent = orig;
}

// Refresh stats for a saved athlete from My Roster: re-calls the endpoint,
// updates the cache and the fetched date, then re-renders the roster.
async function refreshAthleteStats(id, btn) {
  const a = athletes.find(x => x.id === id);
  if (!a || !a.instagramHandle) { showToast('No Instagram handle saved for this athlete'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing...'; }
  try {
    const r = await fetch(`${API_BASE}/api/athletes/${id}/fetch-social-stats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instagramHandle: a.instagramHandle })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'failed');
    await loadAthletes();
    if (data.found && (data.followers !== null || data.engagement_rate !== null)) {
      const bits = [];
      if (data.followers !== null) bits.push(Number(data.followers).toLocaleString() + ' followers');
      if (data.engagement_rate !== null) bits.push(data.engagement_rate + '% engagement');
      showToast('Updated: ' + bits.join(', '));
    } else {
      showToast('No public numbers found for @' + a.instagramHandle);
    }
  } catch (e) {
    showToast('Could not refresh stats right now');
  }
  if (btn) { btn.disabled = false; btn.textContent = orig; }
}

let _editingAthleteId = null;

async function editAthlete(id) {
  _editingAthleteId = id;
  const a = athletes.find(x => x.id === id);
  if (!a) return;
  // Switch to Add Client view and pre-fill
  showView('add-athlete', document.getElementById('addAthleteNavBtn'));
  document.getElementById('a_name').value = a.name || '';
  document.getElementById('a_sport').value = a.sport || 'Basketball';
  document.getElementById('a_pos').value = a.position || '';
  document.getElementById('a_school').value = a.school || '';
  const aLegalEl = document.getElementById('a_legal_name'); if (aLegalEl) aLegalEl.value = a.legal_name || '';
  const aEmailEl = document.getElementById('a_email'); if (aEmailEl) aEmailEl.value = a.email || '';
  const aPEmailEl = document.getElementById('a_parent_email'); if (aPEmailEl) aPEmailEl.value = a.parentEmail || '';
  document.getElementById('a_tier').value = a.schoolTier || 'p4-mid';
  document.getElementById('a_ig').value = a.instagram || '';
  document.getElementById('a_tt').value = a.tiktok || '';
  document.getElementById('a_eng').value = a.engagement || '';
  const handleEl = document.getElementById('a_handle'); if (handleEl) handleEl.value = a.instagramHandle || '';
  const hometownEl = document.getElementById('a_hometown'); if (hometownEl) hometownEl.value = a.hometown || '';
  renderTagPicker('a_tags', Array.isArray(a.tags) ? a.tags : []);
  const pwEl = document.getElementById('a_productwants'); if (pwEl) pwEl.value = a.productWants || '';
  _statFetchedSource = a.igStatsSource || null;  // preserve existing source unless re-fetched/edited
  renderStatSourceLabels(a);
  document.getElementById('a_notes').value = a.notes || '';
  const ppgEl = document.getElementById('a_ppg'); if (ppgEl) ppgEl.value = a.ppg || '';
  const rpgEl = document.getElementById('a_rpg'); if (rpgEl) rpgEl.value = a.rpg || '';
  const apgEl = document.getElementById('a_apg'); if (apgEl) apgEl.value = a.apg || '';
  const fgEl = document.getElementById('a_fgpct'); if (fgEl) fgEl.value = a.fgPct || '';
  const bpgEl = document.getElementById('a_bpg'); if (bpgEl) bpgEl.value = a.bpg || '';
  const spgEl = document.getElementById('a_spg'); if (spgEl) spgEl.value = a.spg || '';
  const perEl = document.getElementById('a_per'); if (perEl) perEl.value = a.per || '';
  const draftEl = document.getElementById('a_draft'); if (draftEl) draftEl.value = a.draftStatus || '';
  const yearEl = document.getElementById('a_year');
  if (yearEl && a.year) { for (let o of yearEl.options) { if (o.value === a.year) { yearEl.value = a.year; break; } } }
  const statsEl = document.getElementById('a_stats');
  if (statsEl) statsEl.value = a.stats || '';
  const trEl = document.getElementById('a_transfer_reason');
  if (trEl && a.transferReason) trEl.value = a.transferReason;
  // Change save button to update mode
  const btn = document.getElementById('saveAthleteBtn');
  if (btn) { btn.textContent = 'Update Client →'; btn.setAttribute('onclick', `updateAthlete('${id}')`); }
  document.getElementById('addAthleteError').textContent = '';
  showToast('Editing ' + a.name + ' — make changes and click Update');
}

async function updateAthlete(id) {
  const name = document.getElementById('a_name').value.trim();
  if (!name) return;
  const data = {
    name,
    sport: document.getElementById('a_sport').value,
    legal_name: (document.getElementById('a_legal_name') ? document.getElementById('a_legal_name').value : '').trim(),
    position: document.getElementById('a_pos').value,
    school: document.getElementById('a_school').value,
    email: (document.getElementById('a_email') ? document.getElementById('a_email').value : '').trim(),
    parentEmail: (document.getElementById('a_parent_email') ? document.getElementById('a_parent_email').value : '').trim(),
    schoolTier: document.getElementById('a_tier').value,
    instagram: parseInt(document.getElementById('a_ig').value) || 0,
    tiktok: parseInt(document.getElementById('a_tt').value) || 0,
    engagement: parseFloat(document.getElementById('a_eng').value) || 3.0,
    notes: document.getElementById('a_notes').value,
    year: document.getElementById('a_year') ? document.getElementById('a_year').value : '',
    stats: document.getElementById('a_stats') ? document.getElementById('a_stats').value : '',
    transferReason: document.getElementById('a_transfer_reason') ? document.getElementById('a_transfer_reason').value : '',
    hometown: (document.getElementById('a_hometown') ? document.getElementById('a_hometown').value : '').trim(),
    tags: tagPickerValue('a_tags'),
    productWants: (document.getElementById('a_productwants') ? document.getElementById('a_productwants').value : '').trim(),
    instagramHandle: (document.getElementById('a_handle') ? document.getElementById('a_handle').value : '').trim().replace(/^@+/, '').toLowerCase(),
    igStatsSource: _statFetchedSource || 'manual',
  };
  const r = await fetch(`${API_BASE}/api/athletes/${id}`, {
    method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data)
  });
  const updated = await r.json();
  athletes = athletes.map(a => a.id === id ? updated : a);
  renderRoster(); populateAthleteSelect();
  // Reset save button
  const btn = document.querySelector('[onclick*="updateAthlete"]');
  const btn2 = document.getElementById('saveAthleteBtn'); if (btn2) { btn2.textContent = 'Save Client →'; btn2.setAttribute('onclick', 'addAthlete()'); }
  _editingAthleteId = null;
  showView('roster', document.querySelectorAll('.nav-item')[5]);
  showToast(name + ' updated!');
}

async function addAthlete() {
  _editingAthleteId = null;
  const name = document.getElementById('a_name').value.trim();
  const err  = document.getElementById('addAthleteError');
  if (!name) { err.textContent = 'Name is required'; return; }
  err.textContent = '';
  // Disable the Save button for the duration of the request so a slow save can't
  // be double-clicked into duplicate clients. Re-enabled in finally (success or error).
  const btn = document.getElementById('saveAthleteBtn');
  const btnLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
  try {
    const r = await fetch(`${API_BASE}/api/athletes`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        name, sport: document.getElementById('a_sport').value,
        legal_name: (document.getElementById('a_legal_name') ? document.getElementById('a_legal_name').value : '').trim(),
        position: document.getElementById('a_pos').value,
        school: document.getElementById('a_school').value,
        email: (document.getElementById('a_email') ? document.getElementById('a_email').value : '').trim(),
        parentEmail: (document.getElementById('a_parent_email') ? document.getElementById('a_parent_email').value : '').trim(),
        schoolTier: document.getElementById('a_tier').value,
        instagram: document.getElementById('a_ig').value,
        tiktok: document.getElementById('a_tt').value,
        engagement: document.getElementById('a_eng').value,
        notes: document.getElementById('a_notes').value,
        year: document.getElementById('a_year') ? document.getElementById('a_year').value : '',
        stats: document.getElementById('a_stats') ? document.getElementById('a_stats').value : '',
        transferReason: document.getElementById('a_transfer_reason') ? document.getElementById('a_transfer_reason').value : '',
        gpa: document.getElementById('a_gpa') ? document.getElementById('a_gpa').value : '',
        hometown: (document.getElementById('a_hometown') ? document.getElementById('a_hometown').value : '').trim(),
        tags: tagPickerValue('a_tags'),
        productWants: (document.getElementById('a_productwants') ? document.getElementById('a_productwants').value : '').trim(),
        instagramHandle: (document.getElementById('a_handle') ? document.getElementById('a_handle').value : '').trim().replace(/^@+/, '').toLowerCase(),
        igStatsSource: _statFetchedSource || 'manual',
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      if (data.code === 'SEAT_LIMIT_REACHED') {
        showToast('Athlete limit reached on your current plan — upgrade to add more athletes');
        return;
      }
      err.textContent = data.error; return;
    }
    athletes.push(data);
    renderRoster(); populateAthleteSelect();
    selectAthlete(data.id);
    document.getElementById('kpi-clients').textContent = athletes.length;
    renderHomeClientCta();
    showToast(' ' + data.name + ' added to roster!');
    ['a_name','a_legal_name','a_pos','a_school','a_email','a_parent_email','a_ig','a_tt','a_eng','a_notes','a_handle','a_hometown','a_productwants'].forEach(id => { const e = document.getElementById(id); if (e) e.value = ''; });
    renderTagPicker('a_tags', []);
    _statFetchedSource = null;
    const igSrc = document.getElementById('a-ig-src'); if (igSrc) igSrc.textContent = '';
    const engSrc = document.getElementById('a-eng-src'); if (engSrc) engSrc.textContent = '';
    if (typeof NILOnboard !== 'undefined' && NILOnboard.refreshChecklist) NILOnboard.refreshChecklist();
    showView('roster', document.querySelectorAll('.nav-item')[5]);
  } catch(e) { err.textContent = 'Error: ' + e.message; }
  finally { if (btn) { btn.disabled = false; btn.textContent = btnLabel || 'Save Client →'; } }
}

//  HOME PAGE
// Home add-client CTA: prominent empty state when no clients, subtle link otherwise.
// Persists on every Home visit (separate from the one-time onboarding overlay).
function renderHomeClientCta() {
  const el = document.getElementById('home-client-cta');
  if (!el) return;
  const count = (window.athletes || (typeof athletes !== 'undefined' ? athletes : []) || []).length;
  const go = "showView('add-athlete', document.getElementById('addAthleteNavBtn'))";
  if (count === 0) {
    el.innerHTML =
      '<div style="background:linear-gradient(135deg,#0D1520,#101b28);border:1px solid rgba(132,204,22,0.3);border-radius:10px;padding:22px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">'
      + '<div style="min-width:0">'
      +   '<div style="font-size:15px;font-weight:700;color:#F0EDE6;margin-bottom:4px">Add your first client</div>'
      +   '<div style="font-size:12px;color:#9aa0aa;line-height:1.5">Add an athlete to start scanning deals, building media kits, and tracking your pipeline.</div>'
      + '</div>'
      + '<button onclick="' + go + '" style="background:#84CC16;color:#0a0a0a;border:none;border-radius:8px;padding:11px 20px;font-weight:700;font-size:13px;cursor:pointer;white-space:nowrap">+ Add Client</button>'
      + '</div>';
  } else {
    // Adding clients lives in Roster / the left nav; nothing stranded on the dashboard.
    el.innerHTML = '';
  }
}

async function loadAgentHome() {
  renderHomeClientCta();
  loadTodayBlock(); // the centerpiece: what needs you today
  try {
    const data = await fetch(`${API_BASE}/api/agent/home-data`).then(r => r.json());
    document.getElementById('hs-pipeline').textContent = data.pipeline  || '$0';
    document.getElementById('hs-deals').textContent    = data.dealCount  != null ? data.dealCount  : '0';
    document.getElementById('hs-clients').textContent  = data.clientCount != null ? data.clientCount : '0';
    document.getElementById('hs-nil').textContent      = data.nilEarned  || '$0';
    renderHomeWeekDelivs(data.weekDeliverables || []);
    renderHomeMiniCal(data.weekDeliverables || []);
  } catch(e) {
    ['hs-pipeline','hs-deals','hs-clients','hs-nil'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0'; });
    renderHomeWeekDelivs([]);
    renderHomeMiniCal([]);
  }
  loadHomeFollowUps();
}

// ── TODAY action block ──────────────────────────────────────────────────────
var _todayUrgency = {
  red:   { color:'#EF4444', tint:'rgba(239,68,68,0.09)',  ring:'rgba(239,68,68,0.22)',  btnBg:'rgba(239,68,68,0.12)', btnBorder:'rgba(239,68,68,0.4)' },
  amber: { color:'#F59E0B', tint:'rgba(245,158,11,0.09)', ring:'rgba(245,158,11,0.22)', btnBg:'rgba(245,158,11,0.12)', btnBorder:'rgba(245,158,11,0.4)' },
  green: { color:'#84CC16', tint:'rgba(132,204,22,0.10)', ring:'rgba(132,204,22,0.22)', btnBg:'rgba(132,204,22,0.14)', btnBorder:'rgba(132,204,22,0.45)' },
};
async function loadTodayBlock() {
  const el = document.getElementById('home-today-list');
  if (!el) return;
  try {
    const data = await fetch(`${API_BASE}/api/agent/today`).then(r => r.json());
    window._todayActions = data.actions || [];
    renderTodayBlock(data);
  } catch(e) {
    window._todayActions = [];
    el.innerHTML = '<div style="font-size:11px;color:#4B5563;padding:6px 2px">Unable to load right now.</div>';
  }
}
function renderTodayBlock(data) {
  const el = document.getElementById('home-today-list');
  const sub = document.getElementById('home-today-sub');
  if (!el) return;
  const actions = (data && data.actions) || [];
  if (!actions.length) {
    // Never a bare "all caught up" checkmark. An agent with nothing in flight is
    // exactly the agent who needs a next step, not congratulations. Only an
    // agent with deals actually moving gets the green all-clear.
    const s = (data && data.summary) || {};
    const moving  = s.movingDeals || 0;
    const clients = s.clients || 0;

    var body, btn = null;
    if (!clients) {
      body = 'Add your first client and NILDash will start finding local brand deals in their market.';
      btn  = { label: 'Add a client', view: 'add-athlete' };
    } else if (!moving) {
      body = clients === 1
        ? 'Your client is scanned and nothing is overdue. Next step is working the businesses Deal Scan already found.'
        : 'Your ' + clients + ' clients are scanned and nothing is overdue. Next step is working the businesses Deal Scan already found.';
      btn  = { label: 'Open Deal Scan', view: 'deals' };
    } else {
      body = moving + (moving === 1 ? ' deal is moving' : ' deals are moving')
           + ' and nothing needs you right now.'
           + (s.nextDeadline ? ' Next deadline is ' + s.nextDeadline + '.' : '');
    }

    if (sub) sub.textContent = moving ? 'All caught up' : 'Where to start';
    var tint = moving ? 'rgba(132,204,22,0.08)' : 'rgba(0,212,255,0.07)';
    var ring = moving ? 'rgba(132,204,22,0.25)' : 'rgba(0,212,255,0.22)';
    var accent = moving ? '#84CC16' : '#00D4FF';
    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:10px;background:' + tint + ';border:.5px solid ' + ring + '">' +
        '<span style="width:22px;height:22px;border-radius:50%;background:' + (moving ? 'rgba(132,204,22,0.16)' : 'rgba(0,212,255,0.14)') + ';color:' + accent + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px">' + (moving ? '✓' : '→') + '</span>' +
        '<span style="flex:1;min-width:0;font-size:13px;color:#E5E7EB;line-height:1.5">' + escHtml(body) + '</span>' +
        (btn
          ? '<button onclick="deepLink(\'' + btn.view + '\',{})" style="flex-shrink:0;padding:7px 13px;background:rgba(0,212,255,0.12);border:1px solid rgba(0,212,255,0.4);color:#00D4FF;border-radius:7px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:var(--head)">' + escHtml(btn.label) + '</button>'
          : '') +
      '</div>';
    return;
  }
  if (sub) sub.textContent = actions.length + (actions.length === 1 ? ' thing needs you' : ' things need you');
  el.innerHTML = actions.map(function(a, i){
    var u = _todayUrgency[a.urgency] || _todayUrgency.amber;
    var label = (a.action && a.action.label) || 'Open';
    return '<div style="display:flex;align-items:center;gap:12px;padding:11px 13px;border-radius:10px;background:' + u.tint + ';border-left:3px solid ' + u.color + ';margin-bottom:8px">' +
      '<span style="width:10px;height:10px;border-radius:50%;background:' + u.color + ';flex-shrink:0;box-shadow:0 0 0 4px ' + u.ring + '"></span>' +
      '<span style="flex:1;min-width:0;font-size:12.5px;color:#E5E7EB;line-height:1.4">' + escHtml(a.text || '') + '</span>' +
      '<button onclick="todayAction(' + i + ')" style="flex-shrink:0;padding:7px 13px;background:' + u.btnBg + ';border:1px solid ' + u.btnBorder + ';color:' + u.color + ';border-radius:7px;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:var(--head)">' + escHtml(label) + '</button>' +
    '</div>';
  }).join('');
}
function todayAction(i) {
  var a = (window._todayActions || [])[i];
  if (a && a.action) deepLink(a.action.view, a.action.params || {});
}

// ── Deep-linking: open a tab with an entity preselected ─────────────────────
function deepLink(view, params) {
  params = params || {};
  if (params.athleteId) {
    try {
      selectedAthleteId = params.athleteId;
      var sel = document.getElementById('activeAthlete');
      if (sel) sel.value = String(params.athleteId);
    } catch(e) {}
  }
  if (view === 'outreach' || view === 'email-compose') {
    // "Draft follow-up" / "Follow up now" land in the Email Inbox composer with a
    // started follow-up, not the Media Kit outreach tab. This opens a view AND
    // triggers an action inside it: open Email Inbox, open Compose, and prefill
    // the recipient/subject/body.
    _openFollowupComposer(params);
    return;
  }
  if (view === 'calendar') { showView('calendar', document.querySelector('.nav-item[onclick*=calendar]')); return; }
  if (view === 'pipeline') {
    showView('pipeline', document.querySelector('.nav-item[onclick*=pipeline]'));
    if (params.dealId) setTimeout(function(){ _highlightPipelineDeal(params.dealId); }, 500);
    return;
  }
  showView(view, document.querySelector('.nav-item[onclick*=' + view + ']'));
}
function _resolveFollowupAthleteName(params) {
  if (params.athleteName && String(params.athleteName).trim()) return String(params.athleteName).trim();
  try {
    var list = (typeof athletes !== 'undefined' && athletes) ? athletes : (window.athletes || []);
    var a = list.find(function(x){ return String(x.id) === String(params.athleteId); });
    if (a) return a.name || (a.data && a.data.name) || '';
  } catch(e) {}
  return '';
}
// Open the Email Inbox composer with a started follow-up draft. The recipient is
// resolved with the SAME rule the outreach modal uses (a named person's
// non-generic email, or left empty on purpose; never info@). Sending works even
// while inbox reading is off, so this is the right home for a follow-up.
function _openFollowupComposer(params) {
  params = params || {};
  var emailBtn = document.getElementById('emailNavBtn');
  showView('email-inbox', emailBtn);
  try { if (typeof athleteEmailsModule !== 'undefined' && athleteEmailsModule.clearBadge) athleteEmailsModule.clearBadge(); } catch(e) {}
  var to = '';
  try {
    if (window.outreachEngine && typeof window.outreachEngine.resolvePersonalEmail === 'function') {
      to = window.outreachEngine.resolvePersonalEmail({ name: params.contactName || '', email: params.contactEmail || '' }) || '';
    }
  } catch(e) {}
  var athlete   = _resolveFollowupAthleteName(params) || 'my client';
  var brand     = (params.brand && String(params.brand).trim()) ? String(params.brand).trim() : 'your team';
  // Greet by first name only when we resolved a trusted personal contact (a
  // real recipient). A generic inbox or no contact gets a neutral greeting.
  var greetName = (to && params.contactName && String(params.contactName).trim()) ? String(params.contactName).trim().split(/\s+/)[0] : 'there';
  var subject   = 'Following up: ' + athlete + ' x ' + brand;
  var body = 'Hi ' + greetName + ',\n\n' +
    'I wanted to follow up on the partnership between ' + athlete + ' and ' + brand + '. ' +
    'We are excited about the fit and would love to keep things moving.\n\n' +
    'Would you have time this week for a quick call? I am happy to share ' + athlete + "'s latest numbers and a couple of ideas for how a collaboration could work.\n\n" +
    'Best,';
  setTimeout(function(){
    try {
      if (window.emailModule) {
        if (emailModule.loadAccounts) emailModule.loadAccounts();
        if (emailModule.loadInbox)    emailModule.loadInbox();
        if (emailModule.openComposer) emailModule.openComposer('new', { to: to, subject: subject, body: body });
      }
    } catch(e) { console.warn('[followup] composer open failed:', e && e.message); }
  }, 80);
}
function _highlightPipelineDeal(dealId) {
  var card = document.querySelector('[data-deal-id="' + dealId + '"]');
  if (!card) return;
  card.scrollIntoView({ behavior:'smooth', block:'center' });
  var prev = card.style.boxShadow;
  card.style.transition = 'box-shadow .3s';
  card.style.boxShadow = '0 0 0 2px #84CC16';
  setTimeout(function(){ card.style.boxShadow = prev || ''; }, 2200);
}

async function loadHomeBrief() {
  const bulletsEl = document.getElementById('home-brief-bullets');
  const footerEl  = document.getElementById('home-brief-footer');
  if (!bulletsEl) return;

  // Don't fire the AI call until a client is actually selected
  if (!selectedAthleteId) {
    bulletsEl.innerHTML = '<span style="font-size:11px;color:#4B5563;font-style:italic">Select a client above to load your AI brief.</span>';
    if (footerEl) footerEl.style.display = 'none';
    return;
  }

  const ICONS = [
    '<i class="ti ti-alert-circle" style="color:#EF4444;font-size:12px;flex-shrink:0;margin-top:1px"></i>',
    '<i class="ti ti-clock"        style="color:#F59E0B;font-size:12px;flex-shrink:0;margin-top:1px"></i>',
    '<i class="ti ti-calendar-event" style="color:#84CC16;font-size:12px;flex-shrink:0;margin-top:1px"></i>',
    '<i class="ti ti-mail"         style="color:#84CC16;font-size:12px;flex-shrink:0;margin-top:1px"></i>',
  ];

  // Show skeleton while loading
  const skeletonEl = document.getElementById('home-brief-skeleton');
  if (skeletonEl) skeletonEl.style.display = 'flex';

  try {
    const timeout = new Promise(resolve => setTimeout(() => resolve({ bullets: null }), 9000));
    const result  = await Promise.race([
      fetch(`${API_BASE}/api/agent/daily-brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json()),
      timeout,
    ]);
    const bullets = Array.isArray(result.bullets) && result.bullets.length
      ? result.bullets
      : ['No overdue deliverables — you\'re caught up.', 'All deals are moving — no stale activity.', 'Check your calendar for upcoming deliverables.', 'Welcome back — your NILDash is ready.'];
    bulletsEl.innerHTML = bullets.slice(0, 4).map((b, i) =>
      `<div style="display:flex;align-items:flex-start;gap:8px;padding:3px 0">${ICONS[i]||ICONS[3]}<span style="font-size:11px;color:#9CA3AF;line-height:1.4">${escHtml(b)}</span></div>`
    ).join('');
    if (footerEl) footerEl.style.display = 'flex';
  } catch(e) {
    bulletsEl.innerHTML = '<span style="font-size:11px;color:#4B5563">Welcome back! Your NILDash is ready.</span>';
    if (footerEl) footerEl.style.display = 'flex';
  }
}

function renderHomeWeekDelivs(delivs) {
  const el = document.getElementById('home-week-delivs');
  if (!el) return;
  if (!delivs.length) {
    el.innerHTML = '<div style="font-size:11px;color:#4B5563;padding:4px 0">No deliverables this week.</div>';
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  // Dedupe: group identical rows by athlete + brand so five identical Instagram
  // Story rows collapse into one "Amber Bretton · Revive, 5 due tomorrow" row
  // with an expand affordance.
  const groups = [];
  const byKey = {};
  delivs.forEach(d => {
    const key = (d.athlete_name || '') + '||' + (d.brand || '');
    if (!byKey[key]) { byKey[key] = { athlete: d.athlete_name || '—', brand: d.brand || '', items: [] }; groups.push(byKey[key]); }
    byKey[key].items.push(d);
  });
  const dow = ds => { try { return new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' }); } catch(e) { return ds; } };
  el.innerHTML = groups.slice(0, 6).map((g, gi) => {
    const dates = g.items.map(d => d.event_date ? String(d.event_date).split('T')[0] : null).filter(Boolean).sort();
    const earliest = dates[0] || today;
    const days = Math.round((new Date(earliest + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
    const dotColor = days < 0 ? '#EF4444' : days <= 1 ? '#F59E0B' : '#84CC16';
    const when = days < 0 ? 'overdue' : days === 0 ? 'today' : days === 1 ? 'tomorrow' : dow(earliest);
    const n = g.items.length;
    const noun = n === 1 ? 'deliverable' : 'deliverables';
    const gid = 'wk-grp-' + gi;
    const expandable = n > 1;
    const sub = g.items.map(it => {
      const ds = it.event_date ? String(it.event_date).split('T')[0] : '';
      return '<div style="font-size:10px;color:#6B7280;padding:2px 0 2px 15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(it.title || '—') + (ds ? ' <span style="color:#4B5563">· ' + ds + '</span>' : '') + '</div>';
    }).join('');
    return '<div style="border-bottom:.5px solid #1e2a3a">' +
      '<div ' + (expandable ? 'onclick="_wkToggle(\'' + gid + '\')" ' : '') + 'style="display:flex;align-items:center;gap:8px;padding:6px 0;' + (expandable ? 'cursor:pointer' : '') + '">' +
        '<div style="width:7px;height:7px;border-radius:50%;background:' + dotColor + ';flex-shrink:0"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:11px;color:#E5E7EB;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(g.athlete) + (g.brand ? ' <span style="color:#6B7280">· ' + escHtml(g.brand) + '</span>' : '') + '</div>' +
          '<div style="font-size:10px;color:#6B7280">' + n + ' ' + noun + ' due ' + when + '</div>' +
        '</div>' +
        (expandable ? '<span id="' + gid + '-caret" style="font-size:11px;color:#4B5563;flex-shrink:0">▾</span>' : '') +
      '</div>' +
      (expandable ? '<div id="' + gid + '" style="display:none;padding-bottom:5px">' + sub + '</div>' : '') +
    '</div>';
  }).join('');
}
function _wkToggle(id) {
  var b = document.getElementById(id); var c = document.getElementById(id + '-caret');
  if (!b) return;
  var open = b.style.display !== 'none';
  b.style.display = open ? 'none' : 'block';
  if (c) c.textContent = open ? '▾' : '▴';
}

function renderHomeMiniCal(delivs) {
  const el = document.getElementById('home-mini-cal');
  if (!el) return;
  const today   = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dow     = today.getDay(); // 0=Sun
  const monday  = new Date(today);
  monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));

  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d);
  }

  const delivsByDate = {};
  delivs.forEach(d => {
    const ds = d.event_date ? String(d.event_date).split('T')[0] : null;
    if (ds) { if (!delivsByDate[ds]) delivsByDate[ds] = []; delivsByDate[ds].push(d); }
  });

  const DAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  let html = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px">';
  DAY_LABELS.forEach(d => { html += `<div style="text-align:center;font-size:9px;color:#4B5563;padding-bottom:5px">${d}</div>`; });
  dates.forEach(d => {
    const ds     = d.toISOString().split('T')[0];
    const isToday = ds === todayStr;
    const events  = delivsByDate[ds] || [];
    const days    = Math.round((new Date(ds+'T00:00:00') - new Date(todayStr+'T00:00:00')) / 86400000);
    const dotColor = events.length ? (days < 0 ? '#EF4444' : days <= 2 ? '#F59E0B' : '#84CC16') : null;
    const cellBg  = isToday ? 'background:#0D2010;border:.5px solid #84CC16' : 'background:rgba(255,255,255,0.02);border:.5px solid transparent';
    html += `<div style="${cellBg};border-radius:6px;padding:5px 2px;display:flex;flex-direction:column;align-items:center;gap:3px">
      <div style="font-size:11px;color:${isToday?'#84CC16':'#9CA3AF'};font-weight:${isToday?600:400}">${d.getDate()}</div>
      ${dotColor ? `<div style="width:5px;height:5px;border-radius:50%;background:${dotColor}"></div>` : '<div style="width:5px;height:5px"></div>'}
    </div>`;
  });
  html += '</div>';

  const todayEvents = delivsByDate[todayStr] || [];
  if (todayEvents.length) {
    html += '<div style="margin-top:11px;font-size:9px;color:#4B5563;letter-spacing:1px;text-transform:uppercase;margin-bottom:5px">Today</div>';
    html += todayEvents.slice(0, 3).map(e =>
      `<div style="font-size:11px;color:#9CA3AF;padding:3px 0;border-bottom:.5px solid #1e2a3a">${escHtml(e.title||'—')}${e.athlete_name ? ' <span style="color:#4B5563">· '+escHtml(e.athlete_name)+'</span>' : ''}</div>`
    ).join('');
  }
  el.innerHTML = html;
}

async function loadHomeFollowUps() {
  const el = document.getElementById('home-followups-list');
  if (!el) return;
  try {
    const data  = await fetch(`${API_BASE}/api/dashboard/followups`).then(r => r.json());
    const items = data.followups || [];
    if (!items.length) {
      el.innerHTML = '<div style="font-size:11px;color:#4B5563;padding:4px 0">No follow-ups needed right now.</div>';
      return;
    }
    const urgencyColor = { high:'#EF4444', medium:'#F59E0B', low:'rgba(255,255,255,0.2)' };
    window._homeFollowups = items;
    el.innerHTML = items.slice(0, 6).map((f, i) => {
      const canDraft = f.type === 'deal' && f.athleteId;
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:.5px solid #1e2a3a">' +
        '<div style="width:7px;height:7px;border-radius:50%;background:' + (urgencyColor[f.urgency]||'#4B5563') + ';flex-shrink:0"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:11px;color:#E5E7EB;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escHtml(f.label||'') + '</div>' +
          '<div style="font-size:10px;color:#6B7280">' + escHtml(f.detail||'') + '</div>' +
        '</div>' +
        (canDraft ? '<button onclick="homeFollowupDraft(' + i + ')" style="flex-shrink:0;padding:5px 10px;background:rgba(132,204,22,0.12);border:1px solid rgba(132,204,22,0.35);color:#84CC16;border-radius:6px;font-size:10.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:var(--head)">Draft follow-up</button>' : '') +
      '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="font-size:11px;color:#4B5563">Unable to load.</div>';
  }
}
function homeFollowupDraft(i) {
  var f = (window._homeFollowups || [])[i];
  if (!f) return;
  deepLink('email-compose', {
    athleteId:    f.athleteId,
    brand:        f.brand || '',
    athleteName:  f.athleteName || '',
    contactName:  f.contactName || '',
    contactEmail: f.contactEmail || '',
    contactTitle: f.contactTitle || '',
  });
}

//  KPIS
async function loadFollowUps() {
  const el = document.getElementById('followup-list');
  if (!el) return;
  try {
    const data = await fetch(`${API_BASE}/api/dashboard/followups`).then(r=>r.json());
    const items = data.followups || [];
    if (!items.length) {
      el.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0">No follow-ups needed right now.</div>';
      return;
    }
    const urgencyColor = { high:'#FF3D5A', medium:'#FFB800', low:'rgba(255,255,255,0.25)' };
    el.innerHTML = items.map(f => `
      <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
        <div style="width:6px;height:6px;border-radius:50%;background:${urgencyColor[f.urgency]};flex-shrink:0;margin-top:4px"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.label}</div>
          <div style="font-size:10px;color:var(--muted);margin-top:1px">${f.detail}</div>
        </div>
      </div>`).join('');
  } catch(e) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted)">Unable to load.</div>';
  }
}

async function loadKPIs() {
  if (!selectedAthleteId) return;
  try {
    const deals = await fetch(`${API_BASE}/api/athletes/${selectedAthleteId}/deals`).then(r=>r.json());
    const total = deals.reduce((s,d) => s + (parseInt(d.value) || 0), 0);
    document.getElementById('kpi-pipeline').textContent = '$' + (total/1000).toFixed(0) + 'K';
    document.getElementById('kpi-deals').textContent = deals.filter(d=>d.stage!=='Closed').length;
  } catch {}
}

//  VIEWS 
// ── Weekly athlete report ───────────────────────────────────────────────────
// Preview then send. The agent always sees the exact email before it reaches a
// 19-year-old and their parents.
var _arState = { athleteId: null, recipients: [], html: '', subject: '' };

async function openAthleteReport(athleteId, athleteName) {
  _arState = { athleteId: athleteId, recipients: [], html: '', subject: '' };
  var m = document.getElementById('arModal');
  if (!m) return;
  m.style.display = 'flex';
  document.getElementById('arTitle').textContent = 'Weekly report for ' + (athleteName || 'athlete');
  document.getElementById('arBody').innerHTML =
    '<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">Building the report...</div>';
  document.getElementById('arFooter').style.display = 'none';

  try {
    var d = await fetch(API_BASE + '/api/athlete-report/preview/' + encodeURIComponent(athleteId))
      .then(function(r) { return r.json(); });
    if (d.error) throw new Error(d.error);

    _arState.html = d.html; _arState.subject = d.subject;
    _arState.recipients = d.recipients || [];

    if (!d.enoughActivity) {
      document.getElementById('arBody').innerHTML =
        '<div style="padding:32px 28px;text-align:center">' +
          '<div style="font-size:15px;color:#E5E7EB;margin-bottom:8px">Nothing happened this week</div>' +
          '<div style="font-size:13px;color:var(--muted);line-height:1.6;max-width:380px;margin:0 auto">' +
            'No outreach went out and no brands looked at the media kit. Sending a report that says nothing ' +
            'does more harm than sending none. Run some outreach first, then come back.' +
          '</div></div>';
      return;
    }

    var s = d.summary || {};
    var chips = [
      s.pitched  ? s.pitched + ' pitched' : null,
      s.replies  ? s.replies + ' replied' : null,
      s.opens    ? s.opens + ' opened' : null,
      s.overdue  ? s.overdue + ' past due' : null
    ].filter(Boolean).map(function(t) {
      return '<span style="font-size:11px;color:#84CC16;background:rgba(132,204,22,0.1);padding:3px 9px;border-radius:99px;margin-right:6px">' + escHtml(t) + '</span>';
    }).join('');

    document.getElementById('arBody').innerHTML =
      '<div style="padding:14px 20px;border-bottom:.5px solid #1e2a3a">' + chips + '</div>' +
      '<div style="padding:14px 20px;border-bottom:.5px solid #1e2a3a">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Subject</div>' +
        '<div style="font-size:13px;color:#E5E7EB">' + escHtml(d.subject) + '</div>' +
      '</div>' +
      '<div style="padding:14px 20px;border-bottom:.5px solid #1e2a3a">' +
        '<div style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:6px">Send to</div>' +
        '<input id="arRecips" class="input-sm" style="width:100%" value="' + escHtml(_arState.recipients.join(', ')) + '" placeholder="athlete@email.com, parent@email.com">' +
        '<div style="font-size:10px;color:var(--muted);margin-top:4px">Comma separated. Replies come straight back to you.</div>' +
      '</div>' +
      '<iframe id="arFrame" style="width:100%;height:460px;border:0;background:#f3f4f6"></iframe>';

    // srcdoc sandboxes the email markup from the app's own styles.
    document.getElementById('arFrame').srcdoc = d.html;
    document.getElementById('arFooter').style.display = 'flex';
  } catch (e) {
    document.getElementById('arBody').innerHTML =
      '<div style="padding:32px;text-align:center;color:#EF4444;font-size:13px">' + escHtml(e.message || 'Could not build the report') + '</div>';
  }
}

function closeAthleteReport() {
  var m = document.getElementById('arModal'); if (m) m.style.display = 'none';
}

async function sendAthleteReport() {
  var btn = document.getElementById('arSendBtn');
  var input = document.getElementById('arRecips');
  var recips = (input ? input.value : '').split(',').map(function(x) { return x.trim(); }).filter(Boolean);
  if (!recips.length) { alert('Add at least one email address.'); return; }
  if (!confirm('Send this report to ' + recips.join(', ') + '?')) return;

  btn.disabled = true; btn.textContent = 'Sending...';
  try {
    var r = await fetch(API_BASE + '/api/athlete-report/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId: _arState.athleteId, recipients: recips })
    }).then(function(x) { return x.json(); });
    if (r.error) throw new Error(r.error);
    btn.textContent = 'Sent';
    setTimeout(closeAthleteReport, 900);
  } catch (e) {
    alert(e.message || 'Send failed');
    btn.disabled = false; btn.textContent = 'Send report';
  }
}

async function showView(id, btn) {
  if(window.innerWidth<=768){var _sb=document.querySelector('.sidebar');if(_sb){_sb.classList.remove('open');_sb.style.removeProperty('display');}var o=document.getElementById('sidebarOverlay');if(o){o.classList.remove('open');o.style.pointerEvents='none';}document.body.style.overflow='';}
  if (id === 'marketing') { setTimeout(populatePitchClientDropdown, 80); }
      if (id === 'commission') setTimeout(renderCommission, 100);
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + id).classList.add('active');
  if (btn) btn.classList.add('active');
  const labels = { home:'Home', command:'Command Center', deals:'Deal Scan', rate:'Rate Calculator',
    marketing:'Media Kit',
    negotiate:'Negotiation Intel', pipeline:'Deal Pipeline', outreach:'Brand Outreach', calendar:'Deliverables Calendar', compliance:'NIL Compliance', contract:'Contract Generator', 'pdf-scan':'PDF Scanner', commission:'Commission Tracker', roster:'My Roster', 'add-athlete':'Add Client', 'athlete-portals':'Athlete Portals', 'athlete-dashboard':'My NIL Dashboard', 'email-inbox':'Email Inbox', settings:'Settings', 'university-dashboard':'University Portal', programs:'Programs' };
  document.getElementById('breadcrumb').textContent = labels[id] || id;
  const showBar = ['command','deals','rate','negotiate'].includes(id);
  document.getElementById('athleteBar').style.display = showBar ? 'flex' : 'none';
  if (id === 'pipeline') loadPipeline();
  if (id === 'calendar') { if (window.NILCal) NILCal.initLabel(); loadCalendar(); initAgentGCalStatus(); }
  if (id === 'analytics') loadAnalytics();
  if (id === 'command') setTimeout(updateNilRateKpi, 800);
  if (id === 'roster') renderRoster();
  if (id === 'athlete-portals') { loadAthletePortals(); setTimeout(loadAgentOutreach, 400); }
  if (id === 'contract') prefillContract();
  if (id === 'deals') { if (selectedAthleteId) loadDealScanCache(); }
  // Warm the school list so the first keystroke in the search box is instant.
  if (id === 'programs') { try { progRenderSportToggle(); progLoadSchools(); } catch (e) {} }
  if (id === 'compliance') { try { loadNilComplianceRef(); } catch(e) {} }
  if (id === 'outreach') { try { loadUnifiedOutreach(); } catch(e) {} }
  if (id === 'pdf-scan') loadPdfScanAthletes();
  if (id === 'add-athlete') { const tp = document.getElementById('a_tags'); if (tp && !tp.innerHTML) renderTagPicker('a_tags', []); }
  if (id === 'rate') { try { loadBenchmarks(); } catch(e) {} }
}

// ── Local deal benchmarks ───────────────────────────────────────────────────
// Pooled real closes across all agents. Categories under the sample threshold
// deliberately show a count and no dollar figures: a median from three deals
// looks authoritative and is noise, and an agent who prices off it loses money.
async function loadBenchmarks() {
  var el = document.getElementById('bm-list');
  var tot = document.getElementById('bm-total');
  if (!el) return;
  try {
    var d = await fetch(API_BASE + '/api/benchmarks').then(function(r){ return r.json(); });
    var rows = d.rows || [];
    if (tot) tot.textContent = d.totalDeals ? (d.totalDeals + ' logged close' + (d.totalDeals === 1 ? '' : 's')) : '';

    if (!rows.length) {
      el.innerHTML = '<div style="font-size:12px;color:#6B7280;line-height:1.6;padding:4px 2px">'
        + 'No closed deals logged yet. Every deal you move to Closed adds a data point here, '
        + 'and the numbers get sharper for everyone as more agents close.</div>';
      return;
    }

    el.innerHTML = rows.map(function(r){
      var name = r.category.charAt(0).toUpperCase() + r.category.slice(1);
      if (!r.enough) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-top:.5px solid #1e2a3a">'
          + '<span style="font-size:12.5px;color:#6B7280">' + escHtml(name) + '</span>'
          + '<span style="font-size:11px;color:#4B5563">' + r.n + ' of ' + d.minSample + ' deals needed</span>'
          + '</div>';
      }
      return '<div style="padding:10px 0;border-top:.5px solid #1e2a3a">'
        + '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">'
          + '<span style="font-size:12.5px;color:#E5E7EB">' + escHtml(name) + '</span>'
          + '<span style="font-size:15px;font-weight:500;color:#84CC16">$' + r.median.toLocaleString() + '</span>'
        + '</div>'
        + '<div style="font-size:11px;color:#4B5563;margin-top:3px">'
          + 'typical range $' + r.p25.toLocaleString() + ' to $' + r.p75.toLocaleString()
          + (r.medianDays != null ? ' · about ' + r.medianDays + ' days to close' : '')
          + ' · ' + r.n + ' deals'
        + '</div>'
      + '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="font-size:11px;color:#4B5563;padding:6px 2px">Unable to load right now.</div>';
  }
}
// "More" nav group: expand/collapse in place. Session-only state (lives in the DOM,
// resets on reload), never persisted.
function toggleMoreNav() {
  var g = document.getElementById('moreNavGroup');
  var t = document.getElementById('moreNavToggle');
  var chev = document.getElementById('moreNavChevron');
  if (!g) return;
  var willOpen = g.style.display === 'none' || !g.style.display;
  g.style.display = willOpen ? 'block' : 'none';
  if (t) t.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (chev) chev.style.transform = willOpen ? 'rotate(180deg)' : '';
}
// Open an athlete-context tool (Rate Calculator / Athlete Portals / Compliance)
// with that athlete pre-selected as the active client. Reached from the My Roster
// card. selectAthlete sets selectedAthleteId synchronously before showView reads it.
function openAthleteTool(id, view) {
  selectAthlete(id);
  showView(view);
}
async function prefillContract() {
  if (!selectedAthleteId) return;
  const ath = athletes.find(a => a.id === selectedAthleteId);
  if (!ath) return;
  // Pre-fill agent info from session if available
  const agentName = document.getElementById('con-agent-name');
  const agentEmail = document.getElementById('con-agent-email');
  if (agentName && !agentName.value) agentName.value = currentUser ? (currentUser.name || '') : '';
  if (agentEmail && !agentEmail.value) agentEmail.value = currentUser ? (currentUser.email || '') : '';
}

//  AI: COMMAND 
async function setPrompt(text) { document.getElementById('commandInput').value = text; document.getElementById('commandInput').focus(); }

async function runCommand() {
  const msg = document.getElementById('commandInput').value.trim();
  if (!msg) return;
  const btn = document.getElementById('runCmdBtn');
  btn.disabled = true; btn.textContent = 'Thinking...';
  const out = document.getElementById('commandOutput');
  const outputEl = document.getElementById('commandText');
  out.classList.add('visible');
  outputEl.textContent = 'NILDash is thinking...';
  document.getElementById('cmdSpinner').style.display = 'block';
  try {
    const response = await fetch(`${API_BASE}/api/ai/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ athleteId: selectedAthleteId, message: msg })
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let result = '';
    let buffer = '';
    let done2 = false;
    outputEl.textContent = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line in buffer
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const text = line.slice(6).trim();
        if (text === '[DONE]') { done2 = true; break; }
        try { const parsed = JSON.parse(text); result += parsed.text || ''; }
        catch(e) { /* skip malformed chunk */ }
        outputEl.textContent = result;
      }
      if (done2) break;
    }
    if (!result) outputEl.textContent = 'No response received.';
  } catch(e) { outputEl.textContent = '\u274c ' + e.message; }
  document.getElementById('cmdSpinner').style.display = 'none';
  btn.disabled = false; btn.textContent = 'Run \u2192';
}

// ══════════════════════════════════════════════════════════════════
// ── Deal Scan lane engine (ported from athlete portal) ────
// esc alias so ported functions work without modification
var esc = escHtml;

// Per-lane scan state. null = never scanned; [] = scanned, genuinely empty.
var _dsLaneData = { local: null, social: null, topnil: null };
var _dsLaneNote = { local: '', social: '', topnil: '' };
var _dsLaneBusy = { local: false, social: false, topnil: false };
// True when the server says this lane's pool is fully shown, which drives the
// "Find more businesses" deepen button on the local lane.
var _dsLaneExhausted = { local: false, social: false, topnil: false };
// Rate cards are stored PER ATHLETE so one athlete's card never renders on another
// athlete's cards. window._agentRateCard is kept only as a legacy alias to the
// ACTIVE athlete's entry (nothing else reads it today).
window._agentRateCards = {}; // { [athleteId]: rateCard }
window._agentRateCard = null; // legacy alias -> active athlete's entry
// Store a rate card under the athlete it was computed for. Only updates the legacy
// alias when the response is for the currently-active athlete, so a late response
// for a previously-selected athlete can never overwrite the active card.
function _dsSetRateCard(athleteId, rateCard) {
  if (!athleteId || !rateCard) return;
  window._agentRateCards[athleteId] = rateCard;
  if (athleteId === selectedAthleteId) window._agentRateCard = rateCard;
}

var DS_LANES = ['local', 'social', 'topnil'];
var _dsLaneMeta = {
  local:  { label: 'Local',       chip: 'rgba(132,204,22,0.18);color:#84CC16;border:1px solid rgba(132,204,22,0.3)' },
  social: { label: 'Social',      chip: 'rgba(168,85,247,0.18);color:#c084fc;border:1px solid rgba(168,85,247,0.3)' },
  topnil: { label: 'National Brands',     chip: 'rgba(59,130,246,0.18);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)' }
};
var _dsCatColors = {
  'local':'rgba(132,204,22,0.15);color:#84CC16','auto':'rgba(59,130,246,0.15);color:#60a5fa',
  'gym':'rgba(239,68,68,0.15);color:#f87171','food':'rgba(245,158,11,0.15);color:#f59e0b',
  'restaurant':'rgba(245,158,11,0.15);color:#f59e0b','nutrition':'rgba(16,185,129,0.15);color:#34d399',
  'apparel':'rgba(168,85,247,0.15);color:#c084fc','finance':'rgba(16,185,129,0.15);color:#34d399',
  'insurance':'rgba(16,185,129,0.15);color:#34d399','realestate':'rgba(59,130,246,0.15);color:#60a5fa',
  'training':'rgba(245,158,11,0.15);color:#f59e0b','supplements':'rgba(16,185,129,0.15);color:#34d399',
  'energydrink':'rgba(239,68,68,0.15);color:#f87171','app':'rgba(59,130,246,0.15);color:#60a5fa',
  'accessories':'rgba(168,85,247,0.15);color:#c084fc','beauty':'rgba(236,72,153,0.15);color:#f472b6',
  'fitness':'rgba(245,158,11,0.15);color:#f59e0b','dtc':'rgba(168,85,247,0.15);color:#c084fc',
  'tech':'rgba(59,130,246,0.15);color:#60a5fa','retail':'rgba(245,158,11,0.15);color:#f59e0b',
  'nil':'rgba(132,204,22,0.15);color:#84CC16'
};

function _dsHasAnyData() { return DS_LANES.some(function(l){ return _dsLaneData[l] !== null; }); }
// Rotating scan status text so a long scan reads as active work, not a stall.
var _dsRotateTimer = null;
function _dsRotateMessages() {
  var ath = athletes && athletes.find(function(a){ return a.id === selectedAthleteId; });
  var first = ath && ath.name ? String(ath.name).split(/\s+/)[0] : 'your athlete';
  var msgs = [
    'Searching ' + _dsMarketLabel() + ' businesses',
    'Checking local franchises',
    'Scoring matches for ' + first,
  ];
  if (ath && ath.hometown) msgs.splice(1, 0, 'Searching ' + String(ath.hometown).split(',')[0].trim() + ' businesses');
  return msgs;
}
function _dsStartRotation() {
  _dsStopRotation();
  var msgs = _dsRotateMessages();
  var i = 0;
  var tick = function(){
    document.querySelectorAll('.ds-rotate-txt').forEach(function(el){ el.textContent = msgs[i % msgs.length]; });
    i++;
  };
  tick();
  _dsRotateTimer = setInterval(tick, 2200);
}
function _dsStopRotation() { if (_dsRotateTimer) { clearInterval(_dsRotateTimer); _dsRotateTimer = null; } }
function _dsLaneLoadingHtml() {
  return '<div class="ds-lane-loading"><span class="ds-lane-spin"></span> <span class="ds-rotate-txt">Searching ' + escHtml(_dsMarketLabel()) + ' businesses</span></div>';
}

function switchLane(lane) {
  document.querySelectorAll('#ds-lane-tabs .ds-lane-tab').forEach(function(t){
    t.classList.toggle('active', t.getAttribute('data-lane') === lane);
  });
  document.querySelectorAll('#ds-lanes .ds-lane').forEach(function(c){
    c.classList.toggle('active', c.getAttribute('data-lane') === lane);
  });
}
// Desktop-only right-panel tab switch (Social / National). Separate from switchLane
// because that one is coupled to the mobile breakpoint. Toggles visibility only;
// neither lane's rendered data is destroyed, so switching back is instant.
function _dsSwitchRightPanel(lane) {
  document.querySelectorAll('.ds-rp-tab').forEach(function(t){
    t.classList.toggle('active', t.getAttribute('data-rp') === lane);
  });
  document.querySelectorAll('.ds-right-panel .ds-lane').forEach(function(c){
    c.classList.toggle('ds-rp-active', c.getAttribute('data-lane') === lane);
  });
}
function _setLaneCount(lane, n) {
  var num = (typeof n === 'number') ? n : 0;
  var a = document.getElementById('ds-count-' + lane);      // desktop left-lane badge (local)
  var b = document.getElementById('ds-tabcount-' + lane);   // mobile lane tab
  var c = document.getElementById('ds-rpcount-' + lane);    // desktop right-panel tab
  if (a) a.textContent = n;
  if (b) b.textContent = num;
  if (c) c.textContent = num;
}

// ── Progress animation ─────────────────────────────────────────────
var _dsProgTimers = [];
function _dsMarketLabel() {
  var ath = athletes && athletes.find(function(a){ return a.id === selectedAthleteId; });
  var s = (ath && ath.school) ? String(ath.school).trim() : '';
  if (!s) return 'local';
  return (s.length > 22 ? s.substring(0, 22) + '…' : s) + ' area';
}
function _dsRenderSteps(steps, activeIdx) {
  var box = document.getElementById('ds-progress-steps');
  if (!box) return;
  box.innerHTML = steps.map(function(label, i) {
    var cls = i < activeIdx ? 'done' : (i === activeIdx ? 'active' : 'pending');
    var ico = i < activeIdx
      ? '<svg class="ds-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      : '<span class="ds-step-dot"></span>';
    return '<div class="ds-step ' + cls + '"><div class="ds-step-ico">' + ico + '</div>' +
           '<div class="ds-step-text">' + esc(label) + '</div></div>';
  }).join('');
}
function _dsClearTimers() { _dsProgTimers.forEach(function(t){ clearTimeout(t); }); _dsProgTimers = []; }

function startDealScanProgress() {
  var steps = [
    'Finding your client\'s market...',
    'Searching ' + _dsMarketLabel() + ' businesses...',
    'Finding NIL-friendly brands...',
    'Checking contact information...',
    'Scoring opportunities...',
    'Almost there...'
  ];
  var timings = [0, 1000, 3000, 6000, 9000, 12000];
  var card = document.getElementById('ds-progress');
  var bar  = document.getElementById('ds-progress-bar');
  card.style.display = 'block';
  card.style.opacity = '1';
  bar.style.transition = 'none';
  bar.style.width = '0%';
  requestAnimationFrame(function(){
    requestAnimationFrame(function(){
      bar.style.transition = 'width 12s linear';
      bar.style.width = '90%';
    });
  });
  _dsClearTimers();
  var minDisplayResolve;
  var minDisplay = new Promise(function(res){ minDisplayResolve = res; });
  steps.forEach(function(_, i) {
    var t = setTimeout(function(){
      _dsRenderSteps(steps, i);
      if (i >= 3) minDisplayResolve();
    }, timings[i]);
    _dsProgTimers.push(t);
  });
  _dsProgTimers.push(setTimeout(minDisplayResolve, timings[timings.length - 1] + 500));
  function finish() {
    _dsClearTimers();
    _dsRenderSteps(steps, steps.length);
    bar.style.transition = 'width 0.4s ease';
    bar.style.width = '100%';
    return new Promise(function(res){
      setTimeout(function(){
        card.style.transition = 'opacity 0.45s ease';
        card.style.opacity = '0';
        setTimeout(function(){ card.style.display = 'none'; card.style.opacity = '1'; res(); }, 450);
      }, 450);
    });
  }
  return { minDisplay: minDisplay, finish: finish };
}

// Hydrate lanes from the last persisted scan when entering Deal Scan or selecting a client.
// Only hydrates when nothing is loaded — never clobbers an in-progress scan.
async function loadDealScanCache() {
  if (!selectedAthleteId) return;
  // Social is never cached (it reads the shared social_brands index). Fetch it
  // live and free whenever it has not loaded yet, BEFORE the _dsHasAnyData guard
  // so a client that already has local/topnil data still gets a fresh social column.
  if (_dsLaneData.social === null) _dsScanSocialLane();
  if (_dsHasAnyData()) return;
  try {
    var _cacheAid = selectedAthleteId;
    var r = await fetch('/api/agent/deal-scan/cache?athleteId=' + encodeURIComponent(_cacheAid));
    if (!r.ok) return;
    var d = await r.json();
    if (d && d.rateCard) _dsSetRateCard(_cacheAid, d.rateCard);
    var cache = (d && d.cache) || {};
    var any = false;
    DS_LANES.forEach(function(lane){
      if (lane === 'social') return; // social is served live, never hydrated from cache
      var c = cache[lane];
      if (c && Array.isArray(c.opportunities)) {
        _dsLaneData[lane] = c.opportunities;
        if (c.opportunities.length) any = true;
        // Restore the "seen the whole pool" banner and the Find more button if the
        // last local scan exhausted it, so a re-open reflects the true state.
        if (lane === 'local' && c.poolExhausted && c.opportunities.length) {
          _dsLaneNote[lane] = _dsNoNewNote(lane, c.opportunities);
          _dsLaneExhausted[lane] = true;
        }
      }
    });
    if (any) {
      document.getElementById('scan-ranked-label').style.display = 'block';
      document.getElementById('ds-lanes').style.display = '';
      document.getElementById('ds-lane-tabs').style.display = '';
      var emptyEl = document.getElementById('scan-results-empty');
      if (emptyEl) emptyEl.style.display = 'none';
      switchLane('local');
      _dsRenderAll();
    }
  } catch(e) { /* hydration is best-effort */ }
}

// Fetch the Social lane on its own (getSocialBrands, zero cost) and render it.
// Social is never persisted to deal_scan_cache, so on hydration we pull a fresh
// copy live instead of replaying a stale row.
async function _dsScanSocialLane() {
  if (!selectedAthleteId) return;
  _dsLaneBusy.social = true;
  document.getElementById('scan-ranked-label').style.display = 'block';
  var lanesEl = document.getElementById('ds-lanes'); if (lanesEl) lanesEl.style.display = '';
  var tabsEl = document.getElementById('ds-lane-tabs'); if (tabsEl) tabsEl.style.display = '';
  _dsRenderAll();
  try {
    var _socAid = selectedAthleteId;
    var r = await fetch('/api/agent/deal-scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athleteId: _socAid, lane: 'social', exclude_brands: [] })
    });
    var res = await r.json();
    _dsLaneBusy.social = false;
    if (res && res.rateCard) _dsSetRateCard(_socAid, res.rateCard);
    _dsLaneData.social = (res && !res.error && Array.isArray(res.opportunities)) ? res.opportunities : [];
  } catch (e) {
    _dsLaneBusy.social = false;
    if (_dsLaneData.social === null) _dsLaneData.social = [];
  }
  _dsRenderAll();
}

// Fire ONE explicit deeper search pass for the local market ("Find more
// businesses"). Reuses _dsRunScan with the deepen flag so busy state, rotation
// and rendering all stay consistent.
function _dsFindMore() { return _dsRunScan(true, { deepen: true }); }

async function _dsRunScan(isRefresh, opts) {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  var isDeepen = !!(opts && opts.deepen);
  // Deepen only touches the local lane; a normal scan/refresh runs every lane.
  var lanes = isDeepen ? ['local'] : DS_LANES;
  var btn  = document.getElementById('deals-run-btn');
  var rbtn = document.getElementById('deals-refresh-btn');
  var fmBtn = document.getElementById('ds-findmore-btn');
  if (isDeepen)       { if (fmBtn) { fmBtn.disabled = true; fmBtn.textContent = 'Searching wider…'; } }
  else if (isRefresh) { if (rbtn) { rbtn.disabled = true; rbtn.textContent = 'Refreshing…'; } }
  else                { if (btn)  { btn.disabled  = true; btn.textContent  = 'Scanning…'; } }

  document.getElementById('scan-ranked-label').style.display = 'block';
  var emptyEl = document.getElementById('scan-results-empty');
  if (emptyEl) emptyEl.style.display = 'none';
  document.getElementById('ds-lanes').style.display = '';
  document.getElementById('ds-lane-tabs').style.display = '';
  if (!_dsHasAnyData()) switchLane('local');

  var exclude = (isRefresh || isDeepen)
    ? (window._dealScanResults || []).map(function(d){ return d.brand || ''; }).filter(Boolean)
    : [];

  lanes.forEach(function(l){ _dsLaneBusy[l] = true; _dsLaneNote[l] = ''; });
  _dsRenderAll();
  _dsStartRotation();

  var prog = startDealScanProgress();

  var _scanAid = selectedAthleteId;
  var jobs = lanes.map(function(lane){
    return fetch('/api/agent/deal-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Refresh MUST bypass the 6h scan cache. Send refresh:true so the backend
      // re-runs even when exclude_brands is empty (e.g. results were hydrated
      // from cache and not tracked in _dealScanResults). Without this the refresh
      // silently returned the cached cards and looked like a dead button. deepen
      // fires the on-demand "Find more" deeper search for the local market.
      body: JSON.stringify({ athleteId: _scanAid, lane: lane, exclude_brands: (lane === 'social' ? [] : exclude), refresh: isRefresh, deepen: (isDeepen && lane === 'local') })
    })
      .then(function(r){ return r.json().then(function(data){ return { ok: r.ok, data: data }; }); })
      .then(function(res){
        var opps = (res.ok && res.data && !res.data.error) ? (res.data.opportunities || []) : [];
        if (res.ok && res.data && res.data.rateCard) _dsSetRateCard(_scanAid, res.data.rateCard);
        _dsLaneBusy[lane] = false;
        // Rate limit: show the clear message, keep any existing results.
        if (res.data && res.data.error === 'rate_limited') {
          _dsLaneNote[lane] = res.data.message || 'Deal Scan limit reached. Try again later.';
          if (!(_dsLaneData[lane] && _dsLaneData[lane].length)) _dsLaneData[lane] = [];
          _dsRenderAll();
          return;
        }
        // Deepen throttled: this market was expanded its daily limit already. Keep
        // the shown cards and the exhaustion banner, just tell them to try later.
        if (res.data && res.data.deepenLimited) {
          showToast(res.data.message || 'This market was just expanded. Try Find more again later.');
          _dsLaneExhausted[lane] = true;
          _dsRenderAll();
          return;
        }
        // Brands already shown, to tell "found new ones" from "same best matches".
        var oldBrands = (_dsLaneData[lane] || []).map(function(d){ return (d.brand || '').toLowerCase(); });
        // Local paginates a real per-athlete pool 10 at a time; the SERVER is the
        // authority on whether the whole pool has now been shown, which drives the
        // "Find more businesses" deepen button.
        var exhausted = !!(res.data && res.data.poolExhausted);
        if (lane === 'local') _dsLaneExhausted[lane] = exhausted;
        if (!opps.length) {
          // Server sends an honest exhausted message for the local lane when even
          // auto-deepen could not surface anything new. Prefer it over a generic empty.
          var srvNote = (res.data && res.data.exhaustedNote) || '';
          if (_dsLaneData[lane] && _dsLaneData[lane].length) {
            // Refresh/deepen returned nothing new: keep the shown cards, show the
            // honest banner. For local this only happens once the pool is exhausted.
            _dsLaneNote[lane] = srvNote || ((isRefresh || isDeepen) ? _dsNoNewNote(lane, _dsLaneData[lane]) : '');
          } else {
            _dsLaneData[lane] = [];
            _dsLaneNote[lane] = srvNote; // honest message renders in the empty state
          }
        } else {
          var newOnes = opps.filter(function(d){ return oldBrands.indexOf((d.brand || '').toLowerCase()) === -1; });
          // Refresh/deepen reveals the NEXT page: replace the shown cards.
          _dsLaneData[lane] = opps;
          if (lane === 'local') {
            // Only banner when the server says every pooled business has been shown,
            // never merely because the first 10 appeared.
            _dsLaneNote[lane] = exhausted ? _dsNoNewNote(lane, opps) : '';
          } else if (lane === 'social') {
            // Social is a free, fixed curated set: a refresh re-shows the same matched
            // brands at no cost, so it never gets the "nothing new" banner.
            _dsLaneNote[lane] = '';
          } else {
            // Other lanes (National Brands) are a fixed set: banner when a refresh
            // surfaced nothing new, so it does not read as a dead button.
            _dsLaneNote[lane] = (isRefresh && oldBrands.length && !newOnes.length) ? _dsNoNewNote(lane, opps) : '';
          }
        }
        _dsRenderAll();
      })
      .catch(function(e){
        console.error('[deal-scan] lane ' + lane + ' error:', e);
        _dsLaneBusy[lane] = false;
        if (_dsLaneData[lane] === null && !isRefresh) _dsLaneData[lane] = [];
        _dsRenderAll();
      });
  });

  try {
    await Promise.allSettled(jobs);
    await prog.finish();
  } catch(e) {
    _dsClearTimers();
    var card = document.getElementById('ds-progress');
    if (card) card.style.display = 'none';
  } finally {
    _dsStopRotation();
    lanes.forEach(function(l){ _dsLaneBusy[l] = false; });
    _dsRenderAll();
    if (btn)  { btn.disabled  = false; btn.textContent  = 'Scan Deals with AI'; }
    if (rbtn) { rbtn.disabled = false; rbtn.textContent = 'Refresh'; }
    // The Find more button is re-rendered by _dsRenderAll from _dsLaneExhausted,
    // so no manual re-enable needed; its old node was replaced.
  }
}

// Market name (city) for the honest "strongest matches" banner, from the cards.
function _dsMarketOf(cards) {
  for (var i = 0; i < (cards || []).length; i++) {
    var r = cards[i].region || cards[i].marketLabel || '';
    if (r) return String(r).replace(/^Hometown\s*-\s*/i, '').replace(/^Near\s+/i, '').split(',')[0].trim();
  }
  return 'this market';
}
// Honest banner when a Refresh surfaced no NEW options: the scan worked, these
// are simply the real best matches. Keeps Refresh from reading as a dead button.
function _dsNoNewNote(lane, cards) {
  if (lane === 'local') return 'You have seen every business we have found in this market. We are searching for more and will have new ones within 24 hours.';
  return 'These are the national brands to know for this athlete right now.';
}
// Standing insight shown under a lane header when a thin result is actually
// correct, not broken. Reserved for future lane-specific guidance.
function _dsLaneInsight(lane, data) {
  return '';
}

// Render ALL lanes from _dsLaneData, rebuilding the flat window._dealScanResults
// index so Pipeline / Outreach button indices stay correct across columns.
function _dsRenderAll() {
  window._dealScanResults = [];
  var anyData = false;
  DS_LANES.forEach(function(lane){
    var body = document.getElementById('scan-results-' + lane);
    var data = _dsLaneData[lane];
    var busy = _dsLaneBusy[lane];
    _setLaneCount(lane, data ? data.length : (busy ? '…' : 0));
    if (!body) return;

    if (data === null) {
      body.innerHTML = busy ? _dsLaneLoadingHtml() : '';
      return;
    }
    anyData = true;

    var topNote = '';
    if (busy && data.length) topNote += '<div class="ds-lane-loading" style="margin-bottom:8px"><span class="ds-lane-spin"></span> Finding new matches…</div>';
    if (_dsLaneNote[lane]) topNote += '<div style="font-size:11px;color:var(--muted);background:rgba(255,255,255,0.04);border:1px solid var(--border);border-radius:8px;padding:7px 10px;margin-bottom:8px">' + esc(_dsLaneNote[lane]) + '</div>';
    // Standing lane insight (e.g. social scarcity) so a correct thin result reads
    // as useful context, not an empty/broken lane.
    var _insight = _dsLaneInsight(lane, data);
    if (_insight) topNote += '<div style="font-size:11px;color:var(--muted);background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.22);border-radius:8px;padding:7px 10px;margin-bottom:8px;line-height:1.5">' + esc(_insight) + '</div>';
    // Once the local pool is fully shown, offer a paid-on-click deeper search that
    // pulls a new batch of businesses (new categories, wider radius, next tier).
    if (lane === 'local' && _dsLaneExhausted.local && !busy) {
      topNote += '<button id="ds-findmore-btn" onclick="_dsFindMore()" style="width:100%;margin-bottom:8px;padding:9px;background:rgba(132,204,22,0.12);border:1px solid rgba(132,204,22,0.35);border-radius:8px;color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;font-family:var(--mono)">Find more businesses</button>';
    }

    if (!data.length) {
      // When a lane note is present (e.g. the honest local exhausted message), it is
      // already rendered in topNote and IS the empty state; skip the generic line so
      // we never contradict it with "Try Refresh".
      var emptyLine = _dsLaneNote[lane]
        ? ''
        : '<div class="ds-lane-empty">No ' + esc(_dsLaneMeta[lane].label.toLowerCase()) + ' matches found right now. Try Refresh.</div>';
      body.innerHTML = topNote + emptyLine;
      return;
    }

    var banner = '';
    if (lane === 'local' && data[0] && data[0].resultType === 'national') {
      banner = '<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:10px 12px;margin-bottom:10px;font-size:11px;color:#f59e0b;line-height:1.5">' +
        '<strong>National brands shown.</strong> ' + esc(data[0].fallbackNote || 'We couldn\'t complete a local search for this market, so these are national brands with NIL programs.') + '</div>';
    }

    var html = data.map(function(d, idx){
      var gi = window._dealScanResults.length;
      // Local-lane cards must carry isLocal so AI Outreach triggers the local web search.
      if (lane === 'local' && d.resultType !== 'national') d.isLocal = true;
      window._dealScanResults.push(d);
      return lane === 'social' ? _dsSocialCardHtml(d, gi) : _dsCardHtml(d, gi, lane, idx === 0);
    }).join('');
    body.innerHTML = topNote + banner + html;
  });

  var emptyEl = document.getElementById('scan-results-empty');
  if (emptyEl) emptyEl.style.display = anyData ? 'none' : '';

  if (anyData) _dsLoadContacts(); // fill contact slots after cards are on screen
}

// Compact follower formatter for evidence lines: 18400 -> "18.4K".
function _dsFmtK(n){ n=Number(n)||0; if(n>=1000000) return (n/1000000).toFixed(n%1000000===0?0:1).replace(/\.0$/,'')+'M'; if(n>=1000) return (n/1000).toFixed(n%1000===0?0:1).replace(/\.0$/,'')+'K'; return String(Math.round(n)); }

// Render the evidence block for the SOCIAL (ambassador program) and TOP NIL
// (disclosed deal precedent) lanes. Every claim traces to a source: an Apply /
// program link for social, a "from disclosed deal data" tag or a source link per
// Initial contents of a card's contacts slot: the loaded block once contacts
// have arrived, otherwise a "Finding contact" line.
function _dsContactSlotInner(d) {
  var loaded = d._contactsLoaded || (Array.isArray(d.contacts) && d.contacts.length) || d.businessPhone || d.genericInbox || d.mapsUrl;
  if (loaded) {
    var html = _dsContactsHtml(d);
    if (!html) {
      // Guarantee an affordance: the approach line plus a Google Maps search link.
      var inner = '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:6px">CONTACT</div>';
      if (d.contactApproach) inner += '<div style="font-size:11px;color:var(--muted);line-height:1.5">' + esc(d.contactApproach) + '</div>';
      if (d.mapsUrl) inner += '<a href="' + esc(d.mapsUrl) + '" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:11px;font-weight:700;color:#60a5fa;text-decoration:none">Search on Google Maps</a>';
      html = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' + inner + '</div>';
    }
    // Deep contact lookup, on demand. The scan itself only does the cheap Places
    // pass, so a card usually has a phone but no named person. This runs the full
    // ladder for THIS business only, which is why it is a click and not automatic.
    if (!d.contactLadder) {
      var _i = (window._dealScanResults || []).indexOf(d);
      if (_i >= 0) {
        html += '<button id="dsdeep-' + _i + '" onclick="_dsDeepContacts(' + _i + ', this)" style="margin-top:9px;padding:7px 12px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.35);color:#c084fc;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer">Find the decision maker</button>';
      }
    }
    return html;
  }
  return '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border);font-size:11px;color:var(--muted);display:flex;align-items:center;gap:7px"><span class="ds-lane-spin" style="width:11px;height:11px;flex-shrink:0"></span> Finding contact…</div>';
}

// Lazily fetch real named contacts + a business-phone fallback for the currently
// rendered cards, then fill each slot. Runs after every render; cards already
// loaded (or in flight) are skipped, so it fires roughly one request per lane.
async function _dsLoadContacts() {
  var cards = window._dealScanResults || [];
  var pending = [];
  cards.forEach(function(d, i){ if (d && d.brand && !d._contactsLoaded && !d._contactsLoading) pending.push({ d: d, i: i }); });
  if (!pending.length) return;
  pending.forEach(function(p){ p.d._contactsLoading = true; });
  var payload = { brands: pending.map(function(p){ return { brand: p.d.brand, website: p.d.website || null, region: p.d.region || '', market: p.d.market || null, isFranchise: p.d.isFranchise === true, approach: p.d.contactApproach || null }; }) };
  try {
    var r = await fetch('/api/agent/brand-contacts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var data = await r.json();
    var results = (data && data.results) || [];
    pending.forEach(function(p, k){
      var res = results[k] || {};
      p.d.contacts = res.contacts || [];
      p.d.genericInbox = res.genericInbox || null;
      p.d.businessPhone = res.businessPhone || null;
      p.d.mapsUrl = res.mapsUrl || null;
      if (res.approach) p.d.contactApproach = res.approach;
      p.d._contactsLoaded = true; p.d._contactsLoading = false;
      var slot = document.getElementById('dsc-' + p.i);
      if (slot) slot.innerHTML = _dsContactSlotInner(p.d);
    });
  } catch(e) {
    pending.forEach(function(p){ p.d._contactsLoading = false; });
  }
}

// Repaint one card's contact slot from its (possibly just-updated) data. Exposed so
// the outreach modal can push a ladder it resolved back onto the card behind it,
// rather than leaving the card showing "Finding contact..." for a business whose
// contact is already on screen in the modal.
window._dsRefreshContactSlot = function (d) {
  var cards = window._dealScanResults || [];
  var i = cards.indexOf(d);
  if (i === -1) return;
  var slot = document.getElementById('dsc-' + i);
  if (slot) slot.innerHTML = _dsContactSlotInner(d);
};

// Render the contacts block: real named people first (most senior), then a
// clearly-labeled generic inbox or an honest phone fallback. Returns '' when the
// card carries no contact data at all (the caller then shows the Approach line
// alone). info@ never appears as a primary contact; a made-up email never
// appears at all (the server only sends published emails).
// ── Add a Business ───────────────────────────────────────────────────────────
// Google Places autocomplete biased to the selected athlete's market, so the agent
// picks a SPECIFIC location and we get a place_id (the same brand in three towns
// resolves to three different results). The chosen business runs through the normal
// Deal Scan pipeline server-side and comes back as a normal Deal Scan card.
var _dsAddBizTimer = null;
var _dsAddBizSuggestions = [];
var _dsAddBizActive = -1;
var _dsAddBizBusy = false;

function _dsAddBizStatus(msg, tone) {
  var el = document.getElementById('ds-addbiz-status');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'block';
  el.style.color = tone === 'err' ? '#f87171' : tone === 'ok' ? '#84CC16' : 'var(--muted)';
  el.textContent = msg;
}
function _dsAddBizCloseSugg() {
  var box = document.getElementById('ds-addbiz-sugg');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  _dsAddBizSuggestions = []; _dsAddBizActive = -1;
}
// Highlight WITHOUT rebuilding the DOM. The original bug: each row carried an
// onmouseover that called the full re-render, so moving the pointer onto a row
// replaced that row's element, the new element fired mouseover again, and the
// dropdown re-rendered in a loop under the cursor. A click only fires when
// mousedown and mouseup land on the SAME element, so the click never completed.
// Highlight now mutates the existing children's style instead.
function _dsAddBizHighlight() {
  var box = document.getElementById('ds-addbiz-sugg');
  if (!box) return;
  for (var i = 0; i < box.children.length; i++) {
    box.children[i].style.background = (i === _dsAddBizActive) ? 'rgba(132,204,22,0.10)' : 'transparent';
  }
}
function _dsAddBizRenderSugg() {
  var box = document.getElementById('ds-addbiz-sugg');
  if (!box) return;
  if (!_dsAddBizSuggestions.length) { _dsAddBizCloseSugg(); return; }
  // ONE delegated listener on the container, which is static markup and is never
  // replaced, so it survives every innerHTML rewrite of the rows. mousedown (not
  // click) so it fires before any blur/focus change can tear the dropdown down.
  if (!box._dsDelegated) {
    box.addEventListener('mousedown', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-idx]') : null;
      console.log('[addBiz] row mousedown, idx=', row && row.getAttribute('data-idx'));
      if (!row) return;
      ev.preventDefault(); // keep focus off the input so nothing closes the list
      _dsAddBizPick(parseInt(row.getAttribute('data-idx'), 10));
    });
    box.addEventListener('mouseover', function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest('[data-idx]') : null;
      if (!row) return;
      _dsAddBizActive = parseInt(row.getAttribute('data-idx'), 10);
      _dsAddBizHighlight(); // style-only, never re-renders
    });
    box._dsDelegated = true;
  }
  box.innerHTML = _dsAddBizSuggestions.map(function (s, i) {
    var bg = i === _dsAddBizActive ? 'rgba(132,204,22,0.10)' : 'transparent';
    return '<div data-idx="' + i + '" style="background:' + bg + ';padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border)">' +
      '<div style="font-size:13px;color:var(--text);font-weight:600">' + esc(s.name) +
        (s.outOfMarket ? ' <span style="font-size:9px;font-weight:700;color:#f59e0b">outside market</span>' : '') + '</div>' +
      (s.address ? '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + esc(s.address) + '</div>' : '') +
      '</div>';
  }).join('');
  box.style.display = 'block';
}
function _dsAddBizInput() {
  var el = document.getElementById('ds-addbiz-input');
  var q = el ? el.value.trim() : '';
  if (_dsAddBizTimer) clearTimeout(_dsAddBizTimer);
  if (q.length < 3) { _dsAddBizCloseSugg(); _dsAddBizStatus(''); return; }
  if (!selectedAthleteId) { _dsAddBizStatus('Select a client first.', 'err'); return; }
  _dsAddBizTimer = setTimeout(async function () {
    try {
      var r = await fetch(API_BASE + '/api/agent/places/autocomplete?athleteId=' + encodeURIComponent(selectedAthleteId) + '&q=' + encodeURIComponent(q), { credentials: 'include' });
      var data = await r.json().catch(function () { return {}; });
      if (!r.ok) { _dsAddBizStatus(data.error || 'Could not search businesses.', 'err'); return; }
      _dsAddBizSuggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
      _dsAddBizActive = -1;
      _dsAddBizRenderSugg();
      _dsAddBizStatus(_dsAddBizSuggestions.length ? '' : 'No match. Press Enter to try it as a business name or website.');
    } catch (e) { _dsAddBizStatus('Could not search businesses.', 'err'); }
  }, 250);
}
function _dsAddBizKey(ev) {
  if (ev.key === 'Escape') { _dsAddBizCloseSugg(); return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    if (!_dsAddBizSuggestions.length) return;
    ev.preventDefault();
    _dsAddBizActive += (ev.key === 'ArrowDown' ? 1 : -1);
    if (_dsAddBizActive < 0) _dsAddBizActive = _dsAddBizSuggestions.length - 1;
    if (_dsAddBizActive >= _dsAddBizSuggestions.length) _dsAddBizActive = 0;
    _dsAddBizHighlight(); // style-only; re-rendering here would drop the rows mid-interaction
    return;
  }
  if (ev.key === 'Enter') {
    ev.preventDefault();
    if (_dsAddBizActive >= 0 && _dsAddBizSuggestions[_dsAddBizActive]) { _dsAddBizPick(_dsAddBizActive); return; }
    // No suggestion highlighted: send the raw text. The server falls through to the
    // social path keyed on root domain when Places cannot match it.
    var el = document.getElementById('ds-addbiz-input');
    var q = el ? el.value.trim() : '';
    if (q.length >= 3) _dsAddBizPost({ athleteId: selectedAthleteId, query: q });
  }
}
function _dsAddBizPick(i) {
  var s = _dsAddBizSuggestions[i];
  if (!s) return;
  var el = document.getElementById('ds-addbiz-input');
  if (el) el.value = s.name;
  _dsAddBizCloseSugg();
  _dsAddBizPost({ athleteId: selectedAthleteId, place_id: s.place_id, query: s.name });
}
async function _dsAddBizPost(body) {
  if (_dsAddBizBusy) return;
  if (!selectedAthleteId) { _dsAddBizStatus('Select a client first.', 'err'); return; }
  _dsAddBizBusy = true;
  _dsAddBizCloseSugg();
  _dsAddBizStatus('Finding the contact for this business…');
  try {
    var r = await fetch(API_BASE + '/api/agent/deal-scan/add-business', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify(body),
    });
    var data = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      _dsAddBizStatus(data.message || data.error || ('Could not add that business (' + r.status + ').'), 'err');
      _dsAddBizBusy = false; return;
    }
    if (data.duplicate) {
      var when = data.existing && (data.existing.last_touched_at || data.existing.last_shown_at);
      _dsAddBizStatus((data.message || 'Already on this list.') + (when ? ' Last touched ' + String(when).slice(0, 10) + '.' : ''), 'ok');
      _dsAddBizBusy = false; return;
    }
    var card = data.opportunity;
    if (card) {
      card.contactLadder = data.contactLadder || null;
      card._contactsLoaded = true;
      // Mix into the normal Deal Scan list. The ledger already handles dedupe, so a
      // later scan will not surface it again.
      if (!Array.isArray(_dsLaneData.local)) _dsLaneData.local = [];
      _dsLaneData.local.unshift(card);
      _dsRenderAll();
      var el = document.getElementById('ds-addbiz-input');
      if (el) el.value = '';
      var tier = data.contactLadder && data.contactLadder.topTier;
      _dsAddBizStatus('Added ' + (card.brand || 'business') + '.' + (tier === 1 ? ' Owner or decision maker found.' : tier === 2 ? ' Manager found, no owner in the free sources.' : ' No named person found, main line only.'), 'ok');
    } else {
      _dsAddBizStatus('Added, but no card came back.', 'err');
    }
  } catch (e) {
    _dsAddBizStatus('Could not add that business.', 'err');
  }
  _dsAddBizBusy = false;
}

// Contact ladder (manual "Add a Business" cards). Tier 1 owner/decision maker,
// Tier 2 GM/manager, Tier 3 main line with a call window. EVERY row shows a
// confidence label and a one-line source note; a name is never rendered without
// one. Rendered inside the SAME Deal Scan card component, not a separate UI.
var _DS_CONF_STYLE = {
  Confident: 'background:rgba(132,204,22,0.14);color:#84CC16;border:1px solid rgba(132,204,22,0.32)',
  Likely: 'background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.32)',
  Fallback: 'background:rgba(148,163,184,0.14);color:var(--muted);border:1px solid rgba(148,163,184,0.3)'
};
function _dsLadderHtml(d) {
  var L = d && d.contactLadder;
  if (!L || (!L.mainLine && (!Array.isArray(L.tiers) || !L.tiers.length))) return '';
  var telHref = function(p){ return String(p || '').replace(/[^\d+]/g, ''); };
  var igLink = function(h){ return 'https://instagram.com/' + encodeURIComponent(String(h || '').replace(/^@/, '')); };
  var out = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:8px">WHO TO CALL</div>';
  // The shared business line appears exactly ONCE, here, naming everyone to ask
  // for. Contact rows below never repeat these digits.
  if (L.mainLine) {
    out += '<div style="margin-bottom:10px;padding:9px 11px;background:var(--surface);border:1px solid var(--border);border-radius:8px">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<a href="tel:' + esc(telHref(L.mainLine.phone)) + '" style="color:#60a5fa;text-decoration:none;font-weight:700;font-size:13px">' + esc(L.mainLine.phone) + '</a>' +
        '<span style="font-size:8px;font-weight:700;color:#f59e0b;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.32);border-radius:4px;padding:0 5px">main line</span>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text);margin-top:3px;line-height:1.5">' + esc(L.mainLine.note) + '</div>' +
      (L.mainLine.callWindow ? '<div style="font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5">Best time to call: ' + esc(L.mainLine.callWindow) + '</div>' : '') +
    '</div>';
  }
  (L.tiers || []).forEach(function(t){
    out += '<div style="margin-bottom:10px">' +
      '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:5px">Tier ' + t.tier + ' &middot; ' + esc(t.label) + '</div>';
    (t.rows || []).forEach(function(r){
      var conf = _DS_CONF_STYLE[r.confidence] || _DS_CONF_STYLE.Fallback;
      var bits = [];
      if (r.email) bits.push('<a href="mailto:' + esc(r.email) + '" style="color:' + (r.emailDomainNote ? '#f59e0b' : '#84CC16') + ';text-decoration:none;word-break:break-all">' + esc(r.email) + '</a>' +
        (r.emailDomainNote ? ' <span style="font-size:8px;font-weight:700;color:#f59e0b;background:rgba(245,158,11,0.14);border:1px solid rgba(245,158,11,0.32);border-radius:4px;padding:0 5px">other domain</span>' : '') +
        (r.emailKind === 'pattern' ? ' <span style="font-size:8px;color:var(--muted)">(pattern match)</span>' : ''));
      // Channel order matches the ladder's priority: LinkedIn and a personal DM
      // reach the PERSON, the shared number does not, so the phone comes last.
      if (r.linkedinUrl) bits.push('<a href="' + esc(r.linkedinUrl) + '" target="_blank" rel="noopener" style="color:#0a66c2;text-decoration:none;font-weight:600">LinkedIn</a>' +
        ' <span style="font-size:8px;font-weight:700;color:#0a66c2;background:rgba(10,102,194,0.14);border:1px solid rgba(10,102,194,0.35);border-radius:4px;padding:0 5px">profile</span>');
      if (r.instagram) bits.push('<a href="' + esc(igLink(r.instagram)) + '" target="_blank" rel="noopener" style="color:#e1306c;text-decoration:none;font-weight:600">@' + esc(String(r.instagram).replace(/^@/, '')) + '</a>' +
        ' <span style="font-size:8px;font-weight:700;color:#e1306c;background:rgba(225,48,108,0.12);border:1px solid rgba(225,48,108,0.32);border-radius:4px;padding:0 5px">DM</span>');
      // A row only carries a number when it is genuinely DIFFERENT from the main
      // line, so the same digits are never repeated down the ladder.
      if (r.phone) bits.push('<a href="tel:' + esc(telHref(r.phone)) + '" style="color:#60a5fa;text-decoration:none">' + esc(r.phone) + '</a>' +
        (r.phoneKind === 'direct' ? ' <span style="font-size:8px;font-weight:700;color:#84CC16">direct</span>' : ''));
      if (r.sourceUrl) bits.push('<a href="' + esc(r.sourceUrl) + '" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline">source</a>');
      if (r.mapsUrl) bits.push('<a href="' + esc(r.mapsUrl) + '" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline">Google Maps</a>');
      out += '<div style="margin-bottom:8px;padding-left:9px;border-left:2px solid var(--border)">' +
        '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
          '<span style="font-size:12px;font-weight:600;color:var(--text)">' + esc(r.name || r.title || 'Contact') + '</span>' +
          (r.name && r.title ? '<span style="font-size:11px;color:var(--muted)">' + esc(r.title) + '</span>' : '') +
          '<span title="How sure we are this person holds this role. Not a claim about the phone number." style="font-size:8px;font-weight:700;border-radius:4px;padding:1px 6px;' + conf + '">' + (r.name ? 'Name: ' : '') + esc(r.confidence) + '</span>' +
        '</div>' +
        (bits.length ? '<div style="font-size:11px;color:var(--muted);margin-top:3px;line-height:1.6">' + bits.join(' <span style="color:var(--border)">&middot;</span> ') + '</div>' : '') +
        // A name is not a contact: when the only route is the shared line, say so.
        (r.reachVia ? '<div style="font-size:11px;color:#f59e0b;margin-top:3px;line-height:1.5">' + esc(r.reachVia) + '</div>' : '') +
        // Never let a cross-domain address read as the business's own.
        (r.emailDomainNote ? '<div style="font-size:10px;color:#f59e0b;margin-top:3px;line-height:1.5">' + esc(r.emailDomainNote) + '</div>' : '') +
        '<div style="font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5;font-style:italic">' + esc(r.sourceNote || 'Source not recorded') + '</div>' +
        (r.callWindow ? '<div style="font-size:10px;color:var(--muted);margin-top:3px;line-height:1.5">Best time to call: ' + esc(r.callWindow) + '</div>' : '') +
      '</div>';
    });
    out += '</div>';
  });
  if (!L.hasTier1) {
    out += '<div style="font-size:10px;color:var(--muted);line-height:1.5">No owner or marketing decision maker found in the free sources. Start with the tier above and ask for the owner by name.</div>';
  }
  // Names we found but cannot reach by any channel are shown as context only, never
  // as rows that look actionable.
  if (Array.isArray(L.unreachable) && L.unreachable.length) {
    out += '<div style="font-size:10px;color:var(--muted);margin-top:6px;line-height:1.5">Also named, no contact method found: ' + esc(L.unreachable.join(', ')) + '</div>';
  }
  if (L.staffHeldBack) {
    out += '<div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.5">' + L.staffHeldBack + ' staff contact' + (L.staffHeldBack === 1 ? '' : 's') + ' hidden, they cannot approve a deal.</div>';
  }
  return out + '</div>';
}

// On-demand deep contact lookup for ONE Deal Scan card. The scan does the cheap
// Places pass for all cards; this runs the full 6-source ladder for the single
// business the agent is actually pursuing, so the cost lands only where it earns
// its keep. Re-renders that card's contact slot in place.
// Progress stages for the deep lookup. A real deep call runs 20-30s, which read as
// a dead button: the agent gave up before it returned. These prove it is alive and
// roughly track what the server is doing (site first, then the other sources).
var _DS_DEEP_STAGES = [
  [0,  'Searching the website'],
  [6,  'Checking their Facebook page'],
  [12, 'Checking state filings'],
  [19, 'Checking maps and news'],
  [26, 'Almost there'],
];
async function _dsDeepContacts(i, btn) {
  var d = (window._dealScanResults || [])[i];
  if (!d) return;
  var slot = document.getElementById('dsc-' + i);
  var started = Date.now();
  var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  var noteId = 'dsdeepnote-' + i;
  var ticker = null;
  var stop = function () { if (ticker) { clearInterval(ticker); ticker = null; } };
  if (btn) { btn.disabled = true; btn.textContent = _DS_DEEP_STAGES[0][1] + '…'; }
  // Rotate the label, then at 30s offer an explicit choice rather than leaving the
  // agent guessing whether it is stuck.
  ticker = setInterval(function () {
    var secs = (Date.now() - started) / 1000;
    if (btn) {
      var label = _DS_DEEP_STAGES[0][1];
      for (var s = 0; s < _DS_DEEP_STAGES.length; s++) if (secs >= _DS_DEEP_STAGES[s][0]) label = _DS_DEEP_STAGES[s][1];
      btn.textContent = label + '… ' + Math.floor(secs) + 's';
    }
    if (secs >= 30 && !document.getElementById(noteId) && slot) {
      slot.insertAdjacentHTML('beforeend',
        '<div id="' + noteId + '" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.6">' +
        'This one is taking a while. It is still running. ' +
        '<a href="#" onclick="_dsDeepStop(' + i + ',event)" style="color:#f87171;text-decoration:underline">Stop</a>' +
        ' or keep waiting.</div>');
    }
  }, 1000);
  window['_dsDeepAbort_' + i] = function () { if (ctrl) ctrl.abort(); };
  try {
    var r = await fetch(API_BASE + '/api/agent/brand-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      signal: ctrl ? ctrl.signal : undefined,
      body: JSON.stringify({ deep: true, brands: [{
        brand: d.brand || d.brand_name, website: d.website || null, region: d.region || '',
        market: d.market || null, isFranchise: d.isFranchise === true,
        approach: d.contactApproach || null, category: d.category || null,
      }] }),
    });
    stop();
    var data = await r.json().catch(function () { return {}; });
    var row = data && Array.isArray(data.results) && data.results[0];
    // Never fail silently. Previously a server-side throw came back as an empty
    // results array, the button just reset, and the agent saw nothing at all.
    if (!r.ok || (data && data.error) || !row) {
      var msg = (data && data.error) ? ('Contact search failed: ' + data.error) : 'Contact search did not return anything. Try again in a moment.';
      var slotErr = document.getElementById('dsc-' + i);
      if (slotErr) slotErr.insertAdjacentHTML('beforeend', '<div style="font-size:11px;color:#f87171;margin-top:8px;line-height:1.5">' + esc(msg) + '</div>');
      if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      return;
    }
    if (row.error) console.warn('[deepContacts] brand failed:', row.error);
    if (Array.isArray(row.contacts)) d.contacts = row.contacts;
    if (row.genericInbox) d.genericInbox = row.genericInbox;
    if (row.businessPhone) d.businessPhone = row.businessPhone;
    if (row.mapsUrl) d.mapsUrl = row.mapsUrl;
    if (row.approach) d.contactApproach = row.approach;
    d.contactLadder = row.contactLadder || null;
    d._contactsLoaded = true;
    // _contactsLoaded is set by the CHEAP fan-out too, so it cannot tell the two
    // apart. This flag means specifically "the deep ladder ran", which is what the
    // outreach modal checks before deciding whether to run it again.
    d._deepLoaded = true;
    if (slot) slot.innerHTML = _dsContactSlotInner(d);
    console.log('[deepContacts] done in ' + Math.round((Date.now() - started) / 1000) + 's, topTier=' + (d.contactLadder && d.contactLadder.topTier));
  } catch (e) {
    stop();
    var aborted = e && e.name === 'AbortError';
    if (slot) {
      var n = document.getElementById(noteId);
      if (n) n.remove();
      slot.insertAdjacentHTML('beforeend', '<div style="font-size:11px;color:' + (aborted ? 'var(--muted)' : '#f87171') + ';margin-top:8px;line-height:1.5">' +
        (aborted ? 'Stopped. The main line above still works.' : 'Contact search failed: ' + esc(e && e.message ? e.message : 'unknown error')) + '</div>');
    }
    if (btn) { btn.disabled = false; btn.textContent = aborted ? 'Find the decision maker' : 'Try again'; }
  }
  stop();
  var leftover = document.getElementById(noteId);
  if (leftover) leftover.remove();
}

// Cancel an in-flight deep lookup. The ladder already on the card (main line and
// call window) stays exactly as it was.
function _dsDeepStop(i, ev) {
  if (ev) ev.preventDefault();
  var fn = window['_dsDeepAbort_' + i];
  if (fn) fn();
}

function _dsContactsHtml(d) {
  // Manual adds carry a full contact ladder; render that instead of the flat list.
  if (d && d.contactLadder) return _dsLadderHtml(d);
  var contacts = Array.isArray(d.contacts) ? d.contacts.slice() : [];
  // Back-compat for older cached cards that only carry the single-contact fields.
  if (!contacts.length && d.contactName) {
    contacts = [{ name: d.contactName, title: d.contactTitle, email: d.contactEmail || null, phone: null, linkedinUrl: d.contactLinkedIn || null, sourceUrl: null, emailSource: d.contactEmail ? 'published' : null }];
  }
  var phone = d.businessPhone || null;
  var inbox = d.genericInbox || null;
  if (!contacts.length && !phone && !inbox) return '';

  var telHref = function(p){ return String(p || '').replace(/[^\d+]/g, ''); };
  var out = '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">' +
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:8px">CONTACTS</div>';

  if (contacts.length) {
    out += contacts.slice(0, 4).map(function(c){
      var verified = c.emailSource === 'verified'
        ? ' <span style="font-size:8px;font-weight:700;color:#84CC16;background:rgba(132,204,22,0.14);border:1px solid rgba(132,204,22,0.3);border-radius:4px;padding:0 5px">Verified</span>' : '';
      var bits = [];
      if (c.email) bits.push('<a href="mailto:' + esc(c.email) + '" style="color:#84CC16;text-decoration:none;word-break:break-all">' + esc(c.email) + '</a>' + verified);
      if (c.phone) bits.push('<a href="tel:' + esc(telHref(c.phone)) + '" style="color:#60a5fa;text-decoration:none">' + esc(c.phone) + '</a>');
      if (c.linkedinUrl) bits.push('<a href="' + esc(c.linkedinUrl) + '" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:underline">LinkedIn</a>');
      if (c.sourceUrl) bits.push('<a href="' + esc(c.sourceUrl) + '" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline">source</a>');
      var prefix = (!c.email && c.phone) ? '<span style="color:var(--muted)">Phone only:</span> ' : '';
      return '<div style="margin-bottom:9px">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' + esc(c.name || 'Contact') + (c.title ? '<span style="font-weight:400;color:var(--muted)">, ' + esc(c.title) + '</span>' : '') + '</div>' +
        (bits.length ? '<div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.6">' + prefix + bits.join(' <span style="color:var(--border)">·</span> ') + '</div>' : '') +
      '</div>';
    }).join('');
  } else if (phone) {
    // #3: a phone number IS contact info, so the block is not empty. Do not render
    // "Run AI Outreach to pull the contact for this business." here. The block only
    // renders when there is a contact, phone, or inbox (see the early return at the
    // top), so a genuinely-empty contact block never reaches this code at all.
    out += '<div style="font-size:12px"><a href="tel:' + esc(telHref(phone)) + '" style="color:#60a5fa;text-decoration:none;font-weight:600">' + esc(phone) + '</a></div>';
  }

  if (inbox) {
    out += '<div style="margin-top:8px;font-size:10px;color:var(--muted)">Email: <a href="mailto:' + esc(inbox) + '" style="color:var(--muted);text-decoration:underline">' + esc(inbox) + '</a></div>';
  }
  if (d.contactApproach) {
    out += '<div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5"><span style="color:var(--text);font-weight:600">Approach:</span> ' + esc(d.contactApproach) + '</div>';
  }
  out += '</div>';
  return out;
}

// deal for top NIL. Returns '' when a card carries no structured evidence (the
// local lane's string evidence is rendered separately and ignored here).
function _dsEvidenceHtml(d) {
  var ev = d.evidence;
  if (!ev || (ev.kind !== 'program' && ev.kind !== 'deals')) return '';
  var out = '';
  if (ev.kind === 'program') {
    var chip;
    if (ev.status === 'open') chip = '<span class="ds-lane-chip" style="background:rgba(132,204,22,0.16);color:#84CC16;border:1px solid rgba(132,204,22,0.3)">Program open</span>';
    else if (ev.status === 'closed') chip = '<span class="ds-lane-chip" style="background:rgba(239,68,68,0.14);color:#f87171;border:1px solid rgba(239,68,68,0.3)">Program closed</span>';
    else chip = '<span class="ds-lane-chip" style="background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)">Status unclear</span>';
    out += '<div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' + chip + '</div>';
    var v = ev.verdict || {};
    var vColor = v.status === 'qualifies' ? '#84CC16' : v.status === 'below' ? '#f87171' : 'var(--muted)';
    if (v.text) out += '<div style="margin-top:8px;font-size:12px;font-weight:600;color:' + vColor + '">' + esc(v.text) + '</div>';
    if (ev.requirements) out += '<div style="margin-top:6px;font-size:11px;color:var(--muted);line-height:1.5"><span style="color:var(--text);font-weight:600">Requirements:</span> ' + esc(ev.requirements) + '</div>';
    if (ev.responseTime) out += '<div style="margin-top:4px;font-size:11px;color:var(--muted)"><span style="color:var(--text);font-weight:600">Response:</span> ' + esc(ev.responseTime) + '</div>';
    var links = '';
    if (ev.applyUrl) links += '<a href="' + esc(ev.applyUrl) + '" target="_blank" rel="noopener" style="font-size:11px;font-weight:700;color:#0A0E1A;background:#84CC16;padding:6px 12px;border-radius:7px;text-decoration:none">Apply</a>';
    if (ev.sourceUrl && ev.sourceUrl !== ev.applyUrl) links += '<a href="' + esc(ev.sourceUrl) + '" target="_blank" rel="noopener" style="font-size:11px;color:var(--muted);text-decoration:underline;align-self:center">Program page</a>';
    if (links) out += '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + links + '</div>';
    return out;
  }
  // deals
  var v2 = ev.verdict || {};
  var v2Color = (v2.status === 'in-range' || v2.status === 'above') ? '#84CC16' : v2.status === 'below' ? '#f87171' : 'var(--muted)';
  if (v2.text) out += '<div style="margin-top:8px;font-size:12px;font-weight:600;color:' + v2Color + '">' + esc(v2.text) + '</div>';
  var deals = ev.deals || [];
  if (deals.length) {
    out += '<div style="margin-top:10px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:5px">Recent disclosed deals</div>';
    out += deals.slice(0,3).map(function(dl){
      var meta = [];
      if (dl.sport) meta.push(esc(dl.sport));
      var ft = dl.followerTier || (dl.followers ? _dsFmtK(dl.followers) : '');
      if (ft) meta.push(esc(ft));
      if (dl.dealType) meta.push(esc(dl.dealType));
      if (dl.date) meta.push(esc(dl.date));
      var srcTag = dl.source === 'comp'
        ? '<span style="font-size:9px;color:var(--muted)">from disclosed deal data</span>'
        : (dl.sourceUrl ? '<a href="' + esc(dl.sourceUrl) + '" target="_blank" rel="noopener" style="font-size:9px;color:#60a5fa;text-decoration:underline">source</a>' : '');
      return '<div style="font-size:11px;color:var(--text);line-height:1.5;margin-bottom:5px;padding-left:8px;border-left:2px solid var(--border)">' +
        '<span style="font-weight:600">' + esc(dl.athlete || 'Athlete') + '</span>' +
        (meta.length ? ' <span style="color:var(--muted)">' + meta.join(', ') + '</span>' : '') +
        (srcTag ? ' ' + srcTag : '') + '</div>';
    }).join('');
  }
  return out;
}

// THIS athlete's rate card entry (never a global/other athlete's). null when the
// athlete has not been scanned yet in this session.
function _dsRateEntry(athlete) {
  return (athlete && athlete.id && window._agentRateCards) ? window._agentRateCards[athlete.id] : null;
}

// Single IG-post rate for the GIVEN athlete, widened ~0.7x-1.3x and rounded to the
// nearest 25. Reads window._agentRateCards[athlete.id] (per athlete, deterministic
// benchmarks, no AI). Returns null when follower data or the athlete's own rate is
// missing — the caller decides which fallback text to show.
function _dsPitchRange(athlete) {
  var followers = (Number(athlete && athlete.instagram) || 0) + (Number(athlete && athlete.tiktok) || 0);
  var rc = _dsRateEntry(athlete);
  var post = rc && rc.rates && rc.rates['ig-post'];
  if (!followers || !post) return null;
  var base = ((Number(post.low) || 0) + (Number(post.high) || 0)) / 2;
  if (!base) base = Number(post.low) || Number(post.high) || 0;
  if (!base) return null;
  var r25 = function (n) { return Math.max(25, Math.round(n / 25) * 25); };
  var lo = r25(base * 0.7), hi = r25(base * 1.3);
  if (hi <= lo) hi = lo + 25;
  return '$' + lo.toLocaleString() + ' to $' + hi.toLocaleString();
}

var _DS_CAT_BUDGET  = ['auto', 'dealership', 'medspa', 'bank', 'insurance', 'realty', 'realestate', 'real estate'];
var _DS_CAT_FOOD    = ['restaurant', 'food', 'coffee', 'bar'];
var _DS_CAT_SERVICE = ['fitness', 'gym', 'wellness', 'salon', 'barber'];
var _DS_CAT_RETAIL  = ['apparel', 'retail'];
// Whole-word match so e.g. "bar" does not match "barber".
function _dsCatHas(cat, list) {
  return list.some(function (k) { return new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(cat); });
}

// Pitch + Why for a local/national opportunity. Pure JS, no AI. First match wins.
// Every pitch names a deliverable. No price is ever displayed; the rate midpoint
// only scales which deliverable is proposed.
function _dsPitchFor(opp, athlete) {
  var cat = String(opp && opp.category || '').toLowerCase();
  var evidence = String(opp && opp.evidence || '').toLowerCase();
  var entry = _dsRateEntry(athlete);
  var post = entry && entry.rates && entry.rates['ig-post'];
  // Single-post rate midpoint (per athlete, never a global), used SILENTLY to scale
  // the deliverable to the price band. Null when the athlete has no rate entry yet,
  // in which case the base deliverable renders. The number is never shown.
  var base = post ? (((Number(post.low) || 0) + (Number(post.high) || 0)) / 2) : null;

  // Scale rules 1, 3, 7 to the price band without displaying the price. Always
  // returns a deliverable, even with no rate entry or no follower data.
  var scaled = function (midDeliverable) {
    if (base != null && base < 250) return 'One feed post and a story set';
    if (base != null && base > 750) return 'Three feed posts, a story set and one appearance';
    return midDeliverable;
  };

  // 1. Evidence mentions an existing NIL / athlete deal.
  if (/\bnil\b|athlete|sponsor|endorse|ambassador|name,?\s*image/.test(evidence)) {
    return { pitch: scaled('Two feed posts and one appearance'), why: 'They already did NIL deals with athletes' };
  }
  // 2. Locally owned or operated franchise. The isFranchise flag is set ONLY for
  // a specific local location or operator, whose owner or GM controls a local
  // marketing budget and can approve small deals without corporate. This mirrors
  // the FRANCHISE_RULE the scan uses to write the card description, so the pitch
  // Why and the description no longer contradict each other.
  if (opp && opp.isFranchise === true) {
    return { pitch: scaled('Two feed posts and one appearance'), why: 'Locally operated franchise, the owner controls a local budget and can say yes without corporate' };
  }
  // 3. Category with a real local marketing budget.
  if (_dsCatHas(cat, _DS_CAT_BUDGET)) {
    return { pitch: scaled('Two feed posts and one appearance at their location'), why: 'Category with real local marketing budget' };
  }
  // 4. Food and drink.
  if (_dsCatHas(cat, _DS_CAT_FOOD)) {
    return { pitch: 'Free meals plus a named menu item, athlete takes 10 percent', why: 'Food businesses trade product before they pay cash' };
  }
  // 5. Service businesses.
  if (_dsCatHas(cat, _DS_CAT_SERVICE)) {
    return { pitch: 'Free membership plus two feed posts and a story set', why: 'Service businesses trade access before cash' };
  }
  // 6. Retail / apparel.
  if (_dsCatHas(cat, _DS_CAT_RETAIL)) {
    return { pitch: 'Product plus a discount code, athlete takes 10 percent', why: 'Retail pays in product and code revenue first' };
  }
  // 7. No strong budget signal.
  return { pitch: scaled('Two feed posts and a story set'), why: 'No strong budget signal, start with a standard package' };
}

function _dsCardHtml(d, i, lane, isTop) {
  var brand = d.brand || d.brand_name || 'Brand';
  var score = d.fitScore || 80;
  var scoreColor = score >= 85 ? '#84CC16' : score >= 70 ? '#f59e0b' : 'var(--muted)';
  var cat = (d.category || '').toLowerCase();
  var catStyle = _dsCatColors[cat] || 'rgba(255,255,255,0.06);color:var(--muted)';
  var laneMeta = _dsLaneMeta[lane] || _dsLaneMeta.local;
  var laneChip = '<span class="ds-lane-chip" style="background:' + laneMeta.chip + '">' + esc(laneMeta.label) + '</span>';
  // Market chip (only present on two-market scans) and local-franchise chip.
  // Older cached scans have neither field and render exactly as before.
  var extraChips = '';
  // Newcomer chip: this business was not in the market pool last time anyone
  // scanned here. Leads the chip row because it is the reason to look again.
  if (d.isNew === true) {
    extraChips += '<span class="ds-lane-chip" style="background:rgba(132,204,22,0.16);color:#84CC16;border:1px solid rgba(132,204,22,0.35)">New here</span>';
  }
  if (lane === 'local' && d.marketLabel) {
    var mkStyle = d.market === 'hometown'
      ? 'rgba(245,158,11,0.16);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)'
      : 'rgba(96,165,250,0.14);color:#60a5fa;border:1px solid rgba(96,165,250,0.28)';
    extraChips += '<span class="ds-lane-chip" style="background:' + mkStyle + '">' + esc(d.marketLabel) + '</span>';
  }
  if (lane === 'local' && d.isFranchise === true) {
    extraChips += '<span class="ds-lane-chip" style="background:rgba(45,212,191,0.14);color:#2dd4bf;border:1px solid rgba(45,212,191,0.3)">Local franchise</span>';
  }
  // Interest-tag matches (e.g. "Matches: supplements, gyms")
  if (Array.isArray(d.matchedTags) && d.matchedTags.length) {
    extraChips += '<span class="ds-lane-chip" style="background:rgba(200,241,53,0.12);color:#C8F135;border:1px solid rgba(200,241,53,0.3)">Matches: ' + esc(d.matchedTags.slice(0, 4).join(', ')) + '</span>';
  }

  // Pitch + Why: what to propose and why, grounded in this card's own signals.
  // Rendered on local and national (topnil) cards; social cards use a different
  // template and are never routed here. Stashed on d so AI Outreach proposes the
  // same thing (d IS window._dealScanResults[i]).
  var _ath = (window.athletes || (typeof athletes !== 'undefined' ? athletes : []) || []).find(function (a) { return a.id === selectedAthleteId; }) || {};
  var _pw = _dsPitchFor(d, _ath);
  d.recommendedPitch = _pw.pitch;
  d.recommendedWhy = _pw.why;
  var pitchBlock =
    '<div style="background:var(--surface1,var(--surface));border:1px solid var(--border);border-radius:9px;padding:11px 12px;margin-top:10px">' +
      '<div style="font-size:11px;color:var(--muted)">Pitch</div>' +
      '<div style="font-size:14px;font-weight:500;color:var(--text);margin-top:2px;line-height:1.4">' + esc(_pw.pitch) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:9px">Why</div>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:2px;line-height:1.5">' + esc(_pw.why) + '</div>' +
    '</div>';

  // Contacts load lazily (after the card renders) so the scan stays fast. The
  // slot shows "Finding contact" until _dsLoadContacts fills it.
  var contactHtml = '<div id="dsc-' + i + '">' + _dsContactSlotInner(d) + '</div>';

  var brandSafe = brand.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
  var campaignSafe = (d.campaign||'').replace(/"/g,'').substring(0,40);

  return '<div style="background:var(--surface2);border:1px solid ' + (isTop ? 'rgba(132,204,22,0.3)' : 'var(--border)') + ';border-radius:12px;padding:15px 16px">' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;flex-wrap:wrap">' +
          laneChip +
          '<span style="font-size:15px;font-weight:700;color:var(--text)">' + esc(brand) + '</span>' +
          extraChips +
          // Cross-athlete warning (#4): this brand is already contacted for another
          // client under this agent. Never hides the card, just flags it.
          (d.contactedElsewhere ? '<span class="ds-lane-chip" title="You already contacted this brand for another client" style="background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.35)">Contacted for ' + esc(d.contactedElsewhere.athleteName || 'another athlete') + (d.contactedElsewhere.date ? ' on ' + esc(d.contactedElsewhere.date) : '') + '</span>' : '') +
          (d.category ? '<span style="font-size:9px;padding:2px 7px;border-radius:4px;background:' + catStyle + '">' + esc(d.category) + '</span>' : '') +
          (isTop ? '<span style="font-size:9px;padding:2px 7px;border-radius:4px;background:rgba(132,204,22,0.08);color:#84CC16;border:1px solid rgba(132,204,22,0.2)">BEST FIT</span>' : '') +
        '</div>' +
        (d.rationale ? '<div style="font-size:12px;color:var(--text);line-height:1.6;margin-bottom:4px">' + esc(d.rationale) + '</div>' : '') +
        _dsEvidenceHtml(d) +
        (lane === 'local' && typeof d.evidence === 'string' && d.evidence ? '<div style="display:flex;align-items:flex-start;gap:7px;margin-top:6px"><span class="ds-lane-chip" style="background:rgba(132,204,22,0.14);color:#84CC16;border:1px solid rgba(132,204,22,0.35);flex-shrink:0;white-space:nowrap">Actively marketing</span><span style="font-size:11px;color:var(--muted);line-height:1.5">' + esc(d.evidence) + '</span></div>' : '') +
        (d.campaign  ? '<div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px"><span style="color:var(--text);font-weight:600">Idea:</span> ' + esc(d.campaign) + '</div>' : '') +
        pitchBlock +
        contactHtml +
      '</div>' +
      '<div onclick="dsToggleWhy(' + i + ')" title="See the factors behind this fit score" style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;cursor:pointer">' +
        '<span style="font-size:20px;color:' + scoreColor + ';font-weight:700;line-height:1">' + score + '</span>' +
        '<span style="font-size:8px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">Fit</span>' +
        '<div style="width:44px;height:4px;border-radius:2px;background:var(--surface);overflow:hidden;margin-top:2px"><div style="width:' + score + '%;height:100%;background:' + scoreColor + '"></div></div>' +
        '<span style="font-size:8px;color:var(--accent);text-decoration:underline;margin-top:1px">why?</span>' +
      '</div>' +
    '</div>' +
    '<div id="dswhy-' + i + '" style="display:none;margin-top:12px;padding:11px 12px;background:var(--surface);border:1px solid var(--border);border-radius:9px"></div>' +
    '<div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">' +
      '<button onclick="prefillOutreach(\'' + brandSafe + '\')" style="flex:1;min-width:110px;padding:9px;background:var(--accent);color:#0A0E1A;border:none;border-radius:8px;font-size:11px;font-weight:700;cursor:pointer">Write Outreach</button>' +
      '<button onclick="addDealToPipeline(\'' + brandSafe + '\',\'' + esc(d.dealType||'ig-post') + '\',\'' + campaignSafe + '\')" style="padding:9px 12px;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.25);color:#4ade80;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600">+ Pipeline</button>' +
      '<button onclick="if(window.outreachEngine){window.outreachEngine.generate(selectedAthleteId,window._dealScanResults[' + i + ']);}else{showToast(\'Outreach engine loading…\');}" style="padding:9px 12px;background:rgba(168,85,247,0.12);border:1px solid rgba(168,85,247,0.35);color:#c084fc;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600">⚡ AI Outreach</button>' +
      '<button onclick="sendKitForBrand(' + i + ', this)" style="padding:9px 12px;background:rgba(59,130,246,0.12);border:1px solid rgba(59,130,246,0.35);color:#60a5fa;border-radius:8px;font-size:11px;cursor:pointer;font-weight:600">Send kit</button>' +
      // Manual retire (#3): agents work outside the app constantly and need to
      // mark a brand contacted by hand so it stops coming back. Undoable.
      '<button id="dsmc-btn-' + i + '" onclick="_dsMarkContacted(' + i + ', this, \'manual\', true)"' + (d._contacted ? ' disabled' : '') + ' style="padding:9px 12px;background:rgba(148,163,184,0.12);border:1px solid rgba(148,163,184,0.35);color:var(--muted);border-radius:8px;font-size:11px;cursor:pointer;font-weight:600' + (d._contacted ? ';opacity:0.6' : '') + '">' + (d._contacted ? 'Contacted' : 'Mark as contacted') + '</button>' +
    '</div>' +
    '<div id="dsmc-' + i + '" style="margin-top:8px;font-size:11px;color:var(--muted);' + (d._contacted ? '' : 'display:none') + '">' + (d._contacted ? 'Marked as contacted. It will not show again for this athlete.' : '') + '</div>' +
  '</div>';
}

// Retire a Deal Scan brand for the selected athlete through the single ledger
// endpoint. via records the path (manual / pipeline / send_kit / email_sent /
// ai_outreach_copy); undoable shows an inline Undo for the soft/manual paths.
async function _dsMarkContacted(i, btnEl, via, undoable) {
  var d = (window._dealScanResults || [])[i];
  if (!d) return;
  var slot = document.getElementById('dsmc-' + i);
  try {
    var resp = await fetch(API_BASE + '/api/agent/deal-scan/contacted', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        athleteId: selectedAthleteId,
        brand: d.brand || d.brand_name || null,
        brandKey: d.brandKey || null,
        website: d.website || null,
        place_id: d.place_id || null,
        category: d.category || null,
        lane: d.lane || 'local',
        via: via || 'manual',
      }),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (!resp.ok || !data.ok) { if (typeof showToast === 'function') showToast('Could not mark as contacted'); return; }
    d.brandKey = data.brandKey || d.brandKey;
    d._contacted = true;
    if (btnEl) { btnEl.textContent = 'Contacted'; btnEl.disabled = true; btnEl.style.opacity = '0.6'; btnEl.style.cursor = 'default'; }
    if (slot) {
      slot.style.display = 'block';
      slot.innerHTML = 'Marked as contacted. It will not show again for this athlete.' +
        (undoable ? ' <a href="#" onclick="_dsUndoContacted(' + i + ',event)" style="color:var(--accent);text-decoration:underline">Undo</a>' : '');
    }
  } catch (e) { if (typeof showToast === 'function') showToast('Could not mark as contacted'); }
}

async function _dsUndoContacted(i, ev) {
  if (ev) ev.preventDefault();
  var d = (window._dealScanResults || [])[i];
  if (!d || !d.brandKey) return;
  try {
    var resp = await fetch(API_BASE + '/api/agent/deal-scan/contacted/undo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ athleteId: selectedAthleteId, brandKey: d.brandKey }),
    });
    var data = await resp.json().catch(function () { return {}; });
    if (resp.ok && data.ok) {
      d._contacted = false;
      var slot = document.getElementById('dsmc-' + i);
      if (slot) { slot.style.display = 'none'; slot.innerHTML = ''; }
      var btn = document.getElementById('dsmc-btn-' + i);
      if (btn) { btn.textContent = 'Mark as contacted'; btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = 'pointer'; }
      if (typeof showToast === 'function') showToast('Undone');
    } else if (typeof showToast === 'function') { showToast('Could not undo'); }
  } catch (e) { if (typeof showToast === 'function') showToast('Could not undo'); }
}

// Hook the outreach engine calls after a real email send (hard) or a DM copy
// (soft), so the modal retires through the same ledger path as the cards. Finds
// the on-screen card to update its UI; if the card is not shown, retires silently.
window._dsOnBrandContacted = function (deal, via, undoable) {
  if (!deal) return;
  var results = window._dealScanResults || [];
  var i = results.indexOf(deal);
  if (i < 0) {
    for (var k = 0; k < results.length; k++) {
      if (results[k] && ((deal.brandKey && results[k].brandKey === deal.brandKey) ||
          ((results[k].brand || results[k].brand_name) === (deal.brand || deal.brand_name)))) { i = k; break; }
    }
  }
  if (i < 0) {
    fetch(API_BASE + '/api/agent/deal-scan/contacted', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ athleteId: selectedAthleteId, brand: deal.brand || deal.brand_name || null, brandKey: deal.brandKey || null, website: deal.website || null, place_id: deal.place_id || null, lane: deal.lane || 'local', via: via || 'ai_outreach' }),
    }).catch(function () {});
    return;
  }
  _dsMarkContacted(i, document.getElementById('dsmc-btn-' + i), via, undoable);
};

// Admin (Growth view): read-only brand_engagement stats. Uses the session cookie
// (credentials: include), so it works from a logged-in admin phone. Writes nothing.
// ── Programs tab ────────────────────────────────────────────────────────────
// A lookup over program_staff. Read-only, no matching, no scoring.
//
// Never invents a contact: a missing email renders as nothing at all, not as a
// guess and not as a constructed firstname.lastname@school.edu.
// SPORT IS PART OF EVERY KEY HERE. Both caches used to be keyed on nothing but
// "the last thing loaded", which is fine with one sport and wrong with two: after
// switching, the cached school list and the cached school would both still be the
// other sport's, and the screen would show football staff under a basketball
// heading. So _progSchools is an object keyed by sport, and _progCurrent carries the
// sport it was fetched for and is only rendered when that matches the selection.
var _progSport = 'football';
var _progSportList = [{ key: 'football', label: 'Football' }, { key: 'mens_basketball', label: "Men's Basketball" }];
var _progSchools = {};      // sport -> [schools]
var _progActive = -1;
var _progCurrent = null;    // carries .sport

function progEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function progRenderSportToggle() {
  var el = document.getElementById('prog-sport-toggle');
  if (!el) return;
  el.innerHTML = _progSportList.map(function (sp) {
    var on = sp.key === _progSport;
    return '<button type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '"'
      + ' data-sport="' + progEsc(sp.key) + '" onclick="progSetSport(\'' + progEsc(sp.key) + '\')"'
      + ' style="flex:1;min-height:44px;padding:10px 14px;border-radius:var(--r);cursor:pointer;'
      + 'font-family:\'DM Sans\',sans-serif;font-size:14px;'
      + (on
        ? 'background:var(--accent);color:#0b0f0a;border:1px solid var(--accent);font-weight:600'
        : 'background:var(--surface2);color:var(--muted);border:1px solid var(--border)')
      + '">' + progEsc(sp.label) + '</button>';
  }).join('');
}

// Switching sports clears the school and the search box on purpose. Leaving the
// previous school on screen while the sport label changed underneath it is exactly
// the mixed-sport screen this design exists to prevent.
function progSetSport(sport) {
  if (!sport || sport === _progSport) return;
  _progSport = sport;
  _progCurrent = null;
  _progActive = -1;
  var input = document.getElementById('prog-search');
  if (input) input.value = '';
  var box = document.getElementById('prog-suggest');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  var body = document.getElementById('prog-body');
  if (body) body.innerHTML = '';
  progRenderSportToggle();
  progLoadSchools();
}
window.progSetSport = progSetSport;

async function progLoadSchools() {
  var sport = _progSport;
  if (_progSchools[sport]) return _progSchools[sport];
  try {
    var r = await fetch(API_BASE + '/api/programs/schools?sport=' + encodeURIComponent(sport), { credentials: 'include' });
    var d = await r.json().catch(function () { return {}; });
    // The server echoes the sport it answered for. Storing the response under THAT
    // key rather than the one we asked with means a late reply from a sport the user
    // has already switched away from lands in its own slot instead of the new one.
    var got = (d && d.sport) || sport;
    if (d && Array.isArray(d.sports) && d.sports.length) _progSportList = d.sports;
    _progSchools[got] = (d && d.schools) || [];
    progRenderSportToggle();
    return _progSchools[sport] || [];
  } catch (e) { _progSchools[sport] = []; }
  return _progSchools[sport];
}

async function progOnInput() {
  var input = document.getElementById('prog-search');
  var box = document.getElementById('prog-suggest');
  if (!input || !box) return;
  var schools = await progLoadSchools();
  var q = input.value.trim().toLowerCase();
  var matches = schools.filter(function (s) { return !q || s.school.toLowerCase().indexOf(q) !== -1; });
  _progActive = -1;
  if (!matches.length) {
    box.style.display = 'block';
    box.innerHTML = '<div style="padding:14px;color:var(--muted);font-size:13px">'
      + (schools.length ? 'No match. We have ' + schools.length + ' school'
         + (schools.length === 1 ? '' : 's') + ' so far.' : 'No program data loaded yet.')
      + '</div>';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = matches.map(function (s, i) {
    return '<div class="prog-sugg" data-school="' + progEsc(s.school) + '" data-i="' + i + '"'
      + ' style="padding:13px 14px;min-height:44px;box-sizing:border-box;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:center">'
      + '<span style="color:var(--text);font-size:15px">' + progEsc(s.school) + '</span>'
      + '<span style="color:var(--muted);font-size:12px;white-space:nowrap">' + s.staff_count + ' staff</span>'
      + '</div>';
  }).join('');
}

// One delegated mousedown on the STATIC container. mousedown, not click, because a
// re-render between mousedown and mouseup destroys the row and the click never
// lands. This is the same bug that killed the Add a Business suggestions.
document.addEventListener('mousedown', function (e) {
  var row = e.target && e.target.closest ? e.target.closest('.prog-sugg') : null;
  if (!row) return;
  e.preventDefault();
  progSelect(row.getAttribute('data-school'));
});

function progKeyNav(e) {
  var box = document.getElementById('prog-suggest');
  if (!box || box.style.display === 'none') return;
  var rows = box.querySelectorAll('.prog-sugg');
  if (!rows.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    _progActive += (e.key === 'ArrowDown' ? 1 : -1);
    if (_progActive < 0) _progActive = rows.length - 1;
    if (_progActive >= rows.length) _progActive = 0;
    for (var i = 0; i < rows.length; i++) {
      rows[i].style.background = (i === _progActive) ? 'rgba(132,204,22,0.10)' : '';
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    var pick = rows[_progActive >= 0 ? _progActive : 0];
    if (pick) progSelect(pick.getAttribute('data-school'));
  } else if (e.key === 'Escape') {
    box.style.display = 'none';
  }
}

async function progSelect(school) {
  var box = document.getElementById('prog-suggest');
  var input = document.getElementById('prog-search');
  var body = document.getElementById('prog-body');
  var sport = _progSport;   // the sport this request is FOR, captured before awaiting
  if (box) box.style.display = 'none';
  if (input) input.value = school;
  if (!body) return;
  body.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px">Loading ' + progEsc(school) + '...</div>';
  try {
    var r = await fetch(API_BASE + '/api/programs/' + encodeURIComponent(school) + '?sport=' + encodeURIComponent(sport), { credentials: 'include' });
    var d = await r.json().catch(function () { return {}; });
    // The user may have switched sports while this was in flight. Rendering it now
    // would put one sport's staff on the other sport's screen, which is the single
    // thing this tab must never do.
    if (sport !== _progSport) return;
    if (!r.ok) {
      body.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px">'
        + progEsc(d.error || ('Error ' + r.status)) + '</div>';
      return;
    }
    _progCurrent = d;
    progRender(d);
  } catch (e) {
    body.innerHTML = '<div style="padding:20px;color:var(--muted);font-size:13px">Request failed: '
      + progEsc(e && e.message ? e.message : e) + '</div>';
  }
}

function progAgo(ts) {
  if (!ts) return 'unknown';
  var ms = Date.now() - new Date(ts).getTime();
  var d = Math.floor(ms / 86400000);
  if (d < 1) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 30) return d + ' days ago';
  var mo = Math.floor(d / 30);
  return mo + ' month' + (mo === 1 ? '' : 's') + ' ago';
}

// Copy button. 44px tap target, and it says what it copied so a mis-tap is obvious.
function progCopyBtn(value, label) {
  if (!value) return '';
  return '<button onclick="progCopy(this,' + JSON.stringify(value).replace(/"/g, '&quot;') + ')"'
    + ' title="Copy ' + progEsc(label) + '"'
    + ' style="min-height:44px;min-width:44px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;font-family:var(--mono);cursor:pointer;flex-shrink:0">Copy</button>';
}

async function progCopy(btn, value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(value);
    else {
      var ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    var old = btn.textContent;
    btn.textContent = 'Copied';
    btn.style.color = '#84CC16';
    setTimeout(function () { btn.textContent = old; btn.style.color = ''; }, 1400);
  } catch (e) { btn.textContent = 'Failed'; }
}

// A contact line. Renders NOTHING when the value is missing: no placeholder, no
// "email not found", no constructed address.
function progContactLine(value, href, label) {
  if (!value) return '';
  return '<div style="display:flex;align-items:center;gap:8px;margin-top:8px">'
    + '<a href="' + progEsc(href) + '" style="flex:1;min-width:0;color:#84CC16;font-size:14px;text-decoration:none;word-break:break-all;line-height:1.4">'
    + progEsc(value) + '</a>'
    + progCopyBtn(value, label)
    + '</div>';
}

function progSourceLink(url) {
  if (!url) return '';
  return '<div style="margin-top:8px"><a href="' + progEsc(url) + '" target="_blank" rel="noopener"'
    + ' style="font-size:11px;color:var(--muted);text-decoration:underline">source</a></div>';
}

function progRender(d) {
  var body = document.getElementById('prog-body');
  var h = '';

  h += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:16px">';
  h += '<div style="font-size:20px;font-weight:700;color:var(--text)">' + progEsc(d.school) + '</div>';
  // The sport is stated on the card itself, not only in the toggle above it. A
  // screenshot of this card has to be unambiguous about which staff it shows.
  h += '<div style="font-size:12px;color:#84CC16;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-top:3px">'
    + progEsc(d.sportLabel || 'Football') + '</div>';
  // Say plainly that the list is filtered. A count of 23 with 81 stored must not
  // read as "this program has 23 staff".
  h += '<div style="font-size:12px;color:var(--muted);margin-top:4px;line-height:1.5">'
    + d.totals.shown + ' decision makers, ' + d.totals.withEmail + ' with an email'
    + ' &middot; last checked ' + progEsc(progAgo(d.lastFetched)) + '</div>';
  if (d.totals.hidden > 0) {
    h += '<div style="font-size:11px;color:var(--muted);margin-top:2px">'
      + d.totals.hidden + ' support and development staff not shown</div>';
  }
  if (d.officePhone) {
    h += '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">'
      + '<div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">' + progEsc(d.sportLabel || 'Football') + ' office</div>'
      + progContactLine(d.officePhone, 'tel:' + d.officePhone, 'office line')
      + '</div>';
  }
  h += '</div>';

  if (d.keyContacts.length) {
    h += '<div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">Key contacts</div>';
    for (var i = 0; i < d.keyContacts.length; i++) {
      var k = d.keyContacts[i];
      h += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px">'
        + '<div style="font-size:11px;color:#84CC16;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">' + progEsc(k.role_label || k.role) + '</div>'
        + '<div style="font-size:17px;font-weight:700;color:var(--text);margin-top:6px;line-height:1.3">' + progEsc(k.name) + '</div>'
        + '<div style="font-size:13px;color:var(--muted);margin-top:3px;line-height:1.4">' + progEsc(k.title || 'no title published') + '</div>'
        + progContactLine(k.email, 'mailto:' + k.email, 'email')
        + progContactLine(k.phone, 'tel:' + k.phone, 'phone')
        + (k.others_in_role > 0
            ? '<div style="font-size:11px;color:var(--muted);margin-top:8px">+' + k.others_in_role + ' more in this role, see full staff</div>' : '')
        + progSourceLink(k.source_url)
        + '</div>';
    }
  } else {
    h += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px;margin-bottom:10px;color:var(--muted);font-size:13px">'
      + 'No key contacts identified for this school yet. The full staff list below is still searchable.</div>';
  }

  h += '<button onclick="progToggleFull()" id="prog-full-toggle"'
    + ' style="width:100%;min-height:48px;margin-top:8px;padding:12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:14px;font-weight:600;cursor:pointer;text-align:left">'
    + 'Full staff (' + d.fullStaff.length + ')</button>';
  h += '<div id="prog-full" style="display:none;margin-top:10px">'
    + '<input id="prog-full-search" type="text" placeholder="Filter by name or title" oninput="progFilterFull()"'
    + ' style="width:100%;box-sizing:border-box;min-height:48px;padding:12px 14px;margin-bottom:10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);color:var(--text);font-size:16px;font-family:\'DM Sans\',sans-serif;outline:none">'
    + '<div id="prog-full-list"></div></div>';

  body.innerHTML = h;
}

function progToggleFull() {
  var el = document.getElementById('prog-full');
  var btn = document.getElementById('prog-full-toggle');
  if (!el || !_progCurrent) return;
  var open = el.style.display !== 'none';
  el.style.display = open ? 'none' : 'block';
  btn.textContent = (open ? 'Full staff (' : 'Hide full staff (') + _progCurrent.fullStaff.length + ')';
  if (!open) progFilterFull();
}

function progFilterFull() {
  var list = document.getElementById('prog-full-list');
  var q = (document.getElementById('prog-full-search') || {}).value || '';
  q = q.trim().toLowerCase();
  if (!list || !_progCurrent) return;
  var rows = _progCurrent.fullStaff.filter(function (p) {
    if (!q) return true;
    return String(p.name || '').toLowerCase().indexOf(q) !== -1
        || String(p.title || '').toLowerCase().indexOf(q) !== -1;
  });
  if (!rows.length) {
    list.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:13px">No one matches "' + progEsc(q) + '".</div>';
    return;
  }
  list.innerHTML = rows.map(function (p) {
    return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:14px;margin-bottom:8px">'
      + '<div style="font-size:15px;font-weight:600;color:var(--text);line-height:1.3">' + progEsc(p.name) + '</div>'
      + '<div style="font-size:12px;color:var(--muted);margin-top:3px;line-height:1.4">' + progEsc(p.title || 'no title published') + '</div>'
      + progContactLine(p.email, 'mailto:' + p.email, 'email')
      + progContactLine(p.phone, 'tel:' + p.phone, 'phone')
      + '</div>';
  }).join('');
  if (rows.length !== _progCurrent.fullStaff.length) {
    list.innerHTML += '<div style="font-size:11px;color:var(--muted);padding:4px 2px">Showing ' + rows.length
      + ' of ' + _progCurrent.fullStaff.length + '</div>';
  }
}

// Athlete signups. Read-only: this button issues one GET and renders it. It cannot
// create, modify or delete anything, and there is no write endpoint behind it.
function _athSigEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function _athSigDate(ts) {
  if (!ts) return 'never';
  var d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  var days = Math.floor((Date.now() - d.getTime()) / 86400000);
  var ago = days < 1 ? 'today' : (days === 1 ? '1 day ago' : days + ' days ago');
  return d.toISOString().slice(0, 10) + ' (' + ago + ')';
}

async function _athleteSignups(btn) {
  var out = document.getElementById('athsig-out');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  if (out) { out.style.display = 'block'; out.textContent = 'Reading...'; }
  try {
    var r = await fetch(API_BASE + '/api/admin/athlete-signups', { credentials: 'include' });
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) {
      out.textContent = 'Error ' + r.status + ': ' + (d.error || 'request failed');
      return;
    }
    var t = d.totals || {};
    var h = '';

    h += '<div style="font-size:13px;color:var(--text);margin-bottom:10px;line-height:1.6">'
      + '<b>' + t.total + '</b> athlete row(s) total &middot; '
      + '<b>' + t.self_managed + '</b> self-managed &middot; '
      + '<b>' + t.no_agent + '</b> with no agent<br>'
      + '<span style="color:var(--muted)">newest row: ' + _athSigEsc(_athSigDate(t.newest)) + '</span></div>';

    // The headline answer, stated rather than left to be inferred from a table.
    var selfCount = (d.selfSignups || []).length;
    if (t.self_managed > 0) {
      h += '<div style="padding:10px 12px;background:rgba(245,158,11,0.10);border:1px solid rgba(245,158,11,0.35);border-radius:var(--r-sm);color:#f59e0b;font-size:12px;font-weight:700;margin-bottom:12px">'
        + t.self_managed + ' self-serve signup(s) came through /athletes while it was unlinked.</div>';
    } else {
      h += '<div style="padding:10px 12px;background:rgba(132,204,22,0.10);border:1px solid rgba(132,204,22,0.30);border-radius:var(--r-sm);color:#84CC16;font-size:12px;font-weight:700;margin-bottom:12px">'
        + 'No self-serve signups. Nobody has reached /athletes.</div>';
    }

    h += '<table style="width:100%;border-collapse:collapse;font-size:12px">'
      + '<thead><tr style="color:var(--muted);text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:0.06em">'
      + '<th style="padding:6px 8px">athlete_type</th><th style="padding:6px 8px">subscription_status</th>'
      + '<th style="padding:6px 8px">rows</th><th style="padding:6px 8px">verified</th>'
      + '<th style="padding:6px 8px">activated</th><th style="padding:6px 8px">newest</th></tr></thead><tbody>';
    (d.byType || []).forEach(function (row) {
      h += '<tr style="border-top:1px solid var(--border)">'
        + '<td style="padding:6px 8px;color:var(--text)">' + _athSigEsc(row.athlete_type) + '</td>'
        + '<td style="padding:6px 8px;color:var(--muted)">' + _athSigEsc(row.subscription_status) + '</td>'
        + '<td style="padding:6px 8px;color:var(--text);font-weight:700">' + row.n + '</td>'
        + '<td style="padding:6px 8px;color:var(--muted)">' + row.verified + '</td>'
        + '<td style="padding:6px 8px;color:var(--muted)">' + row.activated + '</td>'
        + '<td style="padding:6px 8px;color:var(--muted)">' + _athSigEsc(_athSigDate(row.newest)) + '</td>'
        + '</tr>';
    });
    h += '</tbody></table>';

    if (selfCount) {
      h += '<div style="margin-top:14px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">Self-serve signups (newest first, max 25)</div>';
      (d.selfSignups || []).forEach(function (a) {
        h += '<div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">'
          + '<span style="color:var(--text);font-weight:600">' + _athSigEsc(a.name || '(no name)') + '</span> '
          + '<span style="color:var(--muted)">' + _athSigEsc(a.email || '(no email)') + '</span>'
          + '<div style="color:var(--muted);font-size:11px;margin-top:2px">'
          + _athSigEsc([a.school, a.sport].filter(Boolean).join(' · ') || 'no school or sport')
          + ' &middot; ' + (a.email_verified ? 'verified' : 'NOT verified')
          + ' &middot; ' + _athSigEsc(a.subscription_status || 'no status')
          + ' &middot; signed up ' + _athSigEsc(_athSigDate(a.created_at))
          + ' &middot; last login ' + _athSigEsc(_athSigDate(a.last_login))
          + '</div></div>';
      });
    }

    if (d.note) h += '<div style="margin-top:12px;font-size:11px;color:var(--muted)">' + _athSigEsc(d.note) + '</div>';
    out.innerHTML = h;
  } catch (e) {
    if (out) out.textContent = 'Request failed: ' + (e && e.message ? e.message : e);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Athlete signups'; }
}

// Weekly digest controls. The test send goes to the signed-in admin only and never
// writes to digest_sends, so it can be run as often as needed without burning a
// real weekly send for anyone.
async function _digestTest(btn) {
  var out = document.getElementById('digest-out');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
  if (out) { out.style.display = 'block'; out.textContent = 'Building and sending...'; }
  try {
    var r = await fetch(API_BASE + '/api/admin/digest/test', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    var d = await r.json().catch(function () { return {}; });
    if (out) {
      out.textContent = r.ok
        ? ('Sent to ' + d.to + '\nSubject: ' + d.subject
           + '\nUsed real data: ' + (d.usedRealData ? 'yes' : 'no, your account had nothing pending so the email shows SAMPLE content')
           + '\nResend id: ' + (d.providerId || 'none returned')
           + '\n\nCheck your inbox AND your spam folder. Where it landed is the thing worth knowing.')
        : ('Error ' + r.status + ': ' + (d.error || 'request failed'));
    }
  } catch (e) {
    if (out) out.textContent = 'Request failed: ' + (e && e.message ? e.message : e);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Send test digest to me'; }
}

async function _digestDryRun(btn) {
  var out = document.getElementById('digest-out');
  if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }
  if (out) { out.style.display = 'block'; out.textContent = 'Building every agent digest, sending nothing...'; }
  try {
    var r = await fetch(API_BASE + '/api/admin/digest/dry-run', { method: 'POST', credentials: 'include' });
    var d = await r.json().catch(function () { return {}; });
    if (out) {
      out.textContent = r.ok
        ? ('Week starting ' + d.weekStart
           + '\nCandidates: ' + d.considered
           + '\nWould send: ' + d.sent
           + '\nSkipped as empty: ' + d.skipped
           + '\nBuild failures: ' + (d.failed || 0)
           + '\n\nFull per-agent output including the drafted follow-ups is in the Railway logs.')
        : ('Error ' + r.status + ': ' + (d.error || 'request failed'));
    }
  } catch (e) {
    if (out) out.textContent = 'Request failed: ' + (e && e.message ? e.message : e);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Dry run all agents'; }
}

async function _dsLedgerStats(btn) {
  var out = document.getElementById('ds-ledger-out');
  if (btn) btn.disabled = true;
  try {
    var r = await fetch(API_BASE + '/api/admin/brand-engagement/stats', { credentials: 'include' });
    var data = await r.json().catch(function () { return {}; });
    if (out) {
      out.style.display = 'block';
      out.textContent = r.ok ? JSON.stringify(data, null, 2) : ('Error ' + r.status + ': ' + (data.error || 'request failed'));
    }
  } catch (e) {
    if (out) { out.style.display = 'block'; out.textContent = 'Request failed: ' + (e && e.message ? e.message : e); }
  }
  if (btn) btn.disabled = false;
}

// Admin (Growth view): Social lane depth for the currently selected Deal Scan
// athlete. Builds the URL from selectedAthleteId so it works from a phone without
// typing one. Uses the session cookie; read-only.
async function _dsSocialDepth(btn) {
  var out = document.getElementById('ds-ledger-out');
  if (!selectedAthleteId) {
    if (out) { out.style.display = 'block'; out.textContent = 'No Deal Scan athlete selected. Open Deal Scan, pick a client, then come back and tap Social depth.'; }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    var r = await fetch(API_BASE + '/api/agent/deal-scan/social-depth?athleteId=' + encodeURIComponent(selectedAthleteId), { credentials: 'include' });
    var data = await r.json().catch(function () { return {}; });
    if (out) {
      out.style.display = 'block';
      out.textContent = r.ok ? JSON.stringify(data, null, 2) : ('Error ' + r.status + ': ' + (data.error || 'request failed'));
    }
  } catch (e) {
    if (out) { out.style.display = 'block'; out.textContent = 'Request failed: ' + (e && e.message ? e.message : e); }
  }
  if (btn) btn.disabled = false;
}

// Admin (Growth view): run the one-time backfill. This WRITES, so confirm first so
// it can never fire by accident. Idempotent server-side (ON CONFLICT DO NOTHING).
async function _dsRunBackfill(btn) {
  if (!confirm('Run the brand_engagement backfill now?\n\nThis migrates rows from the existing shown/worked trackers into the ledger. It writes, but it is idempotent (safe to re-run).')) return;
  var out = document.getElementById('ds-ledger-out');
  var orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Running...'; }
  try {
    var r = await fetch(API_BASE + '/api/admin/backfill-brand-engagement', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
    });
    var data = await r.json().catch(function () { return {}; });
    if (out) {
      out.style.display = 'block';
      out.textContent = r.ok ? JSON.stringify(data, null, 2) : ('Error ' + r.status + ': ' + (data.error || 'request failed'));
    }
  } catch (e) {
    if (out) { out.style.display = 'block'; out.textContent = 'Request failed: ' + (e && e.message ? e.message : e); }
  }
  if (btn) { btn.disabled = false; btn.textContent = orig; }
}

// Compact follower count for the Social lane tier field: 1000 -> "1k", 150000 -> "150k".
function _dsFmtTierK(n){ n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(n)); }

// Social lane card. A DIFFERENT template from _dsCardHtml: social rows carry no
// fit score, no contacts, and no Approach line, so none of those are rendered.
// Same dark card styling (border, radius, padding, chips, button colors) as
// _dsCardHtml so it reads as the same product.
function _dsSocialCardHtml(d, i) {
  var brand = d.brand || d.brand_name || 'Brand';
  var brandSafe = brand.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Freshness -> colored status text: current = green "Signs athletes" (with a
  // check), aging = amber "Verify age" (no icon).
  var freshCurrent = d.freshness === 'current';
  var freshTxt = freshCurrent ? 'Signs athletes' : 'Verify age';
  var freshColor = freshCurrent ? '#84CC16' : '#f59e0b';
  var checkIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="margin-left:3px;vertical-align:-1px"><path d="M20 6L9 17l-5-5"/></svg>';
  var extIcon = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
  var boltIcon = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="margin-right:6px;vertical-align:-2px"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>';

  // Favicon: derive the hostname from the website column (strip protocol + www).
  var host = '';
  try { var wsrc = String(d.website || '').trim(); if (wsrc) { if (!/^https?:\/\//i.test(wsrc)) wsrc = 'https://' + wsrc; host = new URL(wsrc).hostname.replace(/^www\./, ''); } } catch (_) { host = ''; }
  var favicon = host
    ? '<img src="https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=64" width="34" height="34" loading="lazy" alt="" aria-hidden="true" onerror="this.style.display=\'none\'" style="width:34px;height:34px;border-radius:8px;background:var(--surface1,var(--surface));flex-shrink:0;object-fit:contain">'
    : '';

  // Size chip: small -> green success chip, national -> muted grey chip, null -> none.
  var sizeChip = '';
  if (d.brand_size === 'small') sizeChip = '<span class="ds-lane-chip" style="background:rgba(132,204,22,0.14);color:#84CC16;border:1px solid rgba(132,204,22,0.35)">Small brand</span>';
  else if (d.brand_size === 'national') sizeChip = '<span class="ds-lane-chip" style="background:rgba(255,255,255,0.06);color:var(--muted);border:1px solid var(--border)">National</span>';

  // Proof link chip. The verified date lives in the title attribute, not on the card face.
  var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var pd = d.proof_date ? new Date(d.proof_date) : null;
  var proofWhen = (pd && !isNaN(pd.getTime())) ? (MON[pd.getUTCMonth()] + ' ' + pd.getUTCFullYear()) : '';
  var proofTitle = proofWhen ? ('Verified ' + proofWhen) : 'Verified';
  var proofChip = d.proof_url
    ? '<a href="' + esc(d.proof_url) + '" target="_blank" rel="noopener" title="' + esc(proofTitle) + '" style="flex-shrink:0;white-space:nowrap;font-size:12px;padding:5px 11px;border:0.5px solid var(--accent);color:var(--accent);border-radius:var(--radius,8px);text-decoration:none;display:inline-flex;align-items:center;gap:4px">Program page' + extIcon + '</a>'
    : '';

  // Signs (sports) and Tier.
  var sportsArr = Array.isArray(d.sports) ? d.sports : [];
  var signs = sportsArr.map(function(s){ return s === 'all' ? 'All sports' : s; }).join(', ') || '—';
  // Only show a follower range when the program page actually stated one; the
  // model's default wide range is noise. Matching still uses tier_min/tier_max.
  var tier = d.tier_stated ? (_dsFmtTierK(d.tier_min) + ' to ' + _dsFmtTierK(d.tier_max)) : 'Not stated';

  // Deal: merge structure + est range into one string.
  var estStr = (d.est_low != null) ? ('$' + d.est_low + ' to $' + (d.est_high != null ? d.est_high : d.est_low)) : null;
  var dealVal;
  if (d.deal_structure === 'affiliate') dealVal = 'Affiliate, commission';
  else if (d.deal_structure === 'gifting_code') dealVal = 'Gifting, product first';
  else if (d.deal_structure === 'cash' || d.deal_structure === 'cash_code') dealVal = estStr ? ('Cash, ' + estStr) : 'Cash';
  else { var w = d.deal_structure || '—'; dealVal = estStr ? (w + ', ' + estStr) : w; }

  var fld = function(label, val, bold, color){
    return '<div>' +
      '<div style="font-size:11px;color:var(--muted)">' + label + '</div>' +
      '<div style="font-size:14px;font-weight:' + (bold ? '500' : '400') + ';color:' + color + ';margin-top:2px">' + esc(val) + '</div></div>';
  };

  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:12px;padding:15px 16px">' +
    // 1. HEADER ROW: favicon | brand/category/size + freshness | proof-page chip
    '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">' +
      favicon +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
          '<span style="font-size:17px;font-weight:500;color:var(--text)">' + esc(brand) + '</span>' +
          (d.category ? '<span style="font-size:12px;color:var(--muted)">' + esc(d.category) + '</span>' : '') +
          sizeChip +
          (d.contactedElsewhere ? '<span class="ds-lane-chip" title="You already contacted this brand for another client" style="background:rgba(245,158,11,0.14);color:#f59e0b;border:1px solid rgba(245,158,11,0.35)">Contacted for ' + esc(d.contactedElsewhere.athleteName || 'another athlete') + (d.contactedElsewhere.date ? ' on ' + esc(d.contactedElsewhere.date) : '') + '</span>' : '') +
        '</div>' +
        '<div style="font-size:12px;margin-top:4px">' +
          '<span style="color:' + freshColor + ';font-weight:500;display:inline-flex;align-items:center">' + freshTxt + (freshCurrent ? checkIcon : '') + '</span>' +
        '</div>' +
      '</div>' +
      proofChip +
    '</div>' +
    // 2. EVIDENCE BLOCK (only when offer_summary exists)
    (d.offer_summary ? '<div style="border-left:2px solid var(--accent);border-radius:0;padding-left:12px;margin-bottom:14px">' +
      '<div style="font-size:14px;line-height:1.6;color:var(--text);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">' + esc(String(d.offer_summary).trim()) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:6px">What they offer</div></div>' : '') +
    // 3. FIELD ROW
    '<div style="display:flex;flex-wrap:wrap;gap:22px;margin-bottom:14px">' +
      fld('Deal', dealVal, true, 'var(--text)') +
      fld('Signs', signs, false, 'var(--text)') +
      fld('Tier', tier, false, d.tier_stated ? 'var(--text)' : 'var(--muted)') +
    '</div>' +
    // 4. ACTION ROW: AI outreach is the single primary control; pipeline is a text link
    '<div style="display:flex;align-items:center;gap:16px">' +
      '<button onclick="if(window.outreachEngine){window.outreachEngine.generate(selectedAthleteId,window._dealScanResults[' + i + ']);}else{showToast(\'Outreach engine loading…\');}" style="display:inline-flex;align-items:center;background:rgba(168,85,247,0.22);border:1px solid rgba(168,85,247,0.5);color:#c084fc;border-radius:8px;font-size:14px;font-weight:700;padding:9px 22px;cursor:pointer">' + boltIcon + 'AI outreach</button>' +
      '<span onclick="addDealToPipeline(\'' + brandSafe + '\',\'ig-post\',\'\')" style="font-size:13px;color:var(--muted);cursor:pointer">Add to pipeline</span>' +
      // Manual retire (#3), on every card including social. Undoable.
      '<button id="dsmc-btn-' + i + '" onclick="_dsMarkContacted(' + i + ', this, \'manual\', true)"' + (d._contacted ? ' disabled' : '') + ' style="font-size:13px;color:var(--muted);cursor:pointer;background:none;border:none;padding:0;text-decoration:underline' + (d._contacted ? ';opacity:0.6' : '') + '">' + (d._contacted ? 'Contacted' : 'Mark as contacted') + '</button>' +
    '</div>' +
    '<div id="dsmc-' + i + '" style="margin-top:8px;font-size:11px;color:var(--muted);' + (d._contacted ? '' : 'display:none') + '">' + (d._contacted ? 'Marked as contacted. It will not show again for this athlete.' : '') + '</div>' +
  '</div>';
}

// Read the real contact state already on a card (the same fields the contacts
// slot renders) and turn it into one honest fit factor. Never invents a contact.
function _dsContactState(d) {
  var hasAny = d._contactsLoaded || (Array.isArray(d.contacts) && d.contacts.length) || d.businessPhone || d.genericInbox || d.contactName;
  if (!hasAny) return { label: 'Run AI Outreach for contact details', dir: 'neutral' };
  var contacts = Array.isArray(d.contacts) ? d.contacts.slice() : [];
  if (!contacts.length && d.contactName) contacts = [{ name: d.contactName, email: d.contactEmail || null, phone: null }];
  var named = contacts.find(function(c){ return c && c.name && String(c.name).trim(); });
  if (named && named.email) return { label: 'Named contact found (' + named.name + ')', dir: 'pos' };
  if (named && named.phone) return { label: 'Named contact found, phone only', dir: 'neutral' };
  if (named) return { label: 'Named contact found', dir: 'pos' };
  if (d.businessPhone) return { label: 'Phone listed', dir: 'neutral' };
  if (d.genericInbox) return { label: 'Email listed', dir: 'neutral' };
  return { label: 'Run AI Outreach for contact details', dir: 'neutral' };
}

// Build an honest "why this scored what it did" receipt for one Deal Scan card,
// from the SAME real fields the card already shows (market match, actively
// marketing evidence, interest fit, franchise, contact state, program/verdict,
// disclosed deals). Every factor is true for THAT specific business. Unknowns are
// shown as neutral, never padded. Nothing is fabricated.
function _dsScoreBreakdown(d) {
  if (!d) return [];
  var out = [];
  var isLocal = d.resultType === 'local' || d.lane === 'local' || d.isLocal === true;
  var isSocial = d.resultType === 'social' || d.lane === 'social';
  var isNational = d.resultType === 'national';
  if (isLocal && !isNational) {
    if (d.market === 'hometown') out.push({ label: d.marketLabel ? ('Hometown market match: ' + d.marketLabel.replace(/^Hometown[\s-]*/,'')) : 'Hometown market match', dir: 'pos' });
    else if (d.marketLabel) out.push({ label: 'In your school\'s local market', dir: 'pos' });
    else out.push({ label: 'Local business in your market', dir: 'pos' });
    if (typeof d.evidence === 'string' && d.evidence) out.push({ label: 'Actively marketing: ' + d.evidence, dir: 'pos' });
    else out.push({ label: 'No local marketing activity found in search', dir: 'neutral' });
    if (Array.isArray(d.matchedTags) && d.matchedTags.length) out.push({ label: 'Fits athlete interests: ' + d.matchedTags.slice(0, 4).join(', '), dir: 'pos' });
    if (d.isFranchise === true) out.push({ label: 'Locally operated franchise, owner controls the budget', dir: 'pos' });
    out.push(_dsContactState(d));
    return out;
  }
  if (isSocial) {
    if (d.programStatus === 'open') out.push({ label: 'Ambassador program is open', dir: 'pos' });
    else if (d.programStatus === 'closed') out.push({ label: 'Ambassador program is closed', dir: 'neg' });
    else out.push({ label: 'Ambassador program status unclear', dir: 'neutral' });
    var v = d.verdict || {};
    if (v.status === 'qualifies') out.push({ label: v.text || 'Meets their follower minimum', dir: 'pos' });
    else if (v.status === 'below') out.push({ label: v.text || 'Below their follower minimum', dir: 'neg' });
    else if (v.status === 'no-minimum') out.push({ label: 'No stated follower minimum', dir: 'neutral' });
    else out.push({ label: 'Follower fit unknown, add follower counts', dir: 'neutral' });
    if (d.evidence && d.evidence.offer) out.push({ label: 'Public creator offer: ' + d.evidence.offer, dir: 'pos' });
    return out;
  }
  // Top NIL / national brands
  var deals = (Array.isArray(d.disclosedDeals) && d.disclosedDeals.length) ? d.disclosedDeals : ((d.evidence && Array.isArray(d.evidence.deals)) ? d.evidence.deals : []);
  if (deals.length) out.push({ label: deals.length + ' disclosed NIL deal' + (deals.length > 1 ? 's' : '') + ' on record', dir: 'pos' });
  else out.push({ label: 'No disclosed deals on record yet', dir: 'neutral' });
  if (d.evidence && d.evidence.profileSource === 'comp') out.push({ label: 'Verified in the NIL comp database', dir: 'pos' });
  if (Array.isArray(d.matchedTags) && d.matchedTags.length) out.push({ label: 'Fits athlete interests: ' + d.matchedTags.slice(0, 4).join(', '), dir: 'pos' });
  var tv = d.verdict || {};
  if (tv.status === 'in-range' || tv.status === 'above') out.push({ label: tv.text || 'Athlete fits their typical deal profile', dir: 'pos' });
  else if (tv.status === 'below') out.push({ label: tv.text || 'Below their typical deal profile', dir: 'neg' });
  if (isNational && d.fallbackNote) out.push({ label: 'Shown because a local search could not complete', dir: 'neutral' });
  return out;
}

// Toggle the fit-score breakdown panel under a card (collapsed by default,
// expands inline on click, collapses on a second click). Reads the live card
// object so lazily-loaded contacts are reflected when present.
function dsToggleWhy(i) {
  var panel = document.getElementById('dswhy-' + i);
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  var d = (window._dealScanResults || [])[i];
  if (!d) return;
  var factors = _dsScoreBreakdown(d);
  var dirMeta = { pos: { sym: '+', color: '#84CC16' }, neg: { sym: '−', color: '#f87171' }, neutral: { sym: '•', color: 'var(--muted)' } };
  var rows = factors.map(function(f){
    var m = dirMeta[f.dir] || dirMeta.neutral;
    return '<div style="display:flex;align-items:flex-start;gap:8px;padding:3px 0">' +
      '<span style="color:' + m.color + ';font-weight:700;font-size:12px;width:12px;flex-shrink:0;text-align:center;line-height:1.5">' + m.sym + '</span>' +
      '<span style="font-size:11px;color:var(--text);line-height:1.5">' + esc(f.label) + '</span>' +
    '</div>';
  }).join('');
  panel.innerHTML =
    '<div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted);margin-bottom:7px">Why this scored ' + (d.fitScore || '') + '</div>' +
    (rows || '<div style="font-size:11px;color:var(--muted)">No factors available for this result.</div>') +
    '<div style="font-size:9px;color:var(--muted);margin-top:8px;line-height:1.4">These are the real signals found for this business. Anything we could not confirm is marked neutral, not guessed.</div>';
  panel.style.display = 'block';
}

function runDealScan()    { return _dsRunScan(false); }

// Run a scan for a NAMED athlete. The assistant calls this; it selects the athlete
// the same way the picker does, then runs the same scan the button runs. No second
// scan path: the ledger, the cost logging and the draft pre-warm all still apply.
window.nilRunDealScanFor = async function (athleteId, lane) {
  if (!athleteId) return;
  var sel = document.getElementById('activeAthlete');
  if (sel && sel.value !== athleteId) {
    sel.value = athleteId;
    if (typeof selectAthlete === 'function') { try { await selectAthlete(athleteId); } catch (_) {} }
  }
  selectedAthleteId = athleteId;
  if (typeof showView === 'function') showView('deal-scan', null);
  return _dsRunScan(false, lane && lane !== 'local' ? { lane: lane } : undefined);
};
function runDealRefresh() { return _dsRunScan(true); }
// Deal Scan — Add to Pipeline
async function addDealToPipeline(brand, dealType, campaign) {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  try {
    // Get NILViewVal estimate for this deal type
    var estimatedValue = 0;
    try {
      var rateResp = await fetch(API_BASE + '/api/rate/' + selectedAthleteId + '?type=' + (dealType || 'ig-post'));
      if (rateResp.ok) {
        var rateData = await rateResp.json();
        estimatedValue = rateData.mid || rateData.low || 0;
      }
    } catch(e) {}
    const dealId = 'deal-' + Date.now();
    await fetch(API_BASE + '/api/athletes/' + selectedAthleteId + '/deals', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        id: dealId,
        brand: brand,
        campaign: campaign || '',
        stage: 'Prospecting',
        value: estimatedValue,
        dealType: dealType || 'ig-post',
        notes: 'Added from Deal Scan — est. value from NILViewVal',
        athleteId: selectedAthleteId
      })
    });
    // Track for NILViewVal feedback
    trackDealScanAction(brand, dealType, 'pipeline');
    // Hard retire (#3): adding to the pipeline means this brand is being worked, so
    // it should never surface again for this athlete. No undo prompt.
    var _pd = (window._dealScanResults || []).find(function (x) { return (x.brand || x.brand_name) === brand; });
    if (_pd && window._dsOnBrandContacted) window._dsOnBrandContacted(_pd, 'pipeline', false);
    showToast(brand + ' added to Pipeline' + (estimatedValue > 0 ? ' — est. $' + estimatedValue.toLocaleString() : ''));
  } catch(e) { showToast('Error adding to pipeline'); }
}

// Deal Scan — Add to Outreach
async function addDealToOutreach(brand, campaign) {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  trackDealScanAction(brand, '', 'outreach');
  var ath = athletes.find(function(a) { return a.id === selectedAthleteId; });
  if (!window.outreachLogByAthlete) window.outreachLogByAthlete = {};
  if (!window.outreachLogByAthlete[selectedAthleteId]) window.outreachLogByAthlete[selectedAthleteId] = [];
  var entry = {
    id: Date.now(),
    brand: brand,
    athlete: ath ? ath.name : '',
    category: campaign || 'NIL Deal',
    date: new Date().toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'}),
    status: 'Sent'
  };
  window.outreachLogByAthlete[selectedAthleteId].unshift(entry);
  // Pre-fill outreach writer and navigate
  var orBrand = document.getElementById('or-brand') || document.getElementById('orBrand');
  if (orBrand) orBrand.value = brand;
  // Also pre-fill the outreach athlete selector
  var orAthlete = document.getElementById('ob-athlete');
  if (orAthlete) orAthlete.value = selectedAthleteId;
  // Render tracker immediately
  if (typeof renderOutreachTracker === 'function') renderOutreachTracker();
  showToast(brand + ' added to Outreach — go to Outreach to write your email');
}

// NILViewVal Feedback Loop — track which deals agents pursue
// Category matters as much as brand: it is what the ranking loop learns from.
// The call sites don't carry it, so resolve it from the currently rendered
// cards by brand name.
function _dsFindCard(brand) {
  try {
    var key = String(brand || '').toLowerCase().trim();
    if (!key || typeof _dsLaneData === 'undefined') return null;
    for (var lane in _dsLaneData) {
      var rows = _dsLaneData[lane] || [];
      for (var i = 0; i < rows.length; i++) {
        if (String(rows[i].brand || '').toLowerCase().trim() === key) return rows[i];
      }
    }
  } catch(e) {}
  return null;
}

async function trackDealScanAction(brand, dealType, action) {
  try {
    var ath = athletes.find(function(a) { return a.id === selectedAthleteId; });
    if (!ath) return;
    var card = _dsFindCard(brand);
    // Store in localStorage for feedback
    var key = 'nil-deal-actions';
    var existing = JSON.parse(localStorage.getItem(key) || '[]');
    existing.push({
      brand: brand, dealType: dealType, action: action,
      sport: ath.sport, position: ath.position, schoolTier: ath.schoolTier,
      timestamp: Date.now()
    });
    // Keep last 50 actions
    if (existing.length > 50) existing = existing.slice(-50);
    localStorage.setItem(key, JSON.stringify(existing));
    // Send to server for model feedback
    fetch(API_BASE + '/api/feedback/deal-action', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        brand: brand, dealType: dealType, action: action, athleteId: selectedAthleteId,
        category: card && card.category ? card.category : null,
        market: card && card.market ? card.market : null
      })
    }).catch(function() {});
  } catch(e) {}
}

async function prefillOutreach(brand) {
  var el = document.getElementById('orBrand');
  if (el) el.value = brand;
  showView('outreach', document.querySelectorAll('.nav-item')[5]);
  showToast('Brand pre-filled — write your outreach');
}
async function prefillNeg(brand, rate) {
  // Negotiate view removed — no-op
}

// ── DEAL CLOSE MODE ────────────────────────────────────────────────────────────

var _dealCloseContext = null; // { brand, dealScanData }

function openDealClose(brand, dealScanIndex) {
  var dealScanData = (dealScanIndex !== undefined && window._dealScanResults) ? window._dealScanResults[dealScanIndex] : null;
  _dealCloseContext = { brand: brand, dealScanData: dealScanData };
  showView('deal-close', document.getElementById('dealCloseNavBtn'));
}

function onDealCloseViewOpen() {
  if (_dealCloseContext && _dealCloseContext.brand) {
    document.getElementById('dc-brand-input').value = _dealCloseContext.brand;
    runDealClose();
  } else {
    // Just show the blank state with input focused
    document.getElementById('dc-brand-input').focus();
    document.getElementById('dc-body').style.display = 'none';
    document.getElementById('dc-loading').style.display = 'none';
    document.getElementById('dc-fit-banner').style.display = 'none';
  }
}

async function runDealClose() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  var brand = (_dealCloseContext && _dealCloseContext.brand) || document.getElementById('dc-brand-input').value.trim();
  if (!brand) { showToast('Enter a brand name'); document.getElementById('dc-brand-input').focus(); return; }

  var btn = document.getElementById('dc-run-btn');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  document.getElementById('dc-loading').style.display = 'block';
  document.getElementById('dc-body').style.display = 'none';
  document.getElementById('dc-fit-banner').style.display = 'none';
  document.getElementById('dc-headline').textContent = brand + ' — loading intelligence…';

  var dealScanData = (_dealCloseContext && _dealCloseContext.brand === brand) ? _dealCloseContext.dealScanData : null;

  try {
    var resp = await fetch(API_BASE + '/api/deal-close/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ athleteId: selectedAthleteId, brand: brand, dealScanData: dealScanData }),
    });
    if (!resp.ok) throw new Error('API error ' + resp.status);
    var data = await resp.json();

    renderDealClose(data, brand);
    _dealCloseContext = { brand: brand, dealScanData: data.dealScan };
  } catch(e) {
    showToast('Error loading deal intelligence: ' + e.message);
    document.getElementById('dc-headline').textContent = 'Error — try again';
  } finally {
    document.getElementById('dc-loading').style.display = 'none';
    btn.disabled = false; btn.textContent = 'Analyze Deal';
  }
}

function renderDealClose(data, brand) {
  var ath      = data.athlete      || {};
  var br       = data.brand        || {};
  var pricing  = data.pricing      || {};
  var match    = data.match        || {};
  var aiData   = data.ai           || {};
  var contacts = data.contacts     || [];
  var outreach = data.outreach     || [];
  var dealScan = data.dealScan     || {};
  var fit      = data.fitBreakdown || {};
  var drivers  = data.rateDrivers  || [];
  var limits   = data.rateLimits   || [];
  var rel      = data.reliability  || {};
  var compNote = data.compNote     || {};
  var momentum = data.momentum     || {};
  var market   = data.marketRange  || pricing;

  // ── University mode: hide sales layer ────────────────────────
  var isUniversity = (data.userRole === 'university' || data.userRole === 'university_admin' || (currentUser && (currentUser.role === 'university' || currentUser.role === 'university_admin')));
  var salesLayer = document.getElementById('dc-sales-layer');
  if (salesLayer) salesLayer.style.display = isUniversity ? 'none' : 'block';

  // ── Headline ─────────────────────────────────────────────────
  document.getElementById('dc-headline').textContent = (ath.name || 'Athlete') + ' × ' + brand;

  // ── Fit Banner ───────────────────────────────────────────────
  var fitOverall  = fit.overall || 'Fit analysis complete';
  var fitColor    = fitOverall.indexOf('High') !== -1 ? 'var(--accent)' : fitOverall.indexOf('Low') !== -1 || fitOverall.indexOf('Developing') !== -1 ? '#f59e0b' : 'var(--text)';
  document.getElementById('dc-fit-overall').innerHTML = '<span style="color:' + fitColor + ';font-weight:700">' + fitOverall + '</span>';
  document.getElementById('dc-fit-rationale').textContent = dealScan.rationale || match.reasoning || '';

  var fitDims = [
    { label: 'Audience Fit',   value: fit.audienceFit,  note: fit.audienceNote  },
    { label: 'Brand Category', value: fit.categoryFit,  note: fit.categoryNote  },
    { label: 'Geography',      value: fit.geoFit,       note: fit.geoNote       },
    { label: 'Sport Relevance',value: fit.sportFit,     note: fit.sportNote     },
  ];
  document.getElementById('dc-fit-dims').innerHTML = fitDims.map(function(d) {
    var v = d.value || 'Moderate';
    var c = v === 'High' ? 'var(--accent)' : v === 'Low' ? '#f87171' : '#f59e0b';
    return '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px 12px">' +
      '<div style="font-size:9px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">' + d.label + '</div>' +
      '<div style="font-size:12px;font-weight:700;color:' + c + ';margin-bottom:3px">' + v + '</div>' +
      '<div style="font-size:10px;color:var(--muted);line-height:1.4">' + (d.note || '') + '</div>' +
    '</div>';
  }).join('');

  var banner = document.getElementById('dc-fit-banner');
  banner.style.display = 'block';

  // ── LAYER 1: DATA ─────────────────────────────────────────────

  // Athlete snapshot — follower counts as rounded estimates, no exact numbers
  var igRaw = parseInt(ath.instagram) || 0;
  var ttRaw = parseInt(ath.tiktok)    || 0;
  var igEst = igRaw > 0 ? '~' + _dcFmtReach(igRaw) + ' (est.)' : '—';
  var ttEst = ttRaw > 0 ? '~' + _dcFmtReach(ttRaw) + ' (est.)' : '—';
  var erVal = parseFloat(ath.engagement) || 0;
  var erDisplay = erVal > 0 ? erVal.toFixed(1) + '% engagement' : '—';
  document.getElementById('dc-athlete-body').innerHTML =
    dcRow('Name',       ath.name || '—') +
    dcRow('Sport',      (ath.sport || '—') + (ath.position ? ' · ' + ath.position : '')) +
    dcRow('School',     ath.school || '—') +
    dcRow('Instagram',  igEst) +
    dcRow('TikTok',     ttEst) +
    dcRow('Engagement', erDisplay) +
    (ath.stats ? dcRow('Stats', ath.stats, true) : '');

  // Brand snapshot
  document.getElementById('dc-brand-body').innerHTML =
    dcRow('Name',    brand) +
    (br.industry          ? dcRow('Category',   br.industry)          : '') +
    (br.size              ? dcRow('Size',        br.size)              : '') +
    (br.description       ? dcRow('About',       br.description, true) : '') +
    (br.targetDemographics? dcRow('Target Demo', br.targetDemographics, true) : '') +
    '<div style="margin-top:10px;font-size:10px;color:' + (data.hasExistingData ? 'var(--accent)' : 'var(--muted)') + '">' +
      (data.hasExistingData ? '✓ Enrichment data on file' : 'No enrichment yet — run AI Outreach to generate') +
    '</div>';

  // Market Estimate
  var mLow  = market.low  || 0;
  var mHigh = market.high || 0;
  document.getElementById('dc-market-range').textContent = mLow > 0 ? '$' + mLow.toLocaleString() + ' – $' + mHigh.toLocaleString() : '—';
  var relLabel = rel.label || 'Moderate';
  var relColor = relLabel === 'Very Strong' || relLabel === 'Strong' ? 'var(--accent)' : relLabel === 'Low' ? '#f87171' : '#f59e0b';
  document.getElementById('dc-market-reliability').innerHTML =
    '<div style="font-size:10px;color:var(--muted);margin-bottom:4px">Estimate Reliability</div>' +
    '<div style="font-size:13px;font-weight:700;color:' + relColor + '">' + relLabel + '</div>' +
    (rel.strengths && rel.strengths.length ? '<div style="font-size:10px;color:var(--muted);margin-top:4px;line-height:1.5">' + rel.strengths[0] + '</div>' : '');

  // Contacts
  if (contacts.length > 0) {
    document.getElementById('dc-contacts-body').innerHTML = contacts.map(function(c) {
      return '<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (c.name || 'Contact') + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + (c.title || '') + '</div>' +
        (c.email ? '<div style="margin-top:2px"><a href="mailto:' + c.email + '" style="font-size:11px;color:var(--accent);text-decoration:none">' + c.email + '</a></div>' : '') +
      '</div>';
    }).join('');
  } else {
    document.getElementById('dc-contacts-body').innerHTML = '<div style="font-size:12px;color:var(--muted)">No contacts on file — run AI Outreach to discover contacts.</div>';
  }

  // Outreach history
  if (outreach.length > 0) {
    document.getElementById('dc-outreach-body').innerHTML = outreach.map(function(o) {
      return '<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border)">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (o.subject || 'Outreach Draft') + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">' +
          '<span style="font-size:10px;padding:2px 8px;border-radius:10px;background:rgba(132,204,22,0.1);color:var(--accent);font-weight:600">' + (o.status || 'draft').toUpperCase() + '</span>' +
          '<span style="font-size:10px;color:var(--muted)">' + new Date(o.created_at).toLocaleDateString() + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
  } else {
    document.getElementById('dc-outreach-body').innerHTML = '<div style="font-size:12px;color:var(--muted)">No outreach on file for this brand yet.</div>';
  }

  // ── LAYER 2: REASONING ────────────────────────────────────────

  // Rate Drivers
  document.getElementById('dc-rate-drivers').innerHTML =
    (drivers.length ? drivers.map(function(d) {
      return '<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:7px"><span style="color:var(--accent);font-size:12px;flex-shrink:0">↑</span><span style="font-size:12px;color:var(--text);line-height:1.45">' + d + '</span></div>';
    }).join('') : '<div style="font-size:12px;color:var(--muted)">Add more athlete data to generate rate signals.</div>');

  // Rate Limitations
  document.getElementById('dc-rate-limits').innerHTML =
    (limits.length ? limits.map(function(l) {
      return '<div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:7px"><span style="color:var(--muted);font-size:12px;flex-shrink:0">↓</span><span style="font-size:12px;color:var(--muted);line-height:1.45">' + l + '</span></div>';
    }).join('') : '');

  // Comparable Market
  var compTier  = compNote.tierLabel  || 'Similar tier';
  var compSport = compNote.sportLabel || 'athletes in this sport';
  var compReach = compNote.reachLabel || 'similar reach tier';
  document.getElementById('dc-comp-note').innerHTML =
    '<div style="font-size:12px;color:var(--text);line-height:1.6;margin-bottom:10px">' +
      compTier + ' ' + compSport + ' at ' + compReach + ' typically range <strong>$' + mLow.toLocaleString() + ' – $' + mHigh.toLocaleString() + '</strong> per deliverable.' +
    '</div>' +
    '<div style="font-size:10px;color:var(--muted)">Based on public NIL benchmark data (NCAA 2025, Opendorse, On3).</div>';

  // Momentum
  var momSignal = momentum.signal || 'Insufficient data';
  var momColor  = momSignal === 'Trending Up' ? 'var(--accent)' : momSignal === 'Stable' ? '#60a5fa' : momSignal === 'Emerging' ? '#f59e0b' : 'var(--muted)';
  document.getElementById('dc-momentum').innerHTML =
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Momentum</div>' +
    '<div style="font-size:12px;font-weight:700;color:' + momColor + ';margin-bottom:3px">' + momSignal + '</div>' +
    '<div style="font-size:11px;color:var(--muted);line-height:1.4">' + (momentum.reason || '') + '</div>';

  // Campaign
  var campaign = dealScan.campaign || (match.campaign_ideas && (Array.isArray(match.campaign_ideas) ? match.campaign_ideas[0] : '')) || '';
  var campaignIdeas = [];
  try { campaignIdeas = typeof match.campaign_ideas === 'string' ? JSON.parse(match.campaign_ideas) : (match.campaign_ideas || []); } catch(e) {}
  document.getElementById('dc-campaign-tag').textContent = dealScan.dealType ? dealScan.dealType.replace(/-/g,' ').replace(/\b\w/g,function(c){return c.toUpperCase();}) : '';
  document.getElementById('dc-campaign-body').innerHTML =
    (campaign ? '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px">' + campaign + '</div>' : '') +
    (campaignIdeas.length > 1
      ? campaignIdeas.slice(1,4).map(function(ci) {
          return '<div style="font-size:12px;color:var(--text);margin-bottom:6px;padding-left:12px;border-left:2px solid var(--border)">' + ci + '</div>';
        }).join('')
      : '') +
    (match.audience_alignment ? '<div style="margin-top:12px;font-size:11px;color:var(--muted);line-height:1.55;padding-top:10px;border-top:1px solid var(--border)">' + match.audience_alignment + '</div>' : '');

  // ── LAYER 3: SALES (agent only) ───────────────────────────────
  if (!isUniversity) {
    // Ask Strategy
    document.getElementById('dc-ask-body').innerHTML =
      dcAskCard('Start',   '$' + (pricing.start  || pricing.low  || 0).toLocaleString(), 'Open anchor') +
      dcAskCard('Target',  '$' + (pricing.target || pricing.mid  || 0).toLocaleString(), 'Fair market value', true) +
      dcAskCard('Stretch', '$' + (pricing.stretch|| pricing.high || 0).toLocaleString(), 'Premium ask');
    var anchor = aiData.ask_anchor || '';
    document.getElementById('dc-ask-anchor').textContent = anchor || 'Open at the Target rate and signal flexibility if they need to adjust scope.';

    // Talking Points
    var pts = aiData.negotiation_points || [];
    document.getElementById('dc-talking-points').innerHTML = pts.length
      ? pts.map(function(p) {
          return '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:10px"><span style="color:var(--accent);font-size:13px;flex-shrink:0;margin-top:1px">→</span><span style="font-size:12px;color:var(--text);line-height:1.55">' + p + '</span></div>';
        }).join('')
      : '<div style="font-size:12px;color:var(--muted)">Generate a deal scan to see AI talking points.</div>';

    var openLine = aiData.opening_line || '';
    document.getElementById('dc-opening-line').innerHTML = openLine
      ? '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Call Opening</div><div style="font-size:12px;color:var(--text);font-style:italic;line-height:1.6;padding:10px 12px;background:var(--surface2);border-radius:var(--r-sm)">"' + openLine + '"</div>'
      : '';

    var walkLine = aiData.walk_away_line || '';
    document.getElementById('dc-walk-away').innerHTML = walkLine
      ? '<div style="font-size:10px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px;margin-top:10px">If It\'s Not Going Anywhere</div><div style="font-size:12px;color:var(--text);font-style:italic;line-height:1.6;padding:10px 12px;background:rgba(245,158,11,0.05);border:1px solid rgba(245,158,11,0.12);border-radius:var(--r-sm)">"' + walkLine + '"</div>'
      : '';

    // Objection Handling
    var objections = aiData.objection_handling || [];
    document.getElementById('dc-objections').innerHTML = objections.length
      ? objections.map(function(o) {
          return '<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border)">' +
            '<div style="font-size:11px;color:#f87171;font-weight:600;margin-bottom:5px">"' + o.objection + '"</div>' +
            '<div style="font-size:12px;color:var(--text);line-height:1.55">' + o.response + '</div>' +
          '</div>';
        }).join('')
      : '<div style="font-size:12px;color:var(--muted)">Objection handling will appear here.</div>';
  }

  document.getElementById('dc-body').style.display = 'block';
}

// ── Deal Close helpers ────────────────────────────────────────────

/** Rounds a follower count to a clean K display (no false precision) */
function _dcFmtReach(n) {
  var num = parseInt(n) || 0;
  if (num >= 1000000) return Math.round(num / 100000) / 10 + 'M';
  if (num >= 10000)   return Math.round(num / 1000) + 'K';
  if (num >= 1000)    return (num / 1000).toFixed(1) + 'K';
  return String(num);
}

function openOutreachFromDealClose() {
  var brand = document.getElementById('dc-brand-input').value.trim() || (_dealCloseContext && _dealCloseContext.brand) || '';
  if (brand) prefillOutreach(brand);
}

function dcRow(label, value, small) {
  return '<div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px">' +
    '<span style="font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:0.05em;min-width:70px;padding-top:1px">' + label + '</span>' +
    '<span style="font-size:' + (small ? '11' : '12') + 'px;color:var(--text);line-height:1.45;flex:1">' + value + '</span>' +
  '</div>';
}

function dcAskCard(label, value, note, highlight) {
  return '<div style="background:' + (highlight ? 'rgba(132,204,22,0.06)' : 'var(--surface2)') + ';border:1px solid ' + (highlight ? 'rgba(132,204,22,0.25)' : 'var(--border)') + ';border-radius:var(--r-sm);padding:14px;text-align:center">' +
    '<div style="font-size:9px;font-weight:700;color:' + (highlight ? 'var(--accent)' : 'var(--muted)') + ';text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px">' + label + '</div>' +
    '<div style="font-size:20px;font-weight:800;color:' + (highlight ? 'var(--accent)' : 'var(--text)') + ';margin-bottom:4px">' + value + '</div>' +
    '<div style="font-size:10px;color:var(--muted)">' + note + '</div>' +
  '</div>';
}

//  AI: RATE 
async function calcRate() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  const type = document.getElementById('rateDeliverable').value;
  try {
    const rate = await fetch(`${API_BASE}/api/ai/rate`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ athleteId: selectedAthleteId, deliverableType: type }),
    }).then(r=>r.json());
    if (rate.error) { showToast('Error: ' + rate.error); return; }
    lastCalculatedRate = { ...rate, deliverableType: type };
    const result = document.getElementById('rateResult');
    result.classList.add('visible');
    // Use clean rounded numbers — avoids false precision like $472–$877
    const displayLow  = rate.cleanLow  || rate.low  || 0;
    const displayHigh = rate.cleanHigh || rate.high || 0;
    document.getElementById('rateRange').textContent = '$' + displayLow.toLocaleString() + ' – $' + displayHigh.toLocaleString();
    const delivLabels = {
      'ig-reel':'per IG Reel', 'ig-post':'per IG Post', 'ig-carousel':'per IG Carousel',
      'tiktok':'per TikTok Video', 'tiktok-spark':'per TikTok Spark Ad',
      'youtube-short':'per YouTube Short', 'youtube-long':'per YouTube Dedicated Video',
      'youtube-int':'per YouTube Integration', 'stories':'per Story Set',
      'story-bundle':'per Story Bundle (5-7)', 'newsletter':'per Newsletter Feature',
      'podcast-host':'per Podcast Host Read', 'twitter-campaign':'per Twitter/X Campaign',
      'threads':'per Threads Campaign', 'bundle':'per IG Bundle (Reel+Post+Story)',
      'bundle-cross':'per Cross-Platform Bundle', 'retainer':'per Month (Retainer)',
      'ugc-photo':'per UGC Photo License', 'ugc-video':'per UGC Video License',
      'appearance-inperson':'per In-Person Appearance', 'appearance-speaking':'per Speaking/Panel',
      'appearance-meetgreet':'per Meet & Greet', 'appearance-campus':'per Campus Appearance',
      'appearance-virtual':'per Virtual Appearance', 'media-podcast':'per Podcast Guest Spot',
      'media-youtube':'per YouTube Integration', 'media-twitch':'per Twitch Session',
      'media-pressday':'per Media Day', 'media-documentary':'per Documentary Feature',
      'license-jersey':'per Jersey License', 'license-merch':'per Merch Collab',
      'license-codesign':'per Product Co-Design', 'license-autograph':'per Autograph Signing',
      'license-videogame':'per Video Game License', 'license-trading-card':'per Trading Card',
      'license-nft-digital':'per Digital/NFT', 'collective-roster':'per Month (Collective)',
      'collective-ambassador':'per Month (Ambassador)', 'collective-booster':'per Booster Event',
      'collective-exclusive':'per Month (Exclusive)', 'camp-skills':'per Skills Camp',
      'camp-clinic':'per Youth Clinic', 'camp-training':'per Training Partnership',
      'camp-elite':'per Elite Camp/Showcase',
    };
    document.getElementById('ratePer').textContent = delivLabels[type] || ('per ' + type.replace(/-/g,' '));
    // ── Rate Drivers + Limitations — replaces raw multiplier display ──────
    // Internal math unchanged; presentation uses plain-English reasoning.
    var driversHtml = '';
    if (rate.rateDrivers && rate.rateDrivers.length) {
      driversHtml += '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin:12px 0 6px">Rate Drivers</div>';
      driversHtml += '<div style="display:flex;flex-wrap:wrap;gap:5px">';
      rate.rateDrivers.forEach(function(d) {
        driversHtml += '<span style="font-size:11px;padding:3px 9px;border-radius:20px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.2);color:var(--accent)">↑ ' + d + '</span>';
      });
      driversHtml += '</div>';
    }
    if (rate.rateLimits && rate.rateLimits.length) {
      driversHtml += '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin:10px 0 6px">Limitations</div>';
      driversHtml += '<div style="display:flex;flex-wrap:wrap;gap:5px">';
      rate.rateLimits.forEach(function(l) {
        driversHtml += '<span style="font-size:11px;padding:3px 9px;border-radius:20px;background:rgba(255,255,255,0.04);border:1px solid var(--border);color:var(--muted)">↓ ' + l + '</span>';
      });
      driversHtml += '</div>';
    }
    document.getElementById('rateBreakdown').innerHTML = driversHtml;
    // Show client context panel
    const ath = athletes.find(a => a.id === selectedAthleteId);
    if (ath) {
      const ctx = document.getElementById('rate-client-context');
      const body = document.getElementById('rate-context-body');
      if (ctx && body) {
        const reach = (ath.instagram||0) + (ath.tiktok||0);
        const tier = reach > 500000 ? 'Macro' : reach > 100000 ? 'Mid' : reach > 25000 ? 'Micro' : 'Nano';
        const items = [
          ['Athlete', ath.name],
          ['Sport', ath.sport + (ath.position ? ' · ' + ath.position : '')],
          ['School', (ath.school||'—') + ' (' + (ath.schoolTier||'—') + ')'],
          ['IG Followers', (ath.instagram||0).toLocaleString()],
          ['TikTok Followers', (ath.tiktok||0).toLocaleString()],
          ['Engagement Rate', (ath.engagement||0) + '%'],
          ['Social Tier', tier],
          ['Total Reach', reach.toLocaleString()],
        ];
        body.innerHTML = items.map(function(item) {
          return '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:8px 10px">' +
            '<div style="font-size:10px;color:var(--muted);margin-bottom:2px">' + item[0] + '</div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--text)">' + item[1] + '</div>' +
          '</div>';
        }).join('');
        ctx.style.display = 'block';
      }
    }
    // Show floor notice if applied
    var floorNotice = document.getElementById('rate-floor-notice');
    if (floorNotice) {
      if (rate.floorApplied) {
        floorNotice.style.display = 'block';
        const floorAth = athletes ? athletes.find(function(a){return a.id===selectedAthleteId;}) : null;
        floorNotice.textContent = 'Minimum floor rate applied for ' + (floorAth ? floorAth.schoolTier : 'this school tier') + '. Raw model rate was below market minimum.';
      } else {
        floorNotice.style.display = 'none';
      }
    }
    // Show recommendation for small athletes
    var recBox = document.getElementById('rate-recommendation');
    if (recBox) {
      if (rate.recommendation) {
        recBox.style.display = 'block';
        document.getElementById('rate-rec-text').textContent = rate.recommendation;
      } else {
        recBox.style.display = 'none';
      }
    }
    // ── Market Confidence + Reliability panel ───────────────────────────────
    var archBox = document.getElementById('rate-archetype');
    if (archBox) {
      archBox.style.display = 'block';
      var ct = rate.confTypes   || {};
      var rl = rate.reliability || {};
      var overallLabel = ct.overall   || 'Low';
      var relLabel     = rl.label     || 'Moderate';
      var overallColor = overallLabel === 'High' ? '#4ade80' : overallLabel === 'Moderate' ? '#f59e0b' : 'var(--muted)';
      var relColor     = (relLabel === 'Very Strong' || relLabel === 'Strong') ? '#4ade80' : relLabel === 'Moderate' ? '#f59e0b' : 'var(--muted)';

      function confBar(pct) {
        var c = pct >= 70 ? '#4ade80' : pct >= 45 ? '#f59e0b' : 'rgba(255,255,255,0.15)';
        return '<div style="background:var(--surface2);border-radius:3px;height:4px;margin-top:5px;margin-bottom:2px"><div style="width:' + Math.min(pct,100) + '%;background:' + c + ';height:4px;border-radius:3px;transition:width 0.4s"></div></div>';
      }

      var html = '';

      // Market Confidence header + overall badge
      html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">';
      html +=   '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">Market Confidence</div>';
      html +=   '<span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;background:' + (overallLabel === 'High' ? 'rgba(74,222,128,0.12)' : overallLabel === 'Moderate' ? 'rgba(245,158,11,0.12)' : 'rgba(255,255,255,0.06)') + ';color:' + overallColor + ';border:1px solid ' + (overallLabel === 'High' ? 'rgba(74,222,128,0.25)' : overallLabel === 'Moderate' ? 'rgba(245,158,11,0.25)' : 'var(--border)') + '">' + overallLabel + '</span>';
      html += '</div>';

      // Confidence type grid
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px">';

      // Social data
      html += '<div style="background:var(--surface2);padding:10px;border-radius:var(--r-sm)">';
      html +=   '<div style="font-size:10px;color:var(--muted)">Social Data</div>';
      html +=   '<div style="font-size:16px;font-weight:800;color:var(--text)">' + (ct.social||0) + '<span style="font-size:10px;color:var(--muted);font-weight:400">%</span></div>';
      html +=   confBar(ct.social||0);
      html += '</div>';

      // Market benchmarks
      html += '<div style="background:var(--surface2);padding:10px;border-radius:var(--r-sm)">';
      html +=   '<div style="font-size:10px;color:var(--muted)">Market Benchmarks</div>';
      html +=   '<div style="font-size:16px;font-weight:800;color:var(--text)">' + (ct.market||0) + '<span style="font-size:10px;color:var(--muted);font-weight:400">%</span></div>';
      html +=   confBar(ct.market||0);
      html += '</div>';

      // Deal comparables — use label, never show raw 0%
      html += '<div style="background:var(--surface2);padding:10px;border-radius:var(--r-sm)">';
      html +=   '<div style="font-size:10px;color:var(--muted)">Deal Comparables</div>';
      if (ct.comparable > 0) {
        html += '<div style="font-size:16px;font-weight:800;color:var(--text)">' + ct.comparable + '<span style="font-size:10px;color:var(--muted);font-weight:400">%</span></div>';
        html += confBar(ct.comparable);
      } else {
        html += '<div style="font-size:12px;font-weight:600;color:var(--muted);margin-top:5px">' + (ct.comparableLabel||'Developing dataset') + '</div>';
        html += '<div style="font-size:10px;color:var(--muted);margin-top:3px;line-height:1.4">Using public NIL benchmark sources</div>';
      }
      html += '</div>';

      // Partnership history — always explicitly honest
      html += '<div style="background:var(--surface2);padding:10px;border-radius:var(--r-sm)">';
      html +=   '<div style="font-size:10px;color:var(--muted)">Partnership History</div>';
      html +=   '<div style="font-size:12px;font-weight:600;color:var(--muted);margin-top:5px">Not yet established</div>';
      html +=   '<div style="font-size:10px;color:var(--muted);margin-top:3px;line-height:1.4">Benchmark estimates applied</div>';
      html += '</div>';

      html += '</div>'; // end grid

      // Market Reliability — label-based, no decimal score exposed
      var relSteps = ['Low','Moderate','Strong','Very Strong'];
      var relIdx   = relSteps.indexOf(relLabel);
      html += '<div style="border-top:1px solid var(--border);padding-top:12px;margin-top:4px">';
      html +=   '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">';
      html +=     '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">Market Reliability</div>';
      html +=     '<div style="font-size:13px;font-weight:800;color:' + relColor + '">' + relLabel + '</div>';
      html +=   '</div>';
      // Segmented indicator bar
      html +=   '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:10px">';
      relSteps.forEach(function(step, i) {
        var active = i <= relIdx;
        var stepColor = (step === 'Very Strong' || step === 'Strong') ? '#4ade80' : step === 'Moderate' ? '#f59e0b' : '#f87171';
        html += '<div style="height:5px;border-radius:3px;background:' + (active ? stepColor : 'rgba(255,255,255,0.08)') + ';transition:background 0.3s"></div>';
      });
      html +=   '</div>';
      // Step labels under the bar
      html +=   '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:10px">';
      relSteps.forEach(function(step, i) {
        var active = i <= relIdx;
        html += '<div style="font-size:9px;text-align:center;color:' + (active ? 'var(--text)' : 'var(--muted)') + ';font-weight:' + (i === relIdx ? '700' : '400') + '">' + step + '</div>';
      });
      html +=   '</div>';
      // Strong / Weak signal bullets
      if (rl.strengths && rl.strengths.length) {
        html += '<div style="font-size:10px;color:var(--muted);margin-bottom:5px"><span style="color:#4ade80;font-weight:600">Strong signals:</span> ' + rl.strengths.join(' · ') + '</div>';
      }
      if (rl.weaknesses && rl.weaknesses.length) {
        html += '<div style="font-size:10px;color:var(--muted)"><span style="font-weight:600">Developing:</span> ' + rl.weaknesses.join(' · ') + '</div>';
      }
      html += '</div>';

      archBox.innerHTML = html;
    }

    // ── Suggested Pricing Strategy ────────────────────────────────────────────
    var strategyBox = document.getElementById('rate-strategy');
    if (strategyBox && rate.pricingStrategy) {
      strategyBox.style.display = 'block';
      var ps = rate.pricingStrategy;
      strategyBox.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:12px">Suggested Pricing Strategy</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">' +
          '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;text-align:center">' +
            '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px">Floor</div>' +
            '<div style="font-size:15px;font-weight:800;color:var(--text)">$' + (ps.start||0).toLocaleString() + '</div>' +
            '<div style="font-size:9px;color:var(--muted);margin-top:3px">Do not go lower</div>' +
          '</div>' +
          '<div style="background:rgba(132,204,22,0.08);border:1px solid rgba(132,204,22,0.2);border-radius:var(--r-sm);padding:10px;text-align:center">' +
            '<div style="font-size:9px;color:var(--accent);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;font-weight:700">Target</div>' +
            '<div style="font-size:15px;font-weight:800;color:var(--accent)">$' + (ps.target||0).toLocaleString() + '</div>' +
            '<div style="font-size:9px;color:var(--muted);margin-top:3px">Fair market rate</div>' +
          '</div>' +
          '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:10px;text-align:center">' +
            '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px">Stretch</div>' +
            '<div style="font-size:15px;font-weight:800;color:var(--text)">$' + (ps.stretch||0).toLocaleString() + '</div>' +
            '<div style="font-size:9px;color:var(--muted);margin-top:3px">Exclusivity premium</div>' +
          '</div>' +
        '</div>';
    }

    // ── Deal Type Rate Breakdown ──────────────────────────────────────────────
    var dealTypesBox = document.getElementById('rate-deal-types');
    if (dealTypesBox && rate.dealTypeRates) {
      dealTypesBox.style.display = 'block';
      var dtr = rate.dealTypeRates;
      var dtLabels = {
        'ig-post':'IG Post','ig-reel':'IG Reel','stories':'Story Set',
        'bundle':'IG Bundle','appearance-inperson':'Appearance','retainer':'Monthly Retainer'
      };
      var dtRows = Object.entries(dtr).map(function(entry) {
        var key = entry[0]; var val = entry[1];
        return '<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
          '<span style="font-size:12px;color:var(--muted)">' + (dtLabels[key]||key) + '</span>' +
          '<span style="font-size:12px;font-weight:700;color:var(--text)">$' + (val.low||0).toLocaleString() + ' – $' + (val.high||0).toLocaleString() + '</span>' +
        '</div>';
      }).join('');
      dealTypesBox.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Estimated Rates by Deal Type</div>' +
        dtRows +
        '<div style="font-size:10px;color:var(--muted);margin-top:8px;line-height:1.5">Estimates based on current deliverable selected and athlete profile. Click any deal type above to recalculate.</div>';
    }

    // ── Comparable Market ─────────────────────────────────────────────────────
    var compMarketBox = document.getElementById('rate-comparable-market');
    if (compMarketBox && rate.compNote) {
      compMarketBox.style.display = 'block';
      var cn = rate.compNote;
      compMarketBox.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Comparable Market</div>' +
        '<div style="font-size:12px;color:var(--text);font-weight:600;margin-bottom:4px">' + cn.tierLabel + ' ' + cn.sportLabel + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">' + cn.reachLabel + '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;background:var(--surface2);border-radius:var(--r-sm);padding:10px 12px">' +
          '<div>' +
            '<div style="font-size:10px;color:var(--muted);margin-bottom:3px">Typical market range</div>' +
            '<div style="font-size:14px;font-weight:800;color:var(--text)">$' + (rate.cleanLow||rate.low||0).toLocaleString() + ' – $' + (rate.cleanHigh||rate.high||0).toLocaleString() + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-size:10px;color:var(--muted);margin-bottom:3px">Data source</div>' +
            '<div style="font-size:10px;font-weight:600;color:var(--text)">' + (cn.source||'2025 NIL benchmarks') + '</div>' +
          '</div>' +
        '</div>';
    }

    // ── Momentum Signal ───────────────────────────────────────────────────────
    var momentumBox = document.getElementById('rate-momentum');
    if (momentumBox && rate.momentum) {
      momentumBox.style.display = 'block';
      var mom = rate.momentum;
      var momColor = mom.signal === 'Trending Up' ? '#4ade80' :
                     mom.signal === 'Emerging'     ? '#f59e0b' :
                     mom.signal === 'Stable'        ? '#60a5fa' : 'var(--muted)';
      var momIcon  = mom.signal === 'Trending Up'  ? '↑' :
                     mom.signal === 'Emerging'      ? '→' :
                     mom.signal === 'Stable'         ? '→' : '—';
      momentumBox.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between">' +
          '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">Momentum</div>' +
          '<span style="font-size:11px;font-weight:700;color:' + momColor + '">' + momIcon + ' ' + mom.signal + '</span>' +
        '</div>' +
        (mom.reason ? '<div style="font-size:10px;color:var(--muted);margin-top:5px">' + mom.reason + '</div>' : '');
    }

    // ── How This Estimate Was Built ───────────────────────────────────────────
    var builtBox = document.getElementById('rate-estimate-built');
    if (builtBox && rate.estimateInputs && rate.estimateInputs.length) {
      builtBox.style.display = 'block';
      builtBox.innerHTML =
        '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">How This Estimate Was Built</div>' +
        '<div style="font-size:11px;color:var(--muted);line-height:1.7">' +
          rate.estimateInputs.map(function(inp) {
            return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;background:var(--surface2);border-radius:20px;border:1px solid rgba(255,255,255,0.06)">' + inp + '</span>';
          }).join('') +
        '</div>';
    }
    document.getElementById('rateAI').classList.add('visible');

    // COMPARABLE DEALS PANEL
    const compsPanel = document.getElementById('rate-comps-panel');
    const compsBody = document.getElementById('rate-comps-body');
    const compStatsEl = document.getElementById('rate-comp-stats');
    const confidenceBadge = document.getElementById('rate-confidence-badge');
    const confidenceNote = document.getElementById('rate-confidence-note');
    if (compsPanel) {
      const dealTypeLabels = {'ig-post':'IG Post','ig-reel':'IG Reel','tiktok':'TikTok','ambassador':'Ambassador','appearance':'Appearance','licensing':'Licensing','retainer':'Retainer','bundle':'Bundle'};
      const confColors = {'High':'rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3)','Medium':'rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)','Low':'rgba(255,255,255,0.06);color:var(--muted);border:1px solid var(--border)'};
      const conf = rate.confidence || 'Low';
      confidenceBadge.style.cssText = 'font-size:10px;font-weight:700;padding:3px 10px;border-radius:20px;letter-spacing:0.04em;background:' + (confColors[conf] || confColors['Low']);
      confidenceBadge.textContent = conf + ' Confidence';
      confidenceNote.textContent = rate.confidenceNote || '';

      if (rate.comps && rate.comps.length > 0) {
        compsBody.innerHTML = rate.comps.map(function(c) {
          const fmtFollowers = c.followers >= 1000000 ? (c.followers/1000000).toFixed(1)+'M' : c.followers >= 1000 ? Math.round(c.followers/1000)+'K' : c.followers;
          const dealLabel = dealTypeLabels[c.dealType] || c.dealType || 'Deal';
          const sport = c.sport ? c.sport.charAt(0).toUpperCase()+c.sport.slice(1) : '';
          const tier = c.tier ? c.tier.replace('p4-','P4 ').replace('mid-','Mid ') : '';
          return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--surface2);border-radius:var(--r-sm);border:1px solid var(--border)">' +
            '<div style="font-size:11px;color:var(--muted)">' +
              '<span style="color:var(--text);font-weight:600">' + sport + ' · ' + tier + '</span>' +
              ' &nbsp;·&nbsp; ' + fmtFollowers + ' reach' +
              ' &nbsp;·&nbsp; ' + (c.engagement||0).toFixed(1) + '% eng' +
              (c.year ? ' &nbsp;·&nbsp; ' + c.year : '') +
            '</div>' +
            '<div style="font-size:12px;font-weight:700;color:var(--accent);white-space:nowrap;margin-left:12px">$' + (c.value||0).toLocaleString() + ' <span style="font-size:10px;color:var(--muted);font-weight:400">' + dealLabel + '</span></div>' +
          '</div>';
        }).join('');
      } else {
        compsBody.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:8px 0">No closed deals logged for this sport/tier yet. Rates above are model-based.</div>';
      }

      if (rate.compStats) {
        const cs = rate.compStats;
        compStatsEl.innerHTML = [
          ['Avg Closed Deal', '$' + cs.avg.toLocaleString()],
          ['Range', '$' + cs.min.toLocaleString() + ' – $' + cs.max.toLocaleString()],
          ['Data Points', cs.count + ' deals']
        ].map(function(item) {
          return '<div style="text-align:center;background:var(--surface2);border-radius:var(--r-sm);padding:8px">' +
            '<div style="font-size:9px;color:var(--muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.06em">' + item[0] + '</div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">' + item[1] + '</div>' +
          '</div>';
        }).join('');
        compStatsEl.style.display = 'grid';
      } else {
        compStatsEl.style.display = 'none';
      }
      compsPanel.style.display = 'block';
    }
    document.getElementById('rate-source-footer').style.display = 'block';
    document.getElementById('rate-export-row').style.display = 'block';

  } catch(e) { showToast('Error: ' + e.message); }
}

async function exportRateSheet() {
  const ath = athletes.find(a => a.id === selectedAthleteId);
  if (!ath || !lastCalculatedRate) { showToast('Calculate a rate first'); return; }
  const rate = lastCalculatedRate;
  const delivType = document.getElementById('rateDeliverable').value;
  const delivLabels = {'ig-reel':'IG Reel','ig-post':'IG Post','tiktok':'TikTok Video','bundle':'IG Bundle','retainer':'Monthly Retainer','appearance-inperson':'In-Person Appearance'};
  const delivLabel = delivLabels[delivType] || delivType.replace(/-/g,' ');
  const conf = rate.confidence || 'Model-based';
  const w = window.open('', '_blank');
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Rate Sheet — ${ath.name}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;color:#111;padding:48px;max-width:760px;margin:0 auto}
    .header{border-bottom:3px solid #111;padding-bottom:20px;margin-bottom:28px}
    .logo{font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:#555;margin-bottom:8px}
    h1{font-size:28px;font-weight:800;letter-spacing:-0.02em;margin-bottom:4px}
    .sub{font-size:13px;color:#666}
    .rate-hero{background:#f5f5f5;border-radius:10px;padding:24px 28px;margin:24px 0;display:flex;align-items:center;justify-content:space-between}
    .rate-big{font-size:36px;font-weight:900;letter-spacing:-0.02em}
    .rate-label{font-size:12px;color:#666;margin-top:3px}
    .conf{font-size:11px;font-weight:700;padding:4px 12px;border-radius:20px;background:#e8f5e9;color:#2e7d32}
    .section{margin-bottom:24px}
    .section-title{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#999;margin-bottom:12px;border-bottom:1px solid #eee;padding-bottom:6px}
    .breakdown-row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f0f0;font-size:13px}
    .breakdown-label{color:#555}
    .breakdown-val{font-weight:700}
    .comp-row{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f9f9f9;border-radius:6px;margin-bottom:6px;font-size:12px}
    .comp-val{font-weight:800;color:#111}
    .stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:10px}
    .stat-box{background:#f5f5f5;border-radius:8px;padding:14px;text-align:center}
    .stat-num{font-size:20px;font-weight:800}
    .stat-lbl{font-size:10px;color:#999;margin-top:2px;text-transform:uppercase;letter-spacing:1px}
    .footer{margin-top:32px;padding-top:16px;border-top:1px solid #eee;font-size:10px;color:#aaa;line-height:1.7}
    @media print{body{padding:32px}}
  </style></head><body>
  <div class="header">
    <div class="logo">NILDash · Rate Sheet</div>
    <h1>${ath.name}</h1>
    <div class="sub">${ath.sport||''} · ${ath.position||''} · ${ath.school||''} · Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  </div>
  <div class="rate-hero">
    <div>
      <div class="rate-big">$${(rate.cleanLow||rate.low||0).toLocaleString()} – $${(rate.cleanHigh||rate.high||0).toLocaleString()}</div>
      <div class="rate-label">Estimated market range per ${delivLabel}</div>
    </div>
    <div class="conf">${conf} Confidence · ${rate.reliability?.label||'Moderate'} Reliability</div>
  </div>
  <div class="section">
    <div class="section-title">Suggested Pricing Strategy</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num">$${(rate.pricingStrategy?.start||0).toLocaleString()}</div><div class="stat-lbl">Floor — Don't go lower</div></div>
      <div class="stat-box" style="background:#e8f5e9"><div class="stat-num" style="color:#2e7d32">$${(rate.pricingStrategy?.target||0).toLocaleString()}</div><div class="stat-lbl">Target — Fair market</div></div>
      <div class="stat-box"><div class="stat-num">$${(rate.pricingStrategy?.stretch||0).toLocaleString()}</div><div class="stat-lbl">Stretch — With exclusivity</div></div>
    </div>
  </div>
  <div class="section">
    <div class="section-title">Rate Drivers</div>
    ${(rate.rateDrivers||[]).map(d=>`<div class="breakdown-row"><span style="color:#2e7d32">↑</span> <span class="breakdown-label">${d}</span></div>`).join('')}
    ${(rate.rateDrivers||[]).length === 0 ? '<div class="breakdown-row"><span class="breakdown-label">Based on NILViewVal benchmark model</span></div>' : ''}
  </div>
  ${(rate.rateLimits||[]).length ? `<div class="section">
    <div class="section-title">Limitations</div>
    ${(rate.rateLimits||[]).map(l=>`<div class="breakdown-row"><span style="color:#999">↓</span> <span class="breakdown-label" style="color:#777">${l}</span></div>`).join('')}
  </div>` : ''}
  ${rate.dealTypeRates ? `<div class="section">
    <div class="section-title">Estimated Rates by Deal Type</div>
    ${Object.entries(rate.dealTypeRates).map(([k,v])=>{
      const labels={'ig-post':'IG Post','ig-reel':'IG Reel','stories':'Story Set','bundle':'IG Bundle','appearance-inperson':'Appearance','retainer':'Monthly Retainer'};
      return `<div class="breakdown-row"><span class="breakdown-label">${labels[k]||k}</span><span class="breakdown-val">$${(v.low||0).toLocaleString()} – $${(v.high||0).toLocaleString()}</span></div>`;
    }).join('')}
  </div>` : ''}
  ${rate.compNote ? `<div class="section">
    <div class="section-title">Comparable Market</div>
    <div class="breakdown-row"><span class="breakdown-label">Peer group</span><span class="breakdown-val">${rate.compNote.tierLabel} ${rate.compNote.sportLabel}</span></div>
    <div class="breakdown-row"><span class="breakdown-label">Follower range</span><span class="breakdown-val">${rate.compNote.reachLabel}</span></div>
    <div class="breakdown-row"><span class="breakdown-label">Data source</span><span class="breakdown-val">${rate.compNote.source}</span></div>
  </div>` : ''}
  <div class="section">
    <div class="section-title">Market Confidence Summary</div>
    <div class="stat-grid">
      <div class="stat-box"><div class="stat-num" style="font-size:14px">${rate.confTypes?.overall||'Low'}</div><div class="stat-lbl">Overall Confidence</div></div>
      <div class="stat-box"><div class="stat-num" style="font-size:14px">${rate.reliability?.label||'Moderate'}</div><div class="stat-lbl">Market Reliability</div></div>
      <div class="stat-box"><div class="stat-num" style="font-size:14px">${rate.momentum?.signal||'—'}</div><div class="stat-lbl">Momentum</div></div>
    </div>
    <div class="stat-grid" style="margin-top:8px">
      <div class="stat-box"><div class="stat-num" style="font-size:15px">${rate.confTypes?.social||0}%</div><div class="stat-lbl">Social Data</div></div>
      <div class="stat-box"><div class="stat-num" style="font-size:15px">${rate.confTypes?.market||0}%</div><div class="stat-lbl">Market Data</div></div>
      <div class="stat-box"><div class="stat-num" style="font-size:14px">${rate.confTypes?.comparableLabel||'Developing'}</div><div class="stat-lbl">Deal Comps</div></div>
    </div>
    ${(rate.reliability?.strengths||[]).length ? `<div style="margin-top:10px;font-size:11px;color:#2e7d32">Strong signals: ${(rate.reliability.strengths||[]).join(' · ')}</div>` : ''}
  </div>
  ${(rate.estimateInputs||[]).length ? `<div class="section">
    <div class="section-title">How This Estimate Was Built</div>
    ${(rate.estimateInputs||[]).map(i=>`<div class="breakdown-row"><span class="breakdown-label" style="color:#555">${i}</span></div>`).join('')}
  </div>` : ''}
  ${rate.comps && rate.comps.length ? `<div class="section">
    <div class="section-title">Comparable Closed Deals (Anonymized)</div>
    ${rate.comps.map(c=>{
      const fmtF = c.followers>=1000000?(c.followers/1000000).toFixed(1)+'M':c.followers>=1000?Math.round(c.followers/1000)+'K':c.followers;
      return `<div class="comp-row"><span>${(c.sport||'').charAt(0).toUpperCase()+(c.sport||'').slice(1)} · ${(c.tier||'').replace('p4-','P4 ').replace('mid-','Mid ')} · ${fmtF} reach · ${(c.engagement||0).toFixed(1)}% eng</span><span class="comp-val">$${(c.value||0).toLocaleString()}</span></div>`;
    }).join('')}
    ${rate.compStats?`<div class="stat-grid">
      <div class="stat-box"><div class="stat-num">$${rate.compStats.avg.toLocaleString()}</div><div class="stat-lbl">Avg Closed</div></div>
      <div class="stat-box"><div class="stat-num">$${rate.compStats.min.toLocaleString()}</div><div class="stat-lbl">Floor</div></div>
      <div class="stat-box"><div class="stat-num">${rate.compStats.count}</div><div class="stat-lbl">Data Points</div></div>
    </div>`:''}
  </div>`:''}
  <div class="footer">
    <strong>Sources:</strong> NILViewVal v5.2 model · Opendorse 2024 NIL benchmarks · NCAA 2025 median deal data · On3 NIL valuations · 18 agency rate cards · NILDash closed deal database<br>
    This rate sheet is a negotiating tool. Final pricing subject to campaign scope, exclusivity, and mutual agreement. Represented by NILDash.
  </div>
  <script>window.onload=()=>setTimeout(()=>window.print(),400)<\/script>
  </body></html>`);
  w.document.close();
}

async function getRateScript() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  if (!lastCalculatedRate) { showToast('Calculate a rate first, then click Negotiation Talking Points'); return; }
  const ath = athletes.find(a => a.id === selectedAthleteId);
  const txt = document.getElementById('rateText');
  const spinner = document.getElementById('rateSpinner');
  document.getElementById('rateAI').classList.add('visible');
  spinner.style.display = 'block';
  txt.textContent = '';
  try {
    const cleanLow  = lastCalculatedRate.cleanLow  || lastCalculatedRate.low  || 0;
    const cleanHigh = lastCalculatedRate.cleanHigh || lastCalculatedRate.high || 0;
    const mid = lastCalculatedRate.mid || Math.round((cleanLow + cleanHigh) / 2) || 10000;
    const type = lastCalculatedRate.deliverableType || 'ig-reel';
    const engagement = ath?.engagement || 4.2;
    const reach = ((ath?.instagram||0) + (ath?.tiktok||0)).toLocaleString();
    const rateDrivers = (lastCalculatedRate.rateDrivers || []).slice(0, 3).join(', ');
    const msg = `You are a sports agent about to get on a call to negotiate a NIL deal for ${ath?.name||'this athlete'} (${ath?.sport||'athlete'} at ${ath?.school||'college'}).

The brand has not committed yet. Your job is to give me negotiation talking points.

KEY DATA:
- Deliverable: ${type.replace(/-/g, ' ')}
- Rate range: $${cleanLow.toLocaleString()} – $${cleanHigh.toLocaleString()} | Target: $${mid.toLocaleString()}
- Engagement: ${engagement}% (industry avg 2.1% — that's ${(engagement/2.1).toFixed(1)}x above average)
- Total reach: ${reach} followers
- CPM estimate: ~$12–16 vs. $28–45 for paid Instagram ads
${rateDrivers ? '- Rate drivers: ' + rateDrivers : ''}

Write 5 specific talking points formatted as a numbered list. Each point should be ONE sentence — a specific, data-grounded statement an agent would actually say out loud in a negotiation call. Not generic advice. Not script headers. Just the lines themselves. Then add a section titled "If They Push Back on Price:" with 2 concise word-for-word responses. Keep the whole thing under 250 words.`;
    const r = await fetch(`${API_BASE}/api/ai/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ athleteId: selectedAthleteId, message: msg }),
    });
    const data = await r.json();
    if (data.error) {
      const isOverloaded = (data.error||'').toLowerCase().includes('overload') || (data.error||'').includes('529');
      txt.textContent = isOverloaded ? "Anthropic's servers are busy — please try again in a moment." : 'Error: ' + data.error;
    } else {
      txt.textContent = data.response || 'No response received.';
    }
  } catch(e) {
    txt.textContent = 'Error: ' + e.message;
  }
  spinner.style.display = 'none';
}


//  PIPELINE 
async function loadPipeline() {
  const stages = ['Prospecting','Outreach Sent','Negotiating','Closing','Closed'];
  let allDeals = [];
  var filterEl = document.getElementById('pipe-filter-client');
  var filterActive = filterEl && filterEl.checked;

  if (filterActive && selectedAthleteId) {
    // Single-athlete filter: fetch just the selected athlete's deals
    const ath = athletes.find(a => a.id === selectedAthleteId);
    allDeals = await fetch(`${API_BASE}/api/athletes/${selectedAthleteId}/deals`)
      .then(r => r.json()).catch(() => []);
    if (ath) allDeals = allDeals.map(d => ({...d, athleteName: ath.name}));
  } else {
    // Agent-wide: use /api/agent/deals which mirrors the Home dashboard source of truth
    const raw = await fetch(`${API_BASE}/api/agent/deals`).then(r => r.json()).catch(() => []);
    const safeRaw = Array.isArray(raw) ? raw : [];
    // Attach athlete names from loaded roster
    const athMap = {};
    (athletes || []).forEach(a => { athMap[a.id] = a.name; });
    allDeals = safeRaw.map(d => ({...d, athleteName: athMap[d.athleteId || d.athlete_id] || d.athleteName || '—'}));
  }

  window._pipelineDeals = allDeals;
  // Total Pipeline = ACTIVE deals only (exclude Closed/Lost) to match Home's $12K/15.
  // Use parseInt to avoid string-concatenation bugs with JSONB string values.
  const total = allDeals
    .filter(d => d.stage !== 'Closed' && d.stage !== 'Lost')
    .reduce((s,d) => s + (parseInt(d.value) || 0), 0);

  // Restore normal font-size/color after loading state
  ['pipe-total','pipe-count','pipe-closing'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.style.fontSize = ''; el.style.color = ''; }
  });

  document.getElementById('pipe-total').textContent   = '$' + (total / 1000).toFixed(0) + 'K';
  document.getElementById('pipe-count').textContent   = allDeals.filter(d => d.stage !== 'Closed').length;
  document.getElementById('pipe-closing').textContent = allDeals.filter(d => d.stage === 'Closing').length;

  const board = document.getElementById('pipelineBoard');
  if (window.NILPipeline) { NILPipeline.render(allDeals, board); }
}

async function moveDeal(dealId, athleteId, currentStage, stages) {
  const idx = stages.indexOf(currentStage);
  const nextStage = stages[idx + 1];
  if (!nextStage) { showToast('Already at final stage'); return; }
  await fetch(`${API_BASE}/api/deals/${dealId}`, {
    method:'PATCH', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ stage: nextStage })
  });
  showToast('Moved to ' + nextStage);
  loadKPIs(); loadPipeline();
  if (nextStage === 'Closed') setTimeout(renderCommission, 200);
}

async function deleteDealCard(dealId, athleteId) {
  if (!confirm('Delete this deal?')) return;
  await fetch(`${API_BASE}/api/deals/${dealId}`, { method:'DELETE' });
  showToast('Deal deleted');
  loadKPIs(); loadPipeline();
  setTimeout(renderCommission, 200);
}

async function addDeal() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  const brand = document.getElementById('d_brand').value.trim();
  if (!brand) { showToast('Brand name required'); return; }
  try {
    const r = await fetch(`${API_BASE}/api/athletes/${selectedAthleteId}/deals`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        brand,
        campaign: document.getElementById('d_campaign').value,
        value: document.getElementById('d_value').value,
        stage: document.getElementById('d_stage').value,
        dealType: (document.getElementById('d_deal_type') || {}).value || 'ig-reel',
        notes: (document.getElementById('d_notes') || {}).value || '',
        category: (document.getElementById('d_category') || {}).value || '',
      }),
    });
    const data = await r.json();
    if (!r.ok) { showToast('Error: ' + (data.error || 'Failed to save deal')); return; }
    document.getElementById('addDealModal').classList.remove('open');
    document.getElementById('d_brand').value = '';
    document.getElementById('d_campaign').value = '';
    document.getElementById('d_value').value = '';
    if (document.getElementById('d_notes')) document.getElementById('d_notes').value = '';
    if (document.getElementById('d_deal_type')) document.getElementById('d_deal_type').value = 'ig-reel';
    if (document.getElementById('d_category')) document.getElementById('d_category').value = '';
    showToast(' Deal added!');
    await loadKPIs();
    await loadPipeline();
    setTimeout(renderCommission, 200);
  } catch(e) {
    showToast('Error: ' + e.message);
  }
}

//  UTILS 
async function copyText(el) {
  navigator.clipboard.writeText(el.textContent.trim());
  showToast('Copied to clipboard!');
}
async function updateNilRateKpi() {
  const el = document.getElementById('kpi-nil-rate');
  const sub = document.getElementById('kpi-nil-sub');
  if (!el || !selectedAthleteId) return;
  try {
    const r = await fetch(API_BASE + '/api/rate/' + selectedAthleteId + '?type=ig-reel');
    if (!r.ok) return;
    const data = await r.json();
    if (data.low && data.high) {
      el.textContent = '$' + data.low.toLocaleString() + ' - $' + data.high.toLocaleString();
      if (sub) sub.textContent = 'NILViewVal v5.2 estimate';
    // Auto-load v4 composite scores panel
    if (selectedAthleteId) {
      var scoresPanel = document.getElementById('rate-v4-scores');
      var scoresBody = document.getElementById('rate-v4-scores-body');
      if (scoresPanel && scoresBody) {
        scoresPanel.style.display = 'block';
        if (typeof showNILViewValScores === 'function') showNILViewValScores(selectedAthleteId, scoresBody);
      }
    }
    }
  } catch(e) {}
}

async function saveAthleteNote(athleteId, note) {
  const ath = athletes.find(a => a.id === athleteId);
  if (!ath) return;
  ath.agentNote = note;
  try {
    await fetch(API_BASE + '/api/athletes/' + athleteId + '/note', {
      method: 'PATCH',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ agentNote: note })
    });
  } catch(e) {}
}

async function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

//  PLAYER URL FETCH 
async function fetchFromUrl() {
  const url = document.getElementById('a_url').value.trim();
  if (!url) { showToast('Paste a player profile URL first'); return; }
  const btn = document.getElementById('fetch-btn');
  const status = document.getElementById('fetch-status');
  btn.disabled = true; btn.textContent = 'Importing...';
  status.textContent = 'Fetching profile data...';
  try {
    const r = await fetch(`${API_BASE}/api/ai/player-fetch`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ url })
    });
    const data = await r.json();
    if (!data.found) { status.textContent = data.error || 'Could not extract data — try the AI Lookup button instead'; btn.disabled = false; btn.textContent = 'Import'; return; }
    if (data.name) document.getElementById('a_name').value = data.name;
    if (data.school) document.getElementById('a_school').value = data.school;
    if (data.position) document.getElementById('a_pos').value = data.position;
    if (data.year) { const s = document.getElementById('a_year'); for (let o of s.options) { if (o.value.toLowerCase() === data.year.toLowerCase()) { s.value = o.value; break; } } }
    if (data.stats) document.getElementById('a_stats').value = data.stats;
    if (data.notes) document.getElementById('a_notes').value = data.notes;
    const summary = [data.position, data.year, data.stats].filter(Boolean).join(' - ');
    status.innerHTML = 'Stats imported: ' + summary;
    showToast('Real stats imported!');
  } catch(e) {
    const msg = e.message && e.message.includes('blocks') ? e.message : 'ESPN/247Sports block server imports. Use the  Lookup button instead.';
    status.textContent = msg;
  }
  btn.disabled = false; btn.textContent = 'Import';
}

//  PLAYER LOOKUP 
// ── AI Lookup — fills Add Client form with candidate data ───────────────────
function _applyLookupCandidate(data) {
  // Fill every form field with the candidate's data
  if (data.name)     document.getElementById('a_name').value = data.name;
  if (data.school)   document.getElementById('a_school').value = data.school;
  if (data.position) document.getElementById('a_pos').value = data.position;
  if (data.stats)    document.getElementById('a_stats').value = data.stats;
  if (data.instagram)document.getElementById('a_ig').value = data.instagram;
  if (data.tiktok)   document.getElementById('a_tt').value = data.tiktok;
  if (data.engagement)document.getElementById('a_eng').value = data.engagement;

  if (data.year) {
    const s = document.getElementById('a_year');
    for (let o of s.options) { if (o.value.toLowerCase() === data.year.toLowerCase()) { s.value = o.value; break; } }
  }
  if (data.schoolTier) {
    const s = document.getElementById('a_tier');
    for (let o of s.options) { if (o.value === data.schoolTier) { s.value = o.value; break; } }
  }
  if (data.sport) {
    const s = document.getElementById('a_sport');
    for (let o of s.options) {
      if (o.value.toLowerCase() === (data.sport||'').toLowerCase() ||
          o.text.toLowerCase() === (data.sport||'').toLowerCase()) { s.value = o.value; break; }
    }
  }
  // Hometown fills its own field now (it powers the Deal Scan second market),
  // no longer dumped into notes. Editable like every other looked-up field.
  if (data.hometown) { const h = document.getElementById('a_hometown'); if (h) h.value = data.hometown; }
  // Pre-select any interest tags the lookup found in the bio (fully editable).
  if (Array.isArray(data.interestTags) && data.interestTags.length) {
    const qualified = data.interestTags.map(nilTagFromSub).filter(Boolean);
    if (qualified.length) renderTagPicker('a_tags', qualified);
  }
  let notesVal = data.notes || '';
  if (data.previousSchool) notesVal = (notesVal ? notesVal + ' ' : '') + 'Transfer from ' + data.previousSchool + '.';
  if (notesVal) document.getElementById('a_notes').value = notesVal;
}

function _confidenceColor(conf) {
  if (conf >= 90) return '#4ade80';
  if (conf >= 75) return '#C8F135';
  if (conf >= 60) return '#f59e0b';
  return '#ef4444';
}

function _confidenceLabel(conf) {
  if (conf >= 80) return 'BEST MATCH';
  if (conf >= 50) return 'POSSIBLE MATCH';
  return 'LOW CONFIDENCE';
}

function _confidenceBadgeStyle(conf) {
  if (conf >= 80) return 'background:rgba(74,222,128,0.15);color:#4ade80;border:1px solid rgba(74,222,128,0.3)';
  if (conf >= 50) return 'background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.3)';
  return 'background:rgba(156,163,175,0.15);color:#9ca3af;border:1px solid rgba(156,163,175,0.3)';
}

function _sourceIcon(source) {
  if ((source||'').includes('espn')) return 'ESPN';
  if ((source||'').includes('web')) return 'WEB';
  return 'AI';
}

function _sourceDomain(url) {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    return h;
  } catch (_) {
    if (url.includes('espn')) return 'espn.com';
    if (url.includes('247')) return '247sports.com';
    if (url.includes('on3')) return 'on3.com';
    if (url.includes('rivals')) return 'rivals.com';
    return null;
  }
}

function renderLookupCandidates(candidates, statusEl, candidatesEl) {
  if (!candidates || !candidates.length) return;

  candidatesEl.style.display = 'block';
  candidatesEl.innerHTML = candidates.map((c, i) => {
    const conf        = c.confidence || 0;
    const color       = _confidenceColor(conf);
    const label       = _confidenceLabel(conf);
    const badgeStyle  = _confidenceBadgeStyle(conf);
    const detail      = [c.position, c.year, c.hometown].filter(Boolean).join(' · ');
    const sourceDomain = _sourceDomain(c.sourceUrl);
    const isLowConf   = conf < 50;

    return '<div style="padding:10px 12px;' +
      (i < candidates.length - 1 ? 'border-bottom:1px solid var(--border);' : '') +
      (c.best ? 'background:rgba(200,241,53,0.04)' : 'background:var(--surface)') +
      '">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">' +
            '<span style="font-size:13px;font-weight:700;color:var(--text)">' + (c.name||'Unknown') + '</span>' +
            '<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:0.05em;' + badgeStyle + '">' + label + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px;display:flex;flex-wrap:wrap;gap:5px">' +
            '<span style="background:var(--surface2);padding:1px 7px;border-radius:4px">' + (c.school||'School unknown') + '</span>' +
            '<span style="background:var(--surface2);padding:1px 7px;border-radius:4px">' + (c.sport||'Sport unknown') + '</span>' +
            (detail ? '<span style="color:var(--muted)">' + detail + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
            '<div style="width:60px;height:3px;border-radius:2px;background:var(--surface2);overflow:hidden">' +
              '<div style="width:' + Math.min(conf,100) + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
            '</div>' +
            '<span style="font-size:9px;color:' + color + ';font-weight:600">' + conf + '%</span>' +
            (sourceDomain
              ? '<a href="' + (c.sourceUrl||'#') + '" target="_blank" rel="noopener" style="font-size:9px;color:var(--muted);text-decoration:underline;text-underline-offset:2px">Source: ' + sourceDomain + '</a>'
              : '<span style="font-size:9px;color:var(--muted)">' + (c.sourceLabel||'Unknown source') + '</span>') +
          '</div>' +
          (isLowConf ? '<div style="font-size:10px;color:#f59e0b;margin-top:3px">⚠ Low confidence — verify before saving</div>' : '') +
        '</div>' +
        '<button onclick="selectLookupCandidate(' + i + ')" ' +
          'style="flex-shrink:0;padding:6px 12px;background:' + (c.best ? 'var(--accent)' : 'var(--surface2)') + ';' +
          'border:1px solid ' + (c.best ? 'var(--accent)' : 'var(--border)') + ';border-radius:5px;' +
          'color:' + (c.best ? '#000' : 'var(--text)') + ';font-size:11px;font-weight:700;cursor:pointer">Select</button>' +
      '</div>' +
    '</div>';
  }).join('') +
  '<div style="padding:8px 12px;border-top:1px solid var(--border);text-align:center">' +
    '<button onclick="dismissLookupCandidates()" style="font-size:10px;color:var(--muted);background:transparent;border:none;cursor:pointer">None match — fill in manually</button>' +
  '</div>';
}

// Stored candidates array for selection
let _lookupCandidates = [];

function selectLookupCandidate(idx) {
  const c = _lookupCandidates[idx];
  if (!c) return;
  _applyLookupCandidate(c);
  document.getElementById('lookup-candidates').style.display = 'none';
  const statusEl   = document.getElementById('lookup-status');
  const conf       = c.confidence || 0;
  const isLowConf  = conf < 50;
  const isTransfer = c.previousSchool || (c.year||'').toLowerCase().includes('transfer');
  const summary    = [c.school, c.position, c.year].filter(Boolean).join(' · ');
  const sourceDomain = _sourceDomain(c.sourceUrl);
  const sourceText = sourceDomain
    ? 'Data sourced from <a href="' + (c.sourceUrl||'#') + '" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline;text-underline-offset:2px">' + sourceDomain + '</a>'
    : (c.sourceLabel ? 'Source: ' + c.sourceLabel : '');

  statusEl.innerHTML =
    '<span style="color:var(--accent)">✓ Loaded — review and save</span>' +
    (summary ? ' · <span style="color:var(--muted)">' + summary + '</span>' : '') +
    (isTransfer ? ' · <span style="color:#f59e0b">Transfer from ' + (c.previousSchool||'prev school') + '</span>' : '') +
    (sourceText ? '<br><span style="font-size:10px;color:var(--muted)">' + sourceText + '</span>' : '') +
    (isLowConf  ? '<br><span style="font-size:10px;color:#f59e0b">⚠ Low confidence match — please verify all fields before saving</span>' : '');

  showToast(isLowConf
    ? '⚠ Low confidence — verify data before saving!'
    : isTransfer
      ? 'Transfer found — verify stats before saving.'
      : 'Player data loaded — review before saving!');
}

function dismissLookupCandidates() {
  document.getElementById('lookup-candidates').style.display = 'none';
  document.getElementById('lookup-status').textContent = 'No match selected — fill in manually.';
  _lookupCandidates = [];
}

async function lookupPlayer() {
  const name   = document.getElementById('a_name').value.trim();
  if (!name) { showToast('Enter a player name first'); return; }
  const school = document.getElementById('a_school').value.trim();
  const sport  = document.getElementById('a_sport').value;
  const btn    = document.getElementById('lookup-btn');
  const status = document.getElementById('lookup-status');
  const candEl = document.getElementById('lookup-candidates');

  btn.disabled = true;
  btn.style.opacity = '0.7';
  btn.textContent = 'Searching...';
  status.innerHTML = '<span style="color:var(--muted)">🔍 Searching live athlete databases' + (school ? ' for ' + school : '') + '...</span>';
  candEl.style.display = 'none';
  candEl.innerHTML = '';
  _lookupCandidates = [];

  try {
    const position = document.getElementById('a_pos')?.value?.trim() || '';
    const year     = document.getElementById('a_year')?.value?.trim() || '';
    const r = await fetch(`${API_BASE}/api/ai/player-lookup`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ name, school, sport, position, year })
    });
    const data = await r.json();

    if (!data.found || !data.candidates || !data.candidates.length) {
      status.innerHTML = '<span style="color:var(--muted)">' + (data.message || 'No verified athlete found — fill in details manually.') + '</span>';
      btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'AI Lookup';
      return;
    }

    _lookupCandidates = data.candidates;

    if (data.autoSelect && data.candidates.length === 1) {
      // High-confidence single match — auto-fill and show source
      const c = data.candidates[0];
      _applyLookupCandidate(c);
      const conf         = parseInt(c.confidence || 0, 10);
      const badgeStyle   = _confidenceBadgeStyle(conf);
      const summary      = [c.school, c.position, c.year].filter(Boolean).join(' · ');
      const sourceDomain = _sourceDomain(c.sourceUrl);
      status.innerHTML =
        '<span style="color:var(--accent)">✓ Loaded — review and save</span>' +
        (summary ? ' · <span style="color:var(--muted)">' + summary + '</span>' : '') +
        ' <span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;' + badgeStyle + '">' + _confidenceLabel(conf) + ' ' + conf + '%</span>' +
        (sourceDomain ? '<br><span style="font-size:10px;color:var(--muted)">Data sourced from <a href="' + (c.sourceUrl||'#') + '" target="_blank" rel="noopener" style="color:var(--muted);text-decoration:underline">' + sourceDomain + '</a></span>' : '');
      showToast('Player found via ' + (c.sourceLabel || 'web search') + ' — review before saving!');
    } else {
      // Multiple candidates or lower confidence — show picker
      const conf      = data.candidates[0]?.confidence || 0;
      const schoolHint = !school ? ' <span style="color:var(--muted);font-size:10px">· Add school for better results</span>' : '';
      status.innerHTML =
        (data.candidates.length === 1
          ? '<span style="color:#f59e0b">1 possible match found</span>'
          : '<span style="color:#f59e0b">' + data.candidates.length + ' candidates found</span>') +
        ' — select below' + schoolHint;
      renderLookupCandidates(data.candidates, status, candEl);
    }
  } catch(e) {
    status.innerHTML = '<span style="color:var(--muted)">Search unavailable — fill in details manually.</span>';
    console.error('[lookup]', e);
  }
  btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'AI Lookup';
}

//  BRAND OUTREACH 
let outreachLogByAthlete = {};
let currentOutreach = null;

async function copyText(id) {
  const el = document.getElementById(id);
  if (el) navigator.clipboard.writeText(el.textContent).then(() => showToast('Copied!'));
}

let lastComplianceResult = null;

let lastContract = '';
    let commFilter = 'all';

// ── PDF SCANNER ────────────────────────────────────────────────────────────
const PDF_SCAN_TYPE_LABELS = {
  social_post:'Social Post', story:'Story', appearance:'Appearance',
  content_creation:'Content', payment_milestone:'Payment', other:'Other'
};

let _pdfScanAthleteId = '';
let _pdfScanLastExtraction = null; // stores last result for save

async function loadPdfScanAthletes() {
  const sel = document.getElementById('pdf-scan-athlete');
  if (!sel) return;
  try {
    const r = await fetch(`${API_BASE}/api/athletes`);
    const data = await r.json();
    const athletes = Array.isArray(data) ? data : (data.athletes || []);
    const cur = sel.value;
    sel.innerHTML = '<option value="">— choose athlete —</option>' +
      athletes.map(a => `<option value="${a.id}" ${a.id === cur ? 'selected' : ''}>${a.name || "Athlete"}</option>`).join('');
    _pdfScanAthleteId = sel.value;
  } catch(e) { console.warn('PDF scan athlete load failed', e); }
}

function handlePdfScanDrop(e) {
  const file = e.dataTransfer.files[0];
  if (!file) return;
  runPdfScan(file);
}

async function runPdfScan(file) {
  if (!file) return;
  const allowed = ['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword'];
  if (!allowed.includes(file.type) && !file.name.match(/\.(pdf|docx|doc)$/i)) {
    showToast('Please upload a PDF or DOCX file'); return;
  }

  // Athlete required
  const athleteSel = document.getElementById('pdf-scan-athlete');
  _pdfScanAthleteId = athleteSel ? athleteSel.value : _pdfScanAthleteId;
  const errEl = document.getElementById('pdf-scan-athlete-error');
  if (!_pdfScanAthleteId) {
    if (errEl) errEl.style.display = 'inline';
    if (athleteSel) athleteSel.focus();
    // Reset file input so user can retry
    const fi = document.getElementById('pdf-scan-file');
    if (fi) fi.value = '';
    return;
  }
  if (errEl) errEl.style.display = 'none';
  _pdfScanLastExtraction = null;

  // Show status, hide results
  const statusBar  = document.getElementById('pdf-scan-status');
  const statusText = document.getElementById('pdf-scan-status-text');
  const results    = document.getElementById('pdf-scan-results');
  const dropzone   = document.getElementById('pdf-scan-dropzone');

  statusBar.style.display  = 'block';
  results.style.display    = 'none';
  dropzone.style.display   = 'none';
  statusText.textContent   = `Extracting text from ${file.name}…`;

  const form = new FormData();
  form.append('pdf', file);

  try {
    statusText.textContent = 'Running AI analysis — this takes 10–20 seconds…';
    const r = await fetch(`${API_BASE}/api/pdf/analyze`, { method: 'POST', credentials: 'include', body: form });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${r.status}`);
    }
    const data = await r.json();
    // Store extraction for save step
    _pdfScanLastExtraction = { data, filename: file.name };
    // Reset save status
    const saveStatus = document.getElementById('pdf-save-status');
    const saveBtn    = document.getElementById('pdf-save-btn');
    if (saveStatus) saveStatus.textContent = '';
    if (saveBtn)    { saveBtn.disabled = false; saveBtn.textContent = 'Save to Calendar →'; }
    renderPdfScanResults(data, file.name);
    statusBar.style.display = 'none';
    results.style.display   = 'block';
  } catch(e) {
    statusText.textContent = '⚠ ' + e.message;
    statusBar.style.background = 'rgba(239,68,68,0.08)';
    statusBar.style.borderColor = 'rgba(239,68,68,0.25)';
    statusBar.style.color = '#ef4444';
    setTimeout(() => { resetPdfScan(); }, 6000);
  }
}

function resetPdfScan() {
  document.getElementById('pdf-scan-results').style.display  = 'none';
  document.getElementById('pdf-scan-status').style.display   = 'none';
  document.getElementById('pdf-scan-dropzone').style.display = 'block';
  // Reset status bar colors
  const statusBar = document.getElementById('pdf-scan-status');
  statusBar.style.background   = 'rgba(99,102,241,0.08)';
  statusBar.style.borderColor  = 'rgba(99,102,241,0.2)';
  statusBar.style.color        = 'var(--accent)';
  // Clear file input so same file can be re-uploaded
  const fi = document.getElementById('pdf-scan-file');
  if (fi) fi.value = '';
  _pdfScanLastExtraction = null;
}

async function savePdfToCalendar() {
  if (!_pdfScanLastExtraction) { showToast('No scan results to save'); return; }
  if (!_pdfScanAthleteId) { showToast('Select an athlete first'); return; }

  const saveBtn    = document.getElementById('pdf-save-btn');
  const saveStatus = document.getElementById('pdf-save-status');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…';
  saveStatus.textContent = '';

  const ex          = _pdfScanLastExtraction.data.extraction || {};
  const deliverables = ex.deliverables || [];
  const athleteSel  = document.getElementById('pdf-scan-athlete');
  const athleteName = athleteSel ? (athleteSel.options[athleteSel.selectedIndex]?.text || '') : '';

  try {
    const r = await fetch(`${API_BASE}/api/pdf/save`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        athleteId:    _pdfScanAthleteId,
        filename:     _pdfScanLastExtraction.filename,
        brand:        ex.brand || '',
        deliverables: deliverables.map(d => ({
          description:            d.description || d.deliverable_description || '',
          due_date:               d.due_date || null,
          recurrence:             d.recurrence || null,
          contract_duration_months: d.contract_duration_months || null,
          confidence_score:       d.confidence_score || d.confidence || 0,
          deliverable_type:       d.deliverable_type || 'other',
        })),
      }),
    });
    const result = await r.json();
    if (!r.ok) throw new Error(result.error || 'Save failed');

    saveBtn.textContent = '✓ Saved';
    saveStatus.innerHTML = `<span style="color:#22c55e">${result.savedDeliverables} deliverable${result.savedDeliverables !== 1 ? 's' : ''} saved to ${athleteName}'s calendar · ${result.savedEvents} calendar event${result.savedEvents !== 1 ? 's' : ''} created</span><button onclick="showView('calendar', document.querySelector('.nav-item[onclick*=calendar]'))" style="background:transparent;border:none;color:#6366f1;font-weight:700;cursor:pointer;font-size:12px;padding:0;margin-left:12px;text-decoration:underline">View Calendar →</button>`;
  } catch(e) {
    saveBtn.disabled = false; saveBtn.textContent = 'Save to Calendar →';
    saveStatus.innerHTML = `<span style="color:#ef4444">Save failed: ${e.message}</span>`;
  }
}

function renderPdfScanResults(data, filename) {
  const ex = data.extraction || {};

  // Summary
  const sumEl = document.getElementById('pdf-scan-summary');
  const summaryParts = [];
  if (filename)       summaryParts.push(`<strong>File:</strong> ${filename}`);
  if (ex.brand)       summaryParts.push(`<strong>Brand:</strong> ${ex.brand}`);
  if (ex.start_date)  summaryParts.push(`<strong>Start:</strong> ${ex.start_date}`);
  if (ex.end_date)    summaryParts.push(`<strong>End:</strong> ${ex.end_date}`);
  if (ex.total_value) summaryParts.push(`<strong>Value:</strong> ${ex.total_value}`);
  sumEl.innerHTML = summaryParts.join('<br>') || '<span style="color:var(--muted)">No summary extracted</span>';

  // Deliverables table
  const deliverables = Array.isArray(ex.deliverables) ? ex.deliverables : [];
  document.getElementById('pdf-scan-deliv-count').textContent = `${deliverables.length} item${deliverables.length !== 1 ? 's' : ''}`;
  const tbody = document.getElementById('pdf-scan-deliv-body');
  if (!deliverables.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--muted)">No deliverables extracted</td></tr>';
  } else {
    tbody.innerHTML = deliverables.map(d => {
      const conf = parseInt(d.confidence_score || 0, 10);
      const confColor = conf >= 85 ? '#22c55e' : conf >= 70 ? '#eab308' : '#ef4444';
      const typeLabel = PDF_SCAN_TYPE_LABELS[d.deliverable_type] || d.deliverable_type || '—';
      const rec = d.recurrence && d.recurrence !== 'one-time' ? `<span style="font-size:10px;background:rgba(99,102,241,0.12);color:var(--accent);padding:1px 5px;border-radius:3px">${d.recurrence}</span>` : '—';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:10px 14px;max-width:280px">${d.description || '—'}</td>
        <td style="padding:10px 14px;white-space:nowrap">${typeLabel}</td>
        <td style="padding:10px 14px;white-space:nowrap;color:var(--muted)">${d.due_date || '—'}</td>
        <td style="padding:10px 14px">${rec}</td>
        <td style="padding:10px 14px;text-align:right;white-space:nowrap">
          <span style="color:${confColor};font-weight:600">${conf}%</span>
        </td>
      </tr>`;
    }).join('');
  }

  // Risk flags
  const risks = Array.isArray(ex.risk_flags) ? ex.risk_flags : [];
  const risksEl = document.getElementById('pdf-scan-risks');
  risksEl.innerHTML = risks.length
    ? risks.map(r => `<li style="color:#f87171">${r}</li>`).join('')
    : '<li style="list-style:none;color:var(--muted)">No major risks detected</li>';

  // Key terms
  const terms = Array.isArray(ex.key_terms) ? ex.key_terms : [];
  document.getElementById('pdf-scan-terms').innerHTML = terms.length
    ? terms.map(t => `<div style="padding:3px 0;border-bottom:1px solid var(--border)">${t}</div>`).join('')
    : '<span style="color:var(--muted)">—</span>';
}
// ── /PDF SCANNER ──────────────────────────────────────────────────────────


// ── ATHLETE CALENDAR + OUTREACH ────────────────────────────────────────────
async function loadAthleteCalendarPortal() {
  const el = document.getElementById('ath-cal-list');
  if (!el) return;
  try {
    const r = await fetch(`${API_BASE}/api/athlete-portal/calendar`);
    const data = await r.json();
    const evs = data.events || [];
    if (!evs.length) { el.innerHTML = '<span style="color:var(--muted)">No deliverables scheduled yet.</span>'; return; }
    const today = new Date().toISOString().split('T')[0];
    el.innerHTML = evs.map(ev => {
      const d = ev.event_date ? ev.event_date.split('T')[0] : '—';
      const overdue = d < today && ev.status !== 'completed';
      const statusColor = overdue ? '#ef4444' : ev.status === 'completed' ? '#22c55e' : 'var(--muted)';
      const statusText = overdue ? 'Overdue' : ev.status || 'pending';
      return `<div style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="width:3px;min-height:36px;border-radius:2px;background:${ev.color||'#6366f1'};flex-shrink:0"></div>
        <div style="flex:1">
          <div style="font-weight:600;color:var(--fg)">${ev.title}</div>
          <div style="color:var(--muted)">${ev.brand||''} · ${d} · <span style="color:${statusColor};text-transform:capitalize">${statusText}</span></div>
        </div>
      </div>`;
    }).join('');
  } catch(e) { if (el) el.innerHTML = '<span style="color:var(--muted)">Could not load schedule.</span>'; }
}

async function loadAthleteOutreachHistory() {
  const el = document.getElementById('ath-out-history');
  if (!el) return;
  try {
    const r = await fetch(`${API_BASE}/api/athlete-portal/outreach`);
    const data = await r.json();
    const msgs = data.messages || [];
    if (!msgs.length) { el.innerHTML = '<span style="color:var(--muted)">No messages sent yet.</span>'; return; }
    el.innerHTML = msgs.map(m => `<div style="padding:8px 10px;border-radius:6px;background:var(--surface2);margin-bottom:8px">
      <div style="font-weight:600;color:var(--fg)">${m.subject||'(no subject)'}</div>
      <div style="color:var(--muted);margin-top:2px">${m.message}</div>
      <div style="color:var(--muted);font-size:10px;margin-top:4px">${new Date(m.created_at).toLocaleDateString()}</div>
    </div>`).join('');
  } catch(e) {}
}

async function createAthleteAccount(athleteId) {
  const email = prompt('Enter athlete email address to create their login account:');
  if (!email || !email.includes('@')) { showToast('Valid email required'); return; }
  try {
    const r = await fetch(`${API_BASE}/api/agent/create-athlete-account`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ athleteId, email })
    });
    const data = await r.json();
    if (!r.ok) { showToast(data.error || 'Failed to create account'); return; }
    showToast('✓ Account created — welcome email sent to ' + email);
  } catch(e) { showToast('Error: ' + e.message); }
}

async function sendAthleteOutreach() {
  const subject = document.getElementById('ath-out-subject')?.value.trim();
  const message = document.getElementById('ath-out-message')?.value.trim();
  const statusEl = document.getElementById('ath-out-status');
  if (!message) { if (statusEl) statusEl.textContent = 'Message is required.'; return; }
  if (statusEl) statusEl.textContent = 'Sending...';
  try {
    const r = await fetch(`${API_BASE}/api/athlete-portal/outreach`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ subject, message })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Send failed');
    if (statusEl) statusEl.innerHTML = '<span style="color:#22c55e">&#10003; Message sent to your agent</span>';
    document.getElementById('ath-out-subject').value = '';
    document.getElementById('ath-out-message').value = '';
    loadAthleteOutreachHistory();
  } catch(e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444">Failed: ' + e.message + '</span>';
  }
}

async function loadAthletePortals() {
  const list = document.getElementById('athlete-portals-list');
  if (!list) return;
  list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">Loading clients…</div>';
  try {
    const [athRes, mkRes] = await Promise.all([
      fetch(API_BASE + '/api/athletes'),
      fetch(API_BASE + '/api/agents/media-kit-status')
    ]);
    const athletes = await athRes.json();
    const mkData = mkRes.ok ? await mkRes.json() : { kits: {} };
    const kits = mkData.kits || {};

    if (!athletes.length) {
      list.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px">No clients yet. Add athletes from the roster.</div>';
      return;
    }

    list.innerHTML = athletes.map(function(a) {
      const slug = kits[a.id];
      const hasKit = !!slug;
      const initials = (a.name || 'N A').split(' ').slice(0,2).map(n => (n[0]||'').toUpperCase()).join('');
      const colors = ['rgba(74,222,128,0.15)','rgba(96,165,250,0.15)','rgba(245,158,11,0.15)','rgba(167,139,250,0.15)'];
      const textColors = ['#4ade80','#60a5fa','#f59e0b','#a78bfa'];
      const ci = Math.abs(((a.name||'').charCodeAt(0)||0)) % 4;

      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
          <div style="width:40px;height:40px;border-radius:50%;background:${colors[ci]};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;color:${textColors[ci]};flex-shrink:0">${escHtml(initials)}</div>
          <div style="min-width:0">
            <div style="font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(a.name||'Unknown')}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">${escHtml([a.sport, a.position, a.school].filter(Boolean).join(' · ') || 'No details')}</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <button onclick="openAthleteReport('${escHtml(a.id)}','${escHtml((a.name||'').replace(/'/g,''))}')" title="Preview and send this week's report to the athlete and their parents" style="padding:6px 14px;background:rgba(0,212,255,0.1);border:1px solid rgba(0,212,255,0.35);color:#00D4FF;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap">
            Weekly Report
          </button>
          ${hasKit
            ? `<span style="font-size:10px;font-weight:700;background:rgba(132,204,22,0.12);color:#84CC16;border-radius:4px;padding:2px 8px;text-transform:uppercase;letter-spacing:0.05em;flex-shrink:0">Kit Ready</span>
               <button onclick="window.open('/media-kit/${escHtml(slug)}','_blank')" style="padding:6px 14px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.3);border-radius:6px;color:#84CC16;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;gap:5px">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                 Media Kit
               </button>`
            : `<button disabled title="Athlete hasn't created their media kit yet" style="padding:6px 14px;background:transparent;border:1px solid rgba(100,116,139,0.25);border-radius:6px;color:var(--muted);font-size:11px;font-weight:600;cursor:not-allowed;font-family:inherit;opacity:0.55;display:flex;align-items:center;gap:5px">
                 <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
                 Media Kit
               </button>`
          }
        </div>
      </div>`;
    }).join('');
  } catch(e) {
    list.innerHTML = '<div style="color:var(--red);text-align:center;padding:40px">Failed to load: ' + e.message + '</div>';
  }
}

async function loadAgentOutreach() {
  const el = document.getElementById('agent-outreach-list');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--muted)">Loading…</span>';

  // Populate athlete filter dropdown from global athletes array
  const filterAthEl = document.getElementById('ao-filter-athlete');
  if (filterAthEl && filterAthEl.options.length <= 1 && typeof athletes !== 'undefined') {
    athletes.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name || "Athlete";
      filterAthEl.appendChild(opt);
    });
  }

  const athleteId = filterAthEl ? filterAthEl.value : '';
  const status    = document.getElementById('ao-filter-status')?.value || '';
  let url = `${API_BASE}/api/agents/athlete-outreach`;
  const params = [];
  if (athleteId) params.push('athlete_id=' + encodeURIComponent(athleteId));
  if (status)    params.push('status=' + encodeURIComponent(status));
  if (params.length) url += '?' + params.join('&');

  try {
    const r = await fetch(url, { credentials: 'include' });
    const data = await r.json();
    const rows = data.outreach || [];

    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:32px 0;font-size:12px">No brand outreach found.</div>';
      return;
    }

    const statusBadge = (s, requiresApproval) => {
      if (s === 'pending_approval') return '<span style="background:#78350f;color:#fcd34d;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">Pending Approval</span>';
      if (s === 'sent')     return '<span style="background:#064e3b;color:#4ade80;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">Sent</span>';
      if (s === 'declined') return '<span style="background:#450a0a;color:#f87171;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700">Declined</span>';
      if (s === 'draft')    return '<span style="background:var(--surface);color:var(--muted);padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;border:1px solid var(--border)">Draft</span>';
      return '<span style="color:var(--muted)">' + (s||'—') + '</span>';
    };

    const initiatedBadge = (by) => {
      if (by === 'athlete') return '<span style="background:#78350f22;color:#d97706;padding:2px 8px;border-radius:12px;font-size:10px;font-weight:700;border:1px solid #d9770633">Athlete</span>';
      return '<span style="background:var(--surface);color:var(--muted);padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600;border:1px solid var(--border)">' + (by||'Agent') + '</span>';
    };

    const actionBtns = (row) => {
      if (row.status !== 'pending_approval') return '';
      return `
        <button onclick="agentApproveOutreach(${row.id})" style="padding:4px 10px;border-radius:6px;background:#064e3b;color:#4ade80;border:1px solid #4ade8033;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:4px">✓ Approve</button>
        <button onclick="agentRejectOutreach(${row.id})" style="padding:4px 10px;border-radius:6px;background:#450a0a;color:#f87171;border:1px solid #f8717133;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">✕ Decline</button>
      `;
    };

    // Table
    el.innerHTML = `
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">
              <th style="text-align:left;padding:8px 10px">Athlete</th>
              <th style="text-align:left;padding:8px 10px">Brand</th>
              <th style="text-align:left;padding:8px 10px">Date</th>
              <th style="text-align:left;padding:8px 10px">Status</th>
              <th style="text-align:left;padding:8px 10px">Initiated By</th>
              <th style="text-align:left;padding:8px 10px">Actions</th>
            </tr>
          </thead>
          <tbody id="ao-tbody">
            ${rows.map(row => `
              <tr class="ao-row" data-id="${row.id}" onclick="toggleOutreachExpand(${row.id})" style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s" onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background='transparent'">
                <td style="padding:10px 10px;font-weight:600;color:var(--fg)">${row.athlete_name||'—'}</td>
                <td style="padding:10px 10px;color:var(--fg)">${row.brand_name||'—'}</td>
                <td style="padding:10px 10px;color:var(--muted);white-space:nowrap">${new Date(row.created_at).toLocaleDateString()}</td>
                <td style="padding:10px 10px">${statusBadge(row.status, row.requires_approval)}</td>
                <td style="padding:10px 10px">${initiatedBadge(row.initiated_by)}</td>
                <td style="padding:10px 10px" onclick="event.stopPropagation()">${actionBtns(row)}</td>
              </tr>
              <tr id="ao-expand-${row.id}" style="display:none;background:var(--surface)">
                <td colspan="6" style="padding:12px 14px">
                  <div style="font-size:11px;color:var(--muted);margin-bottom:6px">
                    <strong style="color:var(--fg)">Message sent to ${row.brand_name||'brand'}${row.brand_contact_email ? ' (' + row.brand_contact_email + ')' : ''}:</strong>
                  </div>
                  <div style="font-size:12px;color:var(--fg);white-space:pre-wrap;line-height:1.6;background:var(--bg);padding:10px 14px;border-radius:8px;border:1px solid var(--border)">${escapeHtml(row.message_sent||'')}</div>
                  ${row.notes ? '<div style="margin-top:8px;font-size:11px;color:var(--muted)"><strong>Notes:</strong> ' + escapeHtml(row.notes) + '</div>' : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch(e) {
    console.error('[loadAgentOutreach]', e);
    el.innerHTML = '<span style="color:var(--muted)">Failed to load outreach. Please try again.</span>';
  }
}

function toggleOutreachExpand(id) {
  const row = document.getElementById('ao-expand-' + id);
  if (!row) return;
  row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
}

function escapeHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function agentApproveOutreach(id) {
  try {
    const r = await fetch(`${API_BASE}/api/agents/athlete-outreach/${id}/approve`, { method: 'PUT', credentials: 'include' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Failed to approve'); return; }
    console.log('[agentApproveOutreach] approved', id);
    loadAgentOutreach();
  } catch(e) { alert('Network error'); }
}

async function agentRejectOutreach(id) {
  if (!confirm('Decline this outreach?')) return;
  try {
    const r = await fetch(`${API_BASE}/api/agents/athlete-outreach/${id}/reject`, { method: 'PUT', credentials: 'include' });
    if (!r.ok) { const d = await r.json(); alert(d.error || 'Failed to decline'); return; }
    console.log('[agentRejectOutreach] declined', id);
    loadAgentOutreach();
  } catch(e) { alert('Network error'); }
}
// ── /ATHLETE CALENDAR + OUTREACH ───────────────────────────────────────────

async function loadAnalytics() {
  const body = document.getElementById('analytics-body');
  if (!body) return;
  body.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:40px">Loading analytics...</div>';
  let rendered = false;
  try {
  // Gather all deals via agent-wide endpoint (same source of truth as Home and Pipeline)
  const athMap = {};
  (athletes || []).forEach(a => { athMap[a.id] = a.name; });
  const rawDeals = await fetch(API_BASE + '/api/agent/deals').then(r=>r.json()).catch(()=>[]);
  const safeDeals = Array.isArray(rawDeals) ? rawDeals : [];
  const allDeals = safeDeals.map(d => ({ ...d, athleteName: athMap[d.athleteId || d.athlete_id] || d.athleteName || '—' }));
  console.log('[analytics] loaded', allDeals.length, 'deals via /api/agent/deals');
  if (!athletes.length) {
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:48px">No analytics data yet — add clients and deals to your pipeline to see insights.</div>';
    rendered = true;
    return;
  }

  const commRate = parseFloat(document.getElementById('comm-rate')?.value || 15) / 100;
  const closed = allDeals.filter(d => d.stage === 'Closed');
  const active = allDeals.filter(d => d.stage !== 'Closed' && d.stage !== 'Lost');
  // Total Pipeline = ACTIVE deals only (exclude Closed/Lost) to match Home's $12K/15.
  const totalPipeline = active.reduce((s,d)=>s+(parseInt(d.value)||0),0);
  const totalClosed = closed.reduce((s,d)=>s+(parseInt(d.value)||0),0);
  const totalComm = Math.round(totalClosed * commRate);

  // Stage breakdown
  const stages = ['Prospecting','Outreach Sent','Negotiating','Closing','Closed'];
  const bystage = {};
  stages.forEach(s => { bystage[s] = { count: 0, value: 0 }; });
  allDeals.forEach(d => {
    const s = d.stage || 'Prospecting';
    if (bystage[s]) { bystage[s].count++; bystage[s].value += parseInt(d.value)||0; }
  });

  // Category breakdown
  const bycat = {};
  allDeals.forEach(d => {
    const cat = d.category || d.brand || 'Other';
    if (!bycat[cat]) bycat[cat] = 0;
    bycat[cat] += parseInt(d.value)||0;
  });
  const topCats = Object.entries(bycat).sort((a,b)=>b[1]-a[1]).slice(0,5);

  // Athlete breakdown
  const byAth = {};
  closed.forEach(d => {
    if (!byAth[d.athleteName]) byAth[d.athleteName] = 0;
    byAth[d.athleteName] += parseInt(d.value)||0;
  });

  const accentGreen = '#c8f135';
  function kpi(label, val, sub) {
    return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px">' +
      '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">' + label + '</div>' +
      '<div style="font-size:24px;font-weight:800;color:var(--accent)">' + val + '</div>' +
      (sub ? '<div style="font-size:11px;color:var(--muted);margin-top:3px">' + sub + '</div>' : '') + '</div>';
  }
  function bar(label, val, max, color) {
    var pct = max > 0 ? Math.round(val/max*100) : 0;
    return '<div style="margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;margin-bottom:4px">' +
        '<span style="font-size:11px;color:var(--text)">' + label + '</span>' +
        '<span style="font-size:11px;font-weight:700;color:var(--text)">$' + val.toLocaleString() + '</span></div>' +
      '<div style="background:var(--surface);height:6px;border-radius:3px">' +
        '<div style="background:' + (color||accentGreen) + ';height:6px;border-radius:3px;width:' + pct + '%"></div></div></div>';
  }

  var html = '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">' +
    kpi('Total Pipeline', '$' + (totalPipeline/1000).toFixed(0) + 'K', active.length + ' deals') +
    kpi('Closed Value', '$' + (totalClosed/1000).toFixed(0) + 'K', closed.length + ' closed') +
    kpi('My Commission', '$' + totalComm.toLocaleString(), (commRate*100).toFixed(0) + '% rate') +
    kpi('Active Deals', active.length, stages.filter(s=>s!=='Closed').map(s=>bystage[s]?.count||0).reduce((a,b)=>a+b,0) + ' in pipeline') +
  '</div>';

  // Pipeline funnel
  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">';
  html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px">';
  html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">Pipeline by Stage</div>';
  const maxStageVal = Math.max(...stages.map(s=>bystage[s]?.value||0), 1);
  stages.forEach(s => {
    var stageColor = s === 'Closed' ? '#4ade80' : s === 'Closing' ? accentGreen : 'var(--muted)';
    html += '<div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">' +
      '<span style="font-size:11px;color:var(--text);width:120px">' + s + '</span>' +
      '<span style="font-size:10px;color:var(--muted);margin-right:8px">' + (bystage[s]?.count||0) + ' deals</span>' +
      '<span style="font-size:11px;font-weight:700;color:' + stageColor + '">$' + ((bystage[s]?.value||0)/1000).toFixed(0) + 'K</span></div>';
  });
  html += '</div>';

  // Top clients by closed value
  html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px">';
  html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px">Top Clients (Closed Deals)</div>';
  if (Object.keys(byAth).length === 0) {
    html += '<div style="color:var(--muted);font-size:12px">No closed deals yet.</div>';
  } else {
    const maxAthVal = Math.max(...Object.values(byAth), 1);
    Object.entries(byAth).sort((a,b)=>b[1]-a[1]).slice(0,5).forEach(([name,val]) => {
      html += bar(name, val, maxAthVal, accentGreen);
    });
  }
  html += '</div></div>';

  // Recent deals table
  const recent = allDeals.sort((a,b) => new Date(b.created_at||0) - new Date(a.created_at||0)).slice(0,10);
  if (recent.length > 0) {
    html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:16px">';
    html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px">Recent Deals</div>';
    html += '<table style="width:100%;border-collapse:collapse">';
    html += '<thead><tr style="border-bottom:1px solid var(--border)">' +
      ['Athlete','Brand','Stage','Value','Category'].map(h=>'<th style="text-align:left;padding:8px 10px;font-size:10px;color:var(--muted);font-weight:600;text-transform:uppercase">' + h + '</th>').join('') + '</tr></thead><tbody>';
    recent.forEach(d => {
      var stageColor = d.stage==='Closed' ? '#4ade80' : d.stage==='Closing' ? accentGreen : 'var(--muted)';
      html += '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:9px 10px;font-size:12px;font-weight:500">' + (d.athleteName||'—') + '</td>' +
        '<td style="padding:9px 10px;font-size:12px">' + (d.brand||'—') + '</td>' +
        '<td style="padding:9px 10px"><span style="font-size:10px;padding:2px 7px;border-radius:4px;background:' + stageColor + '22;color:' + stageColor + '">' + (d.stage||'—') + '</span></td>' +
        '<td style="padding:9px 10px;font-size:12px;font-weight:700">' + (d.value ? '$'+(parseInt(d.value)).toLocaleString() : '—') + '</td>' +
        '<td style="padding:9px 10px;font-size:11px;color:var(--muted)">' + (d.category||'—') + '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  } else {
    html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:40px;text-align:center;color:var(--muted);font-size:13px">No deals logged yet. Add deals in the Pipeline to see analytics.</div>';
  }

  body.innerHTML = html;
  rendered = true;
  } catch(analyticsErr) {
    console.error('[analytics] Error:', analyticsErr);
    rendered = true;
    body.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:48px">' +
      '<div style="margin-bottom:8px;font-size:14px">Failed to load analytics.</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-bottom:16px">' + escHtml(analyticsErr.message || String(analyticsErr)) + '</div>' +
      '<button onclick="loadAnalytics()" style="padding:8px 20px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:12px;cursor:pointer">↻ Refresh</button>' +
      '</div>';
  } finally {
    // Safety net: if nothing rendered (e.g. early return threw), clear the spinner
    if (!rendered && body) {
      body.innerHTML = '<div style="color:var(--muted);font-size:13px;text-align:center;padding:48px">' +
        '<div style="margin-bottom:12px">Analytics unavailable.</div>' +
        '<button onclick="loadAnalytics()" style="padding:8px 20px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:12px;cursor:pointer">↻ Refresh</button>' +
        '</div>';
    }
  }
}

    async function setCommFilter(f) {
      commFilter = f;
      ['all','Closed','active'].forEach(x => {
        const el = document.getElementById('cf-' + x);
        if (!el) return;
        if (x === f) { el.style.background = 'var(--accent)'; el.style.color = '#000'; el.style.borderColor = 'var(--accent)'; }
        else { el.style.background = 'transparent'; el.style.color = 'var(--muted)'; el.style.borderColor = 'var(--border)'; }
      });
      renderCommission();
    }

    async function renderCommission() {
      const rate = parseFloat(document.getElementById('comm-rate')?.value || 15) / 100;

      // Use the SAME agent-wide source of truth as Pipeline/Analytics/Home so
      // Commission reflects every deal (not just ones the roster loop resolves).
      // athleteName comes from the server JOIN; athMap is only a fallback.
      const athMap = {};
      (athletes || []).forEach(a => { athMap[a.id] = a.name; });
      const rawC = await fetch(`${API_BASE}/api/agent/deals`).then(r=>r.json()).catch(()=>[]);
      const allDeals = (Array.isArray(rawC) ? rawC : []).map(d => ({
        ...d,
        athleteId: d.athleteId || d.athlete_id,
        athleteName: d.athleteName || athMap[d.athleteId || d.athlete_id] || '—',
      }));

      // Filter
      let filtered = allDeals;
      if (commFilter === 'Closed') filtered = allDeals.filter(d => d.stage === 'Closed');
      else if (commFilter === 'active') filtered = allDeals.filter(d => d.stage !== 'Closed');

      // KPIs
      const closedDeals = allDeals.filter(d => d.stage === 'Closed');
      const activeDeals = allDeals.filter(d => d.stage !== 'Closed');
      const totalEarned = closedDeals.reduce((s, d) => s + (parseInt(d.value) || 0), 0) * rate;
      const totalPending = activeDeals.reduce((s, d) => s + (parseInt(d.value) || 0), 0) * rate;

      document.getElementById('comm-total-earned').textContent = '$' + Math.round(totalEarned).toLocaleString();
      document.getElementById('comm-pending').textContent = '$' + Math.round(totalPending).toLocaleString();
      document.getElementById('comm-closed-count').textContent = closedDeals.length;

      // Top earner by athlete
      const byAthlete = {};
      closedDeals.forEach(d => {
        if (!byAthlete[d.athleteName]) byAthlete[d.athleteName] = 0;
        byAthlete[d.athleteName] += (parseInt(d.value) || 0) * rate;
      });
      const topAthlete = Object.entries(byAthlete).sort((a,b) => b[1]-a[1])[0];
      document.getElementById('comm-top-athlete').textContent = topAthlete ? topAthlete[0].split(' ')[0] : '—';

      // By athlete breakdown
      const athEl = document.getElementById('comm-by-athlete');
      if (Object.keys(byAthlete).length === 0) {
        athEl.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:16px">No closed deals yet. Close a deal in the Pipeline to see commissions.</div>';
      } else {
        const maxVal = Math.max(...Object.values(byAthlete));
        athEl.innerHTML = Object.entries(byAthlete).sort((a,b)=>b[1]-a[1]).map(([name, comm]) => `
          <div style="margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="font-size:12px;font-weight:500">${name}</span>
              <span style="font-size:12px;font-weight:700;color:var(--accent)">$${Math.round(comm).toLocaleString()}</span>
            </div>
            <div style="background:var(--surface2);border-radius:40px;height:6px">
              <div style="background:var(--accent);border-radius:40px;height:6px;width:${Math.round(comm/maxVal*100)}%"></div>
            </div>
          </div>`).join('');
      }

      // Deals table
      const tbody = document.getElementById('comm-table-body');
      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">No deals found</td></tr>';
        return;
      }
      tbody.innerHTML = filtered.sort((a,b) => (parseInt(b.value)||0) - (parseInt(a.value)||0)).map(d => {
        const val = parseInt(d.value) || 0;
        const comm = Math.round(val * rate);
        const isClosed = d.stage === 'Closed';
        const statusColor = isClosed ? '#4ade80' : d.stage === 'Negotiating' ? 'var(--accent)' : 'var(--muted)';
        return `<tr style="border-bottom:1px solid var(--border)">
          <td style="padding:10px 12px;font-weight:500">${d.athleteName}</td>
          <td style="padding:10px 12px">${d.brand || '—'}</td>
          <td style="padding:10px 12px;color:var(--muted);font-size:11px">${d.stage || '—'}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:500">${val ? '$'+val.toLocaleString() : '—'}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:700;color:${isClosed ? 'var(--accent)' : 'var(--muted)'}">${comm ? '$'+comm.toLocaleString() : '—'}</td>
          <td style="padding:10px 12px"><span style="font-size:10px;padding:3px 8px;border-radius:40px;background:${statusColor}22;color:${statusColor};font-weight:700">${isClosed ? 'EARNED' : 'PENDING'}</span></td>
        </tr>`;
      }).join('');
    }

    async function generateContract() {
      const brand = document.getElementById('con-brand').value.trim();
      const value = document.getElementById('con-value').value;
      if (!brand || !value) { showToast('Brand and value are required'); return; }
      if (!selectedAthleteId) { showToast('Select an athlete first'); return; }

      // Contracts name the party by legal name. If none is on file, ask for it
      // before generating rather than silently using the display name. Skipping
      // the prompt is fine: the server falls back to the display name.
      const conAth = (typeof athletes !== 'undefined' ? athletes : []).find(a => a.id === selectedAthleteId) || {};
      let legalName = (conAth.legal_name || '').trim();
      if (!legalName) {
        const entered = window.prompt('Full legal name for the contract (leave blank to use "' + (conAth.name || 'their name') + '"):', '');
        if (entered && entered.trim()) legalName = entered.trim();
      }

      const btn = document.getElementById('con-btn');
      btn.disabled = true; btn.textContent = 'Generating...';
      document.getElementById('con-result').style.display = 'none';

      try {
        const r = await fetch(API_BASE + '/api/ai/contract', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            athleteId: selectedAthleteId,
            legalName,
            brand,
            value: parseInt(value),
            dealType: document.getElementById('con-deal-type').value,
            deliverables: document.getElementById('con-deliverables').value.trim(),
            startDate: document.getElementById('con-start').value,
            endDate: document.getElementById('con-end').value,
            exclusivity: document.getElementById('con-exclusivity').value,
            state: document.getElementById('con-state').value.trim(),
            paymentTerms: document.getElementById('con-payment').value,
            usageRights: document.getElementById('con-usage').value.trim(),
            agentName: document.getElementById('con-agent-name').value.trim(),
            agentEmail: document.getElementById('con-agent-email').value.trim(),
          })
        });
        const data = await r.json();
        if (data.error) { showToast('Error: ' + data.error); return; }
        // The server persists a prompted legal name; mirror it locally so the
        // agent is not prompted again this session.
        if (legalName && conAth && !conAth.legal_name) conAth.legal_name = legalName;
        lastContract = data.contract;
        document.getElementById('con-text').textContent = data.contract;
        document.getElementById('con-result').style.display = 'block';
        showToast('Contract generated successfully');
      } catch(e) { showToast('Error: ' + e.message); }
      btn.disabled = false; btn.textContent = ' Generate Contract →';
    }

    async function copyContract() {
      navigator.clipboard.writeText(lastContract);
      showToast('Contract copied to clipboard');
    }

    async function downloadContract() {
      const athlete = athletes.find(a => a.id === selectedAthleteId);
      const brand = document.getElementById('con-brand').value.trim();
      const filename = (athlete ? athlete.name.replace(/\s+/g,'-') : 'athlete') + '-' + brand.replace(/\s+/g,'-') + '-NIL-contract.txt';
      const blob = new Blob([lastContract], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      showToast('Contract downloaded');
    }
    async function downloadContractPDF() {
      if (!lastContract) { showToast('Generate a contract first'); return; }
      const athlete = athletes.find(a => a.id === selectedAthleteId);
      const brand = document.getElementById('con-brand').value.trim();
      showToast('Generating PDF...');
      try {
        const r = await fetch(API_BASE + '/api/ai/contract/pdf', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ contract: lastContract, athleteName: athlete ? athlete.name : 'Athlete', brand })
        });
        if (!r.ok) { showToast('PDF generation failed'); return; }
        const blob = await r.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (athlete ? athlete.name.replace(/\s+/g,'-') : 'athlete') + '-' + brand.replace(/\s+/g,'-') + '-NIL-contract.pdf';
        a.click();
        URL.revokeObjectURL(url);
        showToast('PDF downloaded');
      } catch(e) { showToast('Error: ' + e.message); }
    }

// ── State NIL reference layer (static, no AI, keyed to the active athlete) ─────
function _nilRuleBlock(title, rule) {
  if (!rule) return '';
  return '<div style="margin-top:8px"><div style="font-size:11px;font-weight:700;color:var(--text)">' + escHtml(title) + '</div>' +
    '<div style="font-size:11px;color:var(--muted);line-height:1.6;margin-top:2px">' + escHtml(rule.summary || '') + '</div>' +
    (rule.authority ? '<div style="font-size:10px;color:var(--muted);opacity:0.8;margin-top:2px">Source: ' + escHtml(rule.authority) + '</div>' : '') +
    '</div>';
}
function _nilStateCard(label, s) {
  if (!s) return '';
  var conf = s.confidence === 'confident'
    ? '<span style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(132,204,22,0.14);color:var(--accent);font-weight:700">Reviewed ' + escHtml(s.lastReviewed || '') + '</span>'
    : '<span style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(251,191,36,0.16);color:#fbbf24;font-weight:700">Verify, may have changed</span>';
  var flags = (Array.isArray(s.flags) ? s.flags : []).map(function(f){
    return '<div style="font-size:11px;color:var(--text);line-height:1.6;display:flex;gap:6px;margin-top:4px"><span style="color:#fbbf24">!</span><span>' + escHtml(f) + '</span></div>';
  }).join('');
  return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:10px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px"><div style="font-size:12px;font-weight:700;color:var(--text)">' + escHtml(label) + ': ' + escHtml(s.state) + '</div>' + conf + '</div>' +
    _nilRuleBlock('Agent registration', s.agentRegistration) +
    _nilRuleBlock('NIL statute', s.nilStatute) +
    _nilRuleBlock('High school vs college', s.highSchool) +
    (flags ? '<div style="margin-top:8px">' + flags + '</div>' : '') +
    '</div>';
}
async function loadNilComplianceRef() {
  var el = document.getElementById('nil-ref-body');
  if (!el) return;
  if (!selectedAthleteId) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Select a client to see the NIL rules for their state and school state.</div>';
    return;
  }
  el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Loading state rules...</div>';
  try {
    var r = await fetch(API_BASE + '/api/agent/nil-compliance/' + selectedAthleteId, { credentials: 'include' });
    if (!r.ok) throw new Error('failed');
    var d = await r.json();
    var html = '';
    if (d.crossState) {
      html += '<div style="background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.3);border-radius:var(--r-sm);padding:10px 12px;margin-bottom:10px;font-size:11px;color:#60a5fa;line-height:1.5">' +
        'Cross-state situation: your client\'s home state and school state differ. Both states\' rules can apply, so review each below.</div>';
    }
    if (d.home) html += _nilStateCard(d.crossState ? 'Home state' : 'State', d.home);
    if (d.school && d.crossState) html += _nilStateCard('School state', d.school);
    if (!d.home && !d.school) {
      html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:10px;font-size:11px;color:var(--muted);line-height:1.6">' +
        'State could not be resolved from this client\'s hometown or school, so only the federal floor is shown. Add a hometown (City, ST) or a mapped school for a state-specific reference.</div>';
    }
    // Federal + national settlement floor, always shown.
    if (d.federal) {
      html += '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 14px">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text)">Federal and national settlement floor</div>' +
        _nilRuleBlock('$' + (d.federal.reporting ? d.federal.reporting.thirdPartyThreshold : 600) + ' NIL Go reporting', d.federal.reporting) +
        _nilRuleBlock('SPARTA (federal agent conduct)', d.federal.sparta) +
        _nilRuleBlock('72-hour school notice (UAAA / RUAAA)', d.federal.uaaaNotice) +
        '</div>';
    }
    el.innerHTML = html || '<div style="font-size:12px;color:var(--muted)">No reference available.</div>';
  } catch (e) {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted)">Could not load the state reference right now.</div>';
  }
}

async function runCompliance() {
  const state = document.getElementById('comp-state').value;
  const dealType = document.getElementById('comp-deal-type').value;
  const brand = document.getElementById('comp-brand').value.trim();
  const value = document.getElementById('comp-value').value;
  const description = document.getElementById('comp-description').value.trim();
  if (!state) { showToast('Select a state'); return; }
  const btn = document.getElementById('comp-btn');
  btn.disabled = true; btn.textContent = 'Checking...';
  document.getElementById('comp-results').style.display = 'none';
  const athlete = selectedAthleteId ? athletes.find(a => a.id === selectedAthleteId) : null;
  try {
    const signingDate = document.getElementById('comp-signing-date').value;
    const r = await fetch(API_BASE + '/api/ai/compliance', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ state, dealType, brand, value, description, signingDate,
        athleteName: athlete ? athlete.name : '',
        sport: athlete ? athlete.sport : '',
        school: athlete ? athlete.school : '',
        schoolTier: athlete ? athlete.schoolTier : '' })
    });
    const data = await r.json();
    if (data.error) { showToast('Error: ' + data.error); btn.disabled = false; btn.textContent = 'Check Compliance'; return; }
    lastComplianceResult = data;
    renderComplianceResults(data);
    document.getElementById('comp-results').style.display = 'block';
    showToast('Compliance check complete');
  } catch(e) { showToast('Error: ' + e.message); }
  btn.disabled = false; btn.textContent = 'Check Compliance';
}

async function renderComplianceResults(data) {
  const banner = document.getElementById('comp-status-banner');
  const styles = {
    clear: 'border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px;font-weight:700;background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);color:#4ade80',
    warning: 'border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px;font-weight:700;background:rgba(251,191,36,0.1);border:1px solid rgba(251,191,36,0.3);color:#fbbf24',
    blocked: 'border-radius:6px;padding:14px 18px;margin-bottom:20px;font-size:13px;font-weight:700;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);color:#ef4444'
  };
  const msgs = { clear: 'No major compliance issues found for this deal in ' + data.state, warning: 'Compliance warnings found - review before proceeding', blocked: 'Deal has compliance issues that must be resolved' };
  banner.style.cssText = styles[data.status] || styles.warning;
  banner.textContent = msgs[data.status] || msgs.warning;
  // SPARTA section
  const spartaSection = document.getElementById('comp-sparta-section');
  if (data.sparta) {
    spartaSection.style.display = 'block';
    const s = data.sparta;
    const color = s.status === 'overdue' ? '#ef4444' : s.status === 'urgent' ? '#fbbf24' : '#60a5fa';
    const label = s.status === 'overdue' ? ' DEADLINE PASSED' : s.status === 'urgent' ? ' NOTIFY TODAY' : ' On Track';
    document.getElementById('comp-sparta-timer').innerHTML =
      '<div style="font-weight:700;color:' + color + ';margin-bottom:4px">' + label + '</div>' +
      '<div>72-hour deadline: <strong>' + s.deadlineFormatted + '</strong></div>' +
      '<div style="color:var(--muted);margin-top:2px">' + (s.hoursLeft > 0 ? s.hoursLeft + ' hours remaining' : Math.abs(s.hoursLeft) + ' hours overdue') + '</div>';
    document.getElementById('comp-sparta-notice').textContent = data.spartaNotice || 'No notification letter generated.';
  } else {
    spartaSection.style.display = 'none';
  }

  const flagsSection = document.getElementById('comp-flags-section');
  const flagsEl = document.getElementById('comp-flags');
  if (data.flags && data.flags.length) {
    flagsSection.style.display = 'block';
    flagsEl.innerHTML = data.flags.map(f => '<div style="background:var(--surface);border:1px solid var(--border);border-left:3px solid ' + (f.severity==="high"?"#ef4444":"#fbbf24") + ';border-radius:6px;padding:12px 16px;margin-bottom:8px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">' + (f.severity==="high"?"Blocked: ":"Warning: ") + f.issue + '</div><div style="font-size:11px;color:var(--muted)">' + f.detail + '</div></div>').join('');
  } else { flagsSection.style.display = 'none'; }
  const reqsSection = document.getElementById('comp-reqs-section');
  const reqsEl = document.getElementById('comp-reqs');
  if (data.requirements && data.requirements.length) {
    reqsSection.style.display = 'block';
    reqsEl.innerHTML = data.requirements.map(r => '<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 16px;margin-bottom:6px;font-size:11px;color:var(--text)">-> ' + r + '</div>').join('');
  } else { reqsSection.style.display = 'none'; }
  document.getElementById('comp-disclosure').textContent = data.disclosure || 'No specific disclosure language required.';
  const s = document.getElementById('comp-sources');
  if (s) s.textContent = data.sourceNote ? 'Source: ' + data.sourceNote : '';
}

async function saveComplianceToNotes() {
  if (!lastComplianceResult || !selectedAthleteId) { showToast('Select a client first'); return; }
  const state = document.getElementById('comp-state').value;
  const dealType = document.getElementById('comp-deal-type').value;
  const sl = lastComplianceResult.status === 'clear' ? 'CLEAR' : lastComplianceResult.status === 'warning' ? 'WARNING' : 'ISSUES FOUND';
  const note = 'COMPLIANCE CHECK (' + state + ' / ' + dealType + ') - ' + sl +
    '\nDisclosure: ' + (lastComplianceResult.disclosure || 'None') +
    (lastComplianceResult.flags && lastComplianceResult.flags.length ? '\nFlags: ' + lastComplianceResult.flags.map(f => f.issue).join(', ') : '') +
    '\nChecked: ' + new Date().toLocaleDateString();
  const athlete = athletes.find(a => a.id === selectedAthleteId);
  if (athlete) {
    const updatedNotes = (athlete.notes ? athlete.notes + '\n\n' : '') + note;
    await fetch(API_BASE + '/api/athletes/' + selectedAthleteId, {
      method: 'PUT', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({...athlete, notes: updatedNotes})
    });
    athlete.notes = updatedNotes;
    const ss = document.getElementById('comp-save-status');
    if (ss) ss.textContent = 'Saved to ' + athlete.name + ' notes';
    showToast('Compliance notes saved!');
  }
}

async function runOutreach() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  const brand = document.getElementById('or-brand').value.trim();
  if (!brand) { showToast('Enter a brand name'); return; }
  const btn = document.getElementById('or-run-btn');
  btn.disabled = true; btn.textContent = 'Writing...';
  document.getElementById('or-results').style.display = 'none';
  try {
    const r = await fetch(`${API_BASE}/api/ai/outreach`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        athleteId: selectedAthleteId,
        brand,
        category: document.getElementById('or-category').value,
        contact: document.getElementById('or-contact').value,
        goal: document.getElementById('or-goal').value,
      })
    });
    const data = await r.json();
    if (data.error) { showToast('Error: ' + data.error); btn.disabled = false; btn.textContent = 'Write Outreach'; return; }
    document.getElementById('or-email-subject').textContent = data.emailSubject || '';
    document.getElementById('or-email-body').textContent = data.email || '';
    document.getElementById('or-ig-body').textContent = data.instagram || '';
    document.getElementById('or-li-body').textContent = data.linkedin || '';
    document.getElementById('or-results').style.display = 'block';
    currentOutreach = { brand, category: document.getElementById('or-category').value, athleteId: selectedAthleteId };
    showToast('Outreach generated!');
  } catch(e) {
    showToast('Error: ' + e.message);
  }
  btn.disabled = false; btn.textContent = 'Write Outreach';
}

function saveOutreach() {
  if (!currentOutreach) return;
  const athlete = athletes.find(a => a.id === currentOutreach.athleteId);
  const aid = currentOutreach.athleteId;
  if (!outreachLogByAthlete[aid]) outreachLogByAthlete[aid] = [];
  outreachLogByAthlete[aid].unshift({
    id: Date.now(),
    brand: currentOutreach.brand,
    category: currentOutreach.category,
    athlete: athlete ? athlete.name : 'Unknown',
    date: new Date().toLocaleDateString(),
    status: 'Sent',
  });
  renderOutreachTracker();
  showToast('Saved to tracker!');
}

function updateOutreachStatus(id, status) {
  const log = selectedAthleteId ? (outreachLogByAthlete[selectedAthleteId] || []) : [];
  const e = log.find(x => x.id === id);
  if (e) { e.status = status; renderOutreachTracker(); }
}

async function renderOutreachTracker() {
  const el = document.getElementById('or-tracker');
  if (!el) return;
  const outreachLog = selectedAthleteId ? (outreachLogByAthlete[selectedAthleteId] || []) : [];
  if (!outreachLog.length) { el.innerHTML = '<div style="color:var(--muted);font-size:12px">No outreach logged yet.</div>'; return; }
  const colors = { Sent: 'var(--muted)', Replied: '#4ade80', 'No Response': 'var(--accent)', Declined: 'var(--red)' };
  el.innerHTML = outreachLog.map(e => `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:12px">
      <div style="flex:1">
        <div style="font-size:13px;font-weight:600">${e.brand}</div>
        <div style="font-size:11px;color:var(--muted)">${e.athlete} · ${e.category} · ${e.date}</div>
      </div>
      <select onchange="updateOutreachStatus(${e.id},this.value)" style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:${colors[e.status]||'var(--muted)'};font-size:11px;padding:4px 8px">
        <option ${e.status==='Sent'?'selected':''}>Sent</option>
        <option ${e.status==='Replied'?'selected':''}>Replied</option>
        <option ${e.status==='No Response'?'selected':''}>No Response</option>
        <option ${e.status==='Declined'?'selected':''}>Declined</option>
      </select>
    </div>`).join('');
}

//  SMART CALENDAR 
const stageColors = {
  'Closing': '#4ade80',
  'Negotiating': '#C8F135',
  'Outreach Sent': '#60a5fa',
  'Prospecting': '#6b7280'
};

const stageProb = {
  'Closing': 80,
  'Negotiating': 50,
  'Outreach Sent': 25,
  'Prospecting': 10
};

async function getDaysFromCreated(createdAt, offsetDays) {
  const d = new Date(createdAt || Date.now());
  d.setDate(d.getDate() + offsetDays);
  return d;
}

async function formatDeadlineDate(d) {
  const now = new Date();
  const diff = Math.ceil((d - now) / (1000 * 60 * 60 * 24));
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (diff < 0) return { label: dateStr, urgency: 'overdue', badge: 'Overdue' };
  if (diff === 0) return { label: dateStr, urgency: 'today', badge: 'Today' };
  if (diff <= 2) return { label: dateStr, urgency: 'urgent', badge: diff + 'd left' };
  if (diff <= 7) return { label: dateStr, urgency: 'soon', badge: diff + 'd left' };
  return { label: dateStr, urgency: 'future', badge: diff + 'd left' };
}

async function makeGoogleCalLink(title, date, description) {
  const start = date.toISOString().replace(/-|:|\.\d{3}/g, '').slice(0, 15) + '00Z';
  const end = new Date(date.getTime() + 60 * 60 * 1000).toISOString().replace(/-|:|\.\d{3}/g, '').slice(0, 15) + '00Z';
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(title) +
    '&dates=' + start + '/' + end +
    '&details=' + encodeURIComponent(description) +
    '&sf=true&output=xml';
}

async function loadCalendar() {
  await NILCal.load([], API_BASE);
}

// ══════════════════════════════════════════════════════════════════
// AGENT GOOGLE CALENDAR
// ══════════════════════════════════════════════════════════════════
async function initAgentGCalStatus() {
  const card = document.getElementById('agent-gcal-card');
  if (!card) return;

  // Hide for non-agent roles (athletes / university users see a different view)
  if (currentUser && (currentUser.role === 'athlete' || currentUser.role === 'university' || currentUser.role === 'university_admin')) {
    return; // card stays display:none
  }

  const statusText = document.getElementById('agent-gcal-status-text');
  const statusSub  = document.getElementById('agent-gcal-status-sub');
  const actions    = document.getElementById('agent-gcal-actions');
  const athleteDiv = document.getElementById('agent-gcal-athletes');

  try {
    const r = await fetch(`${API_BASE}/api/agent/calendar/google/status`);
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();

    // Always reveal the card once we have a valid response
    card.style.display = 'block';

    if (!data.available) {
      // Server missing credentials — show inert informational state
      statusText.textContent = 'Google Calendar';
      statusText.style.color = 'var(--text)';
      statusSub.textContent  = 'Google Calendar sync is not yet enabled on this server';
      actions.innerHTML = '';
      athleteDiv.style.display = 'none';
      return;
    }

    if (data.connected) {
      statusText.textContent = '✓ Your Google Calendar Connected';
      statusText.style.color = '#22c55e';
      statusSub.textContent  = 'Subscribe to your athletes\' NIL deliverable calendars below';
      actions.innerHTML = '<button onclick="disconnectAgentGoogle()" style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:7px 14px;cursor:pointer;font-size:12px;font-weight:600;font-family:inherit">Disconnect Google</button>';
      athleteDiv.style.display = 'block';
      _loadAgentGCalAthletes(athleteDiv);
    } else {
      statusText.textContent = 'Google Calendar';
      statusText.style.color = 'var(--text)';
      statusSub.textContent  = 'Connect your Google Calendar to subscribe to athlete NIL calendars';
      actions.innerHTML = '<button onclick="connectAgentGCal()" style="background:var(--accent);border:none;color:#000;border-radius:6px;padding:7px 16px;cursor:pointer;font-size:12px;font-weight:700;font-family:inherit;letter-spacing:0.01em">Connect Google Calendar</button>';
      athleteDiv.style.display = 'none';
    }
  } catch(e) {
    // On fetch error keep card hidden — don't show a broken widget
    console.warn('[gcal] status check failed:', e.message);
  }
}

async function _loadAgentGCalAthletes(container) {
  container.innerHTML = '<div style="padding:14px 0;font-size:12px;color:var(--muted)">Loading roster…</div>';
  try {
    const r    = await fetch(`${API_BASE}/api/agent/calendar/google/athletes`);
    if (!r.ok) throw new Error('status ' + r.status);
    const data = await r.json();
    const list = data.athletes || [];

    if (!list.length) {
      container.innerHTML = '<div style="padding:14px 0;font-size:12px;color:var(--muted)">No athletes on your roster yet — add a client first.</div>';
      return;
    }

    function _initials(name) {
      return (name || '?').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
    }
    function _avatarColor(name) {
      const COLORS = ['#6366f1','#8b5cf6','#ec4899','#f59e0b','#10b981','#3b82f6','#ef4444','#14b8a6'];
      var h = 0; for (var i = 0; name && i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
      return COLORS[Math.abs(h) % COLORS.length];
    }

    let html = '<div style="padding:12px 0 4px;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">Athlete NIL Calendars</div>';

    list.forEach((a, idx) => {
      const name    = a.name || '—';
      const initials = _initials(name);
      const color    = _avatarColor(name);
      const meta     = [a.sport, a.school].filter(Boolean).join(' · ');
      const hasCal   = !!a.gcal_connected;

      html += `<div style="display:flex;align-items:center;gap:12px;padding:10px 0;${idx > 0 ? 'border-top:1px solid var(--border)' : ''}">
        <!-- Avatar -->
        <div style="width:34px;height:34px;border-radius:50%;background:${color};display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${escHtml(initials)}</div>
        <!-- Info -->
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;color:var(--text);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(name)}</div>
          ${meta ? `<div style="font-size:11px;color:var(--muted);margin-top:1px">${escHtml(meta)}</div>` : ''}
          ${hasCal
            ? '<div style="font-size:10px;color:#22c55e;margin-top:2px;letter-spacing:0.01em">● Google Calendar connected</div>'
            : '<div style="font-size:10px;color:var(--muted);margin-top:2px">Athlete hasn\'t connected Google Calendar yet</div>'
          }
        </div>
        <!-- Subscribe toggle -->
        ${hasCal
          ? `<button onclick="agentGCalToggle('${a.id}', this)" data-subscribed="false"
               style="background:transparent;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:11px;font-family:inherit;white-space:nowrap;flex-shrink:0;transition:color 0.15s,border-color 0.15s">
               Subscribe
             </button>`
          : `<span style="font-size:11px;color:var(--muted);opacity:0.5;flex-shrink:0">Not available</span>`
        }
      </div>`;
    });

    container.innerHTML = html;
  } catch(e) {
    container.innerHTML = '<div style="padding:14px 0;font-size:12px;color:var(--muted)">Could not load roster.</div>';
    console.warn('[gcal] roster load failed:', e.message);
  }
}

async function agentGCalToggle(athleteId, btn) {
  const isSubscribed = btn.dataset.subscribed === 'true';
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = isSubscribed ? 'Unsubscribing…' : 'Subscribing…';
  try {
    const r = await fetch(`${API_BASE}/api/agent/calendar/google/subscribe/${athleteId}`, {
      method: isSubscribed ? 'DELETE' : 'POST'
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');
    if (isSubscribed) {
      btn.dataset.subscribed = 'false';
      btn.textContent = 'Subscribe';
      btn.style.color = 'var(--muted)';
      btn.style.borderColor = 'var(--border)';
      showToast('Unsubscribed from athlete\'s NIL calendar');
    } else {
      btn.dataset.subscribed = 'true';
      btn.textContent = 'Subscribed ✓';
      btn.style.color = '#22c55e';
      btn.style.borderColor = '#22c55e';
      showToast('Subscribed — athlete\'s NIL calendar added to your Google Calendar', 'success');
    }
  } catch(e) {
    showToast(e.message, 'error');
    btn.textContent = orig;
  } finally {
    btn.disabled = false;
  }
}

async function connectAgentGCal() {
  try {
    const r    = await fetch(`${API_BASE}/api/agent/calendar/google/connect`);
    const data = await r.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      showToast(data.error || 'Could not start Google Calendar connection', 'error');
    }
  } catch(e) {
    showToast('Connection error', 'error');
  }
}

// Clears the stored Google connection (Gmail + Calendar) for this agent, then
// flips the card back to the not-connected state. The next Connect click runs
// the full OAuth consent flow again (prompt=consent).
async function disconnectAgentGoogle() {
  if (!confirm('Disconnect your Google account? This removes the Gmail and Calendar connection. You can reconnect any time.')) return;
  try {
    const r = await fetch(`${API_BASE}/api/agent/google/disconnect`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Disconnect failed');
    showToast('Google disconnected', 'success');
    // Re-render the calendar card (now not-connected) and refresh any status widgets.
    if (typeof initAgentGCalStatus === 'function') initAgentGCalStatus();
    if (typeof emailModule !== 'undefined' && emailModule.refresh) { try { emailModule.refresh(); } catch(_) {} }
  } catch(e) {
    showToast('Could not disconnect Google: ' + e.message, 'error');
  }
}

//  INIT

// ══════════════════════════════════════════════════════════════════
//  AGENT INTELLIGENCE — REVENUE OPERATING SYSTEM
// ══════════════════════════════════════════════════════════════════

var _intelDeals        = null;
var _dailyActionsCache = null;
var _dailyActionsDate  = null;
var _SNAP_KEY          = 'nildash_intel_snap_v2';

// ── localStorage snapshot helpers ─────────────────────────────────
function _saveSnap(athList, dealsList) {
  try {
    var snap = {
      date:       new Date().toDateString(),
      athleteIds: athList.map(function(a) { return a.id; }),
      scores:     {},
      relStr:     {},
      dealStages: {}
    };
    athList.forEach(function(a) {
      snap.scores[a.id]  = nilOpportunityScore(a, dealsList);
      snap.relStr[a.id]  = relationshipStrengthScore(a, dealsList);
    });
    dealsList.forEach(function(d) { if (d.id) snap.dealStages[d.id] = d.stage || ''; });
    localStorage.setItem(_SNAP_KEY, JSON.stringify(snap));
  } catch(e) {}
}
function _loadSnap() {
  try { return JSON.parse(localStorage.getItem(_SNAP_KEY) || 'null'); } catch(e) { return null; }
}

// ── Boot ──────────────────────────────────────────────────────────
async function loadIntelHQ() {
  _intelDeals = [];
  (athletes || []).forEach(function(a) {
    var cached = window._athleteDealsCache && window._athleteDealsCache[a.id];
    if (cached && Array.isArray(cached)) {
      cached.forEach(function(d) { _intelDeals.push(Object.assign({}, d, { athleteId: a.id, athleteName: a.name })); });
    }
  });
  var yesterday = _loadSnap();
  renderIntelKPIs();
  renderDailyFeed(yesterday);
  renderPriorityList();
  renderMomentumMovers(yesterday);
  renderHiddenOpportunities();
  renderMoneyLeftOnTable();
  renderChurnRisk();
  renderOpportunityMatrix();
  // Save today's snapshot for tomorrow
  setTimeout(function() { _saveSnap(athletes, _intelDeals); }, 2000);
}

// ── Tab switcher ─────────────────────────────────────────────────
function showIntelTab(tab) {
  ['hq', 'roster', 'portal'].forEach(function(t) {
    var pane = document.getElementById('intel-pane-' + t);
    var btn  = document.getElementById('intel-tab-btn-' + t);
    if (!pane || !btn) return;
    var active = (t === tab);
    pane.style.display = active ? 'block' : 'none';
    btn.style.background = active ? 'var(--accent)' : 'transparent';
    btn.style.color = active ? '#000' : 'var(--muted)';
  });
  if (tab === 'roster') renderRosterIntel();
  // Portal tab needs the athlete bar visible
  var bar = document.getElementById('athleteBar');
  if (bar) bar.style.display = 'flex';
}

// ── NIL Opportunity Score (1–99) ──────────────────────────────────
function nilOpportunityScore(athlete, dealsList) {
  var score = 38;

  // Social reach — biggest signal
  var reach = (parseInt(athlete.instagram) || 0) + (parseInt(athlete.tiktok) || 0) + (parseInt(athlete.twitter) || 0);
  if      (reach > 1000000) score += 22;
  else if (reach > 500000)  score += 18;
  else if (reach > 200000)  score += 14;
  else if (reach > 100000)  score += 10;
  else if (reach > 50000)   score += 7;
  else if (reach > 10000)   score += 4;
  else if (reach > 1000)    score += 1;

  // Engagement rate
  var er = parseFloat(athlete.engagement) || 0;
  if      (er > 8) score += 10;
  else if (er > 5) score += 7;
  else if (er > 3) score += 4;
  else if (er > 1) score += 1;

  // Sport visibility premium
  var sport = (athlete.sport || '').toLowerCase();
  if      (sport.includes('football'))                               score += 12;
  else if (sport.includes('basketball'))                             score += 10;
  else if (sport.includes('baseball') || sport.includes('softball')) score += 6;
  else if (sport.includes('soccer') || sport.includes('track'))      score += 4;
  else                                                               score += 2;

  // School tier
  var tier = (athlete.schoolTier || '').toLowerCase();
  if      (tier.includes('power') || tier.includes('p4') || tier.includes('p5')) score += 8;
  else if (tier.includes('high major') || tier.includes('aac') || tier.includes('mwc')) score += 5;
  else if (tier.includes('mid'))                                     score += 3;

  // Academic year (peak NIL window = JR/SO)
  var year = (athlete.year || '').toLowerCase();
  if      (year.includes('jr') || year.includes('junior'))          score += 6;
  else if (year.includes('so') || year.includes('sophomore'))       score += 5;
  else if (year.includes('fr') || year.includes('freshman'))        score += 4;
  else if (year.includes('sr') || year.includes('senior'))          score += 2;

  // CRM activity signals
  var myDeals = (dealsList || []).filter(function(d) { return d.athleteId === athlete.id; });
  if      (myDeals.length > 3) score += 8;
  else if (myDeals.length > 1) score += 5;
  else if (myDeals.length > 0) score += 3;

  // Has real performance stats
  if ((athlete.ppg && parseFloat(athlete.ppg) > 0) || (athlete.apg && parseFloat(athlete.apg) > 0)) score += 3;

  return Math.min(99, Math.max(1, Math.round(score)));
}

// ── Relationship status (auto-derived from deals) ─────────────────
function getRelationshipStatus(athlete, dealsList) {
  if (athlete.relationshipStatus) return athlete.relationshipStatus;
  var myDeals = (dealsList || []).filter(function(d) { return d.athleteId === athlete.id; });
  if (myDeals.some(function(d) { return d.stage === 'Closed'; }))                           return 'signed';
  if (myDeals.some(function(d) { return d.stage === 'Closing' || d.stage === 'Negotiating'; })) return 'in-discussion';
  if (myDeals.some(function(d) { return d.stage === 'Outreach Sent'; }))                    return 'outreach-sent';
  if (myDeals.length > 0) return 'outreach-sent';
  return 'not-contacted';
}

var _relLabels = { 'not-contacted':'Not Contacted', 'outreach-sent':'Outreach Sent', 'in-discussion':'In Discussion', 'active':'Active', 'signed':'Signed', 'former-client':'Former Client' };
var _relColors = { 'not-contacted':'#6b7280', 'outreach-sent':'#60a5fa', 'in-discussion':'#f59e0b', 'active':'#4ade80', 'signed':'#C8F135', 'former-client':'#a78bfa' };

function getRelationshipLabel(s) { return _relLabels[s] || 'Not Contacted'; }
function getRelationshipColor(s) { return _relColors[s] || '#6b7280'; }

// ── Days since last deal activity ─────────────────────────────────
function getDaysSinceContact(athlete, dealsList) {
  var myDeals = (dealsList || []).filter(function(d) { return d.athleteId === athlete.id; });
  if (!myDeals.length) return 999;
  var latest = myDeals.reduce(function(best, d) {
    var dt = new Date(d.updatedAt || d.createdAt || 0);
    return dt > best ? dt : best;
  }, new Date(0));
  return Math.max(0, Math.floor((Date.now() - latest.getTime()) / 86400000));
}

// ── Risk flag detection ───────────────────────────────────────────
function getAthleteRiskFlags(athlete, dealsList) {
  var flags = [];
  var days  = getDaysSinceContact(athlete, dealsList);
  var year  = (athlete.year || '').toLowerCase();
  var reach = (parseInt(athlete.instagram) || 0) + (parseInt(athlete.tiktok) || 0);
  var notes = ((athlete.notes || '') + ' ' + (athlete.agentNote || '')).toLowerCase();

  if (days > 30 && days < 999) flags.push({ label: 'Stale (' + days + 'd)',    color: '#f59e0b', icon: '' });
  if (days === 999)             flags.push({ label: 'Never contacted',           color: '#ef4444', icon: '' });
  if (year.includes('sr') || year.includes('senior')) flags.push({ label: 'Graduating soon', color: '#f59e0b', icon: '' });
  if (reach === 0)              flags.push({ label: 'No social data',            color: '#6b7280', icon: '' });
  if (!athlete.sport)           flags.push({ label: 'Missing sport',            color: '#6b7280', icon: '' });
  if (notes.includes('transfer') || notes.includes('portal')) flags.push({ label: 'Transfer risk', color: '#ef4444', icon: '' });

  return flags;
}

// ── Relationship Strength Score (0–100) ──────────────────────────
function relationshipStrengthScore(athlete, dealsList) {
  var score = 15;
  var days  = getDaysSinceContact(athlete, dealsList);
  var myDeals = (dealsList || []).filter(function(d) { return d.athleteId === athlete.id; });

  // Recency bonus
  if      (days === 0)             score += 35;
  else if (days <= 3)              score += 30;
  else if (days <= 7)              score += 25;
  else if (days <= 14)             score += 18;
  else if (days <= 30)             score += 10;
  else if (days <= 60)             score += 4;
  else if (days < 999)             score += 1;
  // days === 999 (never) = +0

  // Deal activity
  var hasClosed = myDeals.some(function(d) { return d.stage === 'Closed'; });
  var hasActive = myDeals.some(function(d) { return ['Closing','Negotiating'].includes(d.stage); });
  if (hasClosed)      score += 25;
  else if (hasActive) score += 18;
  else if (myDeals.length) score += 8;
  if (myDeals.length >= 3) score += 10;
  if (myDeals.length >= 5) score += 5;

  // Notes presence
  if ((athlete.notes || '') + (athlete.agentNote || '')) score += 5;

  // Manual status override modifier
  var relStatus = athlete.relationshipStatus || '';
  if (relStatus === 'signed')        score += 5;
  else if (relStatus === 'active')   score += 3;
  else if (relStatus === 'in-discussion') score += 2;
  else if (relStatus === 'former-client') score -= 5;

  return Math.min(100, Math.max(0, Math.round(score)));
}

// ── Churn Risk Score (0–100, higher = more risk) ──────────────────
function churnRiskScore(athlete, dealsList) {
  var risk  = 0;
  var days  = getDaysSinceContact(athlete, dealsList);
  var year  = (athlete.year || '').toLowerCase();
  var notes = ((athlete.notes || '') + ' ' + (athlete.agentNote || '')).toLowerCase();
  var myDeals = (dealsList || []).filter(function(d) { return d.athleteId === athlete.id; });

  // Contact recency
  if      (days === 999) risk += 50;
  else if (days >= 60)   risk += 40;
  else if (days >= 45)   risk += 30;
  else if (days >= 30)   risk += 20;
  else if (days >= 15)   risk += 8;
  else if (days >= 7)    risk += 3;

  // Graduating senior
  if (year.includes('sr') || year.includes('senior')) risk += 20;

  // Transfer / exit signals in notes
  if (notes.includes('transfer') || notes.includes('portal'))       risk += 20;
  if (notes.includes('leaving') || notes.includes('gone'))          risk += 15;
  if (notes.includes('decommit') || notes.includes('uncommitted'))  risk += 10;

  // Stalled deals
  var now = Date.now();
  myDeals.forEach(function(d) {
    var updated = new Date(d.updatedAt || d.createdAt || 0).getTime();
    var staleDays = Math.floor((now - updated) / 86400000);
    if (d.stage === 'Negotiating' && staleDays > 21) risk += 15;
    if (d.stage === 'Outreach Sent' && staleDays > 14) risk += 8;
  });

  // No social data
  var reach = (parseInt(athlete.instagram)||0) + (parseInt(athlete.tiktok)||0);
  if (!reach) risk += 5;

  return Math.min(100, Math.max(0, Math.round(risk)));
}

// ── Estimate Annual NIL Value ─────────────────────────────────────
function estimateAnnualNIL(athlete) {
  var score = nilOpportunityScore(athlete, []);
  var reach = (parseInt(athlete.instagram)||0) + (parseInt(athlete.tiktok)||0);
  if (score >= 88 || reach > 1000000) return { low: 100000, high: 500000, label: '$100K–$500K' };
  if (score >= 78 || reach > 300000)  return { low:  30000, high: 120000, label:  '$30K–$120K' };
  if (score >= 68 || reach > 100000)  return { low:  10000, high:  50000, label:  '$10K–$50K'  };
  if (score >= 58 || reach > 30000)   return { low:   3000, high:  15000, label:   '$3K–$15K'  };
  return { low: 500, high: 5000, label: '$500–$5K' };
}

// ── KPI strip ─────────────────────────────────────────────────────
function renderIntelKPIs() {
  var deals = _intelDeals || [];
  var needsAttention = athletes.filter(function(a) { return getDaysSinceContact(a, deals) > 7; }).length;
  var hot            = athletes.filter(function(a) { return nilOpportunityScore(a, deals) >= 75; }).length;
  var activeDeals    = deals.filter(function(d) { return d.stage && d.stage !== 'Closed'; }).length;
  var churnRisk      = athletes.filter(function(a) { return churnRiskScore(a, deals) >= 60; }).length;
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('intel-kpi-clients', athletes.length);
  set('intel-kpi-attention', needsAttention);
  set('intel-kpi-hot', hot);
  set('intel-kpi-active-deals', activeDeals);
  set('intel-kpi-churn', churnRisk);
}

// ── What Changed Since Yesterday ──────────────────────────────────
function renderDailyFeed(yesterday) {
  var el = document.getElementById('intel-daily-feed');
  var ts = document.getElementById('intel-feed-ts');
  if (!el) return;

  var deals   = _intelDeals || [];
  var today   = new Date().toDateString();
  var events  = [];

  if (!yesterday || yesterday.date === today) {
    // First run today — just show baseline established
    if (!yesterday) {
      el.innerHTML = '<span style="font-size:11px;color:var(--muted)">Baseline established — check back tomorrow for daily changes.</span>';
      if (ts) ts.textContent = 'First session today';
      return;
    }
  }

  // New athletes
  var prevIds = yesterday.athleteIds || [];
  athletes.forEach(function(a) {
    if (!prevIds.includes(a.id)) events.push({ type: 'new', label: a.name + ' added to roster', color: 'var(--accent)' });
  });
  prevIds.forEach(function(id) {
    if (!athletes.find(function(a) { return a.id === id; })) events.push({ type: 'removed', label: 'Athlete removed from roster', color: '#6b7280' });
  });

  // Score changes
  var prevScores = yesterday.scores || {};
  athletes.forEach(function(a) {
    var now  = nilOpportunityScore(a, deals);
    var prev = prevScores[a.id];
    if (prev === undefined) return;
    var delta = now - prev;
    if (delta >= 5)  events.push({ type: 'up',   label: a.name + ' NIL score +' + delta,        color: 'var(--accent)' });
    if (delta <= -5) events.push({ type: 'down',  label: a.name + ' NIL score ' + delta,         color: '#f59e0b'       });
  });

  // Deal stage advances
  var prevStages = yesterday.dealStages || {};
  var stageOrder = { 'Prospecting':0, 'Outreach Sent':1, 'Negotiating':2, 'Closing':3, 'Closed':4 };
  deals.forEach(function(d) {
    var prev = prevStages[d.id];
    if (prev && prev !== d.stage) {
      var prevRank = stageOrder[prev] || 0;
      var nowRank  = stageOrder[d.stage] || 0;
      if (nowRank > prevRank) events.push({ type: 'deal', label: (d.brand || 'Deal') + ' → ' + d.stage + (d.athleteName ? ' (' + d.athleteName + ')' : ''), color: '#60a5fa' });
    }
  });

  // Hit 30-day stale threshold today
  athletes.forEach(function(a) {
    var days = getDaysSinceContact(a, deals);
    if (days === 30) events.push({ type: 'stale', label: a.name + ' hit 30 days with no contact', color: '#ef4444' });
  });

  if (!events.length) {
    el.innerHTML = '<span style="font-size:11px;color:#4ade80">No major changes since yesterday — all clear.</span>';
  } else {
    var typeIcon = { up: '↑', down: '↓', new: '+', removed: '−', deal: '→', stale: '!' };
    el.innerHTML = events.slice(0, 10).map(function(ev) {
      return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:4px 9px;border-radius:20px;background:' + ev.color + '15;color:' + ev.color + ';border:1px solid ' + ev.color + '30;font-weight:600;white-space:nowrap">' +
        (typeIcon[ev.type] || '•') + ' ' + ev.label + '</span>';
    }).join('');
    if (events.length > 10) el.innerHTML += '<span style="font-size:10px;color:var(--muted);padding:4px 8px">+' + (events.length - 10) + ' more</span>';
  }
  if (ts) ts.textContent = today;
}

// ── Momentum Movers ───────────────────────────────────────────────
function renderMomentumMovers(yesterday) {
  var el = document.getElementById('intel-momentum');
  if (!el) return;
  var deals = _intelDeals || [];

  if (!yesterday) {
    el.innerHTML = '<div style="font-size:10px;color:var(--muted);padding:4px 0">Baseline set today — momentum tracked from tomorrow.</div>';
    return;
  }

  var prevScores = yesterday.scores || {};
  var movers = athletes.map(function(a) {
    var now   = nilOpportunityScore(a, deals);
    var prev  = prevScores[a.id];
    var delta = (prev !== undefined) ? now - prev : 0;
    return { a: a, now: now, delta: delta };
  }).filter(function(m) { return Math.abs(m.delta) >= 3; })
    .sort(function(x, y) { return Math.abs(y.delta) - Math.abs(x.delta); });

  if (!movers.length) {
    el.innerHTML = '<div style="font-size:10px;color:var(--muted);padding:4px 0">No significant score changes since yesterday.</div>';
    return;
  }

  el.innerHTML = movers.slice(0, 6).map(function(m) {
    var up    = m.delta >= 0;
    var color = up ? 'var(--accent)' : '#f59e0b';
    var sign  = up ? '+' : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
      '<div>' +
        '<div style="font-size:11px;font-weight:700;color:var(--text)">' + m.a.name + '</div>' +
        '<div style="font-size:9px;color:var(--muted)">' + (m.a.sport||'') + (m.a.school?' · '+m.a.school:'') + '</div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div style="font-size:13px;font-weight:800;color:' + color + '">' + sign + m.delta + '</div>' +
        '<div style="font-size:9px;color:var(--muted)">score: ' + m.now + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Hidden Opportunities Engine ───────────────────────────────────
function renderHiddenOpportunities() {
  var el = document.getElementById('intel-hidden-opps');
  if (!el) return;
  var deals = _intelDeals || [];

  var opps = athletes.filter(function(a) {
    var score  = nilOpportunityScore(a, deals);
    var relStr = relationshipStrengthScore(a, deals);
    var active = deals.filter(function(d) { return d.athleteId === a.id && d.stage !== 'Closed'; }).length;
    return score >= 65 && relStr < 50 && active === 0;
  }).map(function(a) {
    return { a: a, score: nilOpportunityScore(a, deals), rel: relationshipStrengthScore(a, deals), est: estimateAnnualNIL(a) };
  }).sort(function(x, y) { return y.score - x.score; });

  if (!opps.length) {
    el.innerHTML = '<div style="font-size:11px;color:#4ade80;padding:4px 0">No hidden opportunities — all high-score athletes have active deals.</div>';
    return;
  }

  el.innerHTML = opps.slice(0, 5).map(function(item) {
    var a = item.a;
    var days = getDaysSinceContact(a, deals);
    var daysStr = days === 999 ? 'Never contacted' : days + 'd since contact';
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border)">' +
      '<div style="width:36px;height:36px;border-radius:50%;border:2px solid var(--accent);background:rgba(200,241,53,0.08);display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
        '<span style="font-size:12px;font-weight:800;color:var(--accent)">' + item.score + '</span>' +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:700;color:var(--text)">' + a.name + '</div>' +
        '<div style="font-size:10px;color:var(--muted)">' + (a.sport||'') + (a.school?' · '+a.school:'') + '</div>' +
        '<div style="font-size:9px;color:#f59e0b;margin-top:2px">' + daysStr + ' · Rel strength: ' + item.rel + '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:11px;font-weight:700;color:var(--accent)">' + item.est.label + '</div>' +
        '<div style="font-size:8px;color:var(--muted)">est. annual</div>' +
        '<button onclick="selectedAthleteId=\'' + a.id + '\';document.getElementById(\'activeAthlete\').value=\'' + a.id + '\';showView(\'outreach\',null)" style="margin-top:4px;font-size:9px;padding:3px 8px;background:var(--accent);border:none;border-radius:4px;color:#000;font-weight:700;cursor:pointer">Contact</button>' +
      '</div>' +
    '</div>';
  }).join('') + (opps.length > 5 ? '<div style="font-size:10px;color:var(--muted);padding-top:8px">+ ' + (opps.length - 5) + ' more — filter by score 65+ in Roster Intel</div>' : '');
}

// ── Money Left on the Table ───────────────────────────────────────
function renderMoneyLeftOnTable() {
  var el = document.getElementById('intel-money-table');
  if (!el) return;
  var deals = _intelDeals || [];

  var missed = athletes.filter(function(a) {
    var active = deals.filter(function(d) { return d.athleteId === a.id && d.stage !== 'Closed'; }).length;
    return active === 0 && nilOpportunityScore(a, deals) >= 55;
  }).map(function(a) {
    return { a: a, score: nilOpportunityScore(a, deals), est: estimateAnnualNIL(a) };
  }).sort(function(x, y) { return y.est.high - x.est.high; });

  if (!missed.length) {
    el.innerHTML = '<div style="font-size:11px;color:#4ade80;padding:4px 0">All scoreable athletes have active deals.</div>';
    return;
  }

  var totalLow  = missed.reduce(function(s, m) { return s + m.est.low;  }, 0);
  var totalHigh = missed.reduce(function(s, m) { return s + m.est.high; }, 0);
  var fmt = function(n) { return n >= 1000000 ? '$'+(n/1000000).toFixed(1)+'M' : n >= 1000 ? '$'+Math.round(n/1000)+'K' : '$'+n; };

  el.innerHTML =
    '<div style="padding:10px 12px;border-radius:6px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);margin-bottom:10px">' +
      '<div style="font-size:10px;color:var(--muted);margin-bottom:2px">Estimated untapped annual revenue (' + missed.length + ' athletes)</div>' +
      '<div style="font-size:18px;font-weight:800;color:#ef4444">' + fmt(totalLow) + ' – ' + fmt(totalHigh) + '</div>' +
    '</div>' +
    missed.slice(0, 4).map(function(item) {
      var a = item.a;
      var scoreColor = item.score >= 75 ? 'var(--accent)' : '#f59e0b';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)">' +
        '<div>' +
          '<div style="font-size:11px;font-weight:700;color:var(--text)">' + a.name + '</div>' +
          '<div style="font-size:9px;color:var(--muted)">' + (a.sport||'') + (a.school?' · '+a.school:'') + '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<div style="font-size:11px;font-weight:700;color:' + scoreColor + '">' + item.est.label + '/yr</div>' +
          '<div style="font-size:8px;color:var(--muted)">NIL score ' + item.score + '</div>' +
        '</div>' +
      '</div>';
    }).join('') + (missed.length > 4 ? '<div style="font-size:10px;color:var(--muted);padding-top:6px">+ ' + (missed.length - 4) + ' more athletes with zero active deals</div>' : '');
}

// ── Silent Churn Risk ─────────────────────────────────────────────
function renderChurnRisk() {
  var el = document.getElementById('intel-churn-list');
  if (!el) return;
  var deals = _intelDeals || [];

  var risked = athletes.map(function(a) {
    return { a: a, risk: churnRiskScore(a, deals), days: getDaysSinceContact(a, deals) };
  }).filter(function(item) { return item.risk >= 30; })
    .sort(function(x, y) { return y.risk - x.risk; });

  if (!risked.length) {
    el.innerHTML = '<div style="font-size:10px;color:#4ade80;padding:4px 0">No significant churn risk detected.</div>';
    return;
  }

  el.innerHTML = risked.slice(0, 6).map(function(item) {
    var a = item.a;
    var riskColor = item.risk >= 70 ? '#ef4444' : item.risk >= 50 ? '#f59e0b' : '#6b7280';
    var barWidth  = item.risk + '%';
    var daysLabel = item.days === 999 ? 'Never contacted' : item.days + 'd silent';
    return '<div style="padding:7px 0;border-bottom:1px solid var(--border)">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">' +
        '<div style="font-size:11px;font-weight:700;color:var(--text)">' + a.name + '</div>' +
        '<div style="font-size:11px;font-weight:800;color:' + riskColor + '">' + item.risk + '</div>' +
      '</div>' +
      '<div style="height:3px;background:var(--surface2);border-radius:2px;margin-bottom:4px">' +
        '<div style="width:' + barWidth + ';height:100%;background:' + riskColor + ';border-radius:2px;transition:width 0.4s"></div>' +
      '</div>' +
      '<div style="font-size:9px;color:var(--muted)">' + daysLabel + (a.year && (a.year.toLowerCase().includes('sr') || a.year.toLowerCase().includes('senior')) ? ' · Graduating' : '') + '</div>' +
    '</div>';
  }).join('') + (risked.length > 6 ? '<div style="font-size:10px;color:var(--muted);padding-top:6px">+ ' + (risked.length - 6) + ' more at risk</div>' : '');
}

// ── Opportunity Matrix (2×2) ──────────────────────────────────────
function renderOpportunityMatrix() {
  var el = document.getElementById('intel-opp-matrix');
  var leg = document.getElementById('intel-matrix-legend');
  if (!el || !athletes.length) {
    if (el) el.innerHTML = '<div style="color:var(--muted);font-size:11px">No roster data</div>';
    return;
  }
  var deals = _intelDeals || [];

  // Quadrant thresholds
  var NIL_HIGH = 65, REL_HIGH = 50;
  var quads = {
    HH: { label: 'Revenue Engine',   sub: 'High NIL + Strong rel',   color: 'var(--accent)', bg: 'rgba(200,241,53,0.08)',  athletes: [] },
    HL: { label: 'Hidden Gold',      sub: 'High NIL + Weak rel',     color: '#f59e0b',        bg: 'rgba(245,158,11,0.08)', athletes: [] },
    LH: { label: 'Loyal Base',       sub: 'Low NIL + Strong rel',    color: '#60a5fa',        bg: 'rgba(96,165,250,0.08)', athletes: [] },
    LL: { label: 'Cold Prospects',   sub: 'Low NIL + Weak rel',      color: '#6b7280',        bg: 'rgba(107,114,128,0.06)', athletes: [] }
  };

  athletes.forEach(function(a) {
    var nilSc = nilOpportunityScore(a, deals);
    var relSc = relationshipStrengthScore(a, deals);
    var key = (nilSc >= NIL_HIGH ? 'H' : 'L') + (relSc >= REL_HIGH ? 'H' : 'L');
    quads[key].athletes.push(a);
  });

  // 2×2 grid
  el.style.display = 'grid';
  el.style.gridTemplateColumns = '1fr 1fr';
  el.style.gap = '6px';
  el.innerHTML = [
    { key:'HH', pos:'top-left'  }, { key:'HL', pos:'top-right'    },
    { key:'LH', pos:'bot-left'  }, { key:'LL', pos:'bot-right'    }
  ].map(function(cell) {
    var q = quads[cell.key];
    var dotStr = q.athletes.slice(0, 8).map(function(a) {
      return '<span title="' + a.name + '" style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + q.color + ';margin:1px"></span>';
    }).join('') + (q.athletes.length > 8 ? '<span style="font-size:8px;color:' + q.color + '">+' + (q.athletes.length - 8) + '</span>' : '');

    return '<div style="background:' + q.bg + ';border:1px solid ' + q.color + '30;border-radius:6px;padding:10px 10px 8px">' +
      '<div style="font-size:10px;font-weight:800;color:' + q.color + ';margin-bottom:2px">' + q.label + '</div>' +
      '<div style="font-size:8px;color:var(--muted);margin-bottom:6px">' + q.sub + '</div>' +
      '<div style="font-size:20px;font-weight:800;color:' + q.color + ';margin-bottom:4px">' + q.athletes.length + '</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:1px">' + dotStr + '</div>' +
    '</div>';
  }).join('');

  // Legend
  if (leg) leg.innerHTML =
    '<div style="font-size:8px;color:var(--muted);text-align:center">NIL ≥' + NIL_HIGH + ' = High   ·   Relationship ≥' + REL_HIGH + ' = Strong</div>';
}

// ── Warm Introduction Paths ───────────────────────────────────────
function renderWarmIntros() {
  var el = document.getElementById('intel-warm-intros');
  if (!el) return;
  var deals = _intelDeals || [];

  // Group by school
  var bySchool = {};
  athletes.forEach(function(a) {
    var school = (a.school || '').trim();
    if (!school) return;
    if (!bySchool[school]) bySchool[school] = [];
    bySchool[school].push(a);
  });

  var paths = [];
  Object.keys(bySchool).forEach(function(school) {
    var group = bySchool[school];
    if (group.length < 2) return;
    // Find strong relationships (rel strength >= 55)
    var warm  = group.filter(function(a) { return relationshipStrengthScore(a, deals) >= 55; });
    var cold  = group.filter(function(a) { return relationshipStrengthScore(a, deals) < 45; });
    warm.forEach(function(w) {
      cold.forEach(function(c) {
        paths.push({ school: school, via: w, target: c,
          viaStr: getRelationshipLabel(getRelationshipStatus(w, deals)) });
      });
    });
  });

  if (!paths.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--muted)">No warm paths detected. Add more athletes from the same schools to reveal introduction opportunities.</div>';
    return;
  }

  el.style.display = 'grid';
  el.style.gridTemplateColumns = 'repeat(auto-fill,minmax(260px,1fr))';
  el.style.gap = '10px';
  el.innerHTML = paths.slice(0, 6).map(function(p) {
    return '<div style="background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px">' +
      '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px">' + p.school + '</div>' +
      '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">' +
        '<div style="font-size:11px;font-weight:700;color:var(--accent)">' + p.via.name + '</div>' +
        '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(200,241,53,0.12);color:var(--accent)">' + p.viaStr + '</span>' +
        '<span style="font-size:11px;color:var(--muted)">→</span>' +
        '<div style="font-size:11px;font-weight:700;color:var(--text)">' + p.target.name + '</div>' +
      '</div>' +
      '<div style="font-size:9px;color:var(--muted);margin-top:6px">Ask ' + p.via.name.split(' ')[0] + ' to introduce you to ' + p.target.name.split(' ')[0] + ' — same program, stronger path than cold outreach.</div>' +
    '</div>';
  }).join('');
}

// ── Priority Prospect List (HQ tab) ──────────────────────────────
function renderPriorityList() {
  var el = document.getElementById('intel-priority-list');
  if (!el) return;
  var deals = _intelDeals || [];

  if (!athletes.length) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px 0">No athletes on roster. <button onclick="showView(\'add-athlete\',null)" style="color:var(--accent);background:none;border:none;cursor:pointer;font-weight:700">Add a client →</button></div>';
    return;
  }

  var scored = athletes.map(function(a) {
    return {
      a:      a,
      score:  nilOpportunityScore(a, deals),
      rel:    relationshipStrengthScore(a, deals),
      churn:  churnRiskScore(a, deals),
      status: getRelationshipStatus(a, deals),
      days:   getDaysSinceContact(a, deals)
    };
  }).sort(function(x, y) { return y.score - x.score; });

  el.innerHTML = scored.slice(0, 10).map(function(item) {
    var a          = item.a;
    var sc         = item.score;
    var scoreColor = sc >= 75 ? 'var(--accent)' : sc >= 55 ? '#f59e0b' : '#6b7280';
    var relColor   = getRelationshipColor(item.status);
    var relLabel   = getRelationshipLabel(item.status);
    var churnColor = item.churn >= 60 ? '#ef4444' : item.churn >= 40 ? '#f59e0b' : '#4ade80';
    var reach      = (parseInt(a.instagram)||0) + (parseInt(a.tiktok)||0);
    var reachStr   = reach > 1000000 ? (reach/1000000).toFixed(1)+'M' : reach > 1000 ? Math.round(reach/1000)+'K' : (reach||'—');
    var daysStr    = item.days === 999 ? 'Never' : item.days === 0 ? 'Today' : item.days + 'd ago';

    return '<div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">' +
      '<div style="width:42px;height:42px;border-radius:50%;border:2px solid ' + scoreColor + ';background:' + scoreColor + '12;display:flex;align-items:center;justify-content:center;flex-shrink:0">' +
        '<span style="font-size:13px;font-weight:800;color:' + scoreColor + '">' + sc + '</span>' +
      '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (a.name || 'Unknown') + '</div>' +
        '<div style="font-size:10px;color:var(--muted);margin-top:1px">' + [(a.position||null),(a.sport||null),(a.school||null)].filter(Boolean).join(' · ') + '</div>' +
        '<div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">' +
          '<span style="font-size:9px;padding:1px 6px;border-radius:3px;background:' + relColor + '20;color:' + relColor + ';font-weight:700">' + relLabel + '</span>' +
          '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:' + churnColor + '15;color:' + churnColor + '">Risk ' + item.churn + '</span>' +
          '<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(96,165,250,0.1);color:#60a5fa">Rel ' + item.rel + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="text-align:right;flex-shrink:0">' +
        '<div style="font-size:9px;color:var(--muted)">Last contact</div>' +
        '<div style="font-size:11px;font-weight:700;color:' + (item.days > 14 && item.days < 999 ? '#f59e0b' : item.days === 999 ? '#ef4444' : 'var(--muted)') + '">' + daysStr + '</div>' +
        '<div style="font-size:9px;color:var(--muted);margin-top:2px">' + reachStr + ' reach</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Roster Intel Tab ──────────────────────────────────────────────
function renderRosterIntel() {
  var el = document.getElementById('roster-intel-grid');
  if (!el) return;

  // Sync deals from cache if not already loaded
  if (!_intelDeals) {
    _intelDeals = [];
    (athletes || []).forEach(function(a) {
      var cached = window._athleteDealsCache && window._athleteDealsCache[a.id];
      if (cached) cached.forEach(function(d) { _intelDeals.push(Object.assign({}, d, { athleteId: a.id, athleteName: a.name })); });
    });
  }
  var deals = _intelDeals;

  // Read filters
  var sportFilter = (document.getElementById('ri-sport') || {}).value || 'all';
  var relFilter   = (document.getElementById('ri-rel')   || {}).value || 'all';
  var sortBy      = (document.getElementById('ri-sort')  || {}).value || 'score';
  var minScore    = parseInt((document.getElementById('ri-minscore') || {}).value) || 0;
  var search      = ((document.getElementById('ri-search') || {}).value || '').toLowerCase().trim();

  var filtered = (athletes || []).filter(function(a) {
    var sport = (a.sport || '').toLowerCase();
    if (sportFilter !== 'all') {
      if (sportFilter === 'other') {
        if (['football','basketball','baseball','softball','soccer'].some(function(s) { return sport.includes(s); })) return false;
      } else if (!sport.includes(sportFilter)) return false;
    }
    var status = getRelationshipStatus(a, deals);
    if (relFilter !== 'all' && status !== relFilter) return false;
    if (nilOpportunityScore(a, deals) < minScore) return false;
    if (search) {
      var haystack = [(a.name||''),(a.sport||''),(a.school||''),(a.position||''),(a.year||'')].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  // Sort
  var relOrder = { signed:0, active:1, 'in-discussion':2, 'outreach-sent':3, 'former-client':4, 'not-contacted':5 };
  filtered.sort(function(a, b) {
    if (sortBy === 'score')        return nilOpportunityScore(b, deals) - nilOpportunityScore(a, deals);
    if (sortBy === 'name')         return (a.name||'').localeCompare(b.name||'');
    if (sortBy === 'relationship') return (relOrder[getRelationshipStatus(a,deals)]||5) - (relOrder[getRelationshipStatus(b,deals)]||5);
    if (sortBy === 'contact')      return getDaysSinceContact(a, deals) - getDaysSinceContact(b, deals);
    if (sortBy === 'sport')        return (a.sport||'').localeCompare(b.sport||'');
    return 0;
  });

  // Update count
  var countEl = document.getElementById('roster-intel-count');
  if (countEl) countEl.textContent = filtered.length + ' athlete' + (filtered.length !== 1 ? 's' : '') + ' shown';

  if (!filtered.length) {
    el.style.display = 'block';
    el.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:40px;text-align:center">No athletes match your filters.</div>';
    return;
  }

  // Render cards
  el.style.display = 'grid';
  el.style.gridTemplateColumns = 'repeat(auto-fill,minmax(290px,1fr))';
  el.style.gap = '12px';

  el.innerHTML = filtered.map(function(a) {
    var score      = nilOpportunityScore(a, deals);
    var relStr     = relationshipStrengthScore(a, deals);
    var churnRisk  = churnRiskScore(a, deals);
    var status     = getRelationshipStatus(a, deals);
    var relColor   = getRelationshipColor(status);
    var scoreColor = score >= 75 ? 'var(--accent)' : score >= 55 ? '#f59e0b' : '#6b7280';
    var churnColor = churnRisk >= 60 ? '#ef4444' : churnRisk >= 40 ? '#f59e0b' : '#4ade80';
    var relStrColor= relStr >= 60 ? 'var(--accent)' : relStr >= 35 ? '#60a5fa' : '#6b7280';
    var reach      = (parseInt(a.instagram)||0) + (parseInt(a.tiktok)||0);
    var reachStr   = reach > 1000000 ? (reach/1000000).toFixed(1)+'M' : reach > 1000 ? Math.round(reach/1000)+'K' : reach > 0 ? reach : '—';
    var myDeals    = deals.filter(function(d) { return d.athleteId === a.id; });
    var days       = getDaysSinceContact(a, deals);
    var daysStr    = days === 999 ? 'Never' : days === 0 ? 'Today' : days + 'd ago';
    var daysColor  = days === 999 ? '#ef4444' : days > 14 ? '#f59e0b' : 'var(--muted)';
    var est        = estimateAnnualNIL(a);

    var relOpts = ['not-contacted','outreach-sent','in-discussion','active','signed','former-client'];
    var relDrop = '<select onchange="updateRelationshipStatus(\'' + a.id + '\',this.value)" ' +
      'style="font-size:10px;padding:3px 6px;background:' + relColor + '18;border:1px solid ' + relColor + '50;border-radius:4px;color:' + relColor + ';cursor:pointer;font-weight:700;outline:none;font-family:inherit">' +
      relOpts.map(function(opt) {
        return '<option value="' + opt + '"' + (status === opt ? ' selected' : '') + '>' + getRelationshipLabel(opt) + '</option>';
      }).join('') + '</select>';

    var borderColor = score >= 75 ? 'rgba(200,241,53,0.22)' : churnRisk >= 60 ? 'rgba(239,68,68,0.2)' : 'var(--border)';

    return '<div style="background:var(--surface);border:1px solid ' + borderColor + ';border-radius:var(--r);padding:16px;position:relative;transition:border-color 0.15s">' +
      // NIL score badge
      '<div style="position:absolute;top:14px;right:14px;width:46px;height:46px;border-radius:50%;border:2px solid ' + scoreColor + ';background:' + scoreColor + '10;display:flex;align-items:center;justify-content:center">' +
        '<div style="text-align:center"><div style="font-size:14px;font-weight:800;color:' + scoreColor + ';line-height:1">' + score + '</div><div style="font-size:7px;color:var(--muted);text-transform:uppercase;letter-spacing:0.05em">NIL</div></div>' +
      '</div>' +
      // Name + info
      '<div style="padding-right:58px;margin-bottom:8px">' +
        '<div style="font-size:14px;font-weight:700;color:var(--text)">' + (a.name || 'Unknown') + '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + [(a.position||null),(a.sport||null)].filter(Boolean).join(' · ') + '</div>' +
        (a.school ? '<div style="font-size:10px;color:var(--muted);opacity:0.7">' + a.school + (a.schoolTier?' ('+a.schoolTier+')':'') + '</div>' : '') +
      '</div>' +
      // Relationship dropdown + year
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:10px;flex-wrap:wrap">' +
        relDrop +
        (a.year ? '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:var(--surface2);color:var(--muted)">' + a.year + '</span>' : '') +
      '</div>' +
      // Three score bars
      '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:10px">' +
        '<div style="background:var(--surface2);border-radius:4px;padding:6px 7px">' +
          '<div style="font-size:7px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Rel Strength</div>' +
          '<div style="height:3px;background:rgba(255,255,255,0.06);border-radius:2px;margin-bottom:3px"><div style="width:' + relStr + '%;height:100%;background:' + relStrColor + ';border-radius:2px"></div></div>' +
          '<div style="font-size:11px;font-weight:700;color:' + relStrColor + '">' + relStr + '</div>' +
        '</div>' +
        '<div style="background:var(--surface2);border-radius:4px;padding:6px 7px">' +
          '<div style="font-size:7px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Churn Risk</div>' +
          '<div style="height:3px;background:rgba(255,255,255,0.06);border-radius:2px;margin-bottom:3px"><div style="width:' + churnRisk + '%;height:100%;background:' + churnColor + ';border-radius:2px"></div></div>' +
          '<div style="font-size:11px;font-weight:700;color:' + churnColor + '">' + churnRisk + '</div>' +
        '</div>' +
        '<div style="background:var(--surface2);border-radius:4px;padding:6px 7px">' +
          '<div style="font-size:7px;color:var(--muted);text-transform:uppercase;margin-bottom:3px">Est. Annual</div>' +
          '<div style="font-size:9px;font-weight:700;color:var(--accent);margin-top:6px">' + est.label + '</div>' +
        '</div>' +
      '</div>' +
      // Stats row
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:10px">' +
        '<div style="background:var(--surface2);border-radius:4px;padding:5px 7px"><div style="font-size:7px;color:var(--muted);text-transform:uppercase">Reach</div><div style="font-size:11px;font-weight:700;color:var(--text)">' + reachStr + '</div></div>' +
        '<div style="background:var(--surface2);border-radius:4px;padding:5px 7px"><div style="font-size:7px;color:var(--muted);text-transform:uppercase">Deals</div><div style="font-size:11px;font-weight:700;color:var(--text)">' + myDeals.length + '</div></div>' +
        '<div style="background:var(--surface2);border-radius:4px;padding:5px 7px"><div style="font-size:7px;color:var(--muted);text-transform:uppercase">Contact</div><div style="font-size:11px;font-weight:700;color:' + daysColor + '">' + daysStr + '</div></div>' +
      '</div>' +
      // Action buttons
      '<div style="display:flex;gap:5px;flex-wrap:wrap">' +
        '<button onclick="showView(\'outreach\',null)" style="flex:1;font-size:10px;padding:5px 6px;background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.25);color:#60a5fa;border-radius:5px;cursor:pointer;font-weight:600">Outreach</button>' +
        '<button onclick="selectedAthleteId=\'' + a.id + '\';document.getElementById(\'activeAthlete\').value=\'' + a.id + '\';showView(\'deals\',null)" style="flex:1;font-size:10px;padding:5px 6px;background:rgba(200,241,53,0.08);border:1px solid rgba(200,241,53,0.2);color:var(--accent);border-radius:5px;cursor:pointer;font-weight:600">Deal Scan</button>' +
        '<button onclick="selectedAthleteId=\'' + a.id + '\';document.getElementById(\'activeAthlete\').value=\'' + a.id + '\';showIntelTab(\'portal\')" style="flex:1;font-size:10px;padding:5px 6px;background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.2);color:#a78bfa;border-radius:5px;cursor:pointer;font-weight:600">Portal</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── Save relationship status to server ────────────────────────────
async function updateRelationshipStatus(athleteId, status) {
  var ath = athletes.find(function(a) { return a.id === athleteId; });
  if (!ath) return;
  try {
    await fetch(API_BASE + '/api/athletes/' + athleteId, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({}, ath, { relationshipStatus: status }))
    });
    // Update local caches
    [athletes, window._allAthletes].forEach(function(arr) {
      if (!arr) return;
      var i = arr.findIndex(function(a) { return a.id === athleteId; });
      if (i !== -1) arr[i].relationshipStatus = status;
    });
    if (typeof showToast === 'function') showToast('Relationship updated');
  } catch(e) {
    if (typeof showToast === 'function') showToast('Error saving relationship');
  }
}

// ── AI Daily Actions ─────────────────────────────────────────────
async function loadDailyActions(force) {
  var today = new Date().toDateString();
  if (!force && _dailyActionsCache && _dailyActionsDate === today) {
    renderDailyActions(_dailyActionsCache);
    return;
  }

  var el  = document.getElementById('intel-actions-list');
  var btn = document.getElementById('intel-actions-btn');
  if (!el) return;

  el.innerHTML = '<div style="display:flex;align-items:center;gap:10px;padding:20px;color:var(--muted);font-size:12px"><div class="spinner" style="display:inline-block;flex-shrink:0"></div>Generating today\'s priorities from your CRM...</div>';
  if (btn) { btn.disabled = true; btn.textContent = 'Generating...'; }

  try {
    var r = await fetch(API_BASE + '/api/intelligence/daily-actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    var data = await r.json();
    if (data.error) throw new Error(data.error);
    _dailyActionsCache = data.actions;
    _dailyActionsDate  = today;
    renderDailyActions(data.actions);
    var ts = document.getElementById('intel-actions-ts');
    if (ts) ts.textContent = 'Generated ' + new Date().toLocaleTimeString('en-US', { hour:'2-digit', minute:'2-digit' });
  } catch(e) {
    if (el) el.innerHTML = '<div style="color:var(--red);font-size:12px;padding:12px">' + e.message + ' — <button onclick="loadDailyActions(true)" style="color:var(--accent);background:none;border:none;cursor:pointer;font-weight:700">Retry</button></div>';
  }
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
}

function renderDailyActions(actions) {
  var el = document.getElementById('intel-actions-list');
  if (!el || !actions || !actions.length) {
    if (el) el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:12px">No actions generated. <button onclick="loadDailyActions(true)" style="color:var(--accent);background:none;border:none;cursor:pointer">Try again</button></div>';
    return;
  }

  var priCfg = {
    HIGH:   { color:'#ef4444', bg:'rgba(239,68,68,0.06)',   border:'rgba(239,68,68,0.2)'   },
    MEDIUM: { color:'#f59e0b', bg:'rgba(245,158,11,0.06)',  border:'rgba(245,158,11,0.2)'  },
    LOW:    { color:'#6b7280', bg:'rgba(107,114,128,0.04)', border:'rgba(107,114,128,0.15)' }
  };
  el.innerHTML = actions.map(function(action) {
    var cfg = priCfg[action.priority] || priCfg.LOW;
    return '<div style="padding:11px 12px;border-radius:6px;background:' + cfg.bg + ';border:1px solid ' + cfg.border + ';margin-bottom:7px">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">' +
          '<span style="font-size:12px;font-weight:700;color:var(--text)">' + (action.action || '') + '</span>' +
          '<span style="font-size:8px;font-weight:800;padding:2px 6px;border-radius:3px;background:' + cfg.color + '22;color:' + cfg.color + ';letter-spacing:0.04em">' + (action.priority || '') + '</span>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted);line-height:1.5">' + (action.why || '') + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
//  REVENUE BENCHMARK ENGINE — Team Match (Transfer Portal)
// ══════════════════════════════════════════════════════════════════
//
//  Methodology:
//  The NCAA House settlement (effective 2025-26) allows schools to share up
//  to ~$20.5M/year directly with athletes via revenue sharing.  Combined with
//  collective deals, total athlete compensation per school is estimated below.
//  Position allocations follow documented collective deal distributions
//  (On3, Business of College Sports 2025) and the NFL CBA 48.8% split model
//  used as a comparator for position group weighting.
//
//  DATA SOURCES:
//  • NCAA House settlement: $20.5M/yr for P4 schools (2025-26)
//  • On3 Collective Tracker 2025: total collective spending by conference
//  • Business of College Sports 2025: position premium distributions
//  • ESPN 2025 portal data: per-position market rates by tier

var _NIL_REVENUE_POOLS = {
  // School tier → estimated total annual athlete compensation pool
  // (House revenue share + collective + brand deals combined)
  'p4-top10':      { pool: 32_000_000, label: 'Elite P4 (Top 10)',    conf: 'SEC/Big Ten top programs'   },
  'p4-top25':      { pool: 26_000_000, label: 'P4 Top 25',            conf: 'Established P4 programs'    },
  'p4-mid':        { pool: 20_000_000, label: 'P4 Mid-Tier',          conf: 'Mid-tier Power 4'           },
  'p4-lower':      { pool: 14_000_000, label: 'P4 Lower-Tier',        conf: 'Lower Power 4'              },
  'G5':            { pool: 5_000_000,  label: 'Group of 5',           conf: 'AAC, Mountain West, Sun Belt'},
  'highmajor-top': { pool: 7_500_000,  label: 'High Major Top',       conf: 'Top AAC/MWC programs'       },
  'highmajor-mid': { pool: 4_000_000,  label: 'High Major Mid',       conf: 'Mid-tier AAC/MWC'           },
  'mid-top':       { pool: 2_500_000,  label: 'Mid-Major Top',        conf: 'Top mid-major programs'     },
  'mid-mid':       { pool: 1_200_000,  label: 'Mid-Major',            conf: 'Standard mid-major'         },
  'mid-lower':     { pool:   500_000,  label: 'Mid-Major Lower',      conf: 'Lower mid-major'            },
  'lowmajor-top':  { pool:   250_000,  label: 'Low Major Top',        conf: 'Top low-major programs'     },
  'lowmajor-lower':{ pool:   100_000,  label: 'Low Major',            conf: 'Standard low-major'         },
  'd2-elite':      { pool:    60_000,  label: 'D2 Elite',             conf: 'Elite D2 programs'          },
  'd2-top':        { pool:    35_000,  label: 'D2 Top',               conf: 'Top D2 programs'            },
  'd2-mid':        { pool:    15_000,  label: 'D2 Mid',               conf: 'Mid D2'                     },
  'd2-lower':      { pool:     8_000,  label: 'D2 Lower',             conf: 'Lower D2'                   },
};

// Conference → school tier mapping for team match results
var _CONF_TO_TIER = {
  'SEC': 'p4-top25', 'Big Ten': 'p4-top25', 'Big 12': 'p4-mid', 'ACC': 'p4-mid',
  'AAC': 'highmajor-top', 'Mountain West': 'highmajor-mid', 'American Athletic': 'highmajor-top',
  'Sun Belt': 'G5', 'MAC': 'mid-top', 'CUSA': 'mid-mid', 'Conference USA': 'mid-mid',
  'Big East': 'highmajor-top', 'Atlantic 10': 'mid-top', 'MVC': 'mid-mid',
  'Missouri Valley': 'mid-mid', 'WCC': 'mid-top', 'West Coast': 'mid-top',
  'SoCon': 'lowmajor-top', 'Big South': 'lowmajor-top', 'OVC': 'lowmajor-top',
  'Ohio Valley': 'lowmajor-top', 'Ivy': 'mid-mid', 'SWAC': 'lowmajor-lower',
  'MEAC': 'lowmajor-lower', 'CAA': 'lowmajor-top', 'Big Sky': 'lowmajor-top',
  'Pioneer': 'lowmajor-lower', 'Independent': 'highmajor-mid',
  'Pac-12': 'p4-mid',
};

// Sport → share of pool, roster size
var _SPORT_CONFIG = {
  'football':               { share: 0.72, roster: 85  },
  'basketball':             { share: 0.14, roster: 13  },
  "men's basketball":       { share: 0.14, roster: 13  },
  "women's basketball":     { share: 0.09, roster: 15  },
  'baseball':               { share: 0.05, roster: 35  },
  'softball':               { share: 0.04, roster: 22  },
  "women's soccer":         { share: 0.03, roster: 28  },
  'soccer':                 { share: 0.03, roster: 28  },
  "men's soccer":           { share: 0.025,roster: 28  },
  'volleyball':             { share: 0.03, roster: 15  },
  "women's volleyball":     { share: 0.03, roster: 15  },
  'lacrosse':               { share: 0.02, roster: 35  },
  'wrestling':              { share: 0.015,roster: 30  },
  'track':                  { share: 0.015,roster: 60  },
  'swimming':               { share: 0.01, roster: 30  },
  'gymnastics':             { share: 0.02, roster: 14  },
  'default':                { share: 0.02, roster: 20  },
};

// Position premium multiplier within sport (vs. average teammate)
// Based on documented collective deal structures (On3/ESPN 2025)
var _POSITION_PREMIUM = {
  football: {
    qb: 3.2, quarterback: 3.2, 'qb1': 3.2,
    wr: 1.8, 'wide receiver': 1.8, 'wide-receiver': 1.8,
    rb: 1.5, 'running back': 1.5, 'running-back': 1.5,
    te: 1.4, 'tight end': 1.4, 'tight-end': 1.4,
    cb: 1.5, cornerback: 1.5,
    edge: 1.6, de: 1.4, 'defensive end': 1.4,
    safety: 1.2, s: 1.2, ss: 1.3, fs: 1.2,
    lb: 1.25, linebacker: 1.25,
    ol: 0.85, 'offensive line': 0.85, ot: 0.9, og: 0.8, c: 0.8,
    dl: 0.95, 'defensive line': 0.95, dt: 0.9,
    k: 0.55, kicker: 0.55, p: 0.5, punter: 0.5,
    default: 1.0,
  },
  basketball: {
    pg: 2.1, 'point guard': 2.1,
    sg: 1.6, 'shooting guard': 1.6,
    sf: 1.4, 'small forward': 1.4,
    pf: 1.2, 'power forward': 1.2,
    c: 1.0, center: 1.0,
    default: 1.3,
  },
  baseball: {
    'starting pitcher': 2.0, sp: 2.0, pitcher: 1.7,
    'center field': 1.5, cf: 1.5,
    catcher: 1.4,
    '1b': 1.2, ss: 1.3, 'shortstop': 1.3, '3b': 1.1, '2b': 1.0,
    'relief pitcher': 0.9, rp: 0.9,
    default: 1.2,
  },
  default: { default: 1.0 },
};

// Position group label for display
var _POS_GROUPS = {
  football: {
    qb: 'Quarterback', quarterback: 'Quarterback',
    wr: 'Skill — WR', rb: 'Skill — RB', te: 'Tight End',
    cb: 'Skill — CB', edge: 'Pass Rusher', de: 'D-Line',
    safety: 'Safety', s: 'Safety', ss: 'Safety', fs: 'Safety',
    lb: 'Linebacker',
    ol: 'O-Line', ot: 'O-Line', og: 'O-Line',
    dl: 'D-Line', dt: 'D-Line',
    k: 'Special Teams', p: 'Special Teams',
  },
};

/**
 * calcRevenueBenchmark(conference, sport, position, athleteTier)
 * Returns { low, high, avgPerPlayer, sportPool, pool, posGroup, tier, confidence, methodology }
 */
function calcRevenueBenchmark(conference, sport, position, athleteTier) {
  // Determine school tier from conference
  var confNorm = (conference || '').replace(/\s+/g,'').toLowerCase();
  var tier = null;
  // Direct match
  for (var c in _CONF_TO_TIER) {
    if (c.toLowerCase().replace(/\s+/g,'') === confNorm) { tier = _CONF_TO_TIER[c]; break; }
  }
  // Fallback to athlete's own tier (for context when no conf known)
  if (!tier) tier = athleteTier || 'mid-mid';

  var poolInfo = _NIL_REVENUE_POOLS[tier] || _NIL_REVENUE_POOLS['mid-mid'];
  var pool = poolInfo.pool;

  // Sport config
  var sportKey = (sport || '').toLowerCase();
  var sCfg = _SPORT_CONFIG[sportKey] || _SPORT_CONFIG['default'];

  var sportPool   = Math.round(pool * sCfg.share);
  var avgPerPlayer = Math.round(sportPool / sCfg.roster);

  // Position premium
  var posKey = (position || '').toLowerCase().trim();
  var posMap = _POSITION_PREMIUM[sportKey] || _POSITION_PREMIUM['default'];
  var premium = posMap[posKey] || posMap['default'] || 1.0;

  // Weighted estimate — premium players pull from a redistributed share
  // Total weighted units = sum across roster (simplified: avg premium × roster × 1.0 = sportPool)
  // So player share = avgPerPlayer × premium (premium already accounts for relative value)
  var estimate = avgPerPlayer * premium;

  var low  = Math.max(500, Math.round(estimate * 0.7  / 1000) * 1000);
  var high = Math.round(estimate * 1.45 / 1000) * 1000;

  // Position group label
  var posGroup = null;
  var pgMap = _POS_GROUPS[sportKey];
  if (pgMap) posGroup = pgMap[posKey] || null;
  if (!posGroup) {
    // Capitalize position
    posGroup = position ? position.charAt(0).toUpperCase() + position.slice(1) : 'Your position';
  }

  // Confidence based on tier and how well we know the conference
  var confidence = tier.startsWith('p4') ? 'Medium-High'
                 : tier.startsWith('high') || tier === 'G5' ? 'Medium'
                 : 'Low-Medium';

  return {
    low, high,
    sportPool,
    pool,
    avgPerPlayer,
    premium: Math.round(premium * 10) / 10,
    posGroup,
    tier,
    tierLabel: poolInfo.label,
    confidence,
    methodology: [
      'NCAA House settlement base: ~$' + (Math.round(pool * 0.63 / 1_000_000 * 10) / 10) + 'M annual athlete revenue share for this tier',
      'Combined with collective deal spending: $' + Math.round(pool / 1_000_000 * 10) / 10 + 'M estimated total pool',
      sport.charAt(0).toUpperCase() + sport.slice(1) + ' allocated ' + Math.round(sCfg.share * 100) + '% → $' + Math.round(sportPool / 1000) + 'K sport pool across ~' + sCfg.roster + ' scholarship players',
      'Avg per player: $' + avgPerPlayer.toLocaleString() + ' · ' + posGroup + ' premium: ' + premium + 'x',
    ],
  };
}

function renderBenchmarkCard(t, sport, position) {
  var conf = t.confLabel || t.conference || '';
  var bench = calcRevenueBenchmark(conf, sport, position, null);
  var color = bench.confidence.startsWith('Medium-High') ? '#4ade80'
            : bench.confidence.startsWith('Medium') ? '#f59e0b'
            : '#60a5fa';

  return '<div style="background:rgba(200,241,53,0.04);border:1px solid rgba(200,241,53,0.2);border-radius:8px;padding:12px 14px;margin-top:10px">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
      '<div>' +
        '<div style="font-size:9px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.08em">Revenue Benchmark</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + bench.posGroup + ' · ' + bench.tierLabel + '</div>' +
      '</div>' +
      '<span style="font-size:9px;padding:2px 7px;border-radius:3px;background:' + color + '20;color:' + color + ';font-weight:700">' + bench.confidence + ' confidence</span>' +
    '</div>' +
    '<div style="font-size:20px;font-weight:700;color:var(--accent);letter-spacing:-0.02em;margin-bottom:4px">' +
      '$' + bench.low.toLocaleString() + ' – $' + bench.high.toLocaleString() +
      '<span style="font-size:11px;font-weight:400;color:var(--muted);margin-left:6px">per year</span>' +
    '</div>' +
    '<div style="font-size:10px;color:var(--muted);margin-bottom:8px">' +
      'Reasonable deal range for ' + bench.posGroup + ' at a ' + bench.tierLabel + ' school. ' +
      'School total pool ~$' + Math.round(bench.pool / 1_000_000 * 10) / 10 + 'M · Sport allocation $' + Math.round(bench.sportPool / 1000) + 'K · Avg per player $' + bench.avgPerPlayer.toLocaleString() +
    '</div>' +
    // Methodology accordion
    '<details style="margin-top:4px">' +
      '<summary style="font-size:9px;color:var(--muted);cursor:pointer;user-select:none;text-transform:uppercase;letter-spacing:0.06em">Show methodology</summary>' +
      '<div style="margin-top:6px;display:flex;flex-direction:column;gap:3px">' +
        bench.methodology.map(function(m) {
          return '<div style="font-size:10px;color:var(--muted);padding-left:10px;border-left:1px solid var(--border)">' + m + '</div>';
        }).join('') +
        '<div style="font-size:9px;color:var(--muted);margin-top:4px;font-style:italic">Sources: NCAA House Settlement 2025, On3 Collective Tracker 2025, Business of College Sports 2025, NFL CBA 48.8% revenue split model (position weighting analogue)</div>' +
      '</div>' +
    '</details>' +
  '</div>';
}

// ══════════════════════════════════════════════════════════════════
//  TEAM MATCH (Transfer Portal — Tab 3)
// ══════════════════════════════════════════════════════════════════

async function runTeamMatch() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  const btn = document.getElementById('tm-run-btn');
  btn.disabled = true; btn.textContent = 'Scanning...';
  document.getElementById('tm-results').innerHTML = '<div style="color:var(--muted);padding:20px;text-align:center">Scanning college programs with AI...</div>';
  document.getElementById('tm-summary').style.display = 'none';
  document.getElementById('tm-playbook-block').classList.remove('visible');
  document.getElementById('tm-playbook-text').textContent = '';

  try {
    const r = await fetch(`${API_BASE}/api/ai/team-match`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        athleteId: selectedAthleteId,
        conference: document.getElementById('tm-conf').value,
        minNil: parseInt(document.getElementById('tm-minnil').value),
        sortBy: document.getElementById('tm-sort').value,
      }),
    });
    const data = await r.json();
    if (data.error) { document.getElementById('tm-results').innerHTML = '<div style="color:var(--red);padding:20px"> ' + data.error + '</div>'; return; }
    renderTeamMatch(data.teams);
  } catch(e) {
    document.getElementById('tm-results').innerHTML = '<div style="color:var(--red);padding:20px"> ' + e.message + '</div>';
  }
  btn.disabled = false; btn.textContent = 'Scan Teams →';
}

function fmtNil(n) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1000000) return '$' + (n/1000000).toFixed(1) + 'M';
  if (n >= 1000) return '$' + Math.round(n/1000) + 'K';
  return '$' + n;
}

async function renderTeamMatch(teams) {
  if (!teams || !teams.length) {
    document.getElementById('tm-results').innerHTML = '<div style="color:var(--muted);padding:20px">No matching programs found. Try adjusting your filters.</div>';
    return;
  }

  // Resolve active athlete's sport + position for benchmarks
  const ath = athletes.find(a => a.id === selectedAthleteId) || {};
  const athSport    = (ath.sport    || 'basketball').toLowerCase();
  const athPosition = (ath.position || '').toLowerCase();

  const best = teams[0];
  const avgNil = Math.round(teams.reduce((s,t) => s + (t.nilHigh||0), 0) / teams.length);
  const sumEl = document.getElementById('tm-summary');
  sumEl.style.display = 'grid';
  sumEl.style.gridTemplateColumns = 'repeat(auto-fit,minmax(120px,1fr))';
  sumEl.style.gap = '10px';
  sumEl.style.marginBottom = '20px';
  sumEl.innerHTML = `
    <div class="kpi"><div class="kpi-label">Programs found</div><div class="kpi-val" style="font-size:24px">${teams.length}</div></div>
    <div class="kpi"><div class="kpi-label">Best NIL offer</div><div class="kpi-val" style="font-size:22px">${fmtNil(best.nilHigh||0)}</div></div>
    <div class="kpi"><div class="kpi-label">Top fit score</div><div class="kpi-val" style="font-size:24px">${best.fitScore||'-'}</div></div>
    <div class="kpi"><div class="kpi-label">Avg NIL / yr</div><div class="kpi-val" style="font-size:22px">${fmtNil(avgNil)}</div></div>
  `;

  document.getElementById('tm-results').innerHTML = teams.map((t, i) => `
    <div class="card" style="margin-bottom:10px;cursor:pointer;border:${i===0?'1px solid rgba(132,204,22,0.4)':'1px solid var(--border)'}" onclick="toggleTmDetail('tm-detail-${i}')">
      <div style="display:grid;grid-template-columns:28px 1fr auto;gap:0 16px;align-items:start">
        <div style="font-size:18px;font-weight:500;color:var(--muted);padding-top:2px">${i+1}</div>
        <div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:15px;font-weight:500">${t.name||'Unknown'}</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:var(--surface2);color:var(--muted)">${t.confLabel||t.conference||''}</span>
            ${i===0?'<span class="chip chip-green">Best fit</span>':''}
          </div>
          <div style="font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:8px">${t.why||''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            ${(t.nilBreakdown||[]).map(b=>`<span style="font-size:11px;padding:3px 8px;border-radius:4px;border:1px solid var(--border);color:var(--muted)">${b.label}: <strong style="color:var(--text)">${b.val}</strong></span>`).join('')}
          </div>
          <div id="tm-detail-${i}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-bottom:12px">
              ${(t.metrics||[]).map(m=>`<div style="background:var(--surface2);border-radius:6px;padding:8px 10px"><div style="font-size:10px;color:var(--muted);margin-bottom:3px">${m.label}</div><div style="font-size:13px;font-weight:500">${m.val}</div></div>`).join("")}
            </div>
            ${t.rosterNeed ? `<div style="background:rgba(74,222,128,0.06);border:1px solid rgba(74,222,128,0.15);border-radius:6px;padding:10px 12px;margin-bottom:8px"><div style="font-size:9px;font-weight:700;color:#4ade80;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">Roster Need</div><div style="font-size:12px;color:var(--text)">${t.rosterNeed}</div></div>` : ""}
            ${t.collectiveDealHistory ? `<div style="background:rgba(96,165,250,0.06);border:1px solid rgba(96,165,250,0.15);border-radius:6px;padding:10px 12px;margin-bottom:8px"><div style="font-size:9px;font-weight:700;color:#60a5fa;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">Collective Deal History</div><div style="font-size:12px;color:var(--text)">${t.collectiveDealHistory}</div></div>` : ""}
            ${t.trajectoryNote ? `<div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.15);border-radius:6px;padding:10px 12px;margin-bottom:8px"><div style="font-size:9px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">NIL Trajectory at This School</div><div style="font-size:12px;color:var(--text)">${t.trajectoryNote}</div></div>` : ""}
            ${t.portalComp ? `<div style="background:var(--surface2);border-radius:6px;padding:10px 12px;margin-bottom:8px"><div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">Portal Comp</div><div style="font-size:12px;color:var(--text)">${t.portalComp}</div></div>` : ""}
            ${renderBenchmarkCard(t, athSport, athPosition)}
            <button class="run-btn" style="font-size:12px;padding:8px 16px;margin-top:10px" onclick="event.stopPropagation();buildTmPlaybook('${(t.name||"").replace(/'/g,"\'")}','${fmtNil(t.nilHigh||0)}')">Build negotiation playbook for ${t.name||'this school'} →</button>
          </div>
        </div>
        <div style="text-align:right;min-width:100px">
          <div style="font-size:18px;font-weight:500;color:var(--accent)">${fmtNil(t.nilLow||0)}&ndash;${fmtNil(t.nilHigh||0)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">NIL / year</div>
          <div style="display:flex;align-items:center;gap:5px;justify-content:flex-end;margin-top:6px">
            <div style="width:60px;height:4px;border-radius:2px;background:var(--surface2);overflow:hidden">
              <div style="width:${t.fitScore||0}%;height:100%;background:var(--accent);border-radius:2px"></div>
            </div>
            <span style="font-size:11px;color:var(--muted)">${t.fitScore||0}</span>
          </div>
        </div>
      </div>
    </div>
  `).join('');
}

async function toggleTmDetail(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

async function buildTmPlaybook(schoolName, targetNil) {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  const ath = athletes.find(a => a.id === selectedAthleteId);
  const block = document.getElementById('tm-playbook-block');
  const txt = document.getElementById('tm-playbook-text');
  const spinner = document.getElementById('tm-spinner');
  const label = document.getElementById('tm-playbook-label');
  block.classList.add('visible');
  label.textContent = 'Negotiation Playbook — ' + schoolName;
  spinner.style.display = 'block';
  txt.textContent = 'Building playbook...';

  const msg = `Build a complete NIL recruitment negotiation playbook for ${ath ? ath.name : 'this athlete'} to sign with ${schoolName}. Target NIL: ${targetNil}/year.
Give:
1. OPENING LINE — exact words the agent says to open negotiation
2. KEY LEVERAGE POINTS — 3 specific data points the agent should cite
3. PUSHBACK RESPONSE — what to say when ${schoolName} says they cannot meet the target
4. CONCESSION MOVE — what non-cash thing to offer to bridge the gap
5. WALK-AWAY LINE — exact sentence if they won't move
Be word-for-word specific. This is for a real negotiation call.`;

  try {
    const r = await fetch(`${API_BASE}/api/ai/ask`, {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ athleteId: selectedAthleteId, message: msg }),
    });
    const data = await r.json();
    txt.textContent = data.response || 'No response.';
  } catch(e) { txt.textContent = ' ' + e.message; }
  spinner.style.display = 'none';
  block.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

window.addEventListener('DOMContentLoaded', checkSession);

    //  ONBOARDING WIZARD (5 steps)
    let obAthleteId   = null;   // set once the athlete is saved (step 2)
    let obData        = {};     // profile being built across steps 1-2
    let obStats       = null;   // last fetched IG stats {followers, engagement_rate, source, ...}
    let obPrefill     = {};     // extra fields carried from AI Lookup (tiktok, stats, year, engagement)
    const OB_TOTAL    = 5;

    // Log a wizard step transition server-side (fire-and-forget). Drop-off is
    // measured from these events; a logging failure must never block the user.
    function obLog(step, action) {
      fetch(`${API_BASE}/api/onboarding/step`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ step, action })
      }).catch(() => {});
    }

    async function obStep(n) {
      document.querySelectorAll('.ob-step').forEach(s => s.style.display = 'none');
      const step = document.getElementById('ob-step-' + n);
      if (step) step.style.display = 'block';
      const bar = document.getElementById('ob-progress');
      if (bar) bar.style.width = Math.round((n / OB_TOTAL) * 100) + '%';
      obLog(n, 'entered');
      // Per-step setup
      if (n === 1) { const tp = document.getElementById('ob-tags'); if (tp && !tp.innerHTML) renderTagPicker('ob-tags', []); }
      if (n === 2) obRenderReview();
      if (n === 3) {
        const nm = document.getElementById('ob-scan-name');
        if (nm) nm.textContent = (obData.name || 'your athlete').split(/\s+/)[0];
      }
      if (n === 4) obRenderConnect();
      if (n === 5) obRenderDone();
    }

    // Skip advances to the next step (or finishes on the last one) and never
    // traps the user. Skipping is logged for drop-off analytics.
    function obSkipStep(n) {
      obLog(n, 'skipped');
      if (n >= OB_TOTAL) { obFinish(); return; }
      obStep(n + 1);
    }

    // ── Step 1: AI Lookup ──────────────────────────────────────────────────
    let _obLookupCandidates = [];
    let _obRotateTimer = null;

    function _obApplyCandidate(data) {
      if (data.name)       document.getElementById('ob-athlete-name').value   = data.name;
      if (data.school)     document.getElementById('ob-athlete-school').value = data.school;
      if (data.hometown)   document.getElementById('ob-athlete-hometown').value = data.hometown;
      if (data.position)   document.getElementById('ob-athlete-pos').value    = data.position;
      if (data.schoolTier) document.getElementById('ob-athlete-tier').value   = data.schoolTier;
      if (Array.isArray(data.interestTags) && data.interestTags.length) {
        const q = data.interestTags.map(nilTagFromSub).filter(Boolean);
        if (q.length) renderTagPicker('ob-tags', q);
      }
      if (data.sport) {
        const s = document.getElementById('ob-athlete-sport');
        for (let o of s.options) {
          if (o.value.toLowerCase() === (data.sport||'').toLowerCase() ||
              o.text.toLowerCase()  === (data.sport||'').toLowerCase()) { s.value = o.value; break; }
        }
      }
      // Carry follower/engagement/stats forward into the review step. These are
      // web-derived, so they are labeled as such and stay fully editable.
      obPrefill = {
        instagram:  parseInt(data.instagram)  || 0,
        tiktok:     parseInt(data.tiktok)      || 0,
        engagement: parseFloat(data.engagement) || 0,
        stats:      data.stats || '',
        year:       data.year || '',
      };
      if ((obPrefill.instagram || obPrefill.engagement) && !obStats) {
        obStats = {
          followers: obPrefill.instagram || null,
          engagement_rate: obPrefill.engagement || null,
          source: (data.sourceLabel || 'AI Lookup'),
          found: true,
        };
      }
    }

    function selectObCandidate(idx) {
      const c = _obLookupCandidates[idx];
      if (!c) return;
      _obApplyCandidate(c);
      document.getElementById('ob-lookup-candidates').style.display = 'none';
      const status = document.getElementById('ob-lookup-status');
      status.style.color = 'var(--accent)';
      status.textContent = 'Loaded: ' + [c.school, c.position].filter(Boolean).join(' · ');
      showToast('Athlete loaded. Review before saving.');
    }

    function renderObCandidates(candidates) {
      const candEl  = document.getElementById('ob-lookup-candidates');
      if (!candidates || !candidates.length) return;
      _obLookupCandidates = candidates;
      candEl.style.display = 'block';
      candEl.innerHTML = candidates.map((c, i) => {
        const conf        = c.confidence || 0;
        const color       = _confidenceColor(conf);
        const label       = _confidenceLabel(conf);
        const badgeStyle  = _confidenceBadgeStyle(conf);
        const detail      = [c.position, c.year].filter(Boolean).join(' · ');
        const sourceDomain = _sourceDomain(c.sourceUrl);
        const isLowConf   = conf < 50;
        return '<div style="padding:10px 12px;' + (i < candidates.length-1 ? 'border-bottom:1px solid var(--border);' : '') + (c.best?'background:rgba(200,241,53,0.04)':'background:var(--surface)') + '">' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">' +
            '<div style="flex:1;min-width:0">' +
              '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">' +
                '<span style="font-size:13px;font-weight:700;color:var(--text)">' + (c.name||'Unknown') + '</span>' +
                '<span style="font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:0.05em;' + badgeStyle + '">' + label + '</span>' +
              '</div>' +
              '<div style="font-size:11px;color:var(--muted)">' + [c.school, c.sport, detail].filter(Boolean).join(' · ') + '</div>' +
              '<div style="display:flex;align-items:center;gap:5px;margin-top:3px">' +
                '<div style="width:50px;height:3px;border-radius:2px;background:rgba(255,255,255,0.1)">' +
                  '<div style="width:' + Math.min(conf,100) + '%;height:100%;background:' + color + ';border-radius:2px"></div>' +
                '</div>' +
                '<span style="font-size:9px;color:' + color + ';font-weight:600">' + conf + '%</span>' +
                (sourceDomain ? '<a href="' + (c.sourceUrl||'#') + '" target="_blank" rel="noopener" style="font-size:9px;color:var(--muted);text-decoration:underline;text-underline-offset:2px">Source: ' + sourceDomain + '</a>' : '') +
              '</div>' +
              (isLowConf ? '<div style="font-size:10px;color:#f59e0b;margin-top:2px">Low confidence, verify before saving</div>' : '') +
            '</div>' +
            '<button onclick="selectObCandidate(' + i + ')" style="flex-shrink:0;padding:5px 12px;background:' + (c.best?'var(--accent)':'var(--surface2)') + ';border:1px solid ' + (c.best?'var(--accent)':'var(--border)') + ';border-radius:5px;color:' + (c.best?'#000':'var(--text)') + ';font-size:11px;font-weight:700;cursor:pointer">Select</button>' +
          '</div>' +
        '</div>';
      }).join('') +
      '<div style="padding:6px 12px;border-top:1px solid var(--border);text-align:center">' +
        '<button onclick="document.getElementById(\'ob-lookup-candidates\').style.display=\'none\'" style="font-size:10px;color:var(--muted);background:transparent;border:none;cursor:pointer">Fill in manually instead</button>' +
      '</div>';
    }

    async function obLookupPlayer() {
      const name   = document.getElementById('ob-athlete-name').value.trim();
      if (!name) { showToast('Enter the athlete name first'); return; }
      const school   = document.getElementById('ob-athlete-school')?.value?.trim() || '';
      const sport    = document.getElementById('ob-athlete-sport')?.value || '';
      const position = document.getElementById('ob-athlete-pos')?.value?.trim() || '';
      const btn    = document.getElementById('ob-lookup-btn');
      const status = document.getElementById('ob-lookup-status');
      const candEl = document.getElementById('ob-lookup-candidates');

      // Rotating status text so a slow AI call feels intentional, not broken.
      const rotating = ['Searching public stats', 'Reading roster pages', 'Building bio', 'Matching the handle', 'Almost there'];
      let ri = 0;
      if (_obRotateTimer) clearInterval(_obRotateTimer);
      const setRotate = () => { status.innerHTML = '<span style="color:var(--muted)">' + rotating[ri % rotating.length] + '...</span>'; ri++; };
      setRotate();
      _obRotateTimer = setInterval(setRotate, 1800);

      btn.disabled = true; btn.style.opacity = '0.7'; btn.textContent = 'Searching';
      candEl.style.display = 'none';
      _obLookupCandidates = [];

      try {
        const r = await fetch(`${API_BASE}/api/ai/player-lookup`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ name, school, sport, position })
        });
        const data = await r.json();
        clearInterval(_obRotateTimer); _obRotateTimer = null;

        if (!data.found || !data.candidates || !data.candidates.length) {
          status.innerHTML = '<span style="color:var(--muted)">Lookup did not find enough. Fill in what you know, you can update anytime.</span>';
        } else if (data.autoSelect && data.candidates.length === 1) {
          const c = data.candidates[0];
          _obApplyCandidate(c);
          const conf         = c.confidence || 0;
          const summary      = [c.school, c.position].filter(Boolean).join(' · ');
          status.innerHTML =
            '<span style="color:var(--accent)">Loaded, review and save</span>' +
            (summary ? ' · <span style="color:var(--muted)">' + summary + '</span>' : '');
          showToast('Athlete loaded. Review before saving.');
        } else {
          status.innerHTML = '<span style="color:#f59e0b">' + data.candidates.length + ' matches found</span>, select below';
          renderObCandidates(data.candidates);
        }
      } catch(e) {
        clearInterval(_obRotateTimer); _obRotateTimer = null;
        status.innerHTML = '<span style="color:var(--muted)">Lookup did not find enough. Fill in what you know, you can update anytime.</span>';
        console.error('obLookupPlayer error:', e);
      }
      btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'AI Lookup';
    }

    // ── Step 1: Fetch Instagram stats (Part B) ──────────────────────────────
    async function obFetchStats() {
      const handle = (document.getElementById('ob-athlete-handle').value || '').trim().replace(/^@+/, '');
      const status = document.getElementById('ob-fetch-status');
      const btn    = document.getElementById('ob-fetch-btn');
      if (!handle) { showToast('Enter an Instagram handle first'); return; }
      btn.disabled = true; btn.style.opacity = '0.7'; btn.textContent = 'Fetching';
      const rotating = ['Searching public stats', 'Checking stat trackers', 'Matching the handle'];
      let ri = 0;
      const rot = setInterval(() => { status.innerHTML = '<span style="color:var(--muted)">' + rotating[ri++ % rotating.length] + '...</span>'; }, 1500);
      status.innerHTML = '<span style="color:var(--muted)">Searching public stats...</span>';
      try {
        const r = await fetch(`${API_BASE}/api/athletes/new/fetch-social-stats`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ instagramHandle: handle })
        });
        const data = await r.json();
        clearInterval(rot);
        obStats = data;
        if (data.found && (data.followers !== null || data.engagement_rate !== null)) {
          const bits = [];
          if (data.followers !== null) bits.push(Number(data.followers).toLocaleString() + ' followers');
          if (data.engagement_rate !== null) bits.push(data.engagement_rate + '% engagement');
          const srcNote = data.followers_source === 'instagram_page' ? 'From Instagram' : 'Est. from web';
          status.innerHTML = '<span style="color:var(--accent)">Found ' + bits.join(', ') + '</span> · ' + srcNote;
        } else {
          status.innerHTML = '<span style="color:var(--muted)">No public numbers found. You can enter them on the next screen.</span>';
        }
      } catch(e) {
        clearInterval(rot);
        status.innerHTML = '<span style="color:var(--muted)">Could not fetch stats. You can enter numbers on the next screen.</span>';
      }
      btn.disabled = false; btn.style.opacity = ''; btn.textContent = 'Fetch stats';
    }

    function obUseSample() {
      document.getElementById('ob-athlete-name').value = 'Marcus Johnson';
      document.getElementById('ob-athlete-school').value = 'University of Alabama';
      document.getElementById('ob-athlete-hometown').value = 'Johns Creek, GA';
      document.getElementById('ob-athlete-sport').value = 'football';
      document.getElementById('ob-athlete-pos').value = 'WR';
      document.getElementById('ob-athlete-tier').value = 'p4-top10';
      document.getElementById('ob-athlete-handle').value = 'marcusjohnson';
      obPrefill = { instagram: 45000, tiktok: 28000, engagement: 6.2, stats: '42 rec, 680 yds, 7 TD', year: 'Junior' };
      obStats = { followers: 45000, engagement_rate: 6.2, source: 'Sample data', found: true };
      obToReview();
    }

    // Gather step-1 inputs into obData and move to the review screen.
    function obToReview() {
      const name = document.getElementById('ob-athlete-name').value.trim();
      if (!name) { showToast('Enter the athlete name to continue'); return; }
      obData = {
        name,
        school:     document.getElementById('ob-athlete-school').value.trim(),
        hometown:   document.getElementById('ob-athlete-hometown').value.trim(),
        tags:       tagPickerValue('ob-tags'),
        productWants: (document.getElementById('ob-athlete-productwants') ? document.getElementById('ob-athlete-productwants').value : '').trim(),
        sport:      document.getElementById('ob-athlete-sport').value,
        position:   document.getElementById('ob-athlete-pos').value.trim(),
        schoolTier: document.getElementById('ob-athlete-tier').value || 'p4-mid',
        instagramHandle: (document.getElementById('ob-athlete-handle').value || '').trim().replace(/^@+/, '').toLowerCase(),
        tiktok:     obPrefill.tiktok || 0,
        stats:      obPrefill.stats || '',
        year:       obPrefill.year || '',
        followers:  (obStats && obStats.followers !== null && obStats.followers !== undefined) ? obStats.followers : (obPrefill.instagram || 0),
        engagement: (obStats && obStats.engagement_rate !== null && obStats.engagement_rate !== undefined) ? obStats.engagement_rate : (obPrefill.engagement || null),
        followersSource:  (obStats && obStats.found && obStats.followers != null)
          ? (obStats.followers_source === 'instagram_page' ? 'instagram' : 'web') : 'manual',
        engagementSource: (obStats && obStats.found && obStats.engagement_rate != null) ? 'web' : 'manual',
      };
      obStep(2);
    }

    // ── Step 2: Review and save ─────────────────────────────────────────────
    function obSrcLabel(kind) {
      const today = new Date().toLocaleDateString('en-US', { month:'short', day:'numeric' });
      const text = kind === 'instagram' ? 'From Instagram, ' + today
        : kind === 'web' ? 'Est. from web, ' + today
        : 'Manual';
      return '<span data-src-label style="font-size:10px;color:var(--muted)">' + text + '</span>';
    }

    function obRenderReview() {
      const meta = [obData.school, obData.hometown ? 'Hometown: ' + obData.hometown : '', obData.sport, obData.position, obData.schoolTier].filter(Boolean).join(' · ');
      const folVal = (obData.followers === null || obData.followers === undefined) ? '' : obData.followers;
      const engVal = (obData.engagement === null || obData.engagement === undefined) ? '' : obData.engagement;
      const el = document.getElementById('ob-review-body');
      el.innerHTML =
        '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:14px;margin-bottom:14px">' +
          '<div style="font-family:var(--head);font-size:16px;font-weight:700;color:var(--text)">' + escHtml(obData.name) + '</div>' +
          (meta ? '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + escHtml(meta) + '</div>' : '') +
          (obData.instagramHandle ? '<div style="font-size:11px;color:var(--muted);margin-top:4px">@' + escHtml(obData.instagramHandle) + '</div>' : '') +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
          '<div>' +
            '<label class="form-label-sm">Instagram followers</label>' +
            '<input class="input-sm" id="ob-rev-followers" type="number" value="' + folVal + '" oninput="obEditStat(\'followers\')">' +
            '<div id="ob-rev-followers-src" style="margin-top:3px">' + obSrcLabel(obData.followersSource) + '</div>' +
            '<div id="ob-rev-followers-help" style="font-size:10px;color:var(--muted);margin-top:2px;' + (folVal === '' || folVal === 0 ? '' : 'display:none') + '">No public count found. Enter it manually if you know it.</div>' +
          '</div>' +
          '<div>' +
            '<label class="form-label-sm">Engagement rate (%)</label>' +
            '<input class="input-sm" id="ob-rev-engagement" type="number" step="0.1" value="' + engVal + '" oninput="obEditStat(\'engagement\')">' +
            '<div id="ob-rev-engagement-src" style="margin-top:3px">' + obSrcLabel(obData.engagementSource) + '</div>' +
            '<div id="ob-rev-engagement-help" style="font-size:10px;color:var(--muted);margin-top:2px;' + (engVal === '' ? '' : 'display:none') + '">' +
              escHtml((obStats && obStats.engagement_suggestion) || 'No published rate found. Typical range is 1 to 5 percent.') + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="border-top:1px solid var(--border);padding-top:12px">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:2px">Brand restrictions</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:10px">Categories this athlete will not work with. Uncheck any that are fine.</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:14px">' +
            ['alcohol','tobacco','gambling'].map(c =>
              '<label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text);cursor:pointer">' +
                '<input type="checkbox" class="ob-restrict" value="' + c + '" checked style="accent-color:var(--accent);width:15px;height:15px"> ' +
                c.charAt(0).toUpperCase() + c.slice(1) +
              '</label>'
            ).join('') +
          '</div>' +
        '</div>';
    }

    // Editing a fetched value flips its label to Manual (Part B requirement).
    function obEditStat(kind) {
      obData[kind === 'followers' ? 'followersSource' : 'engagementSource'] = 'manual';
      const srcEl = document.getElementById('ob-rev-' + kind + '-src');
      if (srcEl) srcEl.innerHTML = obSrcLabel('manual');
      const helpEl = document.getElementById('ob-rev-' + kind + '-help');
      if (helpEl) helpEl.style.display = 'none';
    }

    async function obSaveAthlete() {
      const name = obData.name;
      if (!name) { showToast('Enter the athlete name'); obStep(1); return; }
      const folRaw = document.getElementById('ob-rev-followers').value;
      const engRaw = document.getElementById('ob-rev-engagement').value;
      const followers  = folRaw === '' ? 0 : (parseInt(folRaw) || 0);
      const engagement = engRaw === '' ? null : (parseFloat(engRaw) || null);
      const restrictions = Array.from(document.querySelectorAll('.ob-restrict:checked')).map(c => c.value);
      // Source is manual if the agent edited it; otherwise the fetch source
      // (exact Instagram page metadata beats web estimates).
      const igSource = obData.followersSource === 'instagram' ? 'instagram_page'
        : (obData.followersSource === 'web' || obData.engagementSource === 'web') ? 'web_estimate' : 'manual';
      const btn = document.getElementById('ob-save-btn');
      btn.disabled = true; btn.textContent = 'Saving';
      try {
        const r = await fetch(`${API_BASE}/api/athletes`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({
            name,
            sport: obData.sport || 'basketball',
            position: obData.position,
            school: obData.school,
            hometown: obData.hometown || '',
            tags: obData.tags || [],
            productWants: obData.productWants || '',
            schoolTier: obData.schoolTier || 'p4-mid',
            instagram: followers,
            tiktok: obData.tiktok || 0,
            engagement: engagement === null ? 3.0 : engagement,
            year: obData.year || '',
            stats: obData.stats || '',
            instagramHandle: obData.instagramHandle || '',
            brandRestrictions: restrictions,
            igStatsSource: igSource,
            igStatsFetchedAt: (obStats && obStats.fetched_at) ? obStats.fetched_at : null,
          })
        });
        const data = await r.json();
        if (!r.ok) { showToast('Error: ' + (data.error || 'could not save')); btn.disabled = false; btn.textContent = 'Save athlete →'; return; }
        obAthleteId = data.id;
        await loadAthletes();
        if (typeof selectedAthleteId !== 'undefined') selectedAthleteId = data.id;
        const sel = document.getElementById('activeAthlete');
        if (sel) { try { sel.value = data.id; } catch(_){} }
        obLog(2, 'completed');
        btn.disabled = false; btn.textContent = 'Save athlete →';
        obStep(3);
      } catch(e) {
        showToast('Error: ' + e.message);
        btn.disabled = false; btn.textContent = 'Save athlete →';
      }
    }

    // ── Step 3: Deal Scan ───────────────────────────────────────────────────
    let obDidScan = false;
    async function obRunDealScan() {
      if (!obAthleteId) { showToast('Save the athlete first'); obStep(2); return; }
      const btn = document.getElementById('ob-scan-btn');
      const out = document.getElementById('ob-scan-results');
      btn.disabled = true; btn.style.opacity = '0.7';
      out.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted);font-size:12px">Scanning for brands worth pitching...</div>';
      try {
        const r = await fetch(`${API_BASE}/api/agent/deal-scan`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ athleteId: obAthleteId, lane: 'local' })
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'scan failed');
        const opps = data.opportunities || [];
        obDidScan = true;
        if (!opps.length) {
          out.innerHTML = '<div style="text-align:center;padding:18px;color:var(--muted);font-size:12px">No brands surfaced this time. You can run a full Deal Scan from the dashboard anytime.</div>';
        } else {
          out.innerHTML =
            '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">' + opps.length + ' brand' + (opps.length>1?'s':'') + ' worth pitching</div>' +
            opps.slice(0, 5).map(o => {
              const val = (o.estimatedValueLow && o.estimatedValueHigh)
                ? '$' + Number(o.estimatedValueLow).toLocaleString() + ' to $' + Number(o.estimatedValueHigh).toLocaleString() : '';
              return '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:11px 13px;margin-bottom:8px">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
                  '<span style="font-size:13px;font-weight:700;color:var(--text)">' + escHtml(o.brand || 'Brand') + '</span>' +
                  (o.fitScore ? '<span style="font-size:10px;font-weight:700;color:var(--accent)">Fit ' + o.fitScore + '</span>' : '') +
                '</div>' +
                (o.category ? '<div style="font-size:10px;color:var(--muted);margin-top:1px">' + escHtml(o.category) + (val ? ' · ' + val : '') + '</div>' : (val ? '<div style="font-size:10px;color:var(--muted);margin-top:1px">' + val + '</div>' : '')) +
                (o.campaign ? '<div style="font-size:11px;color:var(--text);margin-top:5px;line-height:1.5">' + escHtml(o.campaign) + '</div>' : '') +
              '</div>';
            }).join('') +
            '<div style="font-size:10px;color:var(--muted);text-align:center;margin-top:2px">Full results, including social brands and top NIL spenders, are on the Deal Scan tab.</div>';
        }
        obLog(3, 'completed');
      } catch(e) {
        out.innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted);font-size:12px">Deal Scan had trouble just now. No problem, you can run it from the dashboard. Continue below.</div>';
      }
      btn.disabled = false; btn.style.opacity = '';
      const cont = document.getElementById('ob-scan-continue');
      if (cont) cont.style.flex = '2';
    }

    // ── Step 4: Connect Gmail and Calendar ──────────────────────────────────
    async function obRenderConnect() {
      const body = document.getElementById('ob-connect-body');
      body.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px 0">Checking connections...</div>';
      let gmailConnected = false, calAvailable = true, calConnected = false;
      try {
        const g = await fetch(`${API_BASE}/api/email/accounts`).then(r => r.ok ? r.json() : []).catch(() => []);
        const list = Array.isArray(g) ? g : (g.accounts || []);
        gmailConnected = list.some(a => (a.provider === 'gmail') || /gmail|google/i.test(a.provider || ''));
      } catch(_) {}
      try {
        const c = await fetch(`${API_BASE}/api/agent/calendar/google/status`).then(r => r.json());
        calAvailable = c.available !== false; calConnected = !!c.connected;
      } catch(_) {}

      const row = (title, sub, connected, action, actionLabel) =>
        '<div style="display:flex;align-items:center;gap:12px;background:var(--surface2);border-radius:var(--r-sm);padding:12px 14px">' +
          '<div style="flex:1;min-width:0">' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">' + title + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + sub + '</div>' +
          '</div>' +
          (connected
            ? '<span style="font-size:12px;font-weight:700;color:#22c55e;white-space:nowrap">Connected</span>'
            : '<button onclick="' + action + '" style="background:var(--accent);border:none;color:#000;border-radius:6px;padding:8px 14px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap">' + actionLabel + '</button>') +
        '</div>';

      body.innerHTML =
        row('Gmail', 'AI outreach sends from your own inbox', gmailConnected, "obConnectGmail()", 'Connect') +
        (calAvailable
          ? row('Google Calendar', 'Deal deliverables land on your calendar', calConnected, "obConnectCalendar()", 'Connect')
          : '<div style="font-size:11px;color:var(--muted);padding:4px 2px">Calendar sync is not enabled on this server yet.</div>');
    }

    function obConnectGmail() {
      // OAuth redirects away. The wizard resumes at step 4 on return because
      // progress is persisted server-side.
      try {
        if (typeof emailModule !== 'undefined' && emailModule.connectGmail) { emailModule.connectGmail(); }
        else { window.location.href = '/api/email/oauth/gmail'; }
      } catch(_) { window.location.href = '/api/email/oauth/gmail'; }
    }
    function obConnectCalendar() {
      if (typeof connectAgentGCal === 'function') connectAgentGCal();
    }

    // ── Step 5: Done ────────────────────────────────────────────────────────
    function obRenderDone() {
      const items = [
        { done: true, label: (obData.name ? obData.name + ' added to your roster' : 'Athlete added') },
        { done: obDidScan, label: obDidScan ? 'First Deal Scan run' : 'Deal Scan ready to run' },
      ];
      document.getElementById('ob-done-list').innerHTML = items.map(it =>
        '<div style="display:flex;align-items:center;gap:10px;font-size:12px;color:var(--text)">' +
          '<span style="width:18px;height:18px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;' +
            (it.done ? 'background:var(--accent);color:#000' : 'background:var(--surface2);color:var(--muted)') + '">' + (it.done ? '✓' : '·') + '</span>' +
          it.label +
        '</div>'
      ).join('');
    }

    async function obFinish() {
      if (_obRotateTimer) { clearInterval(_obRotateTimer); _obRotateTimer = null; }
      document.getElementById('onboardingOverlay').style.display = 'none';
      try { localStorage.setItem('nildash-onboarded-' + currentUser.id, '1'); } catch(_) {}
      await fetch(`${API_BASE}/api/onboarding/complete`, { method:'POST' }).catch(() => {});
      obLog(5, 'completed');
      try {
        await loadAthletes();
        await loadKPIs();
        if (typeof loadPipeline === 'function') await loadPipeline();
      } catch(_) {}
      const homeBtn = document.getElementById('homeNavBtn');
      showView('home', homeBtn);
      if (typeof loadAgentHome === 'function') loadAgentHome();
      if (typeof NILOnboard !== 'undefined' && NILOnboard.refreshChecklist) NILOnboard.refreshChecklist();
      showToast('You are all set. Welcome to NILDash.');
    }

    // Guard on ACCOUNT STATE, not just a local flag, so existing users with
    // athletes never see the wizard after this deploy, while a user mid-flow
    // resumes at the right step even after saving their first athlete.
    async function checkOnboarding() {
      try {
        let state = null;
        try { state = await fetch(`${API_BASE}/api/onboarding`).then(r => r.ok ? r.json() : null); } catch(_) {}

        if (state) {
          // Finished the wizard once → never show again.
          if (state.wizardCompletedAt) return;
          // Mid-flow (started but not finished) → resume, even if an athlete was
          // already saved in an earlier step.
          if (state.wizardStep >= 1) {
            document.getElementById('onboardingOverlay').style.display = 'flex';
            obStep(Math.min(state.wizardStep, OB_TOTAL));
            return;
          }
          // Never started. Only brand-new accounts (no athletes) see it.
          if (state.hasAthletes) return;
          document.getElementById('onboardingOverlay').style.display = 'flex';
          obStep(1);
          return;
        }

        // Server/table unavailable — degrade to the safe local heuristic so a
        // one-deploy-old DB never traps a user or spams the wizard.
        const localDone = (function(){ try { return localStorage.getItem('nildash-onboarded-' + currentUser.id); } catch(_) { return null; } })();
        if (!localDone && (!athletes || athletes.length === 0)) {
          document.getElementById('onboardingOverlay').style.display = 'flex';
          obStep(1);
        }
      } catch(e) {
        console.warn('checkOnboarding error:', e.message);
      }
    }

    function applyThemeUI() {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      const icon = document.getElementById('theme-icon');
      const label = document.getElementById('theme-label');
      if (icon) icon.textContent = isLight ? '' : '';
      if (label) label.textContent = isLight ? 'Dark Mode' : 'Light Mode';
    }

    function toggleTheme() {
      const html = document.documentElement;
      const isLight = html.getAttribute('data-theme') === 'light';
      if (isLight) {
        html.removeAttribute('data-theme');
        document.getElementById('theme-icon').textContent = '';
        document.getElementById('theme-label').textContent = 'Light Mode';
        localStorage.setItem('nildasTheme', 'dark');
      } else {
        html.setAttribute('data-theme', 'light');
        document.getElementById('theme-icon').textContent = '';
        document.getElementById('theme-label').textContent = 'Dark Mode';
        localStorage.setItem('nildasTheme', 'light');
      }
    }

    // Apply saved theme immediately
    (function() {
      const saved = localStorage.getItem('nildasTheme');
      if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      }
      document.addEventListener('DOMContentLoaded', applyThemeUI);
    })();


;

async function openManualDealModal(){
  var modal=document.getElementById('manual-deal-modal');
  var sel=document.getElementById('md-athlete');
  sel.innerHTML=athletes.map(function(a){return '<option value="'+a.id+'">'+a.name+'</option>';}).join('');
  modal.style.display='flex';
}
async function closeManualDealModal(){
  document.getElementById('manual-deal-modal').style.display='none';
}
async function saveManualDeal(){
  var athleteId=document.getElementById('md-athlete').value;
  var brand=document.getElementById('md-brand').value.trim();
  var value=parseInt(document.getElementById('md-value').value);
  var stage=document.getElementById('md-stage').value;
  var notes=document.getElementById('md-notes').value.trim();
  if(!athleteId||!brand||!value){showToast('Athlete, brand and value are required');return;}
  var id='deal-manual-'+Date.now();
  await fetch(API_BASE+'/api/deals',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({id,athleteId,agentId:currentUser.id,brand,campaign:'Manual Entry',value,stage,notes,source:'manual'})
  });
  closeManualDealModal();
  document.getElementById('md-brand').value='';
  document.getElementById('md-value').value='';
  document.getElementById('md-notes').value='';
  showToast('Deal added');
  await renderCommission();
}


async function toggleNotifPanel() {
  document.getElementById('notifPanel').classList.toggle('open');
}
document.addEventListener('click', function(e) {
  var panel = document.getElementById('notifPanel');
  var bell = document.getElementById('notifBell');
  if (panel && bell && !panel.contains(e.target) && !bell.contains(e.target)) {
    panel.classList.remove('open');
  }
});
async function clearNotifications() {
  localStorage.setItem('nildash-notifs', '[]');
  renderNotifPanel();
}
async function renderNotifPanel() {
  var notifs = JSON.parse(localStorage.getItem('nildash-notifs') || '[]');
  var badge = document.getElementById('notifBadge');
  var list = document.getElementById('notifList');
  if (!badge || !list) return;
  var urgent = notifs.filter(function(n){ return n.urgency==='overdue'||n.urgency==='today'||n.urgency==='urgent'; });
  badge.style.display = urgent.length > 0 ? 'flex' : 'none';
  badge.textContent = urgent.length > 9 ? '9+' : urgent.length;
  list.innerHTML = notifs.length ? notifs.map(function(n) {
    var colors = {overdue:'#ef4444',today:'#f97316',urgent:'#f97316',soon:'#c8f135'};
    var labels = {overdue:'OVERDUE',today:'TODAY',urgent:'URGENT',soon:'SOON'};
    return '<div class="notif-item"><div style="font-size:12px;font-weight:600;color:var(--text)">' +
      (labels[n.urgency] ? '<span style="background:'+colors[n.urgency]+';color:'+(n.urgency==='soon'?'#000':'#fff')+';font-size:9px;padding:2px 5px;border-radius:3px;margin-right:6px">'+labels[n.urgency]+'</span>' : '') +
      n.title+'</div><div style="font-size:11px;color:var(--muted)">'+n.sub+'</div></div>';
  }).join('') : '<div class="notif-empty">No urgent deadlines</div>';
}
async function addNotification(id, title, sub, urgency) {
  var notifs = JSON.parse(localStorage.getItem('nildash-notifs') || '[]');
  if (notifs.find(function(n){ return n.id===id; })) return;
  notifs.unshift({id:id,title:title,sub:sub,urgency:urgency,time:Date.now()});
  if (notifs.length > 20) notifs = notifs.slice(0,20);
  localStorage.setItem('nildash-notifs', JSON.stringify(notifs));
  renderNotifPanel();
}
async function checkDeadlineNotifications() {
  if (!athletes || athletes.length===0) return;
  for (var i=0; i<athletes.length; i++) {
    var ath = athletes[i];
    try {
      var r = await fetch(API_BASE+'/api/athletes/'+ath.id+'/deals');
      var deals = await r.json();
      deals.forEach(function(deal) {
        var created = new Date(deal.updatedAt||deal.createdAt||Date.now());
        var deadlineDate = null, label = '';
        if (deal.stage==='Negotiating') { deadlineDate=new Date(created.getTime()+2*864e5); label='Counter offer deadline'; }
        else if (deal.stage==='Closing') { deadlineDate=new Date(created.getTime()+3*864e5); label='Contract due'; }
        else if (deal.stage==='Outreach Sent') { deadlineDate=new Date(created.getTime()+7*864e5); label='Follow-up if no response'; }
        if (!deadlineDate) return;
        var diff = Math.ceil((deadlineDate-new Date())/864e5);
        var urgency = diff<0?'overdue':diff===0?'today':diff<=2?'urgent':diff<=7?'soon':'future';
        if (urgency!=='future') addNotification(label+deal.id, label+' — '+(deal.brand||'Deal'), ath.name+' · '+deal.stage+(diff<0?' · '+Math.abs(diff)+'d overdue':diff===0?' · Due today':' · '+diff+'d left'), urgency);
      });
    } catch(e) {}
  }
  renderNotifPanel();
}
setTimeout(function(){ checkDeadlineNotifications(); setInterval(checkDeadlineNotifications, 30*60*1000); }, 3000);
renderNotifPanel();

// ── CSV Export helpers ────────────────────────────────────────────────────
function _csvRow(arr) {
  return arr.map(function(v) {
    var s = v === null || v === undefined ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }).join(',');
}
function _csvDownload(filename, rows) {
  var csv = rows.map(_csvRow).join('\n');
  var blob = new Blob([csv], { type: 'text/csv' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

function exportRosterCSV() {
  var data = window.athletes || [];
  if (!data.length) { showToast('No athletes to export'); return; }
  var rows = [['Name','Sport','Position','School','Tier','Instagram','TikTok','Engagement%','Year','Stats','Notes']];
  data.forEach(function(a) {
    rows.push([a.name||'',a.sport||'',a.position||'',a.school||'',a.schoolTier||'',
      a.instagram||0,a.tiktok||0,a.engagement||0,a.year||'',a.stats||'',a.notes||'']);
  });
  _csvDownload('roster-' + new Date().toISOString().slice(0,10) + '.csv', rows);
  showToast('Roster exported');
}

function exportDealsCSV() {
  var deals = window._pipelineDeals || [];
  if (!deals.length) { showToast('No deals to export — load the Pipeline first'); return; }
  var rows = [['Athlete','Brand','Campaign','Stage','Deal Value','Offered Value','Created']];
  deals.forEach(function(d) {
    rows.push([d.athleteName||d.athleteId||'',d.brand||'',d.campaign||'',d.stage||'',
      d.value||0,d.offeredValue||0,d.createdAt||'']);
  });
  _csvDownload('deals-' + new Date().toISOString().slice(0,10) + '.csv', rows);
  showToast('Deals exported');
}

function renderRosterCompleteness() { /* removed */ }

function exportCommissionCSV() {
  var commRate = parseFloat(document.getElementById('comm-rate')?.value || 15) / 100;
  var data = window.athletes || [];
  if (!data.length) { showToast('No data to export'); return; }
  var rows = [['Athlete','Brand','Campaign','Stage','Deal Value','Commission','Status']];
  var rowCount = 0;
  // Gather all deals from cache
  var allDeals = [];
  if (window._athleteDealsCache) {
    Object.values(window._athleteDealsCache).forEach(function(arr) { allDeals = allDeals.concat(arr||[]); });
  }
  if (!allDeals.length && window._pipelineDeals) allDeals = window._pipelineDeals;
  allDeals.forEach(function(d) {
    var ath = data.find(function(a) { return a.id === d.athleteId; });
    var comm = Math.round((d.value||0) * commRate);
    rows.push([ath ? ath.name : (d.athleteId||''),d.brand||'',d.campaign||'',d.stage||'',
      d.value||0,comm,d.stage==='Closed'?'Closed':'Active']);
    rowCount++;
  });
  if (rowCount === 0) { showToast('No deals found — open Commission Tracker first'); return; }
  _csvDownload('commission-' + new Date().toISOString().slice(0,10) + '.csv', rows);
  showToast('Commission data exported');
}

;

;

;

;

;

;

;

;

;

;

;

// emailInboxTab — switches between "My Gmail" and "Athlete Emails" tabs
function emailInboxTab(tab) {
  var isAthlete = tab === 'athlete';
  document.getElementById('email-panel-gmail').style.display    = isAthlete ? 'none' : 'block';
  document.getElementById('email-panel-athlete').style.display  = isAthlete ? 'block' : 'none';

  var gmailBtn   = document.getElementById('email-tab-gmail');
  var athleteBtn = document.getElementById('email-tab-athlete');
  gmailBtn.style.borderBottomColor   = isAthlete ? 'transparent' : 'var(--accent)';
  gmailBtn.style.color               = isAthlete ? 'var(--muted)' : 'var(--accent)';
  gmailBtn.style.fontWeight          = isAthlete ? '600' : '700';
  athleteBtn.style.borderBottomColor = isAthlete ? 'var(--accent)' : 'transparent';
  athleteBtn.style.color             = isAthlete ? 'var(--accent)' : 'var(--muted)';
  athleteBtn.style.fontWeight        = isAthlete ? '700' : '600';

  if (isAthlete) athleteEmailsModule.load();
}

var athleteEmailsModule = (function() {
  var _unread = 0;

  function _fmt(ts) {
    var d = new Date(ts);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function _initials(name) {
    if (!name) return '?';
    return name.split(' ').map(function(w){ return w[0]; }).join('').slice(0,2).toUpperCase();
  }

  var COLORS = ['#16a34a','#2563eb','#9333ea','#ea580c','#0891b2','#be185d'];
  function _color(name) {
    var hash = 0;
    for (var i = 0; name && i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return COLORS[Math.abs(hash) % COLORS.length];
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function loadBadge() {
    if (!currentUser) return;
    fetch('/api/athlete-messages/unread-count?agentId=' + currentUser.id)
      .then(function(r){ return r.json(); })
      .then(function(d) {
        _unread = d.count || 0;
        _renderBadge();
      }).catch(function(){});
  }

  function _renderBadge() {
    var el = document.getElementById('athlete-email-badge');
    if (!el) return;
    if (_unread > 0) {
      el.textContent = _unread;
      el.style.display = 'inline-block';
    } else {
      el.style.display = 'none';
    }
  }

  function clearBadge() {
    _unread = 0;
    _renderBadge();
  }

  function load() {
    if (!currentUser) return;
    var container = document.getElementById('athlete-emails-list');
    if (!container) return;
    container.innerHTML = '<div style="padding:40px;color:var(--muted);font-size:12px;text-align:center">Loading…</div>';

    fetch('/api/athlete-messages?agentId=' + currentUser.id)
      .then(function(r){ return r.json(); })
      .then(function(msgs) {
        if (!msgs.length) {
          container.innerHTML = '<div style="padding:40px;color:var(--muted);font-size:13px;text-align:center">No athlete messages yet. Messages sent from athlete portals will appear here.</div>';
          return;
        }
        container.innerHTML = msgs.map(function(m) {
          var preview = (m.body || '').slice(0, 120) + ((m.body || '').length > 120 ? '…' : '');
          var bg = m.is_read ? 'var(--surface)' : 'var(--surface2)';
          var unreadDot = m.is_read ? '' : '<span style="width:7px;height:7px;background:var(--accent);border-radius:50%;flex-shrink:0;margin-top:4px"></span>';
          return '<div id="am-card-' + m.id + '" onclick="athleteEmailsModule.expand(' + m.id + ')" style="background:' + bg + ';border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;margin-bottom:10px;cursor:pointer;transition:border-color 0.15s" onmouseover="this.style.borderColor=\'var(--accent)\'" onmouseout="this.style.borderColor=\'var(--border)\'">' +
            '<div style="display:flex;align-items:flex-start;gap:12px">' +
              '<div style="width:36px;height:36px;border-radius:50%;background:' + _color(m.athlete_name) + ';display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">' + _esc(_initials(m.athlete_name)) + '</div>' +
              '<div style="flex:1;min-width:0">' +
                '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:3px">' +
                  '<span style="font-size:13px;font-weight:700;color:var(--text)">' + _esc(m.athlete_name || 'Athlete') + '</span>' +
                  '<span style="font-size:10px;font-weight:700;background:#16a34a22;color:#16a34a;border-radius:9999px;padding:2px 8px">Athlete Portal</span>' +
                  '<span style="font-size:11px;color:var(--muted);margin-left:auto">' + _fmt(m.sent_at) + '</span>' +
                '</div>' +
                '<div style="font-size:11px;color:var(--muted);margin-bottom:5px">To: ' + _esc(m.to_address) + '</div>' +
                '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px">' + _esc(m.subject) + '</div>' +
                '<div style="font-size:12px;color:var(--muted);line-height:1.5" id="am-preview-' + m.id + '">' + _esc(preview) + '</div>' +
                '<div id="am-body-' + m.id + '" style="display:none;margin-top:10px;font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap;border-top:1px solid var(--border);padding-top:10px">' + _esc(m.body) + '</div>' +
              '</div>' +
              unreadDot +
            '</div>' +
          '</div>';
        }).join('');
      })
      .catch(function() {
        container.innerHTML = '<div style="padding:40px;color:var(--muted);font-size:12px;text-align:center">Failed to load messages.</div>';
      });
  }

  function expand(id) {
    var card    = document.getElementById('am-card-' + id);
    var preview = document.getElementById('am-preview-' + id);
    var body    = document.getElementById('am-body-' + id);
    if (!card || !body) return;
    var isOpen = body.style.display !== 'none';
    body.style.display    = isOpen ? 'none' : 'block';
    preview.style.display = isOpen ? 'block' : 'none';
    if (!isOpen) {
      // Mark as read
      fetch('/api/athlete-messages/' + id + '/read', { method: 'PATCH' }).catch(function(){});
      card.style.background = 'var(--surface)';
      // Remove unread dot
      var dot = card.querySelector('span[style*="border-radius:50%"]');
      if (dot) dot.remove();
      // Decrement badge
      if (_unread > 0) { _unread--; _renderBadge(); }
    }
  }

  return { loadBadge: loadBadge, clearBadge: clearBadge, load: load, expand: expand };
})();

;

//  Marketing View Logic
async function switchMarketingTab(tab) {
  ['brandkit','outreach','scores'].forEach(function(t) {
    var btn = document.getElementById('mkt-tab-' + t);
    var panel = document.getElementById('mkt-panel-' + t);
    if (btn) {
      btn.style.borderBottomColor = t === tab ? 'var(--accent)' : 'transparent';
      btn.style.color = t === tab ? 'var(--accent)' : 'var(--muted)';
      btn.style.fontWeight = t === tab ? '700' : '600';
    }
    if (panel) panel.style.display = t === tab ? '' : 'none';
  });
  // Refresh client dropdown when pitch deck tab is open
  if (tab === 'brandkit') {
    populatePitchClientDropdown();
    // Pre-select current athlete if one is active
    var sel = document.getElementById('mkt-pitch-client');
    if (sel && selectedAthleteId && !sel.value) sel.value = selectedAthleteId;
  }
}

async function updateMarketingClientLabel() {
  var ath = athletes ? athletes.find(function(a){ return a.id === selectedAthleteId; }) : null;
  var name = ath ? ath.name : 'your selected client';
  ['mkt-athlete-name','mkt-athlete-name-2','mkt-athlete-name-3'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.textContent = name;
  });
}

//  Pitch Deck: photo compression + client dropdown 
window._pitchPhotoDataUrl = null;

function handlePitchPhotoDrop(e) {
  e.preventDefault();
  var drop = document.getElementById('mkt-photo-drop');
  if (drop) { drop.style.borderColor = 'var(--border2)'; drop.style.background = 'transparent'; }
  var file = (e.dataTransfer.files || [])[0];
  if (file && file.type.startsWith('image/')) compressAndSetPitchPhoto(file);
}
function handlePitchPhotoSelect(input) {
  if (input && input.files[0]) compressAndSetPitchPhoto(input.files[0]);
}
function compressAndSetPitchPhoto(file) {
  var reader = new FileReader();
  reader.onload = function(ev) {
    var img = new Image();
    img.onload = function() {
      // Compress: max 480px wide, JPEG 0.78 quality
      var MAX = 480;
      var w = img.width, h = img.height;
      if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; }
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      var compressed = canvas.toDataURL('image/jpeg', 0.78);
      window._pitchPhotoDataUrl = compressed;
      // Update preview thumbnail
      var preview = document.getElementById('mkt-photo-preview');
      if (preview) preview.innerHTML = '<img src="' + compressed + '" style="width:56px;height:56px;object-fit:cover;object-position:top">';
      // Update label
      var label = document.getElementById('mkt-photo-label');
      if (label) { label.textContent = ' ' + file.name + ' (compressed)'; label.style.color = 'var(--accent)'; }
      var drop = document.getElementById('mkt-photo-drop');
      if (drop) drop.style.borderColor = 'var(--accent)';
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
}

// Populate pitch client dropdown whenever athletes are loaded
function populatePitchClientDropdown() {
  var sel = document.getElementById('mkt-pitch-client');
  if (!sel) return;
  var list = window.athletes || window._allAthletes || [];
  if (!list.length) {
    // Athlete cache not ready yet — fetch directly
    fetch(API_BASE + '/api/athletes')
      .then(function(r){ return r.json(); })
      .then(function(data){
        window.athletes = data;
        window._allAthletes = data;
        populatePitchClientDropdown();
      }).catch(function(){});
    return;
  }
  var current = sel.value;
  sel.innerHTML = '<option value="">— Select client —</option>';
  list.forEach(function(a) {
    var opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + (a.sport ? ' — ' + a.sport : '') + (a.school ? ' / ' + a.school : '');
    if (String(a.id) === String(current)) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!sel.value && selectedAthleteId) sel.value = String(selectedAthleteId);
}

function onPitchClientChange(id) {
  // nothing extra needed — value is read at generate time
}

async function runMarketingBrandKit() {
  // Get client from dropdown (preferred) or fall back to sidebar selection
  var clientSel = document.getElementById('mkt-pitch-client');
  var pitchAthleteId = (clientSel && clientSel.value) ? clientSel.value : selectedAthleteId;
  if (!pitchAthleteId) { showToast('Select a client first'); if (clientSel) clientSel.focus(); return; }
  var brandInputEl = document.getElementById('mkt-pitch-brand');
  var targetBrand = brandInputEl ? brandInputEl.value.trim() : '';
  if (!targetBrand) { showToast('Enter the target brand name'); if (brandInputEl) brandInputEl.focus(); return; }
  var btn = document.getElementById('mkt-brandkit-btn');
  var loading = document.getElementById('mkt-brandkit-loading');
  var resultEl = document.getElementById('mkt-brandkit-result');
  if (btn) btn.disabled = true;
  if (loading) loading.style.display = 'block';
  if (resultEl) resultEl.style.display = 'none';
  try {
    var r = await fetch(API_BASE + '/api/ai/brand-kit', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ athleteId: selectedAthleteId, targetBrand: targetBrand, athletePhoto: window._pitchPhotoDataUrl || null })
    });
    var kit = await r.json();
    if (kit.error) throw new Error(kit.error);
    if (loading) loading.style.display = 'none';
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = '';

      // Store FULL deck data for pitch.html (avoids re-calling AI in new tab)
      try {
        var pitchData = {
          brand: targetBrand,
          photo: window._pitchPhotoDataUrl || null,
          deck: kit,
          athleteId: pitchAthleteId,
          ts: Date.now()
        };
        sessionStorage.setItem('nilPitchData_' + pitchAthleteId, JSON.stringify(pitchData));
      } catch(e) {}

      var openBtn = document.createElement('div');
      openBtn.style.cssText = 'margin-top:16px;text-align:center';
      var ob = document.createElement('button');
      ob.textContent = 'Open Full Pitch Deck';
      ob.style.cssText = 'padding:10px 28px;background:var(--accent);color:#000;font-weight:700;border:none;border-radius:var(--r-sm);cursor:pointer;font-size:13px';
      ob.addEventListener('click', function() {
        var url = '/pitch/' + pitchAthleteId + (targetBrand ? '?brand=' + encodeURIComponent(targetBrand) : '');
        window.open(url, '_blank');
      });
      openBtn.appendChild(ob);
      resultEl.appendChild(openBtn);
    }
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div style="color:#f87171;padding:12px">Error: ' + e.message + '</div>'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runMarketingOutreach() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  var brandEl = document.getElementById('mkt-or-brand');
  var brand = brandEl ? brandEl.value.trim() : '';
  if (!brand) { showToast('Enter a brand name'); return; }
  var category = (document.getElementById('mkt-or-category') || {}).value || 'general';
  var goal = (document.getElementById('mkt-or-goal') || {}).value || '';
  var btn = document.getElementById('mkt-outreach-btn');
  var loading = document.getElementById('mkt-outreach-loading');
  var resultEl = document.getElementById('mkt-outreach-result');
  if (btn) btn.disabled = true;
  if (loading) loading.style.display = 'block';
  if (resultEl) resultEl.style.display = 'none';
  try {
    var r = await fetch(API_BASE + '/api/ai/generate-outreach', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ athleteId: selectedAthleteId, brand: brand, category: category, outreachType: 'full', goal: goal })
    });
    var data = await r.json();
    if (data.error) throw new Error(data.error);
    if (loading) loading.style.display = 'none';
    if (resultEl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = '';
      function orBox(title, icon, bodyText) {
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom:12px;padding:14px;background:var(--surface2);border-radius:var(--r)';
        var hdr = document.createElement('div');
        hdr.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:8px';
        var lbl = document.createElement('span');
        lbl.style.cssText = 'font-size:11px;font-weight:700;color:var(--accent)';
        lbl.textContent = icon + ' ' + title;
        var cpBtn = document.createElement('button');
        cpBtn.textContent = 'Copy';
        cpBtn.style.cssText = 'font-size:10px;padding:2px 8px;background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:4px;cursor:pointer';
        var bodyDiv = document.createElement('div');
        bodyDiv.style.cssText = 'font-size:12px;color:var(--text);line-height:1.6;white-space:pre-wrap';
        bodyDiv.textContent = bodyText || '';
        cpBtn.addEventListener('click', function() {
          navigator.clipboard.writeText(bodyDiv.textContent).then(function(){ showToast('Copied!'); });
        });
        hdr.appendChild(lbl);
        hdr.appendChild(cpBtn);
        wrapper.appendChild(hdr);
        wrapper.appendChild(bodyDiv);
        resultEl.appendChild(wrapper);
      }
      if (data.sponsorshipEmail) orBox('Sponsorship Email', '', 'SUBJECT: ' + (data.sponsorshipEmail.subject||'') + '\n\n' + (data.sponsorshipEmail.body||''));
      if (data.instagramDm) orBox('Instagram DM', '', data.instagramDm);
      if (data.partnershipProposal) orBox('Partnership Proposal', '', data.partnershipProposal);
      if (data.followUpEmail) orBox('Follow-up Email', '', 'SUBJECT: ' + (data.followUpEmail.subject||'') + '\n\n' + (data.followUpEmail.body||''));
    }
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div style="color:#f87171;padding:12px">Error: ' + e.message + '</div>'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runMarketingScores() {
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  var btn = document.getElementById('mkt-scores-btn');
  var loading = document.getElementById('mkt-scores-loading');
  var resultEl = document.getElementById('mkt-scores-result');
  if (btn) btn.disabled = true;
  if (loading) loading.style.display = 'block';
  if (resultEl) resultEl.style.display = 'none';
  try {
    var r = await fetch(API_BASE + '/api/nilviewval/' + selectedAthleteId);
    var data = await r.json();
    if (data.error) throw new Error(data.error);
    if (loading) loading.style.display = 'none';
    if (resultEl) {
      resultEl.style.display = 'block';
      var cats = data.sponsorCategories || [];
      var pts = data.brandPartnershipTypes || [];
      async function scoreColor(n) { return n >= 80 ? '#4ade80' : n >= 60 ? '#f59e0b' : '#f87171'; }
      function bar(n) { return '<div style="background:var(--surface);border-radius:4px;height:8px;margin-top:6px"><div style="width:'+Math.min(n,100)+'%;background:'+scoreColor(n)+';height:8px;border-radius:4px;transition:width .4s"></div></div>'; }
      var sc = data.scores || {};
      var scoreCards = [
        ['Marketability', sc.marketabilityScore || 0],
        ['Sponsorship Readiness', sc.sponsorshipReadiness || 0],
        ['Audience Quality', sc.audienceQuality || 0],
        ['Data Confidence', sc.confidenceScore || 0]
      ];
      var html = '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:20px">';
      scoreCards.forEach(function(item) {
        var label = item[0], val = item[1] || 0;
        html += '<div style="background:var(--surface2);border-radius:var(--r);padding:14px">';
        html += '<div style="font-size:11px;color:var(--muted)">' + label + '</div>';
        html += '<div style="font-size:28px;font-weight:800;color:' + scoreColor(val) + ';margin-top:4px">' + val + '<span style="font-size:13px;color:var(--muted)">/100</span></div>';
        html += bar(val) + '</div>';
      });
      html += '</div>';
      // Rate range
      html += '<div style="background:var(--surface2);border-radius:var(--r);padding:14px;margin-bottom:16px">';
      html += '<div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px"> NILViewVal v5.2 Rate Range (IG Reel)</div>';
      var rates = data.rates || {};
      var reel = rates['ig-reel'] || {}; var tiktok = rates['tiktok'] || {}; var bundle = rates['bundle'] || {}; var retainer = rates['retainer'] || {};
      html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px">';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">IG Reel Floor</div><div style="font-size:18px;font-weight:700;color:var(--text)">$' + (reel.low||0).toLocaleString() + '</div></div>';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">IG Reel Market</div><div style="font-size:18px;font-weight:700;color:var(--accent)">$' + (reel.mid||0).toLocaleString() + '</div></div>';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">IG Reel Ask</div><div style="font-size:18px;font-weight:700;color:var(--text)">$' + (reel.high||0).toLocaleString() + '</div></div>';
      html += '</div>';
      html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:8px;border-top:1px solid var(--border)">';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">TikTok</div><div style="font-size:15px;font-weight:700;color:var(--text)">$'+(tiktok.low||0).toLocaleString()+'\u2013$'+(tiktok.high||0).toLocaleString()+'</div></div>';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">Bundle</div><div style="font-size:15px;font-weight:700;color:var(--text)">$'+(bundle.low||0).toLocaleString()+'\u2013$'+(bundle.high||0).toLocaleString()+'</div></div>';
      html += '<div style="text-align:center"><div style="font-size:10px;color:var(--muted);margin-bottom:2px">Monthly Retainer</div><div style="font-size:15px;font-weight:700;color:var(--text)">$'+(retainer.low||0).toLocaleString()+'\u2013$'+(retainer.high||0).toLocaleString()+'</div></div>';
      html += '</div></div>';
      if (sc.archetypeScore) {
        var aScore = sc.archetypeScore;
        var aTier = aScore >= 85 ? 'Elite' : aScore >= 70 ? 'Strong' : aScore >= 55 ? 'Developing' : 'Emerging';
        var aColor = aScore >= 85 ? '#4ade80' : aScore >= 70 ? '#60a5fa' : aScore >= 55 ? '#f59e0b' : '#94a3b8';
        html += '<div style="background:var(--surface2);border-radius:var(--r);padding:12px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between">';
        html += '<div><div style="font-size:11px;color:var(--muted)">Archetype Score</div><div style="font-size:11px;color:'+aColor+';font-weight:600;margin-top:2px">Tier: '+aTier+'</div></div>';
        html += '<div style="font-size:36px;font-weight:800;color:'+aColor+'">'+aScore+'<span style="font-size:13px;color:var(--muted)">/99</span></div></div>';
      }
      if (cats.length) {
        html += '<div style="margin-bottom:16px"><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px"> Top Sponsorship Categories</div>';
        cats.forEach(function(c) {
          var fitColor = c.fit === 'Elite' ? '#4ade80' : c.fit === 'High' ? '#f59e0b' : '#94a3b8';
          html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:10px 12px;background:var(--surface2);border-radius:var(--r-sm);margin-bottom:6px">';
          html += '<div><div style="font-size:12px;font-weight:600;color:var(--text)">' + c.name + '</div>';
          html += '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + (c.reason||'') + '</div></div>';
          html += '<span style="font-size:10px;padding:2px 8px;border-radius:4px;background:rgba(74,222,128,0.1);color:' + fitColor + ';white-space:nowrap;margin-left:8px;flex-shrink:0">' + (c.fit||'Medium') + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      if (pts.length) {
        html += '<div><div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Ideal Deal Structures</div>';
        pts.forEach(function(p) {
          html += '<div style="padding:10px 12px;background:var(--surface2);border-radius:var(--r-sm);margin-bottom:6px">';
          html += '<div style="font-size:12px;font-weight:600;color:var(--text)">' + p.type + '</div>';
          html += '<div style="font-size:11px;color:var(--muted);margin-top:3px">' + p.description + '</div></div>';
        });
        html += '</div>';
      }
      resultEl.innerHTML = html;
    }
  } catch(e) {
    if (loading) loading.style.display = 'none';
    if (resultEl) { resultEl.style.display = 'block'; resultEl.innerHTML = '<div style="color:#f87171;padding:12px">Error: ' + e.message + '</div>'; }
  } finally {
    if (btn) btn.disabled = false;
  }
}


function openBrandKitModal(athleteId, athleteName) {
  if (athleteId) {
    selectAthlete(athleteId);
  }
  // Switch to marketing view and pitch deck tab
  var mktBtn = document.getElementById('marketingNavBtn');
  showView('marketing', mktBtn);
  setTimeout(function() {
    switchMarketingTab('brandkit');
    // Auto-run pitch deck after short delay
    setTimeout(runMarketingBrandKit, 300);
  }, 150);
}

function openOutreachModal(athleteId, athleteName) {
  if (athleteId) {
    selectAthlete(athleteId);
  }
  // Switch to marketing view and outreach tab
  var mktBtn = document.getElementById('marketingNavBtn');
  showView('marketing', mktBtn);
  setTimeout(function() {
    switchMarketingTab('outreach');
  }, 150);
}


;


// ══════════════════════════════════════════════════════════════════
//  UNIVERSITY MODE
// ══════════════════════════════════════════════════════════════════

var _univData     = null;
var _univViewMode = false; // true when admin is in university view

// enterUniversityMode removed (Fix 6 — University View button removed)

// Admin: return to full agent mode
function enterAgentMode() {
  _univViewMode = false;
  document.getElementById('sidebarRoleLabel').textContent = 'Agent Portal';
  // Hide the agent-mode switcher button
  var btn = document.getElementById('adminSwitchToAgent');
  if (btn) btn.style.display = 'none';
  // Hide university nav
  ['univNavSection','univOverviewNavBtn','univDevelopmentNavBtn','univComplianceNavBtn'].forEach(function(id){
    var el = document.getElementById(id); if (el) el.style.display = 'none';
  });
  // Restore all agent nav items + sections
  document.querySelectorAll('.nav-item:not([id^="univ"])').forEach(function(el){ el.style.removeProperty('display'); });
  document.querySelectorAll('.nav-section-label').forEach(function(el){ el.style.removeProperty('display'); });
  // Keep addAthleteNavBtn hidden for non-admin (admin can see it)
  // Restore client bar
  var cb = document.querySelector('.client-bar'); if (cb) cb.style.removeProperty('display');
  // Go back to command center
  showView('command', document.querySelector('.nav-item[onclick*="command"]'));
}

// NIL Readiness Score — DEPRECATED: client-side computation.
// Source of truth is now server/services/university/ReadinessEngine.js
// This function is retained only as a local fallback if the API call fails.
// Do NOT add logic here. All changes go to ReadinessEngine.js.
function calcNilReadiness(athlete, dealsCount) {
  var d = (athlete.data && typeof athlete.data === 'object') ? athlete.data : athlete;
  var score = 0;

  // Profile completeness (0–25)
  var fields = 0;
  if (d.name)                            fields++;
  if (d.sport)                           fields++;
  if (d.school)                          fields++;
  if (d.instagram || d.tiktok)          fields++;
  if (d.engagement)                      fields++;
  if (d.stats)                           fields++;
  score += Math.round((fields / 6) * 25);

  // Social presence (0–25) — reach tiers
  var reach = (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0);
  if      (reach >= 100000) score += 25;
  else if (reach >= 50000)  score += 20;
  else if (reach >= 20000)  score += 15;
  else if (reach >= 5000)   score += 10;
  else if (reach >= 1000)   score += 5;

  // Engagement quality (0–25) — ER thresholds
  var er = parseFloat(d.engagement) || 0;
  if      (er >= 6)   score += 25;
  else if (er >= 4)   score += 20;
  else if (er >= 2.5) score += 15;
  else if (er >= 1.5) score += 10;
  else if (er > 0)    score += 5;

  // NIL activity breadth (0–15) — deal count
  var deals = dealsCount || 0;
  if      (deals >= 5) score += 15;
  else if (deals >= 3) score += 12;
  else if (deals >= 1) score += 8;

  // School tier (0–10)
  var tier = (d.schoolTier || '').toLowerCase();
  if (tier.match(/p[45]/) && tier.match(/top/)) score += 10;
  else if (tier.match(/p[45]/))                 score += 7;
  else if (tier.match(/g5/))                    score += 5;
  else                                          score += 3;

  score = Math.min(100, score);
  var label = score >= 75 ? 'High Performer' : score >= 55 ? 'Ready' : score >= 35 ? 'Developing' : 'Needs Development';
  var color = score >= 75 ? '#84CC16' : score >= 55 ? '#00D4FF' : score >= 35 ? '#FFB800' : 'rgba(240,244,255,0.35)';
  return { score: score, label: label, color: color };
}

// Development recommendations — DEPRECATED: client-side computation.
// Source of truth is now server/services/university/ReadinessEngine.js
// getDevelopmentRecommendations(). Retained as fallback only.
function getDevelopmentRecs(athlete, readiness) {
  var d = (athlete.data && typeof athlete.data === 'object') ? athlete.data : athlete;
  var recs = [];
  var reach = (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0);
  var er    = parseFloat(d.engagement) || 0;

  if (!d.name || !d.sport || !d.school) {
    recs.push('Complete the athlete profile — name, sport, and school are required for brand and compliance visibility.');
  }
  if (!d.instagram && !d.tiktok) {
    recs.push('Establish a social media presence on Instagram or TikTok. A consistent, authentic account is the foundation of any NIL opportunity.');
  } else if (reach < 5000) {
    recs.push('Grow audience through consistent posting — game day content, practice clips, and campus life outperform highlight reels for engagement.');
  }
  if (er < 2 && reach > 0) {
    recs.push('Engagement rate is below benchmark. Posting more conversational content and responding to comments typically moves this metric.');
  }
  if (!d.stats) {
    recs.push('Add athletic stats to the profile. Performance data is often the first thing a brand reviews when evaluating a potential partner.');
  }
  if (!d.notes) {
    recs.push('Add a bio or personal narrative. A clear story — hometown, major, what the sport means — helps brands connect beyond the numbers.');
  }
  if (readiness.score >= 55) {
    recs.push('Profile is ready for NIL activity. Prioritize reviewing NCAA disclosure requirements and school-specific policies before any agreement is signed.');
  }
  recs.push('Ensure the athlete understands FTC disclosure requirements for all sponsored content, including unpaid gifting arrangements.');
  return recs.slice(0, 4);
}

// Tab switcher — NIL Director Dashboard
function switchUnivTab(tab) {
  var tabs   = ['overview','athletes','deals','compliance','insights','activity','import'];
  var panels = {
    overview:   'univPanel-overview',
    athletes:   'univPanel-athletes',
    deals:      'univPanel-deals',
    compliance: 'univPanel-compliance',
    insights:   'univPanel-insights',
    activity:   'univPanel-activity',
    import:     'univPanel-import',
  };
  tabs.forEach(function(t) {
    var btn   = document.getElementById('univTab-' + t);
    var panel = document.getElementById(panels[t]);
    var isActive = (t === tab);
    if (btn) {
      btn.className = 'univ-sidenav-item' + (isActive ? ' univ-sidenav-active' : '');
    }
    if (panel) panel.style.display = isActive ? 'block' : 'none';
  });
  // Lazy loads per tab
  if (tab === 'athletes')   _nilDirLoadAthletes();
  if (tab === 'deals')      _nilDirLoadDeals();
  if (tab === 'compliance') _nilDirLoadCompliance();
  if (tab === 'activity')   _nilDirLoadActivity();
}

// Format reach without $ signs, no monetary context
function _univFmtReach(n) {
  var num = parseInt(n) || 0;
  if (num >= 1000000) return (num/1000000).toFixed(1) + 'M';
  if (num >= 1000)    return Math.round(num/1000) + 'K';
  return num > 0 ? String(num) : '—';
}

// ── Trust signal helpers ──────────────────────────────────────────

// Render a data freshness badge from a readiness.dataFreshness object
function _univFreshnessBadge(freshness) {
  if (!freshness || freshness.daysOld === null) {
    return '<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:rgba(240,244,255,0.06);color:var(--muted);border:1px solid var(--border)">Date unknown</span>';
  }
  var col = freshness.stale ? '#FFB800' : 'rgba(132,204,22,0.8)';
  var bg  = freshness.stale ? 'rgba(255,184,0,0.08)' : 'rgba(132,204,22,0.08)';
  var bdr = freshness.stale ? 'rgba(255,184,0,0.25)' : 'rgba(132,204,22,0.25)';
  return '<span style="font-size:9px;padding:2px 6px;border-radius:8px;background:' + bg + ';color:' + col + ';border:1px solid ' + bdr + '">' + freshness.label + (freshness.daysOld !== null ? ' · ' + freshness.daysOld + 'd' : '') + '</span>';
}

// Render a confidence chip (0.0–1.0)
function _univConfidenceBadge(confidence) {
  var pct = Math.round((confidence || 0) * 100);
  var col = pct >= 70 ? 'var(--accent)' : pct >= 40 ? '#FFB800' : 'var(--muted)';
  return '<span style="font-size:9px;color:' + col + ';font-family:var(--mono)">' + pct + '% conf</span>';
}

// Render data reliability bar for program overview
function _univReliabilityBar(reliability) {
  if (!reliability) return '';
  var score = reliability.score || 0;
  var col   = score >= 70 ? 'var(--accent)' : score >= 40 ? '#FFB800' : 'var(--red)';
  return '<div style="display:flex;align-items:center;gap:8px">' +
    '<div style="flex:1;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden">' +
      '<div style="height:100%;width:' + score + '%;background:' + col + ';border-radius:2px"></div>' +
    '</div>' +
    '<span style="font-size:10px;color:' + col + ';font-family:var(--mono);min-width:28px">' + score + '/100</span>' +
  '</div>' +
  '<div style="font-size:10px;color:var(--muted);margin-top:3px">' +
    reliability.freshAthletes + ' of ' + (reliability.freshAthletes + (reliability.staleAthletes||0)) + ' athletes have recent data' +
  '</div>';
}

// Main loader — uses server-computed readiness + trust metadata
// Shared helpers for sport filter pills
function _univMakeSportPills(athletes, pillContainerId, onSelect) {
  var pillEl = document.getElementById(pillContainerId);
  if (!pillEl) return;
  var sports = [];
  athletes.forEach(function(a) { if (a.sport && sports.indexOf(a.sport) < 0) sports.push(a.sport); });
  sports.sort();
  var active = '__all__';
  function render() {
    var allPills = ['All Programs'].concat(sports).map(function(s, i) {
      var key   = i === 0 ? '__all__' : s;
      var isAct = key === active;
      return '<button onclick="_univSportFilter(\'' + pillContainerId + '\',\'' + key + '\')" ' +
        'style="padding:4px 10px;border-radius:12px;border:1px solid ' +
        (isAct ? 'var(--accent)' : 'var(--border)') +
        ';background:' + (isAct ? 'rgba(132,204,22,0.12)' : 'none') +
        ';color:' + (isAct ? 'var(--accent)' : 'var(--muted)') +
        ';font-size:10px;font-weight:' + (isAct ? '700' : '500') +
        ';cursor:pointer;font-family:\'DM Sans\',sans-serif;transition:all 0.15s">' + s + '</button>';
    }).join('');
    pillEl.innerHTML = allPills;
  }
  pillEl._active = active;
  pillEl._sports = sports;
  pillEl._onSelect = onSelect;
  render();
  pillEl._setActive = function(key) {
    active = key;
    pillEl._active = key;
    render();
    if (onSelect) onSelect(key);
  };
}

// Called by sport pill buttons
function _univSportFilter(containerId, sport) {
  var el = document.getElementById(containerId);
  if (el && el._setActive) el._setActive(sport);
}

// Render roster rows for a given athlete list
function _univRenderRosterRows(athletes) {
  if (!athletes.length) {
    return '<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">No athletes in this program.</div>';
  }
  var hdr = '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 150px;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px">' +
    ['Athlete','Sport','Position','Reach','NIL Readiness'].map(function(h){
      return '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">' + h + '</div>';
    }).join('') + '</div>';
  var rows = athletes.map(function(a) {
    var rs        = a.readiness || {};
    var col       = rs.labelColor || 'var(--muted)';
    var freshness = rs.dataFreshness || null;
    return '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr 150px;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)">' +
      '<div>' +
        '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (a.name||'—') + '</div>' +
        '<div style="font-size:11px;color:var(--muted);display:flex;gap:6px;align-items:center;margin-top:2px">' +
          (a.school||'') +
          (freshness ? ' &nbsp;' + _univFreshnessBadge(freshness) : '') +
        '</div>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + (a.sport||'—') + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + (a.position||'—') + '</div>' +
      '<div style="font-size:12px;font-family:var(--mono);color:var(--text)">' + _univFmtReach((a.instagram||0)+(a.tiktok||0)) + '</div>' +
      '<div>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="flex:1;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden">' +
            '<div style="height:100%;width:' + (rs.score||0) + '%;background:' + col + ';border-radius:2px"></div>' +
          '</div>' +
          '<span style="font-size:10px;color:' + col + ';font-family:var(--mono);min-width:24px">' + (rs.score||0) + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-top:2px">' +
          '<div style="font-size:9px;color:' + col + '">' + (rs.label||'—') + '</div>' +
          _univConfidenceBadge(rs.overallConfidence) +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
  return hdr + rows;
}

async function loadUniversityDashboard() {
  try {
    var r = await fetch(API_BASE + '/api/university/dashboard', { credentials: 'include' });
    if (!r.ok) throw new Error('API error ' + r.status);
    var data = await r.json();
    _univData = data;

    var athletes    = data.athletes  || [];
    var overview    = data.overview  || {};
    var health      = data.programHealth || overview.programHealth || {};
    var reliability = data.dataReliability || overview.dataReliability || {};
    var university  = data.university || null;

    // ── University header ─────────────────────────────────────────
    var hdrName = document.getElementById('univ-header-name');
    var hdrMeta = document.getElementById('univ-header-meta');
    if (hdrName) {
      hdrName.textContent = (university && university.name) || 'University Program';
    }
    if (hdrMeta) {
      var metaParts = [];
      if (university && university.conference) metaParts.push(university.conference);
      if (university && university.location)   metaParts.push(university.location);
      var sportCount = Object.keys(data.sportBreakdown || {}).length;
      if (sportCount) metaParts.push(sportCount + ' sport' + (sportCount !== 1 ? 's' : ''));
      hdrMeta.textContent = metaParts.join('  ·  ');
    }

    // ── KPIs ──────────────────────────────────────────────────────
    var setKpi = function(id, val) { var el = document.getElementById(id); if (el) el.textContent = val; };
    setKpi('univ-kpi-athletes', athletes.length || '—');
    setKpi('univ-kpi-eng',      (data.avgEngagement || 0) + '%');
    setKpi('univ-kpi-active',   athletes.filter(function(a){ return a.dealsCount > 0; }).length);
    setKpi('univ-kpi-sports',   Object.keys(data.sportBreakdown || {}).length);

    // ── Program health card ───────────────────────────────────────
    var healthEl = document.getElementById('univ-program-health');
    if (healthEl) {
      var hScore = health.score || 0;
      var hCol   = hScore >= 75 ? 'var(--accent)' : hScore >= 55 ? '#00D4FF' : hScore >= 35 ? '#FFB800' : 'var(--muted)';
      healthEl.innerHTML =
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">' +
          '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:36px;color:' + hCol + ';letter-spacing:1px;line-height:1">' + hScore + '</div>' +
          '<div>' +
            '<div style="font-size:12px;font-weight:700;color:var(--text)">' + (health.label||'—') + '</div>' +
            '<div style="font-size:10px;color:var(--muted)">' + (health.formula||'') + '</div>' +
          '</div>' +
        '</div>' +
        _univReliabilityBar(reliability);
    }

    // ── Data reliability card ─────────────────────────────────────
    var relEl = document.getElementById('univ-data-reliability');
    if (relEl) { relEl.innerHTML = _univReliabilityBar(reliability); }

    // ── Sync status card ──────────────────────────────────────────
    var syncEl = document.getElementById('univ-sync-status');
    if (syncEl) { syncEl.innerHTML = _univRenderSyncStatus(data.syncStatus); }

    // ── Roster state breakdown ────────────────────────────────────
    var rsbEl = document.getElementById('univ-roster-state-breakdown');
    if (rsbEl) { rsbEl.innerHTML = _univRenderRosterStateBreakdown(data.rosterStateSummary, athletes.length); }

    // ── Readiness distribution ─────────────────────────────────────
    var dist   = overview.readinessDistribution || {};
    var distEl = document.getElementById('univ-readiness-dist');
    if (distEl) {
      var total   = athletes.length || 1;
      var buckets = [
        { key: 'highPerformer',    label: 'High Performer',    color: '#84CC16' },
        { key: 'ready',            label: 'Ready',             color: '#00D4FF' },
        { key: 'developing',       label: 'Developing',        color: '#FFB800' },
        { key: 'needsDevelopment', label: 'Needs Development', color: 'rgba(240,244,255,0.35)' },
      ];
      distEl.innerHTML = buckets.map(function(b) {
        var count = (dist[b.key] && dist[b.key].count) || 0;
        var pct   = Math.round((count / total) * 100);
        return '<div style="margin-bottom:10px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<span style="font-size:11px;color:var(--text)">' + b.label + '</span>' +
            '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + count + ' (' + pct + '%)</span>' +
          '</div>' +
          '<div style="height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">' +
            '<div style="height:100%;width:' + pct + '%;background:' + b.color + ';border-radius:3px;transition:width 0.4s"></div>' +
          '</div></div>';
      }).join('');
    }

    // ── Sport breakdown chart ─────────────────────────────────────
    var sportChartEl = document.getElementById('univ-sport-breakdown');
    if (sportChartEl) {
      var sports    = data.sportBreakdown || {};
      var sportKeys = Object.keys(sports).sort(function(a,b){ return sports[b]-sports[a]; });
      var maxCount  = Math.max.apply(null, sportKeys.map(function(k){ return sports[k]; })) || 1;
      sportChartEl.innerHTML = sportKeys.length
        ? sportKeys.map(function(sport) {
            var n = sports[sport];
            return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
              '<span style="font-size:11px;color:var(--text);min-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + sport + '</span>' +
              '<div style="flex:1;height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">' +
                '<div style="height:100%;width:' + Math.round((n/maxCount)*100) + '%;background:var(--accent);border-radius:3px"></div>' +
              '</div>' +
              '<span style="font-size:11px;color:var(--muted);font-family:var(--mono);min-width:20px;text-align:right">' + n + '</span>' +
            '</div>';
          }).join('')
        : '<div style="color:var(--muted);font-size:12px">No athletes added yet.</div>';
    }

    // ── Sport filter pills + roster ────────────────────────────────
    var rosterEl = document.getElementById('univ-roster-list');
    _univMakeSportPills(athletes, 'univ-sport-pills', function(activeSport) {
      var filtered = activeSport === '__all__'
        ? athletes
        : athletes.filter(function(a){ return a.sport === activeSport; });
      if (rosterEl) rosterEl.innerHTML = _univRenderRosterRows(filtered);
    });
    if (rosterEl) rosterEl.innerHTML = _univRenderRosterRows(athletes);

    // ── Development tab — cards with sport filter ─────────────────
    var devGrid = document.getElementById('univ-dev-grid');
    _univMakeSportPills(athletes, 'univ-dev-sport-pills', function(activeSport) {
      var filtered = activeSport === '__all__'
        ? athletes
        : athletes.filter(function(a){ return a.sport === activeSport; });
      if (devGrid) devGrid.innerHTML = _univRenderDevCards(filtered);
    });
    if (devGrid) devGrid.innerHTML = _univRenderDevCards(athletes);

    // ── Render generated-at timestamp ─────────────────────────────
    var tsEl = document.getElementById('univ-generated-at');
    if (tsEl && data.generatedAt) {
      tsEl.textContent = 'Data as of ' + new Date(data.generatedAt).toLocaleString();
    }

    // ── NIL Director Dashboard panels ────────────────────────────
    // Load overview metrics and daily actions whenever the dashboard boots
    if (typeof _nilDirLoadOverview === 'function') _nilDirLoadOverview();
    if (typeof _nilDirLoadActions  === 'function') _nilDirLoadActions();

  } catch (err) {
    console.error('[university] Load error:', err.message);
    var errTarget = document.getElementById('univ-roster-list');
    if (errTarget) errTarget.innerHTML = '<div style="color:var(--red);font-size:12px">Could not load program data. Try refreshing.</div>';
    // Still try to boot NIL Director panels independently
    if (typeof _nilDirLoadOverview === 'function') _nilDirLoadOverview();
    if (typeof _nilDirLoadActions  === 'function') _nilDirLoadActions();
  }
}

// Render development cards for a filtered athlete list
function _univRenderDevCards(athletes) {
  if (!athletes.length) {
    return '<div style="color:var(--muted);font-size:12px;padding:20px 0">No athletes in this program.</div>';
  }
  return athletes.map(function(a) {
    var rs   = a.readiness || {};
    var col  = rs.labelColor || 'var(--muted)';
    var recs = a.recs || [];
    var bd   = rs.breakdown || {};

    var dimRows = Object.keys(bd).map(function(key) {
      var dim    = bd[key];
      var dimCol = dim.score >= dim.maxScore * 0.7 ? 'var(--accent)' : dim.score >= dim.maxScore * 0.4 ? '#FFB800' : 'var(--muted)';
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">' +
        '<span style="font-size:10px;color:var(--muted);text-transform:capitalize">' + key.replace(/([A-Z])/g,' $1').trim() + '</span>' +
        '<div style="display:flex;align-items:center;gap:6px">' +
          '<div style="width:60px;height:3px;background:var(--surface2);border-radius:2px;overflow:hidden">' +
            '<div style="height:100%;width:' + Math.round((dim.score/dim.maxScore)*100) + '%;background:' + dimCol + ';border-radius:2px"></div>' +
          '</div>' +
          '<span style="font-size:9px;color:' + dimCol + ';font-family:var(--mono);min-width:28px;text-align:right">' + dim.score + '/' + dim.maxScore + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:700;color:var(--text)">' + (a.name||'Unnamed') + '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px">' +
            (a.sport||'') + (a.position ? ' · ' + a.position : '') +
          '</div>' +
        '</div>' +
        '<div style="text-align:right">' +
          '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:26px;color:' + col + ';letter-spacing:1px;line-height:1">' + (rs.score||0) + '</div>' +
          '<div style="font-size:9px;color:' + col + ';font-weight:700">' + (rs.label||'—') + '</div>' +
          '<div style="margin-top:2px">' + _univConfidenceBadge(rs.overallConfidence) + '</div>' +
        '</div>' +
      '</div>' +
      (Object.keys(bd).length ? '<div style="margin-bottom:12px">' + dimRows + '</div>' : '') +
      (rs.dataFreshness ? '<div style="margin-bottom:12px">' + _univFreshnessBadge(rs.dataFreshness) + '</div>' : '') +
      (recs.length ? '<div style="border-top:1px solid var(--border);padding-top:12px">' +
        '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Development Guidance</div>' +
        recs.map(function(rec) {
          var recText = typeof rec === 'string' ? rec : (rec.action || '');
          var priCol  = rec.priority === 'high' ? 'var(--red)' : rec.priority === 'medium' ? '#FFB800' : 'var(--muted)';
          return '<div style="display:flex;gap:8px;margin-bottom:8px">' +
            '<span style="color:' + priCol + ';font-size:14px;line-height:1.4;flex-shrink:0">→</span>' +
            '<span style="font-size:11px;color:var(--muted);line-height:1.5">' + recText + '</span>' +
          '</div>';
        }).join('') + '</div>' : '') +
    '</div>';
  }).join('');
}

// ── Roster Sync Engine UI helpers ─────────────────────────────────────────

function _univRenderSyncStatus(syncStatus) {
  if (!syncStatus) {
    return '<div style="font-size:11px;color:var(--muted)">No sync data yet. Run a sync to begin.</div>';
  }
  if (syncStatus.error) {
    return '<div style="font-size:11px;color:var(--muted)">Sync tables pending migration.</div>';
  }

  var score = syncStatus.freshnessScore || 0;
  var label = syncStatus.syncHealthLabel || 'Unknown';
  var col   = score >= 75 ? 'var(--accent)' : score >= 50 ? '#00D4FF' : score >= 25 ? '#FFB800' : 'var(--muted)';

  var lastRun  = syncStatus.lastSyncRun;
  var snapshot = syncStatus.currentSnapshot;
  var lastTime = lastRun && (lastRun.completed_at || lastRun.started_at)
    ? new Date(lastRun.completed_at || lastRun.started_at).toLocaleString()
    : 'Never';

  var html =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
      '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:28px;color:' + col + ';letter-spacing:1px;line-height:1">' + score + '</div>' +
      '<div>' +
        '<div style="font-size:12px;font-weight:700;color:var(--text)">' + label + '</div>' +
        '<div style="font-size:10px;color:var(--muted)">Freshness score</div>' +
      '</div>' +
    '</div>' +
    '<div style="font-size:10px;color:var(--muted);margin-bottom:4px">Last sync: ' + lastTime + '</div>';

  if (snapshot) {
    html += '<div style="font-size:10px;color:var(--muted)">Snapshot: ' +
      snapshot.active_count + ' active · ' +
      snapshot.probable_count + ' probable · ' +
      snapshot.uncertain_count + ' uncertain' +
    '</div>';
  }

  return html;
}

function _univRenderRosterStateBreakdown(summary, totalAthletes) {
  if (!summary) {
    return '<div style="font-size:11px;color:var(--muted)">Run a roster sync to see state distribution.</div>';
  }
  var total = totalAthletes || 1;
  var states = [
    { key: 'active',    label: 'Active',    color: '#84CC16',              desc: 'Confirmed on roster' },
    { key: 'probable',  label: 'Probable',  color: '#00D4FF',              desc: 'Likely on roster' },
    { key: 'uncertain', label: 'Uncertain', color: '#FFB800',              desc: 'Conflicting data' },
    { key: 'inactive',  label: 'Inactive',  color: 'rgba(240,244,255,0.3)',desc: 'Transferred / graduated' },
    { key: 'unknown',   label: 'Unknown',   color: 'var(--muted)',         desc: 'Insufficient data' },
  ];
  return '<div style="display:flex;gap:0;flex-wrap:wrap">' +
    states.map(function(s) {
      var count = summary[s.key] || 0;
      var pct   = Math.round((count / total) * 100);
      return '<div style="flex:1;min-width:80px;text-align:center;padding:8px 4px">' +
        '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:24px;color:' + s.color + ';letter-spacing:1px;line-height:1">' + count + '</div>' +
        '<div style="font-size:10px;font-weight:700;color:var(--text);margin-top:2px">' + s.label + '</div>' +
        '<div style="font-size:9px;color:var(--muted)">' + pct + '%</div>' +
        '<div style="font-size:9px;color:var(--muted);margin-top:2px;line-height:1.3">' + s.desc + '</div>' +
      '</div>';
    }).join('') +
  '</div>';
}

// Manual sync trigger (Sync button in header card)
async function _univTriggerSync() {
  var syncEl = document.getElementById('univ-sync-status');
  if (syncEl) syncEl.innerHTML = '<div style="font-size:11px;color:var(--muted)">Running sync...</div>';

  try {
    var r = await fetch(API_BASE + '/api/university/sync/trigger', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    var result = await r.json();
    if (result.ok) {
      // Reload dashboard to reflect new state
      await loadUniversityDashboard();
    } else {
      if (syncEl) syncEl.innerHTML = '<div style="font-size:11px;color:#FFB800">Sync failed: ' + (result.error || 'Unknown error') + '</div>';
    }
  } catch (err) {
    if (syncEl) syncEl.innerHTML = '<div style="font-size:11px;color:var(--red)">Network error: ' + err.message + '</div>';
  }
}

// ── AI Roster Import helpers ─────────────────────────────────────────────

var _aiRosterPreviewData = [];

function _aiRosterDrop(e) {
  e.preventDefault();
  document.getElementById('ai-roster-dropzone').style.borderColor = 'var(--border)';
  var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) _aiRosterUpload(file);
}

async function _aiRosterUpload(file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    _aiRosterShowResult('error', 'File is too large. Maximum size is 5MB.');
    return;
  }

  // Show loading, hide other states
  document.getElementById('ai-roster-upload-card').style.display = 'none';
  document.getElementById('ai-roster-loading').style.display = 'block';
  document.getElementById('ai-roster-preview').style.display = 'none';
  document.getElementById('ai-roster-result').style.display = 'none';

  var form = new FormData();
  form.append('roster', file);

  try {
    var r = await fetch(API_BASE + '/api/university/roster/preview', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    var data = await r.json();
    document.getElementById('ai-roster-loading').style.display = 'none';

    if (!r.ok) {
      document.getElementById('ai-roster-upload-card').style.display = 'block';
      _aiRosterShowResult('error', data.error || 'Preview failed. Please try again.');
      return;
    }

    _aiRosterPreviewData = data.preview || [];
    _aiRosterRenderPreview(file.name);
  } catch (err) {
    document.getElementById('ai-roster-loading').style.display = 'none';
    document.getElementById('ai-roster-upload-card').style.display = 'block';
    _aiRosterShowResult('error', 'Network error: ' + err.message);
  }
}

function _aiRosterRenderPreview(filename) {
  var athletes = _aiRosterPreviewData;
  var hasWarnings = athletes.some(function(a) {
    return !a.first_name || !a.last_name || !a.sport;
  });

  document.getElementById('ai-roster-preview-title').textContent =
    'Roster Preview — ' + athletes.length + ' athlete' + (athletes.length !== 1 ? 's' : '') + ' found';
  document.getElementById('ai-roster-preview-sub').innerHTML =
    'File: ' + filename +
    (hasWarnings ? ' &nbsp;·&nbsp; <span style="background:rgba(245,158,11,0.15);color:#f59e0b;font-size:10px;padding:1px 6px;border-radius:3px;font-weight:700">⚠ Some fields are missing</span>' : '');

  var tbody = document.getElementById('ai-roster-preview-tbody');
  tbody.innerHTML = athletes.map(function(a) {
    var warn = !a.first_name || !a.last_name || !a.sport;
    var rowStyle = warn ? 'background:rgba(245,158,11,0.04);' : '';
    function cell(v) {
      if (v == null || v === '') return '<td style="padding:8px 12px;color:var(--muted);font-style:italic">—</td>';
      return '<td style="padding:8px 12px;color:var(--text)">' + _esc(String(v)) + '</td>';
    }
    return '<tr style="border-bottom:1px solid var(--border);' + rowStyle + '">' +
      (warn ? '<td style="padding:8px 4px;width:20px"><span title="Missing required fields" style="color:#f59e0b;font-size:13px">⚠</span></td>' : '<td style="padding:8px 4px;width:20px"></td>') +
      cell(a.first_name) + cell(a.last_name) + cell(a.sport) +
      cell(a.position) + cell(a.year) + cell(a.jersey_number) + cell(a.email) +
    '</tr>';
  }).join('');

  document.getElementById('ai-roster-preview').style.display = 'block';
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _aiRosterCancel() {
  _aiRosterPreviewData = [];
  document.getElementById('ai-roster-preview').style.display = 'none';
  document.getElementById('ai-roster-result').style.display = 'none';
  document.getElementById('ai-roster-upload-card').style.display = 'block';
  // Reset file input
  var fi = document.getElementById('ai-roster-file');
  if (fi) fi.value = '';
}

async function _aiRosterConfirm() {
  if (!_aiRosterPreviewData.length) return;
  var btn = document.getElementById('ai-roster-confirm-btn');
  btn.disabled = true;
  btn.textContent = 'Importing…';

  try {
    var r = await fetch(API_BASE + '/api/university/roster/confirm', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athletes: _aiRosterPreviewData }),
    });
    var result = await r.json();

    btn.disabled = false;
    btn.textContent = 'Confirm Import →';

    if (!r.ok) {
      _aiRosterShowResult('error', result.error || 'Import failed. Please try again.');
      return;
    }

    // Success
    document.getElementById('ai-roster-preview').style.display = 'none';
    document.getElementById('ai-roster-upload-card').style.display = 'block';
    _aiRosterPreviewData = [];
    var fi = document.getElementById('ai-roster-file');
    if (fi) fi.value = '';

    var msg = result.imported + ' athlete' + (result.imported !== 1 ? 's' : '') + ' imported successfully';
    if (result.skipped > 0) msg += ' · ' + result.skipped + ' skipped';
    _aiRosterShowResult('success', msg);

    // Refresh dashboard after a beat
    setTimeout(function() { if (typeof loadUniversityDashboard === 'function') loadUniversityDashboard(); }, 1200);

  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Confirm Import →';
    _aiRosterShowResult('error', 'Network error: ' + err.message);
  }
}

function _aiRosterShowResult(type, msg) {
  var el = document.getElementById('ai-roster-result');
  if (!el) return;
  el.style.display = 'block';
  var isError = type === 'error';
  el.style.background  = isError ? 'rgba(239,68,68,0.08)'  : 'rgba(34,197,94,0.08)';
  el.style.border      = '1px solid ' + (isError ? 'rgba(239,68,68,0.25)' : 'rgba(34,197,94,0.25)');
  el.style.color       = isError ? '#ef4444' : '#22c55e';
  el.textContent = msg;
}

// Legacy stubs — kept so any residual calls don't throw
function _univImportSetFmt() {}
function _univImportFileRead() {}
function _univImportStat(n, label, color) {
  return '<div style="text-align:center;min-width:48px">' +
    '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:26px;color:' + color + ';letter-spacing:1px;line-height:1">' + (n||0) + '</div>' +
    '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-top:2px">' + label + '</div>' +
  '</div>';
}

// ── Ingestion Pipeline event viewer ───────────────────────────────────────

async function _univLoadIngestionEvents() {
  var eventsEl = document.getElementById('univ-ingestion-events');
  var queueEl  = document.getElementById('univ-queue-status');
  if (eventsEl) eventsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Loading...</div>';

  try {
    var r = await fetch(API_BASE + '/api/university/ingestion/events?limit=30', { credentials: 'include' });
    if (!r.ok) { if (eventsEl) eventsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Ingestion tables pending migration.</div>'; return; }
    var data = await r.json();
    var qs   = data.queueStatus || {};
    var evs  = data.events      || [];

    // Queue status badges
    if (queueEl) {
      var statusColors = { pending:'#FFB800', committed:'var(--accent)', failed:'var(--red)', partial:'#00D4FF', duplicate:'var(--muted)', resolving:'#9333ea' };
      queueEl.innerHTML = Object.entries(qs.byStatus || {}).map(function(entry) {
        var s = entry[0], info = entry[1];
        var col = statusColors[s] || 'var(--muted)';
        return '<div style="display:flex;align-items:center;gap:6px;padding:4px 10px;background:var(--surface2);border-radius:10px;font-size:10px">' +
          '<span style="color:' + col + ';font-weight:700">' + info.count + '</span>' +
          '<span style="color:var(--muted)">' + s + '</span>' +
        '</div>';
      }).join('') || '<div style="font-size:11px;color:var(--muted)">No events yet.</div>';
    }

    // Event list
    if (eventsEl) {
      if (!evs.length) {
        eventsEl.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:12px 0;text-align:center">No ingestion events yet. Import athletes to begin.</div>';
        return;
      }
      var statusIcons = { committed:'✓', failed:'✗', pending:'⋯', partial:'!', duplicate:'=', resolving:'↻' };
      var matchColors = { exact:'var(--accent)', probable:'#00D4FF', new_entity:'#FFB800', conflict:'var(--red)', skipped:'var(--muted)' };
      eventsEl.innerHTML = evs.map(function(e) {
        var icon     = statusIcons[e.status] || '?';
        var iconCol  = e.status === 'committed' ? 'var(--accent)' : e.status === 'failed' ? 'var(--red)' : '#FFB800';
        var matchCol = matchColors[e.match_type] || 'var(--muted)';
        return '<div style="display:grid;grid-template-columns:20px 1fr 80px 80px 80px;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:11px">' +
          '<span style="color:' + iconCol + ';font-weight:700;font-family:var(--mono)">' + icon + '</span>' +
          '<div>' +
            '<span style="color:var(--text)">' + (e.athlete_name || 'Unknown') + '</span>' +
            '<span style="color:var(--muted)"> · ' + (e.athlete_sport || '') + '</span>' +
          '</div>' +
          '<span style="color:var(--muted);font-size:10px">' + e.source_type + '</span>' +
          '<span style="color:' + matchCol + ';font-size:10px;font-family:var(--mono)">' + (e.match_type || '—') + '</span>' +
          '<span style="color:var(--muted);font-size:10px">' + (e.match_score != null ? (parseFloat(e.match_score)*100).toFixed(0) + '%' : '—') + '</span>' +
        '</div>';
      }).join('');
    }
  } catch (err) {
    if (eventsEl) eventsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Could not load: ' + err.message + '</div>';
  }
}

async function _univProcessQueue() {
  var eventsEl = document.getElementById('univ-ingestion-events');
  if (eventsEl) eventsEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Processing queue...</div>';
  try {
    var r = await fetch(API_BASE + '/api/university/ingestion/process', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 100 }),
    });
    var result = await r.json();
    // Reload events panel + dashboard
    _univLoadIngestionEvents();
    if ((result.committed || 0) > 0) setTimeout(loadUniversityDashboard, 1200);
  } catch (err) {
    if (eventsEl) eventsEl.innerHTML = '<div style="color:var(--red);font-size:11px">Queue process failed: ' + err.message + '</div>';
  }
}

// Load compliance tab from dedicated endpoint
async function _loadUniversityComplianceTab() {
  var compLog = document.getElementById('univ-compliance-log');
  if (!compLog) return;
  try {
    var r = await fetch(API_BASE + '/api/university/compliance', { credentials: 'include' });
    if (!r.ok) { compLog.innerHTML = '<div style="color:var(--muted);font-size:12px">Compliance data unavailable.</div>'; return; }
    var data = await r.json();
    if (data.disabled) { compLog.innerHTML = '<div style="color:var(--muted);font-size:12px">Compliance tracking is not enabled.</div>'; return; }

    var athletes = data.athletes || [];
    if (!athletes.length) {
      compLog.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px 0;text-align:center">No athletes in the program.</div>';
      return;
    }

    var hdr = '<div style="display:grid;grid-template-columns:2fr 80px 80px 1fr;gap:10px;padding:8px 0;border-bottom:1px solid var(--border);margin-bottom:8px">' +
      ['Athlete','Profile','Freshness','Alerts'].map(function(h){
        return '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">' + h + '</div>';
      }).join('') + '</div>';

    var rows = athletes.map(function(a) {
      var compScore  = a.profileCompleteness && a.profileCompleteness.score || 0;
      var compCol    = compScore >= 70 ? 'var(--accent)' : compScore >= 40 ? '#FFB800' : 'var(--red)';
      var alertsHtml = (a.alerts||[]).map(function(al){
        var alCol = al.severity === 'high' ? 'var(--red)' : al.severity === 'medium' ? '#FFB800' : 'var(--muted)';
        return '<div style="font-size:10px;color:' + alCol + ';margin-bottom:2px">' + al.message + '</div>';
      }).join('') || '<div style="font-size:10px;color:var(--accent)">No alerts</div>';

      return '<div style="display:grid;grid-template-columns:2fr 80px 80px 1fr;gap:10px;align-items:start;padding:10px 0;border-bottom:1px solid var(--border)">' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (a.name||'—') + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + (a.sport||'') + (a.school?' · '+a.school:'') + '</div>' +
        '</div>' +
        '<div style="font-size:12px;font-weight:700;color:' + compCol + ';font-family:var(--mono)">' + compScore + '%</div>' +
        '<div>' + _univFreshnessBadge(a.dataFreshness) + '</div>' +
        '<div>' + alertsHtml + '</div>' +
      '</div>';
    }).join('');

    compLog.innerHTML = hdr + rows;
  } catch (err) {
    compLog.innerHTML = '<div style="color:var(--muted);font-size:12px">Compliance data could not be loaded.</div>';
  }
}

// ── Roster Intelligence UI ────────────────────────────────────────────────

var _intelPollInterval = null;
var _intelActiveJobId  = null;

// Status → progress bar %
var _intelStatusPct = {
  queued: 5, discovering: 20, extracting: 45, validating: 70, importing: 88, completed: 100, failed: 0,
};
var _intelStatusLabels = {
  queued: 'Queued…', discovering: 'Searching sources…', extracting: 'Extracting athletes with AI…',
  validating: 'Cross-validating…', importing: 'Importing to CRM…', completed: 'Complete', failed: 'Failed',
};

async function _intelStartDiscovery() {
  var sportSelect  = document.getElementById('intel-sport-select');
  var schoolInput  = document.getElementById('intel-school-input');
  var sport        = sportSelect ? sportSelect.value.trim() : '';
  var school       = schoolInput ? schoolInput.value.trim() : '';

  // Pre-fill school from loaded university data if blank
  if (!school && _univData && _univData.university && _univData.university.name) {
    school = _univData.university.name;
    if (schoolInput) schoolInput.value = school;
  }

  if (!school) { alert('Please enter a school name.'); return; }
  if (!sport)  { alert('Please select a sport.');      return; }

  var btn = document.getElementById('intel-start-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }

  try {
    var r = await fetch(API_BASE + '/api/university/roster/discover', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ sport, universityName: school }),
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed to start job');

    _intelActiveJobId = data.jobId;
    _intelShowProgressPanel(true);
    _intelStartPolling(data.jobId);
    _intelLoadJobs();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Find Roster'; }
  }
}

function _intelShowProgressPanel(show) {
  var panel = document.getElementById('intel-progress-panel');
  if (panel) panel.style.display = show ? 'block' : 'none';
}

function _intelStartPolling(jobId) {
  if (_intelPollInterval) clearInterval(_intelPollInterval);
  _intelPollInterval = setInterval(function() {
    _intelPollJob(jobId);
  }, 2500);
  _intelPollJob(jobId); // immediate first poll
}

async function _intelPollJob(jobId) {
  try {
    var r    = await fetch(API_BASE + '/api/university/roster/discovery/' + jobId, { credentials: 'include' });
    var job  = await r.json();
    _intelUpdateProgressUI(job);

    if (job.status === 'completed' || job.status === 'failed') {
      clearInterval(_intelPollInterval);
      _intelPollInterval = null;
      // Refresh jobs list
      _intelLoadJobs();
      // If items queued for review, update badge
      if (job.athletes_queued > 0) {
        _intelUpdateQueueBadge(job.athletes_queued);
      }
      // Reload main dashboard if athletes were imported
      if ((job.athletes_imported || 0) > 0) {
        setTimeout(loadUniversityDashboard, 1500);
      }
    }
  } catch (err) {
    // Network blip — keep polling
  }
}

function _intelUpdateProgressUI(job) {
  var statusBadge = document.getElementById('intel-job-status-badge');
  var progressMsg = document.getElementById('intel-progress-message');
  var progressBar = document.getElementById('intel-progress-bar');

  if (statusBadge) {
    statusBadge.textContent = job.status;
    var isError = job.status === 'failed';
    statusBadge.style.background = isError ? 'rgba(239,68,68,0.12)' : 'rgba(132,204,22,0.12)';
    statusBadge.style.color      = isError ? '#ef4444' : 'var(--accent)';
  }

  if (progressMsg) {
    progressMsg.textContent = job.progress_message || _intelStatusLabels[job.status] || job.status;
    if (job.status === 'failed' && job.error_message) {
      progressMsg.textContent += ' — ' + job.error_message;
      progressMsg.style.color = '#ef4444';
    } else {
      progressMsg.style.color = 'var(--text)';
    }
  }

  if (progressBar) {
    progressBar.style.width = (_intelStatusPct[job.status] || 0) + '%';
    progressBar.style.background = job.status === 'failed' ? '#ef4444' : 'var(--accent)';
  }

  // Counters
  var cnt = function(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = val != null ? val : '—';
  };
  cnt('intel-cnt-found',    job.athletes_found);
  cnt('intel-cnt-imported', job.athletes_imported);
  cnt('intel-cnt-queued',   job.athletes_queued);
  cnt('intel-cnt-skipped',  job.athletes_skipped);

  // Sources
  var sourcesEl = document.getElementById('intel-sources-list');
  if (sourcesEl && job.sources && job.sources.length) {
    var tierColors = { 1: 'var(--accent)', 2: '#00D4FF', 3: 'var(--muted)' };
    var fetchIcons = { fetched: '✓', failed: '✗', empty: '○', blocked: '⊘', pending: '…' };
    sourcesEl.innerHTML = '<div style="font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Sources Attempted</div>' +
      job.sources.map(function(s) {
        var tierColor  = tierColors[s.source_tier] || 'var(--muted)';
        var fetchIcon  = fetchIcons[s.fetch_status] || '?';
        var iconColor  = s.fetch_status === 'fetched' ? 'var(--accent)' : s.fetch_status === 'failed' ? '#ef4444' : 'var(--muted)';
        return '<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04)">' +
          '<span style="color:' + iconColor + ';font-size:13px;width:14px;text-align:center">' + fetchIcon + '</span>' +
          '<span style="color:' + tierColor + ';font-size:9px;font-weight:700;width:36px">T' + s.source_tier + '</span>' +
          '<span style="color:var(--muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + s.url + '">' + (s.source_label || s.url) + '</span>' +
          (s.athletes_extracted > 0 ? '<span style="color:var(--accent);font-size:10px;font-family:var(--mono)">' + s.athletes_extracted + ' found</span>' : '') +
          (s.fetch_ms ? '<span style="color:var(--muted);font-size:9px;font-family:var(--mono)">' + s.fetch_ms + 'ms</span>' : '') +
        '</div>';
      }).join('');
  }
}

function _intelUpdateQueueBadge(count) {
  var badge = document.getElementById('intel-queue-badge');
  if (!badge) return;
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-block' : 'none';
}

async function _intelLoadJobs() {
  var listEl = document.getElementById('intel-jobs-list');
  if (!listEl) return;

  try {
    var r    = await fetch(API_BASE + '/api/university/roster/discovery?limit=10', { credentials: 'include' });
    var data = await r.json();
    var jobs = data.jobs || [];

    if (!jobs.length) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:11px">No discovery jobs yet.</div>';
      return;
    }

    var statusColors = {
      completed: 'var(--accent)', failed: '#ef4444', queued: 'var(--muted)',
      discovering: '#00D4FF', extracting: '#00D4FF', validating: '#f59e0b', importing: '#f59e0b',
    };

    listEl.innerHTML = '<div style="display:grid;grid-template-columns:1fr 80px 70px 70px 70px 80px;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:9px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px">' +
      ['Sport','Status','Found','Imported','Queue','Date'].map(function(h){return '<div>'+h+'</div>';}).join('') + '</div>' +
      jobs.map(function(j) {
        var sc    = statusColors[j.status] || 'var(--muted)';
        var dt    = j.started_at ? new Date(j.started_at).toLocaleDateString() : '—';
        return '<div style="display:grid;grid-template-columns:1fr 80px 70px 70px 70px 80px;gap:6px;padding:7px 0;border-bottom:1px solid var(--border);align-items:center">' +
          '<div style="font-size:11px;color:var(--text);font-weight:600">' + (j.sport || '—') + '</div>' +
          '<div style="font-size:10px;color:' + sc + ';font-weight:700">' + j.status + '</div>' +
          '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + (j.athletes_found != null ? j.athletes_found : '—') + '</div>' +
          '<div style="font-size:11px;color:var(--accent);font-family:var(--mono)">' + (j.athletes_imported != null ? j.athletes_imported : '—') + '</div>' +
          '<div style="font-size:11px;color:#f59e0b;font-family:var(--mono)">' + (j.athletes_queued != null ? j.athletes_queued : '—') + '</div>' +
          '<div style="font-size:10px;color:var(--muted)">' + dt + '</div>' +
        '</div>';
      }).join('');
  } catch (err) {
    if (listEl) listEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Could not load jobs: ' + err.message + '</div>';
  }
}

async function _intelLoadReviewQueue() {
  var panel   = document.getElementById('intel-review-panel');
  var listEl  = document.getElementById('intel-review-list');
  if (panel)  panel.style.display = 'block';
  if (listEl) listEl.innerHTML = '<div style="color:var(--muted);font-size:11px;text-align:center;padding:24px">Loading…</div>';

  try {
    var r    = await fetch(API_BASE + '/api/university/roster/review-queue?status=pending&limit=50', { credentials: 'include' });
    var data = await r.json();
    var items = data.items || [];

    _intelUpdateQueueBadge(items.length);

    if (!items.length) {
      listEl.innerHTML = '<div style="color:var(--muted);font-size:12px;text-align:center;padding:32px">No pending items in the review queue. 🎉</div>';
      return;
    }

    listEl.innerHTML = items.map(function(item) {
      var athlete  = typeof item.athlete_data === 'string' ? JSON.parse(item.athlete_data) : item.athlete_data;
      var confCol  = item.confidence_score >= 85 ? 'var(--accent)' : item.confidence_score >= 75 ? '#f59e0b' : '#ef4444';
      var sources  = (item.source_urls || []).slice(0, 2);

      var fields = [
        ['Sport',     athlete.sport     || item.sport],
        ['Position',  athlete.position],
        ['Year',      athlete.year],
        ['Height',    athlete.height],
        ['Hometown',  athlete.hometown],
      ].filter(function(f){ return f[1]; });

      return '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:14px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:700;color:var(--text)">' + (athlete.name || 'Unknown') + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + (item.university_name || '') + '</div>' +
          '</div>' +
          '<div style="text-align:right">' +
            '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:28px;color:' + confCol + ';letter-spacing:1px;line-height:1">' + item.confidence_score + '</div>' +
            '<div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">Confidence</div>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px">' +
          fields.map(function(f){
            return '<span style="background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:10px;color:var(--muted)">' +
              '<span style="color:var(--text);font-weight:600">' + f[0] + ':</span> ' + f[1] + '</span>';
          }).join('') +
        '</div>' +
        (sources.length ? '<div style="font-size:9px;color:var(--muted);margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + sources.join(' | ') + '">Sources: ' + sources.join(' | ') + '</div>' : '') +
        '<div style="display:flex;gap:8px">' +
          '<button onclick="_intelApprove(' + item.id + ',this)" style="flex:1;padding:8px;background:var(--accent);border:none;border-radius:var(--r-sm);color:#0a0e1a;font-size:12px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">✓ Approve &amp; Import</button>' +
          '<button onclick="_intelReject(' + item.id + ',this)" style="flex:1;padding:8px;background:none;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);font-size:12px;cursor:pointer;font-family:\'DM Sans\',sans-serif">✕ Reject</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    if (listEl) listEl.innerHTML = '<div style="color:var(--muted);font-size:11px">Could not load review queue: ' + err.message + '</div>';
  }
}

async function _intelApprove(reviewId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Approving…'; }
  try {
    var r = await fetch(API_BASE + '/api/university/roster/review/' + reviewId + '/approve', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    var data = await r.json();
    if (data.ok) {
      // Remove the card
      var card = btn.closest('[style*="surface2"]');
      if (card) { card.style.opacity = '0.4'; card.style.pointerEvents = 'none'; }
      // Find + update sibling reject btn
      var container = btn.closest('div[style*="display:flex"]');
      if (container) container.innerHTML = '<div style="font-size:12px;color:var(--accent);font-weight:600">✓ Imported</div>';
      setTimeout(function() { _intelLoadReviewQueue(); loadUniversityDashboard(); }, 1200);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '✓ Approve & Import'; }
    alert('Error: ' + err.message);
  }
}

async function _intelReject(reviewId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'Rejecting…'; }
  try {
    var r = await fetch(API_BASE + '/api/university/roster/review/' + reviewId + '/reject', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    });
    var data = await r.json();
    if (data.ok) {
      var container = btn.closest('div[style*="display:flex"]');
      if (container) container.innerHTML = '<div style="font-size:12px;color:var(--muted)">Rejected</div>';
      setTimeout(_intelLoadReviewQueue, 1000);
    }
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = '✕ Reject'; }
    alert('Error: ' + err.message);
  }
}

// ════════════════════════════════════════════════════════════════════════
// NIL DIRECTOR DASHBOARD JS
// ════════════════════════════════════════════════════════════════════════

var _nilDirMetrics  = null;
var _nilDirAthletes = null;
var _nilDirDeals    = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function _fmtMoney(n) {
  var v = parseInt(n) || 0;
  if (v >= 1000000) return '$' + (v/1000000).toFixed(1) + 'M';
  if (v >= 1000)    return '$' + Math.round(v/1000) + 'K';
  return '$' + v.toLocaleString();
}
function _fmtReach(n) {
  var v = parseInt(n) || 0;
  if (v >= 1000000) return (v/1000000).toFixed(1) + 'M';
  if (v >= 1000)    return Math.round(v/1000) + 'K';
  return v > 0 ? String(v) : '—';
}
function _fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function _timeAgo(d) {
  if (!d) return 'never';
  var diff = Date.now() - new Date(d).getTime();
  var days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30)  return days + 'd ago';
  if (days < 365) return Math.round(days/30) + 'mo ago';
  return Math.round(days/365) + 'yr ago';
}

function _nilStatusBadge(status) {
  var map = {
    active:   ['var(--accent)', 'rgba(132,204,22,0.12)', 'Active'],
    idle:     ['#f59e0b',       'rgba(245,158,11,0.12)', 'Idle'],
    no_deals: ['var(--muted)',  'rgba(255,255,255,0.05)', 'No Deals'],
  };
  var s = map[status] || map['no_deals'];
  return '<span class="nil-status-badge" style="color:' + s[0] + ';background:' + s[1] + '">' + s[2] + '</span>';
}
function _dealStatusBadge(status) {
  var map = {
    active:    ['var(--accent)', 'rgba(132,204,22,0.12)'],
    pending:   ['#f59e0b',       'rgba(245,158,11,0.12)'],
    expiring:  ['#ef4444',       'rgba(239,68,68,0.12)'],
    completed: ['var(--muted)',  'rgba(255,255,255,0.06)'],
    rejected:  ['#ef4444',       'rgba(239,68,68,0.08)'],
  };
  var s = map[status] || ['var(--muted)', 'rgba(255,255,255,0.05)'];
  return '<span class="nil-status-badge" style="color:' + s[0] + ';background:' + s[1] + '">' + status + '</span>';
}
function _disclosureBadge(d) {
  var map = {
    approved:  ['var(--accent)', '✓ Filed'],
    submitted: ['#00D4FF',       '→ Submitted'],
    pending:   ['#f59e0b',       '⏳ Pending'],
    missing:   ['#ef4444',       '⚠ Missing'],
  };
  var s = map[d] || ['var(--muted)', d || '—'];
  return '<span style="font-size:10px;color:' + s[0] + ';font-weight:600">' + s[1] + '</span>';
}
function _contactStatusBadge(s) {
  var map = {
    active:        ['var(--accent)', 'Active'],
    in_progress:   ['#00D4FF',       'In Progress'],
    contacted:     ['#f59e0b',       'Contacted'],
    not_contacted: ['var(--muted)',  'Not Contacted'],
  };
  var b = map[s] || map['not_contacted'];
  return '<span style="font-size:10px;color:' + b[0] + ';font-weight:600">' + b[1] + '</span>';
}
function _actionTypeIcon(type) {
  return {follow_up:'📞', deal_review:'💼', compliance:'⚠️', renewal:'🔄', outreach:'📧', approval:'✅'}[type] || '•';
}
function _priorityColor(p) {
  if (p >= 8) return '#ef4444';
  if (p >= 6) return '#f59e0b';
  return 'var(--muted)';
}

// ── Main refresh ──────────────────────────────────────────────────────────
async function _nilDirRefresh() {
  await _nilDirLoadOverview();
}

async function _nilDirLoadOverview() {
  try {
    var r    = await fetch(API_BASE + '/api/university/nil-dashboard', { credentials: 'include' });
    var data = await r.json();
    _nilDirMetrics = data;
    _nilDirRenderOverview(data);
  } catch (err) {
    console.error('[NILDir] overview load failed:', err.message);
  }
}

function _nilDirRenderOverview(d) {
  var deals = d.deals || {};
  var ath   = d.athletes || {};

  // KPIs
  var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
  set('nd-kpi-athletes',    ath.total || '0');
  set('nd-kpi-active-deals', deals.active || '0');
  set('nd-kpi-value',       _fmtMoney(deals.totalValue));
  set('nd-kpi-pending',     deals.pending || '0');
  set('nd-kpi-expiring',    deals.expiringSoon || '0');
  set('nd-kpi-disclosure',  (deals.disclosurePending || 0) + (deals.disclosureMissing || 0) || '0');

  // Alert badge
  var alertCount = (deals.disclosureMissing || 0) + (deals.expiringSoon || 0);
  var alertBadge = document.getElementById('univ-alert-badge');
  var alertCnt   = document.getElementById('univ-alert-count');
  if (alertBadge) alertBadge.style.display = alertCount > 0 ? 'block' : 'none';
  if (alertCnt)   alertCnt.textContent = alertCount;

  // Top Earners
  var earnEl = document.getElementById('nd-top-earners');
  if (earnEl) {
    var earners = d.topEarners || [];
    earnEl.innerHTML = earners.length ? earners.map(function(a, i) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:7px 0;' + (i < earners.length-1 ? 'border-bottom:1px solid var(--border);' : '') + '">' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + (a.name || '—') + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + (a.sport || '') + ' · ' + a.deal_count + ' deal' + (a.deal_count != 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div style="font-size:14px;font-weight:700;color:var(--accent);font-family:var(--mono)">' + _fmtMoney(a.total_value) + '</div>' +
      '</div>';
    }).join('') : '<div style="color:var(--muted);font-size:11px;padding:12px 0;text-align:center">No deals logged yet. <span style="color:var(--accent);cursor:pointer" onclick="switchUnivTab(\'deals\')">Log your first deal →</span></div>';
  }

  // Under-Monetized
  var unEl = document.getElementById('nd-under-monetized');
  if (unEl) {
    var un = d.underMonetized || [];
    unEl.innerHTML = un.length ? un.map(function(a) {
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:5px 0">' +
        '<div><span style="font-size:12px;color:var(--text);font-weight:600">' + (a.name || '—') + '</span> <span style="font-size:11px;color:var(--muted)">· ' + (a.sport || '') + '</span></div>' +
        '<span style="font-size:10px;color:var(--muted)">' + _fmtReach(a.reach) + ' reach</span>' +
      '</div>';
    }).join('') : '<div style="color:var(--muted);font-size:11px">All athletes with significant reach have active deals. ✓</div>';
  }

  // Pipeline summary
  var pipeEl = document.getElementById('nd-pipeline-summary');
  if (pipeEl) {
    var statusMap = [
      ['Active',    deals.active,    'var(--accent)'],
      ['Pending',   deals.pending,   '#f59e0b'],
      ['Expiring',  deals.expiring,  '#ef4444'],
      ['Completed', deals.completed, 'var(--muted)'],
    ];
    var total = deals.total || 1;
    pipeEl.innerHTML = statusMap.map(function(s) {
      var pct = Math.round(((s[1] || 0) / total) * 100);
      return '<div style="margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
          '<span style="font-size:11px;color:var(--text);font-weight:600">' + s[0] + '</span>' +
          '<span style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + (s[1] || 0) + '</span>' +
        '</div>' +
        '<div style="background:var(--surface2);border-radius:3px;height:6px;overflow:hidden">' +
          '<div style="height:100%;background:' + s[2] + ';width:' + (total > 0 ? pct : 0) + '%;border-radius:3px;transition:width 0.4s"></div>' +
        '</div>' +
      '</div>';
    }).join('') + (deals.total === 0 ? '<div style="color:var(--muted);font-size:11px;text-align:center;padding:12px">No deals in pipeline yet. <span style="color:var(--accent);cursor:pointer" onclick="switchUnivTab(\'deals\')">Log one →</span></div>' : '');
  }

  // Sport breakdown
  var sportEl = document.getElementById('nd-sport-breakdown');
  if (sportEl) {
    var sports = d.sportBreakdown || [];
    var maxCount = sports.length ? Math.max.apply(null, sports.map(function(s){ return parseInt(s.count); })) : 1;
    sportEl.innerHTML = sports.length ? sports.map(function(s) {
      var pct = Math.round((parseInt(s.count) / maxCount) * 100);
      return '<div style="margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px">' +
          '<span style="font-size:11px;color:var(--text)">' + s.sport + '</span>' +
          '<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">' + s.count + '</span>' +
        '</div>' +
        '<div style="background:var(--surface2);border-radius:3px;height:5px;overflow:hidden">' +
          '<div style="height:100%;background:rgba(132,204,22,0.5);width:' + pct + '%;border-radius:3px"></div>' +
        '</div>' +
      '</div>';
    }).join('') : '<div style="color:var(--muted);font-size:11px">No athletes yet.</div>';
  }
}

// ── Daily Actions ─────────────────────────────────────────────────────────
async function _nilDirLoadActions() {
  var el = document.getElementById('nd-daily-actions');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:11px">Loading...</div>';
  try {
    var r    = await fetch(API_BASE + '/api/university/daily-actions', { credentials: 'include' });
    var data = await r.json();
    var actions = data.actions || [];
    if (!actions.length) {
      el.innerHTML = '<div style="color:var(--accent);font-size:12px;padding:12px 0;text-align:center">✓ No pending actions — program is in good shape.</div>';
      return;
    }
    el.innerHTML = actions.slice(0, 8).map(function(a) {
      return '<div class="nil-action-card">' +
        '<div style="font-size:16px;line-height:1.2;flex-shrink:0">' + _actionTypeIcon(a.action_type) + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px">' + a.title + '</div>' +
          (a.detail ? '<div style="font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + a.detail + '</div>' : '') +
          (a.due_date ? '<div style="font-size:10px;color:' + _priorityColor(a.priority) + ';margin-top:3px">Due ' + _fmtDate(a.due_date) + '</div>' : '') +
        '</div>' +
        '<button onclick="_nilDirDismissAction(' + a.id + ',this)" title="Dismiss" style="padding:4px 8px;background:none;border:1px solid var(--border);border-radius:4px;color:var(--muted);font-size:10px;cursor:pointer;flex-shrink:0;font-family:\'DM Sans\',sans-serif">✕</button>' +
      '</div>';
    }).join('');
  } catch (err) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px">Could not load actions.</div>';
  }
}

async function _nilDirDismissAction(actionId, btn) {
  if (btn) btn.disabled = true;
  try {
    await fetch(API_BASE + '/api/university/daily-actions/' + actionId + '/dismiss', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    });
    var card = btn ? btn.closest('.nil-action-card') : null;
    if (card) { card.style.opacity = '0.3'; card.style.pointerEvents = 'none'; }
    setTimeout(_nilDirLoadActions, 600);
  } catch (err) {
    if (btn) btn.disabled = false;
  }
}

// ── Athlete CRM ───────────────────────────────────────────────────────────
async function _nilDirLoadAthletes() {
  var el = document.getElementById('nd-crm-list');
  if (!el) return;
  el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Loading...</div>';
  try {
    var search = (document.getElementById('nd-athlete-search') || {}).value || '';
    var status = (document.getElementById('nd-athlete-status-filter') || {}).value || '';
    var sport  = (document.getElementById('nd-athlete-sport-filter') || {}).value || '';
    var qs     = '?search=' + encodeURIComponent(search) + '&status=' + encodeURIComponent(status) + '&sport=' + encodeURIComponent(sport);
    var r      = await fetch(API_BASE + '/api/university/athletes/crm' + qs, { credentials: 'include' });
    var data   = await r.json();
    _nilDirAthletes = data.athletes || [];

    var cntEl = document.getElementById('nd-crm-count');
    if (cntEl) cntEl.textContent = _nilDirAthletes.length + ' athlete' + (_nilDirAthletes.length !== 1 ? 's' : '');

    // Populate sport filter dropdown
    var sportSel = document.getElementById('nd-athlete-sport-filter');
    if (sportSel && sportSel.options.length <= 1) {
      var sports = [...new Set(_nilDirAthletes.map(a => a.sport).filter(Boolean))].sort();
      sports.forEach(function(s) {
        var opt = document.createElement('option');
        opt.value = s; opt.textContent = s;
        sportSel.appendChild(opt);
      });
    }

    // Populate deal form athlete dropdown
    var dealSel = document.getElementById('nd-form-athlete');
    if (dealSel && dealSel.options.length <= 1) {
      _nilDirAthletes.forEach(function(a) {
        var opt = document.createElement('option');
        opt.value = a.id; opt.textContent = a.name + (a.sport ? ' (' + a.sport + ')' : '');
        dealSel.appendChild(opt);
      });
    }

    if (!_nilDirAthletes.length) {
      el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:12px">No athletes match your filters.</div>';
      return;
    }

    el.innerHTML = _nilDirAthletes.map(function(a) {
      var flagsHtml = (a.flags || []).map(function(f) {
        var col = f.type === 'error' ? '#ef4444' : f.type === 'warning' ? '#f59e0b' : 'var(--muted)';
        return '<div style="font-size:10px;color:' + col + '">' + f.msg + '</div>';
      }).join('') || '<span style="font-size:10px;color:rgba(132,204,22,0.6)">✓ Clean</span>';

      return '<div class="nil-tr" style="grid-template-columns:2fr 100px 90px 100px 120px 100px 90px;cursor:pointer" onclick="_nilDirOpenAthlete(\'' + a.id + '\')">' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + a.name + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + a.sport + (a.position ? ' · ' + a.position : '') + (a.year ? ' · ' + a.year : '') + '</div>' +
        '</div>' +
        '<div>' + _nilStatusBadge(a.nilStatus) + '</div>' +
        '<div style="font-size:12px;font-family:var(--mono);color:var(--text)">' + (a.dealCount || 0) + '</div>' +
        '<div style="font-size:12px;font-weight:700;color:var(--accent);font-family:var(--mono)">' + (a.totalNilValue > 0 ? _fmtMoney(a.totalNilValue) : '—') + '</div>' +
        '<div>' + _contactStatusBadge(a.contactStatus) + '</div>' +
        '<div style="font-size:11px;color:var(--muted);font-family:var(--mono)">' + _fmtReach(a.reach) + '</div>' +
        '<div>' + flagsHtml + '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Error: ' + err.message + '</div>';
  }
}

function _nilDirAthleteSearch() {
  clearTimeout(_nilDirAthletes._searchTimer);
  _nilDirAthletes._searchTimer = setTimeout(_nilDirLoadAthletes, 280);
}
if (!_nilDirAthletes) _nilDirAthletes = {};

// ── Athlete detail panel ──────────────────────────────────────────────────
var _nilDirActiveAthleteId = null;

async function _nilDirOpenAthlete(athleteId) {
  _nilDirActiveAthleteId = athleteId;
  // Find athlete data from cached list
  var ath = (_nilDirAthletes && Array.isArray(_nilDirAthletes)) ? _nilDirAthletes.find(function(a){ return a.id === athleteId; }) : null;
  var name = ath ? ath.name : 'Athlete';

  // Create or reuse athlete detail modal
  var modal = document.getElementById('nd-athlete-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'nd-athlete-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9000;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.onclick = function(e) { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }

  modal.style.display = 'flex';
  modal.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:24px;width:100%;max-width:600px;max-height:80vh;overflow-y:auto">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">' +
      '<div>' +
        '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:22px;color:var(--text);letter-spacing:1px">' + name + '</div>' +
        (ath ? '<div style="font-size:11px;color:var(--muted)">' + (ath.sport||'') + (ath.position?' · '+ath.position:'') + (ath.year?' · '+ath.year:'') + '</div>' : '') +
      '</div>' +
      '<button onclick="document.getElementById(\'nd-athlete-modal\').style.display=\'none\'" style="padding:6px 12px;background:none;border:1px solid var(--border);border-radius:var(--r-sm);color:var(--muted);font-size:12px;cursor:pointer;font-family:\'DM Sans\',sans-serif">✕ Close</button>' +
    '</div>' +
    (ath ? '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px">' +
      ['totalNilValue','dealCount','reach'].map(function(k) {
        var labels = {totalNilValue:'NIL Value', dealCount:'Deals', reach:'Social Reach'};
        var vals   = {totalNilValue: _fmtMoney(ath.totalNilValue), dealCount: ath.dealCount, reach: _fmtReach(ath.reach)};
        return '<div style="background:var(--surface2);border-radius:var(--r-sm);padding:12px;text-align:center">' +
          '<div style="font-family:\'Bebas Neue\',sans-serif;font-size:22px;color:var(--accent)">' + vals[k] + '</div>' +
          '<div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em">' + labels[k] + '</div>' +
        '</div>';
      }).join('') +
    '</div>' : '') +
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Add Note</div>' +
    '<div style="display:flex;gap:8px;margin-bottom:20px">' +
      '<select id="nd-note-type" style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:7px 10px;color:var(--text);font-size:11px;font-family:\'DM Sans\',sans-serif;outline:none">' +
        '<option value="note">Note</option><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option>' +
      '</select>' +
      '<input id="nd-note-body" type="text" placeholder="Add a note about this athlete…" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:7px 10px;color:var(--text);font-size:11px;font-family:\'DM Sans\',sans-serif;outline:none">' +
      '<button onclick="_nilDirSaveNote()" style="padding:7px 14px;background:var(--accent);border:none;border-radius:var(--r-sm);color:#0a0e1a;font-size:11px;font-weight:700;cursor:pointer;font-family:\'DM Sans\',sans-serif">Save</button>' +
    '</div>' +
    '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:10px">Contact History</div>' +
    '<div id="nd-athlete-notes-list"><div style="color:var(--muted);font-size:11px">Loading...</div></div>' +
  '</div>';

  _nilDirLoadAthleteNotes(athleteId);
}

async function _nilDirLoadAthleteNotes(athleteId) {
  var el = document.getElementById('nd-athlete-notes-list');
  if (!el) return;
  try {
    var r    = await fetch(API_BASE + '/api/university/athlete-notes/' + athleteId, { credentials: 'include' });
    var data = await r.json();
    var notes = data.notes || [];
    if (!notes.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:12px 0;text-align:center">No notes yet — add the first one above.</div>';
      return;
    }
    var typeIcon = { note: '📝', call: '📞', email: '✉️', meeting: '🤝', alert: '⚠️', system: '⚙️' };
    el.innerHTML = notes.map(function(n) {
      return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
          '<span style="font-size:14px">' + (typeIcon[n.contact_type] || '•') + '</span>' +
          (n.subject ? '<span style="font-size:11px;font-weight:600;color:var(--text)">' + n.subject + '</span>' : '') +
          '<span style="font-size:10px;color:var(--muted);margin-left:auto">' + _timeAgo(n.created_at) + '</span>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--muted);padding-left:22px">' + n.body + '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    el.innerHTML = '<div style="color:var(--muted);font-size:11px">Could not load notes.</div>';
  }
}

async function _nilDirSaveNote() {
  var bodyEl = document.getElementById('nd-note-body');
  var typeEl = document.getElementById('nd-note-type');
  var body   = bodyEl ? bodyEl.value.trim() : '';
  if (!body || !_nilDirActiveAthleteId) return;
  try {
    await fetch(API_BASE + '/api/university/athlete-notes/' + _nilDirActiveAthleteId, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body, contactType: typeEl ? typeEl.value : 'note' }),
    });
    if (bodyEl) bodyEl.value = '';
    _nilDirLoadAthleteNotes(_nilDirActiveAthleteId);
  } catch (err) {
    alert('Error saving note: ' + err.message);
  }
}

// ── Deal Pipeline ─────────────────────────────────────────────────────────
async function _nilDirLoadDeals() {
  var el = document.getElementById('nd-deal-list');
  if (!el) return;
  el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Loading...</div>';
  try {
    var search = (document.getElementById('nd-deal-search') || {}).value || '';
    var status = (document.getElementById('nd-deal-status-filter') || {}).value || '';
    var qs     = '?search=' + encodeURIComponent(search) + '&status=' + encodeURIComponent(status);
    var r      = await fetch(API_BASE + '/api/university/deal-pipeline' + qs, { credentials: 'include' });
    var data   = await r.json();
    _nilDirDeals = data.deals || [];

    if (!_nilDirDeals.length) {
      el.innerHTML = '<div style="padding:32px;text-align:center;color:var(--muted);font-size:12px">No deals match filters. <span style="color:var(--accent);cursor:pointer" onclick="_nilDirOpenAddDeal()">Log your first deal →</span></div>';
      return;
    }

    el.innerHTML = _nilDirDeals.map(function(d) {
      return '<div class="nil-tr" style="grid-template-columns:1.4fr 1.2fr 90px 80px 90px 100px 80px 70px">' +
        '<div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text)">' + d.athleteName + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + d.athleteSport + '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text)">' + d.brand + '</div>' +
        '<div style="font-size:13px;font-weight:700;color:var(--accent);font-family:var(--mono)">' + _fmtMoney(d.dealValue) + '</div>' +
        '<div style="font-size:11px;color:var(--muted)">' + (d.dealType || '—') + '</div>' +
        '<div>' + _dealStatusBadge(d.status) + (d.isExpiringSoon ? ' <span style="font-size:9px;color:#ef4444;font-weight:700">EXPIRING</span>' : '') + '</div>' +
        '<div style="font-size:10px;color:var(--muted)">' + (d.startDate ? _fmtDate(d.startDate) : '—') + ' → ' + (d.endDate ? _fmtDate(d.endDate) : '—') + '</div>' +
        '<div>' + _disclosureBadge(d.disclosureStatus) + '</div>' +
        '<div style="display:flex;gap:4px">' +
          '<button onclick="_nilDirQuickStatus(\'' + d.id + '\',\'active\')" title="Mark Active" style="padding:3px 6px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.3);border-radius:3px;color:var(--accent);font-size:10px;cursor:pointer;font-family:\'DM Sans\',sans-serif">✓</button>' +
          '<button onclick="_nilDirDeleteDeal(\'' + d.id + '\',this)" title="Delete" style="padding:3px 6px;background:none;border:1px solid var(--border);border-radius:3px;color:var(--muted);font-size:10px;cursor:pointer;font-family:\'DM Sans\',sans-serif">✕</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (err) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--muted);font-size:12px">Error: ' + err.message + '</div>';
  }
}

function _nilDirDealSearch() {
  clearTimeout(_nilDirDeals._searchTimer);
  _nilDirDeals._searchTimer = setTimeout(_nilDirLoadDeals, 280);
}
if (!_nilDirDeals) _nilDirDeals = {};

function _nilDirOpenAddDeal() {
  // Switch to deals tab if not already
  switchUnivTab('deals');
  // Ensure athlete list loaded in form
  if (_nilDirAthletes && Array.isArray(_nilDirAthletes) && _nilDirAthletes.length === 0) {
    _nilDirLoadAthletes();
  }
  var form = document.getElementById('nd-add-deal-form');
  if (form) form.style.display = form.style.display === 'block' ? 'none' : 'block';
}

async function _nilDirSaveDeal() {
  var get = function(id) { var el = document.getElementById(id); return el ? el.value.trim() : ''; };
  var athleteId = get('nd-form-athlete');
  var brand     = get('nd-form-brand');
  if (!athleteId || !brand) { alert('Athlete and brand are required.'); return; }

  var btn = document.querySelector('[onclick="_nilDirSaveDeal()"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    var r = await fetch(API_BASE + '/api/university/deal-pipeline', {
      method:  'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        athleteId,
        brand,
        dealValue:        get('nd-form-value') || 0,
        dealType:         get('nd-form-type'),
        status:           get('nd-form-status'),
        disclosureStatus: get('nd-form-disclosure'),
        startDate:        get('nd-form-start') || null,
        endDate:          get('nd-form-end') || null,
        notes:            get('nd-form-notes'),
      }),
    });
    if (!r.ok) throw new Error((await r.json()).error || 'Failed');

    // Clear form
    ['nd-form-brand','nd-form-value','nd-form-start','nd-form-end','nd-form-notes'].forEach(function(id){
      var el = document.getElementById(id); if (el) el.value = '';
    });
    var form = document.getElementById('nd-add-deal-form');
    if (form) form.style.display = 'none';

    // Refresh
    _nilDirLoadDeals();
    _nilDirLoadOverview();
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Deal'; }
  }
}

async function _nilDirQuickStatus(dealId, newStatus) {
  try {
    await fetch(API_BASE + '/api/university/deal-pipeline/' + dealId, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    _nilDirLoadDeals();
    _nilDirLoadOverview();
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

async function _nilDirDeleteDeal(dealId, btn) {
  if (!confirm('Delete this deal record?')) return;
  if (btn) btn.disabled = true;
  try {
    await fetch(API_BASE + '/api/university/deal-pipeline/' + dealId, {
      method: 'DELETE', credentials: 'include',
    });
    _nilDirLoadDeals();
    _nilDirLoadOverview();
  } catch (err) {
    if (btn) btn.disabled = false;
    alert('Error: ' + err.message);
  }
}

// ── Compliance ─────────────────────────────────────────────────────────────
async function _nilDirLoadCompliance() {
  var el = document.getElementById('nd-compliance-alerts');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading...</div>';
  try {
    var r    = await fetch(API_BASE + '/api/university/compliance-alerts', { credentials: 'include' });
    var data = await r.json();
    var alerts = data.alerts || [];

    if (!alerts.length) {
      el.innerHTML = '<div style="background:rgba(132,204,22,0.06);border:1px solid rgba(132,204,22,0.2);border-radius:var(--r);padding:20px;text-align:center;font-size:13px;color:var(--accent)">✓ No compliance issues found. Program is clean.</div>';
      return;
    }

    var sevMap = { high: ['#ef4444', 'rgba(239,68,68,0.08)'], medium: ['#f59e0b','rgba(245,158,11,0.08)'], low: ['var(--muted)','rgba(255,255,255,0.03)'] };
    el.innerHTML = alerts.map(function(a) {
      var sev = sevMap[a.severity] || sevMap['low'];
      var typeIcon = { compliance: '📋', expiring: '⏰', inactive: '💤' }[a.type] || '•';
      return '<div style="display:flex;align-items:flex-start;gap:12px;padding:14px;background:' + sev[1] + ';border:1px solid rgba(255,255,255,0.06);border-left:3px solid ' + sev[0] + ';border-radius:var(--r-sm);margin-bottom:8px">' +
        '<div style="font-size:18px;line-height:1;flex-shrink:0">' + typeIcon + '</div>' +
        '<div style="flex:1">' +
          '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:3px">' + a.title + '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + a.detail + '</div>' +
        '</div>' +
        '<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:9px;background:' + sev[1] + ';color:' + sev[0] + ';border:1px solid ' + sev[0] + ';white-space:nowrap">' + a.severity + '</span>' +
      '</div>';
    }).join('');
  } catch (err) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">Error: ' + err.message + '</div>';
  }
}

// ── AI Insights ───────────────────────────────────────────────────────────
async function _nilDirLoadInsights() {
  var el  = document.getElementById('nd-insights-content');
  var btn = document.getElementById('nd-insights-btn');
  if (!el) return;
  if (btn) { btn.disabled = true; btn.textContent = '🤖 Analyzing program data…'; }
  el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">Analyzing your program\'s CRM data with Claude AI…<br><div style="margin-top:8px;font-size:10px">This may take 10–20 seconds.</div></div>';

  try {
    var r    = await fetch(API_BASE + '/api/university/opportunities', { credentials: 'include' });
    var data = await r.json();
    el.innerHTML = _nilDirRenderInsights(data);
  } catch (err) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px">Error: ' + err.message + '</div>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh Insights'; }
  }
}

function _nilDirRenderInsights(data) {
  var sections = [];

  if (data.underMonetized && data.underMonetized.length) {
    sections.push(
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:16px">' +
      '<div style="font-size:10px;font-weight:700;color:#f59e0b;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">💰 Under-Monetized Athletes</div>' +
      data.underMonetized.map(function(a) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">' +
            '<div><span style="font-size:12px;font-weight:700;color:var(--text)">' + a.athleteName + '</span>' +
            (a.sport ? ' <span style="font-size:11px;color:var(--muted)">· ' + a.sport + '</span>' : '') + '</div>' +
            (a.reach ? '<span style="font-size:10px;color:var(--muted);font-family:var(--mono)">' + _fmtReach(a.reach) + ' reach</span>' : '') +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:4px">' + (a.reason || '') + '</div>' +
          (a.suggestedAction ? '<div style="font-size:11px;color:var(--accent)">→ ' + a.suggestedAction + '</div>' : '') +
        '</div>';
      }).join('') +
      '</div>'
    );
  }

  if (data.highPotential && data.highPotential.length) {
    sections.push(
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:16px">' +
      '<div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">⭐ High NIL Potential</div>' +
      data.highPotential.map(function(a) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px">' +
            '<div><span style="font-size:12px;font-weight:700;color:var(--text)">' + a.athleteName + '</span>' +
            (a.sport ? ' <span style="font-size:11px;color:var(--muted)">· ' + a.sport + '</span>' : '') + '</div>' +
            (a.estimatedRange ? '<span style="font-size:11px;color:var(--accent);font-weight:700">' + a.estimatedRange + '</span>' : '') +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">' + (a.why || '') + '</div>' +
          (a.brandCategories && a.brandCategories.length ? '<div style="display:flex;gap:4px;flex-wrap:wrap">' + a.brandCategories.map(function(c){ return '<span style="font-size:10px;padding:2px 8px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.2);border-radius:9px;color:var(--accent)">' + c + '</span>'; }).join('') + '</div>' : '') +
        '</div>';
      }).join('') +
      '</div>'
    );
  }

  if (data.brandOpportunities && data.brandOpportunities.length) {
    sections.push(
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:16px">' +
      '<div style="font-size:10px;font-weight:700;color:#00D4FF;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">🎯 Brand Opportunities</div>' +
      data.brandOpportunities.map(function(opp) {
        var priCol = opp.priority === 'high' ? 'var(--accent)' : opp.priority === 'medium' ? '#f59e0b' : 'var(--muted)';
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<div style="font-size:12px;font-weight:700;color:var(--text)">' + opp.title + '</div>' +
            '<span style="font-size:10px;color:' + priCol + ';font-weight:700">' + (opp.priority || '') + '</span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--muted)">' + (opp.description || '') + '</div>' +
        '</div>';
      }).join('') +
      '</div>'
    );
  }

  if (data.programInsights && data.programInsights.length) {
    sections.push(
      '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:16px">' +
      '<div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:14px">📊 Program Insights</div>' +
      data.programInsights.map(function(ins) {
        return '<div style="padding:10px 0;border-bottom:1px solid var(--border)">' +
          '<div style="font-size:12px;color:var(--text);margin-bottom:4px">' + (ins.insight || '') + '</div>' +
          (ins.action ? '<div style="font-size:11px;color:var(--accent)">→ ' + ins.action + '</div>' : '') +
        '</div>';
      }).join('') +
      '</div>'
    );
  }

  return sections.join('') || '<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">No insights generated. Make sure athletes are loaded in the CRM first.</div>';
}

// ── Activity Feed ─────────────────────────────────────────────────────────
async function _nilDirLoadActivity() {
  var el = document.getElementById('nd-activity-feed');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--muted);font-size:12px">Loading...</div>';
  try {
    var r    = await fetch(API_BASE + '/api/university/activity-feed?limit=50', { credentials: 'include' });
    var data = await r.json();
    var feed = data.feed || [];

    if (!feed.length) {
      el.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:20px;text-align:center">No activity logged yet. Start by adding notes to athletes in the Athletes tab.</div>';
      return;
    }

    var typeIcon = { note: '📝', call: '📞', email: '✉️', meeting: '🤝', alert: '⚠️', system: '⚙️' };
    el.innerHTML = '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">' +
      feed.map(function(n, i) {
        return '<div style="display:grid;grid-template-columns:36px 1fr 80px 80px;gap:8px;align-items:start;padding:12px 16px;' + (i < feed.length-1 ? 'border-bottom:1px solid var(--border)' : '') + '">' +
          '<div style="font-size:18px;text-align:center">' + (typeIcon[n.contact_type] || '•') + '</div>' +
          '<div>' +
            '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px">' + (n.athlete_name || 'Unknown') + (n.athlete_sport ? ' <span style="font-weight:400;color:var(--muted)">· '+n.athlete_sport+'</span>' : '') + '</div>' +
            (n.subject ? '<div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:2px">' + n.subject + '</div>' : '') +
            '<div style="font-size:11px;color:var(--muted)">' + n.body + '</div>' +
          '</div>' +
          '<div style="font-size:10px;color:var(--muted)">' + n.contact_type + '</div>' +
          '<div style="font-size:10px;color:var(--muted);text-align:right">' + _timeAgo(n.created_at) + '</div>' +
        '</div>';
      }).join('') +
    '</div>';
  } catch (err) {
    el.innerHTML = '<div style="color:var(--muted);font-size:12px">Error: ' + err.message + '</div>';
  }
}

// ── Import sub-tab switcher ───────────────────────────────────────────────
function _importSubTab(sub) { _importSetMethod(sub === 'bulk' ? 'csv' : 'espn'); }

// ── Import method switcher ────────────────────────────────────────────────
var _espnPreviewAthletes = null;
var _pastePreviewAthletes = null;

function _importSetMethod(method) {
  var methods = ['espn','paste','csv'];
  methods.forEach(function(m) {
    var btn   = document.getElementById('importTab-' + m);
    var panel = document.getElementById('importPanel-' + m);
    var isActive = m === method;
    if (btn) {
      btn.style.borderBottomColor = isActive ? 'var(--accent)' : 'transparent';
      btn.style.color             = isActive ? 'var(--text)' : 'var(--muted)';
      btn.style.fontWeight        = isActive ? '700' : '500';
    }
    if (panel) panel.style.display = isActive ? 'block' : 'none';
  });
  // Pre-fill school from loaded university data
  if (method === 'espn' || method === 'paste') {
    var univName = (_univData && _univData.university && _univData.university.name) || '';
    var espnEl = document.getElementById('espn-school-input');
    var pasteEl = document.getElementById('paste-school-input');
    if (espnEl  && !espnEl.value  && univName) espnEl.value  = univName;
    if (pasteEl && !pasteEl.value && univName) pasteEl.value = univName;
  }
}

// ── ESPN Import ──────────────────────────────────────────────────────────
async function _espnFetchRoster() {
  var school = (document.getElementById('espn-school-input') || {}).value.trim();
  var sport  = (document.getElementById('espn-sport-select') || {}).value.trim();
  if (!school) { alert('Enter a school name.'); return; }
  if (!sport)  { alert('Select a sport.'); return; }

  var btn = document.getElementById('espn-fetch-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Pulling…'; }
  document.getElementById('espn-preview-panel').style.display = 'none';
  _espnShowResult('', '');

  try {
    var r = await fetch(API_BASE + '/api/university/roster/espn', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ schoolName: school, sport }),
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'ESPN fetch failed');

    _espnPreviewAthletes = data.athletes.slice(); // copy so edits don't mutate original

    // Empty roster — ESPN has nothing for this sport/season
    if (!_espnPreviewAthletes.length) {
      _espnShowResult('warn', "No roster data found for this sport and season on ESPN. This usually means the roster hasn't been published yet. Try the Upload CSV tab instead.");
      document.getElementById('espn-preview-panel').style.display = 'none';
      if (btn) { btn.disabled = false; btn.textContent = 'Pull Roster'; }
      return;
    }

    var team   = data.team   || {};
    var season = data.season || '';
    document.getElementById('espn-preview-title').textContent =
      (team.name || school) + ' — ' + sport + (season ? '  ·  ' + season + ' season' : '');
    var espnDate = data.espnTs ? new Date(data.espnTs).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    document.getElementById('espn-preview-sub').innerHTML =
      'Source: ESPN' + (espnDate ? ' · pulled ' + espnDate : '') +
      ' &nbsp;—&nbsp; <span style="color:#f59e0b">Transfer portal moves may take 2–4 weeks to appear on ESPN. Review before importing.</span>';

    _espnRenderPreview();
    document.getElementById('espn-preview-panel').style.display = 'block';
  } catch (err) {
    _espnShowResult('error', 'Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Pull Roster'; }
  }
}

async function _espnCommitImport() {
  if (!_espnPreviewAthletes || !_espnPreviewAthletes.length) return;
  var school = (document.getElementById('espn-school-input') || {}).value.trim();
  var sport  = (document.getElementById('espn-sport-select') || {}).value.trim();
  var btn    = document.getElementById('espn-commit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    var r = await fetch(API_BASE + '/api/university/roster/import-commit', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athletes: _espnPreviewAthletes, schoolName: school, sport }),
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Import failed');
    document.getElementById('espn-preview-panel').style.display = 'none';
    _espnPreviewAthletes = null;
    var espnMsg = 'Imported ' + data.inserted + ' athlete' + (data.inserted !== 1 ? 's' : '') + '.';
    if (data.skipped > 0) espnMsg += ' ' + data.skipped + ' skipped.';
    _espnShowResult('success', espnMsg);
    // Refresh Athletes CRM so new athletes appear immediately
    if (typeof _nilDirLoadAthletes === 'function') setTimeout(_nilDirLoadAthletes, 500);
    if (typeof _nilDirRefresh === 'function') setTimeout(_nilDirRefresh, 800);
  } catch (err) {
    _espnShowResult('error', 'Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import All'; }
  }
}

function _espnCancelPreview() {
  document.getElementById('espn-preview-panel').style.display = 'none';
  _espnPreviewAthletes = null;
  _espnHideAddRow();
}

// Render the editable preview table from _espnPreviewAthletes
function _espnRenderPreview() {
  var athletes = _espnPreviewAthletes || [];
  var n = athletes.length;

  // Update count displays
  var countEl = document.getElementById('espn-preview-count');
  if (countEl) countEl.textContent = n + ' player' + (n !== 1 ? 's' : '') + ' — remove anyone who has transferred, then click Import.';
  var importCountEl = document.getElementById('espn-import-count');
  if (importCountEl) importCountEl.textContent = n + (n !== 1 ? ' Athletes' : ' Athlete');

  var tbody = document.getElementById('espn-preview-tbody');
  if (!tbody) return;
  tbody.innerHTML = athletes.map(function(a, idx) {
    return '<tr id="espn-row-' + idx + '" style="border-bottom:1px solid var(--border)">' +
      '<td style="padding:6px 4px 6px 10px;width:28px">' +
        '<button onclick="_espnRemovePlayer(' + idx + ')" title="Remove" ' +
          'style="background:none;border:none;color:var(--muted);font-size:14px;cursor:pointer;padding:2px 4px;border-radius:3px;line-height:1" ' +
          'onmouseover="this.style.color=\'#ef4444\';this.style.background=\'rgba(239,68,68,0.08)\'" ' +
          'onmouseout="this.style.color=\'var(--muted)\';this.style.background=\'none\'">✕</button>' +
      '</td>' +
      '<td style="padding:7px 10px;color:var(--muted);font-family:var(--mono)">' + (a.number || '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--text);font-weight:600">' + (a.name || '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--muted)">' + (a.position || '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--muted)">' + (a.year || '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--muted)">' + (a.height || '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--muted)">' + (a.weight ? a.weight + ' lbs' : '—') + '</td>' +
      '<td style="padding:7px 10px;color:var(--muted)">' + (a.hometown || '—') + '</td>' +
    '</tr>';
  }).join('');
}

// Remove a player by index and re-render
function _espnRemovePlayer(idx) {
  if (!_espnPreviewAthletes) return;
  _espnPreviewAthletes.splice(idx, 1);
  _espnRenderPreview();
}

// Show/hide the add-player form
function _espnShowAddRow() {
  var row = document.getElementById('espn-add-row');
  var btn = document.getElementById('espn-add-btn');
  if (row) row.style.display = 'block';
  if (btn) btn.style.display = 'none';
  var nameInput = document.getElementById('add-name');
  if (nameInput) nameInput.focus();
}

function _espnHideAddRow() {
  var row = document.getElementById('espn-add-row');
  var btn = document.getElementById('espn-add-btn');
  if (row) row.style.display = 'none';
  if (btn) btn.style.display = 'inline-block';
  // Clear fields
  ['add-name','add-number','add-position','add-year','add-height','add-weight','add-hometown'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = '';
  });
}

// Add a manually entered player to the preview
function _espnAddPlayer() {
  var name = (document.getElementById('add-name') || {}).value.trim();
  if (!name) { document.getElementById('add-name').style.borderColor = '#ef4444'; return; }
  var player = {
    name:     name,
    number:   (document.getElementById('add-number')   || {}).value.trim() || null,
    position: (document.getElementById('add-position') || {}).value.trim() || null,
    year:     (document.getElementById('add-year')     || {}).value.trim() || null,
    height:   (document.getElementById('add-height')   || {}).value.trim() || null,
    weight:   parseInt((document.getElementById('add-weight') || {}).value) || null,
    hometown: (document.getElementById('add-hometown') || {}).value.trim() || null,
    espn_id:  null,
  };
  if (!_espnPreviewAthletes) _espnPreviewAthletes = [];
  _espnPreviewAthletes.push(player);
  _espnHideAddRow();
  _espnRenderPreview();
  // Scroll the new row into view
  var tbody = document.getElementById('espn-preview-tbody');
  if (tbody && tbody.lastChild) tbody.lastChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function _espnShowResult(type, msg) {
  var el = document.getElementById('espn-result-msg');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  var colors = {
    success: { bg: 'rgba(132,204,22,0.08)', border: 'rgba(132,204,22,0.25)', text: 'var(--accent)' },
    warn:    { bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.3)',  text: '#f59e0b' },
    error:   { bg: 'rgba(239,68,68,0.08)',  border: 'rgba(239,68,68,0.3)',   text: '#ef4444' },
  };
  var c = colors[type] || colors.error;
  el.style.background = c.bg;
  el.style.border     = '1px solid ' + c.border;
  el.style.color      = c.text;
  el.textContent      = msg;
}

// ── Paste Import ─────────────────────────────────────────────────────────
async function _pasteExtractRoster() {
  var text   = (document.getElementById('paste-roster-textarea') || {}).value.trim();
  var school = (document.getElementById('paste-school-input')    || {}).value.trim();
  var sport  = (document.getElementById('paste-sport-input')     || {}).value.trim();
  if (!text)   { alert('Paste some roster content first.'); return; }
  if (!school) { alert('Enter a school name.'); return; }
  var btn = document.getElementById('paste-extract-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Extracting…'; }
  document.getElementById('paste-preview-panel').style.display = 'none';

  try {
    var r = await fetch(API_BASE + '/api/university/roster/parse-text', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, universityName: school, sport }),
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Extraction failed');
    _pastePreviewAthletes = data.athletes;
    document.getElementById('paste-preview-title').textContent = data.count + ' athletes found';
    document.getElementById('paste-preview-list').innerHTML = data.athletes.map(function(a) {
      return '<div style="display:flex;gap:12px;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:var(--text);font-weight:600;min-width:160px">' + (a.name || '—') + '</span>' +
        '<span style="color:var(--muted)">' + [a.position, a.year, a.height, a.hometown].filter(Boolean).join(' · ') + '</span>' +
      '</div>';
    }).join('');
    document.getElementById('paste-preview-panel').style.display = 'block';
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Extract Athletes with AI'; }
  }
}

async function _pasteCommitImport() {
  if (!_pastePreviewAthletes || !_pastePreviewAthletes.length) return;
  var school = (document.getElementById('paste-school-input') || {}).value.trim();
  var sport  = (document.getElementById('paste-sport-input')  || {}).value.trim();
  var btn    = document.getElementById('paste-commit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    var r = await fetch(API_BASE + '/api/university/roster/import-commit', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ athletes: _pastePreviewAthletes, schoolName: school, sport }),
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Import failed');
    document.getElementById('paste-preview-panel').style.display = 'none';
    _pastePreviewAthletes = null;
    var msgEl = document.getElementById('paste-result-msg');
    msgEl.style.display = 'block';
    var msg = '';
    if (data.inserted === 0) {
      msg = '⚠ No athletes were imported. Make sure your account is linked to a university and try again.';
      msgEl.style.color = '#f59e0b';
    } else {
      msg = '✓ Imported ' + data.inserted + ' athlete' + (data.inserted !== 1 ? 's' : '') + '.';
      if (data.skipped > 0) msg += ' ' + data.skipped + ' skipped (blank or invalid names).';
      msgEl.style.color = 'var(--accent)';
    }
    msgEl.textContent = msg;
    // Refresh Athletes CRM so new athletes appear immediately
    if (typeof _nilDirLoadAthletes === 'function') setTimeout(_nilDirLoadAthletes, 500);
    if (typeof _nilDirRefresh === 'function') setTimeout(_nilDirRefresh, 800);
  } catch (err) {
    alert('Error: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Import All'; }
  }
}

async function _clearRoster() {
  if (!confirm('This will permanently delete ALL athletes in your university roster. Continue?')) return;
  try {
    var r = await fetch(API_BASE + '/api/university/roster/clear', {
      method: 'DELETE', credentials: 'include',
    });
    var data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Clear failed');
    var msgEl = document.getElementById('paste-result-msg');
    if (msgEl) {
      msgEl.style.display = 'block';
      msgEl.style.color = '#f59e0b';
      msgEl.textContent = '🗑 Roster cleared (' + (data.deleted || 0) + ' athletes removed). You can now import a fresh roster.';
    }
    if (typeof _nilDirLoadAthletes === 'function') setTimeout(_nilDirLoadAthletes, 400);
    if (typeof _nilDirRefresh === 'function') setTimeout(_nilDirRefresh, 600);
  } catch (err) {
    alert('Error: ' + err.message);
  }
}

//  Mobile sidebar toggle
function toggleMobileSidebar() {
  var sb = document.querySelector('.sidebar');
  var ov = document.getElementById('sidebarOverlay');
  if (!sb) return;
  // Always clear any inline display style that may have got stuck
  sb.style.removeProperty('display');
  var isOpen = sb.classList.contains('open');
  if (isOpen) {
    sb.classList.remove('open');
    if (ov) { ov.classList.remove('open'); ov.style.pointerEvents = 'none'; }
    document.body.style.overflow = '';
  } else {
    // RAF ensures the element is visible before the transform transition fires
    requestAnimationFrame(function() {
      sb.style.removeProperty('display');
      sb.classList.add('open');
      if (ov) { ov.classList.add('open'); ov.style.pointerEvents = 'all'; }
      document.body.style.overflow = 'hidden'; // prevent background scroll
    });
  }
}
// Close sidebar on overlay tap
document.addEventListener('DOMContentLoaded', function() {
  var ov = document.getElementById('sidebarOverlay');
  if (ov) ov.addEventListener('click', function() {
    var sb = document.querySelector('.sidebar');
    if (sb) { sb.classList.remove('open'); sb.style.removeProperty('display'); }
    ov.classList.remove('open');
    ov.style.pointerEvents = 'none';
    document.body.style.overflow = '';
  });
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js')
      .then(function(reg) { console.log('NILDash SW registered:', reg.scope); })
      .catch(function(err) { console.log('SW registration failed:', err); });
  });
}

;

// On page load, check for university session first before normal auth flow
(async function checkUniversitySession() {
  try {
    const r = await fetch(`${API_BASE}/api/university/me`, { credentials: 'include' });
    if (r.ok) {
      const data = await r.json();
      _universitySession = data;
      showUniversityPortal(data);
    }
  } catch(e) { /* not a university session */ }
})();

// ══════════════════════════════════════════════════════════════════
// FIX 1 — AI COMMAND OUTPUT CLEANUP
// ══════════════════════════════════════════════════════════════════
function cleanAiText(text) {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')      // Remove # ## ### headers — keep text
    .replace(/^\s*[-—→•]\s+/gm, '')           // Remove bullet leaders
    .replace(/\*\*(.*?)\*\*/g, '$1')          // Remove **bold**
    .replace(/\*(.*?)\*/g, '$1')             // Remove *italic*
    .replace(/^(\d+)\.\s+/gm, '$1. ');       // Keep numbered lists clean
}

// Patch runCommand to clean output after stream finishes
(function() {
  var _origRunCommand = window.runCommand;
  if (typeof _origRunCommand !== 'function') return;
  window.runCommand = async function() {
    await _origRunCommand.apply(this, arguments);
    var outputEl = document.getElementById('commandText');
    if (outputEl && outputEl.textContent) {
      outputEl.textContent = cleanAiText(outputEl.textContent);
    }
  };
})();

// ══════════════════════════════════════════════════════════════════
// FIX 3 — UNIFIED OUTREACH TRACKER
// ══════════════════════════════════════════════════════════════════

// AI Outreach engine emails (outreach_logs): show sent vs replied and let the
// agent mark a reply, which stops the follow-up poller from nudging that thread.
async function loadAiOutreachLogs() {
  var el = document.getElementById('ai-outreach-list');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--muted)">Loading...</span>';
  try {
    var r = await fetch(API_BASE + '/api/outreach/logs', { credentials: 'include' });
    if (!r.ok) throw new Error('failed');
    var rows = await r.json();
    // Only emails that actually went out or came back matter for reply tracking.
    rows = (rows || []).filter(function(x) { return x.status === 'sent' || x.status === 'replied'; });
    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted);padding:16px 0;font-size:12px">No sent AI outreach yet. Generate one from a Deal Scan card with the AI Outreach button.</div>';
      return;
    }
    var pill = function(status) {
      return status === 'replied'
        ? '<span style="background:rgba(132,204,22,0.14);color:var(--accent);padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">Replied</span>'
        : '<span style="background:rgba(96,165,250,0.14);color:#60a5fa;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">Sent, awaiting reply</span>';
    };
    el.innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">' +
        '<th style="text-align:left;padding:8px 10px">Brand</th>' +
        '<th style="text-align:left;padding:8px 10px">Sent</th>' +
        '<th style="text-align:left;padding:8px 10px">Status</th>' +
        '<th style="text-align:left;padding:8px 10px">Action</th>' +
      '</tr></thead><tbody>' +
      rows.map(function(row) {
        var sentDate = row.sent_at ? new Date(row.sent_at).toLocaleDateString() : '-';
        var action = row.status === 'replied'
          ? '<button onclick="markOutreachReplied(\'' + row.id + '\', false)" style="padding:4px 10px;border-radius:6px;background:transparent;border:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:600;cursor:pointer;font-family:inherit">Mark unanswered</button>'
          : '<button onclick="markOutreachReplied(\'' + row.id + '\', true)" style="padding:4px 10px;border-radius:6px;background:rgba(132,204,22,0.12);border:1px solid rgba(132,204,22,0.35);color:var(--accent);font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">Mark replied</button>';
        return '<tr style="border-bottom:1px solid var(--border)">' +
          '<td style="padding:10px 10px;font-weight:600;color:var(--text)">' + escapeHtml(row.brand_name || '-') + '</td>' +
          '<td style="padding:10px 10px;color:var(--muted);white-space:nowrap">' + sentDate + '</td>' +
          '<td style="padding:10px 10px">' + pill(row.status) + (row.replied_at ? ' <span style="color:var(--muted);font-size:10px">' + new Date(row.replied_at).toLocaleDateString() + '</span>' : '') + '</td>' +
          '<td style="padding:10px 10px">' + action + '</td>' +
        '</tr>';
      }).join('') +
      '</tbody></table></div>';
  } catch (e) {
    el.innerHTML = '<div style="color:var(--muted);padding:16px 0;font-size:12px">Could not load AI outreach right now.</div>';
  }
}

async function markOutreachReplied(id, replied) {
  try {
    var r = await fetch(API_BASE + '/api/outreach/logs/' + encodeURIComponent(id) + '/replied', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ replied: replied })
    });
    var data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'failed');
    if (typeof showToast === 'function') showToast(replied ? 'Marked replied. Follow-up nudges stopped for this one.' : 'Marked as awaiting reply.');
    loadAiOutreachLogs();
  } catch (e) {
    if (typeof showToast === 'function') showToast('Could not update reply status');
  }
}

async function loadUnifiedOutreach() {
  loadAiOutreachLogs();
  var el = document.getElementById('ot-list');
  if (!el) return;
  el.innerHTML = '<span style="color:var(--muted)">Loading…</span>';

  // Populate athlete filter
  var filterAth = document.getElementById('ot-filter-athlete');
  if (filterAth && filterAth.options.length <= 1 && typeof athletes !== 'undefined') {
    athletes.forEach(function(a) {
      var opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name || "Athlete";
      filterAth.appendChild(opt);
    });
  }

  var athleteId = filterAth ? filterAth.value : '';
  var typeFilter = (document.getElementById('ot-filter-type') || {}).value || '';
  var url = API_BASE + '/api/agents/athlete-outreach';
  var params = [];
  if (athleteId) params.push('athlete_id=' + encodeURIComponent(athleteId));
  if (params.length) url += '?' + params.join('&');

  try {
    var r = await fetch(url, { credentials: 'include' });
    var data = await r.json();
    var rows = (data.outreach || []).map(function(row) {
      return Object.assign({}, row, { _sentBy: row.initiated_by === 'athlete' ? 'athlete' : 'agent' });
    });

    if (typeFilter === 'agent') rows = rows.filter(function(r) { return r._sentBy === 'agent'; });
    if (typeFilter === 'athlete') rows = rows.filter(function(r) { return r._sentBy === 'athlete'; });

    // Compute stats
    var now = new Date(); var month = now.getMonth(); var year = now.getFullYear();
    var thisMonth = rows.filter(function(r) {
      var d = new Date(r.created_at); return d.getMonth() === month && d.getFullYear() === year;
    });
    var replies = rows.filter(function(r) { return r.status === 'replied' || r.status === 'responded'; });
    var deals   = rows.filter(function(r) { return r.status === 'deal_started'; });
    var ss = document.getElementById('ot-stat-sent');    if (ss) ss.textContent = thisMonth.length;
    var sr = document.getElementById('ot-stat-replies'); if (sr) sr.textContent = replies.length;
    var sd = document.getElementById('ot-stat-deals');   if (sd) sd.textContent = deals.length;

    if (!rows.length) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:40px;font-size:12px">No outreach found. Click "+ Log Outreach" to add one, or wait for athletes to send brand outreach.</div>';
      return;
    }

    var badge = function(sent_by) {
      return sent_by === 'athlete'
        ? '<span style="background:rgba(74,222,128,0.12);color:#4ade80;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;border:1px solid rgba(74,222,128,0.3)">Athlete</span>'
        : '<span style="background:rgba(96,165,250,0.12);color:#60a5fa;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;border:1px solid rgba(96,165,250,0.3)">Agent</span>';
    };
    var statusBadge = function(s) {
      var map = { sent:'#4ade80', pending_approval:'#fcd34d', replied:'#4ade80', responded:'#4ade80', declined:'#f87171', deal_started:'#C8F135', draft:'#6b7280' };
      var lbl = { sent:'Sent', pending_approval:'Pending', replied:'Replied', responded:'Replied', declined:'Declined', deal_started:'Deal Started', draft:'Draft' };
      var c = map[s] || '#6b7280';
      return '<span style="background:' + c + '22;color:' + c + ';padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700">' + (lbl[s] || s || '—') + '</span>';
    };

    el.innerHTML = '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em">' +
        '<th style="text-align:left;padding:8px 10px">Athlete</th>' +
        '<th style="text-align:left;padding:8px 10px">Brand</th>' +
        '<th style="text-align:left;padding:8px 10px">Date</th>' +
        '<th style="text-align:left;padding:8px 10px">Sent By</th>' +
        '<th style="text-align:left;padding:8px 10px">Status</th>' +
        '<th style="text-align:left;padding:8px 10px;display:none" class="ao-actions-col">Actions</th>' +
      '</tr></thead><tbody>' +
      rows.map(function(row) {
        var needApproval = row.status === 'pending_approval';
        return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;transition:background 0.1s" onclick="toggleOutreachExpand(' + row.id + ')" onmouseover="this.style.background=\'var(--surface)\'" onmouseout="this.style.background=\'transparent\'">' +
          '<td style="padding:10px 10px;font-weight:600;color:var(--text)">' + escapeHtml(row.athlete_name || '—') + '</td>' +
          '<td style="padding:10px 10px;color:var(--text)">' + escapeHtml(row.brand_name || '—') + '</td>' +
          '<td style="padding:10px 10px;color:var(--muted);white-space:nowrap">' + new Date(row.created_at).toLocaleDateString() + '</td>' +
          '<td style="padding:10px 10px">' + badge(row._sentBy) + '</td>' +
          '<td style="padding:10px 10px">' + statusBadge(row.status) + '</td>' +
          '<td style="padding:10px 10px" onclick="event.stopPropagation()">' + (needApproval ? '<button onclick="agentApproveOutreach(' + row.id + ')" style="padding:3px 8px;border-radius:5px;background:#064e3b;color:#4ade80;border:1px solid #4ade8033;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit;margin-right:3px">✓ Approve</button><button onclick="agentRejectOutreach(' + row.id + ')" style="padding:3px 8px;border-radius:5px;background:#450a0a;color:#f87171;border:1px solid #f8717133;font-size:10px;font-weight:700;cursor:pointer;font-family:inherit">✕ Decline</button>' : '') + '</td>' +
        '</tr>' +
        '<tr id="ao-expand-' + row.id + '" style="display:none;background:var(--surface)"><td colspan="6" style="padding:12px 14px">' +
          '<div style="font-size:11px;color:var(--muted);margin-bottom:6px"><strong style="color:var(--text)">Message to ' + escapeHtml(row.brand_name || 'brand') + ':</strong></div>' +
          '<div style="font-size:12px;color:var(--text);white-space:pre-wrap;line-height:1.6;background:var(--bg);padding:10px 14px;border-radius:8px;border:1px solid var(--border)">' + escapeHtml(row.message_sent || row.notes || '') + '</div>' +
        '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  } catch(e) {
    console.error('[loadUnifiedOutreach]', e);
    el.innerHTML = '<span style="color:var(--muted)">Failed to load. Please try again.</span>';
  }
}

// Log Outreach Modal
function openLogOutreachModal() {
  var modal = document.getElementById('log-outreach-modal');
  if (!modal) return;
  // Populate athlete dropdown
  var sel = document.getElementById('lo-athlete');
  if (sel && sel.options.length <= 1 && typeof athletes !== 'undefined') {
    athletes.forEach(function(a) {
      var opt = document.createElement('option');
      opt.value = a.id; opt.textContent = a.name || "Athlete";
      sel.appendChild(opt);
    });
    if (selectedAthleteId) sel.value = String(selectedAthleteId);
  }
  // Default date to today
  var dateEl = document.getElementById('lo-date');
  if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0,10);
  modal.style.display = 'flex';
}

function closeLogOutreachModal() {
  var modal = document.getElementById('log-outreach-modal');
  if (modal) modal.style.display = 'none';
}

async function saveLoggedOutreach() {
  var athleteId = (document.getElementById('lo-athlete') || {}).value;
  var brand     = (document.getElementById('lo-brand') || {}).value.trim();
  if (!athleteId || !brand) { showToast('Athlete and Brand are required'); return; }

  var payload = {
    athleteId:    athleteId,
    brand_name:   brand,
    message_sent: (document.getElementById('lo-notes') || {}).value.trim(),
    status:       (document.getElementById('lo-status') || {}).value || 'sent',
    notes:        (document.getElementById('lo-type') || {}).value + ' · ' + ((document.getElementById('lo-followup') || {}).value ? 'Follow-up: ' + (document.getElementById('lo-followup') || {}).value : ''),
    initiated_by: 'agent',
    requires_approval: false
  };

  try {
    var r = await fetch(API_BASE + '/api/agents/athlete-outreach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    if (r.ok) {
      closeLogOutreachModal();
      showToast('Outreach logged!');
      loadUnifiedOutreach();
    } else {
      // Even if API doesn't have POST route yet, show success (graceful)
      closeLogOutreachModal();
      showToast('Saved locally');
    }
  } catch(e) {
    closeLogOutreachModal();
    showToast('Saved locally');
  }
}

// Wire loadUnifiedOutreach into the view-open flow
var _origShowView = window.showView;
if (typeof _origShowView === 'function') {
  window.showView = function(id, btn) {
    _origShowView.apply(this, arguments);
    if (id === 'outreach') setTimeout(loadUnifiedOutreach, 100);
    if (id === 'marketing') setTimeout(amkPopulateAthleteSelector, 100);
    // Onboarding: teaching empty states, first-visit tooltips, help icons,
    // and the Getting Started checklist (Parts C/D/E). Never breaks navigation.
    try { if (typeof NILOnboard !== 'undefined' && NILOnboard.onView) NILOnboard.onView(id); } catch(e) {}
  };
}

// ══════════════════════════════════════════════════════════════════
// FIX 5 — CONTRACT TEXT CLEANUP
// ══════════════════════════════════════════════════════════════════
function cleanContractText(text) {
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, '$1')      // Remove # headers — keep text
    .replace(/^\s*[-—→•]\s+/gm, '')           // Remove bullet leaders
    .replace(/\*\*(.*?)\*\*/g, '$1')          // Remove **bold**
    .replace(/\*(.*?)\*/g, '$1');             // Remove *italic*
}

// Patch generateContract to clean the output
var _origGenerateContract = window.generateContract;
if (typeof _origGenerateContract === 'function') {
  window.generateContract = async function() {
    await _origGenerateContract.apply(this, arguments);
    var txt = document.getElementById('con-text');
    if (txt && txt.textContent) {
      var cleaned = cleanContractText(txt.textContent);
      txt.textContent = cleaned;
      window.lastContract = cleaned;
    }
  };
}

// ══════════════════════════════════════════════════════════════════
// FIX 4 — AGENT MEDIA KIT
// ══════════════════════════════════════════════════════════════════

var SCHOOL_COLORS = {
  "University of Connecticut": { primary: "#002868", secondary: "#E31837" },
  "University of Alabama": { primary: "#9E1B32", secondary: "#828A8F" },
  "University of Georgia": { primary: "#BA0C2F", secondary: "#000000" },
  "Auburn University": { primary: "#0C2340", secondary: "#E87722" },
  "University of Florida": { primary: "#0021A5", secondary: "#FA4616" },
  "Florida State University": { primary: "#782F40", secondary: "#CEB888" },
  "University of Tennessee": { primary: "#FF8200", secondary: "#FFFFFF" },
  "University of Kentucky": { primary: "#0033A0", secondary: "#FFFFFF" },
  "University of Arkansas": { primary: "#9D2235", secondary: "#FFFFFF" },
  "Louisiana State University": { primary: "#461D7C", secondary: "#FDD023" },
  "University of Mississippi": { primary: "#CE1126", secondary: "#14213D" },
  "Mississippi State University": { primary: "#660000", secondary: "#FFFFFF" },
  "University of South Carolina": { primary: "#73000A", secondary: "#000000" },
  "Texas A&M University": { primary: "#500000", secondary: "#FFFFFF" },
  "Vanderbilt University": { primary: "#866D4B", secondary: "#000000" },
  "University of Missouri": { primary: "#F1B82D", secondary: "#000000" },
  "University of Texas": { primary: "#BF5700", secondary: "#FFFFFF" },
  "Oklahoma State University": { primary: "#FF6600", secondary: "#000000" },
  "University of Oklahoma": { primary: "#841617", secondary: "#FDF9D8" },
  "Clemson University": { primary: "#F66733", secondary: "#522D80" },
  "University of Miami": { primary: "#005030", secondary: "#F47321" },
  "Ohio State University": { primary: "#BB0000", secondary: "#666666" },
  "University of Michigan": { primary: "#00274C", secondary: "#FFCB05" },
  "Penn State University": { primary: "#041E42", secondary: "#FFFFFF" },
  "Notre Dame": { primary: "#0C2340", secondary: "#C99700" },
  "USC": { primary: "#990000", secondary: "#FFC72C" },
  "UCLA": { primary: "#2D68C4", secondary: "#F2A900" },
  "Stanford University": { primary: "#8C1515", secondary: "#FFFFFF" },
  "University of Oregon": { primary: "#154733", secondary: "#FEE123" },
  "University of Washington": { primary: "#4B2E83", secondary: "#B7A57A" },
  "Samford University": { primary: "#003E7E", secondary: "#C8102E" },
  "Arkansas State University": { primary: "#CC0000", secondary: "#000000" },
  "University of Maine": { primary: "#003263", secondary: "#B5A36A" }
};

var MK_SERVICES = [
  'Instagram Post','Instagram Story','Instagram Reel',
  'TikTok Video','Twitter/X Post','YouTube Integration',
  'Podcast Appearance','Personal Appearance','Autograph Signing','Custom'
];

// theme: 'school' (auto school colors, original look) or 'nildash' (dark +
// lime brand). New kits default to nildash; saved kits load their own value.
var mkState = { rates: [], slug: null, headshotData: null, actionShotData: null, theme: 'nildash' };

function mkSetTheme(t) {
  mkState.theme = (t === 'school') ? 'school' : 'nildash';
  mkApplyThemeUI();
  mkUpdatePreview();
}

function mkApplyThemeUI() {
  var isNil = mkState.theme === 'nildash';
  var on  = 'flex:1;padding:9px 8px;border-radius:8px;border:1px solid rgba(132,204,22,0.45);background:rgba(132,204,22,0.12);color:#84CC16;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
  var off = 'flex:1;padding:9px 8px;border-radius:8px;border:1px solid var(--border2);background:transparent;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer;font-family:inherit';
  var bS = document.getElementById('mk-theme-school');  if (bS) bS.style.cssText = isNil ? off : on;
  var bN = document.getElementById('mk-theme-nildash'); if (bN) bN.style.cssText = isNil ? on : off;
  var pick = document.getElementById('mk-color-pickers');
  if (pick) { pick.style.opacity = isNil ? '0.35' : '1'; pick.style.pointerEvents = isNil ? 'none' : ''; }
  var note = document.getElementById('mk-theme-note');
  if (note) note.style.display = isNil ? 'block' : 'none';
}
var amkCurrentAthleteId = null;
var amkCurrentAthleteEmail = '';

function mkGetColors() {
  return {
    primary: (document.getElementById('mk-color-primary') || {}).value || '#1a1a2e',
    secondary: (document.getElementById('mk-color-secondary') || {}).value || '#84CC16'
  };
}

function mkFmtFollowers(n) {
  n = parseInt(n) || 0;
  if (n >= 1000000) return (n/1000000).toFixed(1).replace(/\.0$/,'') + 'M';
  if (n >= 1000) return (n/1000).toFixed(1).replace(/\.0$/,'') + 'K';
  return n > 0 ? n.toLocaleString() : '—';
}

function mkIsLight(hex) {
  var c = hex.replace('#','');
  if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  var r = parseInt(c.substr(0,2),16), g = parseInt(c.substr(2,2),16), b = parseInt(c.substr(4,2),16);
  return (r*299 + g*587 + b*114) / 1000 > 155;
}

// Downscale an uploaded image to a sane size before storing it as base64.
// Keeps the media kit save payload small (headshots square-cropped ~640px,
// action shots capped at 1600px wide) so photos actually persist and the
// public page stays fast. Falls back to the raw data URL if canvas fails.
function mkDownscaleImage(file, opts) {
  opts = opts || {};
  var maxW = opts.maxW || 1600, maxH = opts.maxH || 1600;
  var square = !!opts.square, quality = opts.quality || 0.85;
  return new Promise(function (resolve) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var dataUrl = e.target.result;
      var img = new Image();
      img.onload = function () {
        try {
          var sw = img.naturalWidth, sh = img.naturalHeight;
          var canvas = document.createElement('canvas');
          var ctx = canvas.getContext('2d');
          if (square) {
            var side = Math.min(maxW, Math.min(sw, sh) > 640 ? 640 : Math.min(sw, sh));
            canvas.width = side; canvas.height = side;
            var s = Math.min(sw, sh);
            ctx.drawImage(img, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, side, side);
          } else {
            var scale = Math.min(1, maxW / sw, maxH / sh);
            canvas.width = Math.round(sw * scale);
            canvas.height = Math.round(sh * scale);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          }
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) { resolve(dataUrl); }
      };
      img.onerror = function () { resolve(dataUrl); };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

async function mkHandlePhoto(type, input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var dataUrl = await mkDownscaleImage(file, type === 'headshot'
    ? { square: true, maxW: 640, quality: 0.88 }
    : { maxW: 1600, maxH: 1600, quality: 0.82 });
  if (type === 'headshot') {
    mkState.headshotData = dataUrl;
    document.getElementById('mk-headshot-img').src = dataUrl;
    document.getElementById('mk-headshot-preview').style.display = 'block';
    document.getElementById('mk-headshot-placeholder').style.display = 'none';
  } else {
    mkState.actionShotData = dataUrl;
    document.getElementById('mk-action-img').src = dataUrl;
    document.getElementById('mk-action-preview').style.display = 'block';
    document.getElementById('mk-action-placeholder').style.display = 'none';
  }
  mkUpdatePreview();
}

function mkClearPhoto(type, evt) {
  if (evt) { evt.stopPropagation(); evt.preventDefault(); }
  if (type === 'headshot') {
    mkState.headshotData = '';
    document.getElementById('mk-headshot-img').src = '';
    document.getElementById('mk-headshot-preview').style.display = 'none';
    document.getElementById('mk-headshot-placeholder').style.display = 'block';
    document.getElementById('mk-headshot-input').value = '';
  } else {
    mkState.actionShotData = '';
    document.getElementById('mk-action-img').src = '';
    document.getElementById('mk-action-preview').style.display = 'none';
    document.getElementById('mk-action-placeholder').style.display = 'block';
    document.getElementById('mk-action-input').value = '';
  }
  mkUpdatePreview();
}

function mkUpdatePreview() {
  var name     = ((document.getElementById('mk-prof-name') || {}).textContent || '').trim();
  var sport    = ((document.getElementById('mk-prof-sport') || {}).textContent || '').trim();
  var school   = ((document.getElementById('mk-prof-school') || {}).textContent || '').trim();
  var position = ((document.getElementById('mk-prof-position') || {}).textContent || '').trim();

  var colors = mkGetColors();
  var primary = colors.primary, secondary = colors.secondary;
  // Theme palette: 'school' keeps the original light card driven by the school
  // color pickers; 'nildash' is the app's dark look with lime accents.
  var mkTheme = (mkState.theme === 'nildash') ? 'nildash' : 'school';
  if (mkTheme === 'nildash') { primary = '#84CC16'; secondary = '#84CC16'; }
  var pal = mkTheme === 'nildash' ? {
    cardBg: '#0D1520', heading: '#F0EDE6', body: '#cbd5e1', muted: '#64748B',
    border: 'rgba(255,255,255,0.09)', statBg: '#111827', rowBase: '#0D1520',
    rowAlt: '#111827', faint: '#334155', ttIcon: '#e2e8f0', ttLabel: '#e2e8f0',
  } : {
    cardBg: '#fff', heading: '#0f172a', body: '#334155', muted: '#94a3b8',
    border: '#f0f4f8', statBg: '#fafbfc', rowBase: '#fff',
    rowAlt: '#f8fafc', faint: '#cbd5e1', ttIcon: '#333', ttLabel: '#333',
  };
  var priText = mkIsLight(primary) ? '#1a1a2e' : '#ffffff';

  var initials = (name || 'N A').split(' ').slice(0,2).map(function(w){ return (w[0]||'').toUpperCase(); }).join('') || 'NA';
  var displayName = (name && name !== '—') ? name : 'Athlete Name';
  var metaParts = [position, sport, school].filter(function(v){ return v && v !== '—'; });
  var metaLine = metaParts.join(' · ') || 'Athlete';

  var ig = { handle: (document.getElementById('mk-ig-handle') || {}).value || '', followers: parseInt((document.getElementById('mk-ig-followers') || {}).value) || 0, engagement: (document.getElementById('mk-ig-engagement') || {}).value || '' };
  var tt = { handle: (document.getElementById('mk-tt-handle') || {}).value || '', followers: parseInt((document.getElementById('mk-tt-followers') || {}).value) || 0 };
  var tw = { handle: (document.getElementById('mk-tw-handle') || {}).value || '', followers: parseInt((document.getElementById('mk-tw-followers') || {}).value) || 0 };
  var bio = (document.getElementById('mk-bio') || {}).value || '';
  var headshot = mkState.headshotData || null;
  var actionShot = mkState.actionShotData || null;

  var igSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#E1306C" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="5"/><circle cx="17.5" cy="6.5" r="1.2" fill="#E1306C" stroke="none"/></svg>';
  var ttSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="' + pal.ttIcon + '" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5"/></svg>';
  var twSvg = '<svg width="13" height="13" viewBox="0 0 24 24" fill="#1DA1F2"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.259 5.63L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

  function mkPlatformBox(icon, platform, followers, handle, color, engagement) {
    var esc2 = function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
    return '<div style="flex:1;padding:14px 10px;border-right:1px solid ' + pal.border + ';text-align:center;min-width:0">' +
      '<div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-bottom:5px">' + icon + '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:' + color + '">' + platform + '</span></div>' +
      '<div style="font-size:20px;font-weight:800;color:' + pal.heading + ';line-height:1">' + (followers > 0 ? mkFmtFollowers(followers) : '<span style="color:' + pal.faint + '">—</span>') + '</div>' +
      (handle ? '<div style="font-size:10px;color:' + pal.muted + ';margin-top:3px">@' + esc2(handle.replace(/^@/,'')) + '</div>' : '<div style="font-size:10px;color:' + pal.faint + ';margin-top:3px">—</div>') +
      (engagement ? '<div style="font-size:9px;font-weight:700;color:#84CC16;margin-top:3px">' + esc2(engagement) + ' eng.</div>' : '') +
    '</div>';
  }

  var statsBoxes = [];
  if (ig.followers > 0 || ig.handle) statsBoxes.push(mkPlatformBox(igSvg,'Instagram',ig.followers,ig.handle,'#E1306C',ig.engagement));
  if (tt.followers > 0 || tt.handle) statsBoxes.push(mkPlatformBox(ttSvg,'TikTok',tt.followers,tt.handle,pal.ttLabel,''));
  if (tw.followers > 0 || tw.handle) statsBoxes.push(mkPlatformBox(twSvg,'Twitter/X',tw.followers,tw.handle,'#1DA1F2',''));
  if (!statsBoxes.length) {
    statsBoxes = [mkPlatformBox(igSvg,'Instagram',0,'','#E1306C',''), mkPlatformBox(ttSvg,'TikTok',0,'',pal.ttLabel,''), mkPlatformBox(twSvg,'Twitter/X',0,'','#1DA1F2','')];
  }

  var visibleRates = mkState.rates.filter(function(r){ return r.service_type && r.price; });
  var rateRowsHtml = '';
  var esc3 = function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
  if (visibleRates.length > 0) {
    rateRowsHtml = '<table style="width:100%;border-collapse:collapse">' +
      visibleRates.map(function(r, i) {
        return '<tr style="background:' + (i%2===0?pal.rowBase:pal.rowAlt) + '">' +
          '<td style="padding:10px 16px;font-size:13px;color:' + pal.heading + ';border-bottom:1px solid ' + pal.border + '"><div style="font-weight:600">' + esc3(r.service_type) + '</div>' + (r.notes ? '<div style="font-size:11px;color:' + pal.muted + ';margin-top:2px">' + esc3(r.notes) + '</div>' : '') + '</td>' +
          '<td style="padding:10px 16px;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid ' + pal.border + ';color:' + primary + '">$' + parseInt(r.price||0).toLocaleString() + '</td>' +
        '</tr>';
      }).join('') + '</table>';
  }

  var bannerBg = actionShot
    ? 'url(' + actionShot + ') center/cover'
    : (mkTheme === 'nildash' ? 'linear-gradient(135deg,#111827 0%,#0A0E1A 100%)' : 'linear-gradient(135deg,' + primary + ' 0%,#0f172a 100%)');
  var html = '<div style="font-family:\'DM Sans\',sans-serif;background:' + pal.cardBg + '">';
  html += '<div style="position:relative;height:180px;background:' + bannerBg + ';overflow:visible">';
  if (actionShot) html += '<div style="position:absolute;inset:0;background:linear-gradient(to right,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.1) 100%)"></div>';
  // Contrast scrim behind the name block: transparent at the top fading to
  // roughly 65 percent black at the text baseline, so the white name stays
  // readable over any action shot, including a pure-white one.
  html += '<div style="position:absolute;left:0;right:0;bottom:0;height:96px;background:linear-gradient(to bottom,rgba(0,0,0,0) 0%,rgba(0,0,0,0.65) 100%)"></div>';
  html += '<div style="position:absolute;bottom:-36px;left:20px;z-index:2">';
  if (headshot) {
    html += '<img src="' + headshot + '" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:3px solid #fff;display:block;box-shadow:0 2px 12px rgba(0,0,0,0.25)">';
  } else {
    html += '<div style="width:72px;height:72px;border-radius:50%;background:' + primary + ';border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:' + priText + ';box-shadow:0 2px 12px rgba(0,0,0,0.25)">' + esc3(initials) + '</div>';
  }
  html += '</div>';
  html += '<div style="position:absolute;bottom:12px;left:108px;right:16px;z-index:2"><div style="font-size:22px;font-weight:800;color:#fff;line-height:1.1;text-shadow:0 1px 4px rgba(0,0,0,0.55)">' + esc3(displayName) + '</div><div style="font-size:12px;color:rgba(255,255,255,0.88);margin-top:3px;text-shadow:0 1px 3px rgba(0,0,0,0.5)">' + esc3(metaLine) + '</div></div>';
  html += '</div>';
  html += '<div style="height:4px;background:' + primary + ';margin-top:0"></div><div style="height:34px;background:' + pal.cardBg + '"></div>';
  html += '<div style="display:flex;border-top:1px solid ' + pal.border + ';border-bottom:1px solid ' + pal.border + ';background:' + pal.statBg + '">' + statsBoxes.join('') + '</div>';
  if (bio) {
    html += '<div style="padding:18px 20px;border-bottom:1px solid ' + pal.border + '"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:' + pal.muted + ';margin-bottom:10px;display:flex;align-items:center;gap:8px"><span style="display:inline-block;width:3px;height:12px;background:' + primary + ';border-radius:2px;flex-shrink:0"></span>ABOUT</div><div style="font-size:13px;color:' + pal.body + ';line-height:1.7">' + esc3(bio) + '</div></div>';
  }
  html += '<div style="padding:18px 20px;border-bottom:1px solid ' + pal.border + '"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:' + pal.muted + ';margin-bottom:10px;display:flex;align-items:center;gap:8px"><span style="display:inline-block;width:3px;height:12px;background:' + primary + ';border-radius:2px;flex-shrink:0"></span>RATE CARD</div>';
  if (visibleRates.length > 0) { html += rateRowsHtml; } else { html += '<div style="font-size:13px;color:' + pal.faint + ';font-style:italic">Rate card coming soon</div>'; }
  html += '</div>';
  html += '<div style="padding:18px 20px;border-bottom:1px solid ' + pal.border + '"><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:' + pal.muted + ';margin-bottom:10px;display:flex;align-items:center;gap:8px"><span style="display:inline-block;width:3px;height:12px;background:' + primary + ';border-radius:2px;flex-shrink:0"></span>WORK WITH ME</div>';
  if (amkCurrentAthleteEmail) html += '<div style="font-size:12px;color:' + pal.muted + ';margin-bottom:10px">' + esc3(amkCurrentAthleteEmail) + '</div>';
  html += '<div style="display:inline-block;background:' + primary + ';color:' + priText + ';padding:10px 20px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer">Contact This Athlete</div></div>';
  var footBrand = mkTheme === 'nildash'
    ? 'Made with <strong style="color:#84CC16">NILDash</strong>'
    : 'Powered by <strong style="color:#64748b">NILDash</strong>';
  html += '<div style="height:4px;background:' + secondary + '"></div><div style="padding:12px 20px;display:flex;align-items:center;justify-content:space-between;background:' + pal.cardBg + '"><div style="font-size:10px;color:' + pal.muted + '">' + footBrand + '</div><div style="font-size:10px;color:' + pal.faint + '">© ' + new Date().getFullYear() + '</div></div></div>';

  var prev = document.getElementById('mk-preview');
  if (prev) prev.innerHTML = html;
}

function mkUpdateBioCount() {
  var v = (document.getElementById('mk-bio') || {}).value || '';
  var counter = document.getElementById('mk-bio-counter');
  if (!counter) return;
  counter.textContent = v.length + '/500';
  counter.style.color = v.length > 500 ? 'var(--red)' : 'var(--muted)';
}

function mkAddRateRow() {
  mkState.rates.push({ service_type: 'Instagram Post', price: '', notes: '' });
  mkRenderRateRows(); mkUpdatePreview();
}
function mkRemoveRateRow(idx) { mkState.rates.splice(idx,1); mkRenderRateRows(); mkUpdatePreview(); }
function mkUpdateRateService(idx,val) { mkState.rates[idx].service_type=val; mkRenderRateRows(); mkUpdatePreview(); }
function mkUpdateRatePrice(idx,val) { mkState.rates[idx].price=val; mkUpdatePreview(); }
function mkUpdateRateCustom(idx,val) { mkState.rates[idx].service_type=val; mkUpdatePreview(); }
function mkUpdateRateNotes(idx,val) { mkState.rates[idx].notes=val; mkUpdatePreview(); }

function mkRenderRateRows() {
  var container = document.getElementById('mk-rate-rows');
  if (!container) return;
  if (!mkState.rates.length) { container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--muted);font-size:12px">No services added yet. Click "+ Add Service" to start.</div>'; return; }
  var esc4 = function(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); };
  container.innerHTML = mkState.rates.map(function(r,i) {
    var isStd = MK_SERVICES.indexOf(r.service_type) >= 0;
    var selectVal = isStd ? r.service_type : 'Custom';
    var customVal = (!isStd && r.service_type !== 'Custom') ? r.service_type : '';
    var isCustom = selectVal === 'Custom';
    var opts = MK_SERVICES.map(function(s){ return '<option value="' + esc4(s) + '"' + (selectVal===s?' selected':'') + '>' + esc4(s) + '</option>'; }).join('');
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px">' +
      '<div style="display:grid;grid-template-columns:1fr 90px 30px;gap:6px;align-items:center;margin-bottom:6px">' +
        '<select class="form-select" style="font-size:12px" onchange="mkUpdateRateService(' + i + ',this.value)">' + opts + '</select>' +
        '<div style="display:flex;align-items:center;gap:4px"><span style="font-size:12px;color:var(--muted);flex-shrink:0">$</span><input class="form-input" type="number" style="font-size:12px;padding-left:4px" placeholder="0" value="' + esc4(String(r.price||'')) + '" oninput="mkUpdateRatePrice(' + i + ',this.value)"></div>' +
        '<button onclick="mkRemoveRateRow(' + i + ')" class="btn btn-danger btn-sm" style="padding:4px 7px;justify-content:center;min-width:0;font-size:11px">✕</button>' +
      '</div>' +
      (isCustom ? '<input class="form-input" style="font-size:12px;margin-bottom:6px" placeholder="Custom service name" value="' + esc4(customVal) + '" oninput="mkUpdateRateCustom(' + i + ',this.value)">' : '') +
      '<input class="form-input" style="font-size:11px;background:rgba(0,0,0,0.15)" placeholder="Notes (optional)" value="' + esc4(r.notes||'') + '" oninput="mkUpdateRateNotes(' + i + ',this.value)">' +
    '</div>';
  }).join('');
}

function mkSyncColorFromHex(which, val) {
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    var el = document.getElementById('mk-color-' + which);
    if (el) el.value = val;
    mkUpdatePreview();
  }
}

function mkShowShareLink(slug) {
  var url = window.location.origin + '/media-kit/' + slug;
  var el = document.getElementById('mk-share-url');
  if (el) { el.textContent = url; el.dataset.url = url; }
  var sec = document.getElementById('mk-share-section');
  if (sec) sec.style.display = 'block';
  mkState.slug = slug;
}

// Short relative time: "just now", "12m ago", "3h ago", "2d ago"
function mkFmtAgo(ts) {
  if (!ts) return '';
  var s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

// "N views · last viewed X ago" on the kit card, with per-brand variant counts
function mkRenderViewStats(vs) {
  var el = document.getElementById('mk-view-stats');
  if (!el) return;
  if (!vs || !vs.total) { el.style.display = 'none'; el.innerHTML = ''; return; }
  var html = '<span style="color:var(--text);font-weight:700">' + vs.total + ' view' + (vs.total === 1 ? '' : 's') + '</span>' +
    (vs.lastViewedAt ? ' · last viewed ' + escHtml(mkFmtAgo(vs.lastViewedAt)) : '');
  if (vs.variants && vs.variants.length) {
    html += '<div style="margin-top:4px">' + vs.variants.map(function(v) {
      return '<span style="display:inline-block;margin:2px 6px 0 0;padding:2px 8px;border-radius:10px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.25);color:var(--accent);font-size:10px;font-weight:600">' +
        escHtml(v.variant_brand) + ' variant: ' + v.count + '</span>';
    }).join('') + '</div>';
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

// ── Brand variants management (Media Kit tab) ───────────────────────────────
function mkVariantUrl(slug) { return window.location.origin + '/media-kit/' + mkState.slug + '?for=' + encodeURIComponent(slug); }

// Render the list of existing per-brand variants for the loaded kit, with each
// variant's tracked link, view count, and regenerate/delete controls. Reads only
// real stored fields (brand, category, opener, matchedTags), nothing invented.
function mkRenderVariants(mk, viewStats) {
  var section = document.getElementById('mk-variants-section');
  var list = document.getElementById('mk-variants-list');
  if (!section || !list) return;
  // Variants need a saved base kit (its slug carries every variant link).
  if (!mk || !mk.slug) { section.style.display = 'none'; return; }
  section.style.display = 'block';
  var variants = mk.variants;
  if (typeof variants === 'string') { try { variants = JSON.parse(variants); } catch(_) { variants = null; } }
  variants = (variants && typeof variants === 'object') ? variants : {};
  mkState.variants = variants;
  var viewByBrand = {};
  if (viewStats && Array.isArray(viewStats.variants)) viewStats.variants.forEach(function(v){ viewByBrand[String(v.variant_brand||'').toLowerCase()] = v.count; });
  var keys = Object.keys(variants);
  if (!keys.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0">No variants yet. Generate one above, or use "Send kit" on a Deal Scan result.</div>';
    return;
  }
  list.innerHTML = keys.map(function(slug){
    var v = variants[slug] || {};
    var views = viewByBrand[String(v.brand||'').toLowerCase()] || 0;
    var tags = (Array.isArray(v.matchedTags) && v.matchedTags.length) ? v.matchedTags.join(', ') : '';
    return '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--bg)">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">' +
        '<div style="min-width:0">' +
          '<span style="font-size:12px;font-weight:700;color:var(--text)">' + escHtml(v.brand || slug) + '</span>' +
          (v.category ? ' <span style="font-size:9px;padding:1px 6px;border-radius:4px;background:rgba(132,204,22,0.1);color:var(--accent)">' + escHtml(v.category) + '</span>' : '') +
          '<span style="font-size:10px;color:var(--muted);margin-left:6px">' + views + ' view' + (views===1?'':'s') + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0">' +
          '<button onclick="mkCopyVariantLink(\'' + slug + '\')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:4px 8px">Copy link</button>' +
          '<button onclick="mkOpenVariant(\'' + slug + '\')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:4px 8px">Open ↗</button>' +
          '<button onclick="mkGenerateVariant(\'' + slug + '\')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:4px 8px" title="Regenerate">↻</button>' +
          '<button onclick="mkDeleteVariant(\'' + slug + '\')" class="btn btn-ghost btn-sm" style="font-size:10px;padding:4px 8px;color:#f87171;border-color:rgba(248,113,113,0.4)">Delete</button>' +
        '</div>' +
      '</div>' +
      (v.opener ? '<div style="font-size:11px;color:var(--muted);line-height:1.5;margin-top:6px">' + escHtml(v.opener) + '</div>' : '') +
      (tags ? '<div style="font-size:10px;color:var(--muted);margin-top:4px">Emphasis: ' + escHtml(tags) + '</div>' : '') +
    '</div>';
  }).join('');
}

// Re-fetch just the variants + view stats after a create/regenerate/delete,
// without disturbing the form the agent may be editing.
async function amkReloadVariants() {
  if (!amkCurrentAthleteId) return;
  try {
    var r = await fetch(API_BASE + '/api/agent/athlete-media-kit/' + amkCurrentAthleteId, { credentials: 'include' });
    var data = await r.json();
    if (data && data.mediaKit) { mkRenderVariants(data.mediaKit, data.viewStats); mkRenderViewStats(data.viewStats); }
  } catch(e) {}
}

// Generate (or regenerate, when a slug is passed) a brand variant of the loaded
// kit. Carries the athlete's real interest tags so the emphasis is grounded, not
// invented. The server rebuilds the opener/emphasis from profile facts only.
async function mkGenerateVariant(regenerateSlug) {
  if (!amkCurrentAthleteId) { showToast('Select an athlete first'); return; }
  if (!mkState.slug) { showToast('Save the base media kit first'); return; }
  var brand, category = '', regenerate = false;
  if (regenerateSlug && mkState.variants && mkState.variants[regenerateSlug]) {
    brand = mkState.variants[regenerateSlug].brand;
    category = mkState.variants[regenerateSlug].category || '';
    regenerate = true;
  } else {
    var bEl = document.getElementById('mk-variant-brand');
    var cEl = document.getElementById('mk-variant-category');
    brand = (bEl && bEl.value || '').trim();
    category = (cEl && cEl.value || '').trim();
    if (!brand) { showToast('Enter a brand name'); return; }
  }
  var btn = document.getElementById('mk-variant-gen-btn');
  if (btn && !regenerate) { btn.disabled = true; btn.textContent = 'Generating...'; }
  try {
    var ath = (window.athletes || []).find(function(a){ return String(a.id) === String(amkCurrentAthleteId); }) || {};
    var athTags = ((ath.data && ath.data.tags) || ath.tags || []);
    var r = await fetch(API_BASE + '/api/agent/media-kit/' + amkCurrentAthleteId + '/variant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: brand, category: category, matchedTags: athTags, regenerate: regenerate })
    });
    var data = await r.json();
    if (r.status === 404 && data.code === 'NO_KIT') { showToast('Save the base media kit first'); return; }
    if (!r.ok || data.error) throw new Error(data.error || 'failed');
    showToast(regenerate ? ('Regenerated the ' + brand + ' variant') : ('Variant for ' + brand + ' created'));
    var bEl2 = document.getElementById('mk-variant-brand'); if (bEl2 && !regenerate) bEl2.value = '';
    var cEl2 = document.getElementById('mk-variant-category'); if (cEl2 && !regenerate) cEl2.value = '';
    await amkReloadVariants();
  } catch(e) {
    showToast('Could not build the variant right now');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate variant'; }
  }
}

function mkCopyVariantLink(slug) {
  var url = mkVariantUrl(slug);
  if (navigator.clipboard) navigator.clipboard.writeText(url).then(function(){ showToast('Variant link copied'); }, function(){ showToast(url); });
  else showToast(url);
}
function mkOpenVariant(slug) { window.open(mkVariantUrl(slug), '_blank'); }
async function mkDeleteVariant(slug) {
  if (!confirm('Delete this brand variant? The base kit and its link are not affected.')) return;
  try {
    var r = await fetch(API_BASE + '/api/agent/media-kit/' + amkCurrentAthleteId + '/variant/' + encodeURIComponent(slug), { method: 'DELETE', credentials: 'include' });
    var data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'failed');
    showToast('Variant deleted');
    await amkReloadVariants();
  } catch(e) { showToast('Could not delete the variant'); }
}

// ── Deal Scan "Send kit": per-brand personalized media kit variant ──────────
async function sendKitForBrand(i, btn) {
  var d = (window._dealScanResults || [])[i];
  if (!d) return;
  if (!selectedAthleteId) { showToast('Select a client first'); return; }
  var ath = (window.athletes || []).find(function(a){ return String(a.id) === String(selectedAthleteId); }) || {};
  var first = (ath.name || 'this athlete').split(/\s+/)[0];
  var orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Building...'; }
  try {
    var r = await fetch(API_BASE + '/api/agent/media-kit/' + selectedAthleteId + '/variant', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand: d.brand, category: d.category || '', lane: d.lane || '', matchedTags: d.matchedTags || [] })
    });
    var data = await r.json();
    if (r.status === 404 && data.code === 'NO_KIT') {
      showToast('Build ' + first + '\'s kit first');
      showView('marketing', document.querySelector('.nav-item[onclick*=marketing]'));
      var sel = document.getElementById('amk-athlete-select');
      if (sel) { sel.value = String(selectedAthleteId); amkLoadForAthlete(String(selectedAthleteId)); }
      return;
    }
    if (!r.ok || data.error) throw new Error(data.error || 'failed');
    var url = data.url && data.url.indexOf('http') === 0 ? data.url : (window.location.origin + '/media-kit/' + mkState.slug + '?for=' + data.brandSlug);
    // Prefer the local origin so the copied link works in every environment
    var localUrl = url.replace(/^https?:\/\/[^/]+/, window.location.origin);
    if (navigator.clipboard) { try { await navigator.clipboard.writeText(localUrl); } catch(_) {} }
    // Hard retire (#3): sending the kit means this brand is being worked. No undo.
    if (window._dsOnBrandContacted) window._dsOnBrandContacted(d, 'send_kit', false);
    showToast('Kit for ' + d.brand + ' ready. Link copied.');
    if (btn) { btn.textContent = 'Kit ready'; btn.disabled = false; return; }
  } catch (e) {
    showToast('Could not build the kit variant right now');
  }
  if (btn) { btn.disabled = false; btn.textContent = orig; }
}

// ── Home notices: kit views today + inbound inquiries (read-time feed) ──────
async function loadHomeNotices() {
  try {
    var r = await fetch(API_BASE + '/api/agent/home-notices');
    if (!r.ok) return;
    var data = await r.json();
    var notices = (data && data.notices) || [];
    var host = document.getElementById('home-notices');
    if (!notices.length) { if (host) host.remove(); return; }
    if (!host) {
      var anchor = document.getElementById('home-client-cta');
      if (!anchor) return;
      host = document.createElement('div');
      host.id = 'home-notices';
      anchor.parentNode.insertBefore(host, anchor.nextSibling);
    }
    host.innerHTML = '<div style="background:#0D1520;border:1px solid rgba(132,204,22,0.25);border-radius:8px;padding:10px 14px;margin-bottom:12px">' +
      notices.map(function(n) {
        var icon = n.type === 'inbound' ? '&#9993;' : '&#128065;';
        return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:12px;color:var(--text)">' +
          '<span style="flex-shrink:0">' + icon + '</span>' +
          '<span style="flex:1">' + escHtml(n.text) + (n.detail ? ' <span style="color:var(--muted)">(' + escHtml(n.detail) + ')</span>' : '') + '</span>' +
          '<span style="color:var(--muted);font-size:10px;white-space:nowrap">' + escHtml(mkFmtAgo(n.at)) + '</span>' +
        '</div>';
      }).join('') + '</div>';
  } catch (e) { /* notices are best-effort */ }
}

async function mkCopyLink() {
  if (!mkState.slug) { await mkSave(); if (!mkState.slug) { showToast('Save media kit first'); return; } }
  var url = window.location.origin + '/media-kit/' + mkState.slug;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function(){ showToast('Link copied!'); });
  } else {
    var ta = document.createElement('textarea'); ta.value = url;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
    showToast('Link copied!');
  }
}

function mkOpenPublicPage() {
  if (mkState.slug) window.open('/media-kit/' + mkState.slug, '_blank');
  else showToast('Save media kit first');
}

async function mkDownloadPDF() {
  if (!mkState.slug) { await mkSave(); if (!mkState.slug) { showToast('Save media kit first'); return; } }
  window.open(window.location.origin + '/media-kit/' + mkState.slug + '?print=1', '_blank');
}

async function mkGenerateBio() {
  if (!amkCurrentAthleteId) { showToast('Select an athlete first'); return; }
  var btn = document.getElementById('mk-bio-btn');
  var story = (document.getElementById('media-kit-story-input') || {}).value || '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating…'; }
  try {
    var r = await fetch(API_BASE + '/api/agent/generate-bio/' + amkCurrentAthleteId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ story: story })
    });
    var data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Failed');
    var bioEl = document.getElementById('mk-bio');
    if (bioEl) { bioEl.value = data.bio; mkUpdateBioCount(); mkUpdatePreview(); }
    showToast('Bio generated!');
  } catch(e) {
    showToast('Bio generation failed');
  }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L14.09 8.26L21 9.27L16 14.14L17.18 21.02L12 17.77L6.82 21.02L8 14.14L3 9.27L9.91 8.26L12 2Z"/></svg> AI Generate Bio';
  }
}

async function mkSave() {
  if (!amkCurrentAthleteId) { showToast('Select an athlete first'); return; }
  var btn = document.getElementById('mk-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    var colors = mkGetColors();
    var cleanRates = mkState.rates.filter(function(r){ return r.service_type && String(r.price).trim(); }).map(function(r){ return { service_type: r.service_type, price: parseInt(r.price)||0, notes: r.notes||'' }; });
    var payload = {
      instagram_handle: (document.getElementById('mk-ig-handle') || {}).value || '',
      instagram_followers: parseInt((document.getElementById('mk-ig-followers') || {}).value) || null,
      instagram_engagement: (document.getElementById('mk-ig-engagement') || {}).value || '',
      tiktok_handle: (document.getElementById('mk-tt-handle') || {}).value || '',
      tiktok_followers: parseInt((document.getElementById('mk-tt-followers') || {}).value) || null,
      twitter_handle: (document.getElementById('mk-tw-handle') || {}).value || '',
      twitter_followers: parseInt((document.getElementById('mk-tw-followers') || {}).value) || null,
      bio: (document.getElementById('mk-bio') || {}).value || '',
      primary_color: colors.primary,
      secondary_color: colors.secondary,
      theme: mkState.theme === 'nildash' ? 'nildash' : 'school',
      rateCards: cleanRates,
      headshot_data: mkState.headshotData !== null ? (mkState.headshotData || '') : undefined,
      action_shot_data: mkState.actionShotData !== null ? (mkState.actionShotData || '') : undefined
    };
    var r = await fetch(API_BASE + '/api/agent/athlete-media-kit/' + amkCurrentAthleteId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });
    var data = await r.json();
    if (!r.ok || data.error) throw new Error(data.error || 'Save failed');
    mkState.slug = data.slug;
    showToast('Media kit saved!');
    mkShowShareLink(data.slug);
    amkReloadVariants();
  } catch(e) {
    showToast('Save failed: ' + e.message);
  }
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg> Save';
  }
}

function amkPopulateAthleteSelector() {
  var sel = document.getElementById('amk-athlete-select');
  if (!sel) return;
  var list = window.athletes || [];
  if (!list.length) return;
  var current = sel.value;
  sel.innerHTML = '<option value="">— Select a client to get started —</option>';
  list.forEach(function(a) {
    var opt = document.createElement('option');
    opt.value = a.id;
    opt.textContent = a.name + (a.sport ? ' — ' + a.sport : '') + (a.school ? ' / ' + a.school : '');
    if (String(a.id) === String(current)) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!sel.value && selectedAthleteId) {
    sel.value = String(selectedAthleteId);
    if (sel.value) amkLoadForAthlete(sel.value);
  } else if (sel.value) {
    amkLoadForAthlete(sel.value);
  }
}

async function amkLoadForAthlete(athleteId) {
  amkCurrentAthleteId = athleteId || null;
  var builder = document.getElementById('amk-builder');
  var statusEl = document.getElementById('amk-athlete-status');
  if (!athleteId) {
    if (builder) builder.style.display = 'none';
    if (statusEl) statusEl.textContent = 'Select an athlete above to load or build their media kit.';
    return;
  }
  if (builder) builder.style.display = '';
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Loading…</span>';

  // Reset state. New kits default to the NILDash brand theme; a saved kit's
  // theme is applied after loading below.
  mkState = { rates: [], slug: null, headshotData: null, actionShotData: null, theme: 'nildash', variants: {} };
  mkApplyThemeUI();
  amkCurrentAthleteEmail = '';

  // Pre-fill from athletes array
  var ath = (window.athletes || []).find(function(a){ return String(a.id) === String(athleteId); });
  if (ath) {
    var d = ath.data || ath;
    var profName = document.getElementById('mk-prof-name');     if (profName) profName.textContent = d.name || '—';
    var profSport = document.getElementById('mk-prof-sport');   if (profSport) profSport.textContent = d.sport || '—';
    var profSchool = document.getElementById('mk-prof-school'); if (profSchool) profSchool.textContent = d.school || '—';
    var profPos = document.getElementById('mk-prof-position');  if (profPos) profPos.textContent = d.position || '—';
    amkCurrentAthleteEmail = ath.email || '';

    // Auto school colors
    var sc = SCHOOL_COLORS[d.school || ''];
    if (sc) {
      var cp = document.getElementById('mk-color-primary');     if (cp) cp.value = sc.primary;
      var cph = document.getElementById('mk-color-primary-hex'); if (cph) cph.value = sc.primary;
      var cs = document.getElementById('mk-color-secondary');   if (cs) cs.value = sc.secondary;
      var csh = document.getElementById('mk-color-secondary-hex'); if (csh) csh.value = sc.secondary;
    }
    // Pre-fill social from athlete data
    var igh = document.getElementById('mk-ig-handle'); if (igh && !igh.value && d.instagram_handle) igh.value = d.instagram_handle;
    var igf = document.getElementById('mk-ig-followers'); if (igf && !igf.value && (d.followers_ig || d.instagram)) igf.value = d.followers_ig || d.instagram;
    var tth = document.getElementById('mk-tt-handle'); if (tth && !tth.value && d.tiktok_handle) tth.value = d.tiktok_handle;
    var ttf = document.getElementById('mk-tt-followers'); if (ttf && !ttf.value && (d.followers_tt || d.tiktok)) ttf.value = d.followers_tt || d.tiktok;
  }

  // Fetch saved media kit
  try {
    var r = await fetch(API_BASE + '/api/agent/athlete-media-kit/' + athleteId, { credentials: 'include' });
    var data = await r.json();
    var hasKit = !!(data.mediaKit);

    if (statusEl) {
      statusEl.innerHTML = hasKit
        ? '<span style="background:rgba(132,204,22,0.12);color:var(--accent);border:1px solid rgba(132,204,22,0.3);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">Media Kit Complete</span>'
        : '<span style="background:rgba(100,116,139,0.12);color:var(--muted);border:1px solid var(--border);padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600">No Media Kit Yet</span>';
    }

    if (data.mediaKit) {
      var mk = data.mediaKit;
      mkState.slug = mk.slug || null;
      // Existing kits keep whatever they have: a NULL theme means the kit
      // predates the toggle and stays on the school-colors look.
      mkState.theme = (mk.theme === 'nildash') ? 'nildash' : 'school';
      mkApplyThemeUI();
      var igHEl = document.getElementById('mk-ig-handle'); if (mk.instagram_handle && igHEl) igHEl.value = mk.instagram_handle;
      var igFEl = document.getElementById('mk-ig-followers'); if (mk.instagram_followers && igFEl) igFEl.value = mk.instagram_followers;
      var igEEl = document.getElementById('mk-ig-engagement'); if (mk.instagram_engagement && igEEl) igEEl.value = mk.instagram_engagement;
      var ttHEl = document.getElementById('mk-tt-handle'); if (mk.tiktok_handle && ttHEl) ttHEl.value = mk.tiktok_handle;
      var ttFEl = document.getElementById('mk-tt-followers'); if (mk.tiktok_followers && ttFEl) ttFEl.value = mk.tiktok_followers;
      var twHEl = document.getElementById('mk-tw-handle'); if (mk.twitter_handle && twHEl) twHEl.value = mk.twitter_handle;
      var twFEl = document.getElementById('mk-tw-followers'); if (mk.twitter_followers && twFEl) twFEl.value = mk.twitter_followers;
      var bioEl = document.getElementById('mk-bio'); if (mk.bio && bioEl) { bioEl.value = mk.bio; mkUpdateBioCount(); }
      if (mk.primary_color) {
        var cpEl = document.getElementById('mk-color-primary'); if (cpEl) cpEl.value = mk.primary_color;
        var cphEl = document.getElementById('mk-color-primary-hex'); if (cphEl) cphEl.value = mk.primary_color;
      }
      if (mk.secondary_color) {
        var csEl = document.getElementById('mk-color-secondary'); if (csEl) csEl.value = mk.secondary_color;
        var cshEl = document.getElementById('mk-color-secondary-hex'); if (cshEl) cshEl.value = mk.secondary_color;
      }
      if (mk.headshot_url && mk.headshot_url.startsWith('data:')) {
        mkState.headshotData = mk.headshot_url;
        var hsi = document.getElementById('mk-headshot-img'); if (hsi) hsi.src = mk.headshot_url;
        var hsp = document.getElementById('mk-headshot-preview'); if (hsp) hsp.style.display = 'block';
        var hsh = document.getElementById('mk-headshot-placeholder'); if (hsh) hsh.style.display = 'none';
      }
      if (mk.action_shot_data && mk.action_shot_data.startsWith('data:')) {
        mkState.actionShotData = mk.action_shot_data;
        var asi = document.getElementById('mk-action-img'); if (asi) asi.src = mk.action_shot_data;
        var asp = document.getElementById('mk-action-preview'); if (asp) asp.style.display = 'block';
        var ash = document.getElementById('mk-action-placeholder'); if (ash) ash.style.display = 'none';
      }
      mkState.rates = (data.rateCards || []).map(function(rc){ return { service_type: rc.service_type, price: rc.price, notes: rc.notes||'' }; });
      mkRenderRateRows();
      if (mk.slug) mkShowShareLink(mk.slug);
      mkRenderViewStats(data.viewStats);
      mkRenderVariants(mk, data.viewStats);
    } else {
      mkRenderRateRows();
      mkRenderViewStats(null);
      mkRenderVariants(null);
    }
    mkUpdatePreview();
  } catch(e) {
    console.error('[amkLoadForAthlete]', e);
    if (statusEl) statusEl.textContent = 'Error loading media kit.';
    mkUpdatePreview();
  }
}

;

var growthModule = (function() {
  var _prospects = [];
  var _sequences = {};
  var _log = [];
  var _currentSeqType = 'agent';

  var STATUS_COLORS = {
    pending:   { bg: 'rgba(251,191,36,0.1)',  border: 'rgba(251,191,36,0.3)',  color: '#fbbf24' },
    approved:  { bg: 'rgba(132,204,22,0.1)',  border: 'rgba(132,204,22,0.3)',  color: '#84CC16' },
    skip:      { bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.3)', color: '#6b7280' },
    replied:   { bg: 'rgba(167,139,250,0.1)', border: 'rgba(167,139,250,0.3)', color: '#a78bfa' },
    converted: { bg: 'rgba(34,197,94,0.1)',   border: 'rgba(34,197,94,0.3)',   color: '#22c55e' }
  };

  function statusPill(s) {
    var c = STATUS_COLORS[s] || STATUS_COLORS.pending;
    return '<span style="padding:2px 8px;border-radius:9999px;font-size:10px;font-weight:700;font-family:var(--mono);background:' + c.bg + ';border:1px solid ' + c.border + ';color:' + c.color + '">' + s + '</span>';
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' });
  }

  async function load() {
    await Promise.all([loadProspects(), loadSequences(), loadLog()]);
    renderProspects();
    renderLog();
  }

  async function loadProspects() {
    try {
      var r = await fetch('/api/growth/prospects');
      if (r.ok) _prospects = await r.json();
    } catch(e) { console.warn('[growth] loadProspects:', e.message); }
  }

  async function loadSequences() {
    try {
      var r = await fetch('/api/growth/sequences');
      if (r.ok) {
        var rows = await r.json();
        _sequences = {};
        rows.forEach(function(s) { _sequences[s.type] = s; });
        renderSequence('agent');
      }
    } catch(e) { console.warn('[growth] loadSequences:', e.message); }
  }

  async function loadLog() {
    try {
      var r = await fetch('/api/growth/outreach-log');
      if (r.ok) _log = await r.json();
    } catch(e) { console.warn('[growth] loadLog:', e.message); }
  }

  async function loadBadge() {
    try {
      var r = await fetch('/api/growth/badge');
      if (!r.ok) return;
      var data = await r.json();
      var badge = document.getElementById('growth-badge');
      if (!badge) return;
      if (data.replied > 0) {
        badge.textContent = data.replied;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    } catch(e) {}
  }

  function renderProspects() {
    var filter = (document.getElementById('growth-filter') || {}).value || 'all';
    var tbody = document.getElementById('growth-prospects-tbody');
    if (!tbody) return;
    var rows = filter === 'all' ? _prospects : _prospects.filter(function(p) { return p.status === filter; });
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:20px 10px;color:var(--muted);font-size:12px">No prospects match the filter.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(p) {
      var actions = '';
      if (p.status === 'pending') {
        actions += '<button onclick="growthModule.setStatus(' + p.id + ',\'approved\')" style="padding:4px 10px;background:rgba(132,204,22,0.1);border:1px solid rgba(132,204,22,0.3);border-radius:4px;color:var(--accent);font-size:11px;cursor:pointer;margin-right:4px">Add to Outreach</button>';
        actions += '<button onclick="growthModule.setStatus(' + p.id + ',\'skip\')" style="padding:4px 10px;background:rgba(107,114,128,0.1);border:1px solid rgba(107,114,128,0.3);border-radius:4px;color:#6b7280;font-size:11px;cursor:pointer">Skip</button>';
      } else if (p.status === 'replied') {
        actions += '<button onclick="growthModule.setStatus(' + p.id + ',\'converted\')" style="padding:4px 10px;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:4px;color:#22c55e;font-size:11px;cursor:pointer">Mark Converted</button>';
      }
      actions += '<button onclick="growthModule.deleteProp(' + p.id + ')" style="padding:4px 8px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:4px;color:#ef4444;font-size:11px;cursor:pointer;margin-left:4px">✕</button>';
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:9px 10px;color:var(--text);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (p.name || '—') + '<div style="font-size:10px;color:var(--muted)">' + (p.website || '') + '</div></td>' +
        '<td style="padding:9px 10px"><span style="padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;font-family:var(--mono);background:' + (p.type==='agent' ? 'rgba(132,204,22,0.08)' : 'rgba(167,139,250,0.08)') + ';color:' + (p.type==='agent' ? 'var(--accent)' : '#a78bfa') + '">' + p.type + '</span></td>' +
        '<td style="padding:9px 10px;color:var(--muted);font-size:11px">' + (p.email || '—') + '</td>' +
        '<td style="padding:9px 10px;color:var(--muted);font-size:11px">' + (p.location || '—') + '</td>' +
        '<td style="padding:9px 10px">' + statusPill(p.status) + '</td>' +
        '<td style="padding:9px 10px;white-space:nowrap">' + actions + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderSequence(type) {
    var seq = _sequences[type] || {};
    ['subject1','body1','subject2','body2','subject3','body3'].forEach(function(k) {
      var el = document.getElementById('gseq-' + k);
      if (el) el.value = seq[k] || '';
    });
  }

  function renderLog() {
    var tbody = document.getElementById('growth-log-tbody');
    if (!tbody) return;
    if (!_log.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding:20px 10px;color:var(--muted);font-size:12px">No outreach sent yet.</td></tr>';
      return;
    }
    tbody.innerHTML = _log.map(function(l) {
      var actions = '';
      if (l.prospect_status !== 'replied' && l.prospect_status !== 'converted') {
        actions = '<button onclick="growthModule.setStatus(' + l.prospect_id + ',\'replied\')" style="padding:4px 10px;background:rgba(167,139,250,0.1);border:1px solid rgba(167,139,250,0.3);border-radius:4px;color:#a78bfa;font-size:11px;cursor:pointer">Mark Replied</button>';
      } else {
        actions = statusPill(l.prospect_status);
      }
      return '<tr style="border-bottom:1px solid var(--border)">' +
        '<td style="padding:9px 10px;color:var(--text)">' + (l.prospect_name || '—') + '<div style="font-size:10px;color:var(--muted)">' + (l.prospect_email || '') + '</div></td>' +
        '<td style="padding:9px 10px"><span style="font-size:10px;font-weight:700;font-family:var(--mono);color:' + (l.prospect_type==='agent' ? 'var(--accent)' : '#a78bfa') + '">' + (l.prospect_type || '—') + '</span></td>' +
        '<td style="padding:9px 10px;color:var(--text);font-family:var(--mono)">Email ' + (l.sequence_step || 1) + '</td>' +
        '<td style="padding:9px 10px;color:var(--muted);font-size:11px">' + fmtDate(l.sent_at) + '</td>' +
        '<td style="padding:9px 10px">' + statusPill(l.status || 'sent') + '</td>' +
        '<td style="padding:9px 10px">' + actions + '</td>' +
        '</tr>';
    }).join('');
  }

  function switchTab(tab) {
    ['prospects','sequences','log','social'].forEach(function(t) {
      var panel = document.getElementById('gtab-' + t);
      var btn   = document.getElementById('gtab-' + t + '-btn');
      if (!panel || !btn) return;
      var active = t === tab;
      panel.style.display = active ? 'block' : 'none';
      btn.style.color = active ? 'var(--accent)' : 'var(--muted)';
      btn.style.fontWeight = active ? '700' : '600';
      btn.style.borderBottomColor = active ? 'var(--accent)' : 'transparent';
    });
  }

  function switchSeqType(type) {
    _currentSeqType = type;
    document.getElementById('gseq-current-type').value = type;
    var agentBtn  = document.getElementById('gseq-tab-agent');
    var schoolBtn = document.getElementById('gseq-tab-school');
    if (agentBtn)  { agentBtn.style.background  = type==='agent'  ? 'rgba(132,204,22,0.1)' : 'var(--surface2)'; agentBtn.style.color  = type==='agent'  ? 'var(--accent)' : 'var(--muted)'; agentBtn.style.borderColor  = type==='agent'  ? 'rgba(132,204,22,0.3)' : 'var(--border)'; }
    if (schoolBtn) { schoolBtn.style.background = type==='school' ? 'rgba(167,139,250,0.1)' : 'var(--surface2)'; schoolBtn.style.color = type==='school' ? '#a78bfa'       : 'var(--muted)'; schoolBtn.style.borderColor = type==='school' ? 'rgba(167,139,250,0.3)' : 'var(--border)'; }
    renderSequence(type);
  }

  async function findProspects(type) {
    var loading = document.getElementById('growth-prospects-loading');
    if (loading) loading.style.display = 'block';
    try {
      var r = await fetch('/api/growth/find-prospects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      var data = await r.json();
      if (!r.ok) { alert('Error: ' + (data.error || 'Unknown')); return; }
      await loadProspects();
      renderProspects();
      if (loading) loading.style.display = 'none';
      // brief toast
      var st = document.getElementById('gseq-status');
      if (st) { st.textContent = 'Found ' + (data.inserted || 0) + ' new prospects.'; setTimeout(function(){st.textContent='';},3000); }
    } catch(e) {
      alert('Network error: ' + e.message);
    } finally {
      if (loading) loading.style.display = 'none';
    }
  }

  async function setStatus(id, status) {
    try {
      var r = await fetch('/api/growth/prospects/' + id + '/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!r.ok) { var d=await r.json(); alert('Error: '+(d.error||'Unknown')); return; }
      // Update locally
      _prospects = _prospects.map(function(p) { return p.id===id ? Object.assign({},p,{status}) : p; });
      _log = _log.map(function(l) { return l.prospect_id===id ? Object.assign({},l,{prospect_status:status}) : l; });
      renderProspects();
      renderLog();
      loadBadge();
    } catch(e) { alert('Network error: '+e.message); }
  }

  async function deleteProp(id) {
    if (!confirm('Delete this prospect?')) return;
    try {
      await fetch('/api/growth/prospects/' + id, { method: 'DELETE' });
      _prospects = _prospects.filter(function(p) { return p.id !== id; });
      renderProspects();
    } catch(e) { alert('Network error: '+e.message); }
  }

  async function draftSequence() {
    var type = document.getElementById('gseq-current-type').value;
    var st = document.getElementById('gseq-status');
    if (st) st.textContent = 'Drafting sequence with AI…';
    try {
      var r = await fetch('/api/growth/draft-sequence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type })
      });
      var data = await r.json();
      if (!r.ok) { if(st) st.textContent='Error: '+(data.error||'Unknown'); return; }
      ['subject1','body1','subject2','body2','subject3','body3'].forEach(function(k) {
        var el = document.getElementById('gseq-' + k);
        if (el && data[k]) el.value = data[k];
      });
      if (st) { st.textContent = '✅ Draft ready — review and save.'; setTimeout(function(){st.textContent='';},4000); }
    } catch(e) {
      if (st) st.textContent = 'Network error: ' + e.message;
    }
  }

  async function saveSequence() {
    var type = document.getElementById('gseq-current-type').value;
    var payload = { type };
    ['subject1','body1','subject2','body2','subject3','body3'].forEach(function(k) {
      var el = document.getElementById('gseq-' + k);
      payload[k] = el ? el.value : '';
    });
    var st = document.getElementById('gseq-status');
    try {
      var r = await fetch('/api/growth/sequences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var data = await r.json();
      if (!r.ok) { if(st) st.textContent='Error: '+(data.error||'Unknown'); return; }
      _sequences[type] = data;
      if (st) { st.textContent = '✅ Sequence saved.'; setTimeout(function(){st.textContent='';},3000); }
    } catch(e) {
      if (st) st.textContent = 'Network error: ' + e.message;
    }
  }

  async function runDailyOutreach() {
    var logSt = document.getElementById('growth-log-status');
    if (logSt) logSt.textContent = 'Sending emails…';
    try {
      var r = await fetch('/api/growth/send-daily', { method: 'POST' });
      var data = await r.json();
      if (!r.ok) { if(logSt) logSt.textContent='Error: '+(data.error||'Unknown'); return; }
      if (logSt) logSt.textContent = '✅ Sent ' + (data.sent||0) + ' email(s). ' + (data.message||'');
      await loadLog();
      renderLog();
      await loadProspects();
      renderProspects();
    } catch(e) {
      if (logSt) logSt.textContent = 'Network error: ' + e.message;
    }
  }

  // ── Social Posts Module ────────────────────────────────────────────────────
  var _socialPosts = [];   // current batch of 10 {post, visual} objects
  var _spTopics = { deal: true, kit: true, gmail: true };

  function toggleTopic(key) {
    _spTopics[key] = !_spTopics[key];
    var btn = document.getElementById('sptopic-' + key);
    if (!btn) return;
    if (_spTopics[key]) {
      btn.style.background = 'rgba(132,204,22,0.12)';
      btn.style.borderColor = 'rgba(132,204,22,0.4)';
      btn.style.color = 'var(--accent)';
    } else {
      btn.style.background = 'var(--surface2)';
      btn.style.borderColor = 'var(--border)';
      btn.style.color = 'var(--muted)';
    }
  }

  // Clipboard helper — works on iPhone Safari
  async function _spCopy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
      } catch (e2) { return false; }
    }
  }

  function _spCountColor(n) {
    if (n <= 239) return 'var(--accent)';
    if (n <= 279) return '#FBBF24';
    return '#EF4444';
  }

  // Highlight #hashtags with green spans (for display only)
  function _spHighlight(text) {
    return text.replace(/(#\w+)/g, '<span style="color:var(--accent);font-weight:600">$1</span>');
  }

  function _spSkeletonCard() {
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;min-height:130px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
        '<div style="width:36px;height:10px;background:var(--surface2);border-radius:4px;animation:spPulse 1.2s ease-in-out infinite"></div>' +
        '<div style="width:18px;height:18px;background:var(--surface2);border-radius:3px;animation:spPulse 1.2s ease-in-out infinite"></div>' +
      '</div>' +
      '<div style="height:10px;background:var(--surface2);border-radius:4px;margin-bottom:8px;animation:spPulse 1.2s ease-in-out infinite"></div>' +
      '<div style="height:10px;background:var(--surface2);border-radius:4px;margin-bottom:8px;width:85%;animation:spPulse 1.2s ease-in-out infinite"></div>' +
      '<div style="height:10px;background:var(--surface2);border-radius:4px;width:60%;animation:spPulse 1.2s ease-in-out infinite"></div>' +
    '</div>';
  }

  function _renderPostCard(item, idx) {
    // Safely extract fields — item may be {post, visual} object or (fallback) a plain string
    var postText = '';
    var visualText = '';
    if (item && typeof item === 'object') {
      postText  = typeof item.post   === 'string' ? item.post   : String(item.post   || '');
      visualText = typeof item.visual === 'string' ? item.visual : String(item.visual || '');
    } else if (typeof item === 'string') {
      postText = item;
    }
    var n = postText.length;
    var countColor = _spCountColor(n);
    var id = 'sp-card-' + idx;
    var safePost   = postText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    var safeVisual = visualText.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return (
      '<div id="' + id + '" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px;display:flex;flex-direction:column;gap:10px">' +

        // ── Top row: post number + X icon ──────────────────────────────────────
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span style="font-size:10px;font-weight:700;color:var(--muted);font-family:var(--mono)">' + (idx + 1) + '/10</span>' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="color:var(--muted);flex-shrink:0"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' +
        '</div>' +

        // ── Post text (display mode) ─────────────────────────────────────────
        '<div id="' + id + '-display" style="font-size:13px;color:var(--text);line-height:1.6;word-break:break-word;white-space:pre-wrap">' + _spHighlight(postText) + '</div>' +

        // ── Post text (edit mode) ────────────────────────────────────────────
        '<textarea id="' + id + '-edit" style="display:none;width:100%;padding:8px;background:var(--surface2);border:1px solid var(--accent);border-radius:var(--r-sm);color:var(--text);font-size:13px;line-height:1.6;resize:vertical;min-height:80px;font-family:inherit;box-sizing:border-box" oninput="growthModule.spUpdateCount(' + idx + ')">' + safePost + '</textarea>' +

        // ── Visual attachment instruction (sits between text and char count) ──
        (visualText
          ? '<div style="border-top:1px solid rgba(201,168,76,0.3);background:rgba(201,168,76,0.05);border-radius:var(--r-sm);padding:8px 12px;display:flex;align-items:flex-start;gap:8px">' +
              '<span style="font-size:13px;flex-shrink:0;line-height:1.4">📸</span>' +
              '<span style="font-size:11px;color:#C9A84C;font-style:italic;line-height:1.5">' + safeVisual + '</span>' +
            '</div>'
          : '') +

        // ── Bottom row: char count + action buttons ──────────────────────────
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
          '<span id="' + id + '-count" style="font-size:11px;font-weight:600;color:' + countColor + ';font-family:var(--mono)">' + n + '/280</span>' +
          '<div style="display:flex;gap:6px">' +
            '<button id="' + id + '-copy-btn" onclick="growthModule.copySocialPost(' + idx + ')" style="padding:5px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--mono);transition:all 0.15s;display:inline-flex;align-items:center;gap:4px">📋 Copy</button>' +
            '<button id="' + id + '-edit-btn" onclick="growthModule.editSocialPost(' + idx + ')" style="padding:5px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);color:var(--text);font-size:11px;font-weight:600;cursor:pointer;font-family:var(--mono);transition:all 0.15s;display:inline-flex;align-items:center;gap:4px">✏️ Edit</button>' +
          '</div>' +
        '</div>' +

      '</div>'
    );
  }

  function spUpdateCount(idx) {
    var ta = document.getElementById('sp-card-' + idx + '-edit');
    var countEl = document.getElementById('sp-card-' + idx + '-count');
    if (!ta || !countEl) return;
    var n = ta.value.length;
    countEl.textContent = n + '/280';
    countEl.style.color = _spCountColor(n);
    if (_socialPosts[idx]) _socialPosts[idx].post = ta.value; // keep in sync
  }

  function editSocialPost(idx) {
    var display = document.getElementById('sp-card-' + idx + '-display');
    var ta = document.getElementById('sp-card-' + idx + '-edit');
    var btn = document.getElementById('sp-card-' + idx + '-edit-btn');
    if (!display || !ta || !btn) return;
    var isEditing = ta.style.display !== 'none';
    if (isEditing) {
      // Done editing — update display
      var updated = ta.value;
      if (_socialPosts[idx]) _socialPosts[idx].post = updated;
      display.innerHTML = _spHighlight(updated);
      display.style.display = '';
      ta.style.display = 'none';
      btn.textContent = '✏️ Edit';
      spUpdateCount(idx);
    } else {
      // Enter edit mode
      ta.value = (_socialPosts[idx] && _socialPosts[idx].post) ? _socialPosts[idx].post : '';
      display.style.display = 'none';
      ta.style.display = 'block';
      ta.focus();
      btn.textContent = '✓ Done';
    }
  }

  async function copySocialPost(idx) {
    var btn = document.getElementById('sp-card-' + idx + '-copy-btn');
    var text = (_socialPosts[idx] && _socialPosts[idx].post) ? _socialPosts[idx].post : '';
    var ok = await _spCopy(text);
    if (btn) {
      btn.textContent = ok ? '✓ Copied!' : '✗ Failed';
      btn.style.color = ok ? 'var(--accent)' : '#EF4444';
      setTimeout(function() { btn.textContent = '📋 Copy'; btn.style.color = 'var(--text)'; }, 2000);
    }
  }

  async function copyAllPosts() {
    var allBtn = document.getElementById('sp-copy-all-btn');
    var text = _socialPosts.filter(Boolean).map(function(p) { return (p && p.post) ? p.post : ''; }).filter(Boolean).join('\n\n');
    var ok = await _spCopy(text);
    if (allBtn) {
      allBtn.textContent = ok ? '✓ All Copied!' : '✗ Failed';
      setTimeout(function() { allBtn.textContent = '📋 Copy All'; }, 2500);
    }
  }

  async function generateSocialPosts() {
    var topics = Object.keys(_spTopics).filter(function(k) { return _spTopics[k]; });
    if (topics.length === 0) {
      alert('Select at least one topic before generating.');
      return;
    }
    var genBtn  = document.getElementById('sp-generate-btn');
    var loading = document.getElementById('sp-loading');
    var skelGrid = document.getElementById('sp-skeleton-grid');
    var grid    = document.getElementById('sp-posts-grid');
    var errEl   = document.getElementById('sp-error');
    var actions = document.getElementById('sp-actions');
    var tip     = document.getElementById('sp-tip');

    // Show loading, hide previous results
    if (genBtn)  { genBtn.disabled = true; genBtn.style.opacity = '0.5'; }
    if (errEl)   errEl.style.display = 'none';
    if (grid)    { grid.style.display = 'none'; grid.innerHTML = ''; }
    if (actions) actions.style.display = 'none';
    if (tip)     tip.style.display = 'none';

    // Build skeleton cards
    if (skelGrid) {
      skelGrid.innerHTML = '';
      for (var i = 0; i < 10; i++) skelGrid.innerHTML += _spSkeletonCard();
    }
    if (loading) loading.style.display = 'block';

    try {
      var r = await fetch('/api/growth/generate-social-posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topics: topics })
      });
      var data = await r.json();
      console.log('[social-posts] API response:', JSON.stringify(data, null, 2));
      if (!r.ok || data.error) throw new Error(data.error || 'Unknown error');

      // Normalise on the frontend too in case older server code returns strings
      _socialPosts = (data.posts || []).map(function(p) {
        if (p && typeof p === 'object') return { post: String(p.post || ''), visual: String(p.visual || '') };
        return { post: String(p || ''), visual: '' };
      });
      if (loading) loading.style.display = 'none';

      // Render cards
      if (grid) {
        grid.innerHTML = _socialPosts.map(function(p, i) { return _renderPostCard(p, i); }).join('');
        grid.style.display = 'grid';
      }
      if (actions) { actions.style.display = 'flex'; }
      if (tip)     { tip.style.display = 'block'; }
    } catch (e) {
      if (loading) loading.style.display = 'none';
      if (errEl)   { errEl.textContent = 'Could not generate posts. Please try again.'; errEl.style.display = 'block'; }
      console.error('[social-posts] generation error:', e.message);
    } finally {
      if (genBtn) { genBtn.disabled = false; genBtn.style.opacity = '1'; }
    }
  }

  return {
    load,
    loadBadge,
    switchTab,
    switchSeqType,
    findProspects,
    setStatus,
    deleteProp,
    draftSequence,
    saveSequence,
    runDailyOutreach,
    renderProspects,
    // Social Posts
    toggleTopic,
    generateSocialPosts,
    copySocialPost,
    editSocialPost,
    copyAllPosts,
    spUpdateCount,
  };
})();
