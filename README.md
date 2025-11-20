# Telegram Assistant App (Backend + Frontend)

Приложение-надстройка для Telegram: авторизация по номеру, список диалогов, отправка сообщений, разбор входящей очереди, realtime-обновления (WebSocket).

## Требования
- Python 3.11+
- Node.js 18+ и npm
- Telegram API credentials: API_ID, API_HASH (`https://my.telegram.org`)

## Быстрый старт

### Docker Compose
1. Подготовьте `.env` рядом с `main.py` (см. пример ниже).
2. Запустите приложение:
   ```bash
   docker compose up --build
   ```
3. Бэкенд доступен на `http://localhost:8080`, собранный фронтенд обслуживается на `http://localhost:8080/app`.
   Сессии пользователя сохраняются в каталоге `sessions/` на хосте.

### 1) Backend
1. Установка зависимостей
   ```bash
   cd /Users/macbook/Desktop/backend/tg_my
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. Конфигурация окружения (`.env` рядом с `main.py`)
   ```env
   API_ID=ВАШ_API_ID
   API_HASH=ВАШ_API_HASH
   LOGIN=my_session        # имя файла сессии => создастся my_session.session
   # Если Telegram заблокирован в сети, укажите прокси (необязательно):
   # PROXY_HOST=127.0.0.1
   # PROXY_PORT=1080
   # PROXY_SCHEME=socks5
   # PROXY_USERNAME=
   # PROXY_PASSWORD=
   ```
3. Запуск на порту 8080 (рекомендовано)
   ```bash
   uvicorn main:app --host 0.0.0.0 --port 8080 --app-dir /Users/macbook/Desktop/backend/tg_my
   ```
   Проверка:
   ```bash
   curl http://localhost:8080/healthz
   curl http://localhost:8080/
   ```
   Swagger UI: `http://localhost:8080/docs`

### 2) Frontend
1. Настроить адрес бэкенда и установить зависимости
   ```bash
   cd /Users/macbook/Desktop/backend/tg_my/frontend
   echo 'VITE_API_BASE_URL=http://localhost:8080' > .env.local
   npm i
   npm run dev -- --port 5173
   ```
2. Открыть приложение: `http://localhost:5173`

## Авторизация
- Первый вход:
  1) Нажмите «Получить код», введите номер в формате `+7XXXXXXXXXX`.
  2) Введите код из Telegram (при необходимости — 2FA пароль).
  3) После успеха рядом с `main.py` появится файл сессии `<LOGIN>.session`.
- Повторные входы:
  - Не меняйте `LOGIN` в `.env`. Можно нажать «Войти (по сохраненной сессии)» — код не потребуется.
  - Смена `LOGIN` = новая сессия → потребуется снова код.

## Возможности
- «Написать сообщение»:
  - Диалоги: `GET /dialogs`.
  - История: `GET /messages?chat_id=...&limit=...&before_id=...` (реализована догрузка по скроллу).
  - Отправка: `POST /send_message`.
  - Realtime входящие: WebSocket `/ws`.
- «Разбор очереди»:
  - Очередь пополняется при новых входящих сообщениях автоматически.
  - Кнопки: «Выполнено» — помечает чат прочитанным и удаляет из очереди; «Отложить» — перенос в конец; «В задачи» — также в конец.
  - При «Показать историю» подгружается больше сообщений для текущего диалога.

## Сводка API
- POST `/auth/send_code` — `{ phone: "+7..." }` → отправить код (возвращает `phone_code_hash`).
- POST `/auth/sign_in` — `{ phone, code, password? }` → вход, создаёт `<LOGIN>.session`.
- GET `/me` — `{ authorized: boolean, me? }`.
- GET `/dialogs` — список диалогов (пустые last_message отфильтрованы).
- GET `/messages?chat_id=...&limit=...&before_id=...` — история (пустые сообщения отфильтрованы).
- POST `/send_message` — `{ chat_id, text, reply_to_message_id? }`.
- GET `/queue` — очередь `chat_id[]`.
- POST `/queue/action` — `{ chat_id, action: "done"|"postpone"|"task" }`.
- WS `/ws` — события входящих сообщений.

## Типичные проблемы
- «Request failed» на фронте — проверьте `VITE_API_BASE_URL` и перезапустите `npm run dev`.
- 404 на `/auth/send_code` — убедитесь, что фронт и бэк на одинаковых портах и путь верный.
- Терминал просит номер при `/me` — обновите бэк до текущей версии (интерактив отключён для /me).
- Не запомнился вход — проверьте наличие `<LOGIN>.session` и неизменность `LOGIN`.
- Нет сообщений/«пустые» сообщения — бэк фильтрует пустые текст/подпись; можно включить метки медиа по запросу.

## Продакшен
- Запускайте через процесс-менеджер и боевой ASGI-сервер (`gunicorn -k uvicorn.workers.UvicornWorker`).
- Ограничиайте CORS по доменам.
- Храните `.env` и файл сессии в безопасном месте (делайте бэкапы).
- Используйте HTTPS и обратный прокси.

---
Вопросы/улучшения: добавление меток для медиа, расширенная фильтрация очереди, деплой — напишите, помогу.
