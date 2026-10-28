'use strict';
// Truy vấn báo cáo cho M&T (SQLite). Viết bằng CTE để dễ chuyển sang PostgreSQL:
//   datetime('now', '-N days') -> now() - interval 'N days'
//   strftime('%Y-%m', x)        -> to_char(x, 'YYYY-MM')
const db = require('../db');

/* ---------- KPI chính trong khoảng N ngày ---------- */
const SQL_KPI = `
WITH confirmed AS (               -- khoản thu đã xác nhận trong kỳ (hoàn tiền là số âm)
  SELECT amount, amount - tax - deductions AS net
    FROM payments
   WHERE confirmed_at IS NOT NULL
     AND confirmed_at >= datetime('now', ?)
),
mt_share AS (                     -- phần M&T giữ lại = lợi nhuận gộp của nền tảng
  SELECT c.amount
    FROM commissions c
    JOIN payments p ON p.id = c.payment_id
   WHERE c.user_id IS NULL
     AND p.confirmed_at >= datetime('now', ?)
)
SELECT (SELECT COALESCE(SUM(amount), 0) FROM confirmed) AS collected,
       (SELECT COALESCE(SUM(net), 0)    FROM confirmed) AS net,
       (SELECT COALESCE(SUM(amount), 0) FROM mt_share)  AS mt_profit`;

/* Công nợ phải thu: giá trị HĐ − thực thu, với Order còn hiệu lực */
const SQL_RECEIVABLES = `
WITH collected AS (
  SELECT order_id, SUM(amount) AS paid
    FROM payments
   WHERE confirmed_at IS NOT NULL
   GROUP BY order_id
)
SELECT o.id, o.code, o.title, o.status, ct.value, COALESCE(col.paid, 0) AS paid,
       ct.value - COALESCE(col.paid, 0) AS outstanding,
       CAST(julianday('now') - julianday(ct.signed_at) AS INTEGER) AS age_days
  FROM contracts ct
  JOIN orders o ON o.id = ct.order_id
  LEFT JOIN collected col ON col.order_id = ct.order_id
 WHERE o.status NOT IN ('CANCELLED', 'CLOSED')
   AND ct.value > COALESCE(col.paid, 0)
 ORDER BY outstanding DESC`;

/* Doanh thu theo tháng (12 tháng gần nhất) */
const SQL_MONTHLY = `
SELECT strftime('%Y-%m', confirmed_at, '+7 hours') AS month,      -- quy về giờ Việt Nam
       SUM(amount)                  AS collected,
       SUM(amount - tax - deductions) AS net
  FROM payments
 WHERE confirmed_at IS NOT NULL
   AND confirmed_at >= datetime('now', 'start of month', '-11 months')
 GROUP BY month
 ORDER BY month`;

/*
 * Phễu: số Order (gửi trong kỳ) đã TỪNG đạt mỗi mốc.
 * Dựa trên status_history (entity = 'order') nên Order bị trả lại / quay vòng vẫn chỉ đếm một lần (COUNT DISTINCT).
 */
const SQL_FUNNEL = `
WITH cohort AS (
  SELECT id FROM orders WHERE submitted_at >= datetime('now', ?)
),
reached AS (
  SELECT h.order_id, h.to_status
    FROM status_history h
    JOIN cohort c ON c.id = h.order_id
   WHERE h.entity = 'order'
)
SELECT
  (SELECT COUNT(*) FROM cohort)                                                         AS submitted,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'CONSULTING')         AS consulted,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'QUOTED')             AS quoted,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'CONTRACT_SIGNED')    AS signed,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'DEPOSITED')          AS deposited,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'IN_PROGRESS')        AS started,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'ACCEPTANCE')         AS accepted,
  (SELECT COUNT(DISTINCT order_id) FROM reached WHERE to_status = 'COMPLETED')          AS completed`;

/* Tỷ lệ chốt báo giá: trong các báo giá đã có phản hồi, bao nhiêu được chấp nhận; số vòng báo giá trung bình */
const SQL_QUOTE_WIN = `
WITH answered AS (
  SELECT order_id, status
    FROM quotes
   WHERE status IN ('ACCEPTED', 'REJECTED')
     AND created_at >= datetime('now', ?)
),
rounds AS (
  SELECT order_id, MAX(version) AS versions FROM quotes GROUP BY order_id
)
SELECT
  (SELECT COUNT(*) FROM answered WHERE status = 'ACCEPTED') AS won,
  (SELECT COUNT(*) FROM answered)                           AS answered,
  (SELECT ROUND(AVG(r.versions), 2) FROM rounds r
     WHERE EXISTS (SELECT 1 FROM quotes q WHERE q.order_id = r.order_id AND q.status = 'ACCEPTED')) AS avg_rounds_to_win`;

/* Order đang mở theo trạng thái hiện tại */
const SQL_STATUS = `
SELECT status, COUNT(*) AS n
  FROM orders
 WHERE status NOT IN ('CLOSED', 'CANCELLED', 'DRAFT')
 GROUP BY status`;

/* Hoa hồng theo vai trò × trạng thái (không gồm phần M&T) */
const SQL_COMMISSION_BY_ROLE = `
SELECT role,
       SUM(CASE WHEN status = 'PENDING_APPROVAL' THEN amount ELSE 0 END) AS pending,
       SUM(CASE WHEN status IN ('APPROVED', 'PAYABLE') THEN amount ELSE 0 END) AS approved,
       SUM(CASE WHEN status = 'PAID'             THEN amount ELSE 0 END) AS paid,
       SUM(CASE WHEN status = 'VOID'             THEN amount ELSE 0 END) AS voided
  FROM commissions
 WHERE user_id IS NOT NULL
 GROUP BY role
 ORDER BY CASE role WHEN 'REFERRER' THEN 1 WHEN 'SALES' THEN 2 WHEN 'ACCOUNT' THEN 3 WHEN 'PM' THEN 4 ELSE 5 END`;

/* Việc đang chờ M&T xử lý */
const SQL_QUEUE = `
SELECT
  (SELECT COUNT(*) FROM users WHERE kind <> 'admin' AND status = 'PENDING')
    + (SELECT COUNT(DISTINCT user_id) FROM user_roles r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'PENDING' AND u.status = 'ACTIVE')                                  AS accounts,
  (SELECT COUNT(*) FROM payments WHERE status = 'DECLARED')                                AS payments,
  (SELECT COUNT(*) FROM orders WHERE status = 'PENDING_MATCH_APPROVAL')                     AS match_approvals,
  (SELECT COUNT(*) FROM orders WHERE status = 'RECONCILIATION')                             AS reconciliation,
  (SELECT COUNT(*) FROM commissions WHERE status = 'PENDING_APPROVAL')                      AS commissions,
  (SELECT COUNT(*) FROM disputes WHERE status = 'OPEN')                                     AS disputes,
  (SELECT COALESCE(SUM(amount), 0) FROM commissions WHERE status IN ('APPROVED', 'PAYABLE')) AS payable`;

/*
 * Hiệu suất freelancer:
 *  - orders: số Order đã được khóa phân công (mọi vai trò, đếm Order duy nhất)
 *  - on_time: % nhiệm vụ hoàn thành trước/đúng hạn (chỉ tính nhiệm vụ có hạn và đã DONE)
 *  - revision: % sản phẩm nộp bị PM/Account yêu cầu sửa
 *  - earned: hoa hồng đã duyệt + đã chi
 */
const SQL_FREELANCER_PERF = `
WITH assigned AS (
  SELECT user_id, COUNT(DISTINCT order_id) AS orders,
         group_concat(DISTINCT role) AS roles
    FROM order_assignments
   WHERE status = 'LOCKED'
   GROUP BY user_id
),
done_orders AS (
  SELECT a.user_id, COUNT(DISTINCT a.order_id) AS completed
    FROM order_assignments a
    JOIN orders o ON o.id = a.order_id
   WHERE a.status = 'LOCKED' AND o.status IN ('COMPLETED', 'CLOSED')
   GROUP BY a.user_id
),
task_stats AS (
  SELECT assignee_id AS user_id,
         COUNT(*) AS tasks_due,
         SUM(CASE WHEN date(done_at, '+7 hours') <= due_date THEN 1 ELSE 0 END) AS on_time
    FROM tasks
   WHERE status = 'DONE' AND due_date IS NOT NULL
   GROUP BY assignee_id
),
deliv_stats AS (
  SELECT submitted_by AS user_id,
         COUNT(*) AS submitted,
         SUM(CASE WHEN review_status = 'CHANGES' THEN 1 ELSE 0 END) AS revisions
    FROM deliverables
   GROUP BY submitted_by
),
earned AS (
  SELECT user_id, SUM(amount) AS earned
    FROM commissions
   WHERE status IN ('APPROVED', 'PAYABLE', 'PAID') AND user_id IS NOT NULL
   GROUP BY user_id
)
SELECT u.id, u.code, u.full_name, fp.availability, a.roles,
       a.orders,
       COALESCE(d.completed, 0) AS completed,
       ts.tasks_due,
       CASE WHEN ts.tasks_due > 0 THEN ROUND(100.0 * ts.on_time / ts.tasks_due, 0) END AS on_time_pct,
       ds.submitted,
       CASE WHEN ds.submitted > 0 THEN ROUND(100.0 * ds.revisions / ds.submitted, 0) END AS revision_pct,
       COALESCE(e.earned, 0) AS earned
  FROM assigned a
  JOIN users u ON u.id = a.user_id
  LEFT JOIN freelancer_profiles fp ON fp.user_id = u.id
  LEFT JOIN done_orders d ON d.user_id = a.user_id
  LEFT JOIN task_stats ts ON ts.user_id = a.user_id
  LEFT JOIN deliv_stats ds ON ds.user_id = a.user_id
  LEFT JOIN earned e ON e.user_id = a.user_id
 ORDER BY earned DESC, a.orders DESC
 LIMIT ?`;

/* Lợi nhuận theo Order: thực thu thuần vs. tổng chi cho freelancer vs. phần M&T */
const SQL_ORDER_PROFIT = `
WITH net_by_order AS (
  SELECT order_id, SUM(amount - tax - deductions) AS net
    FROM payments
   WHERE confirmed_at IS NOT NULL
   GROUP BY order_id
),
split AS (
  SELECT order_id,
         SUM(CASE WHEN user_id IS NOT NULL AND status <> 'VOID' THEN amount ELSE 0 END) AS freelancer_cost,
         SUM(CASE WHEN user_id IS NULL THEN amount ELSE 0 END)                           AS mt_share
    FROM commissions
   GROUP BY order_id
)
SELECT o.id, o.code, o.title, o.status, ct.value,
       COALESCE(n.net, 0) AS net,
       COALESCE(s.freelancer_cost, 0) AS freelancer_cost,
       COALESCE(s.mt_share, 0) AS mt_share,
       CASE WHEN n.net > 0 THEN ROUND(100.0 * s.mt_share / n.net, 1) END AS margin_pct
  FROM orders o
  JOIN contracts ct ON ct.order_id = o.id
  LEFT JOIN net_by_order n ON n.order_id = o.id
  LEFT JOIN split s ON s.order_id = o.id
 ORDER BY o.id DESC
 LIMIT 50`;

/* Doanh thu theo loại dịch vụ */
const SQL_BY_SERVICE = `
SELECT o.service_type,
       COUNT(DISTINCT o.id) AS orders,
       COALESCE(SUM(p.amount - p.tax - p.deductions), 0) AS net
  FROM orders o
  LEFT JOIN payments p ON p.order_id = o.id AND p.confirmed_at IS NOT NULL
 WHERE o.status <> 'DRAFT'
 GROUP BY o.service_type
 ORDER BY net DESC`;

/** Điền đủ 12 tháng (tháng không có thu vẫn hiện 0) */
function fillMonths(rows) {
  const map = new Map(rows.map((r) => [r.month, r]));
  const out = [];
  const now = new Date(Date.now() + 7 * 3600e3);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push(map.get(key) || { month: key, collected: 0, net: 0 });
  }
  return out;
}

function dashboard(rangeDays) {
  const since = `-${rangeDays} days`;
  const kpi = db.get(SQL_KPI, since, since);
  const receivables = db.all(SQL_RECEIVABLES);
  const quote = db.get(SQL_QUOTE_WIN, since);
  return {
    kpi: { ...kpi, receivable: receivables.reduce((s, r) => s + r.outstanding, 0) },
    queue: db.get(SQL_QUEUE),
    monthly: fillMonths(db.all(SQL_MONTHLY)),
    funnel: db.get(SQL_FUNNEL, since),
    quote: { ...quote, rate: quote.answered ? Math.round((100 * quote.won) / quote.answered) : null },
    status: db.all(SQL_STATUS),
    commissionByRole: db.all(SQL_COMMISSION_BY_ROLE),
    topFreelancers: db.all(SQL_FREELANCER_PERF, 6),
    receivables: receivables.slice(0, 6),
  };
}

function full() {
  return {
    freelancers: db.all(SQL_FREELANCER_PERF, 200),
    orderProfit: db.all(SQL_ORDER_PROFIT),
    byService: db.all(SQL_BY_SERVICE),
    receivables: db.all(SQL_RECEIVABLES),
    commissionByRole: db.all(SQL_COMMISSION_BY_ROLE),
  };
}

module.exports = { dashboard, full };
