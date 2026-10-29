'use strict';
// Upload vào storage/private (không public) + kiểm tra quyền khi tải
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const db = require('../db');
const finance = require('./finance');
const access = require('./access');

const ROOT = process.env.FLC_STORAGE || path.join(__dirname, '..', '..', 'storage', 'private');
fs.mkdirSync(ROOT, { recursive: true });

// MIME do trình duyệt khai báo có thể giả mạo → kiểm tra cả phần mở rộng.
// Tệp có thể chạy trên trình duyệt (html, svg, js…) luôn bị chặn.
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const DOC_EXT = /\.(pdf|zip|rar|7z|docx?|xlsx?|pptx?|txt|csv|png|jpe?g|webp|gif|psd|ai|fig|sketch|mp4|webm|mov)$/i;

/** Chỉ các định dạng này được xem trực tiếp (inline); còn lại luôn tải về dạng octet-stream */
const INLINE_TYPES = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ROOT),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).toLowerCase().slice(0, 10)),
});

function upload(fields, { imagesOnly = [], maxMB = 25 } = {}) {
  return multer({
    storage,
    limits: { fileSize: maxMB * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
      const ok = (imagesOnly.includes(file.fieldname) ? IMAGE_EXT : DOC_EXT).test(file.originalname);
      cb(ok ? null : Object.assign(new Error(`Định dạng tệp "${file.originalname}" không được hỗ trợ`), { status: 400, expose: true }), ok);
    },
  }).fields(fields.map((name) => (typeof name === 'string' ? { name, maxCount: 1 } : name)));
}

/** Xóa các tệp vừa tải lên của request (khi request thất bại) */
function discard(req) {
  for (const list of Object.values(req.files || {})) for (const f of list) fs.unlink(f.path, () => {});
}

/** Đánh dấu tệp đã được ghi vào CSDL — không xóa khi response kết thúc */
function keep(req) { req.uploadKept = true; }

/**
 * Middleware nhận tệp: lỗi upload → flash + quay lại (hoặc onError).
 * Khi response kết thúc mà handler chưa keep(req) (lỗi kiểm tra/nghiệp vụ) → xóa tệp để không để lại CCCD/CV mồ côi.
 */
function receive(fields, opts = {}, onError) {
  const { flash, back } = require('../middleware');
  const mw = upload(fields, opts);
  return (req, res, next) => mw(req, res, (err) => {
    res.on('finish', () => { if (!req.uploadKept) discard(req); });
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Tệp vượt quá ${opts.maxMB || 25}MB` : err.expose ? err.message : 'Không tải được tệp';
    if (onError) return onError(req, res, msg);
    flash(req, 'danger', msg);
    res.redirect(back(req));
  });
}

/** Tên file gốc của multer bị mã hóa latin1 — đổi lại UTF-8 cho tên tiếng Việt */
function pick(req, field) {
  const f = req.files?.[field]?.[0];
  if (!f) return null;
  return { path: path.basename(f.path), name: Buffer.from(f.originalname, 'latin1').toString('utf8') };
}
function pickAll(req, field) {
  return (req.files?.[field] || []).map((f) => ({ path: path.basename(f.path), name: Buffer.from(f.originalname, 'latin1').toString('utf8') }));
}

const absolute = (stored) => path.join(ROOT, path.basename(stored));

/** Kiểm tra nội dung thật là ảnh PNG/JPEG/WebP (không chỉ dựa vào đuôi tệp) */
function isImage(stored) {
  const fd = fs.openSync(absolute(stored), 'r');
  const head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, 12, 0); } finally { fs.closeSync(fd); }
  return (head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG')
    || (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
    || (head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP');
}

/**
 * Quyết định ai được tải tệp nào. Trả về { file, name, inline } hoặc null.
 * - Hồ sơ (CV, CCCD): chỉ Admin; CV thì chủ hồ sơ cũng xem được
 * - File gốc: khách chỉ tải sau khi thanh toán đủ (quy tắc hệ thống)
 * - Demo/preview: khách chỉ xem inline, không cache
 */
function resolve(user, kind, id, which) {
  if (!user) return null;
  const isAdmin = user.kind === 'admin';
  switch (kind) {
    case 'profile': {
      const p = db.get('SELECT * FROM freelancer_profiles WHERE user_id = ?', id);
      const col = { cv: 'cv_file', id_front: 'id_front_file', id_back: 'id_back_file' }[which];
      if (!p || !col || !p[col]) return null;
      if (!isAdmin && !(which === 'cv' && user.id === p.user_id)) return null;
      return { file: p[col], name: `${which}${path.extname(p[col])}`, inline: true };
    }
    case 'avatar': {
      // Ảnh đại diện: mọi người đã đăng nhập đều xem được (hiện trên bảng xếp hạng, thanh trên cùng)
      const u = db.get('SELECT avatar_file FROM users WHERE id = ?', id);
      if (!u?.avatar_file) return null;
      return { file: u.avatar_file, name: `avatar${path.extname(u.avatar_file)}`, inline: true, cacheable: true };
    }
    case 'attachment': {
      const a = db.get('SELECT * FROM attachments WHERE id = ?', id);
      if (!a || !access.forOrder(user, a.order_id).workspace) return null;
      return { file: a.file_path, name: a.file_name };
    }
    case 'message': {
      const m = db.get('SELECT * FROM messages WHERE id = ?', id);
      if (!m?.file_path || !access.forOrder(user, m.order_id).workspace) return null;
      return { file: m.file_path, name: m.file_name };
    }
    case 'dispute': {
      const d = db.get('SELECT * FROM disputes WHERE id = ?', id);
      if (!d?.evidence_path || !(isAdmin || d.raised_by === user.id)) return null;
      return { file: d.evidence_path, name: d.evidence_name };
    }
    case 'deliverable': {
      const d = db.get('SELECT * FROM deliverables WHERE id = ?', id);
      if (!d) return null;
      const acc = access.forOrder(user, d.order_id);
      if (!acc.workspace) return null;
      if (acc.isCustomer) {
        if (d.review_status !== 'APPROVED') return null;
        if (d.kind === 'final') {
          return finance.summary(d.order_id).paidInFull ? { file: d.file_path, name: d.file_name } : null;
        }
        return { file: d.file_path, name: d.file_name, inline: true, preview: true };
      }
      return { file: d.file_path, name: d.file_name };
    }
    default:
      return null;
  }
}

module.exports = { upload, receive, keep, discard, pick, pickAll, resolve, absolute, isImage, INLINE_TYPES, ROOT };
