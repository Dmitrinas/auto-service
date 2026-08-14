# Деплой Автосервиса

Приложение — Node.js + Express + SQLite. Готово к деплою на любой PaaS с Node.js.

## Что внутри

```
auto-service/
├── server.js            # Express API
├── db.js                # SQLite (better-sqlite3) + seed
├── package.json         # dependencies
├── Dockerfile           # контейнер для Fly.io / Render / Railway
├── render.yaml          # one-click деплой на Render
├── fly.toml             # one-click деплой на Fly.io
├── start.sh             # auto-restart loop (для своего VPS)
├── start-tunnel.sh      # auto-restart loop для cloudflared
├── .gitignore
├── public/              # статический фронт (SPA)
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   └── uploads/photos/
└── DEPLOY.md            # ← вы здесь
```

## Хранение данных

- **SQLite**: лежит в `process.env.DATA_DIR` (по умолчанию `./data/data.db`)
- **Фото**: лежат в `process.env.DATA_DIR/photos/` (по умолчанию `./data/photos/`)
- На платформах с persistent volume — настройте `DATA_DIR=/var/data` (Render) или аналог

---

## 1. GitHub → Render (рекомендую, бесплатно)

### Шаг 1: Создать репозиторий на GitHub

1. Зайдите на https://github.com/new
2. Имя: `auto-service` (или любое)
3. **Private** или **Public** — без разницы для деплоя
4. **НЕ** ставьте галочки «Initialize with README» / .gitignore / license
5. Нажмите «Create repository»

### Шаг 2: Залить код

В папке проекта:

```bash
cd /workspace/auto-service
git add -A
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/ВАШ_ЮЗЕР/auto-service.git
git push -u origin main
```

Если попросит логин/пароль — используйте **Personal Access Token** (https://github.com/settings/tokens), не пароль.

### Шаг 3: Деплой на Render

1. Зайдите на https://render.com → Sign up with GitHub
2. **New +** → **Blueprint**
3. Подключите репозиторий `auto-service`
4. Render увидит `render.yaml` и сам настроит:
   - План: Free (бесплатно, но засыпает через 15 мин без запросов)
   - Persistent disk 1 GB для SQLite и фото
5. Нажмите **Apply** → ждите 2-3 мин
6. Получите URL вида `https://auto-service-XXXX.onrender.com`

**Минус бесплатного плана:** спит после 15 мин простоя. Первый запрос после сна = 30-50 сек холодного старта. Для постоянной работы — $7/мес.

---

## 2. GitHub → Fly.io (бесплатный tier пожизненно)

```bash
# Установить flyctl (https://fly.io/docs/hands-on/install-flyctl/)
curl -L https://fly.io/install.sh | sh

# Залогиниться
fly auth signup

# В папке проекта
cd /workspace/auto-service
fly launch --no-deploy   # создаст приложение, спросит имя/регион
fly deploy               # задеплоит
fly open                 # откроет в браузере
```

**Бесплатно:** 3 shared-cpu-1gb VMs, 3 GB persistent volume. Для демо хватит с головой.

`fly.toml` уже настроен на persistent volume для данных.

---

## 3. GitHub → Railway (простой, $5 кредита в месяц бесплатно)

1. https://railway.app → Sign up with GitHub
2. **New Project** → **Deploy from GitHub repo** → выбрать `auto-service`
3. Railway сам определит Node.js, запустит `npm start`
4. **Variables** → добавить `DATA_DIR=/data` (опционально)
5. **Settings** → **Generate Domain**

Кредит $5/мес расходуется по мере работы. Для маленького демо — хватит на весь месяц.

---

## 4. GitHub → Glitch (полностью бесплатно, но спит через 5 мин)

1. https://glitch.com → Sign in with GitHub
2. **New Project** → **Import from GitHub** → `auto-service`
3. Glitch задеплоит автоматически
4. Получите `.glitch.me` URL

**Минус:** ephemeral filesystem — данные теряются при передеплое. SQLite файл создастся заново.

---

## 5. Свой VPS (DigitalOcean / Hetzner / и т.д.) — полный контроль

```bash
# На VPS с Ubuntu 22.04
sudo apt update && sudo apt install -y nodejs npm git nginx

# Скопировать проект
git clone https://github.com/ВАШ_ЮЗЕР/auto-service.git
cd auto-service
npm install --production

# Создать systemd-сервис для автоперезапуска
sudo tee /etc/systemd/system/auto-service.service > /dev/null <<EOF
[Unit]
Description=Auto Service
After=network.target

[Service]
WorkingDirectory=/opt/auto-service
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=DATA_DIR=/var/lib/auto-service
User=auto-service

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /var/lib/auto-service/photos
sudo useradd -r -s /usr/sbin/nologin auto-service
sudo chown -R auto-service:auto-service /var/lib/auto-service /opt/auto-service
sudo systemctl daemon-reload
sudo systemctl enable --now auto-service

# nginx + Let's Encrypt
sudo tee /etc/nginx/sites-available/auto-service > /dev/null <<EOF
server {
  server_name autoservice.example.com;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_http_version 1.1;
    client_max_body_size 20M;
  }
}
EOF
sudo ln -s /etc/nginx/sites-available/auto-service /etc/nginx/sites-enabled/
sudo certbot --nginx -d autoservice.example.com
```

---

## Сравнение вариантов

| Платформа | Цена | Cold start | Persistent data | Сложность |
|---|---|---|---|---|
| **Render Free** | $0 | 30-50с (спит) | 1 GB ✓ | ★☆☆ |
| **Fly.io Free** | $0 (3 VMs) | нет | 3 GB ✓ | ★★☆ |
| **Railway** | $5 free/мес | нет | ephemeral | ★☆☆ |
| **Glitch** | $0 | да (5 мин) | ✗ | ★☆☆ |
| **VPS** | $4-6/мес | нет | ∞ | ★★★ |

Для быстрого теста: **Render** (1 клик после `render.yaml`).
Для нормального постоянного деплоя: **Fly.io** или **VPS**.

---

## Демо-аккаунты (seed)

- `admin` / `admin`
- `master1` / `pass`
- `Петров Пётр` / таб. `001`
- `Сидоров Алексей` / таб. `002`

Создаются автоматически при первом запуске.
