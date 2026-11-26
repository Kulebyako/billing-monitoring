#!/usr/bin/env bash
# UI smoke-проверка панели billing-monitoring.
# Статические проверки src/public + прогон сервера на синтетических данных (DATA_DIR во временном каталоге).
# Запуск из корня репозитория: bash scripts/ui-smoke.sh
# Только синтетика из Приложения А docs/DESIGN.md; реальные данные не используются.

set -uo pipefail
cd "$(dirname "$0")/.."

PUBLIC="src/public"
FAIL=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }
section() { printf '\n== %s ==\n' "$1"; }

section "статика: синтаксис и состав"
if node --check "$PUBLIC/app.js"; then pass "node --check src/public/app.js"; else fail "node --check src/public/app.js"; fi

for id in summary services accounts add-account filter-provider filter-tag provider-select provider-hint \
  edit-dlg edit-form edit-save btn-sync btn-logout view-overview view-services view-providers nav sync-status \
  paid-meter header breadcrumb drawer-btn confirm-dlg confirm-ok confirm-cancel toast app-error chart-weekly \
  attention skeleton main \
  view-monitor monitor-summary monitor-kpi monitor-meta monitor-refresh monitor-banner monitor-banner-title \
  monitor-banner-text monitor-banner-retry monitor-table-card monitor-hosts monitor-hosts-body monitor-hosts-count \
  monitor-problems monitor-provider monitor-role monitor-reset monitor-sort \
  monitor-legend monitor-problems-label; do
  if grep -q "id=\"$id\"" "$PUBLIC/index.html"; then pass "id #$id"; else fail "id #$id отсутствует в index.html"; fi
done

for name in provider label baseUrl login password token; do
  if grep -q "name=\"$name\"" "$PUBLIC/index.html"; then pass "поле name=$name"; else fail "поле name=$name отсутствует"; fi
done
for name in id tag notes; do
  if grep -q "name=\"$name\"" "$PUBLIC/index.html"; then pass "поле диалога name=$name"; else fail "поле диалога name=$name отсутствует"; fi
done

section "статика: hero, плюрализация и таблица"
if node - <<'NODE'
const fs = require('fs');
const src = fs.readFileSync('src/public/app.js', 'utf8');
function grab(name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('function ' + name + ' not found');
  return m[0];
}
const sandbox = {};
new Function('exports', grab('plural') + '\n' + grab('attentionText') + '\nexports.attentionText = attentionText;')(sandbox);
const cases = [
  [1, '1 услуга требует внимания'],
  [2, '2 услуги требуют внимания'],
  [3, '3 услуги требуют внимания'],
  [4, '4 услуги требуют внимания'],
  [5, '5 услуг требуют внимания'],
  [11, '11 услуг требуют внимания'],
  [21, '21 услуга требует внимания'],
];
let bad = 0;
for (const [n, expected] of cases) {
  const got = sandbox.attentionText(n);
  if (got !== expected) {
    console.error('  attentionText(' + n + ') = ' + JSON.stringify(got) + ', ожидалось ' + JSON.stringify(expected));
    bad += 1;
  }
}
process.exit(bad ? 1 : 0);
NODE
then
  pass "hero: формы «услуга/услуги/услуг» для n=1,2,3,4,5,11,21"
else
  fail "hero: неверные формы множественного числа"
fi

if grep -q 'attentionServices(d)' "$PUBLIC/app.js" && grep -q 'attentionText(attention.length)' "$PUBLIC/app.js" && grep -q 'const attention = attentionServices(d)' "$PUBLIC/app.js"; then
  pass "hero и карточка считают одно множество urgent ∪ lowBalance"
else
  fail "hero и карточка считают разные множества"
fi

if grep -q 'min-width: 1120px' "$PUBLIC/style.css" &&
  grep -q 'nth-child(1) { width: 15%' "$PUBLIC/style.css" &&
  grep -q 'nth-child(7) { width: 11.5%' "$PUBLIC/style.css" &&
  grep -q 'nth-child(8) { width: 6%' "$PUBLIC/style.css" &&
  grep -q 'nth-child(9) { width: 17.5%' "$PUBLIC/style.css"; then
  pass "таблица услуг: min-width 1120px, Провайдер 15%, Статус 11.5%, Тег 6%, Заметка 17.5%"
else
  fail "ширины колонок таблицы услуг не совпадают с согласованными"
fi

section "статика: запреты и бюджеты"
if grep -q 'class="top"' "$PUBLIC/index.html"; then fail "старый верхний header (.top) остался"; else pass "старый header удалён"; fi
if grep -q 'style.css' "$PUBLIC/login.html"; then fail "login.html ссылается на /style.css"; else pass "login.html не ссылается на /style.css"; fi
if grep -q '<style>' "$PUBLIC/login.html"; then pass "login.html содержит inline-стили"; else fail "login.html без inline-стилей"; fi
if grep -q 'id="login"' "$PUBLIC/login.html" && grep -q 'id="err"' "$PUBLIC/login.html" && grep -q 'role="alert"' "$PUBLIC/login.html"; then
  pass "login.html: #login, #err, role=alert"
else
  fail "login.html: нет #login/#err/role=alert"
fi

if grep -nE 'https?://|@import|fonts\.googleapis|cdn\.' "$PUBLIC"/* >/dev/null 2>&1; then
  fail "внешние запросы/URL в src/public: $(grep -nE 'https?://|@import|fonts\.googleapis|cdn\.' "$PUBLIC"/* | head -3 | tr '\n' ' ')"
else
  pass "нет внешних запросов (CDN, шрифты, @import)"
fi

if grep -niE 'prefers-color-scheme|theme-toggle|\blight\b' "$PUBLIC"/* >/dev/null 2>&1; then
  fail "светлая тема/переключатель темы в src/public"
else
  pass "только тёмная тема, без prefers-color-scheme и переключателя"
fi

if grep -nE '(^|[^[:alnum:]_])alert\(|(^|[^[:alnum:]_])confirm\(' "$PUBLIC/app.js" >/dev/null 2>&1; then
  fail "alert()/confirm() в app.js: $(grep -nE '(^|[^[:alnum:]_])alert\(|(^|[^[:alnum:]_])confirm\(' "$PUBLIC/app.js" | head -3 | tr '\n' ' ')"
else
  pass "нет alert()/confirm() в app.js"
fi

if grep -nE '^[[:space:]]*import[[:space:]]|require\(|React|Vue|Tailwind' "$PUBLIC/app.js" >/dev/null 2>&1; then
  fail "импорты/фреймворки в app.js"
else
  pass "app.js без импортов и фреймворков"
fi

if grep -qE '<canvas|getContext\(' "$PUBLIC/app.js"; then fail "canvas в графике"; else pass "график без canvas"; fi
if grep -q 'role="img"' "$PUBLIC/app.js"; then pass "график: role=img"; else fail "график без role=img"; fi
if grep -q 'font-variant-numeric: tabular-nums' "$PUBLIC/style.css"; then pass "tabular-nums"; else fail "нет tabular-nums"; fi
if grep -q 'position: sticky' "$PUBLIC/style.css"; then pass "sticky-заголовок таблиц/шапки"; else fail "нет sticky"; fi

# цвета — только через var(--…): литералы допустимы в :root и в data-URI шеврона
color_offenders=$(awk '
  /^:root[[:space:]]*\{/ { root = 1 }
  root && /^\}/ { root = 0; next }
  root { next }
  /data:image\/svg\+xml/ { next }
  /#[0-9a-fA-F]{3,8}|rgba?\(/ { print FILENAME ":" NR ":" $0 }
' "$PUBLIC/style.css")
if [ -n "$color_offenders" ]; then fail "цветовые литералы вне :root: $color_offenders"; else pass "цвета только через var(--…)"; fi

css_lines=$(wc -l < "$PUBLIC/style.css")
if [ "$css_lines" -ge 600 ] && [ "$css_lines" -le 1000 ]; then pass "style.css: $css_lines строк (600–1000)"; else fail "style.css: $css_lines строк, нужно 600–1000"; fi
login_lines=$(wc -l < "$PUBLIC/login.html")
if [ "$login_lines" -le 90 ]; then pass "login.html: $login_lines строк (≤90)"; else fail "login.html: $login_lines строк, нужно ≤90"; fi

for token in --bg --surface --surface-2 --surface-3 --field --fail-bg --overlay --row-hover --border --hairline \
  --border-strong --text --text-muted --text-dim --text-faint --accent --accent-soft --accent-ink --ok --ok-bg \
  --warn --warn-bg --danger --danger-bg --danger-soft --ring --ring-soft --fs-12 --fs-13 --fs-14 --fs-15 \
  --fs-18 --fs-34 --tracking-figure --s-1 --s-16 --r-sm --r-2xl --shadow-xs --shadow-lg --sidebar-w \
  --sidebar-w-drawer --header-h --content-max --gutter --ease --dur \
  --line-soft --row-line --active-line --header-line --sticky-bg --chart-1 --chart-2 --chart-3 --grad-card \
  --grad-summary --grad-meter --header-bg --user-bg --meter-bg --badge-ok-bg --badge-warn-bg --badge-danger-bg \
  --badge-accent-bg --badge-neutral-bg --edge-fade --shadow-card --glow-accent --glow-chart; do
  if grep -q -- "$token:" "$PUBLIC/style.css"; then pass "токен $token"; else fail "токен $token отсутствует"; fi
done

section "статика: палитра «Индиго»"
for pair in "--bg: #0b0915" "--surface: #121022" "--surface-2: #181530" "--surface-3: #1f1b3b" \
  "--field: #15122a" "--border: #292350" "--hairline: #1d1838" "--border-strong: #6b63a8" \
  "--text: #ece9f9" "--text-muted: #a9a2c9" "--accent: #9c93ff"; do
  if grep -qF -- "$pair" "$PUBLIC/style.css"; then pass "индиго: $pair"; else fail "индиго: нет $pair"; fi
done

if grep -nE '#151514|#1e1e1c|#232321|#2a2a27|#ecebe6|#a3b3c4|#92b095|#cfa968|#e0806a' "$PUBLIC"/* >/dev/null 2>&1; then
  fail "остались хексы прежней палитры: $(grep -nE '#151514|#1e1e1c|#232321|#2a2a27|#ecebe6|#a3b3c4|#92b095|#cfa968|#e0806a' "$PUBLIC"/* | head -3 | tr '\n' ' ')"
else
  pass "нет хексов прежней палитры (#151514, #1e1e1c, #ecebe6, #a3b3c4, #92b095, #cfa968, #e0806a)"
fi

if grep -q 'data-scrollable="true"' "$PUBLIC/style.css" &&
  grep -q 'function syncTableOverflow()' "$PUBLIC/app.js" &&
  grep -q 'watchTableOverflow();' "$PUBLIC/app.js"; then
  pass "подсказка горизонтального скролла: data-scrollable по фактическому overflow, любая ширина ≥768"
else
  fail "подсказка горизонтального скролла не привязана к фактическому overflow"
fi

section "статика: вид «Мониторинг»"
if grep -q 'href="#/monitor" data-view="monitor"' "$PUBLIC/index.html" &&
  grep -q '<span>Мониторинг</span>' "$PUBLIC/index.html"; then
  pass "пункт сайдбара «Мониторинг» → #/monitor"
else
  fail "нет пункта сайдбара «Мониторинг» (#/monitor)"
fi

if grep -q "api('/monitor/overview')" "$PUBLIC/app.js" && grep -q "api('/monitor/hosts')" "$PUBLIC/app.js"; then
  pass "данные только из /api/monitor/overview и /api/monitor/hosts"
else
  fail "вид не ходит в /api/monitor/*"
fi
if grep -qE '203\.0\.113|198\.51\.100|monitor-host-1' "$PUBLIC"/app.js "$PUBLIC"/index.html; then
  fail "в вёрстке остались хардкод-значения хостов"
else
  pass "нет хардкод-значений хостов (тестовая RFC 5737 подсеть отсутствует)"
fi
if grep -q 'data-label="Хост"' "$PUBLIC/index.html"; then
  fail "строки хостов захардкожены в index.html"
else
  pass "таблица хостов строится только из ответа API"
fi

if grep -q 'const MONITOR_REFRESH_MS = 60000' "$PUBLIC/app.js" &&
  grep -q 'setInterval(monitorAutoRefresh, MONITOR_REFRESH_MS)' "$PUBLIC/app.js" &&
  grep -q 'if (document.hidden) return' "$PUBLIC/app.js"; then
  pass "автообновление мониторинга раз в 60 с с паузой при скрытой вкладке"
else
  fail "автообновление мониторинга не 60 с или без паузы при document.hidden"
fi

if grep -q 'aria-sort="none"' "$PUBLIC/index.html" &&
  grep -q 'data-sort-key=' "$PUBLIC/index.html" &&
  grep -q 'th\[aria-sort="descending"\]' "$PUBLIC/style.css" &&
  grep -q "setAttribute('aria-sort'" "$PUBLIC/app.js"; then
  pass "сортировка: th[aria-sort], кнопки .th-sort и индикатор направления"
else
  fail "сортировка без aria-sort/кнопок"
fi

if grep -q 'th-sort:focus-visible' "$PUBLIC/style.css" &&
  grep -q '^:focus-visible { outline: 2px solid var(--ring)' "$PUBLIC/style.css"; then
  pass "фокус-ринги: глобальный :focus-visible и .th-sort:focus-visible"
else
  fail "нет фокус-рингов у сортировки"
fi

if grep -q 'available === false' "$PUBLIC/app.js" &&
  grep -q 'VictoriaMetrics недоступна' "$PUBLIC/app.js" &&
  grep -q 'app-error--warn' "$PUBLIC/style.css"; then
  pass "состояние «VM недоступна»: отдельный баннер с причиной"
else
  fail "нет отдельного состояния available:false"
fi

# причины флага «проблема»: один порог-константа, видимый текст причины, полный
# список в title/aria-label, легенда с правилом — без копии числа в вёрстке
if grep -q 'const MONITOR_PROBLEM_PCT = 90;' "$PUBLIC/app.js" &&
  grep -q 'function monitorProblemReasons(row)' "$PUBLIC/app.js" &&
  grep -q 'function monitorProblemFlag(row)' "$PUBLIC/app.js" &&
  grep -q 'reasons.slice(0, 2)' "$PUBLIC/app.js" &&
  grep -q 'aria-label="${esc(flag.full)}"' "$PUBLIC/app.js" &&
  grep -q 'ICMP или node-exporter недоступны; CPU, RAM или диск' "$PUBLIC/app.js" &&
  grep -q 'id="monitor-legend"' "$PUBLIC/index.html" &&
  ! grep -qE '≥[[:space:]]*90|90[[:space:]]?%' "$PUBLIC/index.html"; then
  pass "причины «проблемы»: MONITOR_PROBLEM_PCT, бейдж + title/aria, легенда с порогом"
else
  fail "причины/легенда «проблемы» не привязаны к MONITOR_PROBLEM_PCT или порог продублирован"
fi

# бейдж с причинами переносится внутри ячейки, а не расширяет таблицу
if awk '/^\.monitor-flag \{/,/^\}/' "$PUBLIC/style.css" | grep -q 'white-space: normal'; then
  pass "бейдж-причина переносится строкой внутри ячейки (white-space: normal)"
else
  fail "бейдж-причина не переносится (нет white-space: normal)"
fi

missing_labels=""
for label in "Хост" "Провайдер" "Роль" "ICMP" "RTT p50" "RTT p95" "node-exporter" "CPU %" "RAM %" "Диск %" "load1" "Аптайм"; do
  if ! grep -q "data-label=\"$label\"" "$PUBLIC/app.js"; then missing_labels="$missing_labels $label"; fi
done
if [ -n "$missing_labels" ]; then
  fail "нет data-label у колонок:$missing_labels"
else
  pass "12 колонок размечены data-label для карточного режима 360"
fi

# провайдеры подписываются из /api/meta и перерисовываются, когда meta пришла позже снимка
if grep -q 'if (monitor.overview || monitor.hosts) renderMonitor();' "$PUBLIC/app.js"; then
  pass "провайдеры мониторинга перерисовываются после обновления providerMap"
else
  fail "нет перерисовки мониторинга после /api/meta (providerMap)"
fi

# карточный режим: компактные бейджи и скрытые null-ячейки
if grep -q 'td.cell-status .badge { justify-self: start; }' "$PUBLIC/style.css"; then
  pass "статус-бейджи в карточном режиме не растягиваются (justify-self: start)"
else
  fail "нет justify-self: start у статус-бейджей в карточном режиме"
fi
if grep -q 'data-empty' "$PUBLIC/app.js" && grep -q 'td\[data-empty\] { display: none; }' "$PUBLIC/style.css"; then
  pass "null-ячейки помечены data-empty и скрыты в карточном режиме"
else
  fail "null-ячейки не помечены data-empty"
fi

# сортировка на телефоне: скрытые кнопки thead вне tab-порядка + select «Сортировка»
if grep -q '.monitor-table thead { display: none; }' "$PUBLIC/style.css" &&
  grep -q 'monitor-sort' "$PUBLIC/app.js"; then
  pass "в карточном режиме thead выключен из tab-порядка, сортировка через select"
else
  fail "скрытые sort-кнопки остаются в tab-порядке или нет select «Сортировка»"
fi
if node - "$PUBLIC/index.html" <<'NODE'
const fs = require('fs');
const html = fs.readFileSync(process.argv[2], 'utf8');
const block = html.match(/<select id="monitor-sort"[\s\S]*?<\/select>/);
if (!block) process.exit(1);
const values = [...block[0].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
const keys = values.filter(Boolean);
const expected = ['host', 'provider', 'role', 'icmp', 'rttP50Ms', 'rttP95Ms', 'node', 'cpu', 'ram', 'disk', 'load1', 'uptimeSec'];
process.exit(values.length === 13 && keys.length === 12 && expected.every((key) => keys.includes(key)) ? 0 : 1);
NODE
then
  pass "select «Сортировка»: 12 колонок + сброс"
else
  fail "select «Сортировка»: ожидались 12 колонок и сброс"
fi

# offline-состояние не подставляет текущее время вместо времени снимка
if grep -q 'Данные недоступны' "$PUBLIC/app.js" &&
  grep -q 'monitor.checkedAt' "$PUBLIC/app.js" &&
  ! grep -q '|| new Date().toISOString()' "$PUBLIC/app.js"; then
  pass "available:false показывает «Данные недоступны · проверено: HH:MM:SS» без подставленного времени"
else
  fail "offline-мета подставляет время или нет сообщения «Данные недоступны»"
fi

if [ "${SMOKE_STATIC_ONLY:-0}" = "1" ]; then
  section "итог"
  [ "$FAIL" -eq 0 ] && { echo "static checks passed"; exit 0; }
  echo "FAILED: $FAIL"; exit 1
fi

section "runtime: сервер на синтетических данных"
if ! command -v curl >/dev/null 2>&1; then
  fail "curl не найден — runtime-проверки пропущены"
elif [ ! -x node_modules/.bin/tsx ]; then
  fail "node_modules/.bin/tsx не найден: выполните npm ci --include=dev"
else
  TMP=$(mktemp -d)
  SERVER_PID=""
  cleanup() {
    if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
    rm -rf "$TMP"
  }
  trap cleanup EXIT

  PORT=$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')
  BASE="http://127.0.0.1:$PORT"

  env -i PATH="$PATH" HOME="$HOME" TZ=Europe/Moscow PORT="$PORT" \
    PANEL_PASSWORD="smoke-pass" SESSION_SECRET="smoke-session-secret" \
    CREDENTIALS_KEY="0123456789abcdef0123456789abcdef" DATA_DIR="$TMP/data" \
    BALANCE_THRESHOLD=200 SYNC_CRON='0 0 1 1 *' REMINDER_CRON='0 0 1 1 *' \
    MONITOR_SUMMARY_CRON='0 0 1 1 *' TELEGRAM_BOT_TOKEN='' TELEGRAM_CHAT_ID='' \
    VICTORIAMETRICS_URL='' PLAYWRIGHT_HEADLESS=1 \
    node_modules/.bin/tsx src/index.ts >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!

  ready=0
  for _ in $(seq 1 100); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/login" 2>/dev/null || true)
    if [ "$code" = "200" ]; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" != "1" ]; then
    fail "сервер не стартовал (порт $PORT)"
    sed -n '1,20p' "$TMP/server.log" >&2 || true
  else
    pass "сервер слушает $BASE"

    if node scripts/seed-demo.mjs "$TMP/data" >"$TMP/seed.log" 2>&1; then
      pass "синтетические данные: $(cat "$TMP/seed.log")"
    else
      fail "seed-demo.mjs: $(cat "$TMP/seed.log")"
    fi

    code=$(curl -s -o "$TMP/login.html" -w '%{http_code}' "$BASE/login")
    [ "$code" = "200" ] && pass "GET /login → 200" || fail "GET /login → $code"
    grep -q '<style>' "$TMP/login.html" && pass "login отдаёт inline-стили" || fail "login без inline-стилей"
    grep -q 'style.css' "$TMP/login.html" && fail "login ссылается на style.css" || pass "login без style.css"

    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
    [ "$code" = "302" ] && pass "GET / без сессии → 302" || fail "GET / без сессии → $code"
    code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/style.css")
    [ "$code" = "302" ] && pass "GET /style.css без сессии → 302" || fail "GET /style.css без сессии → $code"

    code=$(curl -s -o "$TMP/bad.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d '{"password":"wrong"}' "$BASE/api/login")
    [ "$code" = "401" ] && pass "неверный пароль → 401" || fail "неверный пароль → $code"

    code=$(curl -s -c "$TMP/cookies" -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d '{"password":"smoke-pass"}' "$BASE/api/login")
    [ "$code" = "200" ] && pass "вход → 200 + cookie" || fail "вход → $code"

    code=$(curl -s -b "$TMP/cookies" -o "$TMP/index.html" -w '%{http_code}' "$BASE/")
    if [ "$code" = "200" ] && grep -q 'class="sidebar"' "$TMP/index.html" && grep -q 'id="view-overview"' "$TMP/index.html"; then
      pass "GET / с сессией → 200, сайдбар и виды на месте"
    else
      fail "GET / с сессией → $code"
    fi
    for id in btn-sync btn-logout summary services accounts add-account edit-dlg; do
      grep -q "id=\"$id\"" "$TMP/index.html" || fail "id #$id отсутствует в отданном HTML"
    done

    code=$(curl -s -b "$TMP/cookies" -o "$TMP/style.css" -w '%{http_code}' "$BASE/style.css")
    [ "$code" = "200" ] && pass "GET /style.css с сессией → 200" || fail "GET /style.css с сессией → $code"

    if curl -s -b "$TMP/cookies" -o "$TMP/dashboard.json" "$BASE/api/dashboard" &&
      node - "$TMP/dashboard.json" <<'NODE'
const fs = require('fs');
const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const monthly = d.services
  .filter((s) => s.status !== 'missing' && s.status !== 'deleted')
  .reduce((sum, s) => sum + (Number(s.cost) || 0), 0);
const rfc5737 = d.services.every((s) => !s.ip || /^(192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/.test(s.ip));
const ok = [
  ['services=5', d.services.length === 5],
  ['urgent=4', d.urgent.length === 4],
  ['lowBalance=2', d.lowBalance.length === 2],
  ['syncErrors=1', d.syncErrors.length === 1],
  ['accounts=3', d.accounts.length === 3],
  ['monthly=3620', monthly === 3620],
  ['IP только RFC 5737', rfc5737],
];
let bad = 0;
for (const [name, passed] of ok) {
  if (!passed) { console.error('  FAIL api/dashboard: ' + name); bad += 1; }
}
process.exit(bad ? 1 : 0);
NODE
    then
      pass "GET /api/dashboard: 5 услуг, 4 срочных, 2 низких баланса, 1 ошибка, 3 аккаунта, 3620 ₽"
    else
      fail "GET /api/dashboard: данные не совпали с синтетическим набором"
    fi

    if curl -s -b "$TMP/cookies" -o "$TMP/meta.json" "$BASE/api/meta" &&
      node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(Array.isArray(m.providers)&&m.providers.length===6?0:1)' "$TMP/meta.json"; then
      pass "GET /api/meta: 6 провайдеров"
    else
      fail "GET /api/meta"
    fi

    code=$(curl -s -b "$TMP/cookies" -o "$TMP/patch.json" -w '%{http_code}' -X PATCH -H 'Content-Type: application/json' \
      -d '{"tag":"proxy","notes":"smoke"}' "$BASE/api/services/1")
    if [ "$code" = "200" ] && node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.tag==="proxy"?0:1)' "$TMP/patch.json"; then
      pass "PATCH /api/services/1: тег сохранён"
    else
      fail "PATCH /api/services/1 → $code"
    fi

    code=$(curl -s -b "$TMP/cookies" -o "$TMP/account.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
      -d '{"provider":"landvps","label":"smoke"}' "$BASE/api/accounts")
    new_id=$(node -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.id||""))}catch(e){}' "$TMP/account.json")
    if [ "$code" = "201" ] && [ -n "$new_id" ]; then
      pass "POST /api/accounts → 201 (id $new_id)"
      code=$(curl -s -b "$TMP/cookies" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/accounts/$new_id")
      [ "$code" = "200" ] && pass "DELETE /api/accounts/$new_id → 200" || fail "DELETE /api/accounts/$new_id → $code"
    else
      fail "POST /api/accounts → $code"
    fi

    code=$(curl -s -o "$TMP/monitor-anon.json" -w '%{http_code}' "$BASE/api/monitor/overview")
    [ "$code" = "401" ] && pass "GET /api/monitor/overview без сессии → 401" || fail "GET /api/monitor/overview без сессии → $code"
    code=$(curl -s -b "$TMP/cookies" -o "$TMP/monitor.json" -w '%{http_code}' "$BASE/api/monitor/overview")
    if [ "$code" = "200" ] && node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.available===false&&typeof d.reason==="string"&&d.reason.length>0?0:1)' "$TMP/monitor.json"; then
      pass "GET /api/monitor/overview без VM → 200 { available:false, reason }"
    else
      fail "GET /api/monitor/overview без VM → $code"
    fi
    code=$(curl -s -b "$TMP/cookies" -o "$TMP/monitor-hosts.json" -w '%{http_code}' "$BASE/api/monitor/hosts")
    if [ "$code" = "200" ] && node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.available===false&&Array.isArray(d.hosts)&&d.hosts.length===0?0:1)' "$TMP/monitor-hosts.json"; then
      pass "GET /api/monitor/hosts без VM → 200 { available:false, hosts:[] }"
    else
      fail "GET /api/monitor/hosts без VM → $code"
    fi

    code=$(curl -s -b "$TMP/cookies" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/logout")
    [ "$code" = "200" ] && pass "выход → 200" || fail "выход → $code"
    code=$(curl -s -b "$TMP/cookies" -o /dev/null -w '%{http_code}' "$BASE/")
    [ "$code" = "302" ] && pass "после выхода / → 302" || fail "после выхода / → $code"
  fi
fi

section "runtime: UI вида «Мониторинг» (Playwright)"
if [ ! -d node_modules/playwright ]; then
  fail "playwright не установлен: выполните npm ci --include=dev"
elif [ ! -d node_modules/.bin ]; then
  fail "node_modules/.bin не найден: выполните npm ci --include=dev"
elif node scripts/monitor-ui-smoke.mjs; then
  pass "вид «Мониторинг»: KPI, сортировка, фильтры, состояния, адаптив, 401, без внешних запросов"
else
  fail "monitor-ui-smoke.mjs: вид «Мониторинг» не прошёл проверки"
fi

section "итог"
if [ "$FAIL" -eq 0 ]; then
  echo "all UI smoke checks passed"
  exit 0
fi
echo "FAILED: $FAIL"
exit 1
