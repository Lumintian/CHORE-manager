import type { ActionLink, ActionResult, CashFlow, Counterparty, Event, Operation, PublicSettings, Rule, Service, ServiceAction, Snapshot, Wallet } from '../shared/types.js';

const root = document.getElementById('app')!, dialog = document.getElementById('editor') as HTMLDialogElement;
const escape = (value: unknown = '') => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const getStored = (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const setStored = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* Storage is optional. */ } };
let snapshot: Snapshot, settings: PublicSettings;
let logs: { channel: string; status: string; attempts: number; created_at: string; error: string | null }[] = [];
let horizon = Number(getStored('horizon', '30')); if (!Number.isInteger(horizon) || horizon < 1 || horizon > 365) horizon = 30;
let dashboardFilter = 'all', serviceQuery = '', cashStatus = 'pending', cashDirection = 'all', renderVersion = 0;
let toastTimer: ReturnType<typeof setTimeout>;
document.documentElement.dataset.theme = getStored('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, method = 'GET', data?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-App-Request': 'lifecycle' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new ApiError(result.error ?? result.message ?? 'Request failed', response.status); return result as T;
}
function toast(message: string, error = false) {
  const el = document.getElementById('toast')!; el.textContent = message; el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, error ? 8000 : 4500);
}
function failure(error: unknown) { toast(error instanceof Error ? error.message : 'Something went wrong', true); }
function go(path: string) { history.pushState({}, '', path); void refresh(); }
const dateLabel = (value: string) => new Date(`${value.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const plusDays = (value: string, days: number) => { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const badge = (label: string, kind = '') => `<span class="badge ${escape(kind)}">${escape(label)}</span>`;
const routeLink = (path: string, label: string, css = '') => `<a href="${escape(path)}" data-nav class="${escape(css)}">${escape(label)}</a>`;
const empty = (title: string, detail: string) => `<div class="empty"><span class="empty-symbol" aria-hidden="true">&#9678;</span><h3>${escape(title)}</h3><p>${escape(detail)}</p></div>`;
const editButton = (entity: string, id = '', label = 'Edit', serviceId = '') => `<button type="button" class="button small secondary" data-edit="${escape(entity)}" data-id="${escape(id)}" data-service="${escape(serviceId)}">${escape(label)}</button>`;
const removeButton = (entity: string, id: string) => `<button type="button" class="button small quiet danger-text" data-remove="${escape(entity)}" data-id="${escape(id)}">Remove</button>`;
function actionLink(action: ActionLink, primary = false): string {
  const css = `button small ${primary ? 'primary' : 'secondary'}`;
  if (action.url) return `<a class="${css}" href="${escape(action.url)}" target="_blank" rel="noopener noreferrer">${escape(action.label)} &#8599;</a>`;
  if (action.route) return routeLink(action.route, action.label, css);
  return `<button type="button" class="${css}${action.operation === 'cancel_service' ? ' danger-text' : ''}" data-operation="${escape(action.operation)}" data-entity="${escape(action.entity_id)}">${escape(action.label)}</button>`;
}
function header(title: string, subtitle: string, action = '') { return `<div class="page-heading"><div><p class="eyebrow">YOUR WORKSPACE</p><h1>${escape(title)}</h1><p class="subtitle">${escape(subtitle)}</p></div><div class="heading-actions">${action}</div></div>`; }
function eventList(events: Event[], limit = 8): string {
  if (!events.length) return empty('No activity yet', 'Important changes will be recorded here.');
  return `<ol class="timeline">${events.slice(0, limit).map(event => {
    const service = snapshot.services.find(s => s.id === event.service_id)?.name ?? 'Workspace';
    const detail = event.data.expiry_at ? `Expiry: ${event.data.expiry_at}` : event.data.balance ? `Balance: ${event.data.balance} ${event.data.currency ?? ''}` : event.data.amount ? `${event.data.amount} ${event.data.currency ?? ''}` : '';
    return `<li><span class="timeline-dot"></span><div><strong>${escape(event.event_type.toLowerCase().replace(/_/g, ' '))}</strong><span>${escape(service)}${detail ? ` &middot; ${escape(detail)}` : ''}</span></div><time datetime="${escape(event.created_at)}">${escape(dateLabel(event.created_at))}</time></li>`;
  }).join('')}</ol>`;
}
function shell(content: string) {
  const path = location.pathname;
  const nav = [['/dashboard', 'Action Center', '&#9678;'], ['/services', 'Services', '&#9633;'], ['/cashflows', 'Cash flows', '&#8644;'], ['/wallets', 'Funding sources', '&#9682;'], ['/counterparties', 'People & providers', '&#9823;'], ['/settings/notifications', 'Notifications', '&#9831;']];
  root.innerHTML = `<div class="workspace"><aside class="sidebar"><a href="/dashboard" data-nav class="brand"><span class="brand-symbol">L</span><span>Lifecycle<small>SERVICE MANAGER</small></span></a><nav aria-label="Main navigation">${nav.map(([href, label, icon]) => `<a href="${href}" data-nav class="nav-item ${path.startsWith(href) ? 'selected' : ''}" ${path.startsWith(href) ? 'aria-current="page"' : ''}><span aria-hidden="true">${icon}</span>${label}${href === '/dashboard' && snapshot.obligations.length ? `<b>${snapshot.obligations.length}</b>` : ''}</a>`).join('')}</nav><div class="sidebar-bottom"><p><span class="live-dot"></span> Self-hosted workspace</p><small>SQLite &middot; Single user &middot; UTC dates</small><div class="sidebar-controls"><button type="button" class="button quiet small" data-theme-toggle>${document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Dark mode'}</button><button type="button" class="button quiet small" data-logout>Sign out</button></div></div></aside><main class="main"><div class="topbar"><span>Services, not just subscriptions.</span><div><time>${escape(dateLabel(snapshot.today))} &middot; UTC</time><button type="button" class="button small quiet" data-refresh aria-label="Refresh workspace">&#8635; Refresh</button></div></div>${content}<footer class="page-footer">Lifecycle &middot; Own your services. Keep the history.</footer></main></div>`;
}
function dashboard() {
  const urgent = snapshot.obligations.filter(o => o.days <= 7).length;
  const types: Record<string, string> = { expiry: 'Expiry', maintenance: 'Maintenance', receivable: 'To receive', payable: 'To pay', wallet: 'Funding risk' };
  const selected = snapshot.obligations.filter(o => dashboardFilter === 'all' || (dashboardFilter === 'services' ? ['expiry', 'maintenance'].includes(o.type) : o.type === dashboardFilter));
  const tabs = [['all', 'All items'], ['services', 'Expiry & maintenance'], ['receivable', 'Receivables'], ['payable', 'Payables'], ['wallet', 'Funding risks']];
  let content = header('Action Center', 'What needs your attention, and what to do next.', editButton('services', '', '+ Add service'));
  if (!snapshot.services.length) return content + `<section class="panel welcome">${empty('Start with a service', 'A name and a note are enough. Add rules, payments or automation only when you need them.')}<div class="button-row center">${editButton('services', '', 'Create your first service')}<button class="button primary" data-seed>Explore demo workspace</button></div></section>`;
  content += `<div class="summary-grid"><div class="summary"><span class="summary-label">Due within 7 days</span><strong>${urgent}<small>items need attention</small></strong><span class="summary-foot">Including overdue items</span></div><div class="summary"><span class="summary-label">Active services</span><strong>${snapshot.services.filter(s => s.status === 'active').length}<small>services in your care</small></strong><span class="summary-foot">Subscriptions, accounts and access</span></div><div class="summary ${snapshot.coverage.some(c => Number(c.shortfall) > 0) ? 'risk-summary' : ''}"><span class="summary-label">Funding sources at risk</span><strong>${snapshot.coverage.filter(c => Number(c.shortfall) > 0 || c.truncated).length}<small>balances to review</small></strong><span class="summary-foot">No currency conversion</span></div></div>`;
  content += `<section class="panel action-panel"><div class="section-heading"><div><h2>Your next actions <span class="count">${snapshot.obligations.length}</span></h2><p>Sorted by due date. Every action leaves a record.</p></div><label class="inline-field">Window <select id="horizon" aria-label="Planning window">${[7, 30, 90, 365].map(n => `<option value="${n}" ${horizon === n ? 'selected' : ''}>${n} days</option>`).join('')}</select></label></div><div class="tabs" role="group" aria-label="Filter actions">${tabs.map(([key, label]) => `<button type="button" data-filter="${key}" class="tab ${dashboardFilter === key ? 'active' : ''}" aria-pressed="${dashboardFilter === key}">${label}</button>`).join('')}</div><div class="obligations">${selected.map(o => `<article class="obligation ${o.severity}" data-obligation="${escape(o.entity_id)}"><div class="obligation-icon ${o.type}" aria-hidden="true">${({ expiry: '&#9671;', maintenance: '&#8635;', receivable: '&#8601;', payable: '&#8599;', wallet: '&#9682;' })[o.type]}</div><div class="obligation-body"><div class="obligation-meta"><span class="kind-label">${types[o.type]}</span>${badge(o.days < 0 ? `${-o.days}d overdue` : o.days === 0 ? 'Due today' : o.days === 1 ? 'Tomorrow' : `In ${o.days} days`, o.severity)}</div><h3>${o.service_id ? routeLink(`/services/${o.service_id}`, o.title) : escape(o.title)}</h3><p>${escape(o.detail)}</p><div class="button-row">${o.actions.map((a, i) => actionLink(a, i === 0)).join('')}</div></div><div class="obligation-value">${o.amount ? `<strong class="${o.type === 'receivable' ? 'incoming-text' : o.type === 'wallet' ? 'danger-text' : ''}">${o.type === 'wallet' ? '<small>Shortfall</small>' : ''}${escape(o.amount)} <span>${escape(o.currency)}</span></strong>` : ''}<time>${escape(dateLabel(o.due_at))}</time></div></article>`).join('') || empty('Nothing to handle in this view', 'Try another filter or a longer planning window.')}</div></section>`;
  return content + `<section class="panel activity"><div class="section-heading"><div><h2>Recent activity</h2><p>What actually happened, not just what was scheduled.</p></div></div>${eventList(snapshot.events)}</section>`;
}
function serviceCards() {
  return snapshot.services.filter(s => `${s.name} ${s.category} ${s.notes}`.toLowerCase().includes(serviceQuery.toLowerCase())).map(s => {
    const next = [...snapshot.rules.filter(r => r.service_id === s.id && r.enabled).map(r => r.next_due!), ...snapshot.cashflows.filter(c => c.service_id === s.id && c.status === 'pending').map(c => c.due_at)].sort()[0];
    return `<article class="panel service-card"><div class="service-card-top"><span class="service-avatar">${escape(s.name.slice(0, 1))}</span>${badge(s.status, s.status === 'active' ? 'positive' : 'muted')}</div><h2>${routeLink(`/services/${s.id}`, s.name)}</h2><p>${escape(s.description || s.notes || 'No description yet. Add details as you need them.')}</p><div class="service-card-bottom"><span>${escape(s.category || 'Uncategorized')}</span><span>${s.status === 'active' ? next ? `Next: ${escape(dateLabel(next))}` : 'No rules or payments' : 'Reminders inactive'}</span></div></article>`;
  }).join('') || empty('No matching services', 'Create a service or try a different search.');
}
function services() {
  return header('Services', 'Manage everything you hold, from paid subscriptions to occasional maintenance.', editButton('services', '', '+ Add service')) + `<div class="toolbar"><label class="search-field"><span aria-hidden="true">&#8981;</span><input id="service-search" type="search" placeholder="Search services, categories or notes" aria-label="Search services" value="${escape(serviceQuery)}"></label><span class="muted-text">${snapshot.services.length} total services</span></div><div class="service-grid" id="service-list">${serviceCards()}</div>`;
}
function cashTable(rows: CashFlow[]): string {
  if (!rows.length) return empty('No cash flows in this view', 'Track outgoing costs and incoming shared payments with the same model.');
  return `<div class="table-scroll"><table><thead><tr><th>Service / counterparty</th><th>Direction</th><th>Amount</th><th>Due</th><th>Recurrence</th><th>Status</th><th class="align-right">Actions</th></tr></thead><tbody>${rows.map(c => {
    const s = snapshot.services.find(s => s.id === c.service_id)!; const party = snapshot.counterparties.find(p => p.id === c.counterparty_id);
    return `<tr><td><strong>${routeLink(`/services/${s.id}`, s.name)}</strong><small>${escape(party?.name ?? 'Provider / unspecified')}${s.status !== 'active' ? ` &middot; ${escape(s.status)}` : ''}</small></td><td>${badge(c.direction === 'IN' ? 'IN / receivable' : 'OUT / payable', c.direction === 'IN' ? 'positive' : 'neutral')}</td><td class="money ${c.direction === 'IN' ? 'incoming-text' : ''}">${escape(c.amount)} <small>${escape(c.currency)}</small></td><td class="nowrap">${escape(dateLabel(c.due_at))}</td><td>${escape(c.recurrence === 'none' ? 'One-off' : `Every ${c.interval} ${c.recurrence === 'monthly' ? 'month(s)' : c.recurrence === 'yearly' ? 'year(s)' : 'day(s)'}`)}</td><td>${badge(c.status === 'paid' && c.direction === 'IN' ? 'received' : c.status, c.status === 'paid' ? 'positive' : 'muted')}</td><td><div class="button-row end">${c.status === 'pending' ? `${actionLink({ label: c.direction === 'IN' ? 'Received' : 'Paid', operation: c.direction === 'IN' ? 'mark_cashflow_received' : 'mark_cashflow_paid', entity_id: c.id }, true)}${editButton('cashflows', c.id)}<button class="button small quiet" data-operation="skip_cashflow" data-entity="${c.id}">Skip</button>${removeButton('cashflows', c.id)}` : '<span class="muted-text">Recorded</span>'}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}
function cashflows() {
  const rows = snapshot.cashflows.filter(c => (cashStatus === 'all' || c.status === cashStatus) && (cashDirection === 'all' || c.direction === cashDirection));
  return header('Cash flows', 'Independent incoming and outgoing payments. Every currency stays as entered.', editButton('cashflows', '', '+ Add cash flow')) + `<section class="panel"><div class="section-heading"><div><h2>Payment ledger</h2><p>Settling a recurring payment creates its next occurrence; it never overwrites history.</p></div><div class="button-row"><label class="inline-field">Status <select id="cash-status">${[['pending', 'Pending'], ['paid', 'Paid / received'], ['skipped', 'Skipped'], ['all', 'All history']].map(([v, l]) => `<option value="${v}" ${cashStatus === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><label class="inline-field">Direction <select id="cash-direction">${[['all', 'Both'], ['IN', 'IN'], ['OUT', 'OUT']].map(([v, l]) => `<option value="${v}" ${cashDirection === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div></div>${cashTable(rows)}</section>`;
}
function serviceDetail(id: string) {
  const service = snapshot.services.find(s => s.id === id); if (!service) return empty('Service not found', 'Return to Services to choose an existing record.');
  const rules = snapshot.rules.filter(r => r.service_id === id), actions = snapshot.actions.filter(a => a.service_id === id);
  const actionRows = actions.map(a => `<div class="record-row"><div><h3>${escape(a.label)} ${!a.enabled ? badge('disabled', 'muted') : ''}</h3><p>${escape(a.kind)}${a.kind === 'webhook' ? ` &middot; ${escape(a.method)} &middot; ${a.configured ? 'server-side configuration' : 'not configured'}` : a.kind === 'state' ? ` &middot; ${escape(a.operation)}` : ''}</p></div><div class="button-row">${a.enabled && service.status === 'active' ? a.kind === 'url' ? `<a class="button small secondary" href="${escape(a.url)}" target="_blank" rel="noopener noreferrer" data-audit-url="${a.id}">Open &#8599;</a>` : actionLink({ label: 'Run', operation: 'custom_action', entity_id: a.id }) : ''}${editButton('actions', a.id, 'Edit', id)}${removeButton('actions', a.id)}</div></div>`).join('');
  return `<div class="breadcrumb">${routeLink('/services', 'Services')} <span>/</span> ${escape(service.name)}</div>` + header(service.name, service.description || 'A service can be as simple or as detailed as you need.', `${service.url ? `<a class="button secondary" href="${escape(service.url)}" target="_blank" rel="noopener noreferrer">Open website &#8599;</a>` : ''}${editButton('services', id)}${service.status !== 'cancelled' ? actionLink({ label: 'Stop holding', operation: 'cancel_service', entity_id: id }) : ''}`) +
    `<section class="panel service-info"><div class="button-row">${badge(service.status, service.status === 'active' ? 'positive' : 'muted')}${service.category ? badge(service.category, 'neutral') : ''}<span class="muted-text">Created ${escape(dateLabel(service.created_at))}</span></div>${service.notes ? `<p class="notes">${escape(service.notes)}</p>` : ''}${service.status !== 'active' ? '<p class="notice">This service is inactive. Its derived reminders and funding projections are suppressed; payment history is preserved.</p>' : ''}</section>` +
    `<div class="detail-grid"><section class="panel"><div class="section-heading"><div><h2>Rules</h2><p>Describe when something is due.</p></div>${editButton('rules', '', '+ Add rule', id)}</div>${rules.map(r => `<div class="rule-record"><div class="record-row"><div><h3>${escape(r.label)} ${!r.enabled ? badge('disabled', 'muted') : ''}</h3><p>${escape(r.type.replace(/_/g, ' '))}${r.type === 'interval_since_event' ? ` &middot; ${r.interval_days} days since ${escape(r.event_type)}` : ` &middot; +${r.extend_days} days per action`}</p></div><div class="button-row">${editButton('rules', r.id, 'Edit', id)}${removeButton('rules', r.id)}</div></div><div class="rule-due"><span>Next due <strong data-rule-due="${r.id}">${escape(r.next_due)}</strong></span>${r.enabled && service.status === 'active' ? actionLink({ label: r.type === 'interval_since_event' ? (r.event_type === 'LOGIN' ? 'Already logged in' : 'Mark done') : r.type === 'extend_by' ? `Extend ${r.extend_days} days` : 'Mark renewed', operation: r.type === 'interval_since_event' ? 'mark_login' : r.type === 'extend_by' ? 'extend_expiry' : 'mark_renewed', entity_id: r.id }, true) : ''}</div></div>`).join('') || empty('No rules yet', 'Add a fixed expiry, an event interval, or an extendable expiry.')}</section><section class="panel"><div class="section-heading"><div><h2>Actions</h2><p>State changes, links and webhooks.</p></div>${editButton('actions', '', '+ Add action', id)}</div>${actionRows || empty('No custom actions', 'Built-in rule and payment actions are available automatically.')}</section></div>` +
    `<section class="panel"><div class="section-heading"><div><h2>Cash flows</h2><p>Current occurrences and retained history for this service.</p></div>${editButton('cashflows', '', '+ Add cash flow', id)}</div>${cashTable(snapshot.cashflows.filter(c => c.service_id === id))}</section><section class="panel activity"><div class="section-heading"><div><h2>Service history</h2><p>Events record what actually happened.</p></div></div>${eventList(snapshot.events.filter(e => e.service_id === id), 30)}</section>`;
}
function wallets() {
  return header('Funding sources', 'Will your prepaid balances cover upcoming outgoing payments?', editButton('wallets', '', '+ Add funding source')) + `<div class="notice">Forecast window: ${horizon} days. Includes pending debt and projected recurring charges from active services. Incoming transfers and other currencies are not assumed.</div><div class="wallet-grid">${snapshot.wallets.map(w => {
    const c = snapshot.coverage.find(c => c.wallet_id === w.id)!;
    return `<section class="panel wallet-card"><div class="section-heading"><div><p class="eyebrow">${escape(w.currency)} FUNDING SOURCE</p><h2>${escape(w.name)}</h2></div>${badge(Number(c.shortfall) > 0 ? 'Top-up needed' : 'Covered', Number(c.shortfall) > 0 ? 'soon' : 'positive')}</div><div class="wallet-balance"><span>Current balance</span><strong>${escape(w.balance)} <small>${escape(w.currency)}</small></strong></div><dl class="wallet-metrics"><div><dt>Upcoming deductions</dt><dd>${escape(c.required)} ${escape(c.currency)}</dd></div><div><dt>${Number(c.shortfall) > 0 ? 'Projected shortfall' : 'Projected remaining'}</dt><dd class="${Number(c.shortfall) > 0 ? 'danger-text' : 'incoming-text'}">${escape(Number(c.shortfall) > 0 ? c.shortfall : c.remaining)} ${escape(c.currency)}</dd></div></dl>${c.truncated ? '<p class="notice">Projection truncated after 4096 occurrences. Review old pending charges.</p>' : ''}<p class="wallet-note">${escape(w.notes || `Forecast through ${c.through}`)}</p><div class="button-row">${editButton('wallets', w.id, 'Update balance')}${w.topup_url ? `<a class="button secondary small" href="${escape(w.topup_url)}" target="_blank" rel="noopener noreferrer">Open top-up page &#8599;</a>` : ''}${removeButton('wallets', w.id)}</div><details><summary>Upcoming deductions (${c.entries.length})</summary><div class="table-scroll"><table><thead><tr><th>Service</th><th>Due</th><th>Amount</th></tr></thead><tbody>${c.entries.map(e => { const flow = snapshot.cashflows.find(c => c.id === e.cashflow_id)!; return `<tr><td>${escape(snapshot.services.find(s => s.id === flow.service_id)?.name)}${e.projected ? '<small>Projected recurrence</small>' : ''}</td><td>${escape(e.due_at)}</td><td class="money">${escape(e.amount)} ${escape(w.currency)}</td></tr>`; }).join('') || '<tr><td colspan="3">No scheduled deductions in this window.</td></tr>'}</tbody></table></div></details></section>`;
  }).join('') || empty('No funding sources yet', 'Add gift-card balances, prepaid accounts or API credits.')}</div>`;
}
function counterparties() {
  return header('People & providers', 'The same person can pay you or receive a payment from you.', editButton('counterparties', '', '+ Add counterparty')) + `<section class="panel">${snapshot.counterparties.map(p => `<div class="record-row"><div><h3>${escape(p.name)}</h3><p>${escape(p.notes || 'No notes')}</p></div><div class="button-row">${editButton('counterparties', p.id)}${removeButton('counterparties', p.id)}</div></div>`).join('') || empty('No counterparties yet', 'Add the people you share services with, or your service providers.')}</section>`;
}
function field(key: string, label: string, value: unknown = '', type = 'text', attributes = '') {
  return `<label class="field"><span>${escape(label)}</span><input name="${key}" type="${type}" value="${escape(value)}" ${attributes}></label>`;
}
function textarea(key: string, label: string, value: unknown = '', placeholder = '') { return `<label class="field full"><span>${escape(label)}</span><textarea name="${key}" rows="3" placeholder="${escape(placeholder)}">${escape(value)}</textarea></label>`; }
function select(key: string, label: string, value: unknown, options: [string, string][], required = false) { return `<label class="field"><span>${escape(label)}</span><select name="${key}" ${required ? 'required' : ''}>${options.map(([v, l]) => `<option value="${escape(v)}" ${v === value ? 'selected' : ''}>${escape(l)}</option>`).join('')}</select></label>`; }
function checkbox(key: string, label: string, checked: boolean, disabled = false) { return `<label class="checkbox"><input type="checkbox" name="${key}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${escape(label)}</span></label>`; }
function values(data: FormData): Record<string, unknown> { return Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)])); }
function openForm(title: string, fields: string, submit: (data: FormData) => Promise<unknown>, note = ''): HTMLFormElement {
  if (dialog.open) dialog.close();
  dialog.innerHTML = `<form id="entity-form"><div class="dialog-heading"><div><p class="eyebrow">WORKSPACE EDITOR</p><h2 id="dialog-title">${escape(title)}</h2></div><button class="button quiet" type="button" data-close aria-label="Close editor">&#10005;</button></div>${note ? `<p class="dialog-note">${escape(note)}</p>` : ''}<div class="form-grid">${fields}</div><p class="form-error" role="alert" hidden></p><div class="dialog-footer"><button class="button secondary" type="button" data-close>Cancel</button><button class="button primary" type="submit">Save changes</button></div></form>`;
  const form = dialog.querySelector('form')!;
  form.addEventListener('submit', async event => {
    event.preventDefault(); const button = form.querySelector<HTMLButtonElement>('[type="submit"]')!, error = form.querySelector<HTMLElement>('.form-error')!;
    button.disabled = true; error.hidden = true;
    try { await submit(new FormData(form)); dialog.close(); toast('Changes saved'); await refresh(); }
    catch (err) { error.textContent = err instanceof Error ? err.message : 'Could not save'; error.hidden = false; }
    finally { button.disabled = false; }
  });
  dialog.showModal(); return form;
}
function toggleGroup(form: HTMLFormElement, name: string, enabled: boolean) {
  const group = form.querySelector<HTMLElement>(`[data-group="${name}"]`)!; group.hidden = !enabled;
  group.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea').forEach(input => { input.disabled = !enabled; });
}
function editService(id: string) {
  const s: Service | undefined = snapshot.services.find(s => s.id === id);
  openForm(s ? 'Edit service' : 'Add service', field('name', 'Name', s?.name, 'text', 'required maxlength="160" autofocus') + select('status', 'Status', s?.status ?? 'active', ['active', 'paused', 'cancelled', 'expired'].map(v => [v, v])) + field('url', 'Website URL (optional)', s?.url, 'url') + field('category', 'Category (optional)', s?.category, 'text', 'maxlength="80"') + textarea('description', 'Description (optional)', s?.description) + textarea('notes', 'Notes (optional)', s?.notes), data => api(`/services${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { ...values(data), ...(s ? { version: s.version } : {}) }), 'Only a name is required. Inactive services keep their history but stop generating reminders and funding projections.');
}
function editRule(id: string, serviceId: string) {
  const r: Rule | undefined = snapshot.rules.find(r => r.id === id); serviceId ||= r?.service_id ?? '';
  const form = openForm(r ? 'Edit rule' : 'Add rule', field('label', 'Rule label', r?.label ?? 'Service expiry', 'text', 'required maxlength="160"') + select('type', 'Rule type', r?.type ?? 'fixed_expiry', [['fixed_expiry', 'Fixed expiry'], ['interval_since_event', 'Interval since an event'], ['extend_by', 'Extend existing expiry']]) +
    `<div class="form-group full" data-group="expiry">${field('expiry_at', 'Expiry date', r?.expiry_at ?? plusDays(snapshot.today, 30), 'date', 'required')}${field('extend_days', 'Days added by renew / extend', r?.extend_days ?? 30, 'number', 'min="1" max="3650" required')}</div>` +
    `<div class="form-group full" data-group="interval">${field('event_type', 'Matching event type', r?.event_type ?? 'LOGIN', 'text', 'required maxlength="64"')}${field('interval_days', 'Days since the last event', r?.interval_days ?? 40, 'number', 'min="1" max="3650" required')}${field('anchor_at', 'Fallback date (before first event)', r?.anchor_at ?? snapshot.today, 'date', 'required')}</div>` +
    field('reminders', 'Remind before (days, comma-separated)', r?.remind_before_days.join(', ') ?? '30, 7, 3, 1') + checkbox('enabled', 'Rule enabled', r?.enabled ?? true), data => {
      const body = values(data); delete body.reminders;
      return api(`/rules${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { ...body, service_id: serviceId, enabled: data.has('enabled'), remind_before_days: String(data.get('reminders') ?? '').split(',').map(v => v.trim()).filter(Boolean).map(Number), ...(r ? { version: r.version } : {}) });
    }, 'Interval rules use the latest matching Event, not a manually maintained next-login date. Due-day and overdue reminders are automatic.');
  const type = form.elements.namedItem('type') as HTMLSelectElement;
  const update = () => { toggleGroup(form, 'interval', type.value === 'interval_since_event'); toggleGroup(form, 'expiry', type.value !== 'interval_since_event'); };
  type.addEventListener('change', update); update();
}
function editCashflow(id: string, serviceId: string) {
  if (!snapshot.services.length) { toast('Create a service before adding a cash flow.', true); return; }
  const c: CashFlow | undefined = snapshot.cashflows.find(c => c.id === id);
  const form = openForm(c ? 'Edit pending cash flow' : 'Add cash flow', select('service_id', 'Service', c?.service_id ?? serviceId ?? '', [['', 'Choose a service'], ...snapshot.services.map(s => [s.id, s.name] as [string, string])], true) + select('direction', 'Direction', c?.direction ?? 'OUT', [['OUT', 'OUT - I pay'], ['IN', 'IN - I receive']]) +
    select('counterparty_id', 'Person / provider (optional)', c?.counterparty_id ?? '', [['', 'Provider / unspecified'], ...snapshot.counterparties.map(p => [p.id, p.name] as [string, string])]) + field('amount', 'Amount', c?.amount ?? '', 'number', 'min="0" max="999999999" step="0.0001" required') + field('currency', 'Currency', c?.currency ?? 'USD', 'text', 'required minlength="3" maxlength="8" pattern="[A-Za-z]{3,8}"') + field('due_at', 'Due date', c?.due_at ?? plusDays(snapshot.today, 1), 'date', 'required') +
    select('recurrence', 'Recurrence', c?.recurrence ?? 'monthly', [['none', 'One-off'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['days', 'Every N days']]) + field('interval', 'Recurrence interval', c?.interval ?? 1, 'number', 'min="1" max="365" required') +
    `<div class="form-group full" data-group="wallet">${select('wallet_id', 'Funding source (OUT only)', c?.wallet_id ?? '', [['', 'No funding source'], ...snapshot.wallets.map(w => [w.id, `${w.name} (${w.currency})`] as [string, string])])}</div>` + textarea('notes', 'Notes (optional)', c?.notes), data => api(`/cashflows${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { ...values(data), wallet_id: data.get('direction') === 'IN' ? '' : data.get('wallet_id'), ...(c ? { version: c.version } : {}) }), 'Amounts keep their original currency (up to 4 decimal places). A linked funding source must have the same currency.');
  const direction = form.elements.namedItem('direction') as HTMLSelectElement, wallet = form.elements.namedItem('wallet_id') as HTMLSelectElement;
  const update = () => toggleGroup(form, 'wallet', direction.value === 'OUT'); direction.addEventListener('change', update); update();
  wallet.addEventListener('change', () => { const w = snapshot.wallets.find(w => w.id === wallet.value); if (w) (form.elements.namedItem('currency') as HTMLInputElement).value = w.currency; });
}
function editWallet(id: string) {
  const w: Wallet | undefined = snapshot.wallets.find(w => w.id === id);
  openForm(w ? 'Update funding source' : 'Add funding source', field('name', 'Name', w?.name, 'text', 'required maxlength="160"') + field('currency', 'Currency', w?.currency ?? 'USD', 'text', 'required minlength="3" maxlength="8" pattern="[A-Za-z]{3,8}"') + field('balance', 'Current balance', w?.balance ?? '0', 'number', 'step="0.0001" required') + field('topup_url', 'Top-up page (optional)', w?.topup_url, 'url') + textarea('notes', 'Notes (optional)', w?.notes), data => api(`/wallets${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', { ...values(data), ...(w ? { expected_balance: w.balance } : {}) }), 'Enter the actual balance now, not a top-up amount. Paying a linked outgoing cash flow deducts its amount exactly once.');
}
function editCounterparty(id: string) {
  const p: Counterparty | undefined = snapshot.counterparties.find(p => p.id === id);
  openForm(p ? 'Edit counterparty' : 'Add counterparty', field('name', 'Name', p?.name, 'text', 'required maxlength="160"') + textarea('notes', 'Notes (optional)', p?.notes), data => api(`/counterparties${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', values(data)));
}
function editAction(id: string, serviceId: string) {
  const a: ServiceAction | undefined = snapshot.actions.find(a => a.id === id); serviceId ||= a?.service_id ?? '';
  const rules = snapshot.rules.filter(r => r.service_id === serviceId);
  const form = openForm(a ? 'Edit action' : 'Add action', field('label', 'Button label', a?.label, 'text', 'required maxlength="160"') + select('kind', 'Action kind', a?.kind ?? 'url', [['url', 'Open a URL'], ['state', 'Change state'], ['webhook', 'Call webhook']]) + select('rule_id', 'Related rule (optional for URL / webhook)', a?.rule_id ?? '', [['', 'No related rule'], ...rules.map(r => [r.id, r.label] as [string, string])]) +
    `<div class="form-group full" data-group="url">${field('url', 'URL to open', a?.url, 'url', 'required')}</div>` +
    `<div class="form-group full" data-group="state">${select('operation', 'State operation', a?.operation || 'mark_login', [['mark_login', 'Record matching event (e.g. LOGIN)'], ['mark_renewed', 'Mark renewed'], ['extend_expiry', 'Extend existing expiry'], ['cancel_service', 'Stop holding service']])}</div>` +
    `<div class="form-group full" data-group="webhook">${field('webhook_url', a?.configured && a.kind === 'webhook' ? 'Webhook URL (blank keeps saved URL)' : 'Webhook URL', '', 'url', a?.configured && a.kind === 'webhook' ? '' : 'required')}${select('method', 'HTTP method', a?.method ?? 'POST', ['POST', 'GET', 'PUT', 'PATCH', 'DELETE'].map(m => [m, m]))}${field('success_event', 'Event after success (optional, e.g. LOGIN)', a?.success_event)}${textarea('headers', 'Headers as JSON (server-side only)', '', 'Blank keeps saved headers; {} clears them.')}${textarea('body', 'Request body as JSON', '', 'Blank keeps saved body; {} uses an empty object.')}</div>` + checkbox('enabled', 'Action enabled', a?.enabled ?? true), data => {
      const body = values(data); body.service_id = serviceId; body.enabled = data.has('enabled'); if (a) body.version = a.version;
      for (const key of ['headers', 'body']) { const value = String(data.get(key) ?? '').trim(); if (value) { try { body[key] = JSON.parse(value); } catch { throw new Error(`${key} must be valid JSON`); } } else delete body[key]; }
      return api(`/actions${id ? `/${id}` : ''}`, id ? 'PUT' : 'POST', body);
    }, 'Webhook URLs, headers and bodies are encrypted on the server and never returned to this editor. Only HTTP 2xx is success. Private-network destinations are blocked unless explicitly allowed by the server.');
  const kind = form.elements.namedItem('kind') as HTMLSelectElement, operation = form.elements.namedItem('operation') as HTMLSelectElement, rule = form.elements.namedItem('rule_id') as HTMLSelectElement;
  const update = () => { for (const group of ['state', 'url', 'webhook']) toggleGroup(form, group, kind.value === group); rule.required = kind.value === 'state' && operation.value !== 'cancel_service'; };
  kind.addEventListener('change', update); operation.addEventListener('change', update); update();
}
function notificationsPage() {
  const locked = (env: string) => settings.env_overrides.includes(env) ? 'disabled' : '';
  return header('Notifications', 'Reminders that let you act, without opening another dashboard.') +
    `<div class="notice">Server URL: <strong>${escape(settings.app_url)}</strong> &middot; Reminder scan every ${settings.scheduler_seconds / 60} minutes &middot; Wallet horizon ${settings.wallet_horizon} days.${settings.env_overrides.length ? `<br>Environment overrides: ${escape(settings.env_overrides.join(', '))}` : ''}</div>` +
    `<form id="notifications-form"><div class="detail-grid"><section class="panel settings-card"><div class="section-heading"><div><p class="eyebrow">BOT API</p><h2>Telegram</h2></div>${badge(settings.telegram_enabled ? 'Enabled' : 'Disabled', settings.telegram_enabled ? 'positive' : 'muted')}</div><p>Inline buttons record actions through the bot. Polling means Telegram does not need inbound access to your server.</p><div class="form-grid">${checkbox('telegram_enabled', 'Enable Telegram reminders', settings.telegram_enabled, !!locked('TELEGRAM_ENABLED'))}${field('telegram_chat_id', 'Numeric chat ID', settings.telegram_chat_id, 'text', locked('TELEGRAM_CHAT_ID'))}${field('telegram_token', `Bot token (${settings.telegram_has_token ? 'stored; leave blank to keep' : 'not configured'})`, '', 'password', `autocomplete="new-password" ${locked('TELEGRAM_BOT_TOKEN')}`)}${checkbox('telegram_token_clear', 'Clear stored bot token', false, !!locked('TELEGRAM_BOT_TOKEN'))}</div><p class="hint">Use a private chat, or a group whose members you trust to execute actions.</p><button type="button" class="button secondary small" data-test-channel="telegram">Send Telegram test</button>${settings.telegram_error ? `<p class="form-error">${escape(settings.telegram_error)}</p>` : ''}</section><section class="panel settings-card"><div class="section-heading"><div><p class="eyebrow">HTTP PUSH</p><h2>ntfy</h2></div>${badge(settings.ntfy_enabled ? 'Enabled' : 'Disabled', settings.ntfy_enabled ? 'positive' : 'muted')}</div><p>Native HTTP actions call this server using a scoped, expiring token. Your phone must be able to reach the server URL.</p><div class="form-grid">${checkbox('ntfy_enabled', 'Enable ntfy reminders', settings.ntfy_enabled, !!locked('NTFY_ENABLED'))}${field('ntfy_server', 'ntfy server URL', settings.ntfy_server, 'url', `required ${locked('NTFY_SERVER_URL')}`)}${field('ntfy_topic', 'Private topic', settings.ntfy_topic, 'text', locked('NTFY_TOPIC'))}${field('ntfy_token', `Access token (${settings.ntfy_has_token ? 'stored; leave blank to keep' : 'optional'})`, '', 'password', `autocomplete="new-password" ${locked('NTFY_TOKEN')}`)}${checkbox('ntfy_token_clear', 'Clear stored access token', false, !!locked('NTFY_TOKEN'))}</div><p class="hint">Use an access-controlled topic. Anyone who receives an action token can execute that action.</p><button type="button" class="button secondary small" data-test-channel="ntfy">Send ntfy test</button></section></div><div class="save-bar"><span>Save settings before testing. Secrets remain on the server.</span><button class="button primary" type="submit">Save notification settings</button></div></form>` +
    `<section class="panel"><div class="section-heading"><div><h2>Reminder controls</h2><p>Preview is inert: it sends nothing and creates no executable tokens.</p></div><div class="button-row"><button class="button secondary" data-preview>Preview payloads</button><button class="button primary" data-scan>Send due reminders now</button></div></div><p class="panel-note">${settings.last_scan ? `Last scan: ${escape(settings.last_scan)}` : 'No scan recorded since this server started.'}</p><pre id="payload-preview" hidden></pre></section><section class="panel"><div class="section-heading"><div><h2>Delivery log</h2><p>One delivery per obligation, due state, threshold and channel. Failed delivery retries are limited to three attempts.</p></div></div>${logs.length ? `<div class="table-scroll"><table><thead><tr><th>Channel</th><th>Status</th><th>Attempts</th><th>Created</th><th>Note</th></tr></thead><tbody>${logs.map(l => `<tr><td>${escape(l.channel)}</td><td>${badge(l.status, l.status === 'sent' ? 'positive' : 'muted')}</td><td>${l.attempts}</td><td>${escape(dateLabel(l.created_at))}</td><td>${escape(l.error ?? '')}</td></tr>`).join('')}</tbody></table></div>` : empty('No deliveries yet', 'Configure a channel, preview the payloads, and send a test.')}</section>`;
}
function render() {
  let content: string; const path = location.pathname;
  if (path === '/services') content = services();
  else if (path.startsWith('/services/')) content = serviceDetail(path.split('/')[2]);
  else if (path === '/cashflows') content = cashflows();
  else if (path === '/wallets') content = wallets();
  else if (path === '/counterparties') content = counterparties();
  else if (path === '/settings/notifications') content = notificationsPage();
  else content = dashboard();
  shell(content);
}
async function refresh() {
  const version = ++renderVersion;
  try {
    const data = await api<Snapshot>(`/snapshot?horizon=${horizon}`);
    let config: PublicSettings | undefined, deliveries: typeof logs = [];
    if (location.pathname === '/settings/notifications') [config, deliveries] = await Promise.all([api<PublicSettings>('/settings/notifications'), api<typeof logs>('/notifications/logs')]);
    if (version !== renderVersion) return;
    snapshot = data; if (config) settings = config; logs = deliveries; render();
  } catch (error) { if (error instanceof ApiError && error.status === 401) showAuth(false); else failure(error); }
}
function showAuth(setup: boolean) {
  root.innerHTML = `<main class="auth-page"><div class="auth-card"><div class="brand"><span class="brand-symbol">L</span><span>Lifecycle<small>SERVICE MANAGER</small></span></div><p class="eyebrow">YOUR SERVICES. YOUR SERVER.</p><h1>${setup ? 'Make this workspace yours.' : 'Welcome back.'}</h1><p class="subtitle">${setup ? 'Set a password before using your private workspace. Setup is available only once.' : 'Sign in to manage your services, payments and next actions.'}</p><form id="auth-form">${field('password', 'Password', '', 'password', `required minlength="${setup ? 12 : 1}" maxlength="256" autocomplete="${setup ? 'new-password' : 'current-password'}" autofocus`)}${setup ? field('confirm', 'Confirm password', '', 'password', 'required minlength="12" autocomplete="new-password"') : ''}<p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">${setup ? 'Set password & continue' : 'Sign in'}</button></form><p class="hint">${setup ? 'Use at least 12 characters. Complete first-run setup on a trusted, local connection.' : 'Self-hosted. No bank sync. No cloud account required.'}</p></div></main>`;
  const form = root.querySelector('form')!;
  form.addEventListener('submit', async event => {
    event.preventDefault(); const data = new FormData(form), error = form.querySelector<HTMLElement>('.form-error')!, button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
    button.disabled = true; error.hidden = true;
    try {
      if (setup && data.get('password') !== data.get('confirm')) throw new Error('Passwords do not match');
      await api(setup ? '/setup' : '/login', 'POST', { password: data.get('password') }); await refresh();
    } catch (err) { error.textContent = err instanceof Error ? err.message : 'Sign in failed'; error.hidden = false; }
    finally { button.disabled = false; }
  });
}
async function runOperation(operation: Operation, id: string, button?: HTMLButtonElement) {
  if (operation === 'cancel_service' && !confirm('Stop holding this service? Reminders and projected charges stop; existing payment history is retained.')) return;
  if (operation === 'skip_cashflow' && !confirm('Skip this occurrence without recording a payment? A recurring flow will advance to its next due date.')) return;
  if (operation === 'custom_action' && snapshot.actions.find(a => a.id === id)?.kind === 'webhook' && !confirm('Run this configured webhook? This calls your remote automation endpoint.')) return;
  if (button) button.disabled = true;
  try { const issued = await api<{ token: string }>('/action-tokens', 'POST', { operation, entity_id: id }); const result = await api<ActionResult>(`/actions/${issued.token}/execute`, 'POST', {}); toast(result.message); await refresh(); }
  catch (error) { failure(error); }
  finally { if (button) button.disabled = false; }
}
document.addEventListener('click', async event => {
  const target = (event.target as Element).closest<HTMLElement>('button,a'); if (!target) return;
  try {
    if (target.hasAttribute('data-nav') && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); go((target as HTMLAnchorElement).pathname); }
    else if (target.hasAttribute('data-close')) dialog.close();
    else if (target.hasAttribute('data-theme-toggle')) { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; setStored('theme', theme); target.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode'; }
    else if (target.hasAttribute('data-logout')) { await api('/logout', 'POST', {}); renderVersion++; showAuth(false); }
    else if (target.hasAttribute('data-refresh')) await refresh();
    else if (target.dataset.filter) { dashboardFilter = target.dataset.filter; render(); }
    else if (target.dataset.edit) {
      const id = target.dataset.id ?? '', serviceId = target.dataset.service ?? '';
      ({ services: () => editService(id), rules: () => editRule(id, serviceId), cashflows: () => editCashflow(id, serviceId), wallets: () => editWallet(id), counterparties: () => editCounterparty(id), actions: () => editAction(id, serviceId) }[target.dataset.edit] ?? (() => {}))();
    } else if (target.dataset.remove) {
      const message = target.dataset.remove === 'cashflows' ? 'Remove this pending occurrence and stop its recurrence? The ledger retains a skipped record.' : 'Remove this record? Existing events remain. Records referenced by payment history cannot be deleted.';
      if (confirm(message)) { await api(`/${target.dataset.remove}/${target.dataset.id}`, 'DELETE'); toast('Record removed'); await refresh(); }
    } else if (target.dataset.operation) await runOperation(target.dataset.operation as Operation, target.dataset.entity!, target as HTMLButtonElement);
    else if (target.dataset.auditUrl) {
      const token = await api<{ token: string }>('/action-tokens', 'POST', { operation: 'custom_action', entity_id: target.dataset.auditUrl }); await api(`/actions/${token.token}/execute`, 'POST', {});
    } else if (target.hasAttribute('data-seed')) { await api('/demo-seed', 'POST', {}); toast('Demo workspace created'); await refresh(); }
    else if (target.hasAttribute('data-preview')) { const data = await api('/notifications/preview'); const pre = document.getElementById('payload-preview')!; pre.textContent = JSON.stringify(data, null, 2); pre.hidden = false; }
    else if (target.hasAttribute('data-scan')) {
      if (!confirm('Send currently due reminders to all enabled channels now? Previously delivered reminders are deduplicated.')) return;
      (target as HTMLButtonElement).disabled = true;
      try { const report = await api<{ sent: number; failed: number; skipped: number }>('/notifications/run', 'POST', {}); toast(`Sent ${report.sent}; failed ${report.failed}; already handled ${report.skipped}`, report.failed > 0); await refresh(); }
      finally { (target as HTMLButtonElement).disabled = false; }
    } else if (target.dataset.testChannel) { (target as HTMLButtonElement).disabled = true; try { const r = await api<{ message: string }>('/notifications/test', 'POST', { channel: target.dataset.testChannel }); toast(r.message); } finally { (target as HTMLButtonElement).disabled = false; } }
  } catch (error) { failure(error); }
});
document.addEventListener('change', event => {
  const target = event.target as HTMLSelectElement;
  if (target.id === 'horizon') { horizon = Number(target.value); setStored('horizon', String(horizon)); void refresh(); }
  if (target.id === 'cash-status') { cashStatus = target.value; render(); }
  if (target.id === 'cash-direction') { cashDirection = target.value; render(); }
});
document.addEventListener('input', event => {
  const target = event.target as HTMLInputElement;
  if (target.id === 'service-search') { serviceQuery = target.value; document.getElementById('service-list')!.innerHTML = serviceCards(); }
});
document.addEventListener('submit', async event => {
  const form = event.target as HTMLFormElement; if (form.id !== 'notifications-form') return;
  event.preventDefault(); const data = new FormData(form), body = values(data), button = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  for (const key of ['telegram_enabled', 'ntfy_enabled', 'telegram_token_clear', 'ntfy_token_clear']) body[key] = (form.elements.namedItem(key) as HTMLInputElement).checked;
  button.disabled = true;
  try { await api('/settings/notifications', 'PUT', body); toast('Notification settings saved'); await refresh(); }
  catch (error) { failure(error); }
  finally { button.disabled = false; }
});
window.addEventListener('popstate', () => { void refresh(); });
async function boot() {
  try {
    const session = await api<{ authenticated: boolean; setup_required: boolean }>('/session');
    if (location.pathname === '/') history.replaceState({}, '', '/dashboard');
    if (!session.authenticated) showAuth(session.setup_required); else await refresh();
  } catch (error) { root.innerHTML = empty('Cannot reach the server', 'Check that the application is running, then reload this page.'); failure(error); }
}
void boot();
