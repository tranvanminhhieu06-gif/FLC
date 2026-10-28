'use strict';
// Nguồn duy nhất cho nhãn tiếng Việt + màu badge (xem docs/DESIGN_SYSTEM.md)

// Bảng trạng thái M&T: mã cố định tiếng Anh lưu trong CSDL, `code` (STTn) + tên + ý nghĩa tiếng Việt chỉ để hiển thị
const ORDER_STATUS = {
  DRAFT:                  { code: 'STT1',  label: 'Bản nháp',        tone: 'neutral', step: 3, desc: 'Customer đang tạo Order, chưa gửi.' },
  PENDING_INTAKE:         { code: 'STT2',  label: 'Chờ tiếp nhận',   tone: 'info',    step: 3, desc: 'Order đã gửi, chờ Sales kiểm tra.' },
  CONSULTING:             { code: 'STT3',  label: 'Tư vấn',          tone: 'info',    step: 4, desc: 'Sales đang tư vấn. Sales và Account xác định phạm vi, giá và tiến độ.' },
  QUOTED:                 { code: 'STT4',  label: 'Báo giá',         tone: 'info',    step: 4, desc: 'Đã gửi báo giá và điều khoản hợp đồng.' },
  REJECTED:               { code: 'STT5',  label: 'Từ chối',         tone: 'danger',  step: 4, desc: 'Khách từ chối báo giá hoặc M&T từ chối cung cấp dịch vụ.' },
  CONTRACT_SIGNED:        { code: 'STT6',  label: 'Ký hợp đồng',     tone: 'brand',   step: 4, desc: 'Khách đã xác nhận báo giá, đang ký hợp đồng.' },
  AWAITING_DEPOSIT:       { code: 'STT7',  label: 'Chờ cọc',         tone: 'warn',    step: 4, desc: 'Đã ký hợp đồng, chờ hoàn thành điều kiện đặt cọc.' },
  DEPOSITED:              { code: 'STT8',  label: 'Đã cọc',          tone: 'brand',   step: 4, desc: 'Đã đáp ứng điều kiện chốt đơn theo thỏa thuận.' },
  CANCELLED:              { code: 'STT9',  label: 'Hủy',             tone: 'danger',  step: 4, desc: 'Hai bên thống nhất chấm dứt Order (kể cả khi khách đã đặt cọc nhưng không triển khai nữa).' },
  MATCHING:               { code: 'STT10', label: 'Đang ghép',       tone: 'violet',  step: 5, desc: 'Đưa ra tỷ lệ phần trăm, kế hoạch phân công và chờ ghép PM, người triển khai.' },
  PENDING_MATCH_APPROVAL: { code: 'STT11', label: 'Chờ duyệt ghép',  tone: 'warn',    step: 5, desc: 'Chờ M&T duyệt phương án nhân sự và tỷ lệ.' },
  IN_PROGRESS:            { code: 'STT12', label: 'Đang triển khai', tone: 'brand',   step: 6, desc: 'Nhân sự đang thực hiện các đầu việc.' },
  IN_REVIEW:              { code: 'STT13', label: 'Đang kiểm duyệt', tone: 'warn',    step: 6, desc: 'Account hoặc PM kiểm tra sản phẩm.' },
  DEMO:                   { code: 'STT14', label: 'Demo',            tone: 'violet',  step: 6, desc: 'Khách xem demo hoặc sản phẩm theo phạm vi được phép. Nhân sự xử lý phản hồi hợp lệ và chỉnh sửa.' },
  PREVIEW:                { code: 'STT15', label: 'Preview',         tone: 'violet',  step: 6, desc: 'Demo đã được khách đồng ý, bản final đã tải lên nhưng khách chưa được xem hay tải về.' },
  AWAITING_PAYMENT:       { code: 'STT16', label: 'Chờ thanh toán',  tone: 'warn',    step: 7, desc: 'Chờ khách thanh toán phần còn lại.' },
  ACCEPTANCE:             { code: 'STT17', label: 'Nghiệm thu',      tone: 'brand',   step: 7, desc: 'Khách đã thanh toán, mở bản final; nhân sự hỗ trợ bàn giao và khách ký nghiệm thu.' },
  RECONCILIATION:         { code: 'STT18', label: 'Đối soát',        tone: 'violet',  step: 7, desc: 'Kiểm tra doanh thu, các khoản phân bổ, xử lý tranh chấp; khách hàng và toàn bộ nhân sự xác nhận chi phí/doanh thu.' },
  COMPLETED:              { code: 'STT19', label: 'Hoàn tất',        tone: 'success', step: 7, desc: 'Đã đáp ứng điều kiện hoàn thành Order.' },
  CLOSED:                 { code: 'STT20', label: 'Đã đóng',         tone: 'neutral', step: 7, desc: 'Hồ sơ Order đã được đóng theo quy trình lưu trữ.' },
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
  DEV:      { label: 'Coder web', full: 'Coder web – Người xây dựng nền tảng FLC', desc: 'Phí phát triển & vận hành nền tảng, tính trên mọi Order' },
  MT:       { label: 'M&T',      full: 'M&T Group',                   desc: 'Quản trị, kiểm duyệt' },
};
/** Thứ tự các phần chia doanh thu — định nghĩa trong module dùng chung với trình duyệt */
const { RATE_KEYS } = require('../../public/js/revenue-core');
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
  PENDING_APPROVAL: { code: 'STT21', label: 'Chờ duyệt',      tone: 'warn',    desc: 'Khoản hoa hồng đã được ghi nhận, chờ các bên kiểm tra và duyệt, gồm freelancer và M&T.' },
  APPROVED:         { code: 'STT22', label: 'Đã duyệt',       tone: 'brand',   desc: 'Khoản hoa hồng được các bên đồng ý, không có tranh chấp.' },
  PAYABLE:          { code: 'STT23', label: 'Chờ thanh toán', tone: 'info',    desc: 'Đã đủ điều kiện đưa vào kỳ thanh toán.' },
  PAID:             { code: 'STT24', label: 'Đã thanh toán',  tone: 'success', desc: 'Đã chi trả và ghi nhận giao dịch.' },
  VOID:             { label: 'Hủy',         tone: 'danger',  desc: 'Dòng bị M&T hủy kèm lý do (vẫn giữ trong sổ để truy vết).' },
  RETAINED:         { label: 'M&T giữ lại', tone: 'neutral', desc: 'Phần của M&T hoặc phần vai trò không có người nhận.' },
};

const PAYMENT_STATUS = {
  DECLARED:   { label: 'Chờ xác nhận', tone: 'warn',    desc: 'Khách báo đã chuyển khoản, chờ M&T đối chiếu sao kê.' },
  CONFIRMED:  { label: 'Đã xác nhận',  tone: 'brand',   desc: 'M&T đã xác nhận thực thu; số tiền bị khóa.' },
  REJECTED:   { label: 'Từ chối',      tone: 'danger',  desc: 'Không tìm thấy giao dịch hoặc sai thông tin; không tính vào thực thu.' },
  RECONCILED: { label: 'Đã đối soát',  tone: 'success', desc: 'Đã tính hoa hồng cho khoản thu này.' },
};

const PAYOUT_STATUS = {
  SCHEDULED: { label: 'Chờ chi', tone: 'info' },
  PAID:      { label: 'Đã chi',  tone: 'success' },
};

/** Tình trạng thanh toán ở cấp Order — suy ra từ payment_status của từng khoản, không lưu riêng */
const ORDER_PAYMENT_STATE = {
  NO_CONTRACT:      { label: 'Chưa có hợp đồng',   tone: 'neutral' },
  AWAITING_DEPOSIT: { label: 'Chưa đủ cọc',        tone: 'warn' },
  PARTIAL:          { label: 'Đã cọc, còn phải thu', tone: 'info' },
  PAID_IN_FULL:     { label: 'Đã thanh toán đủ',   tone: 'success' },
};

/** Bốn trường trạng thái độc lập (+ kỳ chi trả) dùng trong status_history */
const HISTORY_ENTITY = {
  order:      { label: 'Order',      field: 'order_status' },
  task:       { label: 'Nhiệm vụ',   field: 'task_status' },
  payment:    { label: 'Thanh toán', field: 'payment_status' },
  commission: { label: 'Hoa hồng',   field: 'commission_status' },
  payout:     { label: 'Kỳ chi trả', field: 'payout_status' },
};

const PAYMENT_KIND = { deposit: 'Đặt cọc', installment: 'Thanh toán đợt', refund: 'Hoàn tiền' };
const DELIVERABLE_KIND = { demo: 'Demo', preview: 'Preview', final: 'File gốc' };
const REVIEW_STATUS = {
  PENDING: { label: 'Chờ kiểm duyệt', tone: 'warn' },
  APPROVED: { label: 'Đạt — đã gửi khách', tone: 'success' },
  CHANGES: { label: 'Yêu cầu sửa', tone: 'danger' },
};
const TASK_STATUS = {
  TODO:      { label: 'Cần làm',    tone: 'neutral', desc: 'Đã giao, chưa bắt đầu.' },
  DOING:     { label: 'Đang làm',   tone: 'info',    desc: 'Người nhận đang thực hiện.' },
  SUBMITTED: { label: 'Đã nộp',     tone: 'warn',    desc: 'Đã nộp sản phẩm, chờ PM/Account kiểm duyệt.' },
  DONE:      { label: 'Hoàn thành', tone: 'success', desc: 'PM/Account xác nhận hoàn thành.' },
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

// Bảng "Full" M&T chốt 28/10/2026: 5 · 10 · 5 · 10 · 40 · 4 (Coder web) · 26 (M&T)
const DEFAULT_RATES = { REFERRER: 500, SALES: 1000, ACCOUNT: 500, PM: 1000, PROJECT: 4000, DEV: 400, MT: 2600 };
const DEFAULT_VAT_PCT = 10; // dùng để ƯỚC TÍNH doanh thu thuần khi Order chưa có khoản thu nào

HISTORY_ENTITY.order.statuses = ORDER_STATUS;
HISTORY_ENTITY.task.statuses = TASK_STATUS;
HISTORY_ENTITY.payment.statuses = PAYMENT_STATUS;
HISTORY_ENTITY.commission.statuses = COMMISSION_STATUS;
HISTORY_ENTITY.payout.statuses = PAYOUT_STATUS;

module.exports = {
  ORDER_STATUS, STEPS, ROLES, FREELANCER_ROLES, ACCOUNT_STATUS, ASSIGNMENT_STATUS, COMMISSION_STATUS, PAYMENT_STATUS, PAYOUT_STATUS,
  ORDER_PAYMENT_STATE, HISTORY_ENTITY,
  PAYMENT_KIND, DELIVERABLE_KIND, REVIEW_STATUS, TASK_STATUS, DISPUTE_KIND, DISPUTE_STATUS, LEAD_STATUS,
  SERVICE_TYPES, DEFAULT_RATES, DEFAULT_VAT_PCT, RATE_KEYS,
};
