const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

// Data directory: env override (e.g. /var/data on Render) or local ./data
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'data.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL CHECK (role IN ('admin','master','mechanic')),
      name TEXT NOT NULL,
      username TEXT,
      password_hash TEXT,
      personnel_no TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      car_brand_model TEXT,
      vin TEXT,
      plate TEXT,
      mileage TEXT,
      client_name TEXT,
      parts_source TEXT,
      status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','done','archived')),
      master_id INTEGER NOT NULL,
      mechanic_id INTEGER NOT NULL,
      recommendations TEXT,
      completed_at TEXT,
      archived_at TEXT,
      FOREIGN KEY (master_id) REFERENCES users(id),
      FOREIGN KEY (mechanic_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      labor_hours REAL,
      done INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime TEXT,
      uploaded_by INTEGER,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (uploaded_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id INTEGER,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  // Seed demo data on first run
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 0) {
    const insertUser = db.prepare(
      'INSERT INTO users (role, name, username, password_hash, personnel_no) VALUES (?,?,?,?,?)'
    );

    // Admin: admin / admin
    insertUser.run('admin', 'Администратор', 'admin', bcrypt.hashSync('admin', 10), null);

    // Master: master1 / pass
    insertUser.run('master', 'Иванов Иван', 'master1', bcrypt.hashSync('pass', 10), null);

    // Mechanics: 001 and 002
    insertUser.run('mechanic', 'Петров Пётр', null, null, '001');
    insertUser.run('mechanic', 'Сидоров Алексей', null, null, '002');

    // Demo order
    const masterId = db.prepare("SELECT id FROM users WHERE username='master1'").get().id;
    const mech1Id = db.prepare("SELECT id FROM users WHERE personnel_no='001'").get().id;

    const orderInsert = db.prepare(`
      INSERT INTO orders (order_number, car_brand_model, vin, plate, mileage, client_name, parts_source, master_id, mechanic_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const orderInfo = orderInsert.run(
      'ЗН-2026-0001',
      'Toyota Camry 70',
      'XW7BF4FK30S123456',
      'А123БВ 777',
      '85 400',
      'Смирнов Алексей Викторович',
      'our',
      masterId,
      mech1Id
    );

    const workInsert = db.prepare(
      'INSERT INTO works (order_id, title, labor_hours, sort_order) VALUES (?,?,?,?)'
    );
    workInsert.run(orderInfo.lastInsertRowid, 'Замена масла ДВС + фильтр', 0.5, 1);
    workInsert.run(orderInfo.lastInsertRowid, 'Диагностика ходовой', 1.0, 2);
    workInsert.run(orderInfo.lastInsertRowid, 'Замена передних колодок', 1.5, 3);

    console.log('[db] Seed data inserted (admin/admin, master1/pass, механики 001/002, 1 заказ-наряд).');
  }
}

module.exports = { db, init };
