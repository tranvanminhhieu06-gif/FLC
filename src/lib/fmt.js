'use strict';

const money = new Intl.NumberFormat('vi-VN');
const dateFmt = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('vi-VN', {
  timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});

// SQLite datetime('now') trả về UTC dạng 'YYYY-MM-DD HH:MM:SS'
function parse(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00+07:00');
  return new Date(String(s).replace(' ', 'T') + (String(s).includes('Z') || String(s).includes('+') ? '' : 'Z'));
}

module.exports = {
  vnd: (n) => (n == null ? '—' : money.format(n) + ' ₫'),
  num: (n) => (n == null ? '—' : money.format(n)),
  /** Rút gọn cho trục biểu đồ: 1,2 tỷ · 350 tr · 12 k */
  short: (n) => {
    const a = Math.abs(n || 0);
    const f = (v) => v.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
    if (a >= 1e9) return f(n / 1e9) + ' tỷ';
    if (a >= 1e6) return f(n / 1e6) + ' tr';
    if (a >= 1e3) return f(n / 1e3) + ' k';
    return String(n || 0);
  },
  pct: (bp) => (bp == null ? '—' : (bp / 100).toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + '%'),
  date: (s) => { const d = parse(s); return d ? dateFmt.format(d) : '—'; },
  dateTime: (s) => { const d = parse(s); return d ? dateTimeFmt.format(d) : '—'; },
  /** "1.500.000" | "1500000" -> 1500000; rỗng -> null */
  parseMoney: (v) => {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(String(v).replace(/[^\d-]/g, ''));
    return Number.isFinite(n) ? Math.trunc(n) : null;
  },
};
