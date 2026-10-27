'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.FLC_DB || path.join(__dirname, '..', '..', 'data', 'flc.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

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
