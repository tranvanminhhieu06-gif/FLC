'use strict';
// Máy trạng thái Order — mọi thay đổi status đều phải đi qua transition()
const db = require('../db');
const { fail, audit, history, notify, notifyAdmins } = require('./core');
const { ORDER_STATUS } = require('../lib/labels');

/*
 * Bảng chuyển trạng thái kèm quyền: EDGES[từ][đến] = các bên được thực hiện.
 * CUSTOMER = chủ Order · ADMIN = M&T · SALES/ACCOUNT/PM/PROJECT = freelancer đang giữ vai trò đó trong Order
 * SYSTEM = hệ thống tự chuyển khi đạt điều kiện (gọi với { auto: true } từ một thao tác đã được kiểm quyền)
 * Điều kiện nghiệp vụ chi tiết hơn (đã cọc chưa, đã trả đủ chưa…) nằm ở guard().
 */
const REVIEWERS = ['ACCOUNT', 'PM', 'ADMIN'];
const EDGES = {
  DRAFT:                  { PENDING_INTAKE: ['CUSTOMER'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  PENDING_INTAKE:         { CONSULTING: ['SALES'], REJECTED: ['ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  CONSULTING:             { QUOTED: ['SALES', 'ACCOUNT', 'ADMIN'], REJECTED: ['ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  QUOTED:                 { CONTRACT_SIGNED: ['CUSTOMER'], REJECTED: ['CUSTOMER', 'ADMIN'], CONSULTING: ['SALES', 'ACCOUNT', 'ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  REJECTED:               { CONSULTING: ['SALES', 'ACCOUNT', 'ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  CONTRACT_SIGNED:        { AWAITING_DEPOSIT: ['SYSTEM'] },
  AWAITING_DEPOSIT:       { DEPOSITED: ['SYSTEM', 'ADMIN'], CANCELLED: ['CUSTOMER', 'ADMIN'] },
  DEPOSITED:              { MATCHING: ['ACCOUNT', 'ADMIN'], CANCELLED: ['ADMIN'] },
  MATCHING:               { PENDING_MATCH_APPROVAL: ['ACCOUNT', 'PM', 'ADMIN'], CANCELLED: ['ADMIN'] },
  PENDING_MATCH_APPROVAL: { IN_PROGRESS: ['ADMIN'], MATCHING: ['ADMIN'], CANCELLED: ['ADMIN'] },
  IN_PROGRESS:            { IN_REVIEW: ['PROJECT'], CANCELLED: ['ADMIN'] },
  IN_REVIEW:              { IN_PROGRESS: REVIEWERS, DEMO: REVIEWERS, PREVIEW: REVIEWERS, CANCELLED: ['ADMIN'] },
  DEMO:                   { IN_PROGRESS: ['CUSTOMER'], IN_REVIEW: ['PROJECT'], PREVIEW: REVIEWERS, AWAITING_PAYMENT: ['CUSTOMER'], ACCEPTANCE: ['CUSTOMER'], CANCELLED: ['ADMIN'] },
  PREVIEW:                { IN_PROGRESS: ['CUSTOMER'], IN_REVIEW: ['PROJECT'], DEMO: REVIEWERS, AWAITING_PAYMENT: ['CUSTOMER'], ACCEPTANCE: ['CUSTOMER'], CANCELLED: ['ADMIN'] },
  AWAITING_PAYMENT:       { ACCEPTANCE: ['SYSTEM', 'ADMIN'] },
  ACCEPTANCE:             { RECONCILIATION: ['CUSTOMER'] },
  RECONCILIATION:         { COMPLETED: ['ADMIN'] },
  COMPLETED:              { CLOSED: ['ADMIN'] },
  CLOSED:                 {},
  CANCELLED:              {},
};
const TRANSITIONS = Object.fromEntries(Object.entries(EDGES).map(([from, to]) => [from, Object.keys(to)]));

const ACTORS = {
  CUSTOMER: 'Khách hàng', SALES: 'Sales', ACCOUNT: 'Account', PM: 'PM', PROJECT: 'Project', ADMIN: 'M&T', SYSTEM: 'Hệ thống',
};

// Từ các trạng thái này trở đi, hủy là thỏa thuận chấm dứt: chỉ M&T thực hiện, bắt buộc ghi lý do
const ADMIN_ONLY_CANCEL = ['DEPOSITED', 'MATCHING', 'PENDING_MATCH_APPROVAL', 'IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Các bên mà người này đại diện trong Order (khách, M&T, vai trò freelancer đang giữ) */
function actorRoles(order, actor) {
  if (!actor) return [];
  if (actor.kind === 'admin') return ['ADMIN'];
  const roles = db.all("SELECT role FROM order_assignments WHERE order_id = ? AND user_id = ? AND status IN ('ACCEPTED','LOCKED')", order.id, actor.id)
    .map((r) => r.role);
  if (order.customer_id === actor.id) roles.push('CUSTOMER');
  return roles;
}

/** Người này có quyền chuyển Order sang `to` không (chỉ xét quyền, chưa xét điều kiện nghiệp vụ) */
function permitted(order, actor, to) {
  const allowed = EDGES[order.status]?.[to] || [];
  return actorRoles(order, actor).some((r) => allowed.includes(r));
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
    case 'REJECTED':
      if (actor?.kind === 'admin' && !note) fail('Cần ghi lý do M&T từ chối cung cấp dịch vụ');
      break;
    case 'CONSULTING':
      // M&T đã từ chối cung cấp dịch vụ thì chỉ M&T mới mở lại được
      if (order.status === 'REJECTED' && actor?.kind !== 'admin') {
        const last = db.get(
          "SELECT u.kind FROM status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.entity = 'order' AND h.entity_id = ? AND h.to_status = 'REJECTED' ORDER BY h.id DESC LIMIT 1",
          order.id,
        );
        if (last?.kind === 'admin') fail('M&T đã từ chối cung cấp dịch vụ cho Order này — chỉ M&T mở lại được', 403);
      }
      break;
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
      const n = (sql) => db.get(sql, order.id).n;
      if (n("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'CONFIRMED'")) fail('Còn khoản thu chưa đối soát');
      if (n("SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND status = 'DECLARED'")) fail('Còn khoản khách báo chuyển chưa được xác nhận');
      if (n("SELECT COUNT(*) AS n FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'")) fail('Còn hoa hồng chờ freelancer và M&T duyệt');
      if (n("SELECT COUNT(*) AS n FROM disputes WHERE order_id = ? AND status = 'OPEN'")) fail('Còn tranh chấp / khiếu nại chưa xử lý');
      break;
    }
    case 'CANCELLED':
      if (ADMIN_ONLY_CANCEL.includes(order.status) && !note) fail('Cần nhập lý do hủy');
      break;
  }
}

/**
 * Chuyển trạng thái Order. Thứ tự kiểm tra: có cạnh chuyển không → người thao tác có quyền không → điều kiện nghiệp vụ.
 * opts.auto: bước tự động do hệ thống thực hiện ngay sau một thao tác hợp lệ (vd. đủ cọc → Đã cọc)
 */
function transition(orderId, to, actorId, note, { auto = false, data } = {}) {
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!order) fail('Không tìm thấy Order', 404);
    const fromLabel = ORDER_STATUS[order.status].label;
    const toLabel = ORDER_STATUS[to]?.label || to;
    if (!canTransition(order.status, to)) fail(`Không thể chuyển từ "${fromLabel}" sang "${toLabel}"`);
    const actor = actorId ? db.get('SELECT id, kind FROM users WHERE id = ?', actorId) : null;
    const allowed = EDGES[order.status][to];
    if (auto ? !allowed.includes('SYSTEM') : !permitted(order, actor, to)) {
      fail(`Bạn không có quyền chuyển Order từ "${fromLabel}" sang "${toLabel}" (chỉ ${allowed.map((r) => ACTORS[r]).join(', ')})`, 403);
    }
    guard(order, to, actor, note);
    db.run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", to, orderId);
    if (to === 'PENDING_INTAKE') db.run("UPDATE orders SET submitted_at = datetime('now') WHERE id = ?", orderId);
    history('order', orderId, { orderId, from: order.status, to, actorId, reason: note, data: auto ? { ...data, auto: true } : data });
    audit(actorId, 'order.transition', 'order', orderId, { before: { status: order.status }, after: { status: to }, reason: note });
    const link = `/orders/${orderId}`;
    if (order.customer_id !== actorId) notify(order.customer_id, `${order.code}: ${toLabel}`, link);
    for (const a of db.all("SELECT DISTINCT user_id FROM order_assignments WHERE order_id = ? AND status IN ('ACCEPTED','LOCKED')", orderId)) {
      if (a.user_id !== actorId) notify(a.user_id, `${order.code}: ${toLabel}`, link);
    }
    if (['PENDING_MATCH_APPROVAL', 'RECONCILIATION', 'ACCEPTANCE'].includes(to)) notifyAdmins(`${order.code}: ${toLabel}`, link);
    return { ...order, status: to };
  });
}

module.exports = { EDGES, TRANSITIONS, ACTORS, ADMIN_ONLY_CANCEL, canTransition, actorRoles, permitted, transition };
