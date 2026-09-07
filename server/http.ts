import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Input, Operation } from '../shared/types.js';
import { Domain } from './domain.js';
import { Notifications } from './notifications.js';
import { Auth } from './security.js';
import { AppError, choice, integer, object, requireThat, text } from './util.js';
import { seedDemo } from './seed.js';

function cookie(request: IncomingMessage): string {
  return (request.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith('chore_session='))?.slice(14) ?? '';
}
async function body(request: IncomingMessage): Promise<Input> {
  requireThat((request.headers['content-type'] ?? '').split(';')[0] === 'application/json', 'Use Content-Type: application/json', 415);
  requireThat(Number(request.headers['content-length'] ?? 0) <= 65536, 'Request body is too large', 413);
  const data = await new Promise<string>((resolve, reject) => {
    let length = 0, tooLarge = false; const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 65536) { tooLarge = true; reject(new AppError(413, 'Request body is too large')); } else if (!tooLarge) chunks.push(chunk); });
    request.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    request.on('error', () => reject(new AppError(400, 'Request could not be read')));
  });
  try { return object(data ? JSON.parse(data) : {}); } catch (error) { if (error instanceof AppError) throw error; throw new AppError(400, 'Invalid JSON'); }
}
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value));
}
export function createApp(domain: Domain, notifications: Notifications, auth: Auth, appUrl: string) {
  const origin = new URL(appUrl).origin, secure = origin.startsWith('https:');
  const setCookie = (response: ServerResponse, token: string) => response.setHeader('Set-Cookie', `chore_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 604800 : 0}${secure ? '; Secure' : ''}`);
  const checkMutation = (request: IncomingMessage) => {
    requireThat(request.headers['x-app-request'] === 'chore', 'Missing X-App-Request header', 403);
    requireThat(!request.headers.origin || request.headers.origin === origin, 'Origin does not match APP_URL', 403);
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url ?? '/', appUrl), path = url.pathname, method = request.method ?? 'GET';
      if (path === '/healthz' && method === 'GET') { domain.store.get('SELECT 1'); json(response, 200, { status: 'ok' }); return; }
      if (!path.startsWith('/api/')) {
        requireThat(method === 'GET' || method === 'HEAD', 'Method not allowed', 405);
        let file: URL, type: string;
        if (path === '/assets/app.js') { file = new URL('../client/app.js', import.meta.url); type = 'text/javascript'; }
        else if (path === '/assets/styles.css') { file = new URL('../public/styles.css', import.meta.url); type = 'text/css'; }
        else { requireThat(/^\/(?:dashboard|services(?:\/[A-Za-z0-9-]+)?|cashflows|wallets|counterparties|settings\/notifications)?$/.test(path), 'Page not found', 404); file = new URL('../public/index.html', import.meta.url); type = 'text/html'; }
        const contents = await readFile(file); response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' }); response.end(method === 'HEAD' ? undefined : contents); return;
      }
      if (path === '/api/session' && method === 'GET') { json(response, 200, { authenticated: auth.valid(cookie(request)), setup_required: auth.needsSetup() }); return; }
      const execution = path.match(/^\/api\/actions\/([^/]+)\/execute$/);
      if (execution) {
        requireThat(method === 'POST', 'Actions require POST', 405);
        await body(request); const result = await domain.execute(execution[1]); json(response, result.ok ? 200 : 502, result); return;
      }
      if (method !== 'GET') checkMutation(request);
      if (path === '/api/setup' && method === 'POST') {
        const input = await body(request); auth.setup(input.password); setCookie(response, auth.login(input.password, request.socket.remoteAddress ?? 'unknown')); json(response, 201, { ok: true }); return;
      }
      if (path === '/api/login' && method === 'POST') {
        const input = await body(request); setCookie(response, auth.login(input.password, request.socket.remoteAddress ?? 'unknown')); json(response, 200, { ok: true }); return;
      }
      requireThat(auth.valid(cookie(request)), 'Sign in to continue', 401);
      if (path === '/api/logout' && method === 'POST') { auth.logout(cookie(request)); setCookie(response, ''); json(response, 200, { ok: true }); return; }
      if (path === '/api/snapshot' && method === 'GET') { json(response, 200, domain.snapshot(integer(url.searchParams.get('horizon') ?? undefined, 'Horizon days', notifications.walletHorizon, 1, 365))); return; }
      if (path === '/api/action-tokens' && method === 'POST') {
        const input = await body(request); const operation = choice<Operation>(input.operation, ['mark_login', 'mark_renewed', 'extend_expiry', 'cancel_service', 'mark_cashflow_paid', 'mark_cashflow_received', 'skip_cashflow', 'custom_action'], 'custom_action');
        json(response, 201, domain.issue(operation, text(input.entity_id, 'Entity ID'))); return;
      }
      if (path === '/api/settings/notifications') {
        if (method === 'GET') { json(response, 200, notifications.settings()); return; }
        if (method === 'PUT') { json(response, 200, notifications.save(await body(request))); return; }
      }
      if (path === '/api/notifications/preview' && method === 'GET') { json(response, 200, notifications.preview()); return; }
      if (path === '/api/notifications/logs' && method === 'GET') { json(response, 200, notifications.logs()); return; }
      if (path === '/api/notifications/run' && method === 'POST') { await body(request); json(response, 200, await notifications.run()); return; }
      if (path === '/api/notifications/test' && method === 'POST') { const input = await body(request); json(response, 200, await notifications.test(choice(input.channel, ['telegram', 'ntfy'] as const, 'telegram'))); return; }
      if (path === '/api/demo-seed' && method === 'POST') { await body(request); requireThat(seedDemo(domain), 'Demo data can only be loaded into an empty workspace, once.', 409); json(response, 201, { ok: true }); return; }
      const match = path.match(/^\/api\/(services|rules|cashflows|wallets|counterparties|actions)(?:\/([A-Za-z0-9-]+))?$/);
      if (match) {
        const [, entity, id] = match;
        if (method === 'GET') {
          const snapshot = domain.snapshot();
          const rows = snapshot[entity as 'services' | 'rules' | 'cashflows' | 'wallets' | 'counterparties' | 'actions'];
          const result = id ? rows.find(row => row.id === id) : rows; requireThat(result, 'Record not found', 404); json(response, 200, result); return;
        }
        if ((method === 'POST' && !id) || (['PUT', 'PATCH'].includes(method) && id)) {
          const input = await body(request);
          const save = { services: () => domain.saveService(input, id), rules: () => domain.saveRule(input, id), cashflows: () => domain.saveCashflow(input, id), wallets: () => domain.saveWallet(input, id), counterparties: () => domain.saveCounterparty(input, id), actions: () => domain.saveAction(input, id) };
          json(response, id ? 200 : 201, save[entity as keyof typeof save]()); return;
        }
        if (method === 'DELETE' && id) {
          const remove = { services: () => domain.saveService({ status: 'cancelled' }, id), rules: () => domain.deleteRule(id), cashflows: () => domain.deleteCashflow(id), wallets: () => domain.deleteWallet(id), counterparties: () => domain.deleteCounterparty(id), actions: () => domain.deleteAction(id) };
          remove[entity as keyof typeof remove](); json(response, 200, { ok: true }); return;
        }
      }
      if (path === '/api/events' && method === 'GET') { json(response, 200, domain.snapshot().events); return; }
      throw new AppError(404, 'API endpoint not found');
    } catch (error) {
      if (!(error instanceof AppError)) console.error('Request failed with an internal error; no request or secret data was logged.');
      if (!response.headersSent) json(response, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Internal server error' });
      else response.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 40;
  return server;
}
