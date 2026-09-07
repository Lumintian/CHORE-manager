import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// A single synchronous connection keeps small state changes atomic. Never await in tx().
export class Store {
  readonly db: DatabaseSync;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    const version = Number(this.get<{ user_version: number }>('PRAGMA user_version')?.user_version);
    if (version > 1) throw new Error('Database schema is newer than this application');
    if (version === 0) this.tx(() => {
      this.db.exec(`
        CREATE TABLE services (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
          url TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('active','paused','cancelled','expired')),
          category TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE counterparties (id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '');
        CREATE TABLE wallets (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, balance_units INTEGER NOT NULL,
          notes TEXT NOT NULL DEFAULT '', topup_url TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE rules (
          id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id), label TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN ('fixed_expiry','interval_since_event','extend_by')),
          event_type TEXT NOT NULL DEFAULT 'LOGIN', interval_days INTEGER NOT NULL DEFAULT 40,
          extend_days INTEGER NOT NULL DEFAULT 30, expiry_at TEXT, anchor_at TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1, remind_before_days TEXT NOT NULL DEFAULT '[30,7,3,1]',
          version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE cashflows (
          id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id),
          counterparty_id TEXT REFERENCES counterparties(id), wallet_id TEXT REFERENCES wallets(id),
          direction TEXT NOT NULL CHECK(direction IN ('IN','OUT')), amount_units INTEGER NOT NULL CHECK(amount_units >= 0),
          currency TEXT NOT NULL, due_at TEXT NOT NULL, recurrence TEXT NOT NULL,
          interval INTEGER NOT NULL DEFAULT 1, anchor_at TEXT NOT NULL, series_id TEXT NOT NULL,
          previous_id TEXT UNIQUE REFERENCES cashflows(id), status TEXT NOT NULL CHECK(status IN ('pending','paid','skipped')),
          notes TEXT NOT NULL DEFAULT '', version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE actions (
          id TEXT PRIMARY KEY, service_id TEXT NOT NULL REFERENCES services(id), label TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('state','url','webhook')), operation TEXT NOT NULL DEFAULT '',
          rule_id TEXT REFERENCES rules(id) ON DELETE SET NULL, url TEXT NOT NULL DEFAULT '',
          secret_config TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE events (
          id TEXT PRIMARY KEY, service_id TEXT REFERENCES services(id), event_type TEXT NOT NULL,
          data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
        );
        CREATE INDEX events_rule_lookup ON events(service_id, event_type, created_at DESC);
        CREATE INDEX cashflows_due ON cashflows(status, due_at);
        CREATE INDEX cashflows_wallet ON cashflows(wallet_id, status);
        CREATE INDEX rules_service ON rules(service_id);
        CREATE TABLE action_tokens (
          token_hash TEXT PRIMARY KEY, command TEXT NOT NULL, expires_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE notification_logs (
          id TEXT PRIMARY KEY, entity_key TEXT NOT NULL, channel TEXT NOT NULL, threshold INTEGER NOT NULL,
          status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, next_retry_at TEXT,
          error TEXT, created_at TEXT NOT NULL, sent_at TEXT,
          UNIQUE(entity_key, channel, threshold)
        );
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
        PRAGMA user_version=1;
      `);
    });
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...params) as T[]; }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...params) as T | undefined; }
  run(sql: string, ...params: SQLInputValue[]) { return this.db.prepare(sql).run(...params); }
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key: string): string | undefined { return this.get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value; }
  setSetting(key: string, value: string) { this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value); }
  event(serviceId: string | null, eventType: string, data: Record<string, unknown> = {}, at = new Date().toISOString()): string {
    const id = randomUUID();
    this.run('INSERT INTO events(id,service_id,event_type,data,created_at) VALUES(?,?,?,?,?)', id, serviceId, eventType, JSON.stringify(data), at);
    return id;
  }
  close() { this.db.close(); }
}
