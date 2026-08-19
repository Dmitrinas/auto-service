// =====================================================
// Автосервис — фронтенд (vanilla JS SPA)
// =====================================================

const App = {
  token: localStorage.getItem('token') || null,
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  view: 'auth',
  cache: { mechanics: [], masters: [], lastBellSeen: 0 },
  pollHandle: null,
};

// -------- HTTP --------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (App.token) headers.Authorization = `Bearer ${App.token}`;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    // Don't kick the user back to auth on a failed login — that's a credentials issue
    if (path === '/api/auth/login') {
      throw new Error(data.error || 'Неверный логин или пароль');
    }
    logout();
    throw new Error('Сессия истекла');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// -------- Toast --------
function toast(message, type = 'info', ms = 3500) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  c.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; setTimeout(() => el.remove(), 300); }, ms);
}

// -------- Routing --------
function showView(name) {
  App.view = name;
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const v = document.getElementById('view-' + name);
  if (v) v.classList.remove('hidden');
  document.body.classList.toggle('on-auth', name === 'auth');
  if (name !== 'auth') startPolling(); else stopPolling();
}

function logout() {
  App.token = null;
  App.user = null;
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  stopPolling();
  showView('auth');
}

// -------- Bell / notifications --------
async function refreshBell() {
  if (!App.token) return;
  try {
    const { notifications } = await api('/api/notifications');
    const unread = notifications.filter(n => !n.read).length;
    const countEl = document.getElementById('bell-count');
    countEl.textContent = unread;
    countEl.classList.toggle('hidden', unread === 0);
    App._lastNotifications = notifications;
    renderBellDropdown(notifications);
  } catch (e) { /* silent */ }
}

function renderBellDropdown(notifications) {
  const dd = document.getElementById('bell-dropdown');
  if (!notifications || notifications.length === 0) {
    dd.innerHTML = '<div class="n-empty">Нет уведомлений</div>';
    return;
  }
  dd.innerHTML = notifications.slice(0, 20).map(n => `
    <div class="n-item ${n.read ? '' : 'unread'}" data-order-id="${n.order_id || ''}">
      <div class="n-msg">${escapeHtml(n.message)}</div>
      <div class="n-time">${formatTime(n.created_at)}</div>
    </div>
  `).join('');
  // Click handler
  dd.querySelectorAll('.n-item').forEach(el => {
    el.addEventListener('click', () => {
      const orderId = el.dataset.orderId;
      if (orderId) {
        if (App.user.role === 'mechanic') openMechOrder(orderId);
        else openOrder(orderId);
      }
      hideBellDropdown();
    });
  });
}

function hideBellDropdown() {
  document.getElementById('bell-dropdown').classList.add('hidden');
}

function startPolling() {
  if (App.pollHandle) return;
  refreshBell();
  App.pollHandle = setInterval(() => {
    // Skip polling if user is typing or voice is active — otherwise
    // the innerHTML replacement destroys the focused input/textarea and
    // collapses the soft keyboard on mobile.
    if (App.fieldFocused) return;
    const ae = document.activeElement;
    if (ae && (ae.matches('input, textarea, select') || ae.isContentEditable)) return;
    if (App.voiceActive) return;
    refreshBell();
    if (App.view === 'master') {
      const activeTab = document.querySelector('#view-master .tabs .tab.active')?.dataset.masterTab;
      if (activeTab === 'active') loadMasterOrders('in_progress');
      else if (activeTab === 'done') loadMasterOrders('done');
      else if (activeTab === 'archived') loadMasterOrders('archived');
    } else if (App.view === 'mechanic') {
      const activeTab = document.querySelector('#view-mechanic .tabs .tab.active')?.dataset.mechTab;
      if (activeTab === 'active') loadMechOrders('in_progress');
      else if (activeTab === 'done') loadMechOrders('done');
    } else if (App.view === 'order') loadOrderDetail(App._currentOrderId);
    else if (App.view === 'mech-order') loadMechOrderDetail(App._currentOrderId);
  }, 3000);
}

function stopPolling() {
  if (App.pollHandle) { clearInterval(App.pollHandle); App.pollHandle = null; }
}

// -------- Helpers --------
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'только что';
  if (diff < 3600) return `${Math.floor(diff/60)} мин назад`;
  if (diff < 86400) return `${Math.floor(diff/3600)} ч назад`;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function statusLabel(s) {
  return { in_progress: 'В работе', done: 'Выполнен', archived: 'Архив' }[s] || s;
}
function partsLabel(s) { return s === 'client' ? 'Запчасти клиента' : 'Наши запчасти'; }

// =====================================================
// Auth view (role selector + 3 dedicated login forms)
// =====================================================
function initRoleLoginForms() {
  // Each login form is now separate. The selector at #view-auth links to
  // /#/admin, /#/master, /#/mechanic which trigger the right login view.
  const wire = (formId, errId, role, build) => {
    const form = document.getElementById(formId);
    if (!form) return;
    const errEl = document.getElementById(errId);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.textContent = '';
      const fd = new FormData(form);
      const body = build(fd);
      try {
        const { token, user } = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ role, ...body }) });
        App.token = token;
        App.user = user;
        localStorage.setItem('token', token);
        localStorage.setItem('user', JSON.stringify(user));
        toast(`Добро пожаловать, ${user.name}!`, 'success');
        location.hash = '#/';
        routeForRole();
      } catch (err) {
        errEl.textContent = err.message;
      }
    });
  };
  wire('form-login-admin', 'login-admin-error', 'admin',
    fd => ({ username: fd.get('username')?.trim(), password: fd.get('password') }));
  wire('form-login-master', 'login-master-error', 'master',
    fd => ({ username: fd.get('username')?.trim(), password: fd.get('password') }));
  wire('form-login-mechanic', 'login-mechanic-error', 'mechanic',
    fd => ({ name: fd.get('name')?.trim(), personnel_no: fd.get('personnel_no')?.trim() }));
}

function initHashRouting() {
  // Map URL hash → which view to show
  //   #/           → role selector
  //   #/admin      → admin login
  //   #/master     → master login
  //   #/mechanic   → mechanic login
  const map = {
    '': 'auth',
    '#': 'auth',
    '#/': 'auth',
    '#/admin': 'login-admin',
    '#/master': 'login-master',
    '#/mechanic': 'login-mechanic',
  };
  function apply() {
    // If user is logged in, routeForRole takes priority over hash
    if (App.token && App.user) return;
    const viewId = map[location.hash] || 'auth';
    showView(viewId);
  }
  window.addEventListener('hashchange', apply);
  // Initial application
  if (!App.token && location.hash !== '' && location.hash !== '#' && location.hash !== '#/') {
    // Already set in URL
  } else if (!App.token) {
    showView('auth');
  }
  apply();
}

function routeForRole() {
  if (!App.user) return showView('auth');
  if (App.user.role === 'admin') { showView('admin'); loadAdmin(); }
  else if (App.user.role === 'master') { showView('master'); initMasterView(); }
  else if (App.user.role === 'mechanic') { showView('mechanic'); initMechView(); }
  else showView('auth');
}

// =====================================================
// Admin
// =====================================================
// -------- Backup / Restore --------
async function exportData() {
  try {
    const token = App.token;
    const [users, orders, wRes, pRes, nRes] = await Promise.all([
      api('/api/admin/users', { headers: { Authorization: 'Bearer ' + token } }),
      api('/api/orders'),
      fetch('/api/orders', { headers: { Authorization: 'Bearer ' + token } }).then(r => r.json()),
    ]);
    // Detailed export: per order, fetch full details
    const detailedOrders = [];
    for (const o of orders.orders) {
      const r = await api('/api/orders/' + o.id);
      detailedOrders.push(r.order);
    }
    const data = {
      version: 1,
      exported_at: new Date().toISOString(),
      users: users.users,
      orders: detailedOrders,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auto-service-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Резервная копия скачана', 'success');
  } catch (e) { toast('Ошибка экспорта: ' + e.message, 'error'); }
}

function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm('Импорт заменит текущих пользователей, заказы, работы, фото. Продолжить?')) return;
  const reader = new FileReader();
  reader.onload = async (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      // Send to server for restore
      const r = await api('/api/admin/restore', { method: 'POST', body: JSON.stringify(data) });
      toast(`Импортировано: ${r.imported?.users ?? '?'} юзеров, ${r.imported?.orders ?? '?'} нарядов`, 'success');
      loadAdmin();
    } catch (err) { toast('Ошибка импорта: ' + err.message, 'error'); }
  };
  reader.readAsText(file);
}

async function resetDemo() {
  if (!confirm('Удалить все наряды, работы, фото, уведомления и не-демо пользователей? Демо-аккаунты останутся.')) return;
  try {
    await api('/api/admin/reset-demo', { method: 'POST' });
    toast('Демо-данные сброшены', 'success');
    loadAdmin();
  } catch (e) { toast(e.message, 'error'); }
}

async function loadAdmin() {
  try {
    const { users } = await api('/api/admin/users');
    const masters = users.filter(u => u.role === 'master');
    const mechs = users.filter(u => u.role === 'mechanic');
    document.getElementById('list-masters').innerHTML = masters.map(m => `
      <li>
        <span class="badge">Мастер</span>
        <span class="name">${escapeHtml(m.name)}</span>
        <span class="meta">логин: ${escapeHtml(m.username || '—')}</span>
        ${m.is_demo ? '<span class="badge-demo" title="Создан при первом запуске, нельзя удалить">демо</span>' : '<span class="badge-new">новый</span>'}
        ${!m.is_demo ? `<button class="danger" data-del-user="${m.id}">Удалить</button>` : ''}
      </li>
    `).join('') || '<li class="muted">Нет мастеров</li>';
    document.getElementById('list-mechanics').innerHTML = mechs.map(m => `
      <li>
        <span class="badge">Механик</span>
        <span class="name">${escapeHtml(m.name)}</span>
        <span class="meta">таб. №${escapeHtml(m.personnel_no || '—')}</span>
        ${m.is_demo ? '<span class="badge-demo" title="Создан при первом запуске, нельзя удалить">демо</span>' : '<span class="badge-new">новый</span>'}
        ${!m.is_demo ? `<button class="danger" data-del-user="${m.id}">Удалить</button>` : ''}
      </li>
    `).join('') || '<li class="muted">Нет механиков</li>';
    document.querySelectorAll('[data-del-user]').forEach(b => {
      b.addEventListener('click', async () => {
        if (!confirm('Удалить пользователя?')) return;
        try {
          await api(`/api/admin/users/${b.dataset.delUser}`, { method: 'DELETE' });
          toast('Удалено', 'success');
          loadAdmin();
        } catch (e) { toast(e.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

function initAdminView() {
  // Export / Import / Reset demo data
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json';
    inp.addEventListener('change', importData);
    inp.click();
  });
  document.getElementById('btn-reset-demo').addEventListener('click', resetDemo);

  document.getElementById('form-add-master').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
        role: 'master',
        name: fd.get('name'),
        username: fd.get('username'),
        password: fd.get('password'),
      })});
      e.target.reset();
      toast('Мастер добавлен', 'success');
      loadAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });
  document.getElementById('form-add-mechanic').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/admin/users', { method: 'POST', body: JSON.stringify({
        role: 'mechanic',
        name: fd.get('name'),
        personnel_no: fd.get('personnel_no'),
      })});
      e.target.reset();
      toast('Механик добавлен', 'success');
      loadAdmin();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// =====================================================
// Master view
// =====================================================
async function initMasterView() {
  document.getElementById('master-name').textContent = App.user.name;
  // Tabs
  document.querySelectorAll('#view-master .tabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#view-master .tabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('#view-master .tab-pane').forEach(p => p.classList.add('hidden'));
      document.getElementById('master-tab-' + t.dataset.masterTab).classList.remove('hidden');
      if (t.dataset.masterTab === 'active') loadMasterOrders('in_progress');
      else if (t.dataset.masterTab === 'done') loadMasterOrders('done');
      else if (t.dataset.masterTab === 'archived') loadMasterOrders('archived');
    });
  });
  // New order button (outside tabs)
  document.getElementById('master-new-btn').addEventListener('click', () => {
    document.querySelectorAll('#view-master .tabs .tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('#view-master .tab-pane').forEach(p => p.classList.add('hidden'));
    document.getElementById('master-tab-new').classList.remove('hidden');
    prepareNewOrderForm();
    document.getElementById('master-tab-new').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  loadMasterOrders('in_progress');
  initNewOrderForm();
}

async function loadMasterOrders(status) {
  const listId = status === 'in_progress' ? 'list-orders-active'
                : status === 'done' ? 'list-orders-done'
                : 'list-orders-archived';
  const list = document.getElementById(listId);
  if (!list) return;
  try {
    const { orders } = await api('/api/orders?status=' + status);
    if (orders.length === 0) {
      list.innerHTML = '<li class="muted" style="cursor:default">Нет заказ-нарядов</li>';
      return;
    }
    list.innerHTML = orders.map(o => `
      <li data-order-id="${o.id}">
        <div class="top">
          <span class="num">№ ${escapeHtml(o.order_number)} ${o.has_recommendations ? '<span class="badge-info" title="Есть рекомендации механика">💬</span>' : ''}</span>
          <span class="status status-${o.status}">${statusLabel(o.status)}</span>
        </div>
        <div class="meta">${escapeHtml(o.car_brand_model || '—')} · ${escapeHtml(o.plate || '—')}</div>
        <div class="meta">Мастер: ${escapeHtml(o.master_name)} · Механик: ${escapeHtml(o.mechanic_name)}</div>
      </li>
    `).join('');
    list.querySelectorAll('li[data-order-id]').forEach(li => {
      li.addEventListener('click', () => openOrder(li.dataset.orderId));
    });
  } catch (e) { toast(e.message, 'error'); }
}

async function openOrder(orderId) {
  App._currentOrderId = orderId;
  App.view = 'order';
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-order').classList.remove('hidden');
  await loadOrderDetail(orderId);
}

async function loadOrderDetail(orderId) {
  if (!orderId) return;
  try {
    const { order } = await api('/api/orders/' + orderId);
    document.getElementById('order-detail-title').textContent = `Заказ-наряд № ${order.order_number}`;
    const canArchive = order.status === 'done' && order.master_id === App.user.id;
    const body = document.getElementById('order-detail-body');
    body.innerHTML = `
      <div class="order-header">
        <div class="num">№ ${escapeHtml(order.order_number)} <span class="status status-${order.status}" style="font-size:0.7em;padding:3px 10px;border-radius:999px;margin-left:8px">${statusLabel(order.status)}</span></div>
        <dl>
          <dt>Авто</dt><dd>${escapeHtml(order.car_brand_model || '—')}</dd>
          <dt>VIN</dt><dd>${escapeHtml(order.vin || '—')}</dd>
          <dt>Гос-номер</dt><dd>${escapeHtml(order.plate || '—')}</dd>
          <dt>Пробег</dt><dd>${escapeHtml(order.mileage || '—')}</dd>
          <dt>Клиент</dt><dd>${escapeHtml(order.client_name || '—')}</dd>
          <dt>Запчасти</dt><dd>${partsLabel(order.parts_source)}</dd>
          <dt>Мастер</dt><dd>${escapeHtml(order.master_name)}</dd>
          <dt>Механик</dt><dd>${escapeHtml(order.mechanic_name)}${order.mechanic_no ? ' (таб. '+escapeHtml(order.mechanic_no)+')' : ''}</dd>
        </dl>
      </div>

      <div class="section">
        <h3>Работы (${order.works.length})</h3>
        <ul class="works-list">
          ${order.works.map(w => `
            <li class="${w.done ? 'done' : ''}">
              <span class="hours">${w.labor_hours || 0} ч</span>
              <span class="title">${escapeHtml(w.title)}</span>
              ${w.done ? '<span style="color:#059669">✓</span>' : ''}
            </li>
          `).join('') || '<li class="muted" style="cursor:default">Работ нет</li>'}
        </ul>
      </div>

      ${order.recommendations ? `
        <div class="section">
          <h3>Рекомендации механика</h3>
          <div>${escapeHtml(order.recommendations)}</div>
        </div>
      ` : ''}

      <div class="section">
        <h3>Фото (${order.photos.length})</h3>
        ${order.photos.length === 0 ? '<div class="muted">Фото пока нет</div>' : `
          <div class="photos-grid" id="master-photos-grid">
            ${order.photos.map(p => `
              <div class="photo-tile" data-pid="${p.id}">
                <a href="/uploads/photos/${p.filename}" target="_blank"><img src="/uploads/photos/${p.filename}" alt="" loading="lazy" /></a>
                <button class="photo-del" data-del-photo="${p.id}" title="Удалить фото">✕</button>
              </div>
            `).join('')}
          </div>
        `}
      </div>

      ${canArchive ? `<button class="danger block" id="archive-btn" style="width:100%;padding:12px">📦 Отправить в архив (удалить с экрана)</button>` : ''}

      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="print-btn block" id="print-btn" style="flex:1;padding:12px">🖨 Распечатать заказ-наряд</button>
      </div>
    `;
    if (canArchive) {
      document.getElementById('archive-btn').addEventListener('click', async () => {
        if (!confirm('Отправить заказ-наряд в архив?')) return;
        try {
          await api(`/api/orders/${orderId}/archive`, { method: 'POST' });
          toast('Заказ-наряд в архиве', 'success');
          showView('master');
          loadMasterOrders('done');
        } catch (e) { toast(e.message, 'error'); }
      });
    }
    // Print button (always available on order detail)
    const printBtn = document.getElementById('print-btn');
    if (printBtn) printBtn.addEventListener('click', () => printOrder(order));
    // Master photo delete
    body.querySelectorAll('[data-del-photo]').forEach(b => {
      b.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const pid = b.dataset.delPhoto;
        if (!confirm('Удалить фото?')) return;
        try {
          await api(`/api/orders/${orderId}/photos/${pid}`, { method: 'DELETE' });
          toast('Фото удалено', 'success');
          loadOrderDetail(orderId);
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  } catch (e) { toast(e.message, 'error'); }
}

async function printOrder(order) {
  const doc = document.getElementById('print-doc');
  const createdAt = formatDateTime(order.created_at);
  const completedAt = order.completed_at ? formatDateTime(order.completed_at) : '—';
  const totalHours = order.works.reduce((s, w) => s + (Number(w.labor_hours) || 0), 0);
  const doneWorks = order.works.filter(w => w.done).length;
  doc.innerHTML = `
    <div class="print-h1">ЗАКАЗ-НАРЯД № ${escapeHtml(order.order_number)}</div>
    <div class="print-h2">на выполнение работ по техническому обслуживанию / ремонту автомобиля</div>
    <div class="print-meta">
      <span>Дата открытия: <b>${createdAt}</b></span>
      <span>Дата закрытия: <b>${completedAt}</b></span>
    </div>

    <div class="print-section">
      <div class="print-h3">Автомобиль</div>
      <div class="print-grid2">
        <div><div class="lbl">Марка, модель</div><div class="val">${escapeHtml(order.car_brand_model || '—')}</div></div>
        <div><div class="lbl">Гос. номер</div><div class="val">${escapeHtml(order.plate || '—')}</div></div>
        <div><div class="lbl">VIN</div><div class="val">${escapeHtml(order.vin || '—')}</div></div>
        <div><div class="lbl">Пробег, км</div><div class="val">${escapeHtml(order.mileage || '—')}</div></div>
      </div>
    </div>

    <div class="print-section">
      <div class="print-h3">Заказчик</div>
      <div class="print-grid2">
        <div><div class="lbl">ФИО клиента</div><div class="val">${escapeHtml(order.client_name || '—')}</div></div>
        <div><div class="lbl">Запчасти</div><div class="val">${partsLabel(order.parts_source)}</div></div>
      </div>
    </div>

    <div class="print-section">
      <div class="print-h3">Работы (${doneWorks} из ${order.works.length} выполнено, итого ${totalHours.toFixed(1)} ч)</div>
      <table class="print-table">
        <thead>
          <tr><th style="width:30pt">№</th><th>Наименование работы</th><th style="width:60pt">Трудоёмк.</th><th style="width:60pt">Выполн.</th><th style="width:60pt">Цена</th></tr>
        </thead>
        <tbody>
          ${order.works.map((w, i) => `
            <tr>
              <td>${i+1}</td>
              <td>${escapeHtml(w.title)}</td>
              <td>${(Number(w.labor_hours) || 0).toFixed(1)} ч</td>
              <td style="text-align:center">${w.done ? '✓' : '—'}</td>
              <td></td>
            </tr>
          `).join('') || '<tr><td colspan="5" style="text-align:center;color:#888">Работы не указаны</td></tr>'}
          <tr><td colspan="2" style="text-align:right;font-weight:bold">ИТОГО:</td><td style="font-weight:bold">${totalHours.toFixed(1)} ч</td><td colspan="2"></td></tr>
        </tbody>
      </table>
    </div>

    ${order.recommendations ? `
      <div class="print-section">
        <div class="print-h3">Рекомендации механика</div>
        <div class="print-rec">${escapeHtml(order.recommendations)}</div>
      </div>
    ` : ''}

    ${order.photos.length > 0 ? `
      <div class="print-section">
        <div class="print-h3">Фото (${order.photos.length})</div>
        <div class="print-photos">
          ${order.photos.map(p => `<img src="/uploads/photos/${p.filename}" alt="" />`).join('')}
        </div>
      </div>
    ` : ''}

    <div class="print-sigs">
      <div class="print-sig">
        <div class="line">${escapeHtml(order.master_name || '')}</div>
        <div class="role">Мастер-приёмщик (подпись, дата)</div>
      </div>
      <div class="print-sig">
        <div class="line">${escapeHtml(order.mechanic_name || '')}${order.mechanic_no ? ' (таб. ' + escapeHtml(order.mechanic_no) + ')' : ''}</div>
        <div class="role">Автомеханик (подпись, дата)</div>
      </div>
      <div class="print-sig">
        <div class="line"></div>
        <div class="role">Заказчик (подпись, дата)</div>
      </div>
    </div>

    <div class="print-foot">
      Документ сформирован автоматически ${new Date().toLocaleString('ru-RU')}
    </div>
  `;
  // Wait a tick for images to settle, then print
  setTimeout(() => {
    window.print();
    // Clean up after print dialog closes
    setTimeout(() => { doc.innerHTML = ''; }, 500);
  }, 300);
}

function formatDateTime(s) {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z'));
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function prepareNewOrderForm() {
  // Load mechanics for dropdown
  try {
    const { mechanics } = await api('/api/users/mechanics');
    const sel = document.querySelector('#form-new-order select[name="mechanic_id"]');
    sel.innerHTML = '<option value="">— выберите —</option>' +
      mechanics.map(m => `<option value="${m.id}">${escapeHtml(m.name)} (таб. ${escapeHtml(m.personnel_no)})</option>`).join('');
  } catch (e) { toast(e.message, 'error'); }
  // Auto-suggest next unique order number so user doesn't bump into duplicates
  try {
    const { next_number } = await api('/api/orders/next-number');
    const numInput = document.querySelector('#form-new-order input[name="order_number"]');
    if (numInput && !numInput.value) numInput.value = next_number;
  } catch (e) { /* non-fatal */ }
  // Reset works rows
  const works = document.getElementById('new-order-works');
  works.innerHTML = '';
  addWorkRow();
}

function addWorkRow() {
  const works = document.getElementById('new-order-works');
  const row = document.createElement('div');
  row.className = 'work-row';
  row.innerHTML = `
    <input type="text" placeholder="Описание работы" />
    <input type="number" placeholder="ч" min="0" step="0.1" />
    <button type="button" class="danger" title="Удалить">✕</button>
  `;
  row.querySelector('button').addEventListener('click', () => row.remove());
  works.appendChild(row);
}

function initNewOrderForm() {
  document.getElementById('add-work-row').addEventListener('click', addWorkRow);
  document.getElementById('form-new-order').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('new-order-error');
    errEl.textContent = '';
    const fd = new FormData(e.target);
    const works = [...document.querySelectorAll('#new-order-works .work-row')].map(r => {
      const inputs = r.querySelectorAll('input');
      return { title: inputs[0].value.trim(), labor_hours: parseFloat(inputs[1].value) || 0 };
    }).filter(w => w.title);
    if (!fd.get('mechanic_id')) { errEl.textContent = 'Выберите механика'; return; }
    try {
      const body = {
        order_number: fd.get('order_number').trim(),
        car_brand_model: fd.get('car_brand_model').trim(),
        vin: fd.get('vin').trim(),
        plate: fd.get('plate').trim(),
        mileage: fd.get('mileage').trim(),
        client_name: fd.get('client_name').trim(),
        parts_source: fd.get('parts_source'),
        mechanic_id: parseInt(fd.get('mechanic_id'), 10),
        works,
      };
      await api('/api/orders', { method: 'POST', body: JSON.stringify(body) });
      toast('Заказ-наряд создан и передан механику', 'success');
      e.target.reset();
      document.querySelector('#view-master .tabs .tab[data-master-tab="active"]').click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) { errEl.textContent = err.message; }
  });
}

// =====================================================
// Mechanic view
// =====================================================
async function initMechView() {
  document.getElementById('mechanic-name').textContent = App.user.name + (App.user.personnel_no ? ' (таб. '+App.user.personnel_no+')' : '');
  document.querySelectorAll('#view-mechanic .tabs .tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#view-mechanic .tabs .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      document.querySelectorAll('#view-mechanic .tab-pane').forEach(p => p.classList.add('hidden'));
      document.getElementById('mech-tab-' + t.dataset.mechTab).classList.remove('hidden');
      if (t.dataset.mechTab === 'active') loadMechOrders('in_progress');
      else if (t.dataset.mechTab === 'done') loadMechOrders('done');
    });
  });
  loadMechOrders('in_progress');
}

async function loadMechOrders(status) {
  const listId = status === 'in_progress' ? 'list-mech-active' : 'list-mech-done';
  const list = document.getElementById(listId);
  try {
    const { orders } = await api('/api/orders?status=' + status);
    if (orders.length === 0) {
      list.innerHTML = '<li class="muted" style="cursor:default">Нет заказ-нарядов</li>';
      return;
    }
    list.innerHTML = orders.map(o => `
      <li data-order-id="${o.id}">
        <div class="top">
          <span class="num">№ ${escapeHtml(o.order_number)}</span>
          <span class="status status-${o.status}">${statusLabel(o.status)}</span>
        </div>
        <div class="meta">${escapeHtml(o.car_brand_model || '—')} · ${escapeHtml(o.plate || '—')}</div>
        <div class="meta">Мастер: ${escapeHtml(o.master_name)}</div>
      </li>
    `).join('');
    list.querySelectorAll('li[data-order-id]').forEach(li => {
      li.addEventListener('click', () => openMechOrder(li.dataset.orderId));
    });
  } catch (e) { toast(e.message, 'error'); }
}

async function openMechOrder(orderId) {
  App._currentOrderId = orderId;
  App.view = 'mech-order';
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-mech-order').classList.remove('hidden');
  await loadMechOrderDetail(orderId);
}

async function loadMechOrderDetail(orderId) {
  if (!orderId) return;
  try {
    const { order } = await api('/api/orders/' + orderId);
    document.getElementById('mech-order-title').textContent = `Заказ-наряд № ${order.order_number}`;
    const isDone = order.status === 'done';
    const allDone = order.works.length > 0 && order.works.every(w => w.done);
    const body = document.getElementById('mech-order-body');
    body.innerHTML = `
      <div class="order-header">
        <div class="num">№ ${escapeHtml(order.order_number)} <span class="status status-${order.status}" style="font-size:0.7em;padding:3px 10px;border-radius:999px;margin-left:8px">${statusLabel(order.status)}</span></div>
        <dl>
          <dt>Авто</dt><dd>${escapeHtml(order.car_brand_model || '—')}</dd>
          <dt>VIN</dt><dd>${escapeHtml(order.vin || '—')}</dd>
          <dt>Гос-номер</dt><dd>${escapeHtml(order.plate || '—')}</dd>
          <dt>Пробег</dt><dd>${escapeHtml(order.mileage || '—')}</dd>
          <dt>Мастер-приёмщик</dt><dd>${escapeHtml(order.master_name)}</dd>
          <dt>Запчасти</dt><dd>${partsLabel(order.parts_source)}</dd>
        </dl>
      </div>

      <div class="section">
        <h3>Работы (${order.works.length})</h3>
        <ul class="works-list">
          ${order.works.map(w => `
            <li class="${w.done ? 'done' : ''}">
              <input type="checkbox" class="check" data-work-id="${w.id}" ${w.done ? 'checked' : ''} ${isDone ? 'disabled' : ''} />
              <span class="hours">${w.labor_hours || 0} ч</span>
              <span class="title">${escapeHtml(w.title)}</span>
              ${!isDone ? `<button class="icon" data-del-work="${w.id}" title="Удалить">🗑</button>` : ''}
            </li>
          `).join('') || '<li class="muted" style="cursor:default">Работ нет</li>'}
        </ul>
        ${!isDone ? `
          <div class="add-work">
            <input type="text" id="new-work-title" placeholder="Описание работы" />
            <input type="number" id="new-work-hours" placeholder="ч" min="0" step="0.1" />
            <button class="ghost voice-btn" id="voice-btn" title="Голосовой ввод">🎤</button>
            <button class="primary" id="add-work-btn">+ Добавить</button>
          </div>
        ` : ''}
      </div>

      <div class="section">
        <h3>Рекомендации</h3>
        <div class="rec-wrap">
          <textarea id="recommendations" placeholder="Рекомендации клиенту..." ${isDone ? 'disabled' : ''}>${escapeHtml(order.recommendations || '')}</textarea>
          ${!isDone ? '<button type="button" class="voice-btn-inline" id="voice-rec-btn" title="Голосовой ввод">🎤</button>' : ''}
        </div>
        ${!isDone ? '<button class="primary" id="save-rec-btn" style="margin-top:8px">Сохранить рекомендации</button>' : ''}
      </div>

      <div class="section">
        <h3>Фото</h3>
        ${!isDone ? `
          <div class="photo-actions">
            <label class="photo-input camera">
              📷 Камера
              <input type="file" accept="image/*" capture="environment" id="photo-input-camera" />
            </label>
            <label class="photo-input gallery">
              🖼 Галерея
              <input type="file" accept="image/*" id="photo-input-gallery" />
            </label>
          </div>
        ` : ''}
        ${order.photos.length === 0 ? '<div class="muted" style="margin-top:8px">Фото пока нет</div>' : `
          <div class="photos-grid" id="photos-grid">
            ${order.photos.map(p => `
              <div class="photo-tile" data-pid="${p.id}">
                <a href="/uploads/photos/${p.filename}" target="_blank"><img src="/uploads/photos/${p.filename}" alt="" loading="lazy" /></a>
                ${!isDone ? `<button class="photo-del" data-del-photo="${p.id}" title="Удалить фото">✕</button>` : ''}
              </div>
            `).join('')}
          </div>
        `}
      </div>

      ${!isDone ? `
        <div class="section" style="text-align:center">
          <p class="muted">Механик: <b>${escapeHtml(order.mechanic_name)}</b></p>
          <button class="primary block" id="complete-btn" ${!allDone ? 'disabled' : ''} style="padding:14px;font-size:1.05em">
            ${allDone ? '✅ Все работы выполнены — закрыть заказ-наряд' : '⏳ Отметьте все работы как выполненные'}
          </button>
        </div>
      ` : '<div class="section" style="text-align:center;background:#f0fdf4"><b style="color:#059669">✅ Заказ-наряд выполнен</b></div>'}

      <div style="display:flex;gap:8px;margin-top:12px">
        <button class="print-btn block" id="print-btn-mech" style="flex:1;padding:12px">🖨 Распечатать заказ-наряд</button>
      </div>
    `;

    if (!isDone) {
      // Work checkboxes
      body.querySelectorAll('input.check').forEach(cb => {
        cb.addEventListener('change', async () => {
          try {
            await api(`/api/orders/${orderId}/works/${cb.dataset.workId}`, {
              method: 'PATCH',
              body: JSON.stringify({ done: cb.checked })
            });
            loadMechOrderDetail(orderId); // refresh to update button state
          } catch (e) { toast(e.message, 'error'); cb.checked = !cb.checked; }
        });
      });
      // Delete works
      body.querySelectorAll('[data-del-work]').forEach(b => {
        b.addEventListener('click', async () => {
          if (!confirm('Удалить работу?')) return;
          try {
            await api(`/api/orders/${orderId}/works/${b.dataset.delWork}`, { method: 'DELETE' });
            toast('Работа удалена', 'success');
            loadMechOrderDetail(orderId);
          } catch (e) { toast(e.message, 'error'); }
        });
      });
      // Add work
      const addBtn = body.querySelector('#add-work-btn');
      addBtn.addEventListener('click', async () => {
        const titleEl = body.querySelector('#new-work-title');
        const hoursEl = body.querySelector('#new-work-hours');
        const title = titleEl.value.trim();
        if (!title) { toast('Введите описание работы', 'error'); return; }
        try {
          await api(`/api/orders/${orderId}/works`, {
            method: 'POST',
            body: JSON.stringify({ title, labor_hours: parseFloat(hoursEl.value) || 0 })
          });
          titleEl.value = ''; hoursEl.value = '';
          toast('Работа добавлена', 'success');
          loadMechOrderDetail(orderId);
        } catch (e) { toast(e.message, 'error'); }
      });
      // Voice input
      const voiceBtn = body.querySelector('#voice-btn');
      voiceBtn.addEventListener('click', () => startVoice(voiceBtn, body.querySelector('#new-work-title')));
      // Recommendations
      const saveRecBtn = body.querySelector('#save-rec-btn');
      if (saveRecBtn) {
        saveRecBtn.addEventListener('click', async () => {
          try {
            await api(`/api/orders/${orderId}/recommendations`, {
              method: 'PATCH',
              body: JSON.stringify({ recommendations: body.querySelector('#recommendations').value })
            });
            toast('Рекомендации сохранены', 'success');
          } catch (e) { toast(e.message, 'error'); }
        });
      }
      // Voice for recommendations
      const voiceRecBtn = body.querySelector('#voice-rec-btn');
      if (voiceRecBtn) {
        voiceRecBtn.addEventListener('click', () => {
          startVoice(voiceRecBtn, body.querySelector('#recommendations'));
        });
      }
      // Photo — camera + gallery inputs
      const photoHandler = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const fd = new FormData();
        fd.append('photo', file);
        try {
          const res = await fetch(`/api/orders/${orderId}/photos`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${App.token}` },
            body: fd,
          });
          if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            throw new Error(d.error || 'HTTP ' + res.status);
          }
          toast('Фото загружено', 'success');
          e.target.value = ''; // allow re-selecting the same file
          loadMechOrderDetail(orderId);
        } catch (err) { toast(err.message, 'error'); }
      };
      const pic = body.querySelector('#photo-input-camera');
      const pig = body.querySelector('#photo-input-gallery');
      if (pic) pic.addEventListener('change', photoHandler);
      if (pig) pig.addEventListener('change', photoHandler);
      // Photo delete
      body.querySelectorAll('[data-del-photo]').forEach(b => {
        b.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const pid = b.dataset.delPhoto;
          if (!confirm('Удалить фото?')) return;
          try {
            await api(`/api/orders/${orderId}/photos/${pid}`, { method: 'DELETE' });
            toast('Фото удалено', 'success');
            loadMechOrderDetail(orderId);
          } catch (err) { toast(err.message, 'error'); }
        });
      });
      // Complete
      const completeBtn = body.querySelector('#complete-btn');
      if (completeBtn && !completeBtn.disabled) {
        completeBtn.addEventListener('click', async () => {
          if (!confirm('Закрыть заказ-наряд? Все работы отмечены выполненными.')) return;
          try {
            await api(`/api/orders/${orderId}/complete`, { method: 'POST' });
            toast('Заказ-наряд выполнен!', 'success');
            showView('mechanic');
            loadMechOrders('in_progress');
          } catch (e) { toast(e.message, 'error'); }
        });
      }
    }
    // Print button (always available)
    const printBtnMech = body.querySelector('#print-btn-mech');
    if (printBtnMech) printBtnMech.addEventListener('click', () => printOrder(order));
  } catch (e) { toast(e.message, 'error'); }
}

// -------- Voice input --------
function startVoice(btn, targetInput) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Голосовой ввод не поддерживается в этом браузере', 'error'); return; }
  if (btn.classList.contains('listening')) {
    btn._recog && btn._recog.stop();
    return;
  }
  // Resolve the target element by ID so we survive DOM re-renders that may
  // happen while the user is talking (polling, updates, etc.).
  let targetId = null;
  if (targetInput && targetInput.id) {
    targetId = targetInput.id;
  } else if (targetInput) {
    // Give it a unique id so we can re-find it
    targetId = 'voice-target-' + Date.now();
    targetInput.id = targetId;
  }
  const recog = new SR();
  recog.lang = 'ru-RU';
  recog.interimResults = false;
  recog.maxAlternatives = 1;
  recog.continuous = false;
  recog.onstart = () => {
    btn.classList.add('listening');
    App.voiceActive = true; // pause polling
  };
  recog.onend = () => {
    btn.classList.remove('listening');
    App.voiceActive = false;
  };
  recog.onerror = (e) => {
    btn.classList.remove('listening');
    App.voiceActive = false;
    const msg = ({'not-allowed':'Нет доступа к микрофону. Разрешите доступ в настройках браузера.',
                  'no-speech':'Не услышал речь. Попробуйте ещё раз.',
                  'audio-capture':'Микрофон не найден.',
                  'network':'Проблема с сетью для распознавания.'})[e.error] || ('Ошибка: ' + e.error);
    toast(msg, 'error');
  };
  recog.onresult = (e) => {
    const text = e.results[0][0].transcript;
    if (!text) return;
    // Re-find the input by ID in case it was re-rendered
    const el = document.getElementById(targetId);
    if (el) {
      const cur = el.value || '';
      el.value = cur ? (cur + (cur.endsWith(' ') || cur.endsWith('\n') ? '' : ' ') + text) : text;
      // Make sure it's focused and visible
      el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
  };
  btn._recog = recog;
  try {
    recog.start();
    toast('Говорите…', 'info', 2000);
  } catch (err) {
    toast('Не удалось запустить распознавание: ' + err.message, 'error');
    App.voiceActive = false;
  }
}

// =====================================================
// Mobile keyboard fix (aggressive, works on Chrome / Yandex / Safari)
// =====================================================
// We don't rely on visualViewport API alone — it doesn't always work on
// Yandex Browser and older Chromium. Instead we use a manual scroll approach:
//   1. On focus, immediately measure the field's position from the TOP of
//      the visible viewport (above the keyboard).
//   2. If the field is not in the upper half of the viewport, scroll the
//      page so it sits at ~30% from the top.
//   3. Re-check after the keyboard animation completes (300-500ms) and
//      scroll again if needed.
//   4. Re-focus if the browser stole it.
//   5. On blur, restore scroll position.
function initKeyboardFix() {
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (!isTouch) return; // desktop — skip

  const APPBAR_OFFSET = 60; // sticky appbar height

  const isField = (el) => el && el.matches && el.matches('input, textarea, select');

  const ensureVisible = (el) => {
    if (!el || !el.isConnected) return;
    const rect = el.getBoundingClientRect();
    const viewportH = window.innerHeight;
    // We want the field's top to be at ~20% from the top of the visible area
    // (so it stays above the keyboard and is comfortable to read)
    const desiredTop = viewportH * 0.2;
    const delta = rect.top - desiredTop;
    if (delta < 0 || rect.bottom > viewportH * 0.6) {
      window.scrollBy({ top: delta, behavior: 'smooth' });
    }
  };

  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!isField(el) || el.readOnly || el.disabled) return;
    // Mark that a field is focused — the polling loop will skip DOM re-renders
    App.fieldFocused = true;
    // Only scroll if the field is significantly out of view — don't fight
    // the browser's own keyboard-up scrolling on every keystroke.
    setTimeout(() => {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // If the field's bottom is hidden by the keyboard, scroll minimally
      if (r.top < 0 || r.bottom > vh * 0.7) {
        ensureVisible(el);
      }
    }, 350);
  });

  // On focusout, give time for focus to move to another input before resetting
  document.addEventListener('focusout', (e) => {
    // Small delay so we don't flip the flag if focus moves to another input
    setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || !ae.matches || !ae.matches('input, textarea, select')) {
        App.fieldFocused = false;
      }
    }, 300);
  });

  // Also handle programmatic focus (e.g. .focus() in JS)
  const origFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (opts) {
    origFocus.call(this, opts);
    if (isField(this) && document.hasFocus && document.hasFocus()) {
      App.fieldFocused = true;
    }
  };
}

// =====================================================
// Init
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
  initRoleLoginForms();
  initAdminView();
  initNewOrderForm();
  initKeyboardFix();
  initHashRouting();

  // Bell click
  document.getElementById('bell').addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('bell-dropdown');
    dd.classList.toggle('hidden');
    if (!dd.classList.contains('hidden')) {
      api('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) }).then(refreshBell);
    }
  });
  document.addEventListener('click', () => hideBellDropdown());

  // Logout / back buttons
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    const a = t.dataset.action;
    if (a === 'logout') logout();
    if (a === 'back') {
      if (App.user.role === 'master') showView('master');
      else if (App.user.role === 'mechanic') showView('mechanic');
      else logout();
    }
  });

  // Try to restore session
  if (App.token && App.user) {
    api('/api/auth/me').then(({ user }) => {
      App.user = user;
      localStorage.setItem('user', JSON.stringify(user));
      routeForRole();
    }).catch(() => {
      App.token = null;
      App.user = null;
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      // Don't force auth view — let hash routing handle it
    });
  }
  // (no else: hash routing decides which view to show)
});
