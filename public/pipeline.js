// NILDash Pipeline — drag and drop kanban
(function() {
  var STAGES = ['Prospecting','Outreach Sent','Negotiating','Closing','Closed'];
  var STAGE_COLORS = {
    'Prospecting': '#6b7280',
    'Outreach Sent': '#60a5fa',
    'Negotiating': '#C8F135',
    'Closing': '#4ade80',
    'Closed': '#a78bfa'
  };
  var draggedDeal = null;

  window.NILPipeline = {
    render: function(allDeals, board) {
      if (!board) return;
      board.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:12px;align-items:stretch';

      board.innerHTML = STAGES.map(function(stage) {
        var stageDeals = allDeals.filter(function(d) { return d.stage === stage; });
        var color = STAGE_COLORS[stage] || '#6b7280';
        var colHtml = '<div class="nil-pipe-col" data-stage="' + stage + '" ' +
          'style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);min-height:300px;' +
          'transition:background 0.15s" ' +
          'ondragover="NILPipeline.onDragOver(event)" ' +
          'ondrop="NILPipeline.onDrop(event)" ' +
          'ondragleave="NILPipeline.onDragLeave(event)">' +
          '<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">' +
            '<div style="display:flex;align-items:center;gap:6px">' +
              '<span style="width:8px;height:8px;border-radius:50%;background:' + color + ';display:inline-block"></span>' +
              '<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted)">' + stage + '</span>' +
            '</div>' +
            '<span style="font-size:11px;font-weight:700;color:var(--text)">' + stageDeals.length + '</span>' +
          '</div>' +
          '<div style="padding:8px;display:flex;flex-direction:column;gap:8px">';

        stageDeals.forEach(function(d) {
          colHtml += '<div class="nil-pipe-card" draggable="true" data-deal-id="' + d.id + '" data-athlete-id="' + d.athleteId + '" data-stage="' + stage + '" ' +
            'ondragstart="NILPipeline.onDragStart(event)" ' +
            'ondragend="NILPipeline.onDragEnd(event)" ' +
            'style="background:var(--surface2);border:1px solid var(--border);border-radius:var(--r-sm);padding:14px;cursor:grab;transition:opacity 0.15s;user-select:none">' +
            '<div style="font-size:12px;font-weight:600;color:var(--text);margin-bottom:2px">' + (d.brand||'Unknown') + '</div>' +
            '<div style="font-size:11px;color:var(--muted);margin-bottom:8px">' + (d.athleteName||'') + '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">' +
              '<div style="font-size:18px;font-weight:700;color:var(--accent);letter-spacing:-0.02em">$' + (d.value||0).toLocaleString() + '</div>' +
              '<span style="font-size:9px;padding:2px 6px;border-radius:3px;background:' + color + '20;color:' + color + ';font-weight:700">' + stage.split(' ')[0] + '</span>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              (stage !== 'Closed' ?
                '<button onclick="NILPipeline.moveNext(\'' + d.id + '\',\'' + d.athleteId + '\',\'' + stage + '\')" ' +
                'style="font-size:10px;color:var(--accent);background:transparent;border:none;cursor:pointer;padding:0;font-weight:700">' +
                '→ ' + STAGES[STAGES.indexOf(stage)+1] + '</button>' :
                '<span style="font-size:10px;color:var(--muted)">✓ Closed</span>'
              ) +
              '<button onclick="NILPipeline.deleteCard(\'' + d.id + '\',\'' + d.athleteId + '\')" ' +
              'style="font-size:11px;color:#ef4444;background:transparent;border:none;cursor:pointer;padding:0">✕</button>' +
            '</div>' +
          '</div>';
        });

        colHtml += '</div></div>';
        return colHtml;
      }).join('');
    },

    onDragStart: function(e) {
      var card = e.target.closest('.nil-pipe-card') || e.target;
      draggedDeal = {
        id: card.dataset.dealId,
        athleteId: card.dataset.athleteId,
        stage: card.dataset.stage
      };
      card.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.dealId);
    },

    onDragEnd: function(e) {
      var card = e.target.closest('.nil-pipe-card') || e.target;
      card.style.opacity = '1';
      document.querySelectorAll('.nil-pipe-col').forEach(function(col) {
        col.style.background = '';
        col.style.border = '1px solid var(--border)';
      });
    },

    onDragOver: function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var col = e.currentTarget;
      col.style.background = 'rgba(200,241,53,0.05)';
      col.style.border = '1px solid rgba(200,241,53,0.3)';
    },

    onDragLeave: function(e) {
      var col = e.currentTarget;
      col.style.background = '';
      col.style.border = '1px solid var(--border)';
    },

    onDrop: async function(e) {
      e.preventDefault();
      var col = e.currentTarget;
      var newStage = col.dataset.stage;
      col.style.background = '';
      col.style.border = '1px solid var(--border)';
      if (!draggedDeal || draggedDeal.stage === newStage) return;
      await NILPipeline.updateStage(draggedDeal.id, draggedDeal.athleteId, newStage);
      draggedDeal = null;
    },

    moveNext: async function(dealId, athleteId, currentStage) {
      var idx = STAGES.indexOf(currentStage);
      var nextStage = STAGES[idx + 1];
      if (!nextStage) return;
      await NILPipeline.updateStage(dealId, athleteId, nextStage);
    },

    updateStage: async function(dealId, athleteId, newStage) {
      try {
        var base = window.API_BASE || '';
        await fetch(base + '/api/deals/' + dealId, {
          method: 'PATCH',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({stage: newStage})
        });
        if (typeof showToast === 'function') showToast('Moved to ' + newStage);
        if (typeof loadKPIs === 'function') loadKPIs();
        if (typeof loadPipeline === 'function') loadPipeline();
        if (newStage === 'Closed' && typeof renderCommission === 'function') {
          setTimeout(renderCommission, 200);
        }
      } catch(e) {
        if (typeof showToast === 'function') showToast('Error moving deal');
      }
    },

    deleteCard: async function(dealId, athleteId) {
      if (!confirm('Delete this deal?')) return;
      try {
        var base = window.API_BASE || '';
        await fetch(base + '/api/deals/' + dealId, {method:'DELETE'});
        if (typeof showToast === 'function') showToast('Deal deleted');
        if (typeof loadKPIs === 'function') loadKPIs();
        if (typeof loadPipeline === 'function') loadPipeline();
      } catch(e) {
        if (typeof showToast === 'function') showToast('Error deleting deal');
      }
    }
  };
})();
