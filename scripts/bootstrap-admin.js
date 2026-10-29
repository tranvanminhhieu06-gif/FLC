'use strict';
/**
 * Tạo Admin đầu tiên khi CSDL chưa có Admin nào — chạy trước `npm start` trên máy chủ (xem render.yaml).
 * Đọc FLC_ADMIN_EMAIL, FLC_ADMIN_PASSWORD, FLC_ADMIN_NAME (tùy chọn). Đã có Admin hoặc thiếu biến thì không làm gì,
 * nên chạy lại mỗi lần khởi động vẫn an toàn và mật khẩu không bao giờ nằm trong mã nguồn.
 */
const db = require('../src/db');
const password = require('../src/lib/password');
const { nextCode, audit } = require('../src/services/core');

const email = String(process.env.FLC_ADMIN_EMAIL || '').trim().toLowerCase();
const pass = process.env.FLC_ADMIN_PASSWORD;
const name = process.env.FLC_ADMIN_NAME || 'M&T Admin';

if (db.get("SELECT 1 FROM users WHERE kind = 'admin' LIMIT 1")) {
  console.log('Đã có tài khoản Admin, bỏ qua bước tạo.');
} else if (!email || !pass) {
  console.warn('CSDL chưa có Admin: đặt FLC_ADMIN_EMAIL và FLC_ADMIN_PASSWORD để tạo khi khởi động.');
} else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password.isStrong(pass)) {
  console.error('FLC_ADMIN_EMAIL không hợp lệ hoặc FLC_ADMIN_PASSWORD yếu (tối thiểu 8 ký tự, gồm chữ và số).');
  process.exit(1);
} else {
  const code = db.tx(() => {
    const c = nextCode('MT');
    const id = db.run(
      "INSERT INTO users (code, kind, email, password_hash, full_name, status, approved_at) VALUES (?, 'admin', ?, ?, ?, 'ACTIVE', datetime('now'))",
      c, email, password.hash(pass), name,
    ).lastInsertRowid;
    audit(null, 'account.bootstrap_admin', 'user', id, { after: { code: c, email } });
    return c;
  });
  console.log(`Đã tạo Admin ${code} · ${email}`);
}
