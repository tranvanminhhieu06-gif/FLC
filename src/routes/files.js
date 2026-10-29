'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const files = require('../services/files');
const { requireLogin } = require('../middleware');

const router = express.Router();

router.get('/files/:kind/:id/:which?', requireLogin, (req, res) => {
  const found = files.resolve(req.user, req.params.kind, Number(req.params.id), req.params.which);
  const abs = found && files.absolute(found.file);
  if (!found || !fs.existsSync(abs)) {
    return res.status(404).render('error', { title: 'Không tải được tệp', message: 'Tệp không tồn tại hoặc bạn chưa đủ điều kiện tải (ví dụ: file gốc chỉ mở sau khi thanh toán đủ).' });
  }
  // Tệp do người dùng tải lên không bao giờ được chạy như một trang của FLC
  // Ảnh đại diện được cache ngắn (URL kèm ?v= đổi theo tệp); các tệp khác không cache
  res.set({ 'Cache-Control': found.cacheable ? 'private, max-age=86400' : 'private, no-store', 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'" });
  const inlineType = files.INLINE_TYPES[path.extname(found.file).toLowerCase()];
  if (found.inline && inlineType) {
    // Demo/preview/hồ sơ: chỉ xem trực tiếp, không gợi ý tải về
    res.set({ 'Content-Type': inlineType, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(found.name)}` });
  } else {
    res.attachment(found.name);
    res.type('application/octet-stream');
  }
  res.sendFile(abs);
});

module.exports = router;
