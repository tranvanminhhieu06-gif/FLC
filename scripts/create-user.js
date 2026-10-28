'use strict';
/**
 * Tạo tài khoản đã duyệt sẵn (không qua form đăng ký) — dùng cho Admin đầu tiên hoặc người của M&T.
 * Mật khẩu đọc từ biến môi trường FLC_NEW_PASSWORD để không nằm trong mã nguồn hay tham số dòng lệnh.
 *
 *   FLC_NEW_PASSWORD='...' node scripts/create-user.js --kind admin --email a@x.com --name "Tên"
 *   FLC_NEW_PASSWORD='...' node scripts/create-user.js --kind freelancer --email b@x.com --name "Tên" --member ma.tv [--roles PROJECT,PM] [--dev]
 *
 *   --dev   đặt tài khoản này làm người nhận phần Coder web (thay người cũ)
 */
const db = require('../src/db');
const password = require('../src/lib/password');
const { nextCode, audit } = require('../src/services/core');
const commission = require('../src/services/commission');
const { FREELANCER_ROLES } = require('../src/lib/labels');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[a.slice(2)] = true;
  else { args[a.slice(2)] = next; i++; }
}
const die = (msg) => { console.error(`Lỗi: ${msg}`); process.exit(1); };

const kind = args.kind || 'freelancer';
const email = String(args.email || '').trim().toLowerCase();
const pass = process.env.FLC_NEW_PASSWORD;
const roles = args.roles ? String(args.roles).toUpperCase().split(',').map((r) => r.trim()).filter(Boolean) : [];

if (!['admin', 'freelancer', 'customer'].includes(kind)) die('--kind phải là admin, freelancer hoặc customer');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) die('--email không hợp lệ');
if (!args.name || args.name === true) die('Cần --name');
if (!password.isStrong(pass)) die('Đặt FLC_NEW_PASSWORD (tối thiểu 8 ký tự, gồm chữ và số)');
if (db.get('SELECT 1 FROM users WHERE lower(email) = ?', email)) die(`Email ${email} đã có tài khoản`);
if (roles.some((r) => !FREELANCER_ROLES.includes(r))) die(`--roles chỉ gồm: ${FREELANCER_ROLES.join(', ')}`);
if (kind === 'freelancer') {
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(args.member || '')) die('Freelancer cần --member (3–32 ký tự: chữ, số, . _ -)');
  if (db.get('SELECT 1 FROM freelancer_profiles WHERE lower(member_code) = lower(?)', args.member)) die('Mã thành viên đã có người dùng');
}
if (args.dev && kind !== 'freelancer') die('--dev chỉ dùng cho freelancer');

const adminId = db.get("SELECT id FROM users WHERE kind = 'admin' AND status = 'ACTIVE' ORDER BY id LIMIT 1")?.id ?? null;
const prefix = { admin: 'MT', freelancer: 'FL', customer: 'CUS' }[kind];

const user = db.tx(() => {
  const code = nextCode(prefix);
  const id = db.run(
    "INSERT INTO users (code, kind, email, password_hash, full_name, status, approved_by, approved_at) VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, datetime('now'))",
    code, kind, email, password.hash(pass), args.name, adminId,
  ).lastInsertRowid;
  if (kind === 'freelancer') {
    db.run('INSERT INTO freelancer_profiles (user_id, member_code) VALUES (?, ?)', id, args.member);
    for (const r of roles) {
      db.run("INSERT INTO user_roles (user_id, role, status, approved_by, approved_at) VALUES (?, ?, 'ACTIVE', ?, datetime('now'))", id, r, adminId);
    }
  }
  if (kind === 'customer') db.run('INSERT INTO customer_profiles (user_id) VALUES (?)', id);
  audit(adminId, 'account.create_script', 'user', id, { after: { code, kind, email, roles } });
  return { id, code };
});
if (args.dev) commission.setDevUser({ adminId, userId: user.id, reason: `Người nhận phần Coder web: ${args.name}` });

console.log(`Đã tạo ${kind} ${user.code} · ${email}${roles.length ? ' · vai trò ' + roles.join(', ') : ''}${args.dev ? ' · nhận phần Coder web' : ''}`);
