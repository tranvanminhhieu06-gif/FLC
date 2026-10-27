'use strict';
const db = require('../db');
const { fail, audit, notify } = require('./core');
const { DEFAULT_RATES, RATE_KEYS } = require('../lib/labels');
// Quy tắc chia nằm ở module dùng chung với trình duyệt để bộ tính trên trang Doanh thu luôn khớp sổ
const { computeLines, PAYABLE_ROLES } = require('../../public/js/revenue-core');

/** Chính sách cũ (trước khi có vai trò mới) được bổ sung 0 cho vai trò thiếu */
const withAllKeys = (rates) => Object.fromEntries(RATE_KEYS.map((k) => [k, rates[k] || 0]));

function activePolicy() {
  const p = db.get('SELECT * FROM rate_policies WHERE active = 1 ORDER BY id DESC LIMIT 1');
  return p ? { ...p, rates: withAllKeys(JSON.parse(p.rates_json)) } : { id: null, name: 'Mặc định', rates: { ...DEFAULT_RATES } };
}

function validateRates(rates) {
  for (const k of RATE_KEYS) {
    if (!Number.isInteger(rates[k]) || rates[k] < 0 || rates[k] > 10000) fail(`Tỷ lệ ${k} không hợp lệ`);
  }
  const sum = RATE_KEYS.reduce((s, k) => s + rates[k], 0);
  if (sum !== 10000) fail(`Tổng tỷ lệ phải bằng 100% (hiện ${sum / 100}%)`);
}

/** Người nhận phần Coder web (cấu hình bởi M&T); null nếu chưa đặt hoặc tài khoản không còn hoạt động */
function devUserId() {
  const r = db.get("SELECT u.id FROM settings s JOIN users u ON u.id = CAST(s.value AS INTEGER) WHERE s.key = 'dev_user_id' AND u.status = 'ACTIVE'");
  return r ? r.id : null;
}

function setDevUser({ adminId, userId, reason }) {
  const before = devUserId();
  if (userId && !db.get("SELECT 1 FROM users WHERE id = ? AND status = 'ACTIVE'", userId)) fail('Tài khoản nhận phải đang hoạt động');
  db.tx(() => {
    if (userId) db.run("INSERT INTO settings (key, value) VALUES ('dev_user_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(userId));
    else db.run("DELETE FROM settings WHERE key = 'dev_user_id'");
    audit(adminId, 'setting.dev_user', 'setting', null, { before: { userId: before }, after: { userId: userId || null }, reason });
  });
}

function setPolicy({ adminId, name, rates, reason }) {
  validateRates(rates);
  return db.tx(() => {
    const before = activePolicy();
    db.run('UPDATE rate_policies SET active = 0 WHERE active = 1');
    const r = db.run('INSERT INTO rate_policies (name, rates_json, active, created_by) VALUES (?, ?, 1, ?)', name, JSON.stringify(rates), adminId);
    audit(adminId, 'policy.set', 'rate_policy', r.lastInsertRowid, { before: before.rates, after: rates, reason });
  });
}

function orderAllocations(orderId) {
  const rows = db.all('SELECT role, rate_bp FROM revenue_allocations WHERE order_id = ?', orderId);
  return rows.length ? Object.fromEntries(rows.map((r) => [r.role, r.rate_bp])) : null;
}

/** Admin điều chỉnh tỷ lệ của một Order đã khóa — chỉ ảnh hưởng các đợt chưa đối soát */
function adjustAllocations({ orderId, adminId, rates, reason }) {
  if (!reason) fail('Điều chỉnh tỷ lệ đã chốt cần có lý do');
  validateRates(rates);
  db.tx(() => {
    const before = orderAllocations(orderId);
    if (!before) fail('Order chưa khóa tỷ lệ');
    // Upsert: Order khóa trước khi có vai trò mới (vd. Coder web) chưa có dòng cho vai trò đó
    for (const [role, bp] of Object.entries(rates)) {
      db.run(
        'INSERT INTO revenue_allocations (order_id, role, rate_bp) VALUES (?, ?, ?) ON CONFLICT(order_id, role) DO UPDATE SET rate_bp = excluded.rate_bp',
        orderId, role, bp,
      );
    }
    audit(adminId, 'allocation.adjust', 'order', orderId, { before, after: rates, reason });
  });
}

function lockedHolders(orderId) {
  const holders = {};
  for (const a of db.all("SELECT user_id, role, share_bp FROM order_assignments WHERE order_id = ? AND status = 'LOCKED'", orderId)) {
    (holders[a.role] ||= []).push({ userId: a.user_id, shareBp: a.share_bp });
  }
  // Coder web nhận trên mọi Order, không qua phân công
  const dev = devUserId();
  if (dev) holders.DEV = [{ userId: dev, shareBp: 10000 }];
  return holders;
}

/**
 * Đối soát: Admin bấm mới chạy (không tự chia khi Order hoàn tất).
 * Tính hoa hồng cho từng khoản thu đã xác nhận nhưng chưa đối soát.
 */
function reconcile({ orderId, adminId }) {
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    const allocations = orderAllocations(orderId);
    if (!allocations) fail('Order chưa khóa tỷ lệ phân bổ — chưa thể đối soát');
    const holders = lockedHolders(orderId);
    const payments = db.all(
      'SELECT * FROM payments WHERE order_id = ? AND confirmed_at IS NOT NULL AND reconciled = 0 ORDER BY id', orderId,
    );
    if (!payments.length) fail('Không có khoản thu mới cần đối soát');
    let count = 0;
    for (const p of payments) {
      const net = p.amount - p.tax - p.deductions;
      for (const l of computeLines({ net, allocations, holders, needsPm: !!order.needs_pm })) {
        db.run(
          `INSERT INTO commissions (order_id, payment_id, beneficiary, user_id, role, base_amount, rate_bp, share_bp, amount, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          orderId, p.id, l.beneficiary, l.userId, l.role, l.base, l.rate, l.share, l.amount,
          l.userId ? 'PENDING_APPROVAL' : 'RETAINED', l.reason,
        );
        count++;
      }
      db.run('UPDATE payments SET reconciled = 1 WHERE id = ?', p.id);
    }
    audit(adminId, 'order.reconcile', 'order', orderId, { after: { payments: payments.map((p) => p.id), lines: count } });
    return count;
  });
}

function approve({ ids, adminId }) {
  return db.tx(() => {
    let n = 0;
    for (const id of ids) {
      const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
      if (!c || c.status !== 'PENDING_APPROVAL') continue;
      db.run("UPDATE commissions SET status = 'APPROVED', approved_by = ?, approved_at = datetime('now') WHERE id = ?", adminId, id);
      audit(adminId, 'commission.approve', 'commission', id, { after: { amount: c.amount } });
      notify(c.user_id, `Hoa hồng ${c.role} đã được duyệt`, '/fl/earnings');
      n++;
    }
    return n;
  });
}

function voidLine({ id, adminId, reason }) {
  if (!reason) fail('Cần lý do khi hủy dòng hoa hồng');
  const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
  if (!c || c.status !== 'PENDING_APPROVAL') fail('Chỉ hủy được dòng đang chờ duyệt');
  db.run("UPDATE commissions SET status = 'VOID', reason = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?",
    `${c.reason ? c.reason + ' · ' : ''}Hủy: ${reason}`, adminId, id);
  audit(adminId, 'commission.void', 'commission', id, { before: { status: c.status }, reason });
}

/** Chi trả: gom các dòng đã duyệt chưa chi của một freelancer thành một Payout */
function payout({ userId, adminId, ref }) {
  if (!ref) fail('Cần nhập mã giao dịch chuyển khoản');
  return db.tx(() => {
    const lines = db.all("SELECT id, amount FROM commissions WHERE user_id = ? AND status = 'APPROVED' AND payout_id IS NULL", userId);
    const total = lines.reduce((s, l) => s + l.amount, 0);
    if (!lines.length || total <= 0) fail('Không có khoản đủ điều kiện chi trả');
    const r = db.run('INSERT INTO payouts (user_id, amount, ref, created_by) VALUES (?, ?, ?, ?)', userId, total, ref, adminId);
    for (const l of lines) db.run("UPDATE commissions SET status = 'PAID', payout_id = ? WHERE id = ?", r.lastInsertRowid, l.id);
    audit(adminId, 'payout.create', 'payout', r.lastInsertRowid, { after: { userId, total, lines: lines.length, ref } });
    notify(userId, `M&T đã chi trả ${new Intl.NumberFormat('vi-VN').format(total)} ₫`, '/fl/earnings');
    return r.lastInsertRowid;
  });
}

module.exports = {
  computeLines, activePolicy, validateRates, setPolicy, orderAllocations, adjustAllocations,
  devUserId, setDevUser, reconcile, approve, voidLine, payout, PAYABLE_ROLES,
};
