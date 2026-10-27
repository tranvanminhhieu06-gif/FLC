'use strict';
// Phân công theo vai trò: tiếp nhận (Sales), nhận chăm sóc (Account), mời (PM/Project), duyệt & khóa (M&T)
const db = require('../db');
const { fail, audit, notify, notifyAdmins, nextCode } = require('./core');
const flow = require('./orderFlow');
const commission = require('./commission');
const { ROLES } = require('../lib/labels');

const LIVE = "('ACCEPTED','LOCKED')";
// Vai trò độc quyền: mỗi Order chỉ có một người đảm nhận
const EXCLUSIVE = ['REFERRER', 'SALES', 'ACCOUNT', 'PM'];

function hasActiveRole(userId, role) {
  return !!db.get(
    "SELECT 1 FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? AND r.role = ? AND r.status = 'ACTIVE' AND u.status = 'ACTIVE'",
    userId, role,
  );
}
function holderOf(orderId, role) {
  return db.get(`SELECT * FROM order_assignments WHERE order_id = ? AND role = ? AND status IN ${LIVE}`, orderId, role);
}
function liveRolesOf(orderId, userId) {
  return db.all(`SELECT role FROM order_assignments WHERE order_id = ? AND user_id = ? AND status IN ${LIVE}`, orderId, userId).map((r) => r.role);
}

function upsert(orderId, userId, role, status, { shareBp = 10000, invitedBy, isPrimary = 0, note } = {}) {
  const existing = db.get('SELECT * FROM order_assignments WHERE order_id = ? AND user_id = ? AND role = ?', orderId, userId, role);
  if (existing) {
    if (['ACCEPTED', 'LOCKED', 'INVITED'].includes(existing.status)) fail('Người này đã có trong Order với vai trò này');
    db.run(
      "UPDATE order_assignments SET status = ?, share_bp = ?, invited_by = ?, is_primary = ?, note = ?, created_at = datetime('now'), responded_at = NULL WHERE id = ?",
      status, shareBp, invitedBy, isPrimary, note, existing.id,
    );
    return existing.id;
  }
  return db.run(
    'INSERT INTO order_assignments (order_id, user_id, role, share_bp, status, invited_by, is_primary, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    orderId, userId, role, shareBp, status, invitedBy, isPrimary, note,
  ).lastInsertRowid;
}

/** Sales tiếp nhận Order đang chờ — ai nhận trước được trước (khóa bằng transaction IMMEDIATE) */
function claimIntake(orderId, userId) {
  return db.tx(() => {
    if (!hasActiveRole(userId, 'SALES')) fail('Bạn chưa được cấp vai trò Sales', 403);
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (order.status !== 'PENDING_INTAKE') fail('Order này đã được tiếp nhận');
    if (holderOf(orderId, 'SALES')) fail('Order này đã có Sales phụ trách');
    upsert(orderId, userId, 'SALES', 'ACCEPTED', { isPrimary: 1 });
    audit(userId, 'assignment.claim', 'order', orderId, { after: { role: 'SALES' } });
    flow.transition(orderId, 'CONSULTING', userId, 'Sales tiếp nhận và bắt đầu tư vấn');
  });
}

/** Account nhận chăm sóc Order (trước khi ghép nhân sự) */
function claimAccount(orderId, userId) {
  return db.tx(() => {
    if (!hasActiveRole(userId, 'ACCOUNT')) fail('Bạn chưa được cấp vai trò Account', 403);
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!['CONSULTING', 'QUOTED', 'REJECTED', 'CONTRACT_SIGNED', 'AWAITING_DEPOSIT', 'DEPOSITED', 'MATCHING'].includes(order.status)) {
      fail('Order không ở giai đoạn cần Account');
    }
    if (holderOf(orderId, 'ACCOUNT')) fail('Order này đã có Account phụ trách');
    upsert(orderId, userId, 'ACCOUNT', 'ACCEPTED', { isPrimary: 1 });
    audit(userId, 'assignment.claim', 'order', orderId, { after: { role: 'ACCOUNT' } });
    const sales = holderOf(orderId, 'SALES');
    if (sales) notify(sales.user_id, `${order.code}: Account đã nhận phối hợp`, `/orders/${orderId}`);
  });
}

function requireCoordinator(order, actor) {
  if (actor.kind === 'admin') return;
  const acc = holderOf(order.id, 'ACCOUNT');
  const pm = order.needs_pm ? holderOf(order.id, 'PM') : null;
  if (acc?.user_id === actor.id || pm?.user_id === actor.id) return;
  fail('Chỉ Account/PM phụ trách Order mới được ghép nhân sự', 403);
}

function startMatching(orderId, actor) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (actor.kind !== 'admin' && holderOf(orderId, 'ACCOUNT')?.user_id !== actor.id) fail('Chỉ Account phụ trách mới bắt đầu ghép', 403);
  if (!holderOf(orderId, 'ACCOUNT')) fail('Order cần có Account phụ trách trước khi ghép');
  flow.transition(order.id, 'MATCHING', actor.id, 'Account bắt đầu ghép nhân sự');
}

/** 5.1 / 5.2 — Account quyết định có cần PM */
function setNeedsPm(orderId, actor, needsPm) {
  db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (order.status !== 'MATCHING') fail('Chỉ thay đổi được khi đang ghép');
    if (actor.kind !== 'admin' && holderOf(orderId, 'ACCOUNT')?.user_id !== actor.id) fail('Chỉ Account quyết định', 403);
    if (!needsPm) {
      db.run(`UPDATE order_assignments SET status = 'EXPIRED' WHERE order_id = ? AND role = 'PM' AND status IN ('INVITED','ACCEPTED')`, orderId);
    }
    db.run('UPDATE orders SET needs_pm = ? WHERE id = ?', needsPm ? 1 : 0, orderId);
    audit(actor.id, 'order.needs_pm', 'order', orderId, { before: { needs_pm: order.needs_pm }, after: { needs_pm: needsPm ? 1 : 0 } });
  });
}

function invite(orderId, actor, userId, role, shareBp = 10000) {
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (order.status !== 'MATCHING') fail('Chỉ mời được khi Order đang ghép');
    if (!['PM', 'PROJECT'].includes(role)) fail('Chỉ mời PM hoặc Project');
    if (role === 'PM') {
      if (actor.kind !== 'admin' && holderOf(orderId, 'ACCOUNT')?.user_id !== actor.id) fail('Chỉ Account mời PM', 403);
      if (!order.needs_pm) fail('Order đang được đánh dấu "không cần PM"');
      if (holderOf(orderId, 'PM')) fail('Order đã có PM nhận việc');
      shareBp = 10000;
    } else {
      requireCoordinator(order, actor);
    }
    if (!hasActiveRole(userId, role)) fail(`Người được mời chưa có vai trò ${ROLES[role].label} đã duyệt`);
    if (!Number.isInteger(shareBp) || shareBp <= 0 || shareBp > 10000) fail('Tỷ lệ phân công không hợp lệ');
    const id = upsert(orderId, userId, role, 'INVITED', { shareBp, invitedBy: actor.id });
    audit(actor.id, 'assignment.invite', 'assignment', id, { after: { userId, role, shareBp } });
    notify(userId, `Lời mời ${ROLES[role].label} cho ${order.code}: ${order.title}`, '/fl/invitations');
    return id;
  });
}

/** Freelancer chấp nhận / từ chối lời mời. Vị trí độc quyền: người chấp nhận trước giữ chỗ. */
function respond(assignmentId, userId, accept) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM order_assignments WHERE id = ?', assignmentId);
    if (!a || a.user_id !== userId) fail('Không tìm thấy lời mời', 404);
    if (a.status !== 'INVITED') fail('Lời mời không còn hiệu lực');
    const order = db.get('SELECT * FROM orders WHERE id = ?', a.order_id);
    if (order.status !== 'MATCHING') fail('Order đã kết thúc giai đoạn ghép');
    if (!accept) {
      db.run("UPDATE order_assignments SET status = 'DECLINED', responded_at = datetime('now') WHERE id = ?", a.id);
    } else {
      if (EXCLUSIVE.includes(a.role) && holderOf(a.order_id, a.role)) {
        db.run("UPDATE order_assignments SET status = 'EXPIRED', responded_at = datetime('now') WHERE id = ?", a.id);
        audit(userId, 'assignment.expired', 'assignment', a.id, { reason: 'Vị trí đã có người nhận trước' });
        return { lost: true };
      }
      db.run("UPDATE order_assignments SET status = 'ACCEPTED', responded_at = datetime('now') WHERE id = ?", a.id);
      if (EXCLUSIVE.includes(a.role)) {
        db.run("UPDATE order_assignments SET status = 'EXPIRED' WHERE order_id = ? AND role = ? AND status = 'INVITED'", a.order_id, a.role);
      }
    }
    audit(userId, accept ? 'assignment.accept' : 'assignment.decline', 'assignment', a.id);
    const acc = holderOf(a.order_id, 'ACCOUNT');
    if (acc) notify(acc.user_id, `${order.code}: ${ROLES[a.role].label} đã ${accept ? 'nhận' : 'từ chối'} lời mời`, `/orders/${order.id}`);
    return { lost: false };
  });
}

function updateShare(assignmentId, actor, shareBp) {
  const a = db.get('SELECT * FROM order_assignments WHERE id = ?', assignmentId);
  const order = db.get('SELECT * FROM orders WHERE id = ?', a.order_id);
  if (order.status !== 'MATCHING') fail('Chỉ chỉnh tỷ lệ phân công khi đang ghép');
  requireCoordinator(order, actor);
  if (a.role !== 'PROJECT') fail('Chỉ vai trò Project mới chia nhiều người');
  if (!Number.isInteger(shareBp) || shareBp <= 0 || shareBp > 10000) fail('Tỷ lệ không hợp lệ');
  db.run('UPDATE order_assignments SET share_bp = ? WHERE id = ?', shareBp, a.id);
  audit(actor.id, 'assignment.share', 'assignment', a.id, { before: { share_bp: a.share_bp }, after: { share_bp: shareBp } });
}

/** Kiểm tra phương án ghép — trả về danh sách lỗi (rỗng = hợp lệ) */
function planProblems(orderId) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const problems = [];
  const live = db.all(`SELECT * FROM order_assignments WHERE order_id = ? AND status IN ${LIVE}`, orderId);
  const by = (r) => live.filter((a) => a.role === r);
  if (!by('ACCOUNT').length) problems.push('Chưa có Account phụ trách chính');
  if (order.needs_pm == null) problems.push('Account chưa xác nhận Order có cần PM hay không');
  if (order.needs_pm && !by('PM').length) problems.push('Order cần PM nhưng chưa có PM nhận việc');
  const projects = by('PROJECT');
  if (!projects.length) problems.push('Chưa có freelancer Project nhận việc');
  const sum = projects.reduce((s, a) => s + a.share_bp, 0);
  if (projects.length && sum !== 10000) problems.push(`Tổng tỷ lệ phân công Project phải là 100% (hiện ${sum / 100}%)`);
  if (db.get("SELECT 1 FROM order_assignments WHERE order_id = ? AND status = 'INVITED'", orderId)) {
    problems.push('Còn lời mời chưa phản hồi (sẽ hết hiệu lực khi M&T khóa)');
  }
  return problems;
}

function submitPlan(orderId, actor) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  requireCoordinator(order, actor);
  const blocking = planProblems(orderId).filter((p) => !p.startsWith('Còn lời mời'));
  if (blocking.length) fail(blocking.join('; '));
  flow.transition(orderId, 'PENDING_MATCH_APPROVAL', actor.id, 'Account gửi phương án nhân sự và tỷ lệ');
}

function returnPlan(orderId, adminId, note) {
  if (!note) fail('Cần ghi rõ lý do trả lại phương án');
  flow.transition(orderId, 'MATCHING', adminId, note);
  const acc = holderOf(orderId, 'ACCOUNT');
  if (acc) notify(acc.user_id, `Phương án ghép bị trả lại: ${note}`, `/orders/${orderId}`);
}

/** M&T phê duyệt: khóa danh sách nhân sự + chụp tỷ lệ vào Order + tạo workspace PROJn */
function approvePlan(orderId, adminId, rates) {
  commission.validateRates(rates);
  return db.tx(() => {
    const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (order.status !== 'PENDING_MATCH_APPROVAL') fail('Order không ở trạng thái chờ duyệt ghép');
    const blocking = planProblems(orderId).filter((p) => !p.startsWith('Còn lời mời'));
    if (blocking.length) fail(blocking.join('; '));
    db.run("UPDATE order_assignments SET status = 'LOCKED' WHERE order_id = ? AND status = 'ACCEPTED'", orderId);
    db.run("UPDATE order_assignments SET status = 'EXPIRED' WHERE order_id = ? AND status = 'INVITED'", orderId);
    const policy = commission.activePolicy();
    for (const [role, bp] of Object.entries(rates)) {
      db.run('INSERT INTO revenue_allocations (order_id, role, rate_bp, policy_id) VALUES (?, ?, ?, ?)', orderId, role, bp, policy.id);
    }
    const code = nextCode('PROJ');
    db.run('INSERT INTO projects (order_id, code) VALUES (?, ?)', orderId, code);
    audit(adminId, 'assignment.lock', 'order', orderId, { after: { rates, project: code } });
    flow.transition(orderId, 'IN_PROGRESS', adminId, `M&T duyệt phương án, khóa nhân sự và tỷ lệ. Tạo nhóm ${code}`);
    return code;
  });
}

/** M&T thay đổi người phụ trách (thu hồi) — luôn kèm lý do */
function revoke(assignmentId, adminId, reason) {
  if (!reason) fail('Cần lý do thu hồi');
  const a = db.get('SELECT * FROM order_assignments WHERE id = ?', assignmentId);
  if (!a || !['INVITED', 'ACCEPTED', 'LOCKED'].includes(a.status)) fail('Phân công không còn hiệu lực');
  db.run("UPDATE order_assignments SET status = 'REVOKED', note = ? WHERE id = ?", reason, a.id);
  audit(adminId, 'assignment.revoke', 'assignment', a.id, { before: { status: a.status }, reason });
  notify(a.user_id, `Phân công ${ROLES[a.role].label} đã bị thu hồi: ${reason}`, '/fl');
}

/** M&T gán trực tiếp (ví dụ thay người sau khi đã khóa) */
function adminAssign(orderId, adminId, userId, role, shareBp, reason) {
  return db.tx(() => {
    if (!hasActiveRole(userId, role)) fail(`Người này chưa có vai trò ${ROLES[role].label} đã duyệt`);
    if (EXCLUSIVE.includes(role) && holderOf(orderId, role)) fail(`Order đã có ${ROLES[role].label} — hãy thu hồi người cũ trước`);
    const locked = !!commission.orderAllocations(orderId);
    const id = upsert(orderId, userId, role, locked ? 'LOCKED' : 'ACCEPTED', { shareBp, invitedBy: adminId, note: reason });
    audit(adminId, 'assignment.admin_assign', 'assignment', id, { after: { userId, role, shareBp }, reason });
    notify(userId, `M&T đã phân công bạn vai trò ${ROLES[role].label}`, `/orders/${orderId}`);
    return id;
  });
}

/** Gợi ý freelancer theo kỹ năng + sẵn sàng + khối lượng việc đang làm */
function suggest(orderId, role) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  const rows = db.all(
    `SELECT u.id, u.code, u.full_name, f.member_code, f.skills, f.service_types, f.availability,
            (SELECT COUNT(*) FROM order_assignments a JOIN orders o ON o.id = a.order_id
              WHERE a.user_id = u.id AND a.status = 'LOCKED' AND o.status NOT IN ('COMPLETED','CLOSED','CANCELLED')) AS load
       FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = ? AND r.status = 'ACTIVE'
       JOIN freelancer_profiles f ON f.user_id = u.id
      WHERE u.status = 'ACTIVE'
        AND u.id NOT IN (SELECT user_id FROM order_assignments WHERE order_id = ? AND role = ? AND status IN ('INVITED','ACCEPTED','LOCKED'))`,
    role, orderId, role,
  );
  const words = `${order.service_type} ${order.title}`.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  return rows
    .map((r) => {
      const hay = `${r.skills || ''} ${r.service_types || ''}`.toLowerCase();
      const match = words.filter((w) => hay.includes(w)).length;
      const score = match * 10 + (r.availability === 'AVAILABLE' ? 5 : r.availability === 'BUSY' ? 1 : -10) - r.load * 2;
      return { ...r, score };
    })
    .sort((a, b) => b.score - a.score);
}

module.exports = {
  hasActiveRole, holderOf, liveRolesOf, claimIntake, claimAccount, startMatching, setNeedsPm, invite, respond,
  updateShare, planProblems, submitPlan, returnPlan, approvePlan, revoke, adminAssign, suggest,
};
