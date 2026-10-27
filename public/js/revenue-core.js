/*
 * FLC — công thức doanh thu dùng chung cho server (require) và trình duyệt (window.FLCRevenue).
 * Đây là NGUỒN DUY NHẤT của quy tắc chia doanh thu: đối soát (src/services/commission.js)
 * và bộ tính trên trang "Doanh thu & dự án" đều gọi vào đây, nên con số luôn khớp nhau.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FLCRevenue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Thứ tự các phần chia; M&T nhận phần còn lại để tổng luôn khớp doanh thu thuần */
  var RATE_KEYS = ['REFERRER', 'SALES', 'ACCOUNT', 'PM', 'PROJECT', 'DEV', 'MT'];
  var PAYABLE_ROLES = RATE_KEYS.filter(function (k) { return k !== 'MT'; });
  var NO_HOLDER_REASON = {
    REFERRER: 'Không có Referrer — Admin giữ lại',
    DEV: 'Chưa cấu hình người nhận phần Coder web — Admin giữ lại',
  };

  /**
   * Doanh thu thuần = Doanh thu − (chiết khấu thương mại + giảm giá hàng bán + hàng bán bị trả lại) − thuế gián thu.
   * Thuế GTGT chỉ bị trừ khi số tiền đã gồm VAT: VAT = (doanh thu sau giảm trừ) × r / (1 + r).
   */
  function netRevenue(i) {
    var n = function (v) { return Math.max(0, Math.round(Number(v) || 0)); };
    var gross = n(i.gross), discount = n(i.discount), allowance = n(i.allowance), returns = n(i.returns);
    var vatPct = Math.max(0, Number(i.vatPct) || 0);
    var afterDeductions = gross - discount - allowance - returns;
    var vat = i.vatIncluded === false ? 0 : Math.round((afterDeductions * vatPct) / (100 + vatPct));
    var excise = n(i.excise), exportTax = n(i.exportTax);
    return {
      gross: gross, deductions: discount + allowance + returns, afterDeductions: afterDeductions,
      vat: vat, otherTax: excise + exportTax, net: afterDeductions - vat - excise - exportTax,
    };
  }

  /**
   * Chia MỘT khoản doanh thu thuần thành các dòng hoa hồng.
   * @param net          doanh thu thuần (âm nếu là hoàn tiền)
   * @param allocations  { ROLE: rate_bp } — 1% = 100
   * @param holders      { ROLE: [{ userId, shareBp }] } — người được hưởng của từng vai trò
   * @param needsPm      false → phần PM chuyển cho Account
   * Không có người nhận → M&T giữ lại. Tổng amount luôn bằng đúng net (dư làm tròn về M&T).
   */
  function computeLines(p) {
    var net = p.net, allocations = p.allocations, holders = p.holders, lines = [], distributed = 0;
    PAYABLE_ROLES.forEach(function (role) {
      var rate = allocations[role] || 0;
      if (!rate) return;
      var pool = Math.round((net * rate) / 10000);
      var people = holders[role] || [];
      var reason = null;
      if (role === 'PM' && !p.needsPm) {
        people = holders.ACCOUNT || [];
        reason = 'Account kiêm PM (Order không có PM)';
      }
      if (!people.length) {
        lines.push({ beneficiary: 'MT', userId: null, role: role, base: net, rate: rate, share: 10000, amount: pool,
          reason: NO_HOLDER_REASON[role] || 'Không có người đảm nhận — Admin giữ lại' });
      } else {
        var totalShare = people.reduce(function (s, h) { return s + h.shareBp; }, 0) || 1;
        var left = pool;
        people.forEach(function (h, i) {
          var amount = i === people.length - 1 ? left : Math.round((pool * h.shareBp) / totalShare);
          left -= amount;
          lines.push({ beneficiary: 'U' + h.userId, userId: h.userId, role: role, base: net, rate: rate, share: h.shareBp, amount: amount, reason: reason });
        });
      }
      distributed += pool;
    });
    lines.push({ beneficiary: 'MT', userId: null, role: 'MT', base: net, rate: allocations.MT || 0, share: 10000,
      amount: net - distributed, reason: 'Phần M&T (gồm chênh lệch làm tròn)' });
    return lines;
  }

  /**
   * Bộ tính minh họa cho freelancer: tính doanh thu thuần rồi chia theo tỷ lệ, đánh dấu phần của người xem ('me').
   * @param input       tham số của netRevenue
   * @param rates       { ROLE: rate_bp }
   * @param myRoles     vai trò của người xem; myShareBp: tỷ lệ phân công trong vai trò Project
   * @param hasReferrer, hasPm, hasDev  bật/tắt để xem phần chia thay đổi thế nào
   */
  function simulate(p) {
    var result = netRevenue(p.input);
    var mine = p.myRoles || [];
    var myShare = p.myShareBp == null ? 10000 : p.myShareBp;
    var holders = {};
    PAYABLE_ROLES.forEach(function (role) {
      if ((role === 'REFERRER' && !p.hasReferrer) || (role === 'DEV' && !p.hasDev)) return;
      var isMine = mine.indexOf(role) >= 0;
      holders[role] = isMine && role === 'PROJECT' && myShare < 10000
        ? [{ userId: 'me', shareBp: myShare }, { userId: 'other', shareBp: 10000 - myShare }]
        : [{ userId: isMine ? 'me' : role, shareBp: 10000 }];
    });
    result.lines = computeLines({ net: result.net, allocations: p.rates, holders: holders, needsPm: p.hasPm });
    result.mine = result.lines.reduce(function (s, l) { return s + (l.userId === 'me' ? l.amount : 0); }, 0);
    return result;
  }

  /** Gom các dòng theo vai trò để hiển thị: tổng tiền, phần của người xem, có bị M&T giữ lại không */
  function byRole(lines) {
    var out = {};
    RATE_KEYS.forEach(function (k) { out[k] = { amount: 0, mine: 0, retained: false, reason: null }; });
    lines.forEach(function (l) {
      var r = out[l.role];
      r.amount += l.amount;
      if (l.userId === 'me') r.mine += l.amount;
      if (l.userId === null && l.role !== 'MT') r.retained = true;
      if (l.reason && l.role !== 'MT') r.reason = l.reason;
    });
    return out;
  }

  return {
    RATE_KEYS: RATE_KEYS, PAYABLE_ROLES: PAYABLE_ROLES,
    netRevenue: netRevenue, computeLines: computeLines, simulate: simulate, byRole: byRole,
  };
});
