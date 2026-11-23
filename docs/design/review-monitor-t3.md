# Ревью «Мониторинг» (t3, round 1) — вид `#/monitor` и API на VictoriaMetrics

**Вердикт: `needs_revision`** — 3 medium, 2 low. Функциональная часть (API, безопасность,
устойчивость, регрессии, десктопный UI) проходит; блокируют приёмку дефекты карточного режима
на 360 и гонка загрузки на deep link, из-за которой таблица и фильтр показывают сырые id
провайдеров вместо подписей.
**Ревьюер:** design-director (не автор реализации).
**Предмет:** t2 — `src/public/{index.html,app.js,style.css}`, а также API t1
(`/api/monitor/overview`, `/api/monitor/hosts`) как источник данных.
**База приёмки:** `docs/DESIGN.md` §2–§6, контракт t3, зависимости t1/t2.
**Окружение:** одноразовый `DATA_DIR` (`/tmp/review-t3/...`), синтетика `scripts/seed-demo.mjs`
(вымышленные провайдеры, IP RFC 5737), собственный stub VictoriaMetrics на 6 хостах.
Прод-хост, его адрес/путь и реальные данные не использовались; `src/`, `scripts/`,
`docs/DESIGN.md` ревью не изменяло.

---

## 1. Итог

| Блок | Итог |
|---|---|
| API-контракт, склейка по `host`, `null` вместо `0`, кэш 30 с | **OK** — независимый stub + реальный `dist`: 8/8 проверок |
| Безопасность (401, секреты, read-only VM, внешние запросы) | **OK** — 401 JSON на оба эндпоинта, 12 GET-запросов к VM, 0 записей, 0 внешних запросов |
| VM недоступна | **OK** — `200 { available:false, reason }`, отдельный warn-баннер, KPI/таблица скрыты |
| UI 1280/1600 | **OK** — KPI, 12 колонок, сортировка `aria-sort`, фильтры, «только проблемные», без скролла страницы |
| UI 768 | **OK** — скролл только внутри `.table-wrap` (718/1172), подсказка прокрутки, страница не скроллится |
| UI 360 / карточный режим | **F2, F3, F4** — статус-пилюли растянуты на всю ячейку, 12 невидимых фокус-стопов
сортировки, пустые «—» не сворачиваются |
| Deep link/refresh `#/monitor` | **F1** — гонка с `/api/meta`: провайдеры показаны как `landvps`/`play2go` |
| Доступность десктопа | **OK** — `th scope`, `aria-sort`, фокус-ринги 2px, подписи фильтров/кнопок, Enter/Space на сортировке |
| Регрессии | **OK** — Обзор/Услуги/Провайдеры, вход/выход, sync, add/delete, теги, фильтры, deep links |
| `npm run build` / `node --check` / `monitor-api-smoke` / `ui-smoke` | **exit 0** |

---

## 2. Как проверялось

| Что | Как |
|---|---|
| Сборка/синтаксис | `npm run build` → exit 0; `node --check src/public/app.js` → exit 0 |
| API-smoke | `node scripts/monitor-api-smoke.mjs` → PASS, exit 0 |
| UI-smoke | `bash scripts/ui-smoke.sh` → «all UI smoke checks passed», exit 0 (включая Playwright-блок) |
| Независимая проверка API | Собственный script (не из репозитория): stub VM на 5 хостах (`alpha/beta/eta/theta/zeta`),
реальный `dist/index.js` на одноразовом `DATA_DIR`: 401/битая сессия, join ICMP+node, null-поля,
кэш, read-only, VM down, GET-only |
| Рендер | Chromium (Playwright MCP), 1600×900, 1280×900, 1024/1100, 768×900, 360×800; полные
скриншоты + измерения DOM; отдельный инстанс с мёртвым `VICTORIAMETRICS_URL` |
| Доступность | Tab-обход 40 шагов с логом `:focus-visible`/outline/rect, Enter/Space на `.th-sort`,
a11y-дерево, `th[scope]`, `aria-sort`, подписи |
| Контраст | вычисленные `color`/эффективный фон, формула WCAG 2.1, 11 пар: **4.65–16.53:1** |
| Внешние запросы | `browser_network_requests` за сессию: только `http://127.0.0.1:18080/...` |
| Данные | 6 синтетических хостов: ICMP down, node down, ICMP-only, node-only, CPU/RAM ≥ 90, длинное имя |

Ключевые замеры:

| Метрика | 1600 | 1280 | 768 | 360 |
|---|---|---|---|---|
| `document.documentElement.scrollWidth` | 1600 = innerWidth | 1280 | 768 | 360 |
| `.table-wrap` client/scroll | 1294/1294 | 974/974 | 718/**1172** | карточки 326/326 |
| Колонки | 12 по процентам | 12 fixed, 68–117px | auto, скролл внутри | карточки |
| Строка таблицы | 83px | 83px | 83px | **400px** |
| Статус-пилюля `up` | 46px (inline-flex) | 46px | 46px | **168px (flex)** |

---

## 3. Что подтверждено (с доказательствами)

### 3.1 API-контракт и данные

- `GET /api/monitor/overview` — `{available, updatedAt, cached, hosts{total,up,down,icmpDown,nodeDown},
  averages{cpu,ram,disk}, security{ufwEnabled,ufwTotal,ufwBlocks1h,fail2banBanned},
  top{cpu,ram,disk}}`; `GET /api/monitor/hosts` — `{available, updatedAt, cached, hosts[]}`,
  18 полей на строку.
- Склейка union по label `host`: оба хоста только с ICMP и только с node сохранены; отсутствующие
  метрики — `null` (`beta.rttP95Ms`, `beta.ufwBlocks1h`, `zeta.cpu`, `eta.icmpUp`), не `0` и не
  ошибка. Округление до 1 знака (12.34 → 12.3 мс/%), `uptimeSec` целый.
- Счётчики overview согласованы со строками: `total=5, down=1, up=4, icmpDown=1, nodeDown=1`;
  средние — среднее по непустым (44.2/53.1/48.5); security суммирует по host.
- Кэш 30 с: первый запрос `cached:false` + 12 запросов к VM, повторные в пределах TTL —
  `cached:true`, 0 новых запросов к VM; `updatedAt` общий для overview/hosts.
- Частичный отказ одной метрики — `200 available:true`, поле `null` (проверено в
  `monitor-api-smoke.mjs`; независимо — отсутствием части серий в stub).
- VM недоступна — оба эндпоинта `200 application/json`: `available:false`, `updatedAt:null`,
  `hosts.total=0`, `top`/`averages` пустые/null, `reason` без URL/секретов. Кэш при отказе не
  записывается (`getMonitorSnapshot` кэширует только `available`).

### 3.2 Безопасность

- Оба эндпоинта без cookies и с битым `sb_session=deadbeef` → `401 application/json
  {"error":"Unauthorized"}`; guard смонтирован в `index.ts` **до** общего `/api`, поэтому
  вместо редиректа — JSON.
- В коде/ответах нет паролей/токенов; smoke использует только фиктивные значения. `reason`
  не содержит `VICTORIAMETRICS_URL` и учётных данных.
- В VM уходят только `GET /api/v1/query` с read-only PromQL (`probe_success`, `up`, `rate`,
  `node_*`, `quantile_over_time`, `sum/max by`); stub зафиксировал 0 записей/не-GET.
- Фронтенд: `fetch('/api'+path)`, единственный внешний вид — inline `data:` SVG для шеврона
  `select` (старый, не сетевой). Сетевая сессия браузера: только same-origin.
- Мониторинговый API — только GET: `POST /api/monitor/overview` → 404, `/api/monitor/unknown` → 404.

### 3.3 Устойчивость VM и состояния UI

- Отдельный инстанс с мёртвым `VICTORIAMETRICS_URL`: баннер «VictoriaMetrics недоступна»
  (`app-error--warn`, причина `VictoriaMetrics недоступна: probe: fetch failed`), KPI-карточка и
  таблица скрыты (`hidden`), пустой таблицы «всё хорошо» нет; «Обновить»/«Повторить» на месте.
- Ошибка запроса при уже загруженных данных оставляет прошлый снимок и показывает баннер ошибки
  (код `renderMonitor`: `showCards = !offline && (!hasBanner || hasData)`).
- Пустой список — «Хостов нет»; пустой результат фильтров — «Ничего не найдено» + «Сбросить
  фильтры»; скелетон KPI/строк; `aria-busy` на таблице и кнопке.

### 3.4 UI и индиго-идентичность

- Пункт «Мониторинг» в группе «Инфраструктура», deep link `#/monitor`, `aria-current="page"`,
  крошка и `<title>`.
- KPI 8 ячеек (5/6, ICMP 1, node 1, средние CPU/RAM/диск, fail2ban 3, UFW 15), null → «—»;
  KPI-карточка `.card.summary` с аврора-градиентом.
- Таблица 12 колонок: ICMP/node `up|down` пилюли с русским `title`, RTT p50/p95 в мс, проценты,
  load1, аптайм; проблемные строки сверху и подсвечены `is-fail` + бейдж «проблема».
- Сортировка: `aria-sort` `none → ascending → descending → none`, null всегда внизу; Enter/Space
  работают; сброс возвращает проблемные сверху.
- Фильтры/«только проблемные»/сброс работают; счётчик «2 из 6»; пустой результат.
- 1280/1600: страница без горизонтального скролла, 12 колонок без скролла; 768/1024 — скролл
  только `.table-wrap` + `data-scrollable`, страница не скроллится; sticky-header проверен на
  24 строках (`th.top` не меняется при `wrap.scrollTop=300`).
- Контраст: meta 8.17, «только проблемные» 6.81, `up` 11.87, `down` на fail-строке 7.31,
  fail-строка dim 4.65, KPI warn 12.63/neutral 16.53, `th` 8.17 — все ≥4.5:1.
- Внешних ассетов, CDN, шрифтов нет; `color-scheme: dark`, чекбокс/селекты тёмные — светлых
  артефактов не найдено; JS-ошибок/console.warn нет (кроме ожидаемых 401 при тесте сессии).

### 3.5 Регрессии

- Виды `#/overview`, `#/services`, `#/providers`, `#/providers?state=failed` рендерятся, активный
  пункт/крошка/`<title>` корректны; неизвестный hash → `#/overview`.
- Правка тега/заметки через диалог → «Изменения сохранены», значения в строке; добавление
  аккаунта через форму → 4-я строка, форма очищена; удаление через confirm → тост «Аккаунт
  удалён», 3 строки; sync all → «Синхронизировано: 0 аккаунтов, 3 ошибки» (адаптеров нет —
  ожидаемо для синтетики); logout → `/login`; 401 мониторинга → `/login`.
- Playwright-сессия без pageerror; сетевые 401 — ожидаемые.

---

## 4. Findings

### F1 — medium: на deep link/refresh провайдеры показываются сырыми id (`landvps`, `play2go`)

**Файлы:** `src/public/app.js:1013` (мониторинг стартует независимо), `src/public/app.js:1094–1112`
(`fillProviders` не перерисовывает мониторинг), `src/public/app.js:1175–1184` (`renderAll` не
трогает `renderMonitor`).

**Проблема.** При прямом заходе на `#/monitor` (reload/F5/deep link) `ensureMonitor()` запускает
`loadMonitor()` до того, как `/api/meta` заполнит `providerMap`. `providerLabel()` возвращает
`String(id)`, и таблица + `<option>` фильтра показывают `play2go`/`kyonix`/`landvps` вместо
`Play2Go`/`Kyonix`/`LandVPS (BILLmanager)` (нарушение `DESIGN.md` §3.5 «вместо сырого id»).
После `/api/meta` перерисовки нет — сырые id висят до первого рендера мониторинга (сортировка,
фильтр, «Обновить», автообновление ≤60 с).

**Доказательство.** 5/5 перезагрузок `/#/monitor`: `providerCells = ["play2go","kyonix","landvps"]`,
`filterOptions = ["Все провайдеры","kyonix","landvps","play2go"]`; после клика по сортировке —
`["Play2Go","Play2Go","LandVPS (BILLmanager)"]`; после «Обновить» — корректные подписи.
Скриншот: `docs/design/monitor-review-1280.png` (сырые id на 1280/360). `monitor-ui-smoke.mjs`
не ловит: deep-link шаг ждёт KPI/`aria-current`, но не проверяет подписи провайдеров.

**Required fix.** После обновления `providerMap` (в конце `fillProviders` или в `renderAll`)
перерисовывать мониторинг, если снимок уже есть (`renderMonitor()`), либо дождаться `/api/meta`
до первого рендера; в `monitor-ui-smoke.mjs` после deep-link reload проверять, что ячейки
провайдера и `option` фильтра равны `meta.providers[].label`, а не id.

**Severity:** medium (видимый дефект на штатном входе в новый вид; лечится перерисовкой).

### F2 — medium: на 360 статус-пилюли растянуты на всю ячейку

**Файлы:** `src/public/style.css:790–804` (`.table-card td { display:grid }`), `src/public/app.js:852–856`
(`monitorStatusCell` отдаёт `.badge` прямо в `<td>`), `src/public/style.css:402` (`.badge` —
`inline-flex`).

**Проблема.** В карточном режиме `<td>` становится grid-контейнером, grid-item блокифицируется:
`.badge` из `inline-flex` превращается в `flex` и растягивается на всю колонку значения. Пилюля
`up`/`down` (2 буквы) занимает 168px из 276px и выглядит как цветная полоса, а не пилюля;
на десктопе она 46px. Это ломает словарь §3.4 («бейдж — пилюля») и комментарий в коде
(«компактные up/down»).

**Доказательство.** 360: `.badge--ok` → `width=168, height=22, cellWidth=276, display=flex`;
1280: `width=46, display=inline-flex`. Скриншот `docs/design/monitor-review-360.png`
(зелёные/красные полосы в карточках).

**Required fix.** В карточном режиме `justify-self:start` для статус-бейджей в `<td>`
(например, `.monitor-table td.cell-status .badge { justify-self: start; }`) либо обернуть бейдж в
`span` c `inline-flex`; проверить, что ширина равна контенту (~46px) на 360–767.

**Severity:** medium (визуальный дефект обязательной ширины 360, ядро статус-словаря).

### F3 — medium: на 360 сортировка уходит в невидимые фокус-стопы (и недоступна пальцем)

**Файлы:** `src/public/style.css:775–780` (`.table-card thead` — absolute 1×1 + `clip-path`),
`src/public/index.html:326–337` (12 кнопок `.th-sort` внутри `th`).

**Проблема.** `thead` визуально скрыт, но остаётся в DOM и в tab-порядке. После фильтров Tab
попадает в 12 подряд идущих кнопок сортировки, у которых `rect` 10×16 в clipped-`thead`;
фокус-ринг (2px `--ring`) обрезается `clip-path: inset(50%)` — видимого индикатора фокуса нет
(WCAG 2.4.7). На тач-устройствах сортировки нет вовсе (заголовки скрыты), хотя данные и фильтры
доступны.

**Доказательство.** Tab-лог на 360: `BUTTON.th-sort` ×12, `clipParent=THEAD: inset(50%)`,
`rect=[12,712,10,16]…`, `:focus-visible=true`, screenshot 360 без фокус-ринга. На 1280 те же
кнопки видны и работают (Enter/Space → `aria-sort`).

**Required fix.** Убрать скрытые сортировочные кнопки из tab-порядка в карточном режиме и дать
доступную замену — компактный `select` «Сортировка» (12 колонок + сброс) в тулбаре на `<768`,
либо видимую панель сортировки; проверить Tab-обход 360 без невидимых остановок и наличие
фокус-ринга у нового контрола. `monitor-ui-smoke.mjs` дополнить Tab-проверкой на 360.

**Severity:** medium (a11y-критерий «фокус-ринги/таблица с клавиатуры» не выполняется на 360).

### F4 — low: пустые «—» не помечены `data-empty` — карточки на 360 раздуты

**Файлы:** `src/public/app.js:858–876` (`monitorRowHtml`/`monitorStatusCell`), `DESIGN.md` §5.3
(«Пустые ячейки («—») в app.js получают `data-empty` и в карточной раскладке не занимают строку»),
`src/public/style.css:805` (`.table-card td[data-empty] { display:none }` уже есть).

**Проблема.** Для хоста `ams-proxy-03` в первой строке 5 ячеек «—», ни одна не имеет
`data-empty`; карточка занимает 400px (12 строк), 6 хостов → страница 3133px. В services/accounts
`data-empty` ставится — это регресс относительно §5.3, а не осознанное отличие (в коде нет
комментария об исключении).

**Доказательство.** 360: `emptyCells=5, emptyCellsMarked=0`, `rowHeight=400`,
`monitor-review-360.png`.

**Required fix.** Помечать `data-empty` ячейки, которые рендерятся как «—» (ICMP/node null, RTT
null, проценты/load/аптайм null) — на десктопе «—» остаётся, в карточном режиме строка
сворачивается; либо явно зафиксировать отличие в спеке (но `DESIGN.md` вне scope этой задачи).

**Severity:** low (плотность/соответствие §5.3; данные не теряются).

### F5 — low: при недоступной VM строка «Обновлено: <сейчас>» противоречит баннеру

**Файлы:** `src/public/app.js:1016–1019` (`updatedAt` fallback на `new Date()` при `null` в
ответе), `src/public/app.js:891–897` (`monitorMetaHtml`).

**Проблема.** Оба ответа `available:false, updatedAt:null`, но UI подставляет текущее время и
показывает «Обновлено: 23.11.2026 17:42:08 · автообновление раз в 60 с» над баннером
«VictoriaMetrics недоступна». Пользователь читает это как «данные свежие», хотя данных нет;
формулировка противоречит состоянию.

**Доказательство.** 18081 с мёртвым VM: `meta="Обновлено: 23.11.2026 17:42:08 …"`,
`bannerTitle="VictoriaMetrics недоступна"`; скриншот `docs/design/monitor-review-vm-down.png`.

**Required fix.** Не подставлять `new Date()` при `available:false`; в offline-состоянии
показывать «Данные недоступны»/«Проверено: HH:MM:SS» либо скрывать мету до успешного снимка.

**Severity:** low (не вводит в заблуждение о таблице — она скрыта, но мета врёт).

---

## 5. Некритичные наблюдения (не блокируют)

- **Кэш и детект отказа.** 30-секундный снимок отдаётся и после остановки VM: сразу после
  успешного запроса `available:true, cached:true` (проверено), `available:false` — только после
  истечения TTL/на новом процессе. Это следует из требования кэша, но при приёмке «остановили
  stub → available:false» надо ждать TTL или поднимать свежий инстанс.
- **Текст причины.** `reason` вида `VictoriaMetrics недоступна: probe: fetch failed` содержит
  внутренний ключ запроса и английскую ошибку Node; для владельца панели полезно, но можно
  очеловечить («нет связи с базой метрик»), детали оставить в логе.
- **`aria-live` при автообновлении.** `announce('Мониторинг обновлён')` каждые 60 с на открытом
  виде — скринридер будет повторять сообщение; лучше озвучивать только ручное обновление/первый
  рендер.
- **Обрезка на 1280:** `monitoring` → `monito…` (роль, 56px), `LandVPS (BILLmanager)` → `LandVPS
  (BILLm…` (и на 1600, 117px), длинный хост — `vps-frankfurt-…`; обрезка через `text-overflow:
  ellipsis` + `title`, посреди слова не рвётся. Можно выиграть 1–2% у RTT-колонок, но это вкус,
  не дефект.
- **768/1024** скролл таблицы внутри `.table-wrap` с подсказкой — соответствует §5.3; страница
  не скроллится.
- **Sticky header** мониторинга работает (проверено на 24 строках), несмотря на `position:
  relative` в `.monitor-table th` — каскад оставляет `sticky` на ≥1024.
- **`top` в overview** (top-5 CPU/RAM/диск) UI не использует — лишняя поверхность API, не дефект.

---

## 6. Что нужно для `pass`

1. F1: перерисовка мониторинга после `/api/meta` + регресс-проверка подписей на deep-link reload.
2. F2: компактные статус-пилюли в карточном режиме 360–767.
3. F3: убрать невидимые фокус-стопы и дать доступную сортировку в карточном режиме с видимым
   фокус-рингом.
4. F4/F5 — желательно в том же repair-раунде (дешёвые правки), но не блокируют.

После правок: `npm run build`; `node --check src/public/app.js`; `node scripts/monitor-api-smoke.mjs`;
`bash scripts/ui-smoke.sh`; повторный рендер 360/768/1280/1600 + Tab-обход 360 и deep-link reload.

---

## 7. Доказательства

- `docs/design/monitor-review-1280.png` — 1280×900, синтетика, сырые id провайдеров после
  deep-link reload (F1).
- `docs/design/monitor-review-360.png` — 360, карточный режим: растянутые пилюли (F2), 12 строк
  на карточку (F4).
- `docs/design/monitor-review-vm-down.png` — 1280, мёртвый VM: warn-баннер, скрытые KPI/таблица,
  «Обновлено» при отсутствии данных (F5).
- API-доказательства: независимый stub (5 хостов, 12 запросов, 401/битая сессия, кэш, read-only,
  VM down) — 8/8 PASS; `monitor-api-smoke.mjs` — PASS; `ui-smoke.sh` — PASS.
