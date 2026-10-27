// FLC — JS tối thiểu: menu mobile, xác nhận thao tác quan trọng, chọn tất cả
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-toggle-nav]');
  if (toggle) {
    const app = document.getElementById('app');
    const open = app.classList.toggle('nav-open');
    toggle.setAttribute('aria-expanded', String(open));
    return;
  }
  const app = document.getElementById('app');
  if (app && app.classList.contains('nav-open') && !e.target.closest('#sidebar')) {
    app.classList.remove('nav-open');
  }
});

document.addEventListener('submit', (e) => {
  const msg = e.submitter?.dataset.confirm || e.target.dataset.confirm;
  if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
  const btn = e.submitter;
  if (btn && !btn.dataset.noLock) {
    // Chống bấm hai lần; trả lại trạng thái nếu người dùng quay lại trang
    setTimeout(() => { btn.setAttribute('aria-disabled', 'true'); btn.dataset.label = btn.textContent; }, 0);
  }
});
window.addEventListener('pageshow', () => document.querySelectorAll('[aria-disabled="true"]').forEach((b) => b.removeAttribute('aria-disabled')));

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-check-all]')) {
    document.querySelectorAll(`input[name="${e.target.dataset.checkAll}"]`).forEach((c) => { c.checked = e.target.checked; });
  }
});

// Hiển thị số tiền có dấu chấm khi nhập
document.addEventListener('input', (e) => {
  if (!e.target.matches('[data-money]')) return;
  const digits = e.target.value.replace(/\D/g, '');
  e.target.value = digits ? Number(digits).toLocaleString('vi-VN') : '';
});
