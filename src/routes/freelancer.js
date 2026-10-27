'use strict';
const express = require('express');
const db = require('../db');
const assignment = require('../services/assignment');
const commission = require('../services/commission');
const accounts = require('../services/accounts');
const revenue = require('../services/revenue');
const fmt = require('../lib/fmt');
const { DEFAULT_VAT_PCT } = require('../lib/labels');
const { fail, notifyAdmins } = require('../services/core');
const { requireKind, requireActive, act } = require('../middleware');

const router = express.Router();
router.use(requireKind('freelancer'));

router.get('/', (req, res) => {
  const u = req.user;
  const myOrders = db.all(
    `SELECT o.id, o.code, o.title, o.status, o.deadline, group_concat(a.role, ', ') AS roles
       FROM order_assignments a JOIN orders o ON o.id = a.order_id
      WHERE a.user_id = ? AND a.status IN ('ACCEPTED','LOCKED') AND o.status NOT IN ('CLOSED','CANCELLED')
      GROUP BY o.id ORDER BY o.updated_at DESC`, u.id,
  );
  const invitations = db.get("SELECT COUNT(*) AS n FROM order_assignments a JOIN orders o ON o.id = a.order_id WHERE a.user_id = ? AND a.status = 'INVITED' AND o.status = 'MATCHING'", u.id).n;
  const earn = db.get(
    `SELECT COALESCE(SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN amount END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status = 'APPROVED' THEN amount END), 0) AS approved,
            COALESCE(SUM(CASE WHEN status = 'PAID' THEN amount END), 0) AS paid
       FROM commissions WHERE user_id = ?`, u.id,
  );
  const estimate = revenue.forUser(u.id).totals.remaining;
  const tasks = db.all(
    "SELECT t.*, o.code FROM tasks t JOIN orders o ON o.id = t.order_id WHERE t.assignee_id = ? AND t.status <> 'DONE' AND o.status NOT IN ('CLOSED','CANCELLED') ORDER BY t.due_date IS NULL, t.due_date LIMIT 8", u.id,
  );
  res.render('freelancer/dashboard', { title: 'Tổng quan · Freelancer', myOrders, invitations, earn, estimate, tasks });
});

router.get('/opportunities', requireActive, (req, res) => {
  const roles = new Set(req.user.roles);
  const intake = roles.has('SALES')
    ? db.all("SELECT o.*, u.code AS customer_code FROM orders o JOIN users u ON u.id = o.customer_id WHERE o.status = 'PENDING_INTAKE' ORDER BY o.submitted_at")
    : [];
  const needAccount = roles.has('ACCOUNT')
    ? db.all(`SELECT o.* FROM orders o WHERE o.status IN ('CONSULTING','QUOTED','REJECTED','CONTRACT_SIGNED','AWAITING_DEPOSIT','DEPOSITED','MATCHING')
               AND NOT EXISTS (SELECT 1 FROM order_assignments a WHERE a.order_id = o.id AND a.role = 'ACCOUNT' AND a.status IN ('ACCEPTED','LOCKED'))
             ORDER BY o.updated_at`)
    : [];
  res.render('freelancer/opportunities', { title: 'Cơ hội', intake, needAccount });
});

router.post('/opportunities/:id/claim', requireActive, act((req) => {
  const id = Number(req.params.id);
  if (req.body.role === 'SALES') assignment.claimIntake(id, req.user.id);
  else if (req.body.role === 'ACCOUNT') assignment.claimAccount(id, req.user.id);
  else fail('Vai trò không hợp lệ');
  return `/orders/${id}`;
}, 'Đã nhận Order'));

router.get('/invitations', requireActive, (req, res) => {
  const list = db.all(
    `SELECT a.*, o.code, o.title, o.service_type, o.deadline, o.description, o.status AS order_status, c.value,
            inv.full_name AS inviter
       FROM order_assignments a JOIN orders o ON o.id = a.order_id
       LEFT JOIN contracts c ON c.order_id = o.id LEFT JOIN users inv ON inv.id = a.invited_by
      WHERE a.user_id = ? AND a.status IN ('INVITED','DECLINED','EXPIRED') ORDER BY a.status = 'INVITED' DESC, a.id DESC LIMIT 50`, req.user.id,
  );
  const policy = commission.activePolicy().rates;
  res.render('freelancer/invitations', { title: 'Lời mời', list, policy });
});

router.post('/invitations/:id', requireActive, act((req) => {
  const r = assignment.respond(Number(req.params.id), req.user.id, req.body.accept === '1');
  if (r.lost) fail('Rất tiếc, vị trí này đã có người nhận trước.');
  return '/fl/invitations';
}, (req) => (req.body.accept === '1' ? 'Đã nhận việc — chờ M&T khóa phương án' : 'Đã từ chối lời mời')));

router.get('/earnings', (req, res) => {
  const lines = db.all(
    `SELECT c.*, o.code, o.title, p.kind AS payment_kind, p.confirmed_at FROM commissions c
       JOIN orders o ON o.id = c.order_id JOIN payments p ON p.id = c.payment_id
      WHERE c.user_id = ? ORDER BY c.id DESC`, req.user.id,
  );
  const payouts = db.all('SELECT * FROM payouts WHERE user_id = ? ORDER BY id DESC', req.user.id);
  res.render('freelancer/earnings', { title: 'Sổ hoa hồng', lines, payouts });
});

/** Doanh thu & dự án đã nhận + bộ tính tự động (form GET hoạt động cả khi tắt JS) */
router.get('/revenue', (req, res) => {
  const data = revenue.forUser(req.user.id);
  const devId = commission.devUserId();
  const myRoles = [...req.user.roles, ...(devId === req.user.id ? ['DEV'] : [])];
  const q = req.query;
  const submitted = q.gross !== undefined;
  const money = (v) => fmt.parseMoney(v) || 0;
  const sampleValue = data.rows.find((r) => r.value && !['CLOSED', 'CANCELLED'].includes(r.status))?.value || 10_000_000;
  const input = {
    gross: submitted ? money(q.gross) : sampleValue,
    discount: money(q.discount), allowance: money(q.allowance), returns: money(q.returns),
    vatPct: submitted && q.vat_pct !== '' ? Math.max(0, Number(q.vat_pct) || 0) : DEFAULT_VAT_PCT,
    vatIncluded: submitted ? q.vat_included === '1' : true,
    excise: money(q.excise), exportTax: money(q.export_tax),
  };
  const opts = {
    hasReferrer: submitted ? q.has_referrer === '1' : true,
    hasPm: submitted ? q.has_pm === '1' : true,
    hasDev: !!devId,
  };
  const myShare = Math.min(100, Math.max(1, Number(q.my_share) || 100));
  const sim = revenue.simulate({ input, rates: data.policy, myRoles, myShareBp: Math.round(myShare * 100), ...opts });
  res.render('freelancer/revenue', {
    title: 'Doanh thu & dự án', data, sim, groups: revenue.byRole(sim.lines), input, opts, myRoles, myShare,
    devName: devId ? db.get('SELECT full_name FROM users WHERE id = ?', devId).full_name : null,
    // Dữ liệu cho bộ tính trên trình duyệt (JSON trong thẻ script không chạy, an toàn với CSP)
    calcJson: JSON.stringify({ rates: data.policy, myRoles, hasDev: opts.hasDev }).replace(/</g, '\\u003c'),
  });
});

router.get('/referrals', requireActive, (req, res) => {
  if (!req.user.roles.includes('REFERRER')) return res.redirect('/fl');
  const profile = db.get('SELECT member_code FROM freelancer_profiles WHERE user_id = ?', req.user.id);
  const leads = db.all(
    `SELECT l.*, u.code AS customer_code,
            (SELECT group_concat(o.code || ':' || o.status) FROM orders o WHERE o.customer_id = l.customer_id) AS orders
       FROM leads l LEFT JOIN users u ON u.id = l.customer_id WHERE l.referrer_id = ? ORDER BY l.id DESC`, req.user.id,
  );
  res.render('freelancer/referrals', { title: 'Giới thiệu khách hàng', leads, memberCode: profile.member_code });
});

router.post('/referrals', requireActive, act((req) => {
  if (!req.user.roles.includes('REFERRER')) fail('Bạn chưa có vai trò Referrer', 403);
  if (!req.body.name || !req.body.contact) fail('Cần tên và thông tin liên hệ của khách');
  db.run('INSERT INTO leads (referrer_id, name, contact, need) VALUES (?, ?, ?, ?)', req.user.id, req.body.name, req.body.contact, req.body.need);
  return '/fl/referrals';
}, 'Đã ghi nhận khách hàng tiềm năng'));

router.post('/referrals/:id/status', requireActive, act((req) => {
  if (!['NEW', 'CONTACTED', 'LOST'].includes(req.body.status)) fail('Trạng thái không hợp lệ');
  db.run("UPDATE leads SET status = ? WHERE id = ? AND referrer_id = ? AND status <> 'CONVERTED'", req.body.status, Number(req.params.id), req.user.id);
  return '/fl/referrals';
}));

router.get('/profile', (req, res) => {
  const profile = db.get('SELECT * FROM freelancer_profiles WHERE user_id = ?', req.user.id);
  res.render('freelancer/profile', { title: 'Hồ sơ năng lực', profile });
});

router.post('/profile', act((req) => {
  db.run('UPDATE freelancer_profiles SET skills = ?, experience = ?, portfolio = ?, availability = ? WHERE user_id = ?',
    req.body.skills, req.body.experience, req.body.portfolio,
    ['AVAILABLE', 'BUSY', 'AWAY'].includes(req.body.availability) ? req.body.availability : 'AVAILABLE', req.user.id);
  if (req.user.status === 'NEEDS_INFO') {
    db.run("UPDATE users SET status = 'PENDING' WHERE id = ?", req.user.id);
    notifyAdmins(`${req.user.code} đã bổ sung hồ sơ`, `/admin/accounts/${req.user.id}`);
  }
  return '/fl/profile';
}, 'Đã cập nhật hồ sơ'));

router.post('/roles', requireActive, act((req) => {
  accounts.requestRole(req.user.id, req.body.role);
  return '/fl/profile';
}, 'Đã gửi yêu cầu thêm vai trò'));

module.exports = router;
