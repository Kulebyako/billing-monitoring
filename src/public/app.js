const hints = {
  landvps: 'BILLmanager: login + password. Base URL по умолчанию https://my.landvps.ru/billmgr',
  vpsville: 'Email+password от https://vpsville.ru/login.php (форма «Войти в ЛК»). Баланс + дни до нуля → due.',
  hsvds: 'Email+password на https://hsvds.ru/login/. Посуточный биллинг: due ≈ баланс / суточный расход (API /apiv1).',
  play2go: 'Биллинг play2go.cloud: email+password (не control-панель). Token ptlc_ — только game-серверы Pterodactyl, для VPS обычно пусто.',
  yun62: 'Login + password для 62yun.ru',
  kyonix:
    'Биллинг: email+password https://beta.kyonix.com (VDS, баланс, даты). Опционально те же креды для vm.kyonix.com (IP merge).',
};

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function daysUntil(dueAt) {
  if (!dueAt) return null;
  const due = new Date(dueAt.slice(0, 10) + 'T12:00:00');
  const today = new Date(new Date().toISOString().slice(0, 10) + 'T12:00:00');
  return Math.round((due - today) / 86400000);
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(v, cur) {
  if (v == null || v === '') return '—';
  return `${v} ${cur || ''}`.trim();
}

let dashboard = null;

async function load() {
  dashboard = await api('/dashboard');
  const meta = await api('/meta');
  renderSummary(dashboard);
  fillProviders(meta.providers);
  renderServices(dashboard.services);
  renderAccounts(dashboard.accounts);
}

function daysInMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

function calcMonthlyStats(services) {
  const now = new Date();
  const totalDays = daysInMonth(now);
  let totalMonthly = 0;
  let remainingMonthly = 0;

  for (const s of services) {
    if (!s.cost || s.status === 'missing' || s.status === 'deleted') continue;
    // Assume monthly cost; daily = cost / 30 (approx)
    const daily = s.cost / 30;
    totalMonthly += s.cost;
    // Days remaining in current month
    const daysLeft = totalDays - now.getDate() + 1;
    remainingMonthly += daily * daysLeft;
  }

  return {
    totalMonthly: Math.round(totalMonthly),
    remainingMonthly: Math.round(remainingMonthly),
  };
}

function renderSummary(d) {
  const stats = calcMonthlyStats(d.services);
  const el = document.getElementById('summary');
  el.innerHTML = `
    <div class="card warn"><span class="muted">Срок ≤ 7 дней</span><strong>${d.urgent.length}</strong></div>
    <div class="card danger"><span class="muted">Низкий баланс</span><strong>${d.lowBalance.length}</strong></div>
    <div class="card ${d.syncErrors.length ? 'danger' : 'ok'}"><span class="muted">Ошибки sync</span><strong>${d.syncErrors.length}</strong></div>
    <div class="card"><span class="muted">Всего услуг</span><strong>${d.services.length}</strong></div>
    <div class="card"><span class="muted">Расход/мес</span><strong>${stats.totalMonthly.toLocaleString('ru-RU')} ₽</strong></div>
    <div class="card warn"><span class="muted">Доплатить</span><strong>${stats.remainingMonthly.toLocaleString('ru-RU')} ₽</strong></div>
  `;
}

function fillProviders(providers) {
  const sel = document.getElementById('provider-select');
  const filter = document.getElementById('filter-provider');
  sel.innerHTML = providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  filter.innerHTML =
    '<option value="">Все провайдеры</option>' +
    providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('');
  updateHint();
}

function updateHint() {
  const id = document.getElementById('provider-select').value;
  document.getElementById('provider-hint').textContent = hints[id] || '';
}

function renderServices(services) {
  const provider = document.getElementById('filter-provider').value;
  const tag = document.getElementById('filter-tag').value;
  const rows = services.filter((s) => {
    if (provider && s.provider !== provider) return false;
    if (tag && s.tag !== tag) return false;
    return true;
  });
  const tbody = document.querySelector('#services tbody');
  tbody.innerHTML = rows
    .map((s) => {
      const d = daysUntil(s.dueAt);
      let dueClass = '';
      if (d != null && d < 0) dueClass = 'due-over';
      else if (d != null && d <= 7) dueClass = 'due-soon';
      const dueText = s.dueAt ? `${esc(s.dueAt)}${d != null ? ` (${d}д)` : ''}` : '—';
      return `<tr>
        <td>${esc(s.provider)}</td>
        <td>${esc(s.name)}${s.billingUrl ? `<div><a href="${esc(s.billingUrl)}" target="_blank" rel="noopener">биллинг</a></div>` : ''}</td>
        <td>${esc(s.ip || '—')}</td>
        <td class="${dueClass}">${dueText}</td>
        <td>${esc(money(s.cost, s.currency))}</td>
        <td>${esc(money(s.balance, s.currency))}</td>
        <td><span class="badge ${esc(s.status)}">${esc(s.status)}</span></td>
        <td>${esc(s.tag || '—')}</td>
        <td>${esc(s.notes || '—')}</td>
        <td><button type="button" class="ghost" data-edit="${s.id}">Тег</button></td>
      </tr>`;
    })
    .join('');
}

function renderAccounts(accounts) {
  const tbody = document.querySelector('#accounts tbody');
  tbody.innerHTML = accounts
    .map(
      (a) => `<tr>
      <td>${a.id}</td>
      <td>${esc(a.provider)}</td>
      <td>${esc(a.label)}${a.enabled ? '' : ' <span class="badge suspended">off</span>'}</td>
      <td>${esc(a.lastSyncedAt || '—')}</td>
      <td class="${a.lastError ? 'due-over' : ''}">${esc(a.lastError || '—')}</td>
      <td style="white-space:nowrap">
        <button type="button" class="ghost" data-sync="${a.id}">Sync</button>
        <button type="button" class="ghost" data-del="${a.id}">Удалить</button>
      </td>
    </tr>`,
    )
    .join('');
}

document.getElementById('provider-select').addEventListener('change', updateHint);
document.getElementById('filter-provider').addEventListener('change', () => renderServices(dashboard.services));
document.getElementById('filter-tag').addEventListener('change', () => renderServices(dashboard.services));

document.getElementById('btn-sync').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    await api('/sync', { method: 'POST' });
    await load();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' });
  location.href = '/login';
});

document.getElementById('add-account').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const body = {
    provider: fd.get('provider'),
    label: fd.get('label') || undefined,
    baseUrl: fd.get('baseUrl') || undefined,
    login: fd.get('login') || undefined,
    password: fd.get('password') || undefined,
    token: fd.get('token') || undefined,
  };
  try {
    await api('/accounts', { method: 'POST', body: JSON.stringify(body) });
    e.target.reset();
    updateHint();
    await load();
  } catch (err) {
    alert(err.message);
  }
});

document.querySelector('#accounts').addEventListener('click', async (e) => {
  const syncId = e.target.getAttribute('data-sync');
  const delId = e.target.getAttribute('data-del');
  if (syncId) {
    e.target.disabled = true;
    try {
      const r = await api(`/accounts/${syncId}/sync`, { method: 'POST' });
      if (!r.ok) alert(r.error || 'Sync failed');
      await load();
    } catch (err) {
      alert(err.message);
    } finally {
      e.target.disabled = false;
    }
  }
  if (delId) {
    if (!confirm('Удалить аккаунт и его услуги?')) return;
    await api(`/accounts/${delId}`, { method: 'DELETE' });
    await load();
  }
});

document.querySelector('#services').addEventListener('click', (e) => {
  const id = e.target.getAttribute('data-edit');
  if (!id) return;
  const svc = dashboard.services.find((s) => String(s.id) === String(id));
  if (!svc) return;
  const form = document.getElementById('edit-form');
  form.id.value = svc.id;
  form.tag.value = svc.tag || '';
  form.notes.value = svc.notes || '';
  document.getElementById('edit-dlg').showModal();
});

document.getElementById('edit-save').addEventListener('click', async (e) => {
  e.preventDefault();
  const form = document.getElementById('edit-form');
  const id = form.id.value;
  try {
    await api(`/services/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ tag: form.tag.value, notes: form.notes.value }),
    });
    document.getElementById('edit-dlg').close();
    await load();
  } catch (err) {
    alert(err.message);
  }
});

load().catch((e) => console.error(e));
