import type { Input, Recurrence } from '../shared/types.js';
export class AppError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new AppError(status, message);
}
export function object(value: unknown): Input {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a JSON object');
  return value as Input;
}
export function text(value: unknown, label: string, fallback = '', max = 2000): string {
  const result = value === undefined || value === null ? fallback : value;
  requireThat(typeof result === 'string' && result.length <= max, `${label} must be text (max ${max} characters)`);
  return result.trim();
}
export function name(value: unknown, label = 'Name'): string {
  const result = text(value, label, '', 160); requireThat(result.length > 0, `${label} is required`); return result;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  const result = value ?? fallback; requireThat(choices.includes(result as T), `Expected one of: ${choices.join(', ')}`); return result as T;
}
export function integer(value: unknown, label: string, fallback: number, min = 1, max = 3650): number {
  const n = value === undefined || value === '' ? fallback : Number(value);
  requireThat(Number.isSafeInteger(n) && n >= min && n <= max, `${label} must be an integer between ${min} and ${max}`); return n;
}
export function bool(value: unknown, fallback = true): boolean {
  if (value === undefined) return fallback;
  requireThat(typeof value === 'boolean', 'Expected a boolean'); return value;
}
export function date(value: unknown, label = 'Date'): string {
  requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), `${label} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  requireThat(Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2199-12-31', `${label} is not a valid date (1900-2199)`);
  return value;
}
export const today = (now = new Date()): string => now.toISOString().slice(0, 10);
export function addDays(value: string, count: number): string {
  const d = new Date(`${value.slice(0, 10)}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + count); return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number { return Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86400000); }
export function nextDate(due: string, recurrence: Recurrence, interval: number, anchor: string): string | null {
  if (recurrence === 'none') return null;
  if (recurrence === 'days') return addDays(due, interval);
  const d = new Date(`${due}T00:00:00Z`), a = new Date(`${anchor}T00:00:00Z`);
  let year = d.getUTCFullYear(), month = d.getUTCMonth();
  if (recurrence === 'monthly') month += interval;
  else { year += interval; month = a.getUTCMonth(); }
  const end = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(a.getUTCDate(), end))).toISOString().slice(0, 10);
}
// Fixed-point (1 unit = 0.0001 currency). No exchange rates or floating-point ledger math.
export function units(value: unknown, signed = false): number {
  const s = String(value ?? '');
  requireThat((signed ? /^-?\d{1,9}(\.\d{1,4})?$/ : /^\d{1,9}(\.\d{1,4})?$/).test(s), 'Amount must be a decimal with at most 4 decimal places');
  const [whole, fraction = ''] = s.replace('-', '').split('.');
  return (Number(whole) * 10000 + Number(fraction.padEnd(4, '0'))) * (s.startsWith('-') ? -1 : 1);
}
export function decimal(n: number): string {
  requireThat(Number.isSafeInteger(n), 'Amount exceeds safe storage range');
  const absolute = Math.abs(n); const fraction = String(absolute % 10000).padStart(4, '0');
  return `${n < 0 ? '-' : ''}${Math.floor(absolute / 10000)}.${fraction.slice(0, 2)}${fraction.slice(2).replace(/0+$/, '')}`;
}
export function currency(value: unknown): string {
  const s = text(value, 'Currency', 'USD', 8).toUpperCase(); requireThat(/^[A-Z]{3,8}$/.test(s), 'Currency must contain 3-8 letters'); return s;
}
export function httpUrl(value: unknown, optional = true): string {
  const s = text(value, 'URL', '', 2048); if (!s && optional) return '';
  let u: URL; try { u = new URL(s); } catch { throw new AppError(400, 'Enter a valid HTTP(S) URL'); }
  requireThat(['http:', 'https:'].includes(u.protocol) && !u.username && !u.password, 'Only HTTP(S) URLs without embedded credentials are allowed');
  return u.toString();
}
export function thresholds(value: unknown): number[] {
  if (value === undefined) return [30, 7, 3, 1];
  requireThat(Array.isArray(value) && value.length <= 12, 'Reminders must be a list of up to 12 day thresholds');
  return [...new Set(value.map(v => integer(v, 'Reminder day', 1, 0, 365)))].sort((a, b) => b - a);
}
