'use strict';
// Trang chủ Freelancer: bảng tin Order khách đã đăng + bảng xếp hạng thành viên theo số dự án hoàn thành
const db = require('../db');

/*
 * Nhóm trạng thái hiển thị trên bảng tin. Bản nháp, Order bị từ chối hoặc hủy không hiện.
 * Chỉ hiện thông tin chung của yêu cầu — không có khách hàng, liên hệ, hóa đơn hay mô tả chi tiết.
 */
const GROUPS = {
  open:    { label: 'Mới đăng & chuẩn bị', statuses: ['PENDING_INTAKE', 'CONSULTING', 'QUOTED', 'CONTRACT_SIGNED', 'AWAITING_DEPOSIT', 'DEPOSITED', 'MATCHING', 'PENDING_MATCH_APPROVAL'] },
  running: { label: 'Đang triển khai', statuses: ['IN_PROGRESS', 'IN_REVIEW', 'DEMO', 'PREVIEW', 'AWAITING_PAYMENT', 'ACCEPTANCE', 'RECONCILIATION'] },
  done:    { label: 'Đã hoàn thành', statuses: ['COMPLETED', 'CLOSED'] },
};
const DONE = GROUPS.done.statuses;
const inList = (list) => `(${list.map((s) => `'${s}'`).join(',')})`; // hằng số nội bộ, không phải dữ liệu người dùng

/** Số Order trong từng nhóm */
function groupCounts() {
  const rows = db.all(`SELECT status, COUNT(*) AS n FROM orders WHERE status IN ${inList(Object.values(GROUPS).flatMap((g) => g.statuses))} GROUP BY status`);
  return Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, rows.filter((r) => g.statuses.includes(r.status)).reduce((s, r) => s + r.n, 0)]));
}

/** Order khách đã đăng trong một nhóm, mới nhất trước. `mine` = người xem đang tham gia / được mời. */
function postedOrders({ group = 'open', service = null, viewerId, limit = 30 }) {
  const g = GROUPS[group] || GROUPS.open;
  return db.all(
    `SELECT o.id, o.code, o.title, o.service_type, o.budget, o.deadline, o.status, o.submitted_at,
            (SELECT COUNT(DISTINCT a.user_id) FROM order_assignments a
              WHERE a.order_id = o.id AND a.status IN ('ACCEPTED', 'LOCKED'))                         AS members,
            EXISTS (SELECT 1 FROM order_assignments a
                     WHERE a.order_id = o.id AND a.user_id = ? AND a.status IN ('INVITED', 'ACCEPTED', 'LOCKED')) AS mine
       FROM orders o
      WHERE o.status IN ${inList(g.statuses)}
        AND (? IS NULL OR o.service_type = ?)
      ORDER BY o.submitted_at DESC, o.id DESC
      LIMIT ?`,
    viewerId, service, service, limit,
  );
}

/*
 * Xếp hạng: số Order đã hoàn tất/đóng mà thành viên có phân công đã khóa (mọi vai trò, mỗi Order đếm một lần).
 * Bằng điểm thì cùng hạng (RANK); trong cùng hạng, ai hoàn thành dự án gần nhất trước.
 */
const SQL_LEADERBOARD = `
WITH done AS (
  SELECT a.user_id, COUNT(DISTINCT a.order_id) AS completed, MAX(o.updated_at) AS last_done
    FROM order_assignments a
    JOIN orders o ON o.id = a.order_id
   WHERE a.status = 'LOCKED' AND o.status IN ${inList(DONE)}
   GROUP BY a.user_id
),
active AS (
  SELECT a.user_id, COUNT(DISTINCT a.order_id) AS active
    FROM order_assignments a
    JOIN orders o ON o.id = a.order_id
   WHERE a.status IN ('ACCEPTED', 'LOCKED') AND o.status NOT IN ('COMPLETED', 'CLOSED', 'CANCELLED', 'REJECTED')
   GROUP BY a.user_id
),
roles AS (
  SELECT user_id, group_concat(role, ',') AS roles FROM user_roles WHERE status = 'ACTIVE' GROUP BY user_id
)
SELECT u.id, u.code, u.full_name, u.avatar_file, f.member_code, r.roles,
       COALESCE(d.completed, 0) AS completed,
       COALESCE(ac.active, 0)   AS active,
       RANK() OVER (ORDER BY COALESCE(d.completed, 0) DESC) AS rank
  FROM users u
  JOIN freelancer_profiles f ON f.user_id = u.id
  LEFT JOIN done d    ON d.user_id = u.id
  LEFT JOIN active ac ON ac.user_id = u.id
  LEFT JOIN roles r   ON r.user_id = u.id
 WHERE u.kind = 'freelancer' AND u.status = 'ACTIVE'
 ORDER BY rank, d.last_done DESC, u.id`;

/** Top N thành viên có ít nhất một dự án hoàn thành + vị trí của người xem (kể cả khi ngoài top) */
function leaderboard(viewerId, top = 10) {
  const all = db.all(SQL_LEADERBOARD);
  return {
    top: all.filter((m) => m.completed > 0).slice(0, top),
    me: all.find((m) => m.id === viewerId) || null,
    members: all.length,
  };
}

module.exports = { GROUPS, groupCounts, postedOrders, leaderboard };
