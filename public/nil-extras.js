

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
    <button onclick="closeProfileModal()" style="position:absolute;top:14px;right:14px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:13px;padding:4px 10px;cursor:pointer">✕ Close</button>
    <div id="profileModalBody"></div>
  </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', function(e) { if (e.target === modal) closeProfileModal(); });

  calcTotalNilEarned();
});
