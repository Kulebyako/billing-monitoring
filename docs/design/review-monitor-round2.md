# Ревью «Мониторинг» — round 2 (t7): приёмка repair t6

**Вердикт: `pass`** — 0 blocker/high/medium. Все пять findings раунда 1 (F1–F5) закрыты и
проверены независимо; acceptance-критерии t7 выполнены. Три низких наблюдения (L1–L3) не
блокируют выкат и зафиксированы в §6.
**Ревьюер:** design-director, независимо от автора repair.
**Предмет:** t6 — repair `src/public/{app.js,index.html,style.css}` и `scripts/monitor-ui-smoke.mjs`
после ревью `docs/design/review-monitor-t3.md`; API t1 не менялся.
**База:** `docs/DESIGN.md` §2–§6, findings F1–F5 раунда 1, контракт t7.
**Окружение:** одноразовый `DATA_DIR` (`/tmp/review-t3/...`), синтетика `scripts/seed-demo.mjs`
(вымышленные провайдеры, IP RFC 5737), собственный stub VM на 6 хостах + инстанс с мёртвым
`VICTORIAMETRICS_URL`. Прод-хост, его адрес/путь и реальные данные не использовались; `src/`,
`scripts/`, `docs/DESIGN.md` этим ревью не изменялись.

---

## 1. Итог

| Finding раунда 1 | Severity | Статус | Доказательство (кратко) |
|---|---|---|---|
| F1 — сырые id провайдеров на deep link (гонка с `/api/meta`) | medium | **closed** | `/api/meta` задержан на 1.2 с: через 350 мс — id, после meta — `Play2Go`/`Kyonix`/`LandVPS (BILLmanager)` в ячейках и в option фильтра; обычный deep link — сразу метки |
| F2 — растянутые статус-пилюли на 360 | medium | **closed** | 360: `up=46px`, `down=59px` (было 168px при ячейке 276px); 1280 — 46px, без изменений |
| F3 — невидимые фокус-стопы сортировки на 360 | medium | **closed** | Tab-обход 30 шагов: ни одного `.th-sort` в порядке; select «Сортировка хостов» 294×36, 13 опций, видимый focus-ring, сортировка/сброс работают |
| F4 — «—» не сворачиваются в карточном режиме | low | **closed** | 360/767: `data-empty`-ячейки `display:none`, карточка 270px (было 400), на ≥768 «—» видимы (`table-cell`) |
| F5 — «Обновлено: сейчас» при мёртвой VM | low | **closed** | offline-мета «Данные недоступны · проверено: 18:11:21», «Обновлено» только по серверному снимку |

Acceptance t7: **все 7 пунктов passed** (§5). Регрессий не найдено; `npm run build`,
`node --check`, `scripts/monitor-api-smoke.mjs`, `scripts/ui-smoke.sh` — exit 0.

---

## 2. Как проверялось

| Что | Как |
|---|---|
| Сборка/синтаксис | `npm run build` → exit 0; `node --check src/public/app.js` → exit 0 |
| API-smoke | `node scripts/monitor-api-smoke.mjs` → PASS, exit 0 (401, контракты, join/null, кэш, read-only, partial failure, fallback) |
| UI-smoke | `bash scripts/ui-smoke.sh` → «all UI smoke checks passed», exit 0; Playwright: 16/16, включая новые проверки F1–F5 |
| Независимая проверка API | Собственный script (не из репозитория) с stub VM на 5 хостах и реальным `dist`: 8/8 PASS (401/битая сессия, join, null, кэш, read-only, VM down, GET-only) |
| Остановка stub VM | Stub убит на живом инстансе, выждано >30 с (TTL кэша): оба эндпоинта `200 {available:false, reason, updatedAt:null}`, UI — «Данные недоступны · проверено», warn-баннер, KPI/таблица скрыты |
| F1 | Отдельная страница с init-script, задерживающим `fetch('/api/meta')` на 1.2 с; измерения в 350 мс и после прихода meta; обычный reload `#/monitor` — метки корректны |
| F2/F3/F4 | Chromium 360×800 и 767/768: размеры пилюль, `display` ячеек, высоты карточек, Tab-обход 30 шагов с логом activeElement/outline, работа select сортировки и сброса |
| F5 | 18081 с мёртвым VM + 18080 после реальной остановки stub: мета/баннер/скрытие карточек |
| UI 360/768/1280/1600 | Chromium: навигация/KPI/таблица/сортировка/фильтры/«только проблемные»/пустой результат; `document.documentElement.scrollWidth === innerWidth`; скролл только `.table-wrap` на 768/1024 |
| Доступность | `th scope`, `aria-sort`, Tab-обход, focus-ring (outline/box-shadow), aria-label фильтров и «Обновить», клавиатурная сортировка; AX-дерево CDP на 360 |
| Контраст | вычисленные цвета/эффективный фон, WCAG: `--dim` на fail-строке 4.65:1 … KPI/card до 16.53:1; select 15.27:1 |
| Регрессии | Виды `#/overview|#/services|#/providers|#/monitor`, deep links, активный пункт, правка тега/заметки, sync all; add/delete, login/logout — в `ui-smoke.sh`; сеть/консоль |
| Внешние запросы | `browser_network_requests` за сессию: только same-origin (`/`, `/login`, `/app.js`, `/style.css`, `/api/*`); JS-исключений нет, в консоли только ожидаемые сетевые 401 при тесте сессии |

Ключевые замеры round 2:

| Метрика | 360 | 768 | 1280 | 1600 |
|---|---|---|---|---|
| Страница: `scrollWidth` | 360 = innerWidth | 768 | 1280 | 1600 |
| `.table-wrap` client/scroll | карточки 326/326 | 718/**1172** (скролл внутри) | 974/974 | 1294/1294 |
| `thead` / sort select | `display:none` / `block` 294×36 | `table-header-group` / `none` | то же | то же |
| `up`-пилюля | 46px (ячейка 276) | 46px | 46px | 46px |
| Строка/карточка | 270px | 83px | 83px | 83px |
| KPI | 8 ячеек, 2 колонки | 8, 4 колонки | 8, 4 | 8, 4 |

---

## 3. Закрытие findings F1–F5

### F1 — закрыт: перерисовка после `/api/meta`

`fillProviders()` в конце вызывает `renderMonitor()`, если снимок уже есть
(`src/public/app.js:1136–1138`). Проверка с задержкой meta 1.2 с (искусственная, чтобы гарантировать
гонку): в 350 мс `providerMap.size=0`, ячейки `play2go/kyonix/landvps`, option фильтра — id;
после ответа meta `providerMap.size=6`, ячейки `Play2Go/Kyonix/LandVPS (BILLmanager)`, option
фильтра — метки; ни одного JS-исключения. Обычный deep link/reload `#/monitor` (meta успевает
раньше снимка) показывает метки сразу. Добавленный в `monitor-ui-smoke.mjs` тест с задержкой
meta 600 мс сверяет ячейки `gamma/alpha/beta` и option фильтра с `meta.providers[].label` —
проверка осмысленная и падает при отключённой перерисовке (по отчёту t6; логика совпадает с
кодом).

### F2 — закрыт: пилюли по контенту

`src/public/style.css:905` — `.monitor-table td.cell-status .badge { justify-self: start; }`.
Замер: 360 — `up=46px`, `down=59px` при ячейке 276px и `display:flex` (grid-item больше не
растягивается); 767 — те же; 1280 — 46px, `inline-flex` как раньше. Визуально — компактные
пилюли, не полосы (`docs/design/monitor-round2-360.png`).

### F3 — закрыт: сортировка в карточном режиме

`src/public/style.css:963` убирает `thead` через `display:none` на `<768`; в тулбаре появился
`select#monitor-sort` (`src/public/index.html:311`, `style.css:964`), 13 опций (12 колонок +
«по умолчанию»), `aria-label="Сортировка хостов"`. Tab-обход 360: skip-link → drawer → sync →
«Обновить» → чекбокс → select сортировки → фильтры → роль → body; `.th-sort` в порядке нет,
все остановки видимы, у select `box-shadow: 0 0 0 3px var(--ring-soft)`. `selectOption('cpu')`
даёт порядок 12.3 → 44.4 → 60.0 → 95.5 (null внизу) и `aria-sort="ascending"` на скрытом th;
«Сортировка: по умолчанию» возвращает проблемные сверху. AX-дерево 360: `columnheader` нет
(скрыты), но accessible name ячеек содержит подпись из `data-label` («Провайдер Play2Go»,
«RTT p50 87,6 мс»), т.е. контекст для скринридера сохранён.

### F4 — закрыт: `data-empty`

`src/public/app.js:865` помечает null-ячейки (ICMP/node/RTT/CPU/RAM/диск/load1/аптайм). 360:
у первой карточки 5 `data-empty`-ячеек с `display:none`, высота 270px вместо 400px; 767 — так
же; 1280/1600 — `display:table-cell`, «—» видимы, как требует UI-контракт. У `beta` скрыт
только отсутствующий RTT p95 (по отчёту smoke; выборочно проверено на синтетике).

### F5 — закрыт: честная offline-мета

`monitor.updatedAt` больше не подменяется `new Date()` (`app.js:1029–1033`); добавлен
`checkedAt` (время последнего запроса, `app.js:1032/1038`). Offline (`available:false`):
«Данные недоступны · проверено: HH:MM:SS» (`app.js:895–901`), KPI/таблица `hidden`, баннер
«VictoriaMetrics недоступна». На живом инстансе после остановки stub: `Данные недоступны ·
проверено: 18:11:21`, count «—», обе карточки скрыты (`docs/design/monitor-round2-vm-down.png`).

---

## 4. Что подтверждено независимо (acceptance t7)

### 4.1 API и безопасность

- `overview`: `available, updatedAt, cached, hosts{total,up,down,icmpDown,nodeDown},
  averages{cpu,ram,disk}, security{ufwEnabled,ufwTotal,ufwBlocks1h,fail2banBanned},
  top{cpu,ram,disk}`; `hosts`: 18 полей строки. Join union по `host` (ICMP-only/node-only
  сохранены), null вместо 0, округление 1 знак, `cached:true` + 0 запросов к VM в пределах
  30 с, `updatedAt` общий.
- 401 JSON для отсутствующей/битой сессии на обоих эндпоинтах; POST/неизвестный путь → 404;
  в ответах нет секретов/URL; VM получает только `GET /api/v1/query` (0 записей); фронтенд — только
  same-origin, внешних ассетов нет.
- Остановка stub VM (живой инстанс, пауза > TTL): `200 {available:false, reason, updatedAt:null,
  hosts.total:0}`, `reason` без секретов; кэш при отказе не пишется.

### 4.2 UI и адаптив

- Пункт «Мониторинг», deep link `#/monitor`, `aria-current`, крошка/`<title>`; KPI 8;
  таблица 12 колонок; сортировка на 1280/1600 (asc → desc → none, null внизу) и select на 360;
  фильтры/«только проблемные»/сброс/пустой результат; «Обновить» и бейдж кэша; offline-состояние.
- 360: карточки, компактные пилюли, `data-empty` скрыты, select сортировки, страница без
  скролла (326/326). 768: `thead` виден, скролл только `.table-wrap` (718/1172), страница без
  скролла. 1280: таблица 974/974, 12 колонок без скролла. 1600: 1294/1294.
- Индиго-токены, тёмные нативные контролы (`color-scheme: dark`), светлых артефактов нет;
  контраст новых элементов ≥4.5:1 (select 15.27, meta 8.17, `--dim` на fail 4.65, KPI до 16.53).
- Внешних запросов и JS-ошибок нет (только ожидаемые сетевые 401 при тесте сессии).

### 4.3 Доступность

- `th scope="col"` и `aria-sort` на десктопе; `aria-label` у фильтров, сортировки, «Обновить
  данные мониторинга»; фокус-ринги 2px `--ring` (th-sort, nav, refresh) и мягкий ring у
  select/чекбокса; Enter/Space/клик по `.th-sort` работают; на 360 сортировка доступна
  клавиатуре через select; невидимых остановок нет; AX-подписи ячеек сохранены через `data-label`.

### 4.4 Регрессии

- `#/overview`, `#/services`, `#/providers`, `#/providers?state=failed`, `#/monitor`: видимость
  панелей, активный пункт, заголовки, строки (5 услуг / 3 аккаунта / 6 хостов), без скролла
  страницы; диалог «Тег и заметка» открывается, сохранение пишет «Изменения сохранены»; sync all
  — «Синхронизировано: 0 аккаунтов, 3 ошибки»; `ui-smoke.sh` покрывает login/logout, 401,
  PATCH/POST/DELETE и «available:false без VM».

---

## 5. Acceptance t7

| # | Критерий | Статус | Доказательство |
|---|---|---|---|
| 1 | API-контракт: форма, join по host, null вместо 0, cached:true ≤30 с | passed | Независимый stub 8/8; 12 запросов, 0 новых в TTL; `monitor-api-smoke` PASS |
| 2 | Безопасность: 401, нет секретов, VM read-only, нет внешних запросов | passed | 401 нет/битая сессия; 0 записей в VM; same-origin network; reason без URL |
| 3 | VM недоступна: 200 `{available:false,reason}` + баннер, не «всё хорошо» | passed | Остановка stub после TTL: оба эндпоинта 200; UI — «Данные недоступны · проверено», warn-баннер, KPI/таблица hidden |
| 4 | UI 360/768/1280/1600: пункт, KPI, таблица, сортировка, фильтры, «только проблемные», без скролла страницы, индиго без светлых артефактов | passed | Замеры 360/768/1280/1600; скролл только `.table-wrap`; 8 KPI; 12 колонок; пилюли 46/59; select 294; скриншоты round 2 |
| 5 | Доступность: th scope, aria-sort, фокус-ринги, подписи, таблица с клавиатуры | passed | scope/aria-sort на десктопе; aria-label; Tab-обход 360 без th-sort; focus-ring select; AX-подписи ячеек |
| 6 | Регрессий нет: виды, вход/выход, sync, add/delete, теги, фильтры, deep links | passed | Ручной проход видов/тега/sync; `ui-smoke.sh` (login/logout, PATCH/POST/DELETE, deep links); сеть/консоль чистые |
| 7 | `npm run build`, `node --check`, `ui-smoke.sh`, `monitor-api-smoke.mjs` — exit 0 | passed | Все четыре exit 0 |

---

## 6. Низкие наблюдения (не блокируют)

- **L1. Мобильная сортировка только по возрастанию.** `select#monitor-sort` даёт по одному
  направлению на колонку («CPU ↑»), без убывания; кроме того, после десктопной сортировки
  по убыванию и ресайза на 360 select показывает `cpu` («↑»), а данные остаются по убыванию
  (проверено: порядок 95.5 → 60.0 → 44.4 → 12.3 при `monitor.sort={cpu,desc}`). Не блокирует:
  select подписан «↑», на тач-устройстве это осознанный компромисс; можно добавить второй
  набор опций/стрелку направления или синхронизировать подпись с `monitor.sort.dir`.
- **L2. Тост может перекрыть кнопку «Обновить».** Глобальный `.toast-stack` (`position:fixed;
  top: calc(header+12px); right:16px; z-index:60; pointer-events:auto`) на 1280 занимает
  904–1264×76–126 и на время показа (4 с) лежит поверх `#monitor-refresh` (1142–1248×88–120):
  `document.elementFromPoint(1195,104)` → `toast-text`, клик блокируется (воспроизведено после
  сохранения тега). Кнопка доступна клавиатуре, проблема только мыши и временная; лечение —
  `pointer-events:none` на `.toast-stack` (кнопка закрытия остаётся кликабельной) или сдвиг
  тоста/кнопки. Компонент тоста существовал до мониторинга, но коллизия появилась из-за
  размещения «Обновить» в этой зоне.
- **L3. Кратковременные сырые id при медленном `/api/meta`.** Пока meta не пришла, таблица
  показывает id (в искусственном тесте — до 1.2 с), затем перерисовывается в метки. При обычной
  локальной meta это доли секунды и незаметно; если хочется нулевого мигания — не рендерить
  таблицу до meta или использовать id как fallback осознанно.
- **L4 (из раунда 1, не блокирует).** `reason` вида «probe: fetch failed» техничен; `aria-live`
  «Мониторинг обновлён» повторяется при автообновлении раз в 60 с; кэш 30 с после остановки VM
  до TTL отдаёт `available:true` (by design, проверено).

---

## 7. Доказательства round 2

- `docs/design/monitor-round2-1280.png` — 1280, синтетика: метки провайдеров, 12 колонок,
  компактные пилюли, KPI.
- `docs/design/monitor-round2-360.png` — 360: карточки с `data-empty`, пилюли 46/59, select
  «Сортировка», без скролла страницы.
- `docs/design/monitor-round2-vm-down.png` — живой инстанс после остановки stub: «Данные
  недоступны · проверено: 18:11:21», warn-баннер, KPI/таблица скрыты.
- Команды: `npm run build` (0), `node --check src/public/app.js` (0),
  `node scripts/monitor-api-smoke.mjs` (PASS, 0), `bash scripts/ui-smoke.sh` (0, «all UI smoke
  checks passed»); независимый API-script 8/8.

**Вывод:** repair t6 закрывает F1–F5 без новых medium/high-дефектов и регрессий; вид и API
готовы к приёмке и выкату. L1–L3 — необязательные улучшения следующего цикла.
