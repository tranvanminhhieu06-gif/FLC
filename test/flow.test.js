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
  assert.throws(() => flow.transition(id, 'COMPLETED', adminId), /chờ duyệt/);
  commission.approve({ ids: db.all("SELECT id FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'", id).map((r) => r.id), adminId });
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
