'use strict';
// Doanh thu & thu nhập của một freelancer theo từng dự án đã nhận.
// Số "theo thực thu" và "dự kiến" chỉ tính để hiển thị — sổ hoa hồng (commissions) mới là khoản được trả.
const db = require('../db');
const commission = require('./commission');
const { DEFAULT_VAT_PCT } = require('../lib/labels');
// netRevenue/simulate dùng chung với bộ tính trên trình duyệt (public/js/revenue-core.js)
const { netRevenue, simulate, byRole } = require('../../public/js/revenue-core');

/** Các Order mà freelancer có phần: qua phân công, qua vai trò Coder web, hoặc đã có dòng trong sổ */
function myOrders(userId) {
  const map = new Map();
  const add = (orderId) => (map.has(orderId) ? map.get(orderId) : map.set(orderId, []).get(orderId));
  for (const a of db.all("SELECT order_id, role, share_bp, status FROM order_assignments WHERE user_id = ? AND status IN ('ACCEPTED','LOCKED')", userId)) {
    add(a.order_id).push({ role: a.role, share: a.share_bp, locked: a.status === 'LOCKED' });
  }
  if (commission.devUserId() === userId) {
    for (const r of db.all("SELECT order_id FROM revenue_allocations WHERE role = 'DEV' AND rate_bp > 0")) add(r.order_id).push({ role: 'DEV', share: 10000, locked: true });
  }
  for (const r of db.all('SELECT DISTINCT order_id FROM commissions WHERE user_id = ?', userId)) add(r.order_id);
  return map;
}

function forUser(userId) {
  const policy = commission.activePolicy().rates;
  const rows = [];
  for (const [orderId, assigned] of myOrders(userId)) {
    const o = db.get(
      `SELECT o.id, o.code, o.title, o.service_type, o.status, o.needs_pm, o.deadline, p.code AS project_code, c.value
         FROM orders o LEFT JOIN contracts c ON c.order_id = o.id LEFT JOIN projects p ON p.order_id = o.id WHERE o.id = ?`, orderId,
    );
    const ledger = db.get(
      `SELECT COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN amount END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status IN ('APPROVED', 'PAYABLE') THEN amount END), 0) AS approved,
              COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount END), 0) AS paid,
              COUNT(*) AS lines
         FROM commissions WHERE order_id = ? AND user_id = ? AND status <> 'VOID'`, orderId, userId,
    );
    if (o.status === 'CANCELLED' && !ledger.lines) continue;
    // Order đã khóa dùng tỷ lệ đã chụp; chưa khóa thì tạm tính theo chính sách hiện hành
    const allocations = commission.orderAllocations(orderId);
    const rates = allocations || policy;
    const roles = assigned.map((r) => {
      let rate = rates[r.role] || 0;
      const pmIncluded = r.role === 'ACCOUNT' && o.needs_pm === 0;
      if (pmIncluded) rate += rates.PM || 0;
      return { ...r, rate, pmIncluded };
    });
    // Tỷ lệ hưởng trên doanh thu thuần (basis point, có thể lẻ)
    const effBp = roles.reduce((s, r) => s + (r.rate * r.share) / 10000, 0);
    const pay = db.get(
      'SELECT COALESCE(SUM(amount), 0) AS collected, COALESCE(SUM(amount - tax - deductions), 0) AS net FROM payments WHERE order_id = ? AND confirmed_at IS NOT NULL',
      orderId,
    );
    // Ước tính doanh thu thuần cả hợp đồng: dùng tỷ lệ thuần/thu thực tế nếu đã có khoản thu, chưa có thì giả định giá gồm VAT mặc định
    const assumed = pay.collected <= 0;
    const netRatio = assumed ? 100 / (100 + DEFAULT_VAT_PCT) : pay.net / pay.collected;
    const expectedNet = o.value ? Math.round(o.value * netRatio) : null;
    const earned = Math.round((pay.net * effBp) / 10000);
    const recorded = ledger.pending + ledger.approved + ledger.paid;
    rows.push({
      ...o, roles, effBp, locked: !!allocations, collected: pay.collected, net: pay.net, expectedNet, assumed,
      earned, expected: expectedNet == null ? null : Math.round((expectedNet * effBp) / 10000),
      ...ledger, unreconciled: Math.max(0, earned - recorded),
    });
  }
  rows.sort((a, b) => b.id - a.id);
  const sum = (k) => rows.reduce((s, r) => s + (r[k] || 0), 0);
  const active = rows.filter((r) => !['COMPLETED', 'CLOSED', 'CANCELLED'].includes(r.status));
  return {
    rows,
    totals: {
      projects: rows.length, active: active.length,
      earned: sum('earned'), expected: sum('expected'), pending: sum('pending'), approved: sum('approved'), paid: sum('paid'),
      unreconciled: sum('unreconciled'),
      remaining: active.reduce((s, r) => s + Math.max(0, (r.expected || 0) - r.earned), 0),
    },
    policy,
  };
}

module.exports = { netRevenue, simulate, byRole, forUser };
