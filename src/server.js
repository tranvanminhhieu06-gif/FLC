'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('./lib/session-store');
const { loadUser, csrf, blockInactive } = require('./middleware');

const app = express();
const PROD = process.env.NODE_ENV === 'production';
if (PROD && !process.env.SESSION_SECRET) throw new Error('Cần đặt biến môi trường SESSION_SECRET khi chạy production');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  next();
});
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: PROD ? '7d' : 0 }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(session({
  store: new SqliteStore(),
  name: 'flc.sid',
  secret: process.env.SESSION_SECRET || 'flc-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true, // gia hạn cookie "ghi nhớ" sau mỗi lần dùng (30 ngày tính từ lần truy cập cuối)
  // Mặc định là cookie phiên: đóng trình duyệt là đăng xuất. Chọn "Ghi nhớ đăng nhập" thì đặt maxAge (routes/public.js)
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD },
}));
app.use(loadUser);
app.use(csrf);
app.use(blockInactive);

app.use(require('./routes/public'));
app.use(require('./routes/files'));
app.use('/customer', require('./routes/customer'));
app.use('/fl', require('./routes/freelancer'));
app.use('/orders', require('./routes/orders'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('error', { title: 'Không tìm thấy', message: 'Trang bạn tìm không tồn tại hoặc bạn không có quyền xem.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).render('error', {
    title: 'Có lỗi xảy ra',
    message: err.expose || err.name === 'FlowError' || err.code === 'LIMIT_FILE_SIZE'
      ? (err.code === 'LIMIT_FILE_SIZE' ? 'Tệp vượt quá 25MB' : err.message)
      : 'Hệ thống gặp sự cố. Vui lòng thử lại sau.',
  });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`FLC đang chạy: http://localhost:${port}`));
}

module.exports = app;
