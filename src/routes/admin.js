'use strict';
const express = require('express');
const db = require('../db');
const accounts = require('../services/accounts');
const assignment = require('../services/assignment');
const finance = require('../services/finance');
const commission = require('../services/commission');
const flow = require('../services/orderFlow');
const orders = require('../services/orders');
const reports = require('../services/reports');
const fmt = require('../lib/fmt');
const { fail } = require('../services/core');
const { ROLES } = require('../lib/labels');
const { requireKind, act } = require('../middleware');

const router = express.Router();
router.use(requireKind('admin'));

const RATE_KEYS = ['REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT', 'MT'];
/** Form nhập % (có thể thập phân) → basis point */
const readRates = (body) => Object.fromEntries(RATE_KEYS.map((k) => [k, Math.round(Number(String(body[`rate_${k}`] ?? '').replace(',', '.')) * 100)]));

router.get('/', (req, res) => {
  const range = ['30', '90', '365'].includes(req.query.range) ? Number(req.query.range) : 90;
  res.render('admin/dashboard', { title: 'Bảng điều khiển M&T', range, d: reports.dashboard(range) });
});

/* ---------- Tài khoản ---------- */

router.get('/accounts', (req, res) => {
  const status = ['PENDING', 'NEEDS_INFO', 'ACTIVE', 'REJECTED', 'SUSPENDED'].includes(req.query.status) ? req.query.status : 'PENDING';
  const kind = ['customer', 'freelancer'].includes(req.query.kind) ? req.query.kind : null;
  const list = db.all(
    `SELECT u.*, (SELECT group_concat(role || ':' || status) FROM user_roles WHERE user_id = u.id) AS roles,
            f.member_code, c.company
       FROM users u LEFT JOIN freelancer_profiles f ON f.user_id = u.id LEFT JOIN customer_profiles c ON c.user_id = u.id
      WHERE u.kind <> 'admin' AND (u.status = ? OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.status = 'PENDING' AND ? = 'PENDING'))
        AND (? IS NULL OR u.kind = ?)
      ORDER BY u.id DESC`, status, status, kind, kind,
  );
  const counts = Object.fromEntries(db.all("SELECT status, COUNT(*) AS n FROM users WHERE kind <> 'admin' GROUP BY status").map((r) => [r.status, r.n]));
  res.render('admin/accounts', { title: 'Duyệt tài khoản', list, status, kind, counts });
});

router.get('/accounts/:id', (req, res) => {
  const u = db.get("SELECT * FROM users WHERE id = ? AND kind <> 'admin'", Number(req.params.id));
  if (!u) return res.redirect('/admin/accounts');
  const roles = db.all('SELECT * FROM user_roles WHERE user_id = ?', u.id);
  const fl = db.get('SELECT * FROM freelancer_profiles WHERE user_id = ?', u.id);
  const cu = db.get('SELECT c.*, r.code AS referrer_user_code FROM customer_profiles c LEFT JOIN users r ON r.id = c.referrer_id WHERE c.user_id = ?', u.id);
  const history = db.all("SELECT a.*, x.code AS actor_code FROM audit_logs a LEFT JOIN users x ON x.id = a.actor_id WHERE a.entity = 'user' AND a.entity_id = ? ORDER BY a.id DESC", u.id);
  const orderRows = u.kind === 'customer'
    ? db.all('SELECT id, code, title, status FROM orders WHERE customer_id = ? ORDER BY id DESC', u.id)
    : db.all("SELECT o.id, o.code, o.title, o.status, a.role, a.status AS a_status FROM order_assignments a JOIN orders o ON o.id = a.order_id WHERE a.user_id = ? ORDER BY a.id DESC", u.id);
  res.render('admin/account-detail', { title: `Hồ sơ ${u.code}`, u, roles, fl, cu, history, orderRows });
});

router.post('/accounts/:id/review', act((req) => {
  accounts.review(Number(req.params.id), req.user.id, { decision: req.body.decision, note: req.body.note, roles: req.body.roles });
  return `/admin/accounts/${req.params.id}`;
}, 'Đã cập nhật trạng thái tài khoản'));

/* ---------- Order ---------- */

router.get('/orders', (req, res) => {
  const status = req.query.status || '';
  const q = (req.query.q || '').trim();
  const list = db.all(
    `SELECT o.*, u.code AS customer_code, c.value,
            (SELECT u2.code FROM order_assignments a JOIN users u2 ON u2.id = a.user_id WHERE a.order_id = o.id AND a.role = 'ACCOUNT' AND a.status IN ('ACCEPTED','LOCKED')) AS account_code,
            (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id = o.id AND p.confirmed_at IS NOT NULL) AS collected
       FROM orders o JOIN users u ON u.id = o.customer_id LEFT JOIN contracts c ON c.order_id = o.id
      WHERE (? = '' OR o.status = ?) AND (? = '' OR o.code LIKE ? OR o.title LIKE ? OR u.code LIKE ?)
      ORDER BY o.updated_at DESC LIMIT 300`, status, status, q, `%${q}%`, `%${q}%`, `%${q}%`,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status').map((r) => [r.status, r.n]));
  res.render('admin/orders', { title: 'Quản lý Order', list, status, q, counts });
});

const orderAct = (path, fn, msg) => router.post(`/orders/:id/${path}`, act((req) => {
  const id = Number(req.params.id);
  fn(req, id);
  return `/orders/${id}`;
}, msg));

orderAct('approve-plan', (req, id) => assignment.approvePlan(id, req.user.id, readRates(req.body)), 'Đã duyệt — nhân sự và tỷ lệ đã được khóa, nhóm làm việc đã tạo');
orderAct('return-plan', (req, id) => assignment.returnPlan(id, req.user.id, req.body.note), 'Đã trả phương án về Account');
orderAct('deposit-exception', (req, id) => orders.depositException(id, req.user.id, req.body.reason), 'Đã phê duyệt ngoại lệ đặt cọc');
orderAct('reconcile', (req, id) => {
  const n = commission.reconcile({ orderId: id, adminId: req.user.id });
  if (!n) fail('Không có dòng nào được tạo');
}, 'Đã đối soát và tạo các dòng hoa hồng chờ duyệt');
orderAct('complete', (req, id) => flow.transition(id, 'COMPLETED', req.user.id, 'M&T xác nhận hoàn tất đối soát'), 'Order đã hoàn tất');
orderAct('close', (req, id) => flow.transition(id, 'CLOSED', req.user.id, 'Đóng Order — thu hồi quyền truy cập workspace của freelancer'), 'Đã đóng Order');
orderAct('assign', (req, id) => {
  if (!ROLES[req.body.role] || req.body.role === 'MT') fail('Vai trò không hợp lệ');
  if (!req.body.reason) fail('Cần lý do khi M&T phân công trực tiếp');
  assignment.adminAssign(id, req.user.id, Number(req.body.user_id), req.body.role, Math.round(Number(req.body.share_pct || 100) * 100), req.body.reason);
}, 'Đã phân công');
orderAct('assignments/:aid/revoke', (req, id) => {
  const a = db.get('SELECT order_id FROM order_assignments WHERE id = ?', Number(req.params.aid));
  if (a?.order_id !== id) fail('Phân công không thuộc Order này');
  assignment.revoke(Number(req.params.aid), req.user.id, req.body.reason);
}, 'Đã thu hồi phân công');
orderAct('allocations', (req, id) => commission.adjustAllocations({ orderId: id, adminId: req.user.id, rates: readRates(req.body), reason: req.body.reason }), 'Đã điều chỉnh tỷ lệ (áp dụng cho các đợt chưa đối soát)');
orderAct('refund', (req, id) => finance.recordRefund({ orderId: id, adminId: req.user.id, amount: fmt.parseMoney(req.body.amount), tax: fmt.parseMoney(req.body.tax) || 0, deductions: fmt.parseMoney(req.body.deductions) || 0, reason: req.body.reason }), 'Đã ghi nhận hoàn tiền');
orderAct('record-payment', (req, id) => {
  const pid = finance.declarePayment({ orderId: id, actorId: req.user.id, kind: req.body.kind, amount: fmt.parseMoney(req.body.amount), method: req.body.method, ref: req.body.ref, note: 'M&T ghi nhận trực tiếp' });
  finance.confirmPayment({ paymentId: pid, adminId: req.user.id, tax: fmt.parseMoney(req.body.tax) || 0, deductions: fmt.parseMoney(req.body.deductions) || 0 });
}, 'Đã ghi nhận và xác nhận khoản thu');

/* ---------- Tài chính ---------- */

router.get('/finance', (req, res) => {
  const pendingPayments = db.all(
    `SELECT p.*, o.code, o.title, c.value, c.deposit_amount, u.code AS customer_code FROM payments p
       JOIN orders o ON o.id = p.order_id JOIN users u ON u.id = o.customer_id LEFT JOIN contracts c ON c.order_id = o.id
      WHERE p.confirmed_at IS NULL AND p.rejected = 0 ORDER BY p.id`,
  );
  const toReconcile = db.all(
    `SELECT o.id, o.code, o.title, o.status, COUNT(p.id) AS n, SUM(p.amount - p.tax - p.deductions) AS net
       FROM payments p JOIN orders o ON o.id = p.order_id
      WHERE p.confirmed_at IS NOT NULL AND p.reconciled = 0 AND EXISTS (SELECT 1 FROM revenue_allocations r WHERE r.order_id = o.id)
      GROUP BY o.id ORDER BY o.id`,
  );
  const pendingCommissions = db.all(
    `SELECT c.*, o.code, u.code AS user_code, u.full_name FROM commissions c
       JOIN orders o ON o.id = c.order_id JOIN users u ON u.id = c.user_id
      WHERE c.status = 'PENDING_APPROVAL' ORDER BY c.order_id, c.payment_id, c.role`,
  );
  const payable = db.all(
    `SELECT u.id, u.code, u.full_name, f.bank_name, f.bank_account, f.bank_holder, SUM(c.amount) AS total, COUNT(*) AS n
       FROM commissions c JOIN users u ON u.id = c.user_id JOIN freelancer_profiles f ON f.user_id = u.id
      WHERE c.status = 'APPROVED' AND c.payout_id IS NULL GROUP BY u.id HAVING total > 0 ORDER BY total DESC`,
  );
  const payouts = db.all('SELECT p.*, u.code, u.full_name FROM payouts p JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 30');
  res.render('admin/finance', { title: 'Tài chính & đối soát', pendingPayments, toReconcile, pendingCommissions, payable, payouts });
});

router.post('/payments/:id/confirm', act((req) => {
  finance.confirmPayment({
    paymentId: Number(req.params.id), adminId: req.user.id, amount: fmt.parseMoney(req.body.amount),
    tax: fmt.parseMoney(req.body.tax) || 0, deductions: fmt.parseMoney(req.body.deductions) || 0,
  });
}, 'Đã xác nhận thực thu'));
router.post('/payments/:id/reject', act((req) => finance.rejectPayment({ paymentId: Number(req.params.id), adminId: req.user.id, reason: req.body.reason }), 'Đã từ chối khoản báo chuyển'));
router.post('/commissions/approve', act((req) => {
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
  if (!ids.length) fail('Chọn ít nhất một dòng');
  commission.approve({ ids, adminId: req.user.id });
}, 'Đã duyệt hoa hồng'));
router.post('/commissions/:id/void', act((req) => commission.voidLine({ id: Number(req.params.id), adminId: req.user.id, reason: req.body.reason }), 'Đã hủy dòng hoa hồng'));
router.post('/payouts', act((req) => commission.payout({ userId: Number(req.body.user_id), adminId: req.user.id, ref: req.body.ref }), 'Đã ghi nhận chi trả'));

/* ---------- Cấu hình tỷ lệ ---------- */

router.get('/rates', (req, res) => {
  const history = db.all('SELECT p.*, u.code AS by_code FROM rate_policies p LEFT JOIN users u ON u.id = p.created_by ORDER BY p.id DESC');
  res.render('admin/rates', { title: 'Cấu hình tỷ lệ doanh thu', policy: commission.activePolicy(), history });
});
router.post('/rates', act((req) => {
  commission.setPolicy({ adminId: req.user.id, name: req.body.name || `Chính sách ${new Date().toLocaleDateString('vi-VN')}`, rates: readRates(req.body), reason: req.body.reason });
  return '/admin/rates';
}, 'Đã áp dụng chính sách mới — các Order đã khóa giữ nguyên tỷ lệ cũ'));

/* ---------- Khiếu nại ---------- */

router.get('/disputes', (req, res) => {
  const list = db.all(
    `SELECT d.*, o.code, o.title AS order_title, u.code AS by_code, u.kind AS by_kind FROM disputes d
       JOIN orders o ON o.id = d.order_id JOIN users u ON u.id = d.raised_by ORDER BY d.status = 'OPEN' DESC, d.id DESC`,
  );
  res.render('admin/disputes', { title: 'Khiếu nại & tranh chấp', list });
});
router.post('/disputes/:id', act((req) => {
  orders.resolveDispute(Number(req.params.id), req.user.id, { status: req.body.status, resolution: req.body.resolution });
  return '/admin/disputes';
}, 'Đã xử lý yêu cầu'));

/* ---------- Báo cáo & nhật ký ---------- */

router.get('/reports', (req, res) => res.render('admin/reports', { title: 'Báo cáo', r: reports.full() }));

router.get('/audit', (req, res) => {
  const entity = req.query.entity || '';
  const list = db.all(
    `SELECT a.*, u.code AS actor_code FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE (? = '' OR a.entity = ?) ORDER BY a.id DESC LIMIT 300`, entity, entity,
  );
  res.render('admin/audit', { title: 'Nhật ký hệ thống', list, entity });
});

module.exports = router;
