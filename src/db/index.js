'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.FLC_DB || path.join(__dirname, '..', '..', 'data', 'flc.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
migrate();

/** Nâng cấp CSDL đã tạo bằng schema cũ (SQLite không sửa được CHECK → dựng lại bảng) */
function migrate() {
  const ra = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'revenue_allocations'").get();
  if (ra && !ra.sql.includes("'DEV'")) {
    // Lấy định nghĩa mới từ schema.sql để không lặp lại cấu trúc bảng
    const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const createSql = schema.match(/CREATE TABLE IF NOT EXISTS revenue_allocations \([\s\S]*?\n\);/)[0];
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    db.exec('ALTER TABLE revenue_allocations RENAME TO revenue_allocations_v1;');
    db.exec(createSql);
    db.exec('INSERT INTO revenue_allocations SELECT * FROM revenue_allocations_v1; DROP TABLE revenue_allocations_v1;');
    db.exec('COMMIT; PRAGMA foreign_keys = ON;');
  }
}

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
// node:sqlite không nhận undefined -> chuyển thành NULL
const clean = (params) => params.map((p) => (p === undefined ? null : p));

const get = (sql, ...p) => stmt(sql).get(...clean(p));
const all = (sql, ...p) => stmt(sql).all(...clean(p));
const run = (sql, ...p) => stmt(sql).run(...clean(p));

let depth = 0;
/** Chạy fn trong một transaction; lồng nhau thì gộp vào transaction ngoài. */
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

module.exports = { db, get, all, run, tx, DB_PATH };
