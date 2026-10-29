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

/** Nâng cấp CSDL đã tạo bằng schema cũ (SQLite không sửa được CHECK/NOT NULL → dựng lại bảng) */
function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const tableSql = (name) => db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)?.sql;
  const columns = (name) => db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);

  /** Dựng lại bảng theo định nghĩa mới trong schema.sql, chép các cột trùng tên, rồi chạy fixup (bảng cũ tên <name>_old) */
  function rebuild(name, fixup = '') {
    const createSql = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))[0];
    db.exec(`ALTER TABLE ${name} RENAME TO ${name}_old;`);
    db.exec(createSql);
    const keep = columns(name).filter((c) => columns(`${name}_old`).includes(c)).join(', ');
    db.exec(`INSERT INTO ${name} (${keep}) SELECT ${keep} FROM ${name}_old; ${fixup} DROP TABLE ${name}_old;`);
  }

  const steps = [];
  if (!columns('users').includes('avatar_file')) steps.push(() => db.exec('ALTER TABLE users ADD COLUMN avatar_file TEXT;'));
  if (!tableSql('revenue_allocations').includes("'DEV'")) steps.push(() => rebuild('revenue_allocations'));
  if (columns('payments').includes('rejected')) {
    steps.push(() => rebuild('payments', `UPDATE payments SET status = (SELECT CASE WHEN o.rejected = 1 THEN 'REJECTED' WHEN o.reconciled = 1 THEN 'RECONCILED'
      WHEN o.confirmed_at IS NOT NULL THEN 'CONFIRMED' ELSE 'DECLARED' END FROM payments_old o WHERE o.id = payments.id);`));
  }
  if (!tableSql('payouts').includes("'SCHEDULED'")) {
    steps.push(() => rebuild('payouts', "UPDATE payouts SET status = 'PAID', created_at = paid_at, paid_by = created_by;"));
  }
  if (!tableSql('commissions').includes("'PAYABLE'")) {
    // Dòng đã duyệt trước đây: coi như freelancer đã đồng ý (quy trình cũ chỉ cần M&T duyệt)
    steps.push(() => rebuild('commissions', "UPDATE commissions SET user_confirmed_at = approved_at WHERE status IN ('APPROVED', 'PAID');"));
  }
  if (tableSql('order_status_history')) {
    steps.push(() => db.exec(`INSERT INTO status_history (entity, entity_id, order_id, from_status, to_status, actor_id, reason, created_at)
      SELECT 'order', order_id, order_id, from_status, to_status, actor_id, note, created_at FROM order_status_history ORDER BY id;
      DROP TABLE order_status_history;`));
  }
  if (!steps.length) return;
  // legacy_alter_table: đổi tên bảng không được viết lại khóa ngoại của bảng khác sang <name>_old
  db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON; BEGIN;');
  try {
    for (const step of steps) step();
    // Bảng dựng lại mất trigger/index cũ; trigger cũ có thể mang điều kiện cũ → tạo lại toàn bộ theo schema.sql
    for (const t of schema.matchAll(/CREATE TRIGGER IF NOT EXISTS (\w+)/g)) db.exec(`DROP TRIGGER IF EXISTS ${t[1]};`);
    db.exec(schema);
    db.exec('COMMIT;');
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF; PRAGMA foreign_keys = ON;');
  }
  const broken = db.prepare('PRAGMA foreign_key_check').all();
  if (broken.length) throw new Error(`Nâng cấp CSDL lỗi khóa ngoại: ${JSON.stringify(broken.slice(0, 3))}`);
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
