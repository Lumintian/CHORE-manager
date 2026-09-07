import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import type { ActionLink, ActionResult, CashFlow, Counterparty, Coverage, Event, Input, Obligation, Operation, Rule, Service, ServiceAction, Snapshot, Wallet } from '../shared/types.js';
import { Store } from './store.js';
import { SecretBox, hash, randomToken, type Transport } from './security.js';
import { addDays, AppError, bool, choice, currency, date, daysBetween, decimal, httpUrl, integer, name, nextDate, object, requireThat, text, thresholds, today, units } from './util.js';

type RuleRow = Omit<Rule, 'enabled' | 'remind_before_days'> & { enabled: number; remind_before_days: string };
type CashRow = Omit<CashFlow, 'amount'> & { amount_units: number };
type WalletRow = Omit<Wallet, 'balance'> & { balance_units: number };
type ActionRow = Omit<ServiceAction, 'enabled' | 'method' | 'success_event' | 'configured'> & { enabled: number; secret_config: string };
interface WebhookConfig { url: string; method: string; headers: Record<string, string>; body: unknown; success_event: string }
interface Command { request: { operation: Operation; entity_id: string }; operation: string; entity_id: string; service_id: string; fingerprint: string }
interface Ticket { token_hash: string; command: string; expires_at: string; status: string; result: string | null }
const serviceStates = ['active', 'paused', 'cancelled', 'expired'] as const;
const eventName = (value: unknown, fallback = 'LOGIN') => {
  const result = text(value, 'Event type', fallback, 64).toUpperCase();
  requireThat(/^[A-Z][A-Z0-9_]*$/.test(result), 'Event type must use letters, numbers and underscores'); return result;
};

export class Domain {
  constructor(readonly store: Store, private box: SecretBox, private transport: Transport, readonly clock: () => Date = () => new Date()) {}
  private now() { return this.clock().toISOString(); }
  private write(table: 'services' | 'rules' | 'wallets' | 'cashflows' | 'counterparties' | 'actions', id: string, fields: Record<string, SQLInputValue>) {
    const keys = Object.keys(fields);
    // Table and field names are internal constants; all user values are bound parameters.
    this.store.run(`INSERT INTO ${table}(id,${keys.join(',')}) VALUES(${['id', ...keys].map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(',')}`, id, ...Object.values(fields));
  }
  service(id: string): Service { const row = this.store.get<Service>('SELECT * FROM services WHERE id=?', id); requireThat(row, 'Service not found', 404); return row; }
  rule(id: string): Rule {
    const row = this.store.get<RuleRow>('SELECT * FROM rules WHERE id=?', id); requireThat(row, 'Rule not found', 404);
    return { ...row, enabled: !!row.enabled, remind_before_days: JSON.parse(row.remind_before_days) };
  }
  cashflow(id: string): CashFlow { const row = this.store.get<CashRow>('SELECT * FROM cashflows WHERE id=?', id); requireThat(row, 'Cash flow not found', 404); const { amount_units, ...rest } = row; return { ...rest, amount: decimal(amount_units) }; }
  wallet(id: string): Wallet { const row = this.store.get<WalletRow>('SELECT * FROM wallets WHERE id=?', id); requireThat(row, 'Wallet not found', 404); const { balance_units, ...rest } = row; return { ...rest, balance: decimal(balance_units) }; }
  private actionRow(id: string): ActionRow { const row = this.store.get<ActionRow>('SELECT * FROM actions WHERE id=?', id); requireThat(row, 'Action not found', 404); return row; }
  private actionView(row: ActionRow): ServiceAction {
    const { secret_config, enabled, ...rest } = row;
    const config = secret_config ? this.box.open<WebhookConfig>(secret_config) : undefined;
    return { ...rest, enabled: !!enabled, method: config?.method ?? 'POST', success_event: config?.success_event ?? '', configured: row.kind !== 'webhook' || !!config?.url };
  }
  private checkVersion(input: Input, previous: { version: number } | undefined) {
    if (previous && input.version !== undefined) requireThat(Number(input.version) === previous.version, 'This record changed. Reload before saving.', 409);
  }
  saveService(input: Input, id?: string): Service {
    const old = id ? this.service(id) : undefined; this.checkVersion(input, old); id ??= randomUUID();
    const value = { name: name(input.name ?? old?.name), description: text(input.description, 'Description', old?.description), url: httpUrl(input.url ?? old?.url), status: choice(input.status, serviceStates, old?.status ?? 'active'), category: text(input.category, 'Category', old?.category, 80), notes: text(input.notes, 'Notes', old?.notes), version: (old?.version ?? 0) + 1, created_at: old?.created_at ?? this.now(), updated_at: this.now() };
    this.store.tx(() => { this.write('services', id!, value); this.store.event(id!, value.status === 'cancelled' && old?.status !== 'cancelled' ? 'SERVICE_CANCELLED' : old ? 'SERVICE_UPDATED' : 'SERVICE_CREATED', { name: value.name, status: value.status }, this.now()); });
    return this.service(id);
  }
  saveRule(input: Input, id?: string): Rule {
    const old = id ? this.rule(id) : undefined; this.checkVersion(input, old); id ??= randomUUID();
    const serviceId = text(input.service_id, 'Service', old?.service_id); this.service(serviceId);
    requireThat(!old || old.service_id === serviceId, 'A rule cannot be moved to a different service');
    const type = choice(input.type, ['fixed_expiry', 'interval_since_event', 'extend_by'] as const, old?.type ?? 'fixed_expiry');
    const expiry = type === 'interval_since_event' ? null : date(input.expiry_at ?? old?.expiry_at, 'Expiry');
    const value = { service_id: serviceId, label: name(input.label ?? old?.label ?? (type === 'interval_since_event' ? 'Periodic maintenance' : 'Service expiry'), 'Rule label'), type,
      event_type: eventName(input.event_type, old?.event_type), interval_days: integer(input.interval_days, 'Interval days', old?.interval_days ?? 40), extend_days: integer(input.extend_days, 'Extension days', old?.extend_days ?? 30),
      expiry_at: expiry, anchor_at: date(input.anchor_at ?? old?.anchor_at ?? today(this.clock()), 'Fallback start date'), enabled: bool(input.enabled, old?.enabled ?? true) ? 1 : 0,
      remind_before_days: JSON.stringify(thresholds(input.remind_before_days ?? old?.remind_before_days)), version: (old?.version ?? 0) + 1 };
    this.store.tx(() => { this.write('rules', id!, value); this.store.event(serviceId, old ? 'RULE_UPDATED' : 'RULE_CREATED', { rule_id: id, type }, this.now()); });
    return this.rule(id);
  }
  deleteRule(id: string) {
    const r = this.rule(id);
    this.store.tx(() => { this.store.run('UPDATE actions SET enabled=0,version=version+1 WHERE rule_id=?', id); this.store.run('DELETE FROM rules WHERE id=?', id); this.store.event(r.service_id, 'RULE_DELETED', { rule_id: id }, this.now()); });
  }
  saveCounterparty(input: Input, id?: string): Counterparty {
    const old = id ? this.store.get<Counterparty>('SELECT * FROM counterparties WHERE id=?', id) : undefined;
    requireThat(!id || old, 'Counterparty not found', 404); id ??= randomUUID();
    const value = { name: name(input.name ?? old?.name), notes: text(input.notes, 'Notes', old?.notes) };
    this.store.tx(() => { this.write('counterparties', id!, value); this.store.event(null, old ? 'COUNTERPARTY_UPDATED' : 'COUNTERPARTY_CREATED', { counterparty_id: id, name: value.name }, this.now()); });
    return { id, ...value };
  }
  deleteCounterparty(id: string) {
    requireThat(!this.store.get('SELECT id FROM cashflows WHERE counterparty_id=? LIMIT 1', id), 'Counterparty is used by payment history. Keep it or rename it.', 409);
    this.store.run('DELETE FROM counterparties WHERE id=?', id); this.store.event(null, 'COUNTERPARTY_DELETED', { counterparty_id: id }, this.now());
  }
  saveWallet(input: Input, id?: string): Wallet {
    const old = id ? this.wallet(id) : undefined; id ??= randomUUID();
    if (old && input.expected_balance !== undefined) requireThat(units(input.expected_balance, true) === units(old.balance, true), 'Balance changed. Reload before saving.', 409);
    const cur = currency(input.currency ?? old?.currency);
    if (old && cur !== old.currency) requireThat(!this.store.get('SELECT id FROM cashflows WHERE wallet_id=? LIMIT 1', id), 'Cannot change currency of a wallet used by payment history', 409);
    const value = { name: name(input.name ?? old?.name), currency: cur, balance_units: units(input.balance ?? old?.balance ?? '0', true), notes: text(input.notes, 'Notes', old?.notes), topup_url: httpUrl(input.topup_url ?? old?.topup_url) };
    this.store.tx(() => { this.write('wallets', id!, value); this.store.event(null, !old || old.balance !== decimal(value.balance_units) ? 'BALANCE_ADJUSTED' : 'WALLET_UPDATED', { wallet_id: id, name: value.name, previous: old?.balance ?? '0.00', balance: decimal(value.balance_units), currency: cur }, this.now()); });
    return this.wallet(id);
  }
  deleteWallet(id: string) {
    this.wallet(id); requireThat(!this.store.get('SELECT id FROM cashflows WHERE wallet_id=? LIMIT 1', id), 'Wallet is used by payment history. It cannot be deleted.', 409);
    this.store.run('DELETE FROM wallets WHERE id=?', id); this.store.event(null, 'WALLET_DELETED', { wallet_id: id }, this.now());
  }
  saveCashflow(input: Input, id?: string): CashFlow {
    const old = id ? this.cashflow(id) : undefined; this.checkVersion(input, old);
    requireThat(!old || old.status === 'pending', 'Only pending cash flows can be edited', 409); id ??= randomUUID();
    const serviceId = text(input.service_id, 'Service', old?.service_id); this.service(serviceId);
    requireThat(!old || old.service_id === serviceId, 'Cash flow history cannot be moved to a different service');
    const direction = choice(input.direction, ['IN', 'OUT'] as const, old?.direction ?? 'OUT');
    const cur = currency(input.currency ?? old?.currency);
    const walletId = text(input.wallet_id, 'Wallet', old?.wallet_id ?? '') || null;
    if (walletId) { const w = this.wallet(walletId); requireThat(direction === 'OUT', 'Only outgoing cash flows can use a funding wallet'); requireThat(cur === w.currency, `Wallet currency is ${w.currency}; currencies are never converted`); }
    const counterpartyId = text(input.counterparty_id, 'Counterparty', old?.counterparty_id ?? '') || null;
    if (counterpartyId) requireThat(this.store.get('SELECT id FROM counterparties WHERE id=?', counterpartyId), 'Counterparty not found', 404);
    const due = date(input.due_at ?? old?.due_at, 'Due date');
    const value = { service_id: serviceId, counterparty_id: counterpartyId, wallet_id: walletId, direction, amount_units: units(input.amount ?? old?.amount), currency: cur, due_at: due,
      recurrence: choice(input.recurrence, ['none', 'monthly', 'yearly', 'days'] as const, old?.recurrence ?? 'none'), interval: integer(input.interval, 'Recurrence interval', old?.interval ?? 1, 1, 365),
      anchor_at: old?.due_at === due ? old.anchor_at : due, series_id: old?.series_id ?? randomUUID(), previous_id: old?.previous_id ?? null, status: 'pending', notes: text(input.notes, 'Notes', old?.notes), version: (old?.version ?? 0) + 1 };
    this.store.tx(() => { this.write('cashflows', id!, value); this.store.event(serviceId, old ? 'CASHFLOW_UPDATED' : 'CASHFLOW_CREATED', { cashflow_id: id, amount: decimal(value.amount_units), currency: cur, direction }, this.now()); });
    return this.cashflow(id);
  }
  deleteCashflow(id: string) {
    const c = this.cashflow(id); requireThat(c.status === 'pending', 'Settled payment history cannot be deleted', 409);
    this.store.tx(() => { this.store.run("UPDATE cashflows SET status='skipped',recurrence='none',version=version+1 WHERE id=?", id); this.store.event(c.service_id, 'CASHFLOW_REMOVED', { cashflow_id: id }, this.now()); });
  }
  saveAction(input: Input, id?: string): ServiceAction {
    const old = id ? this.actionRow(id) : undefined; this.checkVersion(input, old); id ??= randomUUID();
    const serviceId = text(input.service_id, 'Service', old?.service_id); this.service(serviceId);
    requireThat(!old || old.service_id === serviceId, 'Action cannot be moved to a different service');
    const kind = choice(input.kind, ['state', 'url', 'webhook'] as const, old?.kind ?? 'url');
    const ruleId = text(input.rule_id, 'Rule', old?.rule_id ?? '') || null;
    if (ruleId) requireThat(this.rule(ruleId).service_id === serviceId, 'Action rule must belong to this service');
    const operation = kind === 'state' ? choice(input.operation, ['mark_login', 'mark_renewed', 'extend_expiry', 'cancel_service'] as const, (old?.operation as 'mark_login') || 'mark_login') : '';
    if (kind === 'state' && operation !== 'cancel_service') {
      requireThat(ruleId, 'Choose the rule affected by this action');
      const rule = this.rule(ruleId);
      requireThat(operation === 'mark_login' ? rule.type === 'interval_since_event' : rule.type !== 'interval_since_event', 'Action does not match rule type');
    }
    let config: WebhookConfig | undefined;
    if (kind === 'webhook') {
      const prior = old?.secret_config ? this.box.open<WebhookConfig>(old.secret_config) : undefined;
      const headers = input.headers === undefined ? prior?.headers ?? {} : object(input.headers);
      requireThat(Object.keys(headers).length <= 20, 'Too many webhook headers');
      for (const [key, value] of Object.entries(headers)) requireThat(/^[A-Za-z0-9-]{1,80}$/.test(key) && !['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'idempotency-key'].includes(key.toLowerCase()) && typeof value === 'string' && value.length <= 2000 && !/[\r\n]/.test(value), 'Invalid or reserved webhook header');
      const method = choice(input.method, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const, (prior?.method as 'POST') ?? 'POST');
      const success = text(input.success_event, 'Success event', prior?.success_event, 64);
      config = { url: httpUrl(input.webhook_url || prior?.url, false), method, headers: headers as Record<string, string>, body: input.body === undefined ? prior?.body ?? {} : input.body, success_event: success ? eventName(success) : '' };
      requireThat(JSON.stringify(config).length <= 16000, 'Webhook configuration is too large');
    }
    const value = { service_id: serviceId, label: name(input.label ?? old?.label, 'Action label'), kind, operation, rule_id: ruleId, url: kind === 'url' ? httpUrl(input.url ?? old?.url, false) : '', secret_config: config ? this.box.seal(config) : '', enabled: bool(input.enabled, old ? !!old.enabled : true) ? 1 : 0, version: (old?.version ?? 0) + 1 };
    this.store.tx(() => { this.write('actions', id!, value); this.store.event(serviceId, old ? 'ACTION_UPDATED' : 'ACTION_CREATED', { action_id: id, kind }, this.now()); });
    return this.actionView(this.actionRow(id));
  }
  deleteAction(id: string) { const a = this.actionRow(id); this.store.run('DELETE FROM actions WHERE id=?', id); this.store.event(a.service_id, 'ACTION_DELETED', { action_id: id }, this.now()); }
  private latestEvent(rule: Rule) { return this.store.get<{ id: string; created_at: string }>('SELECT id,created_at FROM events WHERE service_id=? AND event_type=? ORDER BY created_at DESC,rowid DESC LIMIT 1', rule.service_id, rule.event_type); }
  nextDue(rule: Rule): string {
    return rule.type === 'interval_since_event' ? addDays(this.latestEvent(rule)?.created_at.slice(0, 10) ?? rule.anchor_at, rule.interval_days) : rule.expiry_at!;
  }
  coverage(wallet: Wallet, horizon = 30): Coverage {
    const through = addDays(today(this.clock()), horizon), balance = units(wallet.balance, true);
    const rows = this.store.all<CashRow>("SELECT c.* FROM cashflows c JOIN services s ON s.id=c.service_id WHERE c.wallet_id=? AND c.direction='OUT' AND c.status='pending' AND s.status='active' ORDER BY c.due_at", wallet.id);
    const entries: Coverage['entries'] = []; let truncated = false;
    for (const c of rows) {
      let due: string | null = c.due_at; let index = 0;
      while (due && due <= through) {
        if (entries.length >= 4096) { truncated = true; break; }
        entries.push({ cashflow_id: c.id, due_at: due, amount: decimal(c.amount_units), projected: index > 0 });
        due = nextDate(due, c.recurrence, c.interval, c.anchor_at); index++;
      }
    }
    entries.sort((a, b) => a.due_at.localeCompare(b.due_at) || a.cashflow_id.localeCompare(b.cashflow_id));
    let remaining = balance, first = balance < 0 ? today(this.clock()) : null;
    for (const entry of entries) { remaining -= units(entry.amount); if (remaining < 0 && !first) first = entry.due_at; }
    return { wallet_id: wallet.id, currency: wallet.currency, balance: wallet.balance, required: decimal(balance - remaining), remaining: decimal(remaining), shortfall: decimal(Math.max(0, -remaining)), first_shortfall_at: first, through, truncated, entries };
  }
  snapshot(horizon = 30): Snapshot {
    const day = today(this.clock()), through = addDays(day, horizon);
    const services = this.store.all<Service>('SELECT * FROM services ORDER BY name COLLATE NOCASE');
    const rules = this.store.all<{ id: string }>('SELECT id FROM rules').map(r => { const rule = this.rule(r.id); return { ...rule, next_due: this.nextDue(rule) }; });
    const cashflows = this.store.all<{ id: string }>('SELECT id FROM cashflows ORDER BY due_at,id').map(c => this.cashflow(c.id));
    const wallets = this.store.all<{ id: string }>('SELECT id FROM wallets ORDER BY name').map(w => this.wallet(w.id));
    const counterparties = this.store.all<Counterparty>('SELECT * FROM counterparties ORDER BY name');
    const actions = this.store.all<ActionRow>('SELECT * FROM actions ORDER BY label').map(a => this.actionView(a));
    const events = this.store.all<Omit<Event, 'data'> & { data: string }>('SELECT * FROM events ORDER BY created_at DESC,rowid DESC LIMIT 150').map(e => ({ ...e, data: JSON.parse(e.data) }));
    const coverage = wallets.map(w => this.coverage(w, horizon));
    const active = new Map(services.filter(s => s.status === 'active').map(s => [s.id, s]));
    const obligations: Obligation[] = [];
    const push = (o: Omit<Obligation, 'days' | 'severity'>) => {
      const days = daysBetween(day, o.due_at); obligations.push({ ...o, days, severity: days < 0 ? 'overdue' : days <= 7 ? 'soon' : 'normal' });
    };
    for (const r of rules) {
      const s = active.get(r.service_id); if (!s || !r.enabled || r.next_due > through) continue;
      const links: ActionLink[] = [{ label: r.type === 'interval_since_event' ? (r.event_type === 'LOGIN' ? 'Already logged in' : 'Mark done') : r.type === 'extend_by' ? `Extend ${r.extend_days} days` : 'Mark renewed', operation: r.type === 'interval_since_event' ? 'mark_login' : r.type === 'extend_by' ? 'extend_expiry' : 'mark_renewed', entity_id: r.id }];
      for (const a of actions.filter(a => a.service_id === s.id && a.enabled && a.kind === 'webhook' && (!a.rule_id || a.rule_id === r.id))) links.push({ label: a.label, operation: 'custom_action', entity_id: a.id });
      if (s.url) links.push({ label: 'Open website', url: s.url });
      links.push({ label: 'Stop holding', operation: 'cancel_service', entity_id: s.id });
      push({ key: `rule:${r.id}:${r.version}:${r.next_due}`, type: r.type === 'interval_since_event' ? 'maintenance' : 'expiry', entity_id: r.id, service_id: s.id, title: s.name, detail: `${r.label}${r.type === 'interval_since_event' ? ` - every ${r.interval_days} days since ${r.event_type}` : ''}`, due_at: r.next_due, thresholds: r.remind_before_days, actions: links });
    }
    for (const c of cashflows) {
      const s = active.get(c.service_id); if (!s || c.status !== 'pending' || c.due_at > through) continue;
      const party = counterparties.find(p => p.id === c.counterparty_id)?.name ?? (c.direction === 'IN' ? 'Receivable' : 'Provider');
      push({ key: `cashflow:${c.id}:${c.version}:${c.due_at}`, type: c.direction === 'IN' ? 'receivable' : 'payable', entity_id: c.id, service_id: s.id, title: `${party} / ${s.name}`, detail: `${c.direction === 'IN' ? 'Money to receive' : 'Money to pay'}${c.recurrence !== 'none' ? ` - ${c.recurrence}` : ''}`, due_at: c.due_at, amount: c.amount, currency: c.currency, thresholds: [30, 7, 3, 1], actions: [{ label: c.direction === 'IN' ? 'Mark received' : 'Mark paid', operation: c.direction === 'IN' ? 'mark_cashflow_received' : 'mark_cashflow_paid', entity_id: c.id }, { label: 'Skip this occurrence', operation: 'skip_cashflow', entity_id: c.id }] });
    }
    for (const c of coverage) if (units(c.shortfall) > 0 || c.truncated) {
      const w = wallets.find(w => w.id === c.wallet_id)!;
      push({ key: `wallet:${w.id}:${w.balance}:${c.required}:${c.first_shortfall_at}`, type: 'wallet', entity_id: w.id, service_id: null, title: w.name, detail: c.truncated ? 'Projection exceeds 4096 occurrences; coverage is incomplete. Review old pending payments.' : `Balance does not cover payments through ${c.through}`, due_at: c.first_shortfall_at ?? day, amount: c.shortfall, currency: w.currency, thresholds: [30, 7, 3, 1], actions: [{ label: 'Update balance', route: '/wallets' }, ...(w.topup_url ? [{ label: 'Open top-up page', url: w.topup_url }] : [])] });
    }
    obligations.sort((a, b) => a.due_at.localeCompare(b.due_at) || Number(b.type === 'wallet') - Number(a.type === 'wallet') || a.title.localeCompare(b.title));
    return { today: day, horizon, services, rules, cashflows, wallets, counterparties, actions, events, coverage, obligations };
  }
  private command(operation: Operation, entityId: string): Command {
    const request = { operation, entity_id: entityId };
    if (operation === 'custom_action') {
      const a = this.actionRow(entityId), service = this.service(a.service_id);
      requireThat(a.enabled && service.status === 'active', 'This action or service is inactive', 409);
      if (a.kind === 'state') {
        const resolved = this.command(a.operation as Operation, a.operation === 'cancel_service' ? service.id : a.rule_id ?? '');
        requireThat(resolved.service_id === service.id, 'Action target is not part of this service');
        return { ...resolved, request, fingerprint: `${resolved.fingerprint}:action:${a.id}:${a.version}` };
      }
      let fingerprint = `action:${a.id}:${a.version}:service:${service.version}`;
      if (a.rule_id) { const r = this.rule(a.rule_id); requireThat(r.enabled, 'This action rule is disabled', 409); fingerprint += `:rule:${r.version}:${this.latestEvent(r)?.id ?? r.anchor_at}:${r.expiry_at}`; }
      return { request, operation: a.kind === 'url' ? 'open_url' : 'trigger_webhook', entity_id: a.id, service_id: service.id, fingerprint };
    }
    if (['mark_cashflow_paid', 'mark_cashflow_received', 'skip_cashflow'].includes(operation)) {
      const c = this.cashflow(entityId), s = this.service(c.service_id);
      requireThat(c.status === 'pending', 'This payment has already been processed', 409);
      requireThat(operation === 'skip_cashflow' || (operation === 'mark_cashflow_paid' ? c.direction === 'OUT' : c.direction === 'IN'), 'Action does not match cash flow direction');
      return { request, operation, entity_id: c.id, service_id: s.id, fingerprint: `cashflow:${c.version}:service:${s.version}` };
    }
    if (operation === 'cancel_service') {
      const s = this.service(entityId); requireThat(s.status !== 'cancelled', 'Service is already cancelled', 409);
      return { request, operation, entity_id: s.id, service_id: s.id, fingerprint: `service:${s.version}` };
    }
    requireThat(['mark_login', 'mark_renewed', 'extend_expiry'].includes(operation), 'Unknown action');
    const r = this.rule(entityId), s = this.service(r.service_id);
    requireThat(r.enabled && s.status === 'active', 'This rule or service is inactive', 409);
    requireThat(operation === 'mark_login' ? r.type === 'interval_since_event' : r.type !== 'interval_since_event', 'Action does not match rule type');
    return { request, operation, entity_id: r.id, service_id: s.id, fingerprint: `rule:${r.version}:${r.expiry_at}:${this.latestEvent(r)?.id ?? r.anchor_at}:service:${s.version}` };
  }
  issue(operation: Operation, entityId: string): { token: string; expires_at: string } {
    const command = this.command(operation, entityId), token = randomToken(), expires = new Date(this.clock().valueOf() + 45 * 86400000).toISOString();
    this.store.run('DELETE FROM action_tokens WHERE expires_at < ?', new Date(this.clock().valueOf() - 7 * 86400000).toISOString());
    this.store.run('INSERT INTO action_tokens(token_hash,command,expires_at,created_at) VALUES(?,?,?,?)', hash(token), JSON.stringify(command), expires, this.now());
    return { token, expires_at: expires };
  }
  private apply(command: Command): ActionResult {
    const { operation, entity_id: id, service_id: serviceId } = command;
    let eventId: string, message: string;
    if (operation === 'open_url') {
      const action = this.actionRow(id);
      eventId = this.store.event(serviceId, 'URL_OPENED', { action_id: id }, this.now());
      return { ok: true, message: 'Website opened', event_id: eventId, open_url: action.url };
    }
    if (operation === 'cancel_service') {
      this.store.run("UPDATE services SET status='cancelled',version=version+1,updated_at=? WHERE id=?", this.now(), id);
      eventId = this.store.event(serviceId, 'SERVICE_CANCELLED', {}, this.now()); message = 'Service cancelled. Pending history is preserved; reminders are stopped.';
    } else if (['mark_cashflow_paid', 'mark_cashflow_received', 'skip_cashflow'].includes(operation)) {
      const c = this.cashflow(id), skipped = operation === 'skip_cashflow';
      this.store.run('UPDATE cashflows SET status=?,version=version+1 WHERE id=? AND status=?', skipped ? 'skipped' : 'paid', id, 'pending');
      eventId = this.store.event(serviceId, skipped ? 'PAYMENT_SKIPPED' : c.direction === 'IN' ? 'PAYMENT_RECEIVED' : 'PAYMENT_SENT', { cashflow_id: id, amount: c.amount, currency: c.currency, counterparty_id: c.counterparty_id }, this.now());
      if (!skipped && c.direction === 'OUT' && c.wallet_id) {
        const w = this.wallet(c.wallet_id), balance = units(w.balance, true) - units(c.amount);
        this.store.run('UPDATE wallets SET balance_units=? WHERE id=?', balance, w.id);
        this.store.event(serviceId, 'BALANCE_ADJUSTED', { wallet_id: w.id, cashflow_id: c.id, previous: w.balance, balance: decimal(balance), currency: w.currency }, this.now());
      }
      const next = nextDate(c.due_at, c.recurrence, c.interval, c.anchor_at);
      if (next && this.service(serviceId).status === 'active') {
        const row = this.store.get<CashRow>('SELECT * FROM cashflows WHERE id=?', id)!;
        const { id: _id, ...fields } = row;
        this.write('cashflows', randomUUID(), { ...fields, due_at: next, status: 'pending', previous_id: id, version: 1 });
      }
      message = skipped ? 'Occurrence skipped' : c.direction === 'IN' ? 'Payment received' : 'Payment paid';
    } else {
      const r = this.rule(id), previous = this.nextDue(r);
      if (operation === 'mark_login') {
        eventId = this.store.event(serviceId, r.event_type, { rule_id: r.id, previous_due: previous }, this.now());
        message = `Recorded ${r.event_type}. Next due: ${this.nextDue(r)}`;
      } else {
        const base = operation === 'extend_expiry' ? r.expiry_at! : (r.expiry_at! > today(this.clock()) ? r.expiry_at! : today(this.clock()));
        const expiry = addDays(base, r.extend_days);
        this.store.run('UPDATE rules SET expiry_at=?,version=version+1 WHERE id=?', expiry, r.id);
        eventId = this.store.event(serviceId, operation === 'extend_expiry' ? 'EXTENDED' : 'RENEWED', { rule_id: id, previous_expiry: previous, expiry_at: expiry, days: r.extend_days }, this.now());
        message = `Expiry updated to ${expiry}`;
      }
    }
    return { ok: true, message, event_id: eventId };
  }
  async execute(token: string): Promise<ActionResult> {
    requireThat(/^[A-Za-z0-9_-]{32}$/.test(token), 'Invalid action token', 404);
    const tokenHash = hash(token); let deferred: Command | undefined;
    const immediate = this.store.tx((): ActionResult | null => {
      const ticket = this.store.get<Ticket>('SELECT * FROM action_tokens WHERE token_hash=?', tokenHash);
      requireThat(ticket, 'Action token not found', 404);
      requireThat(ticket.expires_at > this.now(), 'Action token expired. Open the app for a new action.', 410);
      if (ticket.status === 'done' || ticket.status === 'failed') return { ...JSON.parse(ticket.result!), replayed: true };
      requireThat(ticket.status !== 'running', 'This webhook is already running. Do not retry with a new token.', 409);
      const saved = JSON.parse(ticket.command) as Command;
      const current = this.command(saved.request.operation, saved.request.entity_id);
      requireThat(current.fingerprint === saved.fingerprint, 'This notification is out of date. Open the app for the current action.', 409);
      if (current.operation === 'trigger_webhook') {
        this.store.run("UPDATE action_tokens SET status='running' WHERE token_hash=?", tokenHash); deferred = current; return null;
      }
      const result = this.apply(current);
      this.store.run("UPDATE action_tokens SET status='done',result=? WHERE token_hash=?", JSON.stringify(result), tokenHash);
      return result;
    });
    if (immediate) return immediate;
    const command = deferred!; let status: number | null = null; let config: WebhookConfig | undefined;
    try {
      config = this.box.open<WebhookConfig>(this.actionRow(command.entity_id).secret_config);
      const response = await this.transport({ url: config.url, method: config.method, headers: { 'Content-Type': 'application/json', ...config.headers, 'Idempotency-Key': tokenHash }, body: config.method === 'GET' ? '' : JSON.stringify(config.body) });
      status = response.status;
      if (status < 200 || status >= 300) throw new AppError(502, 'Webhook returned a non-success status');
      return this.store.tx(() => {
        const eventId = this.store.event(command.service_id, 'WEBHOOK_TRIGGERED', { action_id: command.entity_id, status }, this.now());
        if (config!.success_event) this.store.event(command.service_id, config!.success_event, { action_id: command.entity_id, source: 'webhook' }, this.now());
        const result: ActionResult = { ok: true, message: 'Webhook completed successfully', event_id: eventId };
        this.store.run("UPDATE action_tokens SET status='done',result=? WHERE token_hash=?", JSON.stringify(result), tokenHash);
        return result;
      });
    } catch {
      return this.store.tx(() => {
        const message = status ? `Webhook returned HTTP ${status}` : 'Webhook failed or timed out. Check the remote job before creating a new attempt.';
        const eventId = this.store.event(command.service_id, 'WEBHOOK_FAILED', { action_id: command.entity_id, status, error: message }, this.now());
        const result: ActionResult = { ok: false, message, event_id: eventId };
        this.store.run("UPDATE action_tokens SET status='failed',result=? WHERE token_hash=?", JSON.stringify(result), tokenHash);
        return result;
      });
    }
  }
  recoverInterruptedWebhooks(): void {
    this.store.tx(() => {
      for (const row of this.store.all<Ticket>("SELECT * FROM action_tokens WHERE status='running'")) {
        const command = JSON.parse(row.command) as Command;
        const eventId = this.store.event(command.service_id, 'WEBHOOK_UNCERTAIN', { action_id: command.entity_id }, this.now());
        const result: ActionResult = { ok: false, message: 'Server restarted during this webhook. Outcome is unknown; check the remote job.', event_id: eventId };
        this.store.run("UPDATE action_tokens SET status='failed',result=? WHERE token_hash=?", JSON.stringify(result), row.token_hash);
      }
    });
  }
}
