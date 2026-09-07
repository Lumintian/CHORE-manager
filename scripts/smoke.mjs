// Run only against a disposable, freshly seeded instance: this exercises real mutations.
import assert from 'node:assert/strict';
const base = (process.env.SMOKE_URL ?? 'http://localhost:3210').replace(/\/$/, '');
const password = process.env.SMOKE_PASSWORD;
if (!password || password.length < 12) throw new Error('Set SMOKE_PASSWORD (12+ characters) for a disposable test instance');
let cookie = '';
async function request(path, method = 'GET', body, expected = 200, authenticated = true) {
  const response = await fetch(base + path, { method, redirect: 'manual', headers: {
    'Content-Type': 'application/json', 'X-App-Request': 'chore', Origin: base,
    ...(authenticated && cookie ? { Cookie: cookie } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal(response.status, expected, `${method} ${path}: ${response.status}`);
  const header = response.headers.get('set-cookie'); if (header) cookie = header.split(';')[0];
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response.text();
}
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
assert.deepEqual(await request('/healthz'), { status: 'ok' });
await request('/api/snapshot', 'GET', undefined, 401, false);
const session = await request('/api/session');
await request(session.setup_required ? '/api/setup' : '/api/login', 'POST', { password }, session.setup_required ? 201 : 200);
let state = await request('/api/snapshot?horizon=30');
if (!state.services.length) { await request('/api/demo-seed', 'POST', {}, 201); state = await request('/api/snapshot?horizon=30'); }
assert.equal(state.coverage.find(c => c.currency === 'TRY').shortfall, '38.00');
const pt = state.rules.find(r => r.type === 'interval_since_event');
assert.equal(pt.next_due, addDays(state.today, 5));
const extend = state.rules.find(r => r.type === 'extend_by');
const received = state.cashflows.find(c => c.direction === 'IN' && c.currency === 'CNY');
const execute = async (operation, entity_id) => {
  const { token } = await request('/api/action-tokens', 'POST', { operation, entity_id }, 201);
  const first = await request(`/api/actions/${token}/execute`, 'POST', {}, 200, false);
  const again = await request(`/api/actions/${token}/execute`, 'POST', {}, 200, false);
  assert.equal(again.replayed, true); assert.equal(first.event_id, again.event_id);
};
await execute('mark_login', pt.id);
await execute('extend_expiry', extend.id);
await execute('mark_cashflow_received', received.id);
state = await request('/api/snapshot?horizon=30');
assert.equal(state.rules.find(r => r.id === pt.id).next_due, addDays(state.today, 40));
assert.equal(state.rules.find(r => r.id === extend.id).expiry_at, addDays(extend.expiry_at, 30));
assert.equal(state.cashflows.find(c => c.id === received.id).status, 'paid');
assert.equal(state.cashflows.filter(c => c.previous_id === received.id).length, 1);
assert.equal(state.events.filter(e => e.event_type === 'PAYMENT_RECEIVED' && e.data.cashflow_id === received.id).length, 1);
assert.ok(!state.obligations.some(o => o.entity_id === received.id));
const service = await request('/api/services', 'POST', { name: 'HTTP smoke service' }, 201);
await request(`/api/services/${service.id}`, 'PUT', { name: 'HTTP smoke edited', version: service.version });
const party = await request('/api/counterparties', 'POST', { name: 'Smoke party' }, 201);
const wallet = await request('/api/wallets', 'POST', { name: 'Smoke wallet', currency: 'USD', balance: '2.00' }, 201);
await request(`/api/wallets/${wallet.id}`, 'PUT', { balance: '3.50', expected_balance: '2.00' });
await request(`/api/wallets/${wallet.id}`, 'DELETE');
await request(`/api/counterparties/${party.id}`, 'DELETE');
await request(`/api/services/${service.id}`, 'DELETE');
const settings = await request('/api/settings/notifications');
assert.equal('telegram_token' in settings, false); assert.equal('ntfy_token' in settings, false);
const preview = await request('/api/notifications/preview'); assert.ok(preview);
await request('/api/notifications/logs');
for (const path of ['/dashboard', '/services', `/services/${pt.service_id}`, '/cashflows', '/wallets', '/counterparties', '/settings/notifications']) {
  assert.match(await request(path), /<div id="app"/);
}
assert.match(await request('/assets/app.js'), /Action Center/);
assert.match(await request('/assets/styles.css'), /dark/);
await request('/server/security.ts', 'GET', undefined, 404);
await request('/api/logout', 'POST', {});
await request('/api/snapshot', 'GET', undefined, 401);
console.log('HTTP smoke passed: authentication, all pages/assets, five demo scenarios, action replay, CRUD, secret masking, preview, logout.');
