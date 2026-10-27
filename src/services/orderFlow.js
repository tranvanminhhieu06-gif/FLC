'use strict';
// Máy trạng thái Order — mọi thay đổi status đều phải đi qua transition()
const db = require('../db');
const { fail, audit, notify, notifyAdmins } = require('./core');
const { ORDER_STATUS } = require('../lib/labels');

const TRANSITIONS = {
  DRAFT:                  ['PENDING_INTAKE', 'CANCELLED'],
  PENDING_INTAKE:         ['CONSULTING', 'CANCELLED'],
  CONSULTING:             ['QUOTED', 'CANCELLED'],
  QUOTED:                 ['CONTRACT_SIGNED', 'REJECTED', 'CONSULTING', 'CANCELLED'],
  REJECTED:               ['CONSULTING', 'CANCELLED'],
  CONTRACT_SIGNED:        ['AWAITING_DEPOSIT'],
  AWAITING_DEPOSIT:       ['DEPOSITED', 'CANCELLED'],
  DEPOSITED:              ['MATCHING', 'CANCELLED'],
  MATCHING:               ['PENDING_MATCH_APPROVAL', 'CANCELLED'],
  PENDING_MATCH_APPROVAL: ['IN_PROGRESS', 'MATCHING', 'CANCELLED'],
  IN_PROGRESS:            ['IN_REVIEW', 'CANCELLED'],
  IN_REVIEW:              ['IN_PROGRESS', 'DEMO', 'PREVIEW', 'CANCELLED'],
  DEMO:                   ['IN_PROGRESS', 'IN_REVIEW', 'PREVIEW', 'AWAITING_PAYMENT', 'ACCEPTANCE', 'CANCELLED'],
  PREVIEW:                ['IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'AWAITING_PAYMENT', 'ACCEPTANCE', 'CANCELLED'],
  AWAITING_PAYMENT:       ['ACCEPTANCE'],
  ACCEPTANCE:             ['RECONCILIATION'],
  RECONCILIATION:         ['COMPLETED'],
  COMPLETED:              ['CLOSED'],
  CLOSED:                 [],
  CANCELLED:              [],
};

// Từ các trạng thái này trở đi, chỉ Admin mới được hủy (kèm lý do)
const ADMIN_ONLY_CANCEL = ['MATCHING', 'PENDING_MATCH_APPROVAL', 'IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Kiểm tra điều kiện nghiệp vụ trước khi chuyển. Ném FlowError nếu không đạt. */
function guard(order, to, actor, note) {
  const finance = require('./finance');
  switch (to) {
    case 'PENDING_INTAKE': {
      const customer = db.get('SELECT status FROM users WHERE id = ?', order.customer_id);
      if (customer.status !== 'ACTIVE') fail('Tài khoản cần được M&T duyệt trước khi gửi Order');
      break;
    }
    case 'DEPOSITED':
      if (!finance.summary(order.id).depositMet && !order.deposit_exception) {
        fail('Chưa đạt điều kiện đặt cọc — cần M&T xác nhận đủ tiền cọc hoặc phê duyệt ngoại lệ');
      }
      break;
    case 'MATCHING':
      if (order.status === 'DEPOSITED' && !order.deposit_exception && !finance.summary(order.id).depositMet) {
        fail('Chưa đạt điều kiện đặt cọc');
      }
      break;
    case 'IN_PROGRESS':
      if (order.status === 'PENDING_MATCH_APPROVAL' && !db.get('SELECT 1 FROM revenue_allocations WHERE order_id = ?', order.id)) {
        fail('Chưa khóa danh sách nhân sự và tỷ lệ');
      }
      break;
    case 'ACCEPTANCE':
      if (!finance.summary(order.id).paidInFull) fail('Khách hàng chưa thanh toán đủ theo hợp đồng');
      break;
    case 'COMPLETED': {
      const pending = db.get(
        "SELECT COUNT(*) AS n FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'", order.id,
      ).n;
      const unreconciled = db.get(
        'SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND confirmed_at IS NOT NULL AND reconciled = 0', order.id,
      ).n;
      if (unreconciled) fail('Còn khoản thu chưa đối soát');
      if (pending) fail('Còn hoa hồng chờ duyệt');
      break;
    }
    case 'CANCELLED':
      if (ADMIN_ONLY_CANCEL.includes(order.status)) {
        if (actor?.kind !== 'admin') fail('Order đã vào giai đoạn triển khai — chỉ M&T được hủy', 403);
        if (!note) fail('Cần nhập lý do hủy');
      }
      break;
  }
}

function transition(orderId, to, actorId, note) {
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) fail('Không tìm thấy Order', 404);
    if (!canTransition(order.status, to)) {
      fail(`Không thể chuyển từ "${ORDER_STATUS[order.status].label}" sang "${ORDER_STATUS[to]?.label || to}"`);
    }
    const actor = actorId ? db.get('SELECT id, kind FROM users WHERE id = ?', actorId) : null;
    guard(order, to, actor, note);
    db.run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", to, orderId);
    if (to === 'PENDING_INTAKE') db.run("UPDATE orders SET submitted_at = datetime('now') WHERE id = ?", orderId);
    db.run(
      'INSERT INTO order_status_history (order_id, from_status, to_status, actor_id, note) VALUES (?, ?, ?, ?, ?)',
      orderId, order.status, to, actorId, note || null,
    );
    audit(actorId, 'order.transition', 'order', orderId, { before: { status: order.status }, after: { status: to }, reason: note });
    const link = `/orders/${orderId}`;
    const label = ORDER_STATUS[to].label;
    if (order.customer_id !== actorId) notify(order.customer_id, `${order.code}: ${label}`, link);
    for (const a of db.all("SELECT DISTINCT user_id FROM order_assignments WHERE order_id = ? AND status IN ('ACCEPTED','LOCKED')", orderId)) {
      if (a.user_id !== actorId) notify(a.user_id, `${order.code}: ${label}`, link);
    }
    if (['PENDING_MATCH_APPROVAL', 'RECONCILIATION', 'ACCEPTANCE'].includes(to)) notifyAdmins(`${order.code}: ${label}`, `/orders/${orderId}`);
    return { ...order, status: to };
  });
}

module.exports = { TRANSITIONS, canTransition, transition };
