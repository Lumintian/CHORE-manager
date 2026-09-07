import { randomUUID } from 'node:crypto';
import type { Input, Obligation, PublicSettings } from '../shared/types.js';
import { Domain } from './domain.js';
import { SecretBox, type Transport } from './security.js';
import { AppError, bool, httpUrl, requireThat, text } from './util.js';

type Channel = 'telegram' | 'ntfy';
interface Config {
  telegram_enabled: boolean; telegram_chat_id: string; telegram_token: string;
  ntfy_enabled: boolean; ntfy_server: string; ntfy_topic: string; ntfy_token: string;
}
interface Delivery { id: string; status: string; attempts: number; next_retry_at: string | null }
const defaults: Config = { telegram_enabled: false, telegram_chat_id: '', telegram_token: '', ntfy_enabled: false, ntfy_server: 'https://ntfy.sh', ntfy_topic: '', ntfy_token: '' };
const envNames: Record<keyof Config, string> = { telegram_enabled: 'TELEGRAM_ENABLED', telegram_chat_id: 'TELEGRAM_CHAT_ID', telegram_token: 'TELEGRAM_BOT_TOKEN', ntfy_enabled: 'NTFY_ENABLED', ntfy_server: 'NTFY_SERVER_URL', ntfy_topic: 'NTFY_TOPIC', ntfy_token: 'NTFY_TOKEN' };
export function reminderThreshold(obligation: Obligation): number | null {
  if (obligation.days < 0) return -1;
  if (obligation.days === 0) return 0;
  return obligation.thresholds.filter(n => n >= obligation.days).sort((a, b) => a - b)[0] ?? null;
}

export class Notifications {
  private scanning = false;
  private polling = false;
  private telegramError = '';
  private lastScan = '';
  constructor(readonly domain: Domain, private box: SecretBox, private transport: Transport, readonly appUrl: string, readonly schedulerSeconds = 600, readonly walletHorizon = 30, private env: NodeJS.ProcessEnv = process.env) {}
  private stored(): Config { const value = this.domain.store.setting('notification_config'); return value ? { ...defaults, ...this.box.open<Config>(value) } : { ...defaults }; }
  private effective(base = this.stored()): Config {
    const result = { ...base };
    for (const key of Object.keys(envNames) as (keyof Config)[]) {
      const value = this.env[envNames[key]];
      if (value !== undefined && value !== '') {
        if (key === 'telegram_enabled' || key === 'ntfy_enabled') result[key] = value === 'true';
        else result[key] = value;
      }
    }
    return result;
  }
  private validate(config: Config) {
    if (config.telegram_enabled) {
      requireThat(/^\d+:[A-Za-z0-9_-]+$/.test(config.telegram_token), 'Enter a Telegram Bot API token');
      requireThat(/^-?\d+$/.test(config.telegram_chat_id), 'Telegram requires a numeric chat ID');
    }
    config.ntfy_server = httpUrl(config.ntfy_server, false).replace(/\/$/, '');
    requireThat(!new URL(config.ntfy_server).search && !new URL(config.ntfy_server).hash, 'ntfy server URL cannot have a query or fragment');
    if (config.ntfy_enabled) requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(config.ntfy_topic), 'ntfy topic must contain 1-64 letters, numbers, underscores or hyphens');
  }
  settings(): PublicSettings {
    const c = this.effective();
    return { telegram_enabled: c.telegram_enabled, telegram_chat_id: c.telegram_chat_id, telegram_has_token: !!c.telegram_token, ntfy_enabled: c.ntfy_enabled, ntfy_server: c.ntfy_server, ntfy_topic: c.ntfy_topic, ntfy_has_token: !!c.ntfy_token, env_overrides: Object.values(envNames).filter(k => this.env[k] !== undefined && this.env[k] !== ''), app_url: this.appUrl, scheduler_seconds: this.schedulerSeconds, wallet_horizon: this.walletHorizon, telegram_error: this.telegramError, last_scan: this.lastScan };
  }
  save(input: Input): PublicSettings {
    const old = this.stored();
    const result: Config = {
      telegram_enabled: bool(input.telegram_enabled, old.telegram_enabled), telegram_chat_id: text(input.telegram_chat_id, 'Telegram chat ID', old.telegram_chat_id, 100),
      telegram_token: input.telegram_token_clear === true ? '' : text(input.telegram_token, 'Telegram token', '', 256) || old.telegram_token,
      ntfy_enabled: bool(input.ntfy_enabled, old.ntfy_enabled), ntfy_server: httpUrl(input.ntfy_server ?? old.ntfy_server, false).replace(/\/$/, ''),
      ntfy_topic: text(input.ntfy_topic, 'ntfy topic', old.ntfy_topic, 64), ntfy_token: input.ntfy_token_clear === true ? '' : text(input.ntfy_token, 'ntfy token', '', 2048) || old.ntfy_token
    };
    this.validate(this.effective(result));
    this.domain.store.tx(() => { this.domain.store.setSetting('notification_config', this.box.seal(result)); this.domain.store.event(null, 'NOTIFICATION_SETTINGS_UPDATED', {}, this.domain.clock().toISOString()); });
    return this.settings();
  }
  private candidates(): Obligation[] {
    const all = this.domain.snapshot(365).obligations.filter(o => o.type !== 'wallet');
    return [...all, ...this.domain.snapshot(this.walletHorizon).obligations.filter(o => o.type === 'wallet')].filter(o => reminderThreshold(o) !== null).sort((a, b) => a.days - b.days);
  }
  payload(channel: Channel, obligation: Obligation, preview = false): Record<string, unknown> {
    const config = this.effective();
    const textBody = `${obligation.title}\n${obligation.detail}\n${obligation.days < 0 ? `${-obligation.days} days overdue` : obligation.days === 0 ? 'Due today' : `Due in ${obligation.days} days`} (${obligation.due_at})${obligation.amount ? `\n${obligation.type === 'wallet' ? 'Shortfall: ' : ''}${obligation.amount} ${obligation.currency}` : ''}`;
    const buttons = obligation.actions.slice(0, 3).map(action => {
      const url = action.url || (action.route ? new URL(action.route, this.appUrl).toString() : '');
      if (url) return channel === 'telegram' ? { text: action.label, url } : { action: 'view', label: action.label, url };
      const token = preview ? 'PREVIEW_TOKEN_NOT_EXECUTABLE_00000' : this.domain.issue(action.operation!, action.entity_id!).token;
      return channel === 'telegram' ? { text: action.label, callback_data: `a:${token}` } : { action: 'http', label: action.label, url: new URL(`/api/actions/${token}/execute`, this.appUrl).toString(), method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', clear: true };
    });
    if (channel === 'telegram') return { chat_id: config.telegram_chat_id, text: textBody, reply_markup: { inline_keyboard: buttons.map(button => [button]) } };
    return { topic: config.ntfy_topic, title: obligation.title, message: textBody, priority: obligation.days < 0 ? 5 : 3, tags: [obligation.type === 'wallet' ? 'warning' : 'calendar'], actions: buttons };
  }
  preview() {
    return this.candidates().slice(0, 20).map(obligation => ({ title: obligation.title, threshold: reminderThreshold(obligation), telegram: this.payload('telegram', obligation, true), ntfy: this.payload('ntfy', obligation, true) }));
  }
  private async telegram(method: string, payload: unknown, config = this.effective()): Promise<unknown> {
    requireThat(config.telegram_token, 'Telegram token is not configured');
    const response = await this.transport({ url: `https://api.telegram.org/bot${config.telegram_token}/${method}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    requireThat(response.status >= 200 && response.status < 300, 'Telegram HTTP request failed', 502);
    let body: { ok?: boolean; result?: unknown };
    try { body = JSON.parse(response.body); } catch { throw new AppError(502, 'Invalid Telegram response'); }
    requireThat(body.ok === true, 'Telegram rejected the request; check bot configuration', 502);
    return body.result;
  }
  private async send(channel: Channel, payload: Record<string, unknown>, config: Config) {
    if (channel === 'telegram') { await this.telegram('sendMessage', payload, config); return; }
    const response = await this.transport({ url: `${config.ntfy_server.replace(/\/$/, '')}/`, headers: { 'Content-Type': 'application/json', ...(config.ntfy_token ? { Authorization: `Bearer ${config.ntfy_token}` } : {}) }, body: JSON.stringify(payload) });
    requireThat(response.status >= 200 && response.status < 300, 'ntfy HTTP request failed', 502);
  }
  private claim(key: string, channel: Channel, threshold: number): string | null {
    const now = this.domain.clock().toISOString();
    return this.domain.store.tx(() => {
      const old = this.domain.store.get<Delivery>('SELECT * FROM notification_logs WHERE entity_key=? AND channel=? AND threshold=?', key, channel, threshold);
      if (old && (old.status === 'sent' || old.attempts >= 3 || (old.next_retry_at && old.next_retry_at > now))) return null;
      const lease = new Date(this.domain.clock().valueOf() + 15 * 60_000).toISOString();
      if (old) { this.domain.store.run("UPDATE notification_logs SET status='pending',attempts=attempts+1,next_retry_at=? WHERE id=?", lease, old.id); return old.id; }
      const id = randomUUID();
      this.domain.store.run("INSERT INTO notification_logs(id,entity_key,channel,threshold,status,next_retry_at,created_at) VALUES(?,?,?,?,'pending',?,?)", id, key, channel, threshold, lease, now);
      return id;
    });
  }
  async run(): Promise<{ sent: number; failed: number; skipped: number; busy?: boolean }> {
    if (this.scanning) return { sent: 0, failed: 0, skipped: 0, busy: true };
    this.scanning = true; const report = { sent: 0, failed: 0, skipped: 0 };
    try {
      const config = this.effective(); this.validate(config);
      const channels: Channel[] = (['telegram', 'ntfy'] as const).filter(c => config[`${c}_enabled`]);
      if (!channels.length) return report;
      let processed = 0;
      for (const obligation of this.candidates()) for (const channel of channels) {
        if (processed >= 50) return report;
        const id = this.claim(obligation.key, channel, reminderThreshold(obligation)!);
        if (!id) { report.skipped++; continue; }
        processed++;
        try {
          await this.send(channel, this.payload(channel, obligation), config);
          this.domain.store.run("UPDATE notification_logs SET status='sent',sent_at=?,next_retry_at=NULL,error=NULL WHERE id=?", this.domain.clock().toISOString(), id); report.sent++;
        } catch {
          // Never persist provider response bodies, URLs, headers, tokens or raw exception strings.
          const row = this.domain.store.get<Delivery>('SELECT attempts FROM notification_logs WHERE id=?', id)!;
          this.domain.store.run("UPDATE notification_logs SET status='failed',error=?,next_retry_at=? WHERE id=?", 'Delivery failed; verify credentials, network and provider configuration', new Date(this.domain.clock().valueOf() + row.attempts * 10 * 60_000).toISOString(), id); report.failed++;
        }
      }
      return report;
    } finally { this.lastScan = this.domain.clock().toISOString(); this.scanning = false; }
  }
  logs() { return this.domain.store.all('SELECT * FROM notification_logs ORDER BY created_at DESC LIMIT 50'); }
  async test(channel: Channel) {
    const config = this.effective(); this.validate(config);
    requireThat(channel === 'telegram' ? config.telegram_token && config.telegram_chat_id : config.ntfy_topic, 'Configure this channel before testing');
    const payload = channel === 'telegram' ? { chat_id: config.telegram_chat_id, text: 'Lifecycle test notification. Connection is working.' } : { topic: config.ntfy_topic, title: 'Lifecycle', message: 'Test notification. Connection is working.' };
    await this.send(channel, payload, config); return { ok: true, message: 'Test notification sent' };
  }
  async pollTelegram(): Promise<void> {
    const config = this.effective(); if (this.polling || !config.telegram_enabled) return;
    this.polling = true;
    try {
      const offset = Number(this.domain.store.setting('telegram_offset') ?? '0');
      const result = await this.telegram('getUpdates', { offset, limit: 20, timeout: 0, allowed_updates: ['callback_query'] }, config);
      requireThat(Array.isArray(result), 'Invalid Telegram updates', 502);
      for (const update of result as { update_id: number; callback_query?: { id: string; data?: string; message?: { chat: { id: number } } } }[]) {
        if (!Number.isSafeInteger(update.update_id)) continue;
        const callback = update.callback_query;
        try {
          if (callback) {
            let answer = 'This action is not authorized for this chat.';
            if (String(callback.message?.chat.id) === config.telegram_chat_id && /^a:[A-Za-z0-9_-]{32}$/.test(callback.data ?? '')) {
              try { answer = (await this.domain.execute(callback.data!.slice(2))).message; }
              catch (error) { answer = error instanceof AppError ? error.message : 'Action could not be completed'; }
            }
            await this.telegram('answerCallbackQuery', { callback_query_id: callback.id, text: answer.slice(0, 190) }, config);
          }
        } finally { this.domain.store.setSetting('telegram_offset', String(update.update_id + 1)); }
      }
      this.telegramError = '';
    } catch { this.telegramError = 'Telegram polling failed. Check credentials, network, and that no other bot poller or webhook is active.'; }
    finally { this.polling = false; }
  }
  get busy() { return this.scanning || this.polling; }
}
