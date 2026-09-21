# Карта проекта

- `index.html` — грузинское портфолио, шаблон и исходные значения hero/about/services для CMS, контактная форма, dialog просмотра.
- `css/site.css` — светлая тема, ровная галерея 3/2 колонки без смещения, клавиатурный фокус, reduced motion.
- `fonts/allura.ttf`, `fonts/OFL-Allura.txt` — локальный шрифт авторской подписи и лицензия SIL OFL; подпись не зависит от Google Fonts.
- `js/main.js` → `gallery.js`, `api.js`, `config.js` — меню, форма, запуск галереи.
- `js/gallery.js` → `data.js`, `api.js` — фильтры, DOM-карточки, лайтбокс, клавиши/свайпы.
- `js/data.js` — исходные шесть фото, категории, чистая валидация.
- `js/config.js` — публичные URL/ключ Supabase и совместимый fallback формы; после миграции включением управляет сервер.
- `js/api.js` — fetch REST Auth/PostgREST/Storage/Edge Function; авторизация, обновление сессии; нет SDK-зависимостей.
- `admin/index.html`, `css/admin.css`, `js/admin.js` — грузинская панель владельца; редактор, очередь, подтверждение удаления, смена пароля с повторной аутентификацией.
- `js/images.js` — Canvas/WebP-обработка без EXIF.
- `images/*.webp` — сохранённые оригиналы; `images/optimized/` — responsive-превью.
- `supabase/schema.sql` — таблицы, server-enforced RLS, Storage bucket/policies, приватный список владельцев, seed-marker, квоты формы.
- `supabase/functions/contact/index.ts` → `validation.js` — серверная пересылка Telegram с Vault, валидацией и квотами.
- `supabase/config.toml` — публичный вход в функцию contact; доступ к админским API остаётся защищённым.
- `scripts/serve.mjs` — локальный HTTP preview на 127.0.0.1:4173.
- `scripts/verify.ps1`, `tests/unit.test.mjs` — синтаксис, чистая логика, ссылки, статические guards.
- `tests/browser.mjs` — реальный Chrome/CDP, проверка UI и mock API. Без npm-зависимостей.
- `scripts/optimize-images.py` — необязательная генерация превью через Pillow.
- `scripts/supabase-setup.mjs` — локальный Management API оператор: inspect/provision/audit. Читает игнорируемый `.env.management`, не выводит токен, provisioning разрешён только для пустого проекта.
- `scripts/owner-access.mjs create|test` — локальное создание первого временного владельца (только при отсутствии пользователей/владельцев) и live-проверки на одноразовых записях. Привилегированный ключ только в памяти; данные входа в `%USERPROFILE%\Gulievi-admin-access.json`, вне репозитория.
- `scripts/check-deployment.mjs <run-id>` — read-only проверка публичного GitHub Actions run, совпадения ресурсов на домене и отсутствия локальных файлов токена на сайте.
- `tests/live-public.mjs` — явные проверки реального публичного API и запрета анонимных операций на случайных probe IDs. `tests/browser.mjs --live` дополнительно проверяет реальную галерею и экран входа без mock API.
- `CNAME`, `.nojekyll`, `robots.txt`, `sitemap.xml`, `favicon.svg` — статическое размещение/метаданные.

Границы: браузер не получает service_role/Telegram token и не определяет права самостоятельно. SQL — источник полномочий. Edge Function — единственное место отправки Telegram. После подключения Supabase публичная галерея не подменяет сбой БД старыми локальными фото.
CMS: `js/content.js` — поля и безопасное применение; `js/cms-admin.js` — редактор/категории; `js/forms.js` — грузинская валидация и дата; `js/confirm.js` — подтверждения. `supabase/migrations/20260920_content_management.sql` — новые таблицы/RLS/FK. `scripts/preview-api.mjs` — локальный демобэкенд. Подробности и production-порядок: `docs/CMS.md`.

Подключения: js/connections-admin.js — интерфейс, js/connections-validation.js — валидация, supabase/migrations/20260921_connections.sql — Vault и закрытые RPC, supabase/functions/_shared/integration-handlers.js — серверные обработчики contact/connections. Порядок подключения: docs/CONNECTIONS.md. tests/connections.test.mjs — изолированные проверки авторизации и отсутствия утечек.
Редактор владельца: js/cms-fields.js задаёт смысловые подписи и карточки поверх прежних ключей CMS; tests/admin-editor.mjs проверяет полный пользовательский цикл на локальном демо с восстановлением исходных значений.
