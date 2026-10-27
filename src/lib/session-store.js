'use strict';
const session = require('express-session');
const db = require('../db');

/** Lưu phiên đăng nhập vào SQLite (bảng sessions) */
class SqliteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => db.run('DELETE FROM sessions WHERE expires < ?', Date.now()), 60 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = db.get('SELECT sess, expires FROM sessions WHERE sid = ?', sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
      db.run(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
        sid, JSON.stringify(sess), expires,
      );
      cb?.(null);
    } catch (e) { cb?.(e); }
  }
  destroy(sid, cb) {
    try { db.run('DELETE FROM sessions WHERE sid = ?', sid); cb?.(null); } catch (e) { cb?.(e); }
  }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

module.exports = SqliteStore;
