'use strict';
// Tiện ích dùng chung cho các service: lỗi nghiệp vụ, sinh mã, nhật ký, thông báo
const db = require('../db');

/** Lỗi do vi phạm quy tắc nghiệp vụ — thông điệp hiển thị thẳng cho người dùng */
class FlowError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'FlowError'; this.status = status; }
}
const fail = (msg, status) => { throw new FlowError(msg, status); };

/** Sinh mã tuần tự: CUS1, FL1, ORD1, PROJ1 — phải gọi trong transaction */
function nextCode(prefix) {
  db.run('INSERT INTO sequences (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1', prefix);
  return prefix + db.get('SELECT value FROM sequences WHERE name = ?', prefix).value;
}

function audit(actorId, action, entity, entityId, { before, after, reason } = {}) {
  db.run(
    'INSERT INTO audit_logs (actor_id, action, entity, entity_id, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
    actorId, action, entity, entityId,
    before === undefined ? null : JSON.stringify(before),
    after === undefined ? null : JSON.stringify(after),
    reason || null,
  );
}

/** Ghi một lần đổi trạng thái (order/task/payment/commission/payout) vào status_history — chỉ thêm, không sửa */
function history(entity, entityId, { orderId = null, from = null, to, actorId = null, reason = null, data } = {}) {
  db.run(
    'INSERT INTO status_history (entity, entity_id, order_id, from_status, to_status, actor_id, reason, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    entity, entityId, orderId, from, to, actorId, reason, data === undefined ? null : JSON.stringify(data),
  );
}

function notify(userId, title, link) {
  if (userId) db.run('INSERT INTO notifications (user_id, title, link) VALUES (?, ?, ?)', userId, title, link || null);
}
function notifyRole(role, title, link) {
  for (const u of db.all(
    "SELECT u.id FROM users u JOIN user_roles r ON r.user_id = u.id WHERE r.role = ? AND r.status = 'ACTIVE' AND u.status = 'ACTIVE'", role,
  )) notify(u.id, title, link);
}
function notifyAdmins(title, link) {
  for (const u of db.all("SELECT id FROM users WHERE kind = 'admin' AND status = 'ACTIVE'")) notify(u.id, title, link);
}

module.exports = { FlowError, fail, nextCode, audit, history, notify, notifyRole, notifyAdmins };
