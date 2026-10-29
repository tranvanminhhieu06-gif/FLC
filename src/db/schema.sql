-- FLC schema (SQLite). Tiền: INTEGER VND. Tỷ lệ: INTEGER basis point (1% = 100).
-- Viết SQL chuẩn để chuyển sang PostgreSQL: INTEGER PRIMARY KEY -> BIGSERIAL, TEXT datetime -> TIMESTAMPTZ.

CREATE TABLE IF NOT EXISTS sequences (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('customer', 'freelancer', 'admin')),
  email         TEXT UNIQUE,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT,
  avatar_file   TEXT,                       -- ảnh đại diện trong storage/private
  status        TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'NEEDS_INFO', 'ACTIVE', 'REJECTED', 'SUSPENDED')),
  status_note   TEXT,
  approved_by   INTEGER REFERENCES users(id),
  approved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id     INTEGER NOT NULL REFERENCES users(id),
  role        TEXT NOT NULL CHECK (role IN ('REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT')),
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REJECTED')),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS customer_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  company       TEXT,
  tax_code      TEXT,
  address       TEXT,
  referrer_code TEXT,
  referrer_id   INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS freelancer_profiles (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id),
  dob           TEXT,
  member_code   TEXT NOT NULL UNIQUE,
  skills        TEXT,
  experience    TEXT,
  portfolio     TEXT,
  service_types TEXT,
  bank_name     TEXT,
  bank_account  TEXT,
  bank_holder   TEXT,
  cv_file       TEXT,
  id_front_file TEXT,
  id_back_file  TEXT,
  availability  TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (availability IN ('AVAILABLE', 'BUSY', 'AWAY'))
);

CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY,
  referrer_id INTEGER NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL,
  need        TEXT,
  status      TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'CONTACTED', 'CONVERTED', 'LOST')),
  customer_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                       INTEGER PRIMARY KEY,
  code                     TEXT UNIQUE,
  customer_id              INTEGER NOT NULL REFERENCES users(id),
  referrer_id              INTEGER REFERENCES users(id),
  title                    TEXT NOT NULL,
  service_type             TEXT NOT NULL,
  description              TEXT,
  goals                    TEXT,
  deliverables             TEXT,
  budget                   INTEGER,
  deadline                 TEXT,
  contact_info             TEXT,
  invoice_info             TEXT,               -- chỉ Admin xem
  status                   TEXT NOT NULL DEFAULT 'DRAFT',
  needs_pm                 INTEGER,             -- NULL = chưa quyết, 0/1
  deposit_exception        INTEGER NOT NULL DEFAULT 0,
  deposit_exception_reason TEXT,
  submitted_at             TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);

-- Lịch sử trạng thái dùng chung cho 4 trường độc lập: order_status, task_status, payment_status, commission_status
-- (và kỳ chi trả). Chỉ thêm mới: trạng thái cũ, mới, người thao tác, thời điểm, lý do, dữ liệu liên quan.
CREATE TABLE IF NOT EXISTS status_history (
  id          INTEGER PRIMARY KEY,
  entity      TEXT NOT NULL CHECK (entity IN ('order', 'task', 'payment', 'commission', 'payout')),
  entity_id   INTEGER NOT NULL,
  order_id    INTEGER REFERENCES orders(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor_id    INTEGER REFERENCES users(id),
  reason      TEXT,
  data_json   TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hist_order ON status_history(order_id, id);
CREATE INDEX IF NOT EXISTS idx_hist_entity ON status_history(entity, entity_id);

CREATE TABLE IF NOT EXISTS order_assignments (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  role         TEXT NOT NULL CHECK (role IN ('REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT')),
  share_bp     INTEGER NOT NULL DEFAULT 10000 CHECK (share_bp BETWEEN 0 AND 10000),
  is_primary   INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('INVITED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'LOCKED', 'REVOKED')),
  invited_by   INTEGER REFERENCES users(id),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (order_id, user_id, role)
);
CREATE INDEX IF NOT EXISTS idx_assign_user ON order_assignments(user_id, status);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  file_path   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quotes (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  version      INTEGER NOT NULL,
  amount       INTEGER NOT NULL CHECK (amount > 0),
  deposit_pct  INTEGER NOT NULL DEFAULT 50 CHECK (deposit_pct BETWEEN 0 AND 100),
  scope        TEXT NOT NULL,
  timeline     TEXT,
  terms        TEXT,
  status       TEXT NOT NULL DEFAULT 'SENT' CHECK (status IN ('SENT', 'ACCEPTED', 'REJECTED', 'SUPERSEDED')),
  customer_note TEXT,
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT,
  UNIQUE (order_id, version)
);

CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  quote_id       INTEGER NOT NULL REFERENCES quotes(id),
  value          INTEGER NOT NULL,
  deposit_pct    INTEGER NOT NULL,
  deposit_amount INTEGER NOT NULL,
  terms          TEXT,
  signed_by      INTEGER NOT NULL REFERENCES users(id),
  signed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  code       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  title       TEXT NOT NULL,
  description TEXT,
  assignee_id INTEGER REFERENCES users(id),
  due_date    TEXT,
  status      TEXT NOT NULL DEFAULT 'TODO' CHECK (status IN ('TODO', 'DOING', 'SUBMITTED', 'DONE')),
  done_at     TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deliverables (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  task_id          INTEGER REFERENCES tasks(id),
  version          INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('demo', 'preview', 'final')),
  title            TEXT NOT NULL,
  note             TEXT,
  file_path        TEXT NOT NULL,
  file_name        TEXT NOT NULL,
  submitted_by     INTEGER NOT NULL REFERENCES users(id),
  review_status    TEXT NOT NULL DEFAULT 'PENDING' CHECK (review_status IN ('PENDING', 'APPROVED', 'CHANGES')),
  review_note      TEXT,
  reviewed_by      INTEGER REFERENCES users(id),
  reviewed_at      TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS acceptances (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  deliverable_id INTEGER REFERENCES deliverables(id),
  decision       TEXT NOT NULL CHECK (decision IN ('ACCEPT', 'REVISE', 'CHANGE_REQUEST', 'SIGN_OFF')),
  note           TEXT,
  actor_id       INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  order_id   INTEGER NOT NULL REFERENCES orders(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  file_path  TEXT,
  file_name  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id           INTEGER PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id),
  kind         TEXT NOT NULL CHECK (kind IN ('deposit', 'installment', 'refund')),
  amount       INTEGER NOT NULL,          -- refund: âm
  tax          INTEGER NOT NULL DEFAULT 0,
  deductions   INTEGER NOT NULL DEFAULT 0,
  method       TEXT,
  ref          TEXT,
  note         TEXT,
  declared_by  INTEGER REFERENCES users(id),
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  status       TEXT NOT NULL DEFAULT 'DECLARED' CHECK (status IN ('DECLARED', 'CONFIRMED', 'REJECTED', 'RECONCILED')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((kind = 'refund' AND amount < 0) OR (kind <> 'refund' AND amount > 0))
);

CREATE TABLE IF NOT EXISTS rate_policies (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  rates_json TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revenue_allocations (
  id        INTEGER PRIMARY KEY,
  order_id  INTEGER NOT NULL REFERENCES orders(id),
  role      TEXT NOT NULL CHECK (role IN ('REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT', 'DEV', 'MT')),
  rate_bp   INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
  policy_id INTEGER REFERENCES rate_policies(id),
  locked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (order_id, role)
);

-- Kỳ thanh toán hoa hồng: M&T gom dòng đã duyệt (SCHEDULED, dòng → PAYABLE), chuyển khoản xong (PAID)
CREATE TABLE IF NOT EXISTS payouts (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  amount     INTEGER NOT NULL,
  period     TEXT,                              -- kỳ thanh toán, vd. 2026-10
  status     TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'PAID')),
  ref        TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_by    INTEGER REFERENCES users(id),
  paid_at    TEXT
);

CREATE TABLE IF NOT EXISTS commissions (
  id          INTEGER PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id),
  payment_id  INTEGER NOT NULL REFERENCES payments(id),
  beneficiary TEXT NOT NULL,                -- 'U<id>' hoặc 'MT'
  user_id     INTEGER REFERENCES users(id),  -- NULL = M&T
  role        TEXT NOT NULL,
  base_amount INTEGER NOT NULL,
  rate_bp     INTEGER NOT NULL,
  share_bp    INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('PENDING_APPROVAL', 'APPROVED', 'PAYABLE', 'PAID', 'VOID', 'RETAINED')),
  reason      TEXT,
  user_confirmed_at TEXT,                    -- freelancer đồng ý số tiền
  objection   TEXT,                          -- freelancer không đồng ý (chặn duyệt tới khi M&T xử lý)
  approved_by INTEGER REFERENCES users(id),  -- M&T duyệt (hoặc hủy)
  approved_at TEXT,
  payout_id   INTEGER REFERENCES payouts(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (payment_id, beneficiary, role)      -- chống ghi nhận trùng
);
CREATE INDEX IF NOT EXISTS idx_comm_user ON commissions(user_id, status);

CREATE TABLE IF NOT EXISTS disputes (
  id            INTEGER PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id),
  raised_by     INTEGER NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL CHECK (kind IN ('complaint', 'refund', 'change_request', 'support')),
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  evidence_path TEXT,
  evidence_name TEXT,
  status        TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'REJECTED')),
  resolution    TEXT,
  resolved_by   INTEGER REFERENCES users(id),
  resolved_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  title      TEXT NOT NULL,
  link       TEXT,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY,
  actor_id    INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  before_json TEXT,
  after_json  TEXT,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cấu hình hệ thống dạng key/value (vd. dev_user_id: người nhận phần Coder web)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  sess    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Nhật ký chỉ được thêm, không sửa/xóa
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs chỉ cho phép thêm mới'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs chỉ cho phép thêm mới'); END;

CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON status_history
BEGIN SELECT RAISE(ABORT, 'status_history chỉ cho phép thêm mới'); END;
CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON status_history
BEGIN SELECT RAISE(ABORT, 'status_history chỉ cho phép thêm mới'); END;

-- Khoản thu đã xác nhận không được sửa số tiền (điều chỉnh = dòng mới)
CREATE TRIGGER IF NOT EXISTS payments_locked BEFORE UPDATE OF amount, tax, deductions, order_id ON payments
WHEN OLD.confirmed_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Khoản thu đã xác nhận không được sửa — hãy tạo dòng điều chỉnh'); END;

-- Hoa hồng đã duyệt/đã trả không được sửa số tiền
CREATE TRIGGER IF NOT EXISTS commissions_locked BEFORE UPDATE OF amount, base_amount, rate_bp, share_bp, user_id, role ON commissions
WHEN OLD.status IN ('APPROVED', 'PAYABLE', 'PAID', 'RETAINED')
BEGIN SELECT RAISE(ABORT, 'Hoa hồng đã chốt không được sửa — hãy tạo dòng điều chỉnh'); END;
CREATE TRIGGER IF NOT EXISTS commissions_no_delete BEFORE DELETE ON commissions
BEGIN SELECT RAISE(ABORT, 'Không được xóa dòng hoa hồng'); END;
