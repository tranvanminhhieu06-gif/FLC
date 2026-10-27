'use strict';
const db = require('../db');
const { fail, audit, notify } = require('./core');
const { DEFAULT_RATES } = require('../lib/labels');

const PAYABLE_ROLES = ['REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT'];

/**
 * Tính các dòng hoa hồng cho MỘT khoản thu (hàm thuần — có unit test).
 * @param net          doanh thu thuần của khoản thu (âm nếu là hoàn tiền)
 * @param allocations  { ROLE: rate_bp } — bản chụp tỷ lệ của Order
 * @param holders      { ROLE: [{ userId, shareBp }] } — người đã khóa phân công
 * @param needsPm      Order có PM hay không (không có → phần PM về Account)
 * Tổng amount của các dòng luôn bằng đúng net (phần dư làm tròn về M&T).
 */
function computeLines({ net, allocations, holders, needsPm }) {
  const lines = [];
  let distributed = 0;
  for (const role of PAYABLE_ROLES) {
    const rate = allocations[role] || 0;
    if (!rate) continue;
    const pool = Math.round((net * rate) / 10000);
    let people = holders[role] || [];
    let reason = null;
    if (role === 'PM' && !needsPm) {
      people = holders.ACCOUNT || [];
      reason = 'Account kiêm PM (Order không có PM)';
    }
    if (!people.length) {
      lines.push({
        beneficiary: 'MT', userId: null, role, base: net, rate, share: 10000, amount: pool,
        reason: role === 'REFERRER' ? 'Không có Referrer — Admin giữ lại' : 'Không có người đảm nhận — Admin giữ lại',
      });
    } else {
      const totalShare = people.reduce((s, h) => s + h.shareBp, 0) || 1;
      let left = pool;
      people.forEach((h, i) => {
        const amount = i === people.length - 1 ? left : Math.round((pool * h.shareBp) / totalShare);
        left -= amount;
        lines.push({ beneficiary: 'U' + h.userId, userId: h.userId, role, base: net, rate, share: h.shareBp, amount, reason });
      });
    }
    distributed += pool;
  }
  lines.push({
    beneficiary: 'MT', userId: null, role: 'MT', base: net, rate: allocations.MT || 0, share: 10000,
    amount: net - distributed, reason: 'Phần M&T (gồm chênh lệch làm tròn)',
  });
  return lines;
}

function activePolicy() {
  const p = db.get('SELECT * FROM rate_policies WHERE active = 1 ORDER BY id DESC LIMIT 1');
  return p ? { ...p, rates: JSON.parse(p.rates_json) } : { id: null, name: 'Mặc định', rates: { ...DEFAULT_RATES } };
}

function validateRates(rates) {
  const keys = [...PAYABLE_ROLES, 'MT'];
  for (const k of keys) {
    if (!Number.isInteger(rates[k]) || rates[k] < 0 || rates[k] > 10000) fail(`Tỷ lệ ${k} không hợp lệ`);
  }
  const sum = keys.reduce((s, k) => s + rates[k], 0);
  if (sum !== 10000) fail(`Tổng tỷ lệ phải bằng 100% (hiện ${sum / 100}%)`);
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
    for (const [role, bp] of Object.entries(rates)) {
      db.run('UPDATE revenue_allocations SET rate_bp = ? WHERE order_id = ? AND role = ?', bp, orderId, role);
    }
    audit(adminId, 'allocation.adjust', 'order', orderId, { before, after: rates, reason });
  });
}

function lockedHolders(orderId) {
  const holders = {};
  for (const a of db.all("SELECT user_id, role, share_bp FROM order_assignments WHERE order_id = ? AND status = 'LOCKED'", orderId)) {
    (holders[a.role] ||= []).push({ userId: a.user_id, shareBp: a.share_bp });
  }
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

/** Hoa hồng DỰ KIẾN — chỉ tính để hiển thị, không ghi sổ */
function estimateFor(userId) {
  const policy = activePolicy().rates;
  const rows = db.all(
    `SELECT a.order_id, a.role, a.share_bp, o.code, o.title, o.status, o.needs_pm, c.value
       FROM order_assignments a JOIN orders o ON o.id = a.order_id
       LEFT JOIN contracts c ON c.order_id = o.id
      WHERE a.user_id = ? AND a.status IN ('ACCEPTED','LOCKED') AND o.status NOT IN ('CANCELLED','CLOSED')`, userId,
  );
  return rows.map((r) => {
    const alloc = orderAllocations(r.order_id) || policy;
    let rate = alloc[r.role] || 0;
    if (r.role === 'ACCOUNT' && r.needs_pm === 0) rate += alloc.PM || 0;
    return { ...r, rate, estimate: r.value ? Math.round((r.value * rate * r.share_bp) / 1e8) : null };
  });
}

module.exports = {
  computeLines, activePolicy, validateRates, setPolicy, orderAllocations, adjustAllocations,
  reconcile, approve, voidLine, payout, estimateFor, PAYABLE_ROLES,
};
