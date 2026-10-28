'use strict';
const db = require('../db');
const { fail, audit, history, notify, notifyAdmins } = require('./core');
const fmt = require('../lib/fmt');

/** Tổng hợp tài chính của một Order từ các khoản đã xác nhận */
function summary(orderId) {
  const contract = db.get('SELECT * FROM contracts WHERE order_id = ?', orderId);
  const s = db.get(
    `SELECT COALESCE(SUM(amount), 0) AS collected,
            COALESCE(SUM(CASE WHEN kind = 'deposit' THEN amount ELSE 0 END), 0) AS deposit,
            COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount ELSE 0 END), 0) AS refunded,
            COALESCE(SUM(amount - tax - deductions), 0) AS net
       FROM payments WHERE order_id = ? AND status IN ('CONFIRMED', 'RECONCILED')`, orderId,
  );
  const value = contract?.value ?? 0;
  return {
    contract,
    value,
    depositRequired: contract?.deposit_amount ?? 0,
    collected: s.collected,          // thực thu ròng (đã trừ hoàn tiền)
    depositPaid: s.deposit,
    refunded: s.refunded,
    net: s.net,                      // doanh thu thuần
    outstanding: Math.max(0, value - s.collected),
    paidInFull: !!contract && s.collected >= value,
    depositMet: !!contract && s.deposit >= contract.deposit_amount,
  };
}

/** Trạng thái thanh toán ở cấp Order (suy ra từ các khoản thu — mỗi khoản có payment_status riêng) */
function orderPaymentState(orderId, s = summary(orderId)) {
  const declared = db.get("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'DECLARED'", orderId).n;
  let key;
  if (!s.contract) key = 'NO_CONTRACT';
  else if (s.paidInFull) key = 'PAID_IN_FULL';
  else if (s.depositMet) key = 'PARTIAL';
  else key = 'AWAITING_DEPOSIT';
  return { key, declared };
}

/** Khách hàng (hoặc Admin thay mặt) khai báo đã chuyển khoản — chờ Admin xác nhận */
function declarePayment({ orderId, actorId, kind, amount, method, ref, note }) {
  if (!['deposit', 'installment'].includes(kind)) fail('Loại thanh toán không hợp lệ');
  if (!amount || amount <= 0) fail('Số tiền phải lớn hơn 0');
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const allowed = kind === 'deposit' ? ['AWAITING_DEPOSIT'] : ['DEPOSITED', 'MATCHING', 'PENDING_MATCH_APPROVAL', 'IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW', 'AWAITING_PAYMENT'];
  if (!allowed.includes(order.status)) fail('Order chưa ở giai đoạn nhận khoản thanh toán này');
  const s = summary(orderId);
  const pending = db.get("SELECT COALESCE(SUM(amount), 0) AS p FROM payments WHERE order_id = ? AND status = 'DECLARED'", orderId).p;
  const room = s.value - s.collected - pending;
  if (s.contract && amount > room) fail(`Số tiền vượt quá phần còn phải thu (${fmt.vnd(Math.max(0, room))}, đã trừ các khoản đang chờ xác nhận)`);
  const r = db.run(
    'INSERT INTO payments (order_id, kind, amount, method, ref, note, declared_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    orderId, kind, amount, method, ref, note, actorId,
  );
  audit(actorId, 'payment.declare', 'payment', r.lastInsertRowid, { after: { kind, amount, ref } });
  history('payment', r.lastInsertRowid, { orderId, to: 'DECLARED', actorId, reason: 'Khách báo đã chuyển khoản', data: { kind, amount, method, ref } });
  notifyAdmins(`${order.code}: khách báo đã chuyển ${fmt.vnd(amount)} — cần xác nhận`, `/admin/finance`);
  return r.lastInsertRowid;
}

/** Admin xác nhận thực thu, nhập thuế và giảm trừ. Sau khi xác nhận, số tiền bị khóa (trigger). */
function confirmPayment({ paymentId, adminId, tax = 0, deductions = 0, amount }) {
  return db.tx(() => {
    const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
    if (!p) fail('Không tìm thấy khoản thanh toán', 404);
    if (p.status !== 'DECLARED') fail('Khoản này đã được xử lý');
    if (tax < 0 || deductions < 0) fail('Thuế và giảm trừ không được âm');
    const finalAmount = amount && amount > 0 ? amount : p.amount;
    if (tax + deductions > finalAmount) fail('Thuế + giảm trừ vượt quá số tiền thu');
    const s = summary(p.order_id);
    if (s.contract && finalAmount > s.value - s.collected) fail(`Số tiền xác nhận vượt quá phần còn phải thu (${fmt.vnd(Math.max(0, s.value - s.collected))})`);
    db.run(
      "UPDATE payments SET amount = ?, tax = ?, deductions = ?, confirmed_by = ?, confirmed_at = datetime('now'), status = 'CONFIRMED' WHERE id = ?",
      finalAmount, tax, deductions, adminId, paymentId,
    );
    audit(adminId, 'payment.confirm', 'payment', paymentId, { before: { amount: p.amount }, after: { amount: finalAmount, tax, deductions } });
    history('payment', paymentId, { orderId: p.order_id, from: p.status, to: 'CONFIRMED', actorId: adminId, data: { declared: p.amount, amount: finalAmount, tax, deductions } });
    const order = db.get('SELECT * FROM orders WHERE id = ?', p.order_id);
    notify(order.customer_id, `${order.code}: M&T đã xác nhận khoản thu ${fmt.vnd(finalAmount)}`, `/orders/${order.id}`);
    advanceAfterPayment(order, adminId);
    return p.order_id;
  });
}

function rejectPayment({ paymentId, adminId, reason }) {
  if (!reason) fail('Cần nhập lý do từ chối');
  const p = db.get('SELECT * FROM payments WHERE id = ?', paymentId);
  if (!p || p.status !== 'DECLARED') fail('Khoản này đã được xử lý');
  db.tx(() => {
    db.run("UPDATE payments SET status = 'REJECTED', note = ? WHERE id = ?", `${p.note || ''} [Từ chối: ${reason}]`.trim(), paymentId);
    audit(adminId, 'payment.reject', 'payment', paymentId, { reason });
    history('payment', paymentId, { orderId: p.order_id, from: p.status, to: 'REJECTED', actorId: adminId, reason });
  });
  const order = db.get('SELECT * FROM orders WHERE id = ?', p.order_id);
  notify(order.customer_id, `${order.code}: khoản báo chuyển ${fmt.vnd(p.amount)} chưa được xác nhận — ${reason}`, `/orders/${order.id}`);
}

/** Hoàn tiền: luôn là dòng âm mới, không sửa dòng cũ */
function recordRefund({ orderId, adminId, amount, tax = 0, deductions = 0, reason }) {
  if (!amount || amount <= 0) fail('Số tiền hoàn phải lớn hơn 0');
  if (!reason) fail('Cần nhập lý do hoàn tiền');
  const s = summary(orderId);
  if (amount > s.collected) fail('Số tiền hoàn vượt quá số đã thu');
  db.tx(() => {
    const r = db.run(
      "INSERT INTO payments (order_id, kind, amount, tax, deductions, note, declared_by, confirmed_by, confirmed_at, status) VALUES (?, 'refund', ?, ?, ?, ?, ?, ?, datetime('now'), 'CONFIRMED')",
      orderId, -amount, -Math.abs(tax), -Math.abs(deductions), reason, adminId, adminId,
    );
    audit(adminId, 'payment.refund', 'payment', r.lastInsertRowid, { after: { amount: -amount }, reason });
    history('payment', r.lastInsertRowid, { orderId, to: 'CONFIRMED', actorId: adminId, reason: `Hoàn tiền: ${reason}`, data: { amount: -amount, tax, deductions } });
  });
}

/** Tự chuyển bước khi đạt điều kiện tiền: cọc đủ → Đã cọc; trả đủ → Nghiệm thu (mở file gốc) */
function advanceAfterPayment(order, actorId) {
  const flow = require('./orderFlow');
  const s = summary(order.id);
  if (order.status === 'AWAITING_DEPOSIT' && s.depositMet) {
    flow.transition(order.id, 'DEPOSITED', actorId, 'Đã nhận đủ tiền cọc', { auto: true, data: { depositPaid: s.depositPaid } });
  } else if (order.status === 'AWAITING_PAYMENT' && s.paidInFull) {
    flow.transition(order.id, 'ACCEPTANCE', actorId, 'Khách đã thanh toán đủ — mở quyền tải file gốc', { auto: true, data: { collected: s.collected } });
  }
}

module.exports = { summary, orderPaymentState, declarePayment, confirmPayment, rejectPayment, recordRefund, advanceAfterPayment };
