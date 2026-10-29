'use strict';
// Kiểm thử quy tắc hệ thống trên CSDL trong bộ nhớ
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.FLC_DB = ':memory:';
process.env.FLC_STORAGE = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-test-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const accounts = require('../src/services/accounts');
const orders = require('../src/services/orders');
const assignment = require('../src/services/assignment');
const finance = require('../src/services/finance');
const commission = require('../src/services/commission');
const flow = require('../src/services/orderFlow');
const files = require('../src/services/files');
const password = require('../src/lib/password');
const { DEFAULT_RATES } = require('../src/lib/labels');

const PASS = 'Test@1234';
const fake = (n) => { fs.writeFileSync(path.join(files.ROOT, n), 'x'); return { path: n, name: n }; };
const adminId = db.run("INSERT INTO users (code, kind, email, password_hash, status) VALUES ('MT1', 'admin', 'a@t.local', ?, 'ACTIVE')", password.hash(PASS)).lastInsertRowid;
const admin = { id: adminId, kind: 'admin' };

function fl(key, roles) {
  const r = accounts.registerFreelancer({
    full_name: key, dob: '1995-01-01', email: `${key}@t.local`, phone: `09${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    password: PASS, password2: PASS, member_code: `${key}.code`, roles, bank_name: 'B', bank_account: '1',
  }, { cv: fake(`${key}-cv`), id_front: fake(`${key}-f`), id_back: fake(`${key}-b`) });
  accounts.review(r.id, adminId, { decision: 'approve', roles });
  return { id: r.id, kind: 'freelancer' };
}
const sales = fl('sales', ['SALES']);
const sales2 = fl('sales2', ['SALES']);
const acc = fl('acc', ['ACCOUNT']);
const pm1 = fl('pm1', ['PM']);
const pm2 = fl('pm2', ['PM']);
const prj = fl('prj', ['PROJECT']);
const cus = accounts.registerCustomer({ email: 'c@t.local', password: PASS, password2: PASS }).id;

const status = (id) => db.get('SELECT status FROM orders WHERE id = ?', id).status;
const newOrder = () => orders.create(cus, { title: 'T', service_type: 'Thiết kế website', description: 'D' }, false);

test('khách chưa được duyệt không gửi được Order', () => {
  const id = newOrder();
  assert.throws(() => orders.submitOrder(id, cus), /được M&T duyệt/);
  assert.equal(status(id), 'DRAFT');
  accounts.review(cus, adminId, { decision: 'approve' });
  orders.submitOrder(id, cus);
  assert.equal(status(id), 'PENDING_INTAKE');
});

/** Đưa một Order tới AWAITING_DEPOSIT */
function toDeposit(value = 10_000_000) {
  const id = newOrder();
  orders.submitOrder(id, cus);
  assignment.claimIntake(id, sales.id);
  assignment.claimAccount(id, acc.id);
  orders.createQuote(id, sales, { amount: value, deposit_pct: 50, scope: 'S' });
  orders.acceptQuote(db.get("SELECT id FROM quotes WHERE order_id = ? AND status = 'SENT'", id).id, cus, true);
  return id;
}

test('Sales: ai nhận trước được trước', () => {
  const id = newOrder();
  orders.submitOrder(id, cus);
  assignment.claimIntake(id, sales.id);
  assert.throws(() => assignment.claimIntake(id, sales2.id), /đã được tiếp nhận|đã có Sales/);
});

test('không cho triển khai khi chưa đủ cọc; ngoại lệ phải có lý do', () => {
  const id = toDeposit();
  assert.equal(status(id), 'AWAITING_DEPOSIT');
  assert.throws(() => assignment.startMatching(id, acc), /Không thể chuyển/);
  const p = finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 3_000_000, ref: 'x' });
  finance.confirmPayment({ paymentId: p, adminId });
  assert.equal(status(id), 'AWAITING_DEPOSIT', 'cọc thiếu thì giữ nguyên');
  assert.throws(() => orders.depositException(id, adminId, ''), /lý do/);
  orders.depositException(id, adminId, 'Khách thân thiết');
  assert.equal(status(id), 'DEPOSITED');
});

test('PM là vị trí độc quyền: người chấp nhận sau mất lượt', () => {
  const id = toDeposit();
  finance.confirmPayment({ paymentId: finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 5_000_000, ref: 'y' }), adminId });
  assignment.startMatching(id, acc);
  assignment.setNeedsPm(id, acc, true);
  const a1 = assignment.invite(id, acc, pm1.id, 'PM');
  const a2 = assignment.invite(id, acc, pm2.id, 'PM');
  assignment.respond(a1, pm1.id, true);
  assert.throws(() => assignment.respond(a2, pm2.id, true), /không còn hiệu lực/);
});

test('trọn quy trình: file gốc khóa tới khi trả đủ; hoa hồng chỉ sinh khi đối soát; không đối soát trùng', () => {
  const id = toDeposit(20_000_000);
  finance.confirmPayment({ paymentId: finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 10_000_000, ref: 'd' }), adminId });
  assignment.startMatching(id, acc);
  assignment.setNeedsPm(id, acc, false);
  assignment.respond(assignment.invite(id, acc, prj.id, 'PROJECT'), prj.id, true);
  assert.throws(() => assignment.approvePlan(id, adminId, DEFAULT_RATES), /chờ duyệt ghép/);
  assignment.submitPlan(id, acc);
  assignment.approvePlan(id, adminId, DEFAULT_RATES);
  assert.equal(status(id), 'IN_PROGRESS');

  const demo = orders.submitDeliverable(id, prj, { kind: 'demo' }, fake('demo1'));
  orders.reviewDeliverable(demo, acc, true);   // không có PM → Account kiểm duyệt
  const fin = orders.submitDeliverable(id, prj, { kind: 'final' }, fake('final1'));
  orders.reviewDeliverable(fin, acc, true);
  const customer = db.get('SELECT * FROM users WHERE id = ?', cus);
  assert.ok(files.resolve(customer, 'deliverable', demo), 'demo xem được');
  assert.equal(files.resolve(customer, 'deliverable', fin), null, 'file gốc bị khóa khi chưa trả đủ');

  orders.customerDecision(id, cus, { decision: 'ACCEPT' });
  assert.equal(status(id), 'AWAITING_PAYMENT');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM commissions WHERE order_id = ?', id).n, 0, 'không tự chia doanh thu');
  finance.confirmPayment({ paymentId: finance.declarePayment({ orderId: id, actorId: cus, kind: 'installment', amount: 10_000_000, ref: 'f' }), adminId });
  assert.equal(status(id), 'ACCEPTANCE');
  assert.ok(files.resolve(customer, 'deliverable', fin), 'trả đủ → mở file gốc');

  orders.signOff(id, cus);
  commission.reconcile({ orderId: id, adminId });
  assert.throws(() => commission.reconcile({ orderId: id, adminId }), /Không có khoản thu mới/);
  assert.throws(() => flow.transition(id, 'COMPLETED', adminId), /chờ freelancer và M&T duyệt/);
  const pending = db.all("SELECT id, user_id FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'", id);
  commission.approve({ ids: pending.map((r) => r.id), adminId });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM commissions WHERE order_id = ? AND status = 'APPROVED'", id).n, 0, 'M&T duyệt một mình chưa đủ');
  for (const uid of new Set(pending.map((r) => r.user_id))) {
    commission.confirmByUser({ ids: pending.filter((r) => r.user_id === uid).map((r) => r.id), userId: uid });
  }
  assert.equal(db.get("SELECT COUNT(*) AS n FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'", id).n, 0);
  flow.transition(id, 'COMPLETED', adminId);
  const total = db.get('SELECT SUM(amount) AS s FROM commissions WHERE order_id = ?', id).s;
  assert.equal(total, 20_000_000);
});

test('chỉ nộp file gốc (không demo) → khách vẫn duyệt được ở Preview; không thu vượt hợp đồng', () => {
  const id = toDeposit(8_000_000);
  assert.throws(() => finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 80_000_000, ref: 'gõ nhầm' }), /vượt quá/);
  finance.confirmPayment({ paymentId: finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 4_000_000, ref: 'c' }), adminId });
  assignment.startMatching(id, acc);
  assignment.setNeedsPm(id, acc, false);
  assignment.respond(assignment.invite(id, acc, prj.id, 'PROJECT'), prj.id, true);
  assignment.submitPlan(id, acc);
  assignment.approvePlan(id, adminId, DEFAULT_RATES);
  const fin = orders.submitDeliverable(id, prj, { kind: 'final' }, fake('final-only'));
  orders.reviewDeliverable(fin, acc, true);
  assert.equal(status(id), 'PREVIEW');
  orders.customerDecision(id, cus, { decision: 'ACCEPT' });
  assert.equal(status(id), 'AWAITING_PAYMENT');
});

test('demo đạt nhưng file gốc bị yêu cầu sửa → khách vẫn thấy demo của vòng này', () => {
  const id = toDeposit(6_000_000);
  finance.confirmPayment({ paymentId: finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 3_000_000, ref: 'e' }), adminId });
  assignment.startMatching(id, acc);
  assignment.setNeedsPm(id, acc, false);
  assignment.respond(assignment.invite(id, acc, prj.id, 'PROJECT'), prj.id, true);
  assignment.submitPlan(id, acc);
  assignment.approvePlan(id, adminId, DEFAULT_RATES);
  const demo = orders.submitDeliverable(id, prj, { kind: 'demo' }, fake('d2'));
  const fin = orders.submitDeliverable(id, prj, { kind: 'final' }, fake('f2'));
  orders.reviewDeliverable(demo, acc, true);
  assert.equal(status(id), 'IN_REVIEW', 'còn file gốc chờ kiểm duyệt');
  orders.reviewDeliverable(fin, acc, false, 'Thiếu font');
  assert.equal(status(id), 'DEMO');
});

test('dữ liệu tài chính đã chốt không sửa được; nhật ký không xóa được', () => {
  const p = db.get('SELECT id FROM payments WHERE confirmed_at IS NOT NULL LIMIT 1');
  assert.throws(() => db.run('UPDATE payments SET amount = 1 WHERE id = ?', p.id), /đã xác nhận/);
  const c = db.get("SELECT id FROM commissions WHERE status = 'APPROVED' LIMIT 1");
  assert.throws(() => db.run('UPDATE commissions SET amount = 1 WHERE id = ?', c.id), /đã chốt/);
  assert.throws(() => db.run('DELETE FROM audit_logs'), /chỉ cho phép thêm/);
});

test('freelancer không xem được Order không liên quan', () => {
  const access = require('../src/services/access');
  const other = db.get('SELECT * FROM users WHERE id = ?', pm2.id);
  other.roles = ['PM'];
  const id = db.get("SELECT id FROM orders WHERE status = 'COMPLETED' LIMIT 1").id;
  assert.equal(access.forOrder(other, id).any, false);
});

test('quyền chuyển trạng thái theo từng bên', () => {
  const id = newOrder();
  orders.submitOrder(id, cus);
  assert.throws(() => flow.transition(id, 'CONSULTING', cus), /không có quyền/, 'khách không tự chuyển sang Tư vấn');
  assert.throws(() => flow.transition(id, 'CONSULTING', prj.id), /không có quyền/, 'người không giữ vai trò Sales trong Order');
  assignment.claimIntake(id, sales.id);
  orders.createQuote(id, sales, { amount: 4_000_000, deposit_pct: 50, scope: 'S' });
  assert.throws(() => flow.transition(id, 'CONTRACT_SIGNED', sales.id), /không có quyền/, 'Sales không ký thay khách');
  orders.acceptQuote(db.get("SELECT id FROM quotes WHERE order_id = ? AND status = 'SENT'", id).id, cus, true);
  assert.equal(status(id), 'AWAITING_DEPOSIT');
  assert.throws(() => flow.transition(id, 'DEPOSITED', cus), /không có quyền/, 'khách không tự đánh dấu đã cọc');
  assert.throws(() => flow.transition(id, 'CANCELLED', sales.id), /không có quyền/);
});

test('M&T từ chối cung cấp dịch vụ: cần lý do, chỉ M&T mở lại', () => {
  const id = newOrder();
  orders.submitOrder(id, cus);
  assignment.claimIntake(id, sales.id);
  assert.throws(() => orders.rejectService(id, sales.id, 'x'), /không có quyền/);
  assert.throws(() => orders.rejectService(id, adminId, ''), /lý do/);
  orders.rejectService(id, adminId, 'Ngoài năng lực đội ngũ');
  assert.equal(status(id), 'REJECTED');
  assert.throws(() => orders.createQuote(id, sales, { amount: 1_000_000, scope: 'S' }), /chỉ M&T mở lại/);
  assert.equal(status(id), 'REJECTED');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM quotes WHERE order_id = ?', id).n, 0, 'báo giá bị hủy theo transaction');
  flow.transition(id, 'CONSULTING', adminId, 'M&T mở lại sau khi bổ sung nhân sự');
  assert.equal(status(id), 'CONSULTING');
});

test('hoa hồng: hai bên đồng ý mới duyệt; phản đối chặn duyệt; tranh chấp mở chặn đưa vào kỳ', () => {
  const id = toDeposit(10_000_000);
  const dep = finance.declarePayment({ orderId: id, actorId: cus, kind: 'deposit', amount: 5_000_000, ref: 'hh' });
  finance.confirmPayment({ paymentId: dep, adminId });
  assignment.startMatching(id, acc);
  assignment.setNeedsPm(id, acc, false);
  assignment.respond(assignment.invite(id, acc, prj.id, 'PROJECT'), prj.id, true);
  assignment.submitPlan(id, acc);
  assignment.approvePlan(id, adminId, DEFAULT_RATES);
  commission.reconcile({ orderId: id, adminId });
  assert.equal(db.get('SELECT status FROM payments WHERE id = ?', dep).status, 'RECONCILED');

  const line = db.get('SELECT * FROM commissions WHERE order_id = ? AND user_id = ?', id, prj.id);
  const st = () => db.get('SELECT status FROM commissions WHERE id = ?', line.id).status;
  assert.throws(() => commission.objectByUser({ id: line.id, userId: acc.id, reason: 'x' }), /Không tìm thấy/, 'không phản đối dòng của người khác');
  commission.objectByUser({ id: line.id, userId: prj.id, reason: 'Sai tỷ lệ phân công' });
  assert.equal(commission.approve({ ids: [line.id], adminId }), 0, 'dòng đang bị phản đối chưa duyệt được');
  commission.dismissObjection({ id: line.id, adminId, reason: 'Đúng theo phương án đã khóa' });
  commission.approve({ ids: [line.id], adminId });
  assert.equal(st(), 'PENDING_APPROVAL', 'còn chờ freelancer xác nhận lại');
  commission.confirmByUser({ ids: [line.id], userId: prj.id });
  assert.equal(st(), 'APPROVED');

  orders.raiseDispute(id, cus, { kind: 'complaint', title: 'Chậm tiến độ', body: 'Chưa thấy cập nhật' });
  assert.throws(() => commission.schedulePayout({ userId: prj.id, adminId, period: '2026-13' }), /YYYY-MM/);
  // prj còn dòng đã duyệt của Order ở bài kiểm thử trọn quy trình → kỳ này chỉ gom các dòng đó
  const other = commission.schedulePayout({ userId: prj.id, adminId, period: '2026-10' });
  assert.equal(db.get('SELECT COUNT(*) AS n FROM commissions WHERE payout_id = ? AND order_id = ?', other, id).n, 0);
  assert.equal(st(), 'APPROVED', 'Order còn tranh chấp mở → chưa vào kỳ');
  orders.resolveDispute(db.get("SELECT id FROM disputes WHERE order_id = ? AND status = 'OPEN'", id).id, adminId, { resolution: 'Đã cập nhật tiến độ' });
  const payoutId = commission.schedulePayout({ userId: prj.id, adminId, period: '2026-10' });
  assert.equal(st(), 'PAYABLE');
  assert.throws(() => commission.markPaid({ payoutId, adminId, ref: '' }), /mã giao dịch/);
  commission.markPaid({ payoutId, adminId, ref: 'CHI-T1' });
  assert.equal(st(), 'PAID');
  assert.throws(() => db.run('UPDATE commissions SET amount = 1 WHERE id = ?', line.id), /đã chốt/);
  const trail = db.all("SELECT to_status FROM status_history WHERE entity = 'commission' AND entity_id = ? ORDER BY id", line.id).map((h) => h.to_status);
  assert.deepEqual([...new Set(trail)], ['PENDING_APPROVAL', 'APPROVED', 'PAYABLE', 'PAID']);

  // Nhiệm vụ cũng có lịch sử riêng
  const t = orders.createTask(id, acc, { title: 'Thiết kế', assignee_id: prj.id });
  orders.setTaskStatus(t, prj, 'DOING');
  const th = db.all("SELECT from_status, to_status, actor_id FROM status_history WHERE entity = 'task' AND entity_id = ? ORDER BY id", t);
  assert.deepEqual(th.map((h) => [h.from_status, h.to_status]), [[null, 'TODO'], ['TODO', 'DOING']]);
  assert.equal(th[1].actor_id, prj.id);
});

test('lịch sử trạng thái: đánh dấu bước tự động, chỉ thêm không sửa', () => {
  const auto = db.get("SELECT data_json FROM status_history WHERE entity = 'order' AND to_status = 'AWAITING_DEPOSIT' LIMIT 1");
  assert.equal(JSON.parse(auto.data_json).auto, true);
  const entities = db.all('SELECT DISTINCT entity FROM status_history').map((r) => r.entity).sort();
  assert.deepEqual(entities, ['commission', 'order', 'payment', 'payout', 'task']);
  assert.throws(() => db.run("UPDATE status_history SET reason = 'sửa'"), /chỉ cho phép thêm/);
  assert.throws(() => db.run('DELETE FROM status_history'), /chỉ cho phép thêm/);
});

test('trang chủ: bảng tin không lộ Order nháp/hủy; xếp hạng đếm mỗi Order hoàn tất một lần', () => {
  const board = require('../src/services/board');
  const draft = newOrder();
  const feed = Object.keys(board.GROUPS).flatMap((group) => board.postedOrders({ group, viewerId: prj.id, limit: 1000 }));
  assert.ok(!feed.some((o) => o.id === draft), 'bản nháp không hiện');
  assert.ok(!feed.some((o) => ['CANCELLED', 'REJECTED', 'DRAFT'].includes(o.status)));
  assert.ok(!feed.length || !('customer_id' in feed[0]) && !('description' in feed[0]), 'không trả thông tin khách / mô tả');
  const done = db.get(
    "SELECT COUNT(DISTINCT a.order_id) AS n FROM order_assignments a JOIN orders o ON o.id = a.order_id WHERE a.user_id = ? AND a.status = 'LOCKED' AND o.status IN ('COMPLETED','CLOSED')", prj.id,
  ).n;
  const { top, me } = board.leaderboard(prj.id);
  assert.ok(done > 0);
  assert.equal(me.completed, done);
  assert.ok(top.every((m, i) => i === 0 || top[i - 1].completed >= m.completed), 'sắp xếp giảm dần');
  assert.ok(top.every((m) => m.completed > 0));
});

test('ảnh đại diện: chỉ nhận ảnh thật, thay ảnh thì xóa tệp cũ, ai đăng nhập cũng xem được', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3a1c7a80000000049454e44ae426082', 'hex');
  const put = (name, buf) => { fs.writeFileSync(path.join(files.ROOT, name), buf); return name; };
  assert.throws(() => accounts.setAvatar(prj.id, put('fake.png', '<svg onload=alert(1)>')), /không hợp lệ/, 'đuôi .png nhưng nội dung không phải ảnh');
  const first = put('a1.png', PNG);
  accounts.setAvatar(prj.id, first);
  const viewer = db.get('SELECT * FROM users WHERE id = ?', cus);
  assert.equal(files.resolve(viewer, 'avatar', prj.id).file, first);
  accounts.setAvatar(prj.id, put('a2.png', PNG));
  return new Promise((done) => setTimeout(() => {
    assert.equal(fs.existsSync(files.absolute(first)), false, 'tệp cũ đã bị xóa');
    accounts.setAvatar(prj.id, null);
    assert.equal(files.resolve(viewer, 'avatar', prj.id), null);
    done();
  }, 50));
});
