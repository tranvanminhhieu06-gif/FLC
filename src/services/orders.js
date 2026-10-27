'use strict';
// Order, báo giá, hợp đồng, nhiệm vụ, bàn giao, nghiệm thu
const db = require('../db');
const { fail, audit, notify, notifyRole, notifyAdmins, nextCode } = require('./core');
const flow = require('./orderFlow');
const assignment = require('./assignment');
const finance = require('./finance');

function create(customerId, data, submit) {
  return db.tx(() => {
    const profile = db.get('SELECT referrer_id FROM customer_profiles WHERE user_id = ?', customerId);
    const r = db.run(
      `INSERT INTO orders (customer_id, referrer_id, title, service_type, description, goals, deliverables, budget, deadline, contact_info, invoice_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      customerId, profile?.referrer_id, data.title, data.service_type, data.description, data.goals, data.deliverables,
      data.budget, data.deadline, data.contact_info, data.invoice_info,
    );
    const id = r.lastInsertRowid;
    db.run('UPDATE orders SET code = ? WHERE id = ?', nextCode('ORD'), id);
    db.run("INSERT INTO order_status_history (order_id, to_status, actor_id, note) VALUES (?, 'DRAFT', ?, 'Tạo bản nháp')", id, customerId);
    audit(customerId, 'order.create', 'order', id, { after: { title: data.title } });
    if (submit) submitOrder(id, customerId);
    return id;
  });
}

function update(orderId, customerId, data) {
  const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
  if (o.customer_id !== customerId) fail('Không có quyền', 403);
  if (o.status !== 'DRAFT') fail('Chỉ sửa được Order ở trạng thái bản nháp');
  db.run(
    `UPDATE orders SET title = ?, service_type = ?, description = ?, goals = ?, deliverables = ?, budget = ?, deadline = ?,
            contact_info = ?, invoice_info = ?, updated_at = datetime('now') WHERE id = ?`,
    data.title, data.service_type, data.description, data.goals, data.deliverables, data.budget, data.deadline,
    data.contact_info, data.invoice_info, orderId,
  );
}

/** Gửi Order: gắn Referrer (nếu khách có mã giới thiệu hợp lệ) và báo cho Sales */
function submitOrder(orderId, customerId) {
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (o.customer_id !== customerId) fail('Không có quyền', 403);
    flow.transition(orderId, 'PENDING_INTAKE', customerId, 'Khách hàng gửi Order');
    if (o.referrer_id && assignment.hasActiveRole(o.referrer_id, 'REFERRER')) {
      db.run(
        "INSERT OR IGNORE INTO order_assignments (order_id, user_id, role, status, note) VALUES (?, ?, 'REFERRER', 'ACCEPTED', 'Gắn tự động theo mã giới thiệu')",
        orderId, o.referrer_id,
      );
      notify(o.referrer_id, `Khách bạn giới thiệu vừa gửi ${o.code}`, '/fl/referrals');
    }
    notifyRole('SALES', `Order mới chờ tiếp nhận: ${o.code} — ${o.title}`, '/fl/opportunities');
  });
}

function addAttachment(orderId, userId, file) {
  db.run('INSERT INTO attachments (order_id, uploaded_by, file_path, file_name) VALUES (?, ?, ?, ?)', orderId, userId, file.path, file.name);
}

/* ---------- Báo giá & hợp đồng ---------- */

function requireSalesOrAccount(orderId, actor) {
  if (actor.kind === 'admin') return;
  const roles = assignment.liveRolesOf(orderId, actor.id);
  if (!roles.includes('SALES') && !roles.includes('ACCOUNT')) fail('Chỉ Sales/Account phụ trách mới được báo giá', 403);
}

function createQuote(orderId, actor, { amount, deposit_pct, scope, timeline, terms }) {
  return db.tx(() => {
    requireSalesOrAccount(orderId, actor);
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!['CONSULTING', 'QUOTED', 'REJECTED'].includes(o.status)) fail('Order không ở giai đoạn báo giá');
    if (!amount || amount <= 0) fail('Giá trị báo giá phải lớn hơn 0');
    if (!scope) fail('Cần mô tả phạm vi công việc');
    const dp = Number.isInteger(deposit_pct) ? deposit_pct : 50;
    if (dp < 0 || dp > 100) fail('Tỷ lệ cọc từ 0–100%');
    db.run("UPDATE quotes SET status = 'SUPERSEDED' WHERE order_id = ? AND status = 'SENT'", orderId);
    const version = (db.get('SELECT MAX(version) AS v FROM quotes WHERE order_id = ?', orderId).v || 0) + 1;
    const r = db.run(
      'INSERT INTO quotes (order_id, version, amount, deposit_pct, scope, timeline, terms, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      orderId, version, amount, dp, scope, timeline, terms, actor.id,
    );
    audit(actor.id, 'quote.create', 'quote', r.lastInsertRowid, { after: { version, amount, deposit_pct: dp } });
    if (o.status === 'REJECTED') flow.transition(orderId, 'CONSULTING', actor.id, 'Lập báo giá mới');
    if (o.status !== 'QUOTED') flow.transition(orderId, 'QUOTED', actor.id, `Gửi báo giá phiên bản ${version}`);
    else notify(o.customer_id, `${o.code}: có báo giá mới (phiên bản ${version})`, `/orders/${orderId}`);
    return r.lastInsertRowid;
  });
}

/** Khách xác nhận báo giá + điều khoản → ký hợp đồng → chờ cọc */
function acceptQuote(quoteId, customerId, agreed) {
  return db.tx(() => {
    const q = db.get('SELECT * FROM quotes WHERE id = ?', quoteId);
    const o = db.get('SELECT * FROM orders WHERE id = ?', q.order_id);
    if (o.customer_id !== customerId) fail('Không có quyền', 403);
    if (q.status !== 'SENT' || o.status !== 'QUOTED') fail('Báo giá không còn hiệu lực');
    if (!agreed) fail('Bạn cần đồng ý với điều khoản hợp đồng');
    db.run("UPDATE quotes SET status = 'ACCEPTED', responded_at = datetime('now') WHERE id = ?", quoteId);
    const deposit = Math.round((q.amount * q.deposit_pct) / 100);
    db.run(
      'INSERT INTO contracts (order_id, quote_id, value, deposit_pct, deposit_amount, terms, signed_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      o.id, q.id, q.amount, q.deposit_pct, deposit, q.terms, customerId,
    );
    audit(customerId, 'contract.sign', 'order', o.id, { after: { value: q.amount, deposit } });
    flow.transition(o.id, 'CONTRACT_SIGNED', customerId, `Khách xác nhận báo giá v${q.version} và ký hợp đồng`);
    flow.transition(o.id, 'AWAITING_DEPOSIT', customerId, 'Chờ đặt cọc');
    if (deposit === 0) flow.transition(o.id, 'DEPOSITED', customerId, 'Hợp đồng không yêu cầu cọc');
  });
}

function rejectQuote(quoteId, customerId, note) {
  db.tx(() => {
    const q = db.get('SELECT * FROM quotes WHERE id = ?', quoteId);
    const o = db.get('SELECT * FROM orders WHERE id = ?', q.order_id);
    if (o.customer_id !== customerId) fail('Không có quyền', 403);
    if (q.status !== 'SENT') fail('Báo giá không còn hiệu lực');
    db.run("UPDATE quotes SET status = 'REJECTED', customer_note = ?, responded_at = datetime('now') WHERE id = ?", note, quoteId);
    flow.transition(o.id, 'REJECTED', customerId, note || 'Khách từ chối báo giá');
  });
}

function depositException(orderId, adminId, reason) {
  if (!reason) fail('Phê duyệt ngoại lệ cần có lý do');
  db.tx(() => {
    db.run('UPDATE orders SET deposit_exception = 1, deposit_exception_reason = ? WHERE id = ?', reason, orderId);
    audit(adminId, 'order.deposit_exception', 'order', orderId, { after: { deposit_exception: 1 }, reason });
    flow.transition(orderId, 'DEPOSITED', adminId, `Ngoại lệ đặt cọc: ${reason}`);
  });
}

/* ---------- Triển khai ---------- */

function isReviewer(orderId, actor) {
  if (actor.kind === 'admin') return true;
  const o = db.get('SELECT needs_pm FROM orders WHERE id = ?', orderId);
  const roles = assignment.liveRolesOf(orderId, actor.id);
  return o.needs_pm ? roles.includes('PM') : roles.includes('ACCOUNT');
}

function createTask(orderId, actor, { title, description, assignee_id, due_date }) {
  if (!isReviewer(orderId, actor) && !assignment.liveRolesOf(orderId, actor.id).includes('ACCOUNT')) fail('Chỉ PM/Account được giao nhiệm vụ', 403);
  if (!title) fail('Cần tên nhiệm vụ');
  if (assignee_id && !db.get("SELECT 1 FROM order_assignments WHERE order_id = ? AND user_id = ? AND role = 'PROJECT' AND status = 'LOCKED'", orderId, assignee_id)) {
    fail('Người nhận nhiệm vụ phải là Project đã được khóa trong Order');
  }
  const r = db.run('INSERT INTO tasks (order_id, title, description, assignee_id, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    orderId, title, description, assignee_id || null, due_date || null, actor.id);
  if (assignee_id) notify(assignee_id, `Nhiệm vụ mới: ${title}`, `/orders/${orderId}#tasks`);
  return r.lastInsertRowid;
}

function setTaskStatus(taskId, actor, status) {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!t) fail('Không tìm thấy nhiệm vụ', 404);
  if (t.assignee_id !== actor.id && !isReviewer(t.order_id, actor)) fail('Không có quyền cập nhật nhiệm vụ này', 403);
  if (status === 'DONE' && !isReviewer(t.order_id, actor)) fail('Chỉ PM/Account xác nhận hoàn thành');
  db.run("UPDATE tasks SET status = ?, done_at = CASE WHEN ? = 'DONE' THEN datetime('now') ELSE NULL END WHERE id = ?", status, status, taskId);
}

const WORKING = ['IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW'];

function submitDeliverable(orderId, actor, { kind, title, note, task_id }, file) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!WORKING.includes(o.status)) fail('Order không ở giai đoạn triển khai');
    if (!assignment.liveRolesOf(orderId, actor.id).includes('PROJECT')) fail('Chỉ freelancer Project của Order mới nộp sản phẩm', 403);
    if (!['demo', 'preview', 'final'].includes(kind)) fail('Loại sản phẩm không hợp lệ');
    if (!file) fail('Cần đính kèm tệp sản phẩm');
    const version = (db.get('SELECT MAX(version) AS v FROM deliverables WHERE order_id = ? AND kind = ?', orderId, kind).v || 0) + 1;
    const r = db.run(
      'INSERT INTO deliverables (order_id, task_id, version, kind, title, note, file_path, file_name, submitted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      orderId, task_id || null, version, kind, title || file.name, note, file.path, file.name, actor.id,
    );
    if (task_id) db.run("UPDATE tasks SET status = 'SUBMITTED' WHERE id = ? AND assignee_id = ?", task_id, actor.id);
    if (o.status !== 'IN_REVIEW') flow.transition(orderId, 'IN_REVIEW', actor.id, `Nộp ${kind} v${version}`);
    return r.lastInsertRowid;
  });
}

/** PM (hoặc Account nếu không có PM) kiểm duyệt nội bộ trước khi gửi khách */
function reviewDeliverable(deliverableId, actor, approve, note) {
  return db.tx(() => {
    const d = db.get('SELECT * FROM deliverables WHERE id = ?', deliverableId);
    if (!isReviewer(d.order_id, actor)) fail('Chỉ PM (hoặc Account khi không có PM) được kiểm duyệt', 403);
    if (d.review_status !== 'PENDING') fail('Sản phẩm đã được kiểm duyệt');
    if (!approve && !note) fail('Cần ghi rõ nội dung cần sửa');
    db.run("UPDATE deliverables SET review_status = ?, review_note = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
      approve ? 'APPROVED' : 'CHANGES', note, actor.id, d.id);
    notify(d.submitted_by, `${approve ? 'Sản phẩm đạt' : 'Yêu cầu sửa'}: ${d.title}`, `/orders/${d.order_id}#deliverables`);
    // Chỉ chuyển bước khi đã kiểm duyệt hết sản phẩm đang chờ của vòng này
    const o = db.get('SELECT * FROM orders WHERE id = ?', d.order_id);
    if (o.status !== 'IN_REVIEW') return;
    if (db.get("SELECT 1 FROM deliverables WHERE order_id = ? AND review_status = 'PENDING'", d.order_id)) return;
    // Vòng hiện tại bắt đầu sau lần khách yêu cầu chỉnh sửa gần nhất — bản demo cũ khách đã từ chối không gửi lại
    const since = db.get("SELECT MAX(created_at) AS t FROM acceptances WHERE order_id = ? AND decision = 'REVISE'", d.order_id).t || '';
    const shown = db.get(
      "SELECT kind, version FROM deliverables WHERE order_id = ? AND kind <> 'final' AND review_status = 'APPROVED' AND reviewed_at >= ? ORDER BY id DESC LIMIT 1",
      d.order_id, since,
    );
    const label = `${d.kind} v${d.version}`;
    if (shown) {
      flow.transition(d.order_id, shown.kind === 'preview' ? 'PREVIEW' : 'DEMO', actor.id,
        approve ? `Đạt kiểm duyệt ${label} — gửi khách ${shown.kind} v${shown.version}` : `Yêu cầu sửa ${label}; gửi khách ${shown.kind} v${shown.version} đã đạt`);
    } else if (approve && d.kind === 'final') {
      // Chỉ có file gốc (không demo): khách duyệt ở bước Preview, file vẫn khóa tới khi trả đủ
      flow.transition(d.order_id, 'PREVIEW', actor.id, `File gốc ${label} đạt kiểm duyệt (khóa tới khi thanh toán đủ)`);
    } else {
      flow.transition(d.order_id, 'IN_PROGRESS', actor.id, approve ? `Đạt kiểm duyệt ${label}` : `Yêu cầu sửa ${label}`);
    }
  });
}

function resolveDispute(disputeId, adminId, { status, resolution }) {
  if (!resolution) fail('Cần nội dung xử lý');
  db.tx(() => {
    const d = db.get('SELECT * FROM disputes WHERE id = ?', disputeId);
    if (!d || d.status !== 'OPEN') fail('Yêu cầu đã được xử lý');
    const final = status === 'REJECTED' ? 'REJECTED' : 'RESOLVED';
    db.run("UPDATE disputes SET status = ?, resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ?", final, resolution, adminId, d.id);
    audit(adminId, 'dispute.resolve', 'dispute', d.id, { after: { status: final }, reason: resolution });
    notify(d.raised_by, `Yêu cầu "${d.title}" đã được M&T xử lý`, `/orders/${d.order_id}#disputes`);
  });
}

/** 6.3 Khách nghiệm thu bản demo/preview */
function customerDecision(orderId, customerId, { decision, deliverable_id, note }) {
  return db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (o.customer_id !== customerId) fail('Không có quyền', 403);
    if (!['DEMO', 'PREVIEW'].includes(o.status)) fail('Chưa có bản demo/preview chờ bạn duyệt');
    if (!['ACCEPT', 'REVISE', 'CHANGE_REQUEST'].includes(decision)) fail('Quyết định không hợp lệ');
    if (decision !== 'ACCEPT' && !note) fail('Vui lòng mô tả nội dung cần chỉnh sửa / thay đổi');
    db.run('INSERT INTO acceptances (order_id, deliverable_id, decision, note, actor_id) VALUES (?, ?, ?, ?, ?)',
      orderId, deliverable_id || null, decision, note, customerId);
    if (decision === 'ACCEPT') {
      const hasFinal = db.get("SELECT 1 FROM deliverables WHERE order_id = ? AND kind = 'final' AND review_status = 'APPROVED'", orderId);
      if (!hasFinal) fail('Đội dự án chưa nộp file gốc đạt kiểm duyệt — chưa thể chấp nhận');
      const paid = finance.summary(orderId).paidInFull;
      flow.transition(orderId, paid ? 'ACCEPTANCE' : 'AWAITING_PAYMENT', customerId,
        paid ? 'Khách chấp nhận sản phẩm (đã thanh toán đủ)' : 'Khách chấp nhận sản phẩm — chờ thanh toán phần còn lại');
    } else if (decision === 'REVISE') {
      flow.transition(orderId, 'IN_PROGRESS', customerId, `Khách yêu cầu chỉnh sửa: ${note}`);
    } else {
      db.run("INSERT INTO disputes (order_id, raised_by, kind, title, body) VALUES (?, ?, 'change_request', 'Yêu cầu thay đổi ngoài phạm vi', ?)",
        orderId, customerId, note);
      notifyAdmins(`${o.code}: khách yêu cầu thay đổi ngoài phạm vi`, '/admin/disputes');
      const sales = assignment.holderOf(orderId, 'SALES');
      if (sales) notify(sales.user_id, `${o.code}: khách yêu cầu thay đổi ngoài phạm vi — cần báo giá bổ sung`, `/orders/${orderId}`);
    }
  });
}

/** Ký biên bản nghiệm thu sau khi đã nhận file gốc → chuyển Đối soát */
function signOff(orderId, customerId, note) {
  db.tx(() => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', orderId);
    if (o.customer_id !== customerId) fail('Không có quyền', 403);
    if (o.status !== 'ACCEPTANCE') fail('Order chưa ở bước nghiệm thu');
    db.run("INSERT INTO acceptances (order_id, decision, note, actor_id) VALUES (?, 'SIGN_OFF', ?, ?)", orderId, note, customerId);
    flow.transition(orderId, 'RECONCILIATION', customerId, 'Khách ký biên bản nghiệm thu');
  });
}

function postMessage(orderId, userId, body, file) {
  if (!body && !file) fail('Tin nhắn trống');
  db.run('INSERT INTO messages (order_id, user_id, body, file_path, file_name) VALUES (?, ?, ?, ?, ?)',
    orderId, userId, body || '(tệp đính kèm)', file?.path, file?.name);
}

function raiseDispute(orderId, userId, { kind, title, body }, file) {
  if (!title || !body) fail('Cần tiêu đề và nội dung');
  const o = db.get('SELECT code FROM orders WHERE id = ?', orderId);
  db.run('INSERT INTO disputes (order_id, raised_by, kind, title, body, evidence_path, evidence_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    orderId, userId, kind, title, body, file?.path, file?.name);
  notifyAdmins(`${o.code}: ${title}`, '/admin/disputes');
}

module.exports = {
  create, update, submitOrder, addAttachment, createQuote, acceptQuote, rejectQuote, depositException,
  isReviewer, createTask, setTaskStatus, submitDeliverable, reviewDeliverable, customerDecision, signOff,
  postMessage, raiseDispute, resolveDispute,
};
