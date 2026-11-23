# Дизайн-ревью round 2 (t7) — приёмка repair-round-2 (t6)

**Вердикт: `pass`** — 0 blocker/high/medium; F1–F5 из t3 закрыты, все 38 строк чек-листа
проходят с доказательствами. Одно неблокирующее замечание L1 (scroll-affordance) — в §6.
**Ревьюер:** design-director, независимо от автора repair.
**Предмет:** `src/public/{index.html,app.js,style.css,login.html}` после t6.
**База:** `docs/DESIGN.md` (§2–§7), t3 findings (`docs/design/review-t3.md`), эталон
`theirs/docs/screenshot-dark.webp`; скриншоты t6 `docs/design/table-1280.png`,
`table-1280-left.png`, `table-1600.png`.
**Окружение:** одноразовый `DATA_DIR=/tmp/t7-data`, синтетика `scripts/seed-demo.mjs`
(вымышленные провайдеры, IP RFC 5737). Production и реальные данные не использовались.

---

## 1. Правка спецификации (выполнена до приёмки, в scope t7)

Пункт 28 чек-листа противоречил §3.3: требовал «все колонки без горизонтального скролла» на
1280, тогда как §3.3 допускает скролл `.table-wrap` при нехватке ширины. Исправлено точечно
(две формулировки, больше `docs/DESIGN.md` не менялся):

- **Строка 28** — было: «…все колонки без горизонтального скролла | Скриншоты 1280 и 1600 |
  P1». Стало: «…горизонтального скролла у **страницы** нет ни на одной ширине; таблица услуг
  при нехватке места скроллится **внутри** `.table-wrap` (`min-width` по §3.3), при этом все
  10 колонок читаемы: «Заметка» ≥140px, «Провайдер» ≥150px, текст обрезается многоточием, без
  разрыва посреди слова | Скриншоты 1280 и 1600; `document.body.scrollWidth === innerWidth`;
  `wrap.scrollWidth > wrap.clientWidth` допустим только у `.table-wrap` | P1».
- **§5.1, строка 1280–1599** — было: «sticky header, все колонки без скролла». Стало:
  «sticky header; таблица услуг — `min-width` по §3.3, при нехватке места скролл внутри
  `.table-wrap` (страница не скроллится)».

Проверка целостности: 38 строк чек-листа, 10 таблиц без битых строк, fences сбалансированы,
`§3.3` в строке 28 присутствует (см. §7).

---

## 2. Итог по findings t3

| Finding | Severity | Статус | Ключевое доказательство |
|---|---|---|---|
| F1 — «Заметка» 68px, обрезка посреди слова | high | **closed** | 1280: таблица 1120, «Заметка» 196px (текст 184px), одна строка, `text-overflow: ellipsis`, `-webkit-line-clamp: none`; 1600: 227/215; страница без overflow; скролл только `.table-wrap` (144px) |
| F2 — «4 услуг…», hero ≠ карточка | medium | **closed** | hero «4 услуги требуют внимания» = card 4 = 4 строки; формы 1/2/3/4/5/11/21/22/25 корректны; union-кейс: urgent 3 + lowBalance 3 → hero = card = 4 |
| F3 — английский «Failed to fetch» | low | **closed** | abort fetch → «Нет связи с сервером. Проверьте соединение и повторите попытку.»; 500 `{error:"Timeout"}` → «Timeout»; тосты действий используют тот же `humanError` |
| F4 — трёхстрочный блок пользователя | low | **fixed** | блок 208×50, фон `--bg`, «owner» и «единственный» по одной строке (`nowrap` + ellipsis) |
| F5 — «0» в счётчиках при загрузке | low | **fixed** | при задержке fetch: все 4 `.count` и счётчики сайдбара «—», `aria-busy=true`, 6 skeleton-строк; после — «4 платежа · 3 620 ₽», 4, 5, 3 |

### F1 — детально (замеры живого DOM)

| Метрика | 1280 | 1600 |
|---|---|---|
| Таблица | 1120px (fixed, `min-width: 1120px`) | 1296px |
| `.table-wrap` | client 976 / scroll 1120 → 144px, `overflow-x: auto` | 1296 / 1296, скролла нет |
| Провайдер | 168px | 194px |
| Статус | 129px | 149px |
| Тег | 67px | 78px |
| Заметка (ячейка / текст) | 196 / 184px | 227 / 215px |
| Обрезка заметки | `overflow:hidden; text-overflow:ellipsis; white-space:nowrap; line-clamp:none` | то же |
| Страница | `body.scrollWidth 1280 = innerWidth` | без overflow |

Прокрутка обёртки до конца (`scrollLeft 144`) полностью показывает колонку «Действия»
(ячейка 1186–1248 при правом крае обёртки 1248, кнопка «Тег» 1192–1231) — последняя колонка
достижима, ничего не отрезано навсегда. Sticky-заголовок проверен на 17 строках: при
`scrollTop 420` `th` остаётся на `top` обёртки (144), при горизонтальном скролле — тоже sticky.
Скриншоты t6 (`table-1280-left.png`, `table-1280.png`, `table-1600.png`) осмотрены: на 1600
таблица читается целиком, на 1280 после прокрутки «Заметка» заканчивается многоточием,
последняя строка («Песочница разработки») помещается полностью.

### F2 — детально

`attentionText(1..5, 11, 21, 22, 25)` → «1 услуга требует…», «2/3/4 услуги требуют…»,
«5/11 услуг требуют…», «21 услуга требует…», «22 услуги требуют…», «25 услуг требуют…».
`attentionServices(d)` используется и в hero (`app.js:418`), и в карточке (`app.js:531`).
Крафт-кейс: услуге с дальним сроком выставлен нулевой баланс → KPI «Срок ≤ 7 дней» = 3,
«Низкий баланс» = 3, hero = card = 4; строка «4 услуги требуют внимания», карточка «4».
`docs/images/billing-panel.png` перегенерирован: 1440×900, синтетика, «4 услуги требуют
внимания» (проверено визуально).

### F3 — детально

Отказ `/api/dashboard` (abort) → баннер `role="alert"`, заголовок «Не удалось загрузить
данные», текст русский; кнопка «Повторить» после снятия отказа вернула данные (баннер скрыт,
figure «3 620 ₽»). Ответ 500 с `{error:"Timeout"}` показывает серверный текст как есть.

---

## 3. Чек-лист §7 — 38/38 (round-2, с учётом исправленной строки 28)

| # | Критерий (кратко) | Статус | Доказательство round-2 |
|---|---|---|---|
| 1 | Только тёмная тема, без переключателя | passed | `grep -niE 'prefers-color-scheme\|theme-toggle\|\blight\b' src/public/*` пусто; `color-scheme: dark` |
| 2 | Сайдбар 240px, `.top` удалён | passed | замер 240/64; `.sidebar` + `.app-main`; smoke |
| 3 | Виды на hash, неизвестный → overview | passed | #/overview, #/services, #/providers, #/providers?state=failed/never; `#/services?state=ok` → вид услуг (state игнорируется) |
| 4 | Активный пункт `aria-current` + surface-3 + accent | passed | «Ошибка 3», «Не синхр. 0» — ровно один активный; контраст 6.72 |
| 5 | Сайдбар: бренд, пользователь, 3 пункта, 4 счётчика, meter, logout | passed | блок пользователя 208×50, meter 73%, счётчики = 3 аккаунта |
| 6 | `#btn-sync` / `#btn-logout` | passed | sync-тост + восстановление кнопки; logout → `/login` |
| 7 | Сохранены id | passed | smoke по 30 id — все найдены |
| 8 | Сохранены имена полей | passed | smoke: `provider,label,baseUrl,login,password,token,id,tag,notes` |
| 9 | Цвета только через `var(--…)` | passed | awk-проверка: литералов вне `:root`/data-URI нет |
| 10 | Токены §2.2 | passed | smoke по 47 токенам; значения не менялись |
| 11 | Контраст измерен, ≥4.5 / ≥3 | passed | изменённые элементы: user note 5.27, notes 13.99, th 6.51, chart label 4.82, бейджи 5.58–5.92 |
| 12 | tabular + числа вправо | passed | `td.num`: `text-align:right`, `white-space:nowrap`; body `tabular-nums` |
| 13 | KPI 34px, 4 ячейки, 6 метрик | passed | 3 620 / 43 440 / 965 / 3–4 / 2–3 / 1 / 5; значения из API |
| 14 | График: inline SVG, role=img, aria-label | passed | role/aria на месте, 12px подписи, fill `--text-dim`, canvas нет |
| 15 | Таблица: sticky ≥1024, 10 колонок, «биллинг» | passed | sticky при scrollTop 420 и scrollLeft 144; 10 колонок; ссылки в строках |
| 16 | Числовые вправо, nowrap, «—» | passed | замер + скриншоты 1280/1600 |
| 17 | Бейджи со словом, русский маппинг | passed | «активна/приостановлена/не найдена», точка + слово |
| 18 | Аватар 24px, инициал, тон | passed | контраст 5.05–7.05 |
| 19 | Фильтры + «Сбросить» | passed | provider=raduga → 1, reset → 5; пустой фильтр → «Ничего не найдено» |
| 20 | Пустые состояния | passed | услуги/фильтр/аккаунты/график — тексты §3.7 на месте |
| 21 | Skeleton + aria-busy + reduced-motion | passed | counts «—», aria-busy=true, 6 строк, live «Загрузка данных…»; reduced-motion: animation none |
| 22 | `#app-error` + «Повторить» | passed | русский текст, retry восстанавливает данные |
| 23 | Тосты роли, нет `alert()/confirm()` | passed | success/status, error/alert; grep пуст |
| 24 | Диалоги: Esc, фокус, aria-labelledby | passed | edit закрылся по сохранению, фокус на `data-edit="4"`; confirm с корректным текстом |
| 25 | Поля: label, autocomplete, invalid | passed | login 401 → «Неверный пароль» + `aria-invalid`; поля формы как прежде |
| 26 | 360: нет overflow, карточки | passed | `body.scrollWidth 360`, `tr display:block`, `td grid`, кнопка 266×40 |
| 27 | 768: drawer + inert, без сайдбара | passed | `translateX(-280px)`, inert, wrap 1262/720, gradient-hint |
| 28 | 1280/1600: страница без скролла, таблица читаема (скролл обёртки допустим) | passed | 1280: 1120/976, «Заметка» 196/184, ellipsis; 1600: 1296/1296, 227/215; `body.scrollWidth === innerWidth` на обеих |
| 29 | Шапка sticky 64px | passed | computed sticky top 0, высота 64 |
| 30 | login.html self-contained | passed | 81 строка, inline `<style>`, без `/style.css`; 401/429 отображаются |
| 31 | Нет внешних запросов | passed | grep по URL/CDN/@import/шрифтам пуст |
| 32 | Нет сборки, backend не тронут | passed | `git diff --stat` по `src/index.ts`, `src/routes`, `package*.json` пуст |
| 33 | Бюджеты | passed | style.css 816, login 81 |
| 34 | JS без ошибок и зависимостей | passed | `node --check` + smoke |
| 35 | Пустые/битые данные | passed | пустой фильтр, отказ API, 500 `{error}` — без NaN/undefined |
| 36 | Нет реальных данных | passed | только RFC 5737 в src/public, docs, scripts; seed синтетический |
| 37 | Reduced motion | passed | transition 1e-05s, probe animation none |
| 38 | Нет светлой палитры | passed | grep пуст |

---

## 4. Функциональные регрессии — не найдены

| Сценарий | Результат |
|---|---|
| Вход (401 / успех) | «Неверный пароль», `aria-invalid`, фокус в поле; успех → `/#/overview` |
| Выход | `#btn-logout` → `/login` |
| Sync all | тост «Синхронизировано: 0 аккаунтов, 3 ошибки», кнопка восстановлена |
| Per-account sync | строка переходит в «ошибка», кнопка разблокирована, тост-ошибка |
| Добавление аккаунта | тост «Аккаунт добавлен», 4 строки, счётчик 4 |
| Удаление | confirm с текстом «Аккаунт «review2»…», после — 3 строки, тост «Аккаунт удалён» |
| Тег/заметка | диалог → PATCH → тост «Изменения сохранены», значения в ячейках, фокус возвращён |
| Фильтры | provider=raduga → 1, reset → 5; пустой фильтр → «Ничего не найдено» |
| Deep links | `#/providers?state=failed` → крошка «Провайдеры · с ошибкой», один активный пункт; `?state=never` → «Не синхр. 0» + пустое состояние; `#/services?state=ok` → вид услуг |

---

## 5. Верификация

| Команда / проверка | Результат |
|---|---|
| `npm run build` | passed, exit 0 |
| `node --check src/public/app.js` | passed, exit 0 |
| `bash scripts/ui-smoke.sh` | passed, exit 0 (статика + живой сервер, добавлены проверки плюрализации и ширин) |
| замеры DOM 1280/1600 | таблица 1120/1296, «Заметка» 196/227, страница без overflow |
| sticky на 17 строках | th удерживается при scrollTop 420 и scrollLeft 144 |
| контраст изменённых элементов | 4.82–15.31, нарушений нет |
| статические запреты | URL/CDN/@import/light/alert/confirm/import — пусто; бюджеты 816/81 |
| `docs/images/billing-panel.png` | 1440×900, синтетика, «4 услуги требуют внимания» — проверено визуально |

---

## 6. Неблокирующее замечание L1 — discoverability горизонтального скролла на 1280

При 1280 у `.table-wrap` `offsetHeight === clientHeight` (scrollbar-overlay: полоса прокрутки
не занимает место и в Chromium видна только во время скролла), а градиент-подсказка
`.table-shell::after` включается только на 768–1023. В результате на первом экране таблица
обрезается по правому краю карточки внутри колонки «Заметка», и единственная подсказка о
скролле — сам обрез. Это **не** нарушает принятый критерий (скролл обёртки разрешён, ячейки
обрезаются многоточием, колонка «Действия» достижима за 144px, страница не скроллится), но
стоит улучшить: распространить градиент `.table-shell::after` на `≥1280` при
`scrollWidth > clientWidth` (по аналогии с 768–1023) или задать видимую тонкую полосу
прокрутки (`scrollbar-gutter: stable` + стили `::-webkit-scrollbar`), чтобы 10-колоночная
таблица не выглядела «обрезанной». Рекомендация на будущий полиш, не блокирует pass.

---

## 7. Воспроизведение и ограничения

```bash
rm -rf /tmp/t7-data && mkdir -p /tmp/t7-data
PORT=41874 PANEL_PASSWORD=review-pass SESSION_SECRET=review-secret \
  CREDENTIALS_KEY=0123456789abcdef0123456789abcdef DATA_DIR=/tmp/t7-data \
  BALANCE_THRESHOLD=200 SYNC_CRON='0 0 1 1 *' REMINDER_CRON='0 0 1 1 *' \
  MONITOR_SUMMARY_CRON='0 0 1 1 *' TELEGRAM_BOT_TOKEN='' TELEGRAM_CHAT_ID='' \
  VICTORIAMETRICS_URL='' node_modules/.bin/tsx src/index.ts &
node scripts/seed-demo.mjs /tmp/t7-data
# вход: review-pass; #/services на 1280 (скролл обёртки 144px) и 1600 (без скролла)
```

- Скриншоты round-2 хранились во временном каталоге (`/tmp/t7-evidence/`) и в репозиторий не
  добавлялись; в `docs/design/` остаются только скриншоты t6 и текстовые артефакты.
- Sticky проверялся на 17 строках (12 временных синтетических), затем БД пересоздана из
  `seed-demo.mjs`; временные данные в репозиторий не попадали.
- Строки ошибок от бэкенда («No adapter for provider: …», «Timeout») — вне области UI и в
  findings не входят.
