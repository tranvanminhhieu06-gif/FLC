'use strict';
const db = require('../db');
const { fail, audit, history, notify, notifyAdmins } = require('./core');
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

const money = (n) => `${new Intl.NumberFormat('vi-VN').format(n)} ₫`;

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
      "SELECT * FROM payments WHERE order_id = ? AND status = 'CONFIRMED' ORDER BY id", orderId,
    );
    if (!payments.length) fail('Không có khoản thu mới cần đối soát');
    let count = 0;
    for (const p of payments) {
      const net = p.amount - p.tax - p.deductions;
      for (const l of computeLines({ net, allocations, holders, needsPm: !!order.needs_pm })) {
        const status = l.userId ? 'PENDING_APPROVAL' : 'RETAINED';
        const r = db.run(
          `INSERT INTO commissions (order_id, payment_id, beneficiary, user_id, role, base_amount, rate_bp, share_bp, amount, status, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          orderId, p.id, l.beneficiary, l.userId, l.role, l.base, l.rate, l.share, l.amount, status, l.reason,
        );
        history('commission', r.lastInsertRowid, {
          orderId, to: status, actorId: adminId, reason: 'Đối soát khoản thu',
          data: { payment_id: p.id, role: l.role, base: l.base, rate_bp: l.rate, share_bp: l.share, amount: l.amount },
        });
        if (l.userId) notify(l.userId, `${order.code}: hoa hồng ${l.role} ${money(l.amount)} chờ bạn xác nhận`, '/fl/earnings');
        count++;
      }
      db.run("UPDATE payments SET status = 'RECONCILED' WHERE id = ?", p.id);
      history('payment', p.id, { orderId, from: 'CONFIRMED', to: 'RECONCILED', actorId: adminId, data: { net } });
    }
    audit(adminId, 'order.reconcile', 'order', orderId, { after: { payments: payments.map((p) => p.id), lines: count } });
    return count;
  });
}

/* ---------- Chờ duyệt → Đã duyệt: cần cả freelancer và M&T đồng ý, không có phản đối ---------- */

/** Đủ hai bên đồng ý và không còn phản đối → Đã duyệt */
function settleIfAgreed(id, actorId) {
  const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
  if (c.status !== 'PENDING_APPROVAL' || !c.user_confirmed_at || !c.approved_by || c.objection) return false;
  db.run("UPDATE commissions SET status = 'APPROVED' WHERE id = ?", id);
  history('commission', id, { orderId: c.order_id, from: c.status, to: 'APPROVED', actorId, reason: 'Freelancer và M&T đã cùng đồng ý' });
  notify(c.user_id, `Hoa hồng ${c.role} ${money(c.amount)} đã được duyệt`, '/fl/earnings');
  return true;
}

function pendingLine(id) {
  const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
  if (!c || c.status !== 'PENDING_APPROVAL') fail('Dòng hoa hồng không còn ở trạng thái chờ duyệt');
  return c;
}

/** Freelancer đồng ý số tiền của các dòng của mình */
function confirmByUser({ ids, userId }) {
  return db.tx(() => {
    let n = 0;
    for (const id of ids) {
      const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
      if (!c || c.user_id !== userId || c.status !== 'PENDING_APPROVAL' || c.user_confirmed_at) continue;
      db.run("UPDATE commissions SET user_confirmed_at = datetime('now'), objection = NULL WHERE id = ?", id);
      audit(userId, 'commission.user_confirm', 'commission', id, { after: { amount: c.amount } });
      history('commission', id, { orderId: c.order_id, from: c.status, to: c.status, actorId: userId, reason: 'Freelancer xác nhận số tiền' });
      settleIfAgreed(id, userId);
      n++;
    }
    return n;
  });
}

/** Freelancer không đồng ý: dòng bị chặn duyệt tới khi M&T xử lý */
function objectByUser({ id, userId, reason }) {
  if (!reason) fail('Cần ghi rõ lý do không đồng ý');
  db.tx(() => {
    const c = pendingLine(id);
    if (c.user_id !== userId) fail('Không tìm thấy dòng hoa hồng', 404);
    db.run('UPDATE commissions SET objection = ?, user_confirmed_at = NULL WHERE id = ?', reason, id);
    audit(userId, 'commission.object', 'commission', id, { reason });
    history('commission', id, { orderId: c.order_id, from: c.status, to: c.status, actorId: userId, reason: `Freelancer không đồng ý: ${reason}` });
    const o = db.get('SELECT code FROM orders WHERE id = ?', c.order_id);
    notifyAdmins(`${o.code}: freelancer không đồng ý hoa hồng ${c.role} — ${reason}`, '/admin/finance');
  });
}

/** M&T giữ nguyên số tiền sau khi xem phản đối (freelancer cần xác nhận lại) */
function dismissObjection({ id, adminId, reason }) {
  if (!reason) fail('Cần giải thích cho freelancer vì sao giữ nguyên');
  db.tx(() => {
    const c = pendingLine(id);
    if (!c.objection) fail('Dòng này không có phản đối');
    db.run('UPDATE commissions SET objection = NULL WHERE id = ?', id);
    audit(adminId, 'commission.dismiss_objection', 'commission', id, { before: { objection: c.objection }, reason });
    history('commission', id, { orderId: c.order_id, from: c.status, to: c.status, actorId: adminId, reason: `M&T giữ nguyên: ${reason}`, data: { objection: c.objection } });
    notify(c.user_id, `M&T giữ nguyên hoa hồng ${c.role} ${money(c.amount)}: ${reason} — vui lòng xác nhận lại`, '/fl/earnings');
  });
}

/** M&T duyệt. Dòng chỉ sang "Đã duyệt" khi freelancer cũng đã xác nhận; dòng đang bị phản đối được bỏ qua. */
function approve({ ids, adminId }) {
  return db.tx(() => {
    let n = 0;
    for (const id of ids) {
      const c = db.get('SELECT * FROM commissions WHERE id = ?', id);
      if (!c || c.status !== 'PENDING_APPROVAL' || c.approved_by || c.objection) continue;
      db.run("UPDATE commissions SET approved_by = ?, approved_at = datetime('now') WHERE id = ?", adminId, id);
      audit(adminId, 'commission.approve', 'commission', id, { after: { amount: c.amount } });
      history('commission', id, { orderId: c.order_id, from: c.status, to: c.status, actorId: adminId, reason: 'M&T duyệt' });
      settleIfAgreed(id, adminId);
      n++;
    }
    return n;
  });
}

function voidLine({ id, adminId, reason }) {
  if (!reason) fail('Cần lý do khi hủy dòng hoa hồng');
  db.tx(() => {
    const c = pendingLine(id);
    db.run("UPDATE commissions SET status = 'VOID', reason = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?",
      `${c.reason ? c.reason + ' · ' : ''}Hủy: ${reason}`, adminId, id);
    audit(adminId, 'commission.void', 'commission', id, { before: { status: c.status }, reason });
    history('commission', id, { orderId: c.order_id, from: c.status, to: 'VOID', actorId: adminId, reason, data: { objection: c.objection } });
    notify(c.user_id, `Dòng hoa hồng ${c.role} ${money(c.amount)} bị hủy: ${reason}`, '/fl/earnings');
  });
}

/* ---------- Đã duyệt → Chờ thanh toán → Đã thanh toán ---------- */

/** Đưa các dòng đã duyệt của một freelancer vào kỳ thanh toán. Order còn tranh chấp mở thì chưa đủ điều kiện. */
function schedulePayout({ userId, adminId, period }) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period || '')) fail('Kỳ thanh toán có dạng YYYY-MM');
  return db.tx(() => {
    const lines = db.all(
      `SELECT c.id, c.order_id, c.amount FROM commissions c
        WHERE c.user_id = ? AND c.status = 'APPROVED' AND c.payout_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = c.order_id AND d.status = 'OPEN')`, userId,
    );
    const total = lines.reduce((s, l) => s + l.amount, 0);
    if (!lines.length || total <= 0) fail('Không có khoản đủ điều kiện đưa vào kỳ thanh toán (đã duyệt, không có tranh chấp mở)');
    const payoutId = db.run('INSERT INTO payouts (user_id, amount, period, created_by) VALUES (?, ?, ?, ?)', userId, total, period, adminId).lastInsertRowid;
    for (const l of lines) {
      db.run("UPDATE commissions SET status = 'PAYABLE', payout_id = ? WHERE id = ?", payoutId, l.id);
      history('commission', l.id, { orderId: l.order_id, from: 'APPROVED', to: 'PAYABLE', actorId: adminId, reason: `Đưa vào kỳ ${period}`, data: { payout_id: payoutId } });
    }
    history('payout', payoutId, { to: 'SCHEDULED', actorId: adminId, data: { userId, total, period, lines: lines.length } });
    audit(adminId, 'payout.schedule', 'payout', payoutId, { after: { userId, total, period, lines: lines.length } });
    notify(userId, `Kỳ ${period}: ${money(total)} hoa hồng đang chờ chi trả`, '/fl/earnings');
    return payoutId;
  });
}

/** Ghi nhận đã chuyển khoản cho một kỳ thanh toán */
function markPaid({ payoutId, adminId, ref }) {
  if (!ref) fail('Cần nhập mã giao dịch chuyển khoản');
  return db.tx(() => {
    const p = db.get('SELECT * FROM payouts WHERE id = ?', payoutId);
    if (!p || p.status !== 'SCHEDULED') fail('Kỳ thanh toán không ở trạng thái chờ chi');
    db.run("UPDATE payouts SET status = 'PAID', ref = ?, paid_by = ?, paid_at = datetime('now') WHERE id = ?", ref, adminId, payoutId);
    for (const l of db.all("SELECT id, order_id FROM commissions WHERE payout_id = ? AND status = 'PAYABLE'", payoutId)) {
      db.run("UPDATE commissions SET status = 'PAID' WHERE id = ?", l.id);
      history('commission', l.id, { orderId: l.order_id, from: 'PAYABLE', to: 'PAID', actorId: adminId, data: { payout_id: payoutId, ref } });
    }
    history('payout', payoutId, { from: 'SCHEDULED', to: 'PAID', actorId: adminId, data: { ref } });
    audit(adminId, 'payout.paid', 'payout', payoutId, { after: { ref } });
    notify(p.user_id, `M&T đã chi trả ${money(p.amount)} (kỳ ${p.period}, mã ${ref})`, '/fl/earnings');
  });
}

module.exports = {
  computeLines, activePolicy, validateRates, setPolicy, orderAllocations, adjustAllocations,
  devUserId, setDevUser, reconcile, confirmByUser, objectByUser, dismissObjection, approve, voidLine,
  schedulePayout, markPaid, PAYABLE_ROLES,
};
