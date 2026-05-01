
function calcTotalNilEarned() {
  const deals = JSON.parse(localStorage.getItem('nilDashDeals') || '[]');
  const total = deals.reduce((sum, d) => {
    const val = parseFloat((d.value || '').toString().replace(/[^0-9.]/g, '')) || 0;
    return sum + val;
  }, 0);
  const el = document.getElementById('kpi-total-nil');
  if (el) el.textContent = total >= 1000 ? '$' + (total/1000).toFixed(1) + 'K' : '$' + total.toFixed(0);
}

document.addEventListener('DOMContentLoaded', function() {
  calcTotalNilEarned();
});
