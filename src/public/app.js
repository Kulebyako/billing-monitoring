/* Server Billing — панель: hash-виды, рендер данных, действия.
   Ванильный JS без сборки и зависимостей. Данные экранируются через esc(). */

'use strict';

const hints = {
  landvps: 'BILLmanager: login + password. Base URL по умолчанию — my.landvps.ru/billmgr',
  vpsville: 'Email+password от vpsville.ru/login.php (форма «Войти в ЛК»). Баланс + дни до нуля → due.',
  hsvds: 'Email+password на hsvds.ru/login. Посуточный биллинг: due ≈ баланс / суточный расход (API /apiv1).',
  play2go: 'Биллинг play2go.cloud: email+password (не control-панель). Token ptlc_ — только game-серверы Pterodactyl, для VPS обычно пусто.',
  yun62: 'Login + password для 62yun.ru',
  kyonix:
    'Биллинг: email+password beta.kyonix.com (VDS, баланс, даты). Опционально те же креды для vm.kyonix.com (IP merge).',
};

const VIEW_TITLES = { overview: 'Обзор', services: 'Услуги', providers: 'Провайдеры' };
const STATE_TITLES = { ok: 'синхронизированы', failed: 'с ошибкой', never: 'не синхронизированы', off: 'выключены' };
const SERVICE_STATUS = {
  active: { label: 'активна', tone: 'ok', glyph: 'ok' },
  suspended: { label: 'приостановлена', tone: 'warn', glyph: 'warn' },
  deleted: { label: 'удалена', tone: 'danger', glyph: 'danger' },
  missing: { label: 'не найдена', tone: 'danger', glyph: 'danger' },
  unknown: { label: 'неизвестно', tone: 'neutral', glyph: 'pending' },
};
const NETWORK_ERROR_TEXT = 'Нет связи с сервером. Проверьте соединение и повторите попытку.';

const ICONS = {
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.6-4M4 5v6h6M4 13a8 8 0 0 0 14.6 4M20 19v-6h-6"/>',
  external:
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  monitor:
    '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  alert:
    '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
};

let dashboard = null;
let providers = [];
let providerMap = new Map();
let loading = false;
let currentState = '';
let dialogReturnFocus = null;
let pendingFocus = null;
let drawerOpen = false;

/* ── утилиты ─────────────────────────────────────────────────────────────── */

function api(path, opts = {}) {
  return fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  }).then(async (res) => {
    if (res.status === 401) {
      location.href = '/login';
      throw new Error('unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isBlank(v) {
  return v == null || v === '';
}

// Сетевой сбой fetch (TypeError: Failed to fetch) не должен показывать английский текст.
// Серверный { error } приходит обычным Error и показывается как есть.
function humanError(err) {
  if (!err) return NETWORK_ERROR_TEXT;
  if (err instanceof TypeError) return NETWORK_ERROR_TEXT;
  const message = String(err.message || err).trim();
  if (!message || /^(failed to fetch|networkerror|load failed|network request failed)$/i.test(message)) {
    return NETWORK_ERROR_TEXT;
  }
  return message;
}

function plural(n, forms) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

function parseDate(value) {
  if (isBlank(value)) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T12:00:00');
  const iso = s.includes('T') ? s : s.replace(' ', 'T');
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasZone ? iso : iso + 'Z');
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysUntil(dueAt) {
  const due = parseDate(dueAt);
  if (!due) return null;
  return Math.round((startOfDay(due) - startOfDay(new Date())) / 86400000);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatDayMonth(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
}

function formatDateTime(value) {
  const d = parseDate(value);
  if (!d) return '—';
  return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function relativeTime(value) {
  const d = parseDate(value);
  if (!d) return '—';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return formatDateTime(d);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, ['минуту', 'минуты', 'минут'])} назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`;
  return formatDateTime(d);
}

function currencySymbol(cur) {
  if (!cur) return '';
  if (cur === 'RUB') return '₽';
  return String(cur);
}

function money(v, cur) {
  if (isBlank(v)) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return esc(String(v));
  const text = n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const symbol = currencySymbol(cur);
  return symbol ? `${text}\u00a0${symbol}` : text;
}

function moneyRounded(v, cur) {
  if (isBlank(v)) return '—';
  const n = Number(v);
  const text = Number.isFinite(n) ? n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) : String(v);
  const symbol = currencySymbol(cur);
  return symbol ? `${text}\u00a0${symbol}` : text;
}

function daysLabel(n) {
  return `${n} д`;
}

function icon(name, size = 16) {
  const path = ICONS[name];
  if (!path) return '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

function inkGlyph(tone) {
  const filled = tone === 'ok' || tone === 'warn' || tone === 'danger' || tone === 'accent' || tone === 'progress';
  const cls = `glyph${tone && tone !== 'pending' ? ' glyph--' + tone : ''}`;
  if (tone === 'off') {
    return `<svg class="${cls}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="1.6 1.55"/></svg>`;
  }
  if (!filled) {
    return `<svg class="${cls}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  }
  return `<svg class="${cls}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="3.5" fill="currentColor"/></svg>`;
}

function badge(text, tone, glyphTone) {
  return `<span class="badge badge--${tone}">${glyphTone ? inkGlyph(glyphTone) : ''}${esc(text)}</span>`;
}

function avatarTone(id) {
  const s = String(id || '');
  let sum = 0;
  for (let i = 0; i < s.length; i += 1) sum += s.charCodeAt(i);
  return ['slate', 'ok', 'warn', 'danger'][sum % 4];
}

function providerLabel(id) {
  if (isBlank(id)) return '—';
  const p = providerMap.get(id);
  return p && p.label ? p.label : String(id);
}

function providerCell(row) {
  const label = providerLabel(row.provider);
  const tone = avatarTone(row.provider);
  const initial = (label.match(/[0-9A-Za-zА-Яа-я]/) || ['?'])[0];
  return `<span class="provider"><span class="avatar${tone === 'slate' ? '' : ' avatar--' + tone}" aria-hidden="true">${esc(initial)}</span><span class="provider-name" title="${esc(label)}">${esc(label)}</span></span>`;
}

function serviceStatus(s) {
  return SERVICE_STATUS[s && s.status] || SERVICE_STATUS.unknown;
}

function dueBadge(dueAt) {
  const d = daysUntil(dueAt);
  if (d == null) return '';
  if (d < 0) return `<span class="badge badge--danger">просрочено ${daysLabel(Math.abs(d))}</span>`;
  if (d === 0) return '<span class="badge badge--warn">сегодня</span>';
  if (d <= 7) return `<span class="badge badge--warn">через ${daysLabel(d)}</span>`;
  return `<span class="badge badge--neutral">через ${daysLabel(d)}</span>`;
}

function dueCell(dueAt) {
  if (isBlank(dueAt)) return { html: '<span class="dim">—</span>', empty: true };
  return {
    html: `<span class="due"><span class="due-date">${formatDate(dueAt)}</span>${dueBadge(dueAt)}</span>`,
    empty: false,
  };
}

function accountState(a) {
  if (!a || !a.enabled) return { key: 'off', label: 'выключен', tone: 'neutral', glyph: 'off' };
  if (a.lastError) return { key: 'failed', label: 'ошибка', tone: 'danger', glyph: 'danger' };
  if (!a.lastSyncedAt) return { key: 'never', label: 'не синхронизировался', tone: 'neutral', glyph: 'pending' };
  return { key: 'ok', label: 'синхронизировано', tone: 'ok', glyph: 'ok' };
}

function syncGroup(a) {
  return accountState(a).key;
}

function coverage(s) {
  const d = daysUntil(s.dueAt);
  if (d != null && d < 0) return { text: 'просрочено', tone: 'danger' };
  if (s.balance == null) return { text: 'баланс неизвестен', tone: 'warn' };
  if (s.cost != null && Number(s.balance) < Number(s.cost)) {
    return { text: `баланса не хватит: ${money(s.balance, s.currency)}`, tone: 'warn' };
  }
  return { text: 'покрыто балансом', tone: 'ok' };
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function calcMonthlyStats(services) {
  const now = new Date();
  const totalDays = daysInMonth(now);
  let totalMonthly = 0;
  let remainingMonthly = 0;
  for (const s of services || []) {
    if (!s.cost || s.status === 'missing' || s.status === 'deleted') continue;
    const daily = s.cost / 30;
    totalMonthly += s.cost;
    const daysLeft = totalDays - now.getDate() + 1;
    remainingMonthly += daily * daysLeft;
  }
  return {
    totalMonthly: Math.round(totalMonthly),
    remainingMonthly: Math.round(remainingMonthly),
  };
}

/* ── состояния загрузки/ошибки/тостов ────────────────────────────────────── */

function announce(text) {
  const live = document.getElementById('live');
  if (live) live.textContent = text;
}

function setBusy(busy) {
  for (const id of ['summary', 'chart-weekly', 'services', 'accounts']) {
    const el = document.getElementById(id);
    if (el) {
      if (busy) el.setAttribute('aria-busy', 'true');
      else el.removeAttribute('aria-busy');
    }
  }
  // Во время загрузки счётчики не должны читаться как «данных нет».
  if (busy) {
    document.querySelectorAll('.count').forEach((el) => {
      el.textContent = '—';
    });
  }
}

function showError(message) {
  const banner = document.getElementById('app-error');
  const text = banner.querySelector('[data-error-text]');
  if (text) text.textContent = message || 'Неизвестная ошибка';
  banner.hidden = false;
}

function hideError() {
  const banner = document.getElementById('app-error');
  if (banner) banner.hidden = true;
}

function showToast(kind, message) {
  const stack = document.getElementById('toast');
  while (stack.children.length >= 3) stack.removeChild(stack.firstElementChild);
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : ''}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span class="toast-text">${esc(message)}</span><button class="icon-btn icon-btn--sm toast-close" type="button" aria-label="Закрыть">${icon('x', 14)}</button>`;
  stack.appendChild(el);
  const remove = () => el.remove();
  el.querySelector('.toast-close').addEventListener('click', remove);
  if (kind !== 'error') setTimeout(remove, 4000);
}

function emptyState(title, text, actionHtml) {
  return `<div class="empty"><span class="empty-icon">${icon('monitor', 18)}</span><p class="empty-title">${esc(title)}</p><p class="empty-text">${esc(text)}</p>${actionHtml || ''}</div>`;
}

function tableEmptyRow(colspan, html) {
  return `<tr role="row"><td role="cell" class="td-empty-state" colspan="${colspan}">${html}</td></tr>`;
}

function focusPending() {
  if (!pendingFocus) return;
  const el = document.querySelector(pendingFocus);
  pendingFocus = null;
  if (el) el.focus();
}

/* ── рендер: сводка ──────────────────────────────────────────────────────── */

function attentionText(n) {
  if (n === 0) return 'Все услуги в порядке';
  const word = plural(n, ['услуга', 'услуги', 'услуг']);
  const verb = n % 10 === 1 && n % 100 !== 11 ? 'требует' : 'требуют';
  return `${n} ${word} ${verb} внимания`;
}

// Одно и то же дедуплицированное множество для hero-строки и карточки «Требуют внимания».
function attentionServices(d) {
  if (!d) return [];
  const seen = new Map();
  for (const s of [...(d.urgent || []), ...(d.lowBalance || [])]) {
    if (s && !seen.has(s.id)) seen.set(s.id, s);
  }
  return [...seen.values()].sort((a, b) => {
    const da = parseDate(a.dueAt);
    const db = parseDate(b.dueAt);
    return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
  });
}

function renderSummary(d) {
  const el = document.getElementById('summary');
  if (!el) return;
  if (!d) {
    el.innerHTML = emptyState('Данные не загружены', 'Проверьте соединение и повторите попытку.');
    el.removeAttribute('aria-busy');
    return;
  }
  const stats = calcMonthlyStats(d.services);
  const urgent = d.urgent || [];
  const low = d.lowBalance || [];
  const attention = attentionServices(d);
  const errors = d.syncErrors || [];
  const services = d.services || [];
  const upcoming = services
    .filter((s) => !isBlank(s.dueAt) && s.status !== 'missing' && s.status !== 'deleted')
    .sort((a, b) => {
      const da = parseDate(a.dueAt);
      const db = parseDate(b.dueAt);
      return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
    })
    .slice(0, 4);
  const upcomingSums = new Map();
  for (const s of upcoming) {
    const key = s.currency || '';
    upcomingSums.set(key, (upcomingSums.get(key) || 0) + (Number(s.cost) || 0));
  }
  const sumsText = [...upcomingSums.entries()]
    .map(([cur, value]) => moneyRounded(value, cur))
    .join(', ');
  const upcomingRows = upcoming.length
    ? upcoming
        .map((s) => {
          const cov = coverage(s);
          return `<li class="upcoming-row"><span class="upcoming-date">${formatDayMonth(s.dueAt)}</span>${inkGlyph(cov.tone)}<span class="upcoming-name" title="${esc(s.name)}">${esc(s.name)}</span><span class="upcoming-amount">${money(s.cost, s.currency)}</span></li>`;
        })
        .join('')
    : '<li class="upcoming-empty muted">Платежей в ближайшие 30 дней нет</li>';

  el.innerHTML = `
    <div class="summary-top">
      <div class="summary-main">
        <h2 class="summary-label">Расход в месяц</h2>
        <p class="attention-line">${inkGlyph(attention.length ? 'warn' : 'ok')}<span>${esc(attentionText(attention.length))}</span></p>
        <p class="figure">${Number(stats.totalMonthly).toLocaleString('ru-RU')}<span class="currency">₽</span></p>
        <p class="meta-line">≈ ${moneyRounded(stats.totalMonthly * 12, 'RUB')} в год · доплатить ${moneyRounded(stats.remainingMonthly, 'RUB')}</p>
      </div>
      <div class="upcoming">
        <div class="upcoming-head">
          <h3 class="upcoming-title">Ближайшие платежи</h3>
          <span class="upcoming-meta">${upcoming.length} из ${services.length} · ${sumsText || '—'}</span>
        </div>
        <ul class="upcoming-list">${upcomingRows}</ul>
      </div>
    </div>
    <div class="kpi">
      <div><p class="kpi-label">Срок ≤ 7 дней</p><p class="kpi-value${urgent.length ? ' is-warn' : ''}">${urgent.length}</p></div>
      <div><p class="kpi-label">Низкий баланс</p><p class="kpi-value${low.length ? ' is-warn' : ''}">${low.length}</p></div>
      <div><p class="kpi-label">Ошибки синхронизации</p><p class="kpi-value ${errors.length ? 'is-danger' : 'is-ok'}">${errors.length}</p></div>
      <div><p class="kpi-label">Всего услуг</p><p class="kpi-value">${services.length}</p></div>
    </div>`;
  el.removeAttribute('aria-busy');
}

/* ── рендер: график ──────────────────────────────────────────────────────── */

function weekSeries(services) {
  const today = startOfDay(new Date());
  const buckets = [];
  for (let i = 0; i < 6; i += 1) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i * 7);
    buckets.push({ start, sums: new Map(), count: 0, amount: 0 });
  }
  for (const s of services || []) {
    if (!s || s.status === 'missing' || s.status === 'deleted') continue;
    if (isBlank(s.dueAt) || s.cost == null) continue;
    const due = parseDate(s.dueAt);
    if (!due) continue;
    const diffDays = Math.round((startOfDay(due) - today) / 86400000);
    const idx = diffDays < 0 ? 0 : Math.floor(diffDays / 7);
    if (idx < 0 || idx > 5) continue;
    const bucket = buckets[idx];
    const key = s.currency || '';
    bucket.sums.set(key, (bucket.sums.get(key) || 0) + Number(s.cost || 0));
    bucket.amount += Number(s.cost || 0);
    bucket.count += 1;
  }
  return buckets;
}

function sumsText(map) {
  const entries = [...map.entries()];
  if (!entries.length) return '—';
  return entries.map(([cur, value]) => moneyRounded(value, cur)).join(', ');
}

function renderChart(d) {
  const el = document.getElementById('chart-weekly');
  const metaEl = document.getElementById('chart-meta');
  if (!el) return;
  if (!d) {
    if (metaEl) metaEl.textContent = '—';
    el.innerHTML = emptyState('Данные не загружены', 'Нажмите «Повторить» в баннере выше.');
    el.removeAttribute('aria-busy');
    return;
  }
  const buckets = weekSeries(d.services);
  const totalAmount = buckets.reduce((sum, b) => sum + b.amount, 0);
  const totalCount = buckets.reduce((sum, b) => sum + b.count, 0);
  const totals = new Map();
  for (const b of buckets) for (const [cur, value] of b.sums) totals.set(cur, (totals.get(cur) || 0) + value);
  if (metaEl) metaEl.textContent = `${totalCount} ${plural(totalCount, ['платёж', 'платежа', 'платежей'])} · ${sumsText(totals)}`;
  if (!totalCount) {
    el.innerHTML = emptyState('Платежей нет', 'В ближайшие 6 недель платежей по услугам не ожидается.');
    el.removeAttribute('aria-busy');
    return;
  }
  const max = Math.max(...buckets.map((b) => b.amount), 1);
  const maxIdx = buckets.findIndex((b) => b.amount === max);
  // На узких экранах геометрия графика компактнее, иначе подписи недель нечитаемы.
  const narrow = window.innerWidth < 640;
  const W = narrow ? 360 : 720;
  const H = narrow ? 150 : 168;
  const baseY = narrow ? 104 : 120;
  const maxH = narrow ? 84 : 112;
  const slotW = narrow ? 52 : 112;
  const barW = narrow ? 8 : 10;
  const startX = 24;
  const label = `Платежи в ближайшие 6 недель: всего ${sumsText(totals)}, максимум ${sumsText(buckets[maxIdx].sums)} за неделю ${maxIdx + 1}`;
  let svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
  svg += `<line class="chart-base" x1="${startX}" y1="${baseY}" x2="${startX + slotW * 6}" y2="${baseY}"/>`;
  buckets.forEach((b, i) => {
    const cx = startX + i * slotW + slotW / 2;
    if (b.amount > 0) {
      const h = Math.max(3, Math.round((b.amount / max) * maxH));
      const title = `неделя ${i + 1}: ${sumsText(b.sums)}, ${b.count} ${plural(b.count, ['платёж', 'платежа', 'платежей'])}`;
      svg += `<rect class="chart-bar" x="${cx - barW / 2}" y="${baseY - h}" width="${barW}" height="${h}" rx="2"><title>${esc(title)}</title></rect>`;
    }
    svg += `<text class="chart-label" x="${cx}" y="${baseY + 26}" text-anchor="middle">${formatDayMonth(b.start)}</text>`;
  });
  svg += '</svg>';
  el.innerHTML = `${svg}<p class="chart-caption">Столбик — сумма к оплате за неделю. Итог: ${sumsText(totals)} за 6 недель.</p>`;
  el.removeAttribute('aria-busy');
}

/* ── рендер: «Требуют внимания» ──────────────────────────────────────────── */

function renderAttention(d) {
  const tbody = document.getElementById('attention');
  const countEl = document.getElementById('attention-count');
  if (!tbody) return;
  if (!d) {
    if (countEl) countEl.textContent = '—';
    tbody.innerHTML = tableEmptyRow(4, emptyState('Данные не загружены', 'Нажмите «Повторить» в баннере выше.'));
    return;
  }
  const all = attentionServices(d);
  if (countEl) countEl.textContent = String(all.length);
  if (!all.length) {
    const next = (d.services || [])
      .filter((s) => !isBlank(s.dueAt))
      .sort((a, b) => {
        const da = parseDate(a.dueAt);
        const db = parseDate(b.dueAt);
        return (da ? da.getTime() : Infinity) - (db ? db.getTime() : Infinity);
      })[0];
    const text = next ? `Всё оплачено — ближайший платёж ${formatDate(next.dueAt)}` : 'Платежей нет';
    tbody.innerHTML = tableEmptyRow(4, `<p class="empty-text attention-empty">${esc(text)}</p>`);
    return;
  }
  tbody.innerHTML = all
    .slice(0, 5)
    .map((s) => {
      const dLeft = daysUntil(s.dueAt);
      const cov = coverage(s);
      const overdue = dLeft != null && dLeft < 0;
      const due = dueCell(s.dueAt);
      return `<tr role="row"${overdue ? ' class="is-fail"' : ''}>
        <td role="cell" data-label="Услуга" class="cell-name"><div class="name-cell">${providerCell(s)}<span class="truncate" title="${esc(s.name)}">${esc(s.name)}</span></div></td>
        <td role="cell" data-label="Покрытие"><span class="cov cov--${cov.tone}">${esc(cov.text)}</span></td>
        <td role="cell" data-label="Когда">${due.html}</td>
        <td role="cell" data-label="Сумма" class="num">${money(s.cost, s.currency)}</td>
      </tr>`;
    })
    .join('');
}

/* ── рендер: услуги ──────────────────────────────────────────────────────── */

function serviceRow(s) {
  const due = dueCell(s.dueAt);
  const status = serviceStatus(s);
  const billing = s.billingUrl
    ? `<a class="billing-link" href="${esc(s.billingUrl)}" target="_blank" rel="noopener noreferrer">биллинг ${icon('external', 12)}</a>`
    : '';
  const costBlank = isBlank(s.cost);
  const balanceBlank = isBlank(s.balance);
  const ipBlank = isBlank(s.ip);
  const tagBlank = isBlank(s.tag);
  const notesBlank = isBlank(s.notes);
  return `<tr role="row">
    <td role="cell" data-label="Провайдер">${providerCell(s)}</td>
    <td role="cell" data-label="Имя" class="cell-name"><div class="name-cell"><span class="truncate" title="${esc(s.name)}">${esc(s.name)}</span>${billing ? `<span class="billing-row">${billing}</span>` : ''}</div></td>
    <td role="cell" data-label="IP" class="cell-ip"${ipBlank ? ' data-empty' : ''}>${ipBlank ? '<span class="dim">—</span>' : esc(s.ip)}</td>
    <td role="cell" data-label="До"${due.empty ? ' data-empty' : ''}>${due.html}</td>
    <td role="cell" data-label="Стоимость" class="num"${costBlank ? ' data-empty' : ''}>${money(s.cost, s.currency)}</td>
    <td role="cell" data-label="Баланс" class="num"${balanceBlank ? ' data-empty' : ''}>${money(s.balance, s.currency)}</td>
    <td role="cell" data-label="Статус" class="cell-status">${badge(status.label, status.tone, status.glyph)}</td>
    <td role="cell" data-label="Тег"${tagBlank ? ' data-empty' : ''}>${tagBlank ? '<span class="dim">—</span>' : badge(s.tag, 'neutral')}</td>
    <td role="cell" data-label="Заметка" class="cell-notes"${notesBlank ? ' data-empty' : ''}>${notesBlank ? '<span class="dim">—</span>' : `<span class="truncate" title="${esc(s.notes)}">${esc(s.notes)}</span>`}</td>
    <td role="cell" data-label="Действия" data-actions><button class="btn btn--ghost btn--sm" type="button" data-edit="${esc(s.id)}">Тег</button></td>
  </tr>`;
}

function renderServices(services) {
  const tbody = document.querySelector('#services tbody');
  if (!tbody) return;
  const providerEl = document.getElementById('filter-provider');
  const tagEl = document.getElementById('filter-tag');
  const resetEl = document.getElementById('filter-reset');
  const countEl = document.getElementById('services-count');
  const provider = providerEl ? providerEl.value : '';
  const tag = tagEl ? tagEl.value : '';
  if (resetEl) resetEl.hidden = !(provider || tag);
  if (!Array.isArray(services)) {
    if (countEl) countEl.textContent = '—';
    tbody.innerHTML = tableEmptyRow(10, emptyState('Данные не загружены', 'Нажмите «Повторить» в баннере выше.'));
    return;
  }
  const rows = services.filter((s) => {
    if (provider && s.provider !== provider) return false;
    if (tag && s.tag !== tag) return false;
    return true;
  });
  if (countEl) countEl.textContent = String(rows.length);
  if (!rows.length) {
    const filtered = Boolean(provider || tag);
    const action = filtered
      ? '<button class="btn btn--outline btn--sm" type="button" data-reset-filters>Сбросить фильтры</button>'
      : '';
    tbody.innerHTML = tableEmptyRow(
      10,
      filtered
        ? emptyState('Ничего не найдено', 'Измените фильтр или сбросьте его.', action)
        : emptyState('Услуг пока нет', 'Добавьте аккаунт провайдера — при синхронизации услуги появятся здесь.', '<a class="btn btn--outline btn--sm" href="#/providers">Добавить аккаунт</a>'),
    );
    return;
  }
  tbody.innerHTML = rows.map(serviceRow).join('');
}

/* ── рендер: аккаунты и сайдбар ──────────────────────────────────────────── */

function accountRow(a) {
  const state = accountState(a);
  const label = isBlank(a.label) ? '<span class="dim">—</span>' : esc(a.label);
  const offBadge = a.enabled ? '' : ' <span class="badge badge--neutral">выключен</span>';
  const synced = isBlank(a.lastSyncedAt)
    ? '<span class="dim">—</span>'
    : `<span title="${esc(formatDateTime(a.lastSyncedAt))}">${esc(relativeTime(a.lastSyncedAt))}</span>`;
  const error = isBlank(a.lastError)
    ? '<span class="dim">—</span>'
    : `<span class="truncate" title="${esc(a.lastError)}">${esc(a.lastError)}</span>`;
  return `<tr role="row"${a.lastError ? ' class="is-fail"' : ''}>
    <td role="cell" data-label="Провайдер">${providerCell(a)}</td>
    <td role="cell" data-label="Метка"${isBlank(a.label) ? ' data-empty' : ''}>${label}${offBadge}</td>
    <td role="cell" data-label="ID" class="num mono">${esc(a.id)}</td>
    <td role="cell" data-label="Синхронизация"${isBlank(a.lastSyncedAt) ? ' data-empty' : ''}>${synced}</td>
    <td role="cell" data-label="Статус" class="cell-status">${badge(state.label, state.tone, state.glyph)}</td>
    <td role="cell" data-label="Ошибка" class="cell-error"${isBlank(a.lastError) ? ' data-empty' : ''}>${error}</td>
    <td role="cell" data-label="Действия" data-actions><span class="row-actions"><button class="btn btn--ghost btn--sm" type="button" data-sync="${esc(a.id)}">Sync</button><button class="btn btn--danger-ghost btn--sm" type="button" data-del="${esc(a.id)}">Удалить</button></span></td>
  </tr>`;
}

function renderAccounts(accounts, state) {
  const tbody = document.querySelector('#accounts tbody');
  if (!tbody) return;
  const countEl = document.getElementById('accounts-count');
  if (!Array.isArray(accounts)) {
    if (countEl) countEl.textContent = '—';
    tbody.innerHTML = tableEmptyRow(7, emptyState('Данные не загружены', 'Нажмите «Повторить» в баннере выше.'));
    return;
  }
  const rows = state ? accounts.filter((a) => syncGroup(a) === state) : accounts;
  if (countEl) countEl.textContent = String(rows.length);
  if (!rows.length) {
    tbody.innerHTML = tableEmptyRow(
      7,
      state
        ? emptyState('Ничего не найдено', 'Аккаунтов с таким состоянием синхронизации нет.', '<a class="btn btn--outline btn--sm" href="#/providers">Показать все аккаунты</a>')
        : emptyState('Нет подключённых аккаунтов', 'Добавьте первый аккаунт провайдера ниже.'),
    );
    return;
  }
  tbody.innerHTML = rows.map(accountRow).join('');
}

function renderSidebar(d) {
  if (!d) return;
  const counts = { ok: 0, failed: 0, never: 0, off: 0 };
  for (const a of d.accounts || []) counts[syncGroup(a)] += 1;
  document.querySelectorAll('[data-count]').forEach((el) => {
    const key = el.getAttribute('data-count');
    el.textContent = String(counts[key] || 0);
  });
  const stats = calcMonthlyStats(d.services);
  const total = stats.totalMonthly;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(((total - stats.remainingMonthly) / total) * 100))) : 0;
  const meter = document.getElementById('paid-meter');
  if (meter) {
    const pctEl = meter.querySelector('[data-meter-pct]');
    const bar = meter.querySelector('[data-meter-bar]');
    const track = meter.querySelector('.meter-track');
    if (pctEl) pctEl.textContent = total > 0 ? `${pct}%` : '—';
    if (bar) bar.style.width = `${pct}%`;
    if (track) track.setAttribute('aria-valuenow', String(pct));
  }
}

/* ── загрузка и общий рендер ─────────────────────────────────────────────── */

function fillProviders(list) {
  providers = Array.isArray(list) ? list : [];
  providerMap = new Map(providers.map((p) => [p.id, p]));
  const select = document.getElementById('provider-select');
  const filter = document.getElementById('filter-provider');
  if (select) {
    const value = select.value;
    select.innerHTML = providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    if (value) select.value = value;
  }
  if (filter) {
    // Фильтр показывает и провайдеров из meta, и всех, кто реально есть в услугах:
    // так фильтр не теряет услуги провайдера, которого нет в списке адаптеров.
    const seen = new Set(providers.map((p) => p.id));
    const extra = [];
    for (const s of (dashboard && dashboard.services) || []) {
      if (s.provider && !seen.has(s.provider)) {
        seen.add(s.provider);
        extra.push({ id: s.provider, label: s.provider });
      }
    }
    const value = filter.value;
    filter.innerHTML =
      '<option value="">Все провайдеры</option>' +
      [...providers, ...extra].map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
    if (value) filter.value = value;
  }
  updateHint();
}

function updateHint() {
  const select = document.getElementById('provider-select');
  const hint = document.getElementById('provider-hint');
  if (!select || !hint) return;
  hint.textContent = hints[select.value] || '';
}

function renderSkeletonTables() {
  const cell = (cols) => `<tr role="row"><td role="cell" class="skeleton-cell" colspan="${cols}"><span class="skeleton-block skeleton-block--row"></span></td></tr>`;
  const services = document.querySelector('#services tbody');
  const accounts = document.querySelector('#accounts tbody');
  const attention = document.getElementById('attention');
  if (services) services.innerHTML = Array.from({ length: 6 }, () => cell(10)).join('');
  if (accounts) accounts.innerHTML = Array.from({ length: 3 }, () => cell(7)).join('');
  if (attention) attention.innerHTML = Array.from({ length: 2 }, () => cell(4)).join('');
}

function renderAll(d) {
  renderSummary(d);
  renderChart(d);
  renderAttention(d);
  renderServices(d ? d.services : null);
  renderAccounts(d ? d.accounts : null, currentState);
  renderSidebar(d);
  setBusy(false);
  focusPending();
}

function renderFatal() {
  renderAll(null);
}

async function load(options = {}) {
  if (loading) return;
  loading = true;
  const first = !dashboard;
  const skeleton = options.skeleton !== undefined ? options.skeleton : first;
  if (skeleton) {
    setBusy(true);
    renderSkeletonTables();
    announce('Загрузка данных…');
  }
  try {
    const [d, m] = await Promise.all([api('/dashboard'), api('/meta')]);
    dashboard = d;
    fillProviders(m && m.providers);
    renderAll(d);
    hideError();
    announce('Данные обновлены');
  } catch (err) {
    if (err && err.message === 'unauthorized') return;
    showError(humanError(err) || 'Не удалось загрузить данные');
    if (!dashboard) renderFatal();
    else setBusy(false);
  } finally {
    loading = false;
  }
}

/* ── hash-навигация ──────────────────────────────────────────────────────── */

function parseHash() {
  const raw = String(location.hash || '').replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const view = Object.prototype.hasOwnProperty.call(VIEW_TITLES, path) ? path : 'overview';
  const params = new URLSearchParams(query || '');
  const stateParam = params.get('state');
  const state = view === 'providers' && ['ok', 'failed', 'never', 'off'].includes(stateParam) ? stateParam : '';
  return { view, state, known: Object.prototype.hasOwnProperty.call(VIEW_TITLES, path) };
}

function applyRoute() {
  const route = parseHash();
  if (!route.known) {
    try {
      history.replaceState(null, '', '#/overview');
    } catch (err) {
      location.hash = '#/overview';
    }
  }
  currentState = route.state;
  document.querySelectorAll('[data-view-panel]').forEach((el) => {
    el.hidden = el.getAttribute('data-view-panel') !== route.view;
  });
  const crumb = VIEW_TITLES[route.view] + (route.state ? ` · ${STATE_TITLES[route.state]}` : '');
  const crumbEl = document.getElementById('breadcrumb');
  if (crumbEl) crumbEl.textContent = crumb;
  document.title = `${crumb} — Server Billing`;
  document.querySelectorAll('.nav-item').forEach((a) => {
    const state = a.getAttribute('data-state') || '';
    const match = a.getAttribute('data-view') === route.view && state === route.state;
    if (match) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (route.view === 'providers' && dashboard) renderAccounts(dashboard.accounts, route.state);
}

/* ── диалоги ─────────────────────────────────────────────────────────────── */

function openDialog(dlg, opener) {
  dialogReturnFocus = opener || null;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function bindCloseButtons() {
  document.querySelectorAll('dialog [data-close]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dlg = btn.closest('dialog');
      if (dlg) dlg.close();
    });
  });
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('close', () => {
      const target = dialogReturnFocus;
      dialogReturnFocus = null;
      if (target && document.contains(target)) target.focus();
    });
  });
}

function showDialogError(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

/* ── действия ────────────────────────────────────────────────────────────── */

function setSyncBusy(busy) {
  const btn = document.getElementById('btn-sync');
  if (!btn) return;
  const label = btn.querySelector('.sync-label');
  const iconWrap = btn.querySelector('.sync-icon');
  if (busy) {
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-label', 'Синхронизация…');
    if (label) label.textContent = 'Синхронизация…';
    if (iconWrap) iconWrap.innerHTML = inkGlyph('progress');
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.setAttribute('aria-label', 'Синхронизировать всё');
    if (label) label.textContent = 'Синхронизировать всё';
    if (iconWrap) iconWrap.innerHTML = icon('refresh', 16);
  }
}

async function syncAllAction() {
  const btn = document.getElementById('btn-sync');
  if (!btn || btn.disabled) return;
  setSyncBusy(true);
  announce('Синхронизация…');
  try {
    const result = await api('/sync', { method: 'POST' });
    const results = Array.isArray(result.results) ? result.results : [];
    const okCount = results.filter((r) => r.ok).length;
    const errorCount = results.filter((r) => !r.ok).length;
    const message = `Синхронизировано: ${okCount} ${plural(okCount, ['аккаунт', 'аккаунта', 'аккаунтов'])}, ${errorCount} ${plural(errorCount, ['ошибка', 'ошибки', 'ошибок'])}`;
    showToast(errorCount ? 'error' : 'success', message);
    await load({ skeleton: false });
  } catch (err) {
    showToast('error', `Синхронизация не удалась: ${humanError(err)}`);
  } finally {
    setSyncBusy(false);
  }
}

async function syncAccountAction(button) {
  const id = button.getAttribute('data-sync');
  if (!id || button.disabled) return;
  button.disabled = true;
  try {
    const result = await api(`/accounts/${id}/sync`, { method: 'POST' });
    const count = Number(result && result.count) || 0;
    showToast('success', `Синхронизировано услуг: ${count}`);
    await load({ skeleton: false });
  } catch (err) {
    showToast('error', `Синхронизация не удалась: ${humanError(err)}`);
    // Ошибка sync сохраняется в аккаунте на сервере — перерисовываем строку.
    await load({ skeleton: false });
  } finally {
    button.disabled = false;
  }
}

function openDeleteDialog(button) {
  const id = button.getAttribute('data-del');
  const account = dashboard && (dashboard.accounts || []).find((a) => String(a.id) === String(id));
  const dlg = document.getElementById('confirm-dlg');
  const text = document.getElementById('confirm-text');
  if (!dlg || !id) return;
  showDialogError('confirm-error', '');
  if (text) {
    const label = account && account.label ? account.label : `#${id}`;
    text.textContent = `Аккаунт «${label}» и его услуги будут удалены. Это действие нельзя отменить.`;
  }
  dlg.setAttribute('data-account-id', String(id));
  openDialog(dlg, button);
}

async function confirmDelete() {
  const dlg = document.getElementById('confirm-dlg');
  const okBtn = document.getElementById('confirm-ok');
  if (!dlg || !okBtn) return;
  const id = dlg.getAttribute('data-account-id');
  if (!id) return;
  okBtn.disabled = true;
  showDialogError('confirm-error', '');
  try {
    await api(`/accounts/${id}`, { method: 'DELETE' });
    dlg.close();
    showToast('success', 'Аккаунт удалён');
    await load({ skeleton: false });
  } catch (err) {
    showDialogError('confirm-error', `Не удалось удалить: ${humanError(err)}`);
  } finally {
    okBtn.disabled = false;
  }
}

function openEditDialog(button) {
  const id = button.getAttribute('data-edit');
  const service = dashboard && (dashboard.services || []).find((s) => String(s.id) === String(id));
  const dlg = document.getElementById('edit-dlg');
  const form = document.getElementById('edit-form');
  if (!dlg || !form || !service) return;
  const sub = document.getElementById('edit-sub');
  if (sub) sub.textContent = `Услуга: ${service.name}`;
  form.elements.id.value = service.id;
  form.elements.tag.value = service.tag || '';
  form.elements.notes.value = service.notes || '';
  showDialogError('edit-error', '');
  openDialog(dlg, button);
  const tag = form.elements.tag;
  if (tag && typeof tag.focus === 'function') tag.focus();
}

async function saveEdit(event) {
  event.preventDefault();
  const form = document.getElementById('edit-form');
  const dlg = document.getElementById('edit-dlg');
  const save = document.getElementById('edit-save');
  if (!form || !dlg || !save) return;
  const id = form.elements.id.value;
  save.disabled = true;
  showDialogError('edit-error', '');
  try {
    await api(`/services/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ tag: form.elements.tag.value, notes: form.elements.notes.value }),
    });
    pendingFocus = `[data-edit="${id}"]`;
    dlg.close();
    showToast('success', 'Изменения сохранены');
    await load({ skeleton: false });
  } catch (err) {
    showDialogError('edit-error', `Не удалось сохранить: ${humanError(err)}`);
  } finally {
    save.disabled = false;
  }
}

async function addAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const errorEl = document.getElementById('add-account-error');
  const providerField = form.elements.provider;
  const provider = providerField.value;
  if (!provider) {
    showDialogError('add-account-error', 'Выберите провайдера');
    providerField.setAttribute('aria-invalid', 'true');
    providerField.setAttribute('aria-describedby', 'add-account-error');
    providerField.focus();
    return;
  }
  providerField.removeAttribute('aria-invalid');
  providerField.removeAttribute('aria-describedby');
  if (errorEl) errorEl.hidden = true;
  const submitText = submit ? submit.textContent : '';
  if (submit) {
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Сохранение…';
  }
  const fd = new FormData(form);
  const body = {
    provider,
    label: fd.get('label') || undefined,
    baseUrl: fd.get('baseUrl') || undefined,
    login: fd.get('login') || undefined,
    password: fd.get('password') || undefined,
    token: fd.get('token') || undefined,
  };
  try {
    await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
    form.removeAttribute('aria-invalid');
    form.removeAttribute('aria-describedby');
    const keepProvider = provider;
    form.reset();
    if (form.elements.provider) form.elements.provider.value = keepProvider;
    updateHint();
    showToast('success', 'Аккаунт добавлен');
    await load({ skeleton: false });
  } catch (err) {
    showDialogError('add-account-error', humanError(err) || 'Не удалось добавить аккаунт');
    form.setAttribute('aria-invalid', 'true');
    form.setAttribute('aria-describedby', 'add-account-error');
  } finally {
    if (submit) {
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = submitText || 'Сохранить аккаунт';
    }
  }
}

async function logout() {
  try {
    await api('/logout', { method: 'POST' });
    location.href = '/login';
  } catch (err) {
    showToast('error', `Не удалось выйти: ${humanError(err)}`);
  }
}

/* ── drawer (сайдбар < 1024) ─────────────────────────────────────────────── */

const desktopMq = window.matchMedia('(min-width: 1024px)');

function applyDrawer(open) {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const btn = document.getElementById('drawer-btn');
  const appMain = document.getElementById('app-main');
  if (!sidebar || !btn || !appMain) return;
  drawerOpen = open;
  sidebar.setAttribute('data-open', open ? 'true' : 'false');
  btn.setAttribute('aria-expanded', String(open));
  if (scrim) scrim.hidden = !open || desktopMq.matches;
  document.body.classList.toggle('drawer-open', open);
  if (desktopMq.matches) {
    sidebar.removeAttribute('inert');
    sidebar.removeAttribute('aria-hidden');
    appMain.removeAttribute('inert');
    return;
  }
  if (open) {
    sidebar.removeAttribute('inert');
    sidebar.removeAttribute('aria-hidden');
    appMain.setAttribute('inert', '');
  } else {
    sidebar.setAttribute('inert', '');
    sidebar.setAttribute('aria-hidden', 'true');
    appMain.removeAttribute('inert');
  }
}

function openDrawer() {
  applyDrawer(true);
  const first = document.querySelector('#sidebar a[href], #sidebar button');
  if (first) first.focus();
}

function closeDrawer(restoreFocus = true) {
  if (!drawerOpen) return;
  applyDrawer(false);
  const btn = document.getElementById('drawer-btn');
  if (restoreFocus && btn && !desktopMq.matches) btn.focus();
}

function trapFocus(event) {
  if (!drawerOpen || event.key !== 'Tab') return;
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const focusables = [...sidebar.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ── инициализация ───────────────────────────────────────────────────────── */

function init() {
  bindCloseButtons();

  document.getElementById('btn-sync').addEventListener('click', syncAllAction);
  document.getElementById('btn-logout').addEventListener('click', logout);
  document.getElementById('drawer-btn').addEventListener('click', () => {
    if (drawerOpen) closeDrawer();
    else openDrawer();
  });
  const scrim = document.getElementById('scrim');
  if (scrim) scrim.addEventListener('click', () => closeDrawer());

  const providerSelect = document.getElementById('provider-select');
  if (providerSelect) providerSelect.addEventListener('change', updateHint);

  const filterProvider = document.getElementById('filter-provider');
  const filterTag = document.getElementById('filter-tag');
  if (filterProvider) filterProvider.addEventListener('change', () => renderServices(dashboard ? dashboard.services : null));
  if (filterTag) filterTag.addEventListener('change', () => renderServices(dashboard ? dashboard.services : null));
  const reset = document.getElementById('filter-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      if (filterProvider) filterProvider.value = '';
      if (filterTag) filterTag.value = '';
      renderServices(dashboard ? dashboard.services : null);
    });
  }

  const servicesTable = document.getElementById('services');
  if (servicesTable) {
    servicesTable.addEventListener('click', (event) => {
      const editBtn = event.target.closest('[data-edit]');
      if (editBtn) {
        openEditDialog(editBtn);
        return;
      }
      if (event.target.closest('[data-reset-filters]')) {
        if (filterProvider) filterProvider.value = '';
        if (filterTag) filterTag.value = '';
        renderServices(dashboard ? dashboard.services : null);
      }
    });
  }

  const accountsTable = document.getElementById('accounts');
  if (accountsTable) {
    accountsTable.addEventListener('click', (event) => {
      const syncBtn = event.target.closest('[data-sync]');
      if (syncBtn) syncAccountAction(syncBtn);
      const delBtn = event.target.closest('[data-del]');
      if (delBtn) openDeleteDialog(delBtn);
    });
  }

  const editForm = document.getElementById('edit-form');
  if (editForm) editForm.addEventListener('submit', saveEdit);
  const confirmOk = document.getElementById('confirm-ok');
  if (confirmOk) confirmOk.addEventListener('click', confirmDelete);
  const confirmCancel = document.getElementById('confirm-cancel');
  if (confirmCancel) {
    confirmCancel.addEventListener('click', () => {
      const dlg = document.getElementById('confirm-dlg');
      if (dlg) dlg.close();
    });
  }

  const addForm = document.getElementById('add-account');
  if (addForm) addForm.addEventListener('submit', addAccount);

  document.querySelectorAll('.nav-item').forEach((link) => {
    link.addEventListener('click', () => closeDrawer());
  });

  const skip = document.querySelector('.skip-link');
  if (skip) {
    skip.addEventListener('click', (event) => {
      event.preventDefault();
      const main = document.getElementById('main');
      if (main) {
        main.focus();
        main.scrollIntoView({ block: 'start' });
      }
    });
  }

  const retry = document.getElementById('app-error-retry');
  if (retry) retry.addEventListener('click', () => load({ skeleton: !dashboard }));

  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.addEventListener('keydown', trapFocus);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drawerOpen) closeDrawer();
  });
  const onViewportChange = () => {
    if (desktopMq.matches) {
      applyDrawer(false);
    } else if (!drawerOpen) {
      applyDrawer(false);
    }
  };
  if (typeof desktopMq.addEventListener === 'function') desktopMq.addEventListener('change', onViewportChange);
  applyDrawer(false);

  window.addEventListener('hashchange', applyRoute);
  applyRoute();
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
