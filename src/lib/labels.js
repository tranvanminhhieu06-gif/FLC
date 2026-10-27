'use strict';
// Nguồn duy nhất cho nhãn tiếng Việt + màu badge (xem docs/DESIGN_SYSTEM.md)

const ORDER_STATUS = {
  DRAFT:                  { label: 'Bản nháp',         tone: 'neutral', step: 3 },
  PENDING_INTAKE:         { label: 'Chờ tiếp nhận',    tone: 'info',    step: 3 },
  CONSULTING:             { label: 'Tư vấn',           tone: 'info',    step: 4 },
  QUOTED:                 { label: 'Báo giá',          tone: 'info',    step: 4 },
  REJECTED:               { label: 'Từ chối báo giá',  tone: 'danger',  step: 4 },
  CONTRACT_SIGNED:        { label: 'Ký hợp đồng',      tone: 'brand',   step: 4 },
  AWAITING_DEPOSIT:       { label: 'Chờ cọc',          tone: 'warn',    step: 4 },
  DEPOSITED:              { label: 'Đã cọc',           tone: 'brand',   step: 4 },
  CANCELLED:              { label: 'Hủy',              tone: 'danger',  step: 4 },
  MATCHING:               { label: 'Đang ghép',        tone: 'violet',  step: 5 },
  PENDING_MATCH_APPROVAL: { label: 'Chờ duyệt ghép',   tone: 'warn',    step: 5 },
  IN_PROGRESS:            { label: 'Đang triển khai',  tone: 'brand',   step: 6 },
  IN_REVIEW:              { label: 'Đang kiểm duyệt',  tone: 'warn',    step: 6 },
  DEMO:                   { label: 'Demo',             tone: 'violet',  step: 6 },
  PREVIEW:                { label: 'Preview',          tone: 'violet',  step: 6 },
  AWAITING_PAYMENT:       { label: 'Chờ thanh toán',   tone: 'warn',    step: 7 },
  ACCEPTANCE:             { label: 'Nghiệm thu',       tone: 'brand',   step: 7 },
  RECONCILIATION:         { label: 'Đối soát',         tone: 'violet',  step: 7 },
  COMPLETED:              { label: 'Hoàn tất',         tone: 'success', step: 7 },
  CLOSED:                 { label: 'Đã đóng',          tone: 'neutral', step: 7 },
};

const STEPS = [
  { n: 1, name: 'Đăng ký', sub: 'Tạo tài khoản' },
  { n: 2, name: 'Duyệt', sub: 'M&T kiểm định' },
  { n: 3, name: 'Đăng Order', sub: 'Gửi yêu cầu' },
  { n: 4, name: 'Báo giá & cọc', sub: 'Sales · Account' },
  { n: 5, name: 'Ghép nhân sự', sub: 'Account · PM' },
  { n: 6, name: 'Triển khai', sub: 'Demo · nghiệm thu' },
  { n: 7, name: 'Thanh toán', sub: 'Đối soát · đóng' },
];

const ROLES = {
  REFERRER: { label: 'Referrer', full: 'Referrer – Người giới thiệu', desc: 'Ghi nhận khách hàng tiềm năng, gửi giới thiệu, theo dõi hoa hồng' },
  SALES:    { label: 'Sales',    full: 'Sales – Kinh doanh',          desc: 'Tiếp nhận cơ hội, tư vấn, báo giá, đàm phán, chốt hợp đồng' },
  ACCOUNT:  { label: 'Account',  full: 'Account – Quản lý khách hàng', desc: 'Làm rõ yêu cầu, quản lý trao đổi, ghép nhân sự, xử lý phản hồi' },
  PM:       { label: 'PM',       full: 'PM – Quản lý dự án',          desc: 'Lập kế hoạch, phân công, theo dõi tiến độ, kiểm soát chất lượng' },
  PROJECT:  { label: 'Project',  full: 'Project – Triển khai dự án',  desc: 'Nhận nhiệm vụ chuyên môn, cập nhật tiến độ, nộp sản phẩm' },
  MT:       { label: 'M&T',      full: 'M&T Group',                   desc: 'Quản trị, kiểm duyệt' },
};
const FREELANCER_ROLES = ['REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT'];

const ACCOUNT_STATUS = {
  PENDING:    { label: 'Chờ duyệt',      tone: 'warn' },
  NEEDS_INFO: { label: 'Cần bổ sung',    tone: 'info' },
  ACTIVE:     { label: 'Đã duyệt',       tone: 'success' },
  REJECTED:   { label: 'Từ chối',        tone: 'danger' },
  SUSPENDED:  { label: 'Tạm dừng',       tone: 'neutral' },
};

const ASSIGNMENT_STATUS = {
  INVITED:  { label: 'Đã mời',       tone: 'info' },
  ACCEPTED: { label: 'Đã nhận',      tone: 'brand' },
  DECLINED: { label: 'Từ chối',      tone: 'neutral' },
  EXPIRED:  { label: 'Hết hiệu lực', tone: 'neutral' },
  LOCKED:   { label: 'Đã khóa',      tone: 'success' },
  REVOKED:  { label: 'Thu hồi',      tone: 'danger' },
};

const COMMISSION_STATUS = {
  PENDING_APPROVAL: { label: 'Chờ duyệt',  tone: 'warn' },
  APPROVED:         { label: 'Đã duyệt',   tone: 'brand' },
  PAID:             { label: 'Đã chi trả', tone: 'success' },
  VOID:             { label: 'Hủy',        tone: 'danger' },
  RETAINED:         { label: 'M&T giữ lại', tone: 'neutral' },
};

const PAYMENT_KIND = { deposit: 'Đặt cọc', installment: 'Thanh toán đợt', refund: 'Hoàn tiền' };
const DELIVERABLE_KIND = { demo: 'Demo', preview: 'Preview', final: 'File gốc' };
const REVIEW_STATUS = {
  PENDING: { label: 'Chờ kiểm duyệt', tone: 'warn' },
  APPROVED: { label: 'Đạt — đã gửi khách', tone: 'success' },
  CHANGES: { label: 'Yêu cầu sửa', tone: 'danger' },
};
const TASK_STATUS = {
  TODO: { label: 'Cần làm', tone: 'neutral' },
  DOING: { label: 'Đang làm', tone: 'info' },
  SUBMITTED: { label: 'Đã nộp', tone: 'warn' },
  DONE: { label: 'Hoàn thành', tone: 'success' },
};
const DISPUTE_KIND = { complaint: 'Khiếu nại', refund: 'Yêu cầu hoàn tiền', change_request: 'Thay đổi phạm vi', support: 'Hỗ trợ' };
const DISPUTE_STATUS = {
  OPEN: { label: 'Đang mở', tone: 'warn' },
  RESOLVED: { label: 'Đã giải quyết', tone: 'success' },
  REJECTED: { label: 'Bác bỏ', tone: 'neutral' },
};
const LEAD_STATUS = {
  NEW: { label: 'Mới', tone: 'info' },
  CONTACTED: { label: 'Đã liên hệ', tone: 'violet' },
  CONVERTED: { label: 'Đã thành khách', tone: 'success' },
  LOST: { label: 'Không thành', tone: 'neutral' },
};

const SERVICE_TYPES = [
  'Thiết kế website', 'Phát triển ứng dụng', 'Thiết kế đồ họa & nhận diện', 'Marketing & quảng cáo',
  'Sản xuất nội dung / video', 'Dịch thuật', 'Tư vấn & phân tích dữ liệu', 'Khác',
];

const DEFAULT_RATES = { REFERRER: 500, SALES: 1000, ACCOUNT: 1000, PM: 1000, PROJECT: 5000, MT: 1500 };

module.exports = {
  ORDER_STATUS, STEPS, ROLES, FREELANCER_ROLES, ACCOUNT_STATUS, ASSIGNMENT_STATUS, COMMISSION_STATUS,
  PAYMENT_KIND, DELIVERABLE_KIND, REVIEW_STATUS, TASK_STATUS, DISPUTE_KIND, DISPUTE_STATUS, LEAD_STATUS,
  SERVICE_TYPES, DEFAULT_RATES,
};
