import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Store } from '../server/store.js';
import { Domain } from '../server/domain.js';
import { Auth, SecretBox, hash, makeTransport, publicAddress, type OutboundRequest, type Transport } from '../server/security.js';
import { Notifications, reminderThreshold } from '../server/notifications.js';
import { addDays, date, decimal, nextDate, units } from '../server/util.js';
import { seedDemo } from '../server/seed.js';
import { createApp } from '../server/http.js';

function fixture(t: TestContext, handler?: Transport) {
  let now = new Date('2026-09-07T07:00:00Z'); const store = new Store(), box = new SecretBox(Buffer.alloc(32, 7));
  const calls: OutboundRequest[] = [];
  const transport: Transport = async req => { calls.push(req); return handler ? handler(req) : { status: 200, body: JSON.stringify({ ok: true, result: req.url.endsWith('/getUpdates') ? [] : { message_id: 1 } }) }; };
  const domain = new Domain(store, box, transport, () => now);
  const notifications = new Notifications(domain, box, transport, 'https://chore.example', 600, 30, {});
  t.after(() => store.close());
  return { domain, store, box, calls, notifications, advance: (milliseconds: number) => { now = new Date(now.valueOf() + milliseconds); } };
}
const enabledTelegram = { telegram_enabled: true, telegram_chat_id: '42', telegram_token: '123456:TEST_SERVER_SIDE_TOKEN' };
const count = (s: Store, type: string) => s.get<{ n: number }>('SELECT COUNT(*) n FROM events WHERE event_type=?', type)!.n;

test('UTC interval example: August 20 plus 40 days is September 29', () => {
  assert.equal(addDays('2026-08-20', 40), '2026-09-29');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.throws(() => date('2026-02-30'), /valid date/);
});
test('monthly and yearly recurrences preserve their original calendar anchor', () => {
  assert.equal(nextDate('2026-01-31', 'monthly', 1, '2026-01-31'), '2026-02-28');
  assert.equal(nextDate('2026-02-28', 'monthly', 1, '2026-01-31'), '2026-03-31');
  assert.equal(nextDate('2027-02-28', 'yearly', 1, '2024-02-29'), '2028-02-29');
  assert.equal(nextDate('2026-09-07', 'days', 40, '2026-09-07'), '2026-10-17');
  assert.equal(nextDate('2026-09-07', 'none', 1, '2026-09-07'), null);
});
test('money uses fixed-point arithmetic and refuses hidden rounding', () => {
  assert.equal(decimal(units('0.1') + units('0.2')), '0.30');
  assert.equal(decimal(units('1.0001')), '1.0001');
  assert.equal(decimal(units('-3.1', true)), '-3.10');
  assert.throws(() => units('1.00001'), /decimal/);
  assert.throws(() => units('-5'), /decimal/);
});
test('a service requires only a name; SQL-looking names remain data', t => {
  const f = fixture(t), s = f.domain.saveService({ name: "minimal'); DROP TABLE services; --" });
  assert.equal(s.status, 'active'); assert.equal(s.url, ''); assert.equal(f.domain.snapshot().services.length, 1);
  assert.throws(() => f.domain.saveService({ name: 'unsafe', url: 'javascript:alert(1)' }), /HTTP/);
});
test('interval rules derive from events, with an explicit fallback anchor', t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'PT' });
  const rule = f.domain.saveRule({ service_id: s.id, type: 'interval_since_event', event_type: 'LOGIN', interval_days: 40, anchor_at: '2026-08-01' });
  assert.equal(f.domain.nextDue(rule), '2026-09-10');
  f.store.event(s.id, 'LOGIN', {}, '2026-08-20T12:00:00Z');
  assert.equal(f.domain.nextDue(rule), '2026-09-29');
});
test('demo seed contains all five scenarios and is safe to rerun', t => {
  const f = fixture(t); assert.equal(seedDemo(f.domain), true); const snapshot = f.domain.snapshot();
  assert.equal(snapshot.services.length, 7); assert.equal(snapshot.cashflows.length, 6);
  assert.equal(snapshot.coverage[0].required, '358.00'); assert.equal(snapshot.coverage[0].shortfall, '38.00');
  assert.equal(snapshot.obligations.find(o => o.title === 'PT Example')!.days, 5);
  assert.equal(seedDemo(f.domain), false); assert.equal(f.domain.snapshot().services.length, 7);
});
test('login action changes due time and the same token is idempotent', async t => {
  const f = fixture(t); seedDemo(f.domain);
  const r = f.domain.snapshot().rules.find(r => r.type === 'interval_since_event')!;
  const token = f.domain.issue('mark_login', r.id).token, stale = f.domain.issue('mark_login', r.id).token;
  const result = await f.domain.execute(token), replay = await f.domain.execute(token);
  assert.equal(result.event_id, replay.event_id); assert.equal(replay.replayed, true);
  assert.equal(f.domain.nextDue(f.domain.rule(r.id)), '2026-10-17'); assert.equal(count(f.store, 'LOGIN'), 2);
  assert.equal(f.store.get<{ token_hash: string }>('SELECT token_hash FROM action_tokens WHERE token_hash=?', hash(token))!.token_hash === token, false);
  await assert.rejects(() => f.domain.execute(stale), /out of date/);
});
test('extend adds to existing expiry, not to the current date', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Refresh' });
  const r = f.domain.saveRule({ service_id: s.id, type: 'extend_by', expiry_at: '2026-09-20', extend_days: 30 });
  const a = f.domain.issue('extend_expiry', r.id).token, b = f.domain.issue('extend_expiry', r.id).token;
  await f.domain.execute(a); await f.domain.execute(a);
  assert.equal(f.domain.rule(r.id).expiry_at, '2026-10-20'); assert.equal(count(f.store, 'EXTENDED'), 1);
  await assert.rejects(() => f.domain.execute(b), /out of date/);
});
test('renewal of an expired fixed rule starts from today', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Fixed' });
  const r = f.domain.saveRule({ service_id: s.id, type: 'fixed_expiry', expiry_at: '2026-09-01', extend_days: 30 });
  await f.domain.execute(f.domain.issue('mark_renewed', r.id).token);
  assert.equal(f.domain.rule(r.id).expiry_at, '2026-10-07'); assert.equal(count(f.store, 'RENEWED'), 1);
});
test('receiving a payment preserves the settled occurrence and creates one next occurrence', async t => {
  const f = fixture(t); seedDemo(f.domain);
  const c = f.domain.snapshot().cashflows.find(c => c.direction === 'IN' && c.currency === 'CNY')!;
  const token = f.domain.issue('mark_cashflow_received', c.id).token;
  await f.domain.execute(token); await f.domain.execute(token);
  assert.equal(f.domain.cashflow(c.id).status, 'paid'); assert.equal(count(f.store, 'PAYMENT_RECEIVED'), 1);
  const next = f.domain.snapshot().cashflows.filter(n => n.previous_id === c.id);
  assert.equal(next.length, 1); assert.equal(next[0].due_at, '2026-10-08'); assert.equal(next[0].amount, '180.00'); assert.equal(next[0].currency, 'CNY');
  assert.equal(f.domain.snapshot().obligations.some(o => o.entity_id === c.id), false);
});
test('paying a wallet charge deducts balance once and does not double-count coverage', async t => {
  const f = fixture(t); seedDemo(f.domain);
  const c = f.domain.snapshot().cashflows.find(c => c.wallet_id && c.amount === '59.00')!;
  const token = f.domain.issue('mark_cashflow_paid', c.id).token;
  await f.domain.execute(token); await f.domain.execute(token);
  const coverage = f.domain.snapshot().coverage[0];
  assert.equal(coverage.balance, '261.00'); assert.equal(coverage.required, '299.00'); assert.equal(coverage.shortfall, '38.00'); assert.equal(count(f.store, 'PAYMENT_SENT'), 1);
});
test('wallet coverage projects future recurring occurrences within the horizon', t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Weekly' }), w = f.domain.saveWallet({ name: 'Credit', currency: 'USD', balance: '30' });
  f.domain.saveCashflow({ service_id: s.id, wallet_id: w.id, amount: '10', currency: 'USD', direction: 'OUT', recurrence: 'days', interval: 7, due_at: '2026-09-08' });
  const c = f.domain.coverage(w, 30); assert.equal(c.entries.length, 5); assert.equal(c.shortfall, '20.00'); assert.equal(c.first_shortfall_at, '2026-09-29');
});
test('wallet cannot mix currencies or fund an incoming payment', t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Apple' }), w = f.domain.saveWallet({ name: 'TR', currency: 'TRY', balance: '320' });
  const base = { service_id: s.id, wallet_id: w.id, amount: '10', currency: 'USD', due_at: '2026-09-08' };
  assert.throws(() => f.domain.saveCashflow(base), /Wallet currency/);
  assert.throws(() => f.domain.saveCashflow({ ...base, currency: 'TRY', direction: 'IN' }), /outgoing/);
});
test('skipping a recurring occurrence advances it without touching the wallet', async t => {
  const f = fixture(t); seedDemo(f.domain); const c = f.domain.snapshot().cashflows.find(c => c.wallet_id)!;
  await f.domain.execute(f.domain.issue('skip_cashflow', c.id).token);
  assert.equal(f.domain.cashflow(c.id).status, 'skipped'); assert.equal(f.domain.wallet(c.wallet_id!).balance, '320.00');
  assert.equal(f.domain.snapshot().cashflows.filter(n => n.previous_id === c.id).length, 1);
});
test('cancellation stops derived reminders but permits explicit settlement of old debt', async t => {
  const f = fixture(t); seedDemo(f.domain); const c = f.domain.snapshot().cashflows.find(c => c.direction === 'IN')!;
  const stale = f.domain.issue('mark_cashflow_received', c.id).token;
  await f.domain.execute(f.domain.issue('cancel_service', c.service_id).token);
  assert.equal(f.domain.snapshot().obligations.some(o => o.service_id === c.service_id), false);
  await assert.rejects(() => f.domain.execute(stale), /out of date/);
  await f.domain.execute(f.domain.issue('mark_cashflow_received', c.id).token);
  assert.equal(f.domain.snapshot().cashflows.some(n => n.previous_id === c.id), false);
});
test('editing invalidates old tickets and stale editor versions are rejected', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Example' });
  const r = f.domain.saveRule({ service_id: s.id, type: 'extend_by', expiry_at: '2026-09-20' });
  const token = f.domain.issue('extend_expiry', r.id).token;
  f.domain.saveRule({ expiry_at: '2026-10-01' }, r.id);
  await assert.rejects(() => f.domain.execute(token), /out of date/);
  assert.throws(() => f.domain.saveRule({ version: 1, expiry_at: '2026-12-01' }, r.id), /changed/);
});
test('webhook credentials are encrypted and only a 2xx success emits the configured event', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'PT' });
  const r = f.domain.saveRule({ service_id: s.id, type: 'interval_since_event', interval_days: 40, anchor_at: '2026-08-01' });
  const a = f.domain.saveAction({ service_id: s.id, rule_id: r.id, kind: 'webhook', label: 'Auto login', webhook_url: 'https://automation.example/jobs?key=HIDDEN_QUERY', headers: { Authorization: 'Bearer HIDDEN_HEADER' }, body: { secret: 'HIDDEN_BODY' }, success_event: 'LOGIN' });
  const result = await f.domain.execute(f.domain.issue('custom_action', a.id).token);
  assert.equal(result.ok, true); assert.equal(count(f.store, 'WEBHOOK_TRIGGERED'), 1); assert.equal(count(f.store, 'LOGIN'), 1);
  assert.equal(f.domain.nextDue(r), '2026-10-17'); assert.equal(f.calls[0].headers!.Authorization, 'Bearer HIDDEN_HEADER'); assert.ok(f.calls[0].headers!['Idempotency-Key']);
  const snapshot = JSON.stringify(f.domain.snapshot()); for (const secret of ['HIDDEN_QUERY', 'HIDDEN_HEADER', 'HIDDEN_BODY']) assert.equal(snapshot.includes(secret), false);
  assert.equal(JSON.stringify(f.store.all('SELECT * FROM actions')).includes('HIDDEN_HEADER'), false);
});
test('failed webhook is recorded, never retried by replay, and does not emit LOGIN', async t => {
  const f = fixture(t, async () => ({ status: 503, body: 'SECRET_RESPONSE_BODY' })), s = f.domain.saveService({ name: 'PT' });
  const a = f.domain.saveAction({ service_id: s.id, kind: 'webhook', label: 'Auto', webhook_url: 'https://automation.example', success_event: 'LOGIN' });
  const token = f.domain.issue('custom_action', a.id).token;
  assert.equal((await f.domain.execute(token)).ok, false); assert.equal((await f.domain.execute(token)).replayed, true);
  assert.equal(f.calls.length, 1); assert.equal(count(f.store, 'WEBHOOK_FAILED'), 1); assert.equal(count(f.store, 'LOGIN'), 0);
  assert.equal(JSON.stringify(f.domain.snapshot()).includes('SECRET_RESPONSE_BODY'), false);
});
test('concurrent replay cannot dispatch a second webhook', async t => {
  let release!: (value: { status: number; body: string }) => void;
  const pending = new Promise<{ status: number; body: string }>(resolve => { release = resolve; });
  const f = fixture(t, async () => pending), s = f.domain.saveService({ name: 'Job' });
  const a = f.domain.saveAction({ service_id: s.id, label: 'Run', kind: 'webhook', webhook_url: 'https://automation.example' });
  const token = f.domain.issue('custom_action', a.id).token, first = f.domain.execute(token);
  await assert.rejects(() => f.domain.execute(token), /already running/); release({ status: 204, body: '' });
  assert.equal((await first).ok, true); assert.equal(f.calls.length, 1);
});
test('interrupted webhooks become uncertain instead of being silently rerun', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Job' });
  const a = f.domain.saveAction({ service_id: s.id, label: 'Run', kind: 'webhook', webhook_url: 'https://automation.example' });
  const token = f.domain.issue('custom_action', a.id).token;
  f.store.run("UPDATE action_tokens SET status='running' WHERE token_hash=?", hash(token)); f.domain.recoverInterruptedWebhooks();
  assert.match((await f.domain.execute(token)).message, /Outcome is unknown/); assert.equal(f.calls.length, 0); assert.equal(count(f.store, 'WEBHOOK_UNCERTAIN'), 1);
});
test('expired action tokens cannot change state', async t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Expiry' }), token = f.domain.issue('cancel_service', s.id).token;
  f.advance(46 * 86400000); await assert.rejects(() => f.domain.execute(token), /expired/); assert.equal(f.domain.service(s.id).status, 'active');
});
test('notification settings never expose secrets and environment overrides win', t => {
  const f = fixture(t); f.notifications.save({ ...enabledTelegram, ntfy_token: 'PRIVATE_NTFY_TOKEN' });
  f.notifications.save({ telegram_token: '' }); assert.equal(f.notifications.settings().telegram_has_token, true);
  assert.equal(JSON.stringify(f.notifications.settings()).includes('TEST_SERVER_SIDE_TOKEN'), false);
  assert.equal(f.store.setting('notification_config')!.includes('PRIVATE_NTFY_TOKEN'), false);
  const n = new Notifications(f.domain, f.box, async () => ({ status: 200, body: '{}' }), 'https://app.example', 600, 30, { TELEGRAM_BOT_TOKEN: '999:ENV_TOKEN', TELEGRAM_CHAT_ID: '99' });
  assert.equal(n.settings().telegram_chat_id, '99'); assert.ok(n.settings().env_overrides.includes('TELEGRAM_BOT_TOKEN')); assert.equal(JSON.stringify(n.settings()).includes('ENV_TOKEN'), false);
});
test('preview payloads contain native Telegram/ntfy actions without minting tokens', t => {
  const f = fixture(t); seedDemo(f.domain); const preview = f.notifications.preview();
  assert.ok(preview.length > 0); assert.equal(f.store.all('SELECT * FROM action_tokens').length, 0);
  const pt = preview.find(p => p.title === 'PT Example')!;
  const tg = pt.telegram as { reply_markup: { inline_keyboard: { callback_data?: string; url?: string }[][] } };
  assert.ok(tg.reply_markup.inline_keyboard[0][0].callback_data!.startsWith('a:')); assert.ok(Buffer.byteLength(tg.reply_markup.inline_keyboard[0][0].callback_data!) <= 64);
  const ntfy = pt.ntfy as { actions: { action: string; method?: string; url: string }[] };
  assert.equal(ntfy.actions[0].action, 'http'); assert.equal(ntfy.actions[0].method, 'POST'); assert.match(ntfy.actions[0].url, /^https:\/\/chore.example\/api\/actions\//); assert.ok(ntfy.actions.some(a => a.action === 'view'));
});
test('reminders select only the nearest applicable threshold', t => {
  const f = fixture(t); seedDemo(f.domain); const o = f.domain.snapshot().obligations[0];
  for (const [days, expected] of [[31, null], [20, 30], [5, 7], [2, 3], [1, 1], [0, 0], [-100, -1]] as const) assert.equal(reminderThreshold({ ...o, days, thresholds: [30, 7, 3, 1] }), expected);
});
test('notification deduplication survives reopening a SQLite database', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'chore-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'app.sqlite'), box = new SecretBox(Buffer.alloc(32, 4)); let sends = 0;
  const transport: Transport = async () => { sends++; return { status: 200, body: '{"ok":true,"result":{}}' }; };
  for (let iteration = 0; iteration < 2; iteration++) {
    const store = new Store(path), domain = new Domain(store, box, transport, () => new Date('2026-09-07T07:00:00Z'));
    const n = new Notifications(domain, box, transport, 'https://app.example', 600, 30, {});
    if (!iteration) { seedDemo(domain); n.save({ ...enabledTelegram, ntfy_enabled: true, ntfy_topic: 'private-test-topic' }); }
    const report = await n.run(); assert.equal(report.sent, iteration === 0 ? 20 : 0); store.close();
  }
  assert.equal(sends, 20);
});
test('failed reminder deliveries retry with backoff at most three times', async t => {
  const f = fixture(t, async () => ({ status: 500, body: 'SECRET_ERROR_BODY' })), s = f.domain.saveService({ name: 'Due' });
  f.domain.saveRule({ service_id: s.id, expiry_at: '2026-09-08' }); f.notifications.save(enabledTelegram);
  assert.equal((await f.notifications.run()).failed, 1); assert.equal((await f.notifications.run()).failed, 0);
  f.advance(601000); assert.equal((await f.notifications.run()).failed, 1);
  f.advance(1201000); assert.equal((await f.notifications.run()).failed, 1);
  f.advance(1801000); assert.equal((await f.notifications.run()).failed, 0); assert.equal(f.calls.length, 3);
  assert.equal(JSON.stringify(f.notifications.logs()).includes('SECRET_ERROR_BODY'), false);
});
test('Telegram callback authorizes the configured chat and advances the poll offset', async t => {
  let updates: unknown[] = [];
  const f = fixture(t, async req => ({ status: 200, body: JSON.stringify({ ok: true, result: req.url.endsWith('/getUpdates') ? updates : {} }) }));
  seedDemo(f.domain); f.notifications.save(enabledTelegram); const r = f.domain.snapshot().rules.find(r => r.type === 'interval_since_event')!;
  const token = f.domain.issue('mark_login', r.id).token;
  updates = [{ update_id: 10, callback_query: { id: 'bad', data: `a:${token}`, message: { chat: { id: 999 } } } }];
  await f.notifications.pollTelegram(); assert.equal(count(f.store, 'LOGIN'), 1);
  updates = [{ update_id: 11, callback_query: { id: 'good', data: `a:${token}`, message: { chat: { id: 42 } } } }];
  await f.notifications.pollTelegram(); assert.equal(count(f.store, 'LOGIN'), 2); assert.equal(f.store.setting('telegram_offset'), '12');
  assert.equal(JSON.parse(f.calls.at(-1)!.body!).callback_query_id, 'good');
});
test('private, mapped, metadata and reserved addresses are blocked', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.2', '172.16.0.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true, address);
});
test('outbound client blocks local targets by default and never follows redirects', async () => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(302, { Location: '/other' }); res.end('redirect'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address() as { port: number };
  try {
    const url = `http://127.0.0.1:${address.port}/`;
    await assert.rejects(() => makeTransport()( { url } ), /blocked/); assert.equal(requests, 0);
    assert.equal((await makeTransport(true)({ url })).status, 302); assert.equal(requests, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('password setup, session hashing and logout', t => {
  const f = fixture(t), auth = new Auth(f.store); assert.equal(auth.needsSetup(), true);
  assert.throws(() => auth.setup('short'), /12-256/); auth.setup('a-long-test-password');
  assert.throws(() => auth.setup('another-long-password'), /already/); assert.throws(() => auth.login('bad', 'test'), /Invalid/);
  const token = auth.login('a-long-test-password', 'test'); assert.equal(auth.valid(token), true);
  assert.equal(JSON.stringify(f.store.all('SELECT * FROM sessions')).includes(token), false); auth.logout(token); assert.equal(auth.valid(token), false);
});
test('HTTP API enforces login, CSRF, bounded JSON and server-bound token context', async t => {
  const f = fixture(t), auth = new Auth(f.store), server = createApp(f.domain, f.notifications, auth, 'http://localhost:3210');
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; let session = '';
  const request = async (path: string, method = 'GET', data?: unknown, extra: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-App-Request': 'chore', Cookie: session, ...extra }, ...(data === undefined ? {} : { body: typeof data === 'string' ? data : JSON.stringify(data) }) });
    const c = r.headers.get('set-cookie'); if (c) session = c.split(';')[0]; return r;
  };
  try {
    assert.equal((await request('/healthz')).status, 200); assert.equal((await request('/api/snapshot')).status, 401);
    assert.equal((await request('/api/setup', 'POST', { password: 'valid-test-password' }, { 'X-App-Request': '' })).status, 403);
    assert.equal((await request('/api/setup', 'POST', { password: 'valid-test-password' }, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/setup', 'POST', { password: 'valid-test-password' })).status, 201); assert.ok(session);
    assert.ok(session.startsWith('chore_session='));
    assert.equal((await request('/api/services', 'POST', '{')).status, 400);
    assert.equal((await request('/api/services', 'POST', { name: 'x'.repeat(70000) })).status, 413);
    const service = await (await request('/api/services', 'POST', { name: 'HTTP test' })).json() as { id: string };
    const rule = await (await request('/api/rules', 'POST', { service_id: service.id, type: 'interval_since_event', interval_days: 40 })).json() as { id: string };
    const token = await (await request('/api/action-tokens', 'POST', { operation: 'mark_login', entity_id: rule.id })).json() as { token: string };
    session = '';
    assert.equal((await request(`/api/actions/${token.token}/execute`, 'GET')).status, 405);
    const executed = await request(`/api/actions/${token.token}/execute`, 'POST', { entity_id: 'an-attacker-chosen-id', operation: 'cancel_service' }, { 'X-App-Request': '' });
    assert.equal(executed.status, 200); assert.equal(f.domain.service(service.id).status, 'active'); assert.equal(count(f.store, 'LOGIN'), 1);
    assert.equal((await request('/api/snapshot')).status, 401);
  } finally { server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('changing or removing the environment password revokes existing sessions', t => {
  const f = fixture(t), first = new Auth(f.store, 'first-environment-password');
  const token = first.login('first-environment-password', 'local');
  assert.equal(new Auth(f.store, 'first-environment-password').valid(token), true);
  const changed = new Auth(f.store, 'different-environment-password');
  assert.equal(changed.valid(token), false);
  const second = changed.login('different-environment-password', 'local');
  assert.equal(new Auth(f.store).valid(second), false);
});
test('stale balance edits cannot overwrite a payment made in another tab', async t => {
  const f = fixture(t); seedDemo(f.domain);
  const w = f.domain.snapshot().wallets[0], c = f.domain.snapshot().cashflows.find(c => c.wallet_id === w.id)!;
  await f.domain.execute(f.domain.issue('mark_cashflow_paid', c.id).token);
  assert.throws(() => f.domain.saveWallet({ balance: '500', expected_balance: w.balance }, w.id), /Balance changed/);
});
test('invalid state-action and rule combinations are rejected when saved', t => {
  const f = fixture(t), s = f.domain.saveService({ name: 'Rule validation' });
  const r = f.domain.saveRule({ service_id: s.id, expiry_at: '2026-09-20' });
  assert.throws(() => f.domain.saveAction({ service_id: s.id, label: 'Wrong', kind: 'state', operation: 'mark_login', rule_id: r.id }), /rule type/);
});
test('blank Compose notification variables leave UI configuration usable', t => {
  const f = fixture(t);
  f.notifications.save(enabledTelegram);
  const n = new Notifications(f.domain, f.box, async () => ({ status: 200, body: '{}' }), 'https://example.org', 600, 30, { TELEGRAM_ENABLED: '', TELEGRAM_BOT_TOKEN: '', NTFY_SERVER_URL: '' });
  assert.equal(n.settings().telegram_enabled, true);
  assert.equal(n.settings().telegram_has_token, true);
  assert.deepEqual(n.settings().env_overrides, []);
});
