'use strict';
const crypto = require('node:crypto');
const db = require('./db');
const { FlowError } = require('./services/core');
const fmt = require('./lib/fmt');
const labels = require('./lib/labels');
const { icon } = require('./lib/icons');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Badge từ một bảng nhãn trong labels.js */
function badge(map, key) {
  const item = map[key] || { label: key, tone: 'neutral' };
  return `<span class="badge ${item.tone}">${esc(item.label)}</span>`;
}

function loadUser(req, res, next) {
  if (req.session.uid) {
    const u = db.get('SELECT * FROM users WHERE id = ?', req.session.uid);
    if (!u) delete req.session.uid;
    else {
      const roles = db.all('SELECT role, status FROM user_roles WHERE user_id = ?', u.id);
      u.roles = roles.filter((r) => r.status === 'ACTIVE').map((r) => r.role);
      u.allRoles = roles;
      u.unread = db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', u.id).n;
      req.user = u;
    }
  }
  // Token CSRF chỉ được tạo khi trang thật sự có form — khách vãng lai/crawler không sinh phiên mới
  const csrfToken = () => (req.session.csrf ||= crypto.randomBytes(24).toString('hex'));
  Object.assign(res.locals, {
    user: req.user || null, csrf: csrfToken, path: req.path, fmt, L: labels, icon, esc, badge,
    flash: req.session.flash || [], title: 'FLC',
  });
  delete req.session.flash;
  next();
}

/** CSRF: form thường gửi _csrf trong body; form multipart gửi trong query (?_csrf=) vì body được parse sau */
function csrf(req, res, next) {
  if (req.method !== 'POST') return next();
  const sent = req.body?._csrf ?? req.query._csrf;
  const a = typeof sent === 'string' ? Buffer.from(sent) : null;
  const b = Buffer.from(req.session.csrf || '');
  const ok = a && b.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(403).render('error', { title: 'Phiên hết hạn', message: 'Phiên làm việc đã hết hạn. Vui lòng tải lại trang và thử lại.' });
  next();
}

/** Tài khoản bị tạm dừng/từ chối chỉ được xem, không được thao tác */
function blockInactive(req, res, next) {
  if (req.method === 'POST' && req.user && ['SUSPENDED', 'REJECTED'].includes(req.user.status) && req.path !== '/logout') {
    flash(req, 'danger', `Tài khoản đang ở trạng thái "${labels.ACCOUNT_STATUS[req.user.status].label}" nên không thể thao tác. Vui lòng liên hệ M&T.`);
    return res.redirect(back(req));
  }
  next();
}

function flash(req, type, message) {
  (req.session.flash ||= []).push({ type, message });
}

/** Quay về trang trước (chỉ cùng origin) */
function back(req, fallback = '/') {
  const ref = req.get('Referer');
  try {
    if (ref) {
      const u = new URL(ref);
      if (u.host === req.get('host')) return u.pathname + u.search + u.hash;
    }
  } catch { /* bỏ qua */ }
  return fallback;
}

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));

const requireKind = (...kinds) => (req, res, next) => {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (!kinds.includes(req.user.kind)) return res.status(403).render('error', { title: 'Không có quyền', message: 'Bạn không có quyền truy cập trang này.' });
  next();
};

const requireActive = (req, res, next) => {
  if (req.user?.status === 'ACTIVE' || req.user?.kind === 'admin') return next();
  flash(req, 'warn', 'Tài khoản của bạn đang chờ M&T duyệt — tính năng này sẽ mở sau khi được duyệt.');
  res.redirect(req.user?.kind === 'freelancer' ? '/fl/profile' : '/customer');
};

/**
 * Bọc handler POST: lỗi nghiệp vụ → flash + quay lại trang trước.
 * fn trả về đường dẫn để redirect (hoặc tự gửi response).
 */
const act = (fn, success) => (req, res, next) => {
  try {
    const to = fn(req, res);
    req.uploadKept = true; // handler thành công → tệp đã được ghi nhận
    if (res.headersSent) return;
    if (success) flash(req, 'success', typeof success === 'function' ? success(req) : success);
    res.redirect(to || back(req));
  } catch (err) {
    if (err instanceof FlowError || err.expose) {
      flash(req, 'danger', err.message);
      return res.redirect(back(req));
    }
    next(err);
  }
};

module.exports = { loadUser, csrf, blockInactive, flash, back, requireLogin, requireKind, requireActive, act, esc, badge };
