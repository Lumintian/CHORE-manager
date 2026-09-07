import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { AppError, httpUrl, requireThat } from './util.js';
import type { Store } from './store.js';

export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const randomToken = (): string => randomBytes(24).toString('base64url');
export class SecretBox {
  constructor(private key: Buffer) { requireThat(key.length === 32, 'Encryption key must be 32 bytes'); }
  seal(value: unknown): string {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
  }
  open<T>(value: string): T {
    const [iv, tag, data] = value.split('.').map(s => Buffer.from(s, 'base64url'));
    try { const cipher = createDecipheriv('aes-256-gcm', this.key, iv); cipher.setAuthTag(tag); return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString()); }
    catch { throw new AppError(500, 'Cannot decrypt server configuration. Restore the matching secret.key.'); }
  }
  static fromFile(path: string, envKey?: string): SecretBox {
    if (envKey) { requireThat(/^[a-fA-F0-9]{64}$/.test(envKey), 'APP_SECRET_KEY must be 64 hexadecimal characters'); return new SecretBox(Buffer.from(envKey, 'hex')); }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let key: Buffer;
    try { key = readFileSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      key = randomBytes(32); writeFileSync(path, key, { mode: 0o600, flag: 'wx' });
    }
    return new SecretBox(key);
  }
}
function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 32).toString('hex')}`;
}
function checkPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':'); if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex'), actual = scryptSync(password, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class Auth {
  private envHash: string | undefined;
  private attempts = new Map<string, { count: number; reset: number }>();
  constructor(private store: Store, password?: string) {
    const previous = store.setting('env_password_hash');
    if (password) {
      this.validatePassword(password);
      if (previous && checkPassword(password, previous)) this.envHash = previous;
      else {
        this.envHash = passwordHash(password);
        store.tx(() => { store.run('DELETE FROM sessions'); store.setSetting('env_password_hash', this.envHash!); });
      }
    } else if (previous) {
      store.tx(() => { store.run('DELETE FROM sessions'); store.run("DELETE FROM settings WHERE key='env_password_hash'"); });
    }
  }
  private validatePassword(password: unknown): asserts password is string { requireThat(typeof password === 'string' && password.length >= 12 && password.length <= 256, 'Use a password with 12-256 characters'); }
  needsSetup(): boolean { return !this.envHash && !this.store.setting('password_hash'); }
  setup(password: unknown): void {
    this.validatePassword(password);
    this.store.tx(() => { requireThat(this.needsSetup(), 'Setup has already been completed', 409); this.store.setSetting('password_hash', passwordHash(password)); });
  }
  login(password: unknown, ip: string): string {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (value.reset < now) this.attempts.delete(key);
    const entry = this.attempts.get(ip) ?? { count: 0, reset: now + 15 * 60_000 };
    requireThat(entry.count < 10, 'Too many attempts. Try again after 15 minutes.', 429);
    entry.count++; this.attempts.set(ip, entry);
    const stored = this.envHash ?? this.store.setting('password_hash');
    requireThat(typeof password === 'string' && password.length <= 256 && stored && checkPassword(password, stored), 'Invalid password', 401);
    this.attempts.delete(ip);
    this.store.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
    const token = randomToken();
    this.store.run('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)', hash(token), new Date(now + 7 * 86400000).toISOString());
    return token;
  }
  valid(token = ''): boolean {
    return !!this.store.get('SELECT token_hash FROM sessions WHERE token_hash=? AND expires_at>?', hash(token), new Date().toISOString());
  }
  logout(token = '') { this.store.run('DELETE FROM sessions WHERE token_hash=?', hash(token)); }
}
export interface OutboundRequest { url: string; method?: string; headers?: Record<string, string>; body?: string }
export interface OutboundResponse { status: number; body: string }
export type Transport = (request: OutboundRequest) => Promise<OutboundResponse>;
export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // Only globally routed IPv6. Reject mapped IPv4, local, multicast, documentation and transition ranges.
  const lower = address.toLowerCase();
  return isIP(address) === 6 && /^[23]/.test(lower) && !/^2001:(0:|db8:)/.test(lower) && !lower.startsWith('2002:');
}
export function makeTransport(allowPrivate = false, allowedHosts: string[] = [], timeoutMs = 10_000): Transport {
  return async ({ url, method = 'POST', headers = {}, body = '' }) => {
    const target = new URL(httpUrl(url, false)), hostname = target.hostname.replace(/^\[|\]$/g, '');
    requireThat(!allowedHosts.length || allowedHosts.includes(hostname.toLowerCase()), 'Outbound host is not in OUTBOUND_ALLOWED_HOSTS');
    let timer: NodeJS.Timeout | undefined;
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        lookup(hostname, { all: true }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError(502, 'DNS lookup timed out')), timeoutMs); })
      ]);
    } catch { throw new AppError(502, 'Outbound DNS lookup failed'); }
    finally { clearTimeout(timer); }
    requireThat(addresses.length > 0 && (allowPrivate || addresses.every(a => publicAddress(a.address))), 'Private/reserved network destinations are blocked');
    const address = addresses[0];
    // Pin the validated DNS result into the connection to avoid DNS-rebinding TOCTOU.
    const pinnedLookup = ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
      if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
    }) as LookupFunction;
    return new Promise<OutboundResponse>((resolve, reject) => {
      const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, {
        method, headers, lookup: pinnedLookup, agent: false
      }, response => {
        const chunks: Buffer[] = []; let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 65536) request.destroy(new Error('limit')); else chunks.push(chunk);
        });
        response.on('end', () => { clearTimeout(deadline); resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }); });
        response.on('error', () => { clearTimeout(deadline); reject(new AppError(502, 'Outbound response failed')); });
      });
      const deadline = setTimeout(() => request.destroy(new Error('timeout')), timeoutMs);
      request.on('error', () => { clearTimeout(deadline); reject(new AppError(502, 'Outbound request failed or timed out')); });
      request.end(body || undefined);
    });
  };
}
