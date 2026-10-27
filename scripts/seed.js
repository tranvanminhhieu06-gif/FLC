'use strict';
/**
 * Tạo dữ liệu demo bằng chính các service nghiệp vụ (nên cũng là một bài kiểm thử tích hợp).
 *   npm run seed            — chỉ chạy khi CSDL trống
 *   npm run seed -- --reset — xóa CSDL + tệp đã tải lên rồi tạo lại
 *
 * Tài khoản demo (chỉ dùng cho môi trường phát triển):
 *   Admin M&T     admin@flc.local      / mật khẩu: biến FLC_ADMIN_PASSWORD hoặc "FlcAdmin@2026"
 *   Mọi tài khoản demo khác             / mật khẩu "Demo@12345"
 *   Customer: khach.an@demo.local, khach.binh@demo.local, khach.moi@demo.local (chờ duyệt)
 *   Freelancer: referrer@ · sales@ · account@ · pm@ · project1@ · project2@ · da.vai.tro@ (chờ duyệt)  (@demo.local)
 *   Coder web (nhận 4% mọi Order): coder@demo.local
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
if (process.argv.includes('--reset')) {
  for (const f of ['flc.db', 'flc.db-wal', 'flc.db-shm']) fs.rmSync(path.join(ROOT, 'data', f), { force: true });
  fs.rmSync(path.join(ROOT, 'storage', 'private'), { recursive: true, force: true });
}

const db = require('../src/db');
const password = require('../src/lib/password');
const { nextCode } = require('../src/services/core');
const accounts = require('../src/services/accounts');
const orders = require('../src/services/orders');
const assignment = require('../src/services/assignment');
const finance = require('../src/services/finance');
const commission = require('../src/services/commission');
const flow = require('../src/services/orderFlow');
const files = require('../src/services/files');
const { DEFAULT_RATES } = require('../src/lib/labels');

if (db.get('SELECT COUNT(*) AS n FROM users').n > 0) {
  console.log('CSDL đã có dữ liệu — bỏ qua. Dùng "npm run seed -- --reset" để tạo lại.');
  process.exit(0);
}

const PASS = 'Demo@12345';
const ADMIN_PASS = process.env.FLC_ADMIN_PASSWORD || 'FlcAdmin@2026';

/** Tạo tệp mẫu trong kho private */
function sample(name, content = 'Tệp mẫu FLC') {
  const stored = `seed-${Math.random().toString(36).slice(2)}-${name}`;
  fs.writeFileSync(path.join(files.ROOT, stored), content);
  return { path: stored, name };
}

// --- M&T Admin ---
const adminId = db.tx(() => db.run(
  "INSERT INTO users (code, kind, email, password_hash, full_name, status) VALUES (?, 'admin', 'admin@flc.local', ?, 'M&T Admin', 'ACTIVE')",
  nextCode('MT'), password.hash(ADMIN_PASS),
).lastInsertRowid);
const admin = { id: adminId, kind: 'admin' };
commission.setPolicy({ adminId, name: 'Bảng Full 2026 (có Coder web 4%)', rates: DEFAULT_RATES, reason: 'Khởi tạo theo bảng tỷ lệ M&T' });

// --- Freelancer ---
function freelancer(key, fullName, roles, extra = {}) {
  const r = accounts.registerFreelancer({
    full_name: fullName, dob: '1996-05-12', phone: extra.phone, email: `${key}@demo.local`,
    password: PASS, password2: PASS, member_code: extra.member || key.replace(/\d/g, '') + '.flc' + (key.match(/\d/)?.[0] || ''),
    roles, skills: extra.skills, experience: extra.exp || '3 năm làm việc tự do', portfolio: extra.portfolio || 'https://portfolio.demo.local',
    service_types: extra.services || ['Thiết kế website'], bank_name: 'Vietcombank', bank_account: extra.bank || '0011001234567',
  }, { cv: sample('cv.pdf'), id_front: sample('cccd-truoc.jpg'), id_back: sample('cccd-sau.jpg') });
  if (r.errors) throw new Error(`${key}: ${JSON.stringify(r.errors)}`);
  return r.id;
}
const fl = {
  referrer: freelancer('referrer', 'Lê Thu Hà', ['REFERRER'], { phone: '0901000001', member: 'thuha.gt', skills: 'Kết nối doanh nghiệp, networking' }),
  sales: freelancer('sales', 'Phạm Quốc Bảo', ['SALES'], { phone: '0901000002', skills: 'Tư vấn giải pháp, đàm phán, website' }),
  account: freelancer('account', 'Nguyễn Minh Châu', ['ACCOUNT'], { phone: '0901000003', skills: 'Quản lý khách hàng, phân tích yêu cầu website' }),
  pm: freelancer('pm', 'Trần Đức Dũng', ['PM'], { phone: '0901000004', skills: 'Quản lý dự án Agile, website, ứng dụng' }),
  p1: freelancer('project1', 'Võ Hoàng Em', ['PROJECT'], { phone: '0901000005', skills: 'Next.js, Node.js, thiết kế website' }),
  p2: freelancer('project2', 'Đặng Gia Phúc', ['PROJECT'], { phone: '0901000006', skills: 'Figma, UI/UX, thiết kế đồ họa, nhận diện', services: ['Thiết kế đồ họa & nhận diện', 'Thiết kế website'] }),
  multi: freelancer('da.vai.tro', 'Bùi Ngọc Giang', ['REFERRER', 'SALES'], { phone: '0901000007', member: 'giang.multi', skills: 'Bán hàng B2B' }),
  coder: freelancer('coder', 'Hiếu', ['PROJECT'], { phone: '0901000008', member: 'hieu.coder', skills: 'Node.js, xây dựng nền tảng FLC' }),
};
for (const [k, id] of Object.entries(fl)) {
  if (k === 'multi') continue;
  const roles = db.all('SELECT role FROM user_roles WHERE user_id = ?', id).map((r) => r.role);
  accounts.review(id, adminId, { decision: 'approve', roles });
}
commission.setDevUser({ adminId, userId: fl.coder, reason: 'Người xây dựng nền tảng' });

// --- Khách hàng ---
function customer(key, name, extra = {}) {
  const r = accounts.registerCustomer({ full_name: name, email: `${key}@demo.local`, password: PASS, password2: PASS, ...extra });
  if (r.errors) throw new Error(`${key}: ${JSON.stringify(r.errors)}`);
  return r.id;
}
const cu = {
  an: customer('khach.an', 'Công ty TNHH An Phát', { company: 'An Phát Co.', referrer_code: 'thuha.gt' }),
  binh: customer('khach.binh', 'Hoàng Thị Bình', { phone: '0912000002' }),
  moi: customer('khach.moi', 'Khách mới chờ duyệt'),
};
accounts.review(cu.an, adminId, { decision: 'approve' });
accounts.review(cu.binh, adminId, { decision: 'approve' });

const sales = { id: fl.sales, kind: 'freelancer' };
const account = { id: fl.account, kind: 'freelancer' };
const pm = { id: fl.pm, kind: 'freelancer' };
const p1 = { id: fl.p1, kind: 'freelancer' };

// --- Order A: trọn quy trình tới Đã đóng (có Referrer, có PM, 2 Project, thanh toán 2 đợt) ---
const A = orders.create(cu.an, {
  title: 'Website giới thiệu công ty An Phát', service_type: 'Thiết kế website',
  description: 'Website 6 trang: Trang chủ, Giới thiệu, Dịch vụ, Dự án, Tin tức, Liên hệ. Có trang quản trị tin tức.',
  goals: 'Tăng nhận diện thương hiệu, thu lead từ form liên hệ', deliverables: 'Mã nguồn, file thiết kế Figma, hướng dẫn quản trị',
  budget: 45000000, deadline: '2026-12-15', contact_info: 'Anh Tuấn — phòng Marketing', invoice_info: 'Công ty TNHH An Phát · MST 0312345678 · ketoan@anphat.vn',
}, true);
assignment.claimIntake(A, fl.sales);
assignment.claimAccount(A, fl.account);
orders.createQuote(A, sales, { amount: 50000000, deposit_pct: 40, scope: '6 trang + CMS tin tức, responsive, SEO cơ bản', timeline: 'Thiết kế 2 tuần · Lập trình 3 tuần · Kiểm thử 1 tuần', terms: '2 vòng chỉnh sửa miễn phí, bảo hành 6 tháng' });
const qA = db.get("SELECT id FROM quotes WHERE order_id = ? AND status = 'SENT'", A).id;
orders.acceptQuote(qA, cu.an, true);
const depA = finance.declarePayment({ orderId: A, actorId: cu.an, kind: 'deposit', amount: 20000000, method: 'Chuyển khoản', ref: 'VCB123456' });
finance.confirmPayment({ paymentId: depA, adminId, tax: 1818182 });
assignment.startMatching(A, account);
assignment.setNeedsPm(A, account, true);
const invPm = assignment.invite(A, account, fl.pm, 'PM');
assignment.respond(invPm, fl.pm, true);
const i1 = assignment.invite(A, pm, fl.p1, 'PROJECT', 6000);
const i2 = assignment.invite(A, pm, fl.p2, 'PROJECT', 4000);
assignment.respond(i1, fl.p1, true);
assignment.respond(i2, fl.p2, true);
assignment.submitPlan(A, account);
assignment.approvePlan(A, adminId, DEFAULT_RATES);
const tA1 = orders.createTask(A, pm, { title: 'Thiết kế giao diện Figma', assignee_id: fl.p2, due_date: '2026-11-10' });
const tA2 = orders.createTask(A, pm, { title: 'Lập trình front-end + CMS', assignee_id: fl.p1, due_date: '2026-12-01' });
const dDemo = orders.submitDeliverable(A, p1, { kind: 'demo', title: 'Bản demo trang chủ', task_id: tA2 }, sample('demo.pdf', 'Demo An Phát'));
orders.reviewDeliverable(dDemo, pm, false, 'Cần chỉnh màu header theo brand guideline');
const dDemo2 = orders.submitDeliverable(A, p1, { kind: 'demo', title: 'Bản demo trang chủ (đã sửa)', task_id: tA2 }, sample('demo-v2.pdf', 'Demo An Phát v2'));
orders.reviewDeliverable(dDemo2, pm, true, 'Đạt');
orders.submitDeliverable(A, p1, { kind: 'final', title: 'Mã nguồn hoàn chỉnh' }, sample('source.zip', 'zip'));
orders.reviewDeliverable(db.get("SELECT id FROM deliverables WHERE order_id = ? AND kind = 'final'", A).id, pm, true, 'Đạt');
orders.setTaskStatus(tA1, pm, 'DONE');
orders.setTaskStatus(tA2, pm, 'DONE');
orders.postMessage(A, cu.an, 'Bản demo rất ổn, chỉ mong logo to hơn một chút.');
orders.postMessage(A, fl.pm, 'Đã ghi nhận, đội sẽ cập nhật trong bản chính thức.');
orders.customerDecision(A, cu.an, { decision: 'ACCEPT', deliverable_id: dDemo2 });
const finA = finance.declarePayment({ orderId: A, actorId: cu.an, kind: 'installment', amount: 30000000, method: 'Chuyển khoản', ref: 'VCB654321' });
finance.confirmPayment({ paymentId: finA, adminId, tax: 2727273 });
orders.signOff(A, cu.an, 'Đã nhận đủ sản phẩm');
commission.reconcile({ orderId: A, adminId });
commission.approve({ ids: db.all("SELECT id FROM commissions WHERE order_id = ? AND status = 'PENDING_APPROVAL'", A).map((r) => r.id), adminId });
flow.transition(A, 'COMPLETED', adminId, 'M&T xác nhận hoàn tất đối soát');
commission.payout({ userId: fl.p1, adminId, ref: 'CHI-0001' });
commission.payout({ userId: fl.pm, adminId, ref: 'CHI-0002' });
flow.transition(A, 'CLOSED', adminId, 'Đóng Order');
// Lùi ngày khoản thu để biểu đồ 12 tháng có dữ liệu (chỉ dữ liệu demo)
db.run("UPDATE payments SET confirmed_at = datetime('now', '-62 days'), created_at = datetime('now', '-62 days') WHERE id = ?", depA);
db.run("UPDATE payments SET confirmed_at = datetime('now', '-25 days'), created_at = datetime('now', '-25 days') WHERE id = ?", finA);

// --- Order B: không Referrer, không PM (Account kiêm PM), đang kiểm duyệt ---
const B = orders.create(cu.binh, {
  title: 'Bộ nhận diện thương hiệu quán cà phê', service_type: 'Thiết kế đồ họa & nhận diện',
  description: 'Logo, bảng màu, menu, biển hiệu, mẫu bài đăng mạng xã hội', budget: 18000000, deadline: '2026-11-30',
}, true);
assignment.claimIntake(B, fl.sales);
assignment.claimAccount(B, fl.account);
orders.createQuote(B, account, { amount: 20000000, deposit_pct: 50, scope: 'Logo (3 phương án), bộ nhận diện 12 hạng mục', timeline: '3 tuần' });
orders.acceptQuote(db.get("SELECT id FROM quotes WHERE order_id = ? AND status = 'SENT'", B).id, cu.binh, true);
const depB = finance.declarePayment({ orderId: B, actorId: cu.binh, kind: 'deposit', amount: 10000000, ref: 'TCB778899' });
finance.confirmPayment({ paymentId: depB, adminId });
db.run("UPDATE payments SET confirmed_at = datetime('now', '-9 days'), created_at = datetime('now', '-9 days') WHERE id = ?", depB);
assignment.startMatching(B, account);
assignment.setNeedsPm(B, account, false);
assignment.respond(assignment.invite(B, account, fl.p2, 'PROJECT', 10000), fl.p2, true);
assignment.submitPlan(B, account);
assignment.approvePlan(B, adminId, DEFAULT_RATES);
const tB = orders.createTask(B, account, { title: 'Phác thảo 3 phương án logo', assignee_id: fl.p2, due_date: '2026-11-05' });
orders.submitDeliverable(B, { id: fl.p2, kind: 'freelancer' }, { kind: 'preview', title: '3 phương án logo', task_id: tB }, sample('logo-preview.png', 'png'));
commission.reconcile({ orderId: B, adminId });   // đối soát đợt cọc → hoa hồng chờ duyệt

// --- Order C: đang chờ khách xác nhận báo giá ---
const C = orders.create(cu.an, { title: 'Chiến dịch quảng cáo Tết 2027', service_type: 'Marketing & quảng cáo', description: 'Quảng cáo Facebook + TikTok cho dòng sản phẩm mới', budget: 60000000, deadline: '2027-01-20' }, true);
assignment.claimIntake(C, fl.sales);
orders.createQuote(C, sales, { amount: 65000000, deposit_pct: 30, scope: 'Kế hoạch nội dung, 20 video ngắn, chạy quảng cáo 6 tuần', timeline: '8 tuần' });

// --- Order D: mới gửi, chờ Sales tiếp nhận · Order E: bản nháp ---
orders.create(cu.binh, { title: 'Ứng dụng đặt bàn cho quán', service_type: 'Phát triển ứng dụng', description: 'App đặt bàn + tích điểm khách hàng thân thiết', budget: 80000000, deadline: '2027-03-01' }, true);
orders.create(cu.an, { title: 'Dịch catalogue sang tiếng Anh', service_type: 'Dịch thuật', description: 'Catalogue 40 trang' }, false);

db.run("INSERT INTO leads (referrer_id, name, contact, need) VALUES (?, 'Nhà hàng Sen Vàng', '0988777666', 'Cần làm website đặt bàn')", fl.referrer);

console.log('Đã tạo dữ liệu demo.');
console.log('  Order:', db.all('SELECT code, status FROM orders').map((o) => `${o.code}=${o.status}`).join(', '));
console.log('  Tài khoản: xem đầu tệp scripts/seed.js');
