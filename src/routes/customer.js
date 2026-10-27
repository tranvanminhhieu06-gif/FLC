'use strict';
const express = require('express');
const db = require('../db');
const orders = require('../services/orders');
const files = require('../services/files');
const fmt = require('../lib/fmt');
const { SERVICE_TYPES } = require('../lib/labels');
const { requireKind, act, flash } = require('../middleware');
const { FlowError } = require('../services/core');

const router = express.Router();
router.use(requireKind('customer'));

router.get('/', (req, res) => {
  const list = db.all(
    `SELECT o.*, c.value FROM orders o LEFT JOIN contracts c ON c.order_id = o.id
      WHERE o.customer_id = ? ORDER BY o.id DESC`, req.user.id,
  );
  const stats = {
    active: list.filter((o) => !['DRAFT', 'COMPLETED', 'CLOSED', 'CANCELLED'].includes(o.status)).length,
    waiting: list.filter((o) => ['QUOTED', 'AWAITING_DEPOSIT', 'DEMO', 'PREVIEW', 'AWAITING_PAYMENT', 'ACCEPTANCE'].includes(o.status)).length,
    done: list.filter((o) => ['COMPLETED', 'CLOSED'].includes(o.status)).length,
    spent: db.get("SELECT COALESCE(SUM(p.amount),0) AS s FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.customer_id = ? AND p.confirmed_at IS NOT NULL", req.user.id).s,
  };
  res.render('customer/dashboard', { title: 'Tổng quan · Khách hàng', list, stats });
});

function readForm(body) {
  return {
    title: (body.title || '').trim(),
    service_type: body.service_type,
    description: body.description,
    goals: body.goals,
    deliverables: body.deliverables,
    budget: fmt.parseMoney(body.budget),
    deadline: body.deadline || null,
    contact_info: body.contact_info,
    invoice_info: body.invoice_info,
  };
}
function validate(data) {
  const e = {};
  if (!data.title) e.title = 'Cần tên Order';
  if (!SERVICE_TYPES.includes(data.service_type)) e.service_type = 'Chọn loại dịch vụ';
  if (!data.description) e.description = 'Mô tả yêu cầu để Sales tư vấn chính xác';
  if (data.budget != null && data.budget < 0) e.budget = 'Ngân sách không hợp lệ';
  return e;
}

const refs = files.receive([{ name: 'refs', maxCount: 8 }]);

router.get('/orders/new', (req, res) => res.render('customer/order-form', { title: 'Đăng Order', v: {}, errors: {}, order: null }));

router.post('/orders', refs, (req, res, next) => {
  const data = readForm(req.body);
  const errors = validate(data);
  if (Object.keys(errors).length) return res.status(422).render('customer/order-form', { title: 'Đăng Order', v: req.body, errors, order: null });
  let id;
  try {
    id = orders.create(req.user.id, data, false);
    for (const f of files.pickAll(req, 'refs')) orders.addAttachment(id, req.user.id, f);
    files.keep(req);
    if (req.body.intent === 'submit') orders.submitOrder(id, req.user.id);
  } catch (e) {
    if (!(e instanceof FlowError)) return next(e);
    flash(req, 'warn', `Đã lưu bản nháp. ${e.message}`);
    return res.redirect(id ? `/orders/${id}` : '/customer');
  }
  flash(req, 'success', req.body.intent === 'submit' ? 'Đã gửi Order — bộ phận Sales sẽ liên hệ bạn sớm.' : 'Đã lưu bản nháp.');
  res.redirect(`/orders/${id}`);
});

router.get('/orders/:id/edit', (req, res) => {
  const order = db.get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', Number(req.params.id), req.user.id);
  if (!order || order.status !== 'DRAFT') return res.redirect('/customer');
  res.render('customer/order-form', { title: `Sửa ${order.code}`, v: order, errors: {}, order });
});

router.post('/orders/:id', refs, (req, res, next) => {
  const id = Number(req.params.id);
  const data = readForm(req.body);
  const errors = validate(data);
  const order = db.get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', id, req.user.id);
  if (!order) return res.redirect('/customer');
  if (Object.keys(errors).length) return res.status(422).render('customer/order-form', { title: `Sửa ${order.code}`, v: req.body, errors, order });
  act(() => {
    orders.update(id, req.user.id, data);
    for (const f of files.pickAll(req, 'refs')) orders.addAttachment(id, req.user.id, f);
    if (req.body.intent === 'submit') orders.submitOrder(id, req.user.id);
    return `/orders/${id}`;
  }, req.body.intent === 'submit' ? 'Đã gửi Order' : 'Đã lưu bản nháp')(req, res, next);
});

router.get('/profile', (req, res) => {
  const profile = db.get('SELECT * FROM customer_profiles WHERE user_id = ?', req.user.id) || {};
  res.render('customer/profile', { title: 'Hồ sơ khách hàng', profile });
});

router.post('/profile', act((req) => {
  db.run('UPDATE users SET full_name = ? WHERE id = ?', req.body.full_name, req.user.id);
  db.run('UPDATE customer_profiles SET company = ?, tax_code = ?, address = ? WHERE user_id = ?',
    req.body.company, req.body.tax_code, req.body.address, req.user.id);
  return '/customer/profile';
}, 'Đã cập nhật hồ sơ'));

module.exports = router;
