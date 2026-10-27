'use strict';
// Trang Order dùng chung cho mọi vai trò — nội dung và hành động hiển thị theo quyền
const express = require('express');
const db = require('../db');
const access = require('../services/access');
const orders = require('../services/orders');
const assignment = require('../services/assignment');
const finance = require('../services/finance');
const commission = require('../services/commission');
const flow = require('../services/orderFlow');
const files = require('../services/files');
const fmt = require('../lib/fmt');
const { fail } = require('../services/core');
const { requireLogin, act } = require('../middleware');

const router = express.Router();
router.use(requireLogin);

const WORKING = ['IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW'];
const CUSTOMER_CANCEL = ['DRAFT', 'PENDING_INTAKE', 'CONSULTING', 'QUOTED', 'REJECTED', 'AWAITING_DEPOSIT'];

/** Nạp Order + quyền; dừng với 404 nếu không có quyền xem */
function load(req, res, needWorkspace = false) {
  const id = Number(req.params.id);
  const acc = access.forOrder(req.user, id);
  if (!acc.any || (needWorkspace && !acc.workspace)) {
    res.status(404).render('error', { title: 'Không tìm thấy', message: 'Order không tồn tại hoặc bạn không có quyền xem.' });
    return null;
  }
  return { id, acc, order: db.get('SELECT * FROM orders WHERE id = ?', id) };
}

function capabilities(user, order, acc, fin) {
  const r = new Set(acc.roles);
  const admin = acc.isAdmin;
  const owner = acc.isCustomer;
  const coordinator = admin || r.has('ACCOUNT') || (order.needs_pm && r.has('PM'));
  const s = order.status;
  return {
    admin, owner, coordinator,
    sales: r.has('SALES'), account: r.has('ACCOUNT'), pm: r.has('PM'), project: r.has('PROJECT'),
    reviewer: acc.workspace && orders.isReviewer(order.id, user),
    editDraft: owner && s === 'DRAFT',
    quote: (admin || r.has('SALES') || r.has('ACCOUNT')) && ['CONSULTING', 'QUOTED', 'REJECTED'].includes(s),
    respondQuote: owner && s === 'QUOTED',
    payDeposit: owner && s === 'AWAITING_DEPOSIT',
    payInstallment: owner && !!fin.contract && fin.outstanding > 0 && ['DEPOSITED', 'MATCHING', 'PENDING_MATCH_APPROVAL', ...WORKING, 'AWAITING_PAYMENT'].includes(s),
    startMatching: (admin || r.has('ACCOUNT')) && s === 'DEPOSITED',
    matching: coordinator && s === 'MATCHING',
    tasks: coordinator && WORKING.includes(s),
    deliver: r.has('PROJECT') && WORKING.includes(s),
    decide: owner && ['DEMO', 'PREVIEW'].includes(s),
    signOff: owner && s === 'ACCEPTANCE',
    message: acc.workspace && !['CLOSED', 'CANCELLED'].includes(s),
    dispute: acc.workspace && !['CLOSED', 'CANCELLED', 'DRAFT'].includes(s),
    cancel: (owner && CUSTOMER_CANCEL.includes(s)) || (admin && flow.canTransition(s, 'CANCELLED')),
    seeMoney: admin || owner || r.has('SALES') || r.has('ACCOUNT'),
  };
}

router.get('/:id', (req, res) => {
  const ctx = load(req, res);
  if (!ctx) return;
  const { id, acc, order } = ctx;
  const customer = db.get('SELECT u.code, u.full_name, u.email, u.phone, u.status, p.company, p.tax_code, p.address FROM users u LEFT JOIN customer_profiles p ON p.user_id = u.id WHERE u.id = ?', order.customer_id);
  const fin = finance.summary(id);
  const can = capabilities(req.user, order, acc, fin);
  const ws = acc.workspace;
  const view = {
    title: `${order.code} · ${order.title}`,
    order, acc, can, fin, customer,
    history: db.all('SELECT h.*, u.code AS actor_code, u.full_name AS actor_name FROM order_status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.order_id = ? ORDER BY h.id DESC', id),
    assignments: db.all(
      `SELECT a.*, u.code, u.full_name, f.member_code FROM order_assignments a JOIN users u ON u.id = a.user_id
         LEFT JOIN freelancer_profiles f ON f.user_id = u.id WHERE a.order_id = ? ORDER BY a.role, a.id`, id,
    ).filter((a) => can.admin || can.coordinator || ['ACCEPTED', 'LOCKED'].includes(a.status) || a.user_id === req.user.id),
    quotes: db.all('SELECT * FROM quotes WHERE order_id = ? ORDER BY version DESC', id),
    project: db.get('SELECT * FROM projects WHERE order_id = ?', id),
    payments: can.seeMoney ? db.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', id) : [],
    tasks: ws ? db.all('SELECT t.*, u.code AS assignee_code, u.full_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.order_id = ? ORDER BY t.id', id) : [],
    deliverables: ws ? db.all(
      `SELECT d.*, u.code AS by_code FROM deliverables d JOIN users u ON u.id = d.submitted_by WHERE d.order_id = ? ${acc.isCustomer ? "AND d.review_status = 'APPROVED'" : ''} ORDER BY d.id DESC`, id,
    ) : [],
    acceptances: db.all('SELECT a.*, u.code AS actor_code FROM acceptances a JOIN users u ON u.id = a.actor_id WHERE a.order_id = ? ORDER BY a.id DESC', id),
    messages: ws ? db.all('SELECT m.*, u.code, u.full_name, u.kind FROM messages m JOIN users u ON u.id = m.user_id WHERE m.order_id = ? ORDER BY m.id', id) : [],
    attachments: ws || acc.canClaim ? db.all('SELECT * FROM attachments WHERE order_id = ?', id) : [],
    disputes: db.all(`SELECT d.*, u.code AS by_code FROM disputes d JOIN users u ON u.id = d.raised_by WHERE d.order_id = ? ${acc.isAdmin ? '' : 'AND d.raised_by = ?'} ORDER BY d.id DESC`, ...(acc.isAdmin ? [id] : [id, req.user.id])),
    allocations: commission.orderAllocations(id),
    policy: commission.activePolicy(),
    planProblems: ['MATCHING', 'PENDING_MATCH_APPROVAL'].includes(order.status) && (can.coordinator || can.admin) ? assignment.planProblems(id) : [],
    suggestions: can.matching ? { PM: assignment.suggest(id, 'PM').slice(0, 8), PROJECT: assignment.suggest(id, 'PROJECT').slice(0, 12) } : null,
    commissions: can.admin ? db.all('SELECT c.*, u.code AS user_code, u.full_name FROM commissions c LEFT JOIN users u ON u.id = c.user_id WHERE c.order_id = ? ORDER BY c.payment_id, c.role', id) : [],
    projectMembers: ws ? db.all("SELECT u.id, u.code, u.full_name FROM order_assignments a JOIN users u ON u.id = a.user_id WHERE a.order_id = ? AND a.role = 'PROJECT' AND a.status = 'LOCKED'", id) : [],
    freelancers: can.admin ? db.all("SELECT u.id, u.code, u.full_name, group_concat(r.role) AS roles FROM users u JOIN user_roles r ON r.user_id = u.id AND r.status = 'ACTIVE' WHERE u.status = 'ACTIVE' GROUP BY u.id ORDER BY u.id") : [],
    hasFinal: !!db.get("SELECT 1 FROM deliverables WHERE order_id = ? AND kind = 'final' AND review_status = 'APPROVED'", id),
  };
  res.render('order/show', view);
});

/* ---------- Hành động ---------- */

const post = (path, handler, success) => router.post(path, act((req, res) => {
  const ctx = load(req, res);
  if (!ctx) return undefined;
  return handler(req, ctx) || `/orders/${ctx.id}`;
}, success));

post('/:id/submit', (req, { id }) => orders.submitOrder(id, req.user.id), 'Đã gửi Order — Sales sẽ liên hệ bạn sớm');

post('/:id/claim', (req, { id, acc }) => {
  if (acc.canClaim === 'SALES') assignment.claimIntake(id, req.user.id);
  else if (acc.canClaim === 'ACCOUNT') assignment.claimAccount(id, req.user.id);
  else fail('Bạn không thể nhận Order này');
}, 'Đã nhận Order');

post('/:id/cancel', (req, { id, acc, order }) => {
  if (!acc.isAdmin && !(acc.isCustomer && CUSTOMER_CANCEL.includes(order.status))) fail('Không thể hủy Order ở giai đoạn này', 403);
  flow.transition(id, 'CANCELLED', req.user.id, req.body.reason || null);
}, 'Đã hủy Order');

post('/:id/quotes', (req, { id }) => {
  orders.createQuote(id, req.user, {
    amount: fmt.parseMoney(req.body.amount),
    deposit_pct: Number.parseInt(req.body.deposit_pct, 10),
    scope: req.body.scope, timeline: req.body.timeline, terms: req.body.terms,
  });
}, 'Đã gửi báo giá cho khách hàng');

post('/:id/quotes/:qid/accept', (req, { id }) => {
  const q = db.get('SELECT order_id FROM quotes WHERE id = ?', Number(req.params.qid));
  if (q?.order_id !== id) fail('Báo giá không thuộc Order này');
  orders.acceptQuote(Number(req.params.qid), req.user.id, req.body.agree === '1');
}, 'Đã ký hợp đồng — vui lòng hoàn tất đặt cọc');

post('/:id/quotes/:qid/reject', (req, { id }) => {
  const q = db.get('SELECT order_id FROM quotes WHERE id = ?', Number(req.params.qid));
  if (q?.order_id !== id) fail('Báo giá không thuộc Order này');
  orders.rejectQuote(Number(req.params.qid), req.user.id, req.body.note);
}, 'Đã gửi phản hồi từ chối báo giá');

post('/:id/payments', (req, { id, acc }) => {
  if (!acc.isCustomer) fail('Chỉ khách hàng khai báo thanh toán', 403);
  finance.declarePayment({
    orderId: id, actorId: req.user.id, kind: req.body.kind, amount: fmt.parseMoney(req.body.amount),
    method: req.body.method, ref: req.body.ref, note: req.body.note,
  });
}, 'Đã gửi thông tin chuyển khoản — chờ M&T xác nhận');

post('/:id/matching/start', (req, { id }) => assignment.startMatching(id, req.user), 'Bắt đầu ghép nhân sự');
post('/:id/matching/needs-pm', (req, { id }) => assignment.setNeedsPm(id, req.user, req.body.needs_pm === '1'), 'Đã cập nhật');
post('/:id/matching/invite', (req, { id }) => {
  const share = Math.round(Number(req.body.share_pct || 100) * 100);
  assignment.invite(id, req.user, Number(req.body.user_id), req.body.role, share);
}, 'Đã gửi lời mời');
post('/:id/assignments/:aid/share', (req, { id }) => {
  const a = db.get('SELECT order_id FROM order_assignments WHERE id = ?', Number(req.params.aid));
  if (a?.order_id !== id) fail('Phân công không thuộc Order này');
  assignment.updateShare(Number(req.params.aid), req.user, Math.round(Number(req.body.share_pct) * 100));
}, 'Đã cập nhật tỷ lệ phân công');
post('/:id/matching/submit', (req, { id }) => assignment.submitPlan(id, req.user), 'Đã gửi phương án cho M&T duyệt');

post('/:id/tasks', (req, { id }) => {
  orders.createTask(id, req.user, {
    title: req.body.title, description: req.body.description,
    assignee_id: req.body.assignee_id ? Number(req.body.assignee_id) : null, due_date: req.body.due_date,
  });
  return `/orders/${id}#tasks`;
}, 'Đã giao nhiệm vụ');
post('/:id/tasks/:tid/status', (req, { id }) => {
  const t = db.get('SELECT order_id FROM tasks WHERE id = ?', Number(req.params.tid));
  if (t?.order_id !== id) fail('Nhiệm vụ không thuộc Order này');
  if (!['TODO', 'DOING', 'DONE'].includes(req.body.status)) fail('Trạng thái không hợp lệ');
  orders.setTaskStatus(Number(req.params.tid), req.user, req.body.status);
  return `/orders/${id}#tasks`;
});

post('/:id/deliverables/:did/review', (req, { id }) => {
  const d = db.get('SELECT order_id FROM deliverables WHERE id = ?', Number(req.params.did));
  if (d?.order_id !== id) fail('Sản phẩm không thuộc Order này');
  orders.reviewDeliverable(Number(req.params.did), req.user, req.body.approve === '1', req.body.note);
  return `/orders/${id}#deliverables`;
}, 'Đã ghi nhận kết quả kiểm duyệt');

post('/:id/decision', (req, { id }) => {
  orders.customerDecision(id, req.user.id, { decision: req.body.decision, deliverable_id: Number(req.body.deliverable_id) || null, note: req.body.note });
}, 'Đã ghi nhận phản hồi nghiệm thu');
post('/:id/signoff', (req, { id }) => orders.signOff(id, req.user.id, req.body.note), 'Đã ký biên bản nghiệm thu. Cảm ơn bạn!');

/* ---------- Form có tệp (multipart): CSRF đi qua query ---------- */

const withFile = (fields, handler, success) => [
  files.receive(fields),
  act((req, res) => {
    const ctx = load(req, res, true);
    if (!ctx) return undefined;
    return handler(req, ctx) || `/orders/${ctx.id}`;
  }, success),
];

router.post('/:id/deliverables', withFile(['file'], (req, { id }) => {
  orders.submitDeliverable(id, req.user, { kind: req.body.kind, title: req.body.title, note: req.body.note, task_id: Number(req.body.task_id) || null }, files.pick(req, 'file'));
  return `/orders/${id}#deliverables`;
}, 'Đã nộp sản phẩm — chờ kiểm duyệt'));

router.post('/:id/messages', withFile(['file'], (req, { id, order }) => {
  if (['CLOSED', 'CANCELLED'].includes(order.status)) fail('Order đã đóng');
  orders.postMessage(id, req.user.id, (req.body.body || '').trim(), files.pick(req, 'file'));
  return `/orders/${id}#messages`;
}));

router.post('/:id/attachments', withFile([{ name: 'refs', maxCount: 8 }], (req, { id, acc }) => {
  if (!acc.isCustomer && !acc.isAdmin) fail('Chỉ khách hàng bổ sung tài liệu tham khảo', 403);
  for (const f of files.pickAll(req, 'refs')) orders.addAttachment(id, req.user.id, f);
}, 'Đã tải lên tài liệu'));

router.post('/:id/disputes', withFile(['evidence'], (req, { id }) => {
  const kind = ['complaint', 'refund', 'support', 'change_request'].includes(req.body.kind) ? req.body.kind : 'complaint';
  orders.raiseDispute(id, req.user.id, { kind, title: req.body.title, body: req.body.body }, files.pick(req, 'evidence'));
  return `/orders/${id}#disputes`;
}, 'Đã gửi yêu cầu tới M&T'));

module.exports = router;
