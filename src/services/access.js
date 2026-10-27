'use strict';
// Ai được xem gì trong một Order. Freelancer chỉ thấy Order mình tham gia.
const db = require('../db');

const PRE_MATCH = ['CONSULTING', 'QUOTED', 'REJECTED', 'CONTRACT_SIGNED', 'AWAITING_DEPOSIT', 'DEPOSITED', 'MATCHING'];

/**
 * @returns {{
 *   any: boolean,        xem được trang Order (tối thiểu bản tóm tắt)
 *   workspace: boolean,  vào không gian làm việc (tệp, trao đổi, nhiệm vụ)
 *   isAdmin, isCustomer, roles: string[], invited: object[], canClaim: string|null,
 *   seeContact: boolean, seeInvoice: boolean
 * }}
 */
function forOrder(user, orderId) {
  const none = { any: false, workspace: false, isAdmin: false, isCustomer: false, roles: [], invited: [], canClaim: null, seeContact: false, seeInvoice: false };
  if (!user) return none;
  const order = db.get('SELECT id, customer_id, status FROM orders WHERE id = ?', orderId);
  if (!order) return none;
  if (user.kind === 'admin') {
    return { ...none, any: true, workspace: true, isAdmin: true, seeContact: true, seeInvoice: true };
  }
  if (user.kind === 'customer') {
    const own = order.customer_id === user.id;
    return { ...none, any: own, workspace: own, isCustomer: own, seeContact: own, seeInvoice: own };
  }
  if (user.status !== 'ACTIVE') return none;
  const rows = db.all('SELECT * FROM order_assignments WHERE order_id = ? AND user_id = ?', orderId, user.id);
  const closed = ['CLOSED', 'CANCELLED'].includes(order.status);
  // Khi Order đóng, quyền vào workspace bị thu hồi
  const roles = closed ? [] : rows.filter((a) => ['ACCEPTED', 'LOCKED'].includes(a.status)).map((a) => a.role);
  const invited = closed ? [] : rows.filter((a) => a.status === 'INVITED');
  let canClaim = null;
  const active = new Set(user.roles || []);
  if (order.status === 'PENDING_INTAKE' && active.has('SALES')) canClaim = 'SALES';
  else if (PRE_MATCH.includes(order.status) && active.has('ACCOUNT') && !roles.includes('ACCOUNT')
    && !db.get("SELECT 1 FROM order_assignments WHERE order_id = ? AND role = 'ACCOUNT' AND status IN ('ACCEPTED','LOCKED')", orderId)) canClaim = 'ACCOUNT';
  // Referrer chỉ xem tóm tắt trạng thái, không vào workspace
  const working = roles.filter((r) => r !== 'REFERRER');
  return {
    ...none,
    any: roles.length > 0 || invited.length > 0 || !!canClaim,
    workspace: working.length > 0,
    roles,
    invited,
    canClaim,
    seeContact: working.includes('SALES') || working.includes('ACCOUNT'),
  };
}

module.exports = { forOrder };
