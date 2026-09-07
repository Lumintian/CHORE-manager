import type { Domain } from './domain.js';
import { addDays, today } from './util.js';

export function seedDemo(domain: Domain): boolean {
  if (domain.store.setting('demo_seeded') || domain.store.get('SELECT id FROM services LIMIT 1')) return false;
  domain.store.tx(() => {
    const day = today(domain.clock());
    const claude = domain.saveService({ name: 'Claude Max', category: 'AI', description: 'One subscription, three independent cash flows. No currency conversion.', url: 'https://claude.ai/' });
    const netflix = domain.saveService({ name: 'Netflix', category: 'Entertainment', description: 'My share of a service held by someone else.', url: 'https://www.netflix.com/' });
    const music = domain.saveService({ name: 'Apple Music', category: 'Entertainment' });
    const cloud = domain.saveService({ name: 'iCloud', category: 'Storage' });
    const pt = domain.saveService({ name: 'PT Example', category: 'Maintenance', description: 'Log in at least once every 40 days. This is not a subscription.', url: 'https://example.org/', notes: 'Demo URL and disabled automation are placeholders; configure your own server before use.' });
    const refresh = domain.saveService({ name: 'Refreshable Service', category: 'Access', description: 'A successful refresh adds 30 days to the existing expiry.' });
    const zhang = domain.saveCounterparty({ name: '\u5f20\u4e09' });
    const peter = domain.saveCounterparty({ name: 'Peter' });
    const li = domain.saveCounterparty({ name: '\u674e\u56db' });
    const wallet = domain.saveWallet({ name: 'Apple TR Balance', currency: 'TRY', balance: '320', topup_url: 'https://www.apple.com/tr/app-store/', notes: 'Prepaid Apple ID balance. Upcoming charges total 358 TRY.' });
    const cash = (service_id: string, direction: string, amount: string, currency: string, days: number, extra: Record<string, unknown> = {}) => domain.saveCashflow({ service_id, direction, amount, currency, due_at: addDays(day, days), recurrence: 'monthly', ...extra });
    cash(claude.id, 'OUT', '100', 'USD', 3);
    cash(claude.id, 'IN', '180', 'CNY', 1, { counterparty_id: zhang.id });
    cash(claude.id, 'IN', '30', 'USD', 2, { counterparty_id: peter.id });
    cash(netflix.id, 'OUT', '30', 'CNY', 2, { counterparty_id: li.id });
    cash(music.id, 'OUT', '59', 'TRY', 2, { wallet_id: wallet.id });
    cash(cloud.id, 'OUT', '299', 'TRY', 4, { wallet_id: wallet.id });
    const loginRule = domain.saveRule({ service_id: pt.id, label: 'Keep account active', type: 'interval_since_event', interval_days: 40, event_type: 'LOGIN' });
    domain.store.event(pt.id, 'LOGIN', { source: 'demo' }, new Date(domain.clock().valueOf() - 35 * 86400000).toISOString());
    domain.saveAction({ service_id: pt.id, label: 'Open PT website', kind: 'url', url: 'https://example.org/' });
    domain.saveAction({ service_id: pt.id, rule_id: loginRule.id, label: 'Automatic login (configure first)', kind: 'webhook', webhook_url: 'https://example.invalid/jobs/pt-login', method: 'POST', body: { job: 'pt-login' }, success_event: 'LOGIN', enabled: false });
    domain.saveRule({ service_id: refresh.id, label: 'Refresh access', type: 'extend_by', expiry_at: addDays(day, 10), extend_days: 30 });
    const domainName = domain.saveService({ name: 'Example domain', category: 'Domain', description: 'An overdue fixed-expiry example. No payment fields required.' });
    domain.saveRule({ service_id: domainName.id, label: 'Review domain expiry', type: 'fixed_expiry', expiry_at: addDays(day, -2), extend_days: 365 });
    domain.store.setSetting('demo_seeded', 'true');
  });
  return true;
}
