'use strict';
const express = require('express');
const db = require('../db');
const accounts = require('../services/accounts');
const files = require('../services/files');
const { flash, requireLogin, back } = require('../middleware');
const { audit } = require('../services/core');

const router = express.Router();

function home(user) {
  if (!user) return '/';
  return { admin: '/admin', freelancer: '/fl', customer: '/customer' }[user.kind];
}
/** Chỉ cho phép redirect nội bộ */
const safeNext = (n) => (typeof n === 'string' && /^\/(?!\/)/.test(n) ? n : null);

router.get('/', (req, res) => {
  const stats = db.get(
    "SELECT (SELECT COUNT(*) FROM users WHERE kind = 'freelancer' AND status = 'ACTIVE') AS freelancers, (SELECT COUNT(*) FROM orders WHERE status IN ('COMPLETED','CLOSED')) AS done",
  );
  res.render('public/home', { title: 'FLC — Nền tảng kết nối dịch vụ minh bạch', stats });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.render('public/login', { title: 'Đăng nhập · FLC', next: safeNext(req.query.next), identifier: '' });
});

router.post('/login', (req, res, next) => {
  const user = accounts.login(req.body.identifier, req.body.password);
  if (!user) {
    return res.status(401).render('public/login', {
      title: 'Đăng nhập · FLC', next: safeNext(req.body.next), identifier: req.body.identifier || '',
      error: 'Thông tin đăng nhập không đúng',
    });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.uid = user.id;
    audit(user.id, 'user.login', 'user', user.id);
    res.redirect(safeNext(req.body.next) || home(user));
  });
});

router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

router.get('/register', (req, res) => res.render('public/register-choose', { title: 'Đăng ký · FLC' }));

router.get('/register/customer', (req, res) => res.render('public/register-customer', {
  title: 'Đăng ký khách hàng · FLC', v: { referrer_code: req.query.ref || '' }, errors: {},
}));

router.post('/register/customer', (req, res, next) => {
  const result = accounts.registerCustomer(req.body);
  if (result.errors) {
    return res.status(422).render('public/register-customer', { title: 'Đăng ký khách hàng · FLC', v: req.body, errors: result.errors });
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.uid = result.id;
    flash(req, 'success', `Đăng ký thành công. Mã khách hàng của bạn: ${result.code}. M&T sẽ duyệt tài khoản để bạn gửi Order chính thức.`);
    res.redirect('/customer');
  });
});

const renderFl = (req, res, errors) => res.status(422).render('public/register-freelancer', {
  title: 'Đăng ký Freelancer · FLC', v: { ...req.body, roles: [].concat(req.body?.roles || []) }, errors,
});
// Lỗi tệp → hiển thị lại form với dữ liệu đã nhập; hồ sơ không hợp lệ → ảnh CCCD/CV bị xóa khỏi kho
const flUpload = files.receive(['cv', 'id_front', 'id_back'], { imagesOnly: ['id_front', 'id_back'] },
  (req, res, msg) => renderFl(req, res, { upload: msg }));

router.get('/register/freelancer', (req, res) => res.render('public/register-freelancer', {
  title: 'Đăng ký Freelancer · FLC', v: { roles: [] }, errors: {},
}));

router.post('/register/freelancer', flUpload, (req, res, next) => {
  const result = accounts.registerFreelancer(req.body, {
    cv: files.pick(req, 'cv'), id_front: files.pick(req, 'id_front'), id_back: files.pick(req, 'id_back'),
  });
  if (result.errors) return renderFl(req, res, result.errors);
  files.keep(req);
  req.session.regenerate((e) => {
    if (e) return next(e);
    req.session.uid = result.id;
    flash(req, 'success', `Đã gửi hồ sơ. Mã tài khoản: ${result.code}. Hồ sơ đang chờ M&T kiểm định.`);
    res.redirect('/fl/profile');
  });
});

/** Bảng trạng thái: mã cố định, tên hiển thị, ý nghĩa, ai được chuyển sang đâu */
router.get('/statuses', requireLogin, (req, res) => {
  const flow = require('../services/orderFlow');
  res.render('statuses', { title: 'Bảng trạng thái', EDGES: flow.EDGES, ACTORS: flow.ACTORS });
});

router.get('/notifications', requireLogin, (req, res) => {
  const items = db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', req.user.id);
  res.render('notifications', { title: 'Thông báo', items });
});
router.get('/notifications/:id', requireLogin, (req, res) => {
  const n = db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', Number(req.params.id), req.user.id);
  if (!n) return res.redirect('/notifications');
  db.run("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL", n.id);
  res.redirect(safeNext(n.link) || '/notifications');
});
router.post('/notifications/read-all', requireLogin, (req, res) => {
  db.run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", req.user.id);
  res.redirect(back(req, '/notifications'));
});

module.exports = router;
