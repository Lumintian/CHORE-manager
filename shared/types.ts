export type ServiceStatus = 'active' | 'paused' | 'cancelled' | 'expired';
export type RuleType = 'fixed_expiry' | 'interval_since_event' | 'extend_by';
export type Recurrence = 'none' | 'monthly' | 'yearly' | 'days';
export type Operation = 'mark_login' | 'mark_renewed' | 'extend_expiry' | 'cancel_service' | 'mark_cashflow_paid' | 'mark_cashflow_received' | 'skip_cashflow' | 'custom_action';
export interface Service {
  id: string; name: string; description: string; url: string; status: ServiceStatus;
  category: string; notes: string; version: number; created_at: string; updated_at: string;
}
export interface Rule {
  id: string; service_id: string; label: string; type: RuleType; event_type: string;
  interval_days: number; extend_days: number; expiry_at: string | null; anchor_at: string;
  enabled: boolean; remind_before_days: number[]; version: number; next_due?: string;
}
export interface Counterparty { id: string; name: string; notes: string }
export interface Wallet {
  id: string; name: string; currency: string; balance: string; notes: string; topup_url: string;
}
export interface CashFlow {
  id: string; service_id: string; counterparty_id: string | null; wallet_id: string | null;
  direction: 'IN' | 'OUT'; amount: string; currency: string; due_at: string;
  recurrence: Recurrence; interval: number; anchor_at: string; series_id: string;
  previous_id: string | null; status: 'pending' | 'paid' | 'skipped'; notes: string; version: number;
}
export interface ServiceAction {
  id: string; service_id: string; label: string; kind: 'state' | 'url' | 'webhook';
  operation: string; rule_id: string | null; url: string; enabled: boolean;
  method: string; success_event: string; configured: boolean; version: number;
}
export interface Event {
  id: string; service_id: string | null; event_type: string; data: Record<string, unknown>; created_at: string;
}
export interface ActionLink { label: string; operation?: Operation; entity_id?: string; url?: string; route?: string }
export interface Obligation {
  key: string; type: 'expiry' | 'maintenance' | 'receivable' | 'payable' | 'wallet';
  entity_id: string; service_id: string | null; title: string; detail: string;
  due_at: string; days: number; severity: 'overdue' | 'soon' | 'normal';
  amount?: string; currency?: string; thresholds: number[]; actions: ActionLink[];
}
export interface Coverage {
  wallet_id: string; balance: string; required: string; shortfall: string; remaining: string;
  currency: string; first_shortfall_at: string | null; through: string; truncated: boolean;
  entries: { cashflow_id: string; due_at: string; amount: string; projected: boolean }[];
}
export interface Snapshot {
  today: string; horizon: number; services: Service[]; rules: Rule[]; cashflows: CashFlow[];
  wallets: Wallet[]; counterparties: Counterparty[]; actions: ServiceAction[];
  events: Event[]; coverage: Coverage[]; obligations: Obligation[];
}
export interface ActionResult { ok: boolean; message: string; event_id?: string; replayed?: boolean; open_url?: string }
export interface PublicSettings {
  telegram_enabled: boolean; telegram_chat_id: string; telegram_has_token: boolean;
  ntfy_enabled: boolean; ntfy_server: string; ntfy_topic: string; ntfy_has_token: boolean;
  env_overrides: string[]; app_url: string; scheduler_seconds: number; wallet_horizon: number;
  telegram_error?: string; last_scan?: string;
}
export type Input = Record<string, unknown>;
