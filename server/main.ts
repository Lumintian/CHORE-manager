import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Store } from './store.js';
import { Auth, SecretBox, makeTransport } from './security.js';
import { Domain } from './domain.js';
import { Notifications } from './notifications.js';
import { createApp } from './http.js';
import { seedDemo } from './seed.js';
import { AppError, httpUrl, integer, requireThat } from './util.js';

process.umask(0o077);
async function main() {
  const dbPath = resolve(process.env.DATABASE_PATH ?? './data/lifecycle.sqlite');
  const store = new Store(dbPath);
  const box = SecretBox.fromFile(resolve(process.env.KEY_FILE ?? `${dirname(dbPath)}/secret.key`), process.env.APP_SECRET_KEY);
  const transport = makeTransport(process.env.ALLOW_PRIVATE_NETWORK === 'true', (process.env.OUTBOUND_ALLOWED_HOSTS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const domain = new Domain(store, box, transport);
  if (process.argv.includes('--backup')) {
    const target = resolve(process.argv[process.argv.indexOf('--backup') + 1] ?? `${dirname(dbPath)}/backups/lifecycle-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); store.db.prepare('VACUUM INTO ?').run(target); store.close(); console.log(`Consistent SQLite backup created at ${target}. Back up secret.key separately.`); return;
  }
  if (process.argv.includes('--seed')) { console.log(seedDemo(domain) ? 'Demo workspace created.' : 'Seed skipped: workspace is not empty or was already seeded.'); store.close(); return; }
  if (process.env.SEED_DEMO === 'true') seedDemo(domain);
  domain.recoverInterruptedWebhooks();
  const port = integer(process.env.PORT, 'PORT', 3210, 1, 65535);
  const appUrl = httpUrl(process.env.APP_URL ?? `http://localhost:${port}`, false).replace(/\/$/, '');
  const parsedUrl = new URL(appUrl); requireThat(parsedUrl.pathname === '/' && !parsedUrl.search && !parsedUrl.hash, 'APP_URL must be an HTTP(S) origin without a path, query or fragment');
  const schedulerSeconds = integer(process.env.SCHEDULER_SECONDS, 'SCHEDULER_SECONDS', 600, 60, 86400);
  const walletHorizon = integer(process.env.WALLET_HORIZON_DAYS, 'WALLET_HORIZON_DAYS', 30, 1, 365);
  const notifications = new Notifications(domain, box, transport, appUrl, schedulerSeconds, walletHorizon);
  const auth = new Auth(store, process.env.APP_PASSWORD);
  const server = createApp(domain, notifications, auth, appUrl);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, process.env.HOST ?? '127.0.0.1', resolve); });
  console.log(`Lifecycle is listening at ${appUrl}. ${auth.needsSetup() ? 'Open the app to set your password.' : 'Authentication is enabled.'}`);
  const scan = () => { void notifications.run().catch(() => console.error('Reminder scan failed; check notification settings.')); };
  const startup = setTimeout(scan, 1000), scheduler = setInterval(scan, schedulerSeconds * 1000), polling = setInterval(() => { void notifications.pollTelegram(); }, 5000);
  startup.unref(); scheduler.unref(); polling.unref();
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
    if (closing) return; closing = true; clearTimeout(startup); clearInterval(scheduler); clearInterval(polling);
    server.close(() => {
      void (async () => { while (notifications.busy) await new Promise(r => setTimeout(r, 50)); store.close(); })();
    });
    server.closeIdleConnections();
  });
}
main().catch(error => { console.error(error instanceof AppError ? error.message : 'Startup failed. Check configuration, database permissions and README.'); process.exitCode = 1; });
