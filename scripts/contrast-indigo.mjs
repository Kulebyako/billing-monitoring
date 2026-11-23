#!/usr/bin/env node
// Пересчёт контраста итогового CSS панели (палитра «Индиго»).
// Читает :root из src/public/style.css — то есть проверяет именно то, что уходит в бой,
// а не отдельный файл концепции. Формула WCAG 2.1 AA: 4.5:1 для текста, 3:1 для UI.
//
// Запуск из корня репозитория: node scripts/contrast-indigo.mjs
// Код возврата 1, если хотя бы одна пара ниже порога.

import fs from 'node:fs';

const css = fs.readFileSync('src/public/style.css', 'utf8');
const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
if (!root) {
  console.error('не найден блок :root в src/public/style.css');
  process.exit(2);
}
const tokens = new Map();
for (const m of root[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(m[1], m[2].trim());

const need = (name) => {
  const value = tokens.get(name);
  if (!value) {
    console.error(`токен ${name} не найден`);
    process.exit(2);
  }
  return value;
};
const hex = (name) => {
  const value = need(name);
  if (!/^#[0-9a-f]{6}$/i.test(value)) {
    console.error(`токен ${name} = ${value}: ожидался #rrggbb`);
    process.exit(2);
  }
  return value;
};

function channel(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(h) {
  const v = h.replace('#', '');
  return (
    0.2126 * channel(parseInt(v.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(v.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(v.slice(4, 6), 16))
  );
}
function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
// Полупрозрачная заливка бейджа поверх поверхности: считаем скомпозитированный фон.
function composite(fg, alpha, bg) {
  const f = fg.replace('#', '');
  const b = bg.replace('#', '');
  const out = [0, 2, 4].map((i) =>
    Math.round(parseInt(f.slice(i, i + 2), 16) * alpha + parseInt(b.slice(i, i + 2), 16) * (1 - alpha)),
  );
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const bg = hex('--bg');
const surface = hex('--surface');
const surface2 = hex('--surface-2');
const field = hex('--field');
const cardTop = '#16132c'; // верхняя точка градиента --grad-card (более светлая, худший случай)
const text = hex('--text');
const muted = hex('--text-muted');
const dim = hex('--text-dim');
const faint = hex('--text-faint');
const accent = hex('--accent');
const accentSoft = hex('--accent-soft');
const accentInk = hex('--accent-ink');
const ok = hex('--ok');
const warn = hex('--warn');
const danger = hex('--danger');
const ring = hex('--ring');
const borderStrong = hex('--border-strong');
const chart1 = hex('--chart-1');
const chart2 = hex('--chart-2');
const chart3 = hex('--chart-3');

const textPairs = [
  ['--text на --bg', text, bg],
  ['--text на --surface', text, surface],
  ['--text на верху градиента карточки', text, cardTop],
  ['--text на --surface-2 (диалог, тост)', text, surface2],
  ['--text-muted на --surface', muted, surface],
  ['--text-muted на --field', muted, field],
  ['--text-dim на --surface', dim, surface],
  ['--text-dim на верху градиента карточки', dim, cardTop],
  ['--accent на --bg (ссылки)', accent, bg],
  ['--accent на --accent-soft (активный пункт)', accent, accentSoft],
  ['--accent-ink на --accent (primary)', accentInk, accent],
  ['--accent-ink на --danger (danger кнопка)', accentInk, danger],
  ['--ok на --surface', ok, surface],
  ['--warn на --surface', warn, surface],
  ['--danger на --surface', danger, surface],
];

const badgeTokens = [
  ['ok', '--badge-ok-bg', '--ok'],
  ['warn', '--badge-warn-bg', '--warn'],
  ['danger', '--badge-danger-bg', '--danger'],
  ['accent', '--badge-accent-bg', '--accent'],
  ['neutral', '--badge-neutral-bg', '--text-muted'],
];
for (const [name, token, colorToken] of badgeTokens) {
  const raw = need(token).replace(/\s+/g, ' ');
  const parsed = raw.match(/^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/);
  if (!parsed) {
    console.error(`токен ${token} = ${raw}: ожидался rgb(r g b / a)`);
    process.exit(2);
  }
  const fgHex = `#${parsed.slice(1, 4).map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
  const fg = hex(colorToken);
  if (fgHex !== fg) {
    console.error(`токен ${token}: цвет ${fgHex} не совпадает с ${colorToken} = ${fg}`);
    process.exit(2);
  }
  const alpha = Number(parsed[4]);
  for (const [baseName, base] of [['--surface', surface], ['градиент карточки', cardTop]]) {
    const composed = composite(fg, alpha, base);
    textPairs.push([`бейдж ${name} на ${baseName} (${composed})`, name === 'neutral' ? muted : fg, composed]);
  }
}

const uiPairs = [
  ['--ring на --bg (фокус)', ring, bg],
  ['--ring на --surface (фокус)', ring, surface],
  ['--border-strong на --field (граница поля)', borderStrong, field],
  ['--chart-1 на --surface (столбик)', chart1, surface],
  ['--chart-2 на --surface', chart2, surface],
  ['--chart-3 на --surface', chart3, surface],
  ['--text-faint на --surface (точка «не синхр.»)', faint, surface],
  ['--text-faint на --surface-2 (иконка сайдбара)', faint, surface2],
];

let failures = 0;
let minText = Infinity;
let minUi = Infinity;
console.log('text pairs (AA ≥ 4.5:1)');
for (const [name, fg, base] of textPairs) {
  const value = ratio(fg, base);
  minText = Math.min(minText, value);
  if (value < 4.5) failures += 1;
  console.log(`  ${value >= 4.5 ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(5)}  ${name}`);
}
console.log('ui pairs (AA ≥ 3:1)');
for (const [name, fg, base] of uiPairs) {
  const value = ratio(fg, base);
  minUi = Math.min(minUi, value);
  if (value < 3) failures += 1;
  console.log(`  ${value >= 3 ? 'ok  ' : 'FAIL'} ${value.toFixed(2).padStart(5)}  ${name}`);
}
console.log(`min text: ${minText.toFixed(2)}:1, min ui: ${minUi.toFixed(2)}:1, failures: ${failures}`);
process.exit(failures ? 1 : 0);
