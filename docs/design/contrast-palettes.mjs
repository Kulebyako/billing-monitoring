#!/usr/bin/env node
// WCAG 2.1 contrast checker for the four palette concepts.
// Pure sRGB, no dependencies. Prints every measured pair and flags AA failures.

const lin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const palettes = {
  midnight: {
    bg: '#0A0E15',
    surface: '#111823',
    'surface-2': '#17202E',
    'surface-3': '#1D2838',
    field: '#141C28',
    'fail-bg': '#311A1E',
    border: '#223047',
    hairline: '#1A2434',
    'border-strong': '#5B7495',
    text: '#E7EEF8',
    muted: '#9FB0C6',
    dim: '#8396B0',
    faint: '#5E7290',
    accent: '#4FD3E5',
    'accent-soft': '#123039',
    'accent-ink': '#05161A',
    ok: '#7BDBA4',
    'ok-bg': '#102A22',
    warn: '#F3C76B',
    'warn-bg': '#332A16',
    danger: '#FF8B7E',
    'danger-bg': '#351C1E',
    ring: '#5FDCEB',
    'chart-1': '#4FD3E5',
    'chart-2': '#8FA8FF',
    'chart-3': '#7BDBA4',
  },
  phosphor: {
    bg: '#070B08',
    surface: '#0D130F',
    'surface-2': '#111A14',
    'surface-3': '#16221A',
    field: '#101812',
    'fail-bg': '#2E1915',
    border: '#223026',
    hairline: '#18241C',
    'border-strong': '#55705C',
    text: '#DCE9DE',
    muted: '#93A897',
    dim: '#7B917F',
    faint: '#5A6E5F',
    accent: '#B6F04A',
    'accent-soft': '#1D2A10',
    'accent-ink': '#101A05',
    ok: '#6FE0A0',
    'ok-bg': '#0F2A1D',
    warn: '#F5C451',
    'warn-bg': '#332813',
    danger: '#FF7D6B',
    'danger-bg': '#351A17',
    ring: '#B6F04A',
    'chart-1': '#B6F04A',
    'chart-2': '#6FE0A0',
    'chart-3': '#9BB8FF',
  },
  indigo: {
    bg: '#0B0915',
    surface: '#121022',
    'surface-2': '#181530',
    'surface-3': '#1F1B3B',
    field: '#15122A',
    'fail-bg': '#321A26',
    border: '#292350',
    hairline: '#1D1838',
    'border-strong': '#6B63A8',
    text: '#ECE9F9',
    muted: '#A9A2C9',
    dim: '#8D85AE',
    faint: '#6A6190',
    accent: '#9C93FF',
    'accent-soft': '#241F4A',
    'accent-ink': '#0B0915',
    ok: '#77DCAE',
    'ok-bg': '#102A24',
    warn: '#F3C978',
    'warn-bg': '#322816',
    danger: '#FF8E9A',
    'danger-bg': '#351C25',
    ring: '#B0A8FF',
    'chart-1': '#9C93FF',
    'chart-2': '#77DCAE',
    'chart-3': '#F0B8FF',
  },
  ledger: {
    bg: '#0E0F0A',
    surface: '#15170F',
    'surface-2': '#1B1E14',
    'surface-3': '#23271A',
    field: '#181B11',
    'fail-bg': '#2E1A15',
    border: '#2C3120',
    hairline: '#202417',
    'border-strong': '#6B7052',
    text: '#EDE7D6',
    muted: '#B0AA95',
    dim: '#948E79',
    faint: '#6E6A57',
    accent: '#E0A45C',
    'accent-soft': '#332616',
    'accent-ink': '#1A1206',
    ok: '#8FCB9B',
    'ok-bg': '#16291C',
    warn: '#E8C069',
    'warn-bg': '#302715',
    danger: '#E86F5D',
    'danger-bg': '#311915',
    ring: '#E8B472',
    'chart-1': '#E0A45C',
    'chart-2': '#8FCB9B',
    'chart-3': '#C9B8FF',
  },
};

// Полупрозрачные подложки бейджей: [токен, альфа заливки]. Считается композит
// «альфа × цвет поверх --surface», потому что бейдж лежит на карточке.
const translucentBadges = {
  indigo: [['ok', 0.14], ['warn', 0.14], ['danger', 0.15], ['accent', 0.16], ['muted', 0.12]],
};

// [fg token, bg token, required ratio, kind]
const pairs = [
  ['text', 'bg', 4.5, 'text'],
  ['text', 'surface', 4.5, 'text'],
  ['text', 'surface-2', 4.5, 'text'],
  ['text', 'surface-3', 4.5, 'text'],
  ['muted', 'bg', 4.5, 'text'],
  ['muted', 'surface', 4.5, 'text'],
  ['muted', 'surface-2', 4.5, 'text'],
  ['muted', 'surface-3', 4.5, 'text'],
  ['muted', 'field', 4.5, 'placeholder'],
  ['dim', 'bg', 4.5, 'small text'],
  ['dim', 'surface', 4.5, 'small text'],
  ['dim', 'surface-2', 4.5, 'small text'],
  ['accent', 'bg', 4.5, 'link/nav'],
  ['accent', 'surface', 4.5, 'link/nav'],
  ['accent', 'surface-3', 4.5, 'active nav'],
  ['accent-ink', 'accent', 4.5, 'primary button'],
  ['ok', 'surface', 4.5, 'status text'],
  ['ok', 'ok-bg', 4.5, 'badge'],
  ['warn', 'surface', 4.5, 'status text'],
  ['warn', 'warn-bg', 4.5, 'badge'],
  ['danger', 'surface', 4.5, 'status text'],
  ['danger', 'danger-bg', 4.5, 'badge'],
  ['danger', 'fail-bg', 4.5, 'error row'],
  ['muted', 'fail-bg', 4.5, 'error row'],
  ['ring', 'bg', 3, 'focus (non-text)'],
  ['ring', 'surface', 3, 'focus (non-text)'],
  ['border-strong', 'field', 3, 'field border'],
  ['border-strong', 'surface-2', 3, 'field border'],
  ['chart-2', 'surface', 3, 'chart'],
  ['chart-3', 'surface', 3, 'chart'],
  ['faint', 'surface', 3, 'icons only'],
];

const rgb = (hex) => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};
const toHex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
// Композит полупрозрачного слоя поверх непрозрачного фона.
const composite = (fg, alpha, bg) => toHex(rgb(fg).map((v, i) => v * alpha + rgb(bg)[i] * (1 - alpha)));

let failures = 0;
let checks = 0;
for (const [name, p] of Object.entries(palettes)) {
  console.log(`\n## ${name}`);
  for (const [fg, bg, need, kind] of pairs) {
    const r = ratio(p[fg], p[bg]);
    const ok = r >= need;
    checks++;
    if (!ok) failures++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${fg}#${p[fg].slice(1)} on ${bg}#${p[bg].slice(1)} = ${r.toFixed(2)}:1 (need ${need}, ${kind})`,
    );
  }
  for (const [token, alpha] of translucentBadges[name] ?? []) {
    const bg = composite(p[token], alpha, p.surface);
    const r = ratio(p[token], bg);
    const ok = r >= 4.5;
    checks++;
    if (!ok) failures++;
    console.log(
      `${ok ? 'OK  ' : 'FAIL'} ${token}#${p[token].slice(1)} on composite ${Math.round(alpha * 100)}% over surface ${bg} = ${r.toFixed(2)}:1 (need 4.5, translucent badge)`,
    );
  }
}
console.log(`\nchecks: ${checks}, failures: ${failures}`);
