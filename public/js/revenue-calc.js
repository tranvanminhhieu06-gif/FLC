// Bộ tính doanh thu trên trang /fl/revenue — tính lại ngay khi nhập, dùng chung công thức với server (revenue-core.js)
(function () {
  const form = document.getElementById('calc-form');
  const dataEl = document.getElementById('calc-data');
  if (!form || !dataEl || !window.FLCRevenue) return;
  const { rates, myRoles, hasDev } = JSON.parse(dataEl.textContent);
  const money = new Intl.NumberFormat('vi-VN');
  const vnd = (n) => money.format(n) + ' ₫';
  const val = (name) => form.elements[name];
  const num = (name) => Number(String(val(name)?.value || '').replace(/\D/g, '')) || 0;
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };

  function recalc() {
    const share = val('my_share') ? Math.min(100, Math.max(1, Number(val('my_share').value) || 100)) : 100;
    const r = window.FLCRevenue.simulate({
      input: {
        gross: num('gross'), discount: num('discount'), allowance: num('allowance'), returns: num('returns'),
        vatPct: Number(val('vat_pct').value) || 0, vatIncluded: val('vat_included').checked,
        excise: num('excise'), exportTax: num('export_tax'),
      },
      rates, myRoles, myShareBp: Math.round(share * 100),
      hasReferrer: val('has_referrer').checked, hasPm: val('has_pm').checked, hasDev,
    });
    set('out-gross', vnd(r.gross));
    set('out-deductions', vnd(r.deductions));
    set('out-vat', vnd(r.vat));
    set('out-other', vnd(r.otherTax));
    set('out-net', vnd(r.net));
    set('out-total', vnd(r.net));
    set('out-mine', vnd(r.mine));
    const groups = window.FLCRevenue.byRole(r.lines);
    document.querySelectorAll('#out-table tr[data-role]').forEach((tr) => {
      const g = groups[tr.dataset.role];
      tr.querySelector('[data-amount]').textContent = vnd(g.amount);
      tr.querySelector('[data-reason]').textContent = g.reason || '';
    });
  }

  form.addEventListener('input', (e) => { if (e.target.matches('[data-calc]')) recalc(); });
  form.addEventListener('change', (e) => { if (e.target.matches('[data-calc]')) recalc(); });
  // Có JS thì không cần tải lại trang
  form.addEventListener('submit', (e) => { e.preventDefault(); recalc(); });
})();
