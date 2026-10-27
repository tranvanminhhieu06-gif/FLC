'use strict';
const db = require('../db');
const { fail, audit, notify, notifyAdmins, nextCode } = require('./core');
const password = require('../lib/password');
const { FREELANCER_ROLES } = require('../lib/labels');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^(0|\+84)\d{9,10}$/;
const MEMBER_RE = /^[A-Za-z0-9_.-]{3,32}$/;

function normPhone(p) { return p ? String(p).replace(/[\s.-]/g, '') : null; }
function normEmail(e) { return e ? String(e).trim().toLowerCase() : null; }

function checkCredentials({ email, phone, pass }) {
  const errors = {};
  if (!email && !phone) errors.email = 'Cần Gmail hoặc số điện thoại';
  if (email && !EMAIL_RE.test(email)) errors.email = 'Email không hợp lệ';
  if (phone && !PHONE_RE.test(phone)) errors.phone = 'Số điện thoại không hợp lệ (VD: 0912345678)';
  if (!password.isStrong(pass)) errors.password = 'Mật khẩu tối thiểu 8 ký tự, gồm chữ và số';
  if (email && db.get('SELECT 1 FROM users WHERE email = ?', email)) errors.email = 'Email đã được đăng ký';
  if (phone && db.get('SELECT 1 FROM users WHERE phone = ?', phone)) errors.phone = 'Số điện thoại đã được đăng ký';
  return errors;
}

/** Bước 1 — Customer: SĐT/Gmail + mật khẩu (+ mã người giới thiệu nếu có) */
function registerCustomer(input) {
  const email = normEmail(input.email);
  const phone = normPhone(input.phone);
  const errors = checkCredentials({ email, phone, pass: input.password });
  if (input.password !== input.password2) errors.password2 = 'Mật khẩu nhập lại không khớp';
  let referrer = null;
  if (input.referrer_code) {
    referrer = db.get(
      "SELECT u.id FROM freelancer_profiles f JOIN users u ON u.id = f.user_id JOIN user_roles r ON r.user_id = u.id AND r.role = 'REFERRER' AND r.status = 'ACTIVE' WHERE lower(f.member_code) = lower(?) OR u.code = upper(?)",
      input.referrer_code.trim(), input.referrer_code.trim(),
    );
    if (!referrer) errors.referrer_code = 'Mã người giới thiệu không tồn tại hoặc chưa được kích hoạt';
  }
  if (Object.keys(errors).length) return { errors };
  return db.tx(() => {
    const code = nextCode('CUS');
    const r = db.run(
      'INSERT INTO users (code, kind, email, phone, password_hash, full_name) VALUES (?, \'customer\', ?, ?, ?, ?)',
      code, email, phone, password.hash(input.password), input.full_name || null,
    );
    const id = r.lastInsertRowid;
    db.run('INSERT INTO customer_profiles (user_id, company, tax_code, address, referrer_code, referrer_id) VALUES (?, ?, ?, ?, ?, ?)',
      id, input.company, input.tax_code, input.address, input.referrer_code || null, referrer?.id);
    if (referrer) {
      const contact = email || phone;
      const lead = db.get("SELECT id FROM leads WHERE referrer_id = ? AND customer_id IS NULL AND (contact = ? OR contact = ?) LIMIT 1", referrer.id, email, phone);
      if (lead) db.run("UPDATE leads SET status = 'CONVERTED', customer_id = ? WHERE id = ?", id, lead.id);
      else db.run("INSERT INTO leads (referrer_id, name, contact, status, customer_id) VALUES (?, ?, ?, 'CONVERTED', ?)", referrer.id, input.full_name || code, contact, id);
      notify(referrer.id, `Khách hàng mới đăng ký bằng mã của bạn: ${code}`, '/fl/referrals');
    }
    audit(id, 'user.register', 'user', id, { after: { code, kind: 'customer' } });
    notifyAdmins(`Tài khoản khách hàng mới chờ duyệt: ${code}`, `/admin/accounts/${id}`);
    return { id, code };
  });
}

/** Bước 1 — Freelancer: hồ sơ đầy đủ + chọn một hoặc nhiều vai trò */
function registerFreelancer(input, files) {
  const email = normEmail(input.email);
  const phone = normPhone(input.phone);
  const errors = checkCredentials({ email, phone, pass: input.password });
  if (!email) errors.email = 'Freelancer cần Gmail';
  if (!phone) errors.phone = 'Freelancer cần số điện thoại';
  if (input.password !== input.password2) errors.password2 = 'Mật khẩu nhập lại không khớp';
  if (!input.full_name) errors.full_name = 'Cần họ và tên';
  if (!input.dob) errors.dob = 'Cần ngày sinh';
  if (!MEMBER_RE.test(input.member_code || '')) errors.member_code = '3–32 ký tự: chữ, số, dấu . _ -';
  else if (db.get('SELECT 1 FROM freelancer_profiles WHERE lower(member_code) = lower(?)', input.member_code)) errors.member_code = 'Mã thành viên đã có người dùng';
  if (!input.bank_account || !input.bank_name) errors.bank_account = 'Cần ngân hàng và số tài khoản';
  const roles = [].concat(input.roles || []).filter((r) => FREELANCER_ROLES.includes(r));
  if (!roles.length) errors.roles = 'Chọn ít nhất một vai trò';
  if (!files.cv) errors.cv = 'Cần tải lên CV';
  if (!files.id_front || !files.id_back) errors.id_front = 'Cần ảnh CCCD mặt trước và mặt sau';
  if (Object.keys(errors).length) return { errors };
  return db.tx(() => {
    const code = nextCode('FL');
    const r = db.run(
      "INSERT INTO users (code, kind, email, phone, password_hash, full_name) VALUES (?, 'freelancer', ?, ?, ?, ?)",
      code, email, phone, password.hash(input.password), input.full_name,
    );
    const id = r.lastInsertRowid;
    db.run(
      `INSERT INTO freelancer_profiles (user_id, dob, member_code, skills, experience, portfolio, service_types, bank_name, bank_account, bank_holder, cv_file, id_front_file, id_back_file)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.dob, input.member_code, input.skills, input.experience, input.portfolio,
      [].concat(input.service_types || []).join(', '), input.bank_name, input.bank_account, input.bank_holder || input.full_name,
      files.cv.path, files.id_front.path, files.id_back.path,
    );
    for (const role of roles) db.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', id, role);
    audit(id, 'user.register', 'user', id, { after: { code, kind: 'freelancer', roles } });
    notifyAdmins(`Hồ sơ freelancer mới chờ duyệt: ${code} (${roles.join(', ')})`, `/admin/accounts/${id}`);
    return { id, code };
  });
}

function login(identifier, pass) {
  const id = String(identifier || '').trim();
  const user = db.get('SELECT * FROM users WHERE email = ? OR phone = ?', normEmail(id), normPhone(id));
  if (!user || !password.verify(pass || '', user.password_hash)) return null;
  return user;
}

/** Bước 2 — M&T duyệt / yêu cầu bổ sung / từ chối / tạm dừng; gán vai trò */
function review(userId, adminId, { decision, note, roles }) {
  const map = { approve: 'ACTIVE', info: 'NEEDS_INFO', reject: 'REJECTED', suspend: 'SUSPENDED' };
  const status = map[decision];
  if (!status) fail('Quyết định không hợp lệ');
  if (decision !== 'approve' && !note) fail('Cần ghi lý do để người dùng biết');
  db.tx(() => {
    const u = db.get('SELECT * FROM users WHERE id = ?', userId);
    if (!u || u.kind === 'admin') fail('Không tìm thấy tài khoản', 404);
    db.run("UPDATE users SET status = ?, status_note = ?, approved_by = ?, approved_at = datetime('now') WHERE id = ?", status, note || null, adminId, userId);
    if (u.kind === 'freelancer') {
      const granted = new Set([].concat(roles || []));
      if (decision === 'approve' && !granted.size) fail('Cần gán ít nhất một vai trò khi duyệt freelancer');
      for (const r of db.all('SELECT role, status FROM user_roles WHERE user_id = ?', userId)) {
        const next = decision === 'approve' ? (granted.has(r.role) ? 'ACTIVE' : 'REJECTED') : r.status;
        if (next !== r.status) db.run("UPDATE user_roles SET status = ?, approved_by = ?, approved_at = datetime('now') WHERE user_id = ? AND role = ?", next, adminId, userId, r.role);
      }
    }
    audit(adminId, `user.${decision}`, 'user', userId, { before: { status: u.status }, after: { status, roles }, reason: note });
    const text = { approve: 'Tài khoản đã được duyệt', info: `Cần bổ sung hồ sơ: ${note}`, reject: `Tài khoản bị từ chối: ${note}`, suspend: `Tài khoản tạm dừng: ${note}` }[decision];
    notify(userId, text, u.kind === 'freelancer' ? '/fl/profile' : '/customer/profile');
  });
}

/** Freelancer xin thêm vai trò (M&T duyệt lại) */
function requestRole(userId, role) {
  if (!FREELANCER_ROLES.includes(role)) fail('Vai trò không hợp lệ');
  const r = db.get('SELECT status FROM user_roles WHERE user_id = ? AND role = ?', userId, role);
  if (r?.status === 'ACTIVE' || r?.status === 'PENDING') fail('Vai trò này đã có hoặc đang chờ duyệt');
  if (r) db.run("UPDATE user_roles SET status = 'PENDING' WHERE user_id = ? AND role = ?", userId, role);
  else db.run('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', userId, role);
  notifyAdmins(`Freelancer xin thêm vai trò ${role}`, `/admin/accounts/${userId}`);
}

module.exports = { registerCustomer, registerFreelancer, login, review, requestRole, normEmail, normPhone };
