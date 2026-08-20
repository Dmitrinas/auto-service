const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { db, init } = require('./db');

init();

const app = express();
const PORT = process.env.PORT || 3000;
// Photos live in the persistent data dir so they survive deploys/restarts
const PHOTOS_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'photos')
  : path.join(__dirname, 'public', 'uploads', 'photos');
fs.mkdirSync(PHOTOS_DIR, { recursive: true });
app.use('/uploads', express.static(PHOTOS_DIR));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// -------- Multer for photo uploads --------
const storage = multer.diskStorage({
  destination: PHOTOS_DIR,
  filename: (req, file, cb) => {
    const ext = (file.mimetype || '').includes('png') ? '.png' :
                (file.mimetype || '').includes('webp') ? '.webp' : '.jpg';
    // req.params may be empty in storage callback; we rename after upload
    cb(null, `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 } });
const fsPromises = require('fs').promises;

// -------- Auth helpers --------
function tokenFor(userId) {
  return Buffer.from(`u${userId}:${Date.now()}`).toString('base64');
}
function userFromToken(token) {
  if (!token) return null;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const id = parseInt((decoded.split(':')[0] || '').replace(/^u/, ''), 10);
    if (!id) return null;
    return db.prepare('SELECT id, role, name, username, personnel_no FROM users WHERE id = ?').get(id) || null;
  } catch { return null; }
}
function authRequired(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
                req.query.token;
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// -------- Auth routes --------
app.post('/api/auth/login', (req, res) => {
  const { role, username, password, name, personnel_no } = req.body || {};
  let user = null;
  if (role === 'admin') {
    if (!username || !password) return res.status(400).json({ error: 'username+password required' });
    const row = db.prepare('SELECT * FROM users WHERE role=? AND username=?').get('admin', username);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    user = row;
  } else if (role === 'master') {
    if (!username || !password) return res.status(400).json({ error: 'username+password required' });
    const row = db.prepare('SELECT * FROM users WHERE role=? AND username=?').get('master', username);
    if (!row || !bcrypt.compareSync(password, row.password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    user = row;
  } else if (role === 'mechanic') {
    if (!name || !personnel_no) return res.status(400).json({ error: 'name+personnel_no required' });
    const nameTrim = String(name).trim();
    const pnTrim = String(personnel_no).trim();
    // 1. Exact match (fast path)
    let row = db.prepare(
      'SELECT * FROM users WHERE role=? AND personnel_no=? AND name=?'
    ).get('mechanic', pnTrim, nameTrim);
    // 2. ASCII-case-insensitive fallback (for Latin names; SQLite `lower()` doesn't
    //    fold Cyrillic so we do it in JS)
    if (!row) {
      const lower = (s) => String(s).toLowerCase();
      const candidates = db.prepare(
        'SELECT * FROM users WHERE role=? AND personnel_no=?'
      ).all('mechanic', pnTrim);
      row = candidates.find(u => lower(u.name) === lower(nameTrim));
    }
    if (!row) return res.status(401).json({ error: 'Механик с таким именем и табельным номером не найден' });
    user = row;
  } else {
    return res.status(400).json({ error: 'unknown role' });
  }
  const token = tokenFor(user.id);
  res.json({ token, user: { id: user.id, role: user.role, name: user.name, username: user.username, personnel_no: user.personnel_no } });
});

app.get('/api/auth/me', authRequired, (req, res) => res.json({ user: req.user }));

// -------- Admin: users --------
app.get('/api/admin/users', authRequired, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT id, role, name, username, personnel_no, is_demo, created_at FROM users ORDER BY role, name').all();
  res.json({ users: rows });
});
app.post('/api/admin/users', authRequired, requireRole('admin'), (req, res) => {
  const { role, name, username, password, personnel_no } = req.body || {};
  if (!role || !name) return res.status(400).json({ error: 'role+name required' });
  if (!['master','mechanic'].includes(role)) return res.status(400).json({ error: 'role must be master or mechanic' });
  if (role === 'master') {
    if (!username || !password) return res.status(400).json({ error: 'Для мастера нужны логин и пароль' });
    const exists = db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if (exists) return res.status(409).json({ error: 'Логин уже занят' });
    const info = db.prepare(
      'INSERT INTO users (role, name, username, password_hash) VALUES (?,?,?,?)'
    ).run('master', name, username, bcrypt.hashSync(password, 10));
    return res.json({ id: info.lastInsertRowid, name, username, password });
  }
  if (role === 'mechanic') {
    if (!personnel_no) return res.status(400).json({ error: 'Для механика нужен табельный номер' });
    const exists = db.prepare('SELECT id FROM users WHERE personnel_no=? AND role=?').get(personnel_no, 'mechanic');
    if (exists) return res.status(409).json({ error: 'Механик с таким табельным номером уже есть' });
    const info = db.prepare(
      'INSERT INTO users (role, name, personnel_no) VALUES (?,?,?)'
    ).run('mechanic', name, personnel_no);
    return res.json({ id: info.lastInsertRowid, name, personnel_no });
  }
});
app.post('/api/admin/reset-demo', authRequired, requireRole('admin'), (req, res) => {
  // Wipe all non-demo data and re-seed. Demo users (is_demo=1) survive.
  try {
    db.exec(`
      DELETE FROM notifications;
      DELETE FROM photos;
      DELETE FROM works;
      DELETE FROM orders;
      DELETE FROM users WHERE is_demo = 0;
    `);
    // Reset admin password to 'admin' (in case it was changed)
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_demo=1").get();
    if (admin) {
      db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync('admin', 10), admin.id);
    }
    res.json({ ok: true, message: 'Демо-данные сброшены. Все заказы, работы, фото, уведомления удалены. Не-демо пользователи удалены.' });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/admin/restore', authRequired, requireRole('admin'), (req, res) => {
  const data = req.body;
  if (!data || !data.users || !data.orders) return res.status(400).json({ error: 'Invalid backup file' });
  const tx = db.transaction(() => {
    // Wipe everything (including photos on disk)
    const photos = db.prepare('SELECT filename FROM photos').all();
    for (const p of photos) {
      try { require('fs').unlinkSync(path.join(PHOTOS_DIR, p.filename)); } catch {}
    }
    db.exec(`
      DELETE FROM notifications;
      DELETE FROM photos;
      DELETE FROM works;
      DELETE FROM orders;
      DELETE FROM users;
    `);
    // Insert users
    const insUser = db.prepare(
      `INSERT INTO users (id, role, name, username, password_hash, personnel_no, is_demo, created_at)
       VALUES (?,?,?,?,?,?,?, COALESCE(?, datetime('now')))`
    );
    for (const u of data.users) {
      insUser.run(u.id, u.role, u.name, u.username || null, u.password_hash || null, u.personnel_no || null, u.is_demo || 0, u.created_at || null);
    }
    // Insert orders
    const insOrder = db.prepare(
      `INSERT INTO orders (id, order_number, created_at, car_brand_model, vin, plate, mileage, client_name, parts_source, status, master_id, mechanic_id, recommendations, completed_at, archived_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const o of data.orders) {
      insOrder.run(o.id, o.order_number, o.created_at, o.car_brand_model || null, o.vin || null, o.plate || null, o.mileage || null, o.client_name || null, o.parts_source || 'our', o.status, o.master_id, o.mechanic_id, o.recommendations || null, o.completed_at || null, o.archived_at || null);
    }
    // Works
    const insWork = db.prepare(
      `INSERT INTO works (id, order_id, title, labor_hours, done, sort_order) VALUES (?,?,?,?,?,?)`
    );
    for (const o of data.orders) {
      (o.works || []).forEach((w, i) => {
        insWork.run(w.id || null, o.id, w.title, w.labor_hours || 0, w.done ? 1 : 0, w.sort_order || i + 1);
      });
    }
  });
  try {
    tx();
    res.json({ ok: true, imported: { users: data.users.length, orders: data.orders.length } });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/admin/users/:id', authRequired, requireRole('admin'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: 'not found' });
  if (u.role === 'admin') return res.status(400).json({ error: 'Нельзя удалить админа' });
  if (u.is_demo) return res.status(400).json({ error: 'Нельзя удалить демо-пользователя (используйте сброс демо-данных)' });
  // Unlink from orders
  db.prepare('UPDATE orders SET master_id = (SELECT id FROM users WHERE role=? LIMIT 1) WHERE master_id=?').run('admin', id);
  const activeMech = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE mechanic_id=? AND status!='archived'").get(id).c;
  if (activeMech > 0) return res.status(400).json({ error: 'У механика есть активные заказ-наряды' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  res.json({ ok: true });
});

// Lists for dropdowns
app.get('/api/users/masters', authRequired, (req, res) => {
  const rows = db.prepare("SELECT id, name, username FROM users WHERE role='master' ORDER BY name").all();
  res.json({ masters: rows });
});
app.get('/api/users/mechanics', authRequired, (req, res) => {
  const rows = db.prepare("SELECT id, name, personnel_no FROM users WHERE role='mechanic' ORDER BY name").all();
  res.json({ mechanics: rows });
});

// -------- Orders --------
function orderFull(orderId) {
  const o = db.prepare(`
    SELECT o.*, m.name AS master_name, m.username AS master_username,
           mc.name AS mechanic_name, mc.personnel_no AS mechanic_no
    FROM orders o
    JOIN users m ON m.id = o.master_id
    JOIN users mc ON mc.id = o.mechanic_id
    WHERE o.id = ?
  `).get(orderId);
  if (!o) return null;
  o.works = db.prepare('SELECT * FROM works WHERE order_id=? ORDER BY sort_order, id').all(orderId);
  o.photos = db.prepare('SELECT id, filename, mime, uploaded_at FROM photos WHERE order_id=? ORDER BY id').all(orderId);
  return o;
}

function visibleOrdersWhere(user) {
  if (user.role === 'admin') return { sql: '1=1', params: [] };
  if (user.role === 'master') return { sql: 'o.master_id = ?', params: [user.id] };
  if (user.role === 'mechanic') return { sql: 'o.mechanic_id = ?', params: [user.id] };
  return { sql: '0=1', params: [] };
}

app.get('/api/orders/next-number', authRequired, requireRole('master'), (req, res) => {
  // Find the highest number in orders matching pattern ЗН-YYYY-NNNN
  const year = new Date().getFullYear();
  const prefix = `ЗН-${year}-`;
  const rows = db.prepare(
    `SELECT order_number FROM orders WHERE order_number LIKE ?`
  ).all(prefix + '%');
  let max = 0;
  for (const r of rows) {
    const m = r.order_number.match(new RegExp(`^${prefix}(\\d+)$`));
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  // Find any other number pattern too (e.g. "33", "34")
  const all = db.prepare(`SELECT order_number FROM orders`).all();
  for (const r of all) {
    const m = String(r.order_number).match(/(\d+)\s*$/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  res.json({ next_number: `${prefix}${String(max + 1).padStart(4, '0')}` });
});

app.get('/api/orders', authRequired, (req, res) => {
  const { status } = req.query;
  const w = visibleOrdersWhere(req.user);
  let sql = `SELECT o.id, o.order_number, o.status, o.created_at, o.completed_at, o.car_brand_model, o.plate,
                    m.name AS master_name, mc.name AS mechanic_name,
                    CASE WHEN o.recommendations IS NOT NULL AND length(trim(o.recommendations)) > 0 THEN 1 ELSE 0 END AS has_recommendations
             FROM orders o
             JOIN users m ON m.id = o.master_id
             JOIN users mc ON mc.id = o.mechanic_id
             WHERE ${w.sql}`;
  const params = [...w.params];
  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  sql += ' ORDER BY o.created_at DESC';
  res.json({ orders: db.prepare(sql).all(...params) });
});

app.get('/api/orders/:id', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = orderFull(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  // Access check
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  res.json({ order: o });
});

app.post('/api/orders', authRequired, requireRole('master'), (req, res) => {
  const b = req.body || {};
  const required = ['order_number','car_brand_model','vin','plate','mileage','client_name','mechanic_id'];
  for (const k of required) if (!b[k]) return res.status(400).json({ error: `Поле ${k} обязательно` });
  const exists = db.prepare('SELECT id FROM orders WHERE order_number=?').get(b.order_number);
  if (exists) return res.status(409).json({ error: 'Заказ-наряд с таким номером уже существует' });
  const mech = db.prepare("SELECT id FROM users WHERE id=? AND role='mechanic'").get(b.mechanic_id);
  if (!mech) return res.status(400).json({ error: 'Механик не найден' });
  const info = db.prepare(`
    INSERT INTO orders (order_number, car_brand_model, vin, plate, mileage, client_name, parts_source, master_id, mechanic_id)
    VALUES (?,?,?,?,?,?,?,?,?)
  `).run(
    b.order_number, b.car_brand_model, b.vin, b.plate, b.mileage, b.client_name,
    b.parts_source || 'our', req.user.id, b.mechanic_id
  );
  const orderId = info.lastInsertRowid;
  // Initial works
  if (Array.isArray(b.works)) {
    const ins = db.prepare('INSERT INTO works (order_id, title, labor_hours, sort_order) VALUES (?,?,?,?)');
    b.works.forEach((w, i) => {
      if (w && w.title) ins.run(orderId, String(w.title).trim(), Number(w.labor_hours) || 0, i + 1);
    });
  }
  // Notify mechanic
  db.prepare(`
    INSERT INTO notifications (user_id, order_id, kind, message) VALUES (?,?,?,?)
  `).run(b.mechanic_id, orderId, 'new_order', `Новый заказ-наряд №${b.order_number}`);
  res.json({ id: orderId });
});

app.post('/api/orders/:id/works', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  // Both master (who created) and assigned mechanic can add works
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'admin') return res.status(403).json({ error: 'forbidden' });
  const { title, labor_hours } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  const sort = (db.prepare('SELECT COALESCE(MAX(sort_order),0)+1 AS s FROM works WHERE order_id=?').get(id).s);
  const info = db.prepare('INSERT INTO works (order_id, title, labor_hours, sort_order) VALUES (?,?,?,?)')
    .run(id, String(title).trim(), Number(labor_hours) || 0, sort);
  res.json({ id: info.lastInsertRowid });
});

app.delete('/api/orders/:id/works/:wid', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'admin') return res.status(403).json({ error: 'forbidden' });
  db.prepare('DELETE FROM works WHERE id=? AND order_id=?').run(wid, id);
  res.json({ ok: true });
});

app.patch('/api/orders/:id/works/:wid', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const wid = parseInt(req.params.wid, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const { done } = req.body || {};
  if (typeof done !== 'boolean') return res.status(400).json({ error: 'done (bool) required' });
  db.prepare('UPDATE works SET done=? WHERE id=? AND order_id=?').run(done ? 1 : 0, wid, id);
  res.json({ ok: true });
});

app.patch('/api/orders/:id/recommendations', authRequired, requireRole('mechanic'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const { recommendations } = req.body || {};
  const newText = String(recommendations || '').trim();
  const hadText = (o.recommendations || '').trim().length > 0;
  db.prepare('UPDATE orders SET recommendations=? WHERE id=?').run(String(recommendations || ''), id);
  // Notify master only if there is new content and it differs from before
  if (newText && newText !== (o.recommendations || '')) {
    db.prepare(`
      INSERT INTO notifications (user_id, order_id, kind, message) VALUES (?,?,?,?)
    `).run(o.master_id, id, 'recommendations', hadText
      ? `Механик обновил рекомендации в наряде №${o.order_number}`
      : `Механик добавил рекомендации в наряд №${o.order_number}`);
  }
  res.json({ ok: true });
});

app.post('/api/orders/:id/complete', authRequired, requireRole('mechanic'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  const unfinished = db.prepare('SELECT COUNT(*) AS c FROM works WHERE order_id=? AND done=0').get(id).c;
  if (unfinished > 0) return res.status(400).json({ error: 'Есть невыполненные работы' });
  db.prepare("UPDATE orders SET status='done', completed_at=datetime('now') WHERE id=?").run(id);
  db.prepare(`
    INSERT INTO notifications (user_id, order_id, kind, message) VALUES (?,?,?,?)
  `).run(o.master_id, id, 'order_done', `Заказ-наряд №${o.order_number} выполнен`);
  res.json({ ok: true });
});

app.post('/api/orders/:id/archive', authRequired, requireRole('master'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (o.status !== 'done') return res.status(400).json({ error: 'Сначала нужно выполнить заказ-наряд' });
  db.prepare("UPDATE orders SET status='archived', archived_at=datetime('now') WHERE id=?").run(id);
  res.json({ ok: true });
});

// -------- Photos --------
app.delete('/api/orders/:id/photos/:pid', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const pid = parseInt(req.params.pid, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  const photo = db.prepare('SELECT * FROM photos WHERE id=? AND order_id=?').get(pid, id);
  if (!photo) return res.status(404).json({ error: 'photo not found' });
  // Master or assigned mechanic (or admin) can delete
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  // Remove file from disk
  const fsPromisesLocal = require('fs').promises;
  const filePath = path.join(PHOTOS_DIR, photo.filename);
  fsPromisesLocal.unlink(filePath).catch(() => { /* file may already be gone */ });
  db.prepare('DELETE FROM photos WHERE id=?').run(pid);
  res.json({ ok: true });
});

app.post('/api/orders/:id/photos', authRequired, upload.single('photo'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'not found' });
  if (!req.file) return res.status(400).json({ error: 'no file' });
  if (req.user.role === 'master' && o.master_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (req.user.role === 'mechanic' && o.mechanic_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  // Rename to a proper order-prefixed filename
  const ext = req.file.filename.match(/\.[^.]+$/)?.[0] || '.jpg';
  const newName = `o${id}_${Date.now()}${ext}`;
  const oldPath = path.join(PHOTOS_DIR, req.file.filename);
  const newPath = path.join(PHOTOS_DIR, newName);
  try { await fsPromises.rename(oldPath, newPath); } catch (e) { /* ignore */ }
  const info = db.prepare(
    'INSERT INTO photos (order_id, filename, mime, uploaded_by) VALUES (?,?,?,?)'
  ).run(id, newName, req.file.mimetype, req.user.id);
  // Notify the other side
  const otherId = req.user.role === 'mechanic' ? o.master_id : o.mechanic_id;
  db.prepare(`
    INSERT INTO notifications (user_id, order_id, kind, message) VALUES (?,?,?,?)
  `).run(otherId, id, 'photo', `Новое фото в заказ-наряде №${o.order_number}`);
  res.json({ id: info.lastInsertRowid, filename: newName });
});

// -------- Notifications --------
app.get('/api/notifications', authRequired, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50'
  ).all(req.user.id);
  res.json({ notifications: rows });
});
app.post('/api/notifications/read', authRequired, (req, res) => {
  const { ids } = req.body || {};
  if (Array.isArray(ids) && ids.length) {
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${placeholders})`)
      .run(req.user.id, ...ids);
  } else {
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  }
  res.json({ ok: true });
});

// SPA fallback
app.get(/^\/(?!api|uploads).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[auto-service] listening on http://0.0.0.0:${PORT}`);
});
