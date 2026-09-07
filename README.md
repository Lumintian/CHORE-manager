# Lifecycle

**Self-hosted service lifecycle manager for subscriptions, shared payments and recurring maintenance.**

Lifecycle starts with an **Action Center**, not a spending chart. A service can be just a name and a note. Add payment schedules, maintenance rules, prepaid funding, or automation only when needed.

```
Service -> Rule -> Obligation -> Notification -> Action -> Event
                    ^                              |
                    +------- updated state --------+
```

This is not a conventional subscription tracker: incoming shared payments and outgoing bills are independent; money stays in its original currency; maintenance can be driven by actual events rather than a manually edited renewal date; actions can extend access or call your own automation.

## Start with Docker Compose

Requires Docker Engine with the Compose v2 plugin and network access to download the Node image and build dependencies.

```sh
git clone https://github.com/Lumintian/oai-repo.git
cd oai-repo
git checkout feat/service-lifecycle-mvp  # Until the MVP PR is merged.
docker compose up -d
```

Open **http://localhost:3210** and set a password of at least 12 characters. There is no default password. Setup is available only once. By default the published port binds to loopback, so complete setup locally or through a trusted tunnel.

The first build also runs the automated tests. One application container serves the UI, API, scheduler and Telegram poller. SQLite and the generated encryption key live in the persistent `lifecycle_data` volume at `/data`.

The workspace starts empty. Click **Explore demo workspace** on the empty Action Center, or run:

```sh
docker compose exec app node dist/server/main.js --seed
```

Alternatively set `SEED_DEMO=true` in `.env` before first startup. Seed runs only once in an empty workspace and does not overwrite your records. **Do not use `docker compose down -v` on real data**: `-v` deletes the volume.

To configure a server, copy `.env.example` to `.env`, edit the relevant values, then run `docker compose up -d`. For changes to source code, use `docker compose up -d --build`. Read [verification](docs/verification.md) for what has actually been exercised, rather than treating a supplied Dockerfile as proof of a successful deployment.

## Try the demo

| Example | What you will see / do |
| --- | --- |
| Claude Max | 100 USD monthly OUT, 180 CNY monthly IN from Zhang San, and 30 USD monthly IN from Peter. Settle each independently. |
| Netflix | 30 CNY monthly OUT to Li Si, using exactly the same cash-flow model. |
| Apple TR Balance | 320 TRY available against 59 TRY Apple Music and 299 TRY iCloud. The Action Center shows a **38 TRY shortfall**. |
| PT Example | LOGIN was 35 days ago; a 40-day event interval is due in five days. **Already logged in** records LOGIN and moves the next due date to 40 days from today. |
| Refreshable Service | Expires in ten days. **Extend 30 days** adds 30 days to the existing expiry and records EXTENDED. |
| Example domain | An overdue fixed expiry exercises the overdue state and renewal action. |

Seed dates are relative to the day you seed. The demo PT webhook is **disabled** and points to a non-resolving placeholder; it does not pretend to log into a real site. Configure your own endpoint before enabling it.

## Pages and daily workflow

`/dashboard` is the Action Center: overdue and upcoming expiries, maintenance, receivables, payables, and funding risks, ordered by due date. Filter item types and switch the 7/30/90/365-day planning window. Each item exposes its relevant actions.

`/services` supports name/category/note search and service creation. `/services/:id` contains basic information, editable rules, cash-flow history, custom actions and recent events. Services support `active`, `paused`, `cancelled`, and `expired`. Editing to an inactive state stops derived reminders and projections without deleting history.

`/cashflows` shows pending, settled and skipped occurrences, in both directions. **Paid / Received** settles one occurrence, records an event, deducts a linked outgoing wallet once, and creates the next recurring occurrence. **Skip** advances the recurrence without moving money. **Remove** retains a skipped record and stops that occurrence's recurrence. Settled history cannot be edited or deleted.

`/wallets` manages actual balances, currencies and optional top-up links, with projected deductions. **Update balance** replaces the actual balance, not adds a top-up amount. A stale browser balance edit is rejected if a payment changed it meanwhile. `/counterparties` manages people and providers; referenced counterparties and wallets cannot be deleted.

`/settings/notifications` configures Telegram and ntfy, tests delivery, previews inert payloads, triggers a reminder scan and shows recent delivery outcomes. Save before testing.

The UI is responsive and has light/dark modes. The current interface language is English; names and notes support Unicode.

## Architecture and core concepts

The stack is intentionally small: **TypeScript end to end, native Node HTTP, native Node SQLite, typed DOM UI, plain CSS**. There are **no production npm dependencies** and no Redis, queue, frontend runtime, external database or rules DSL. Development needs only TypeScript and Node type declarations; their versions are locked. Node 22.16+ is required; the Docker image uses Node 24.

| Concept | Implementation |
| --- | --- |
| Service | The account, service or entitlement. Price and recurrence are not required. |
| Rule | Explicit `fixed_expiry`, `interval_since_event`, or `extend_by` configuration; optional reminder thresholds. |
| Obligation | Dynamically derived from current rules, pending cash flows and wallet projections. It is not a second editable source of truth. |
| CashFlow | A persisted occurrence: service, counterparty, direction, amount, currency, due date, recurrence, status, and optional funding wallet. |
| Wallet | A prepaid balance, not a bank connection. Only matching-currency OUT flows may use it. |
| Action | A validated state change, URL, or HTTP webhook. Built-in rule/payment actions need no custom setup. |
| Event | Immutable history of actual actions. Interval rules derive their next due date from the latest matching service event. |
| ActionToken | Random, scoped, expiring capability for one particular action and state. Only its hash is stored. |
| NotificationLog | Persisted channel/obligation/threshold delivery and bounded retry state. |

`shared/types.ts` is shared by client and server. `server/store.ts` owns the versioned schema and parameterized persistence, `domain.ts` owns transitions and obligations, `security.ts` owns authentication/encryption/outbound protections, `notifications.ts` owns adapters and scheduling logic, and `http.ts` only exposes the API and assets. `client/app.ts` renders the workspace and forms; `test/core.test.ts` exercises domain, transport, notifications and HTTP integration.

### Calendar and accounting decisions

All due dates are **UTC calendar dates**, not browser-local timestamps. Events retain UTC timestamps. An interval rule uses the latest matching `service_id + event_type`; before any matching event exists, its explicit fallback start date is used. Multiple rules for the same service/event type intentionally see the same event.

**Extend** always adds days to the existing expiry, even if already overdue. **Renew** adds the configured number of days to the later of today and the current expiry. A service's inactive status is an explicit user choice; an overdue rule is displayed as overdue but does not silently cancel the service.

Recurrence supports one-off, every N days, every N months and every N years. Calendar month/year recurrence preserves the original day anchor: January 31 -> February 28 -> March 31. Late settlement advances from the prior due date, not from today; unpaid arrears are not silently skipped. One real pending occurrence is stored per advancing series, and future wallet projections expand the recurrence without creating or paying fake rows.

The Claude demo uses its outgoing payment recurrence as the renewal schedule; it does not also create a duplicate expiry rule. A separately configured expiry rule and a payment flow remain independent: settling money does not implicitly change unrelated entitlement rules.

Amounts are decimal **strings at the API boundary**, stored as integer ten-thousandths. Inputs support up to nine whole digits and four decimal places. Currency codes are 3-8 letters. There are no exchange rates, currency conversion or cross-currency totals. Explicit marking as paid/received is a record, not a real financial transfer. Wallet balances change only when you explicitly settle a linked OUT flow or adjust the balance.

Wallet coverage includes active-service pending OUT debt (including overdue debt) and subsequent projected recurring charges through the selected horizon. It sorts by due date, computes the first shortfall, and assumes no future top-ups or incoming transfers. A 4,096-entry safety cap marks a forecast as truncated rather than silently complete. This is a basic cash-coverage check, not a financial forecasting product.

Paused/cancelled/expired services stop generating reminders and future wallet deductions. Existing pending cash flows remain in the ledger and can still be explicitly settled, but doing so while inactive does not create a next occurrence. Reactivating a service does not invent missed periods after the last pending occurrence has been settled; add a new flow when restarting that schedule.

## Telegram

Create your bot using Telegram's **BotFather**, start a conversation with it, and obtain the numeric chat ID for that private chat or a trusted group. Enter the bot token and chat ID in Notifications, enable Telegram, save, and **Send Telegram test**. A channel can also be tested while disabled once its configuration is saved.

Lifecycle uses Bot API `sendMessage` with inline buttons, polls `getUpdates` every five seconds, and acknowledges button taps with `answerCallbackQuery`. No inbound Telegram webhook or public application URL is needed for callback buttons. Use a dedicated bot: an existing Telegram webhook or another poller will conflict with polling. Polling errors are surfaced on the settings page without exposing provider response bodies.

The callback's chat ID must match the configured chat. **Every member of a configured group is trusted to execute its actions**; there is no per-member permission system. URL buttons open their URL directly. Action buttons carry only a scoped random token, not client-selected service IDs.

Environment overrides are `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_CHAT_ID`. Nonempty environment values override and lock corresponding UI settings; an explicit `false` disables a channel. Blank variables leave UI configuration usable.

## ntfy

Configure the server URL (default `https://ntfy.sh`), a private/access-controlled topic, and an optional bearer token. Enable, save, and **Send ntfy test**. Publishing uses the ntfy JSON HTTP API. Notifications include native `view` and `http` actions, up to three buttons.

An HTTP button sends JSON `{}` by POST to:

```
APP_URL/api/actions/<random-token>/execute
```

**Your receiving device must reach `APP_URL`.** `localhost` on a phone is the phone, not this server. Use a trusted VPN hostname or HTTPS reverse proxy and set `APP_URL` to the exact origin users open. Do not put additional proxy authentication in front of the token endpoint unless your notification client can satisfy it. Regular UI/admin API routes still require the application session.

Treat notifications as sensitive: anyone who receives or captures an unused capability token can perform that one action. Use an access-controlled ntfy topic, not just an obscure name. Configure `NTFY_ENABLED`, `NTFY_SERVER_URL`, `NTFY_TOPIC`, and `NTFY_TOKEN` for environment overrides. A private-network ntfy server requires the outbound allow-private option described below.

### Reminders and deduplication

The scheduler scans at startup and every 600 seconds by default. Rules default to `[30,7,3,1]` reminder thresholds, editable as comma-separated days; due-day and overdue stages are also supported. Cash-flow and wallet reminders use the defaults. The nearest applicable threshold is sent, not every missed threshold at once.

Deduplication is persisted by obligation state, threshold and channel. Repeating a scan or restarting does not resend a recorded successful delivery. State changes, new cash-flow occurrences and newly reached thresholds can produce new reminders. Overdue is one stage, not an unbounded daily nag.

Failed deliveries have at most three attempts per key, with 10/20-minute retry delays. There is a 15-minute pending claim lease and a 50-delivery-per-scan bound. Failures are visible in the delivery log. Provider delivery cannot be transactional with SQLite: a crash after a provider accepted a message but before SQLite recorded success can produce a duplicate message on retry. State actions still reject stale state and replay safely.

**Preview payloads sends nothing and issues no usable tokens.** Unit tests use mock transports for both providers, including payload shape, Telegram callback authorization, acknowledgements and deduplication across a database reopen. Real delivery still requires your own valid credentials and network access.

## Webhooks and action safety

On a service detail page, add a **webhook** action with HTTP(S) URL, method, JSON headers and optional JSON body. Only HTTP 2xx is success; redirects are not followed. `GET` sends no body. Set **Event after success** to `LOGIN` for a PT automation that should reset the maintenance interval. Associate its rule so stale notifications are invalidated after maintenance. Generic webhooks otherwise record only `WEBHOOK_TRIGGERED`, and failures record `WEBHOOK_FAILED`.

URL, headers and body for a webhook are encrypted server-side and are never returned to the editor. On edit, blank fields preserve the saved URL/headers/body; `{}` clears JSON headers/body. A webhook action being present does not implement the remote job for you.

All outbound requests have DNS/connection/response deadlines and a 64 KiB response cap. DNS results are validated and pinned to the actual connection to resist rebinding. Private/reserved destinations, embedded URL credentials, dangerous headers and redirects are blocked by default. These checks also apply to notification providers.

For explicitly trusted LAN automation, set `ALLOW_PRIVATE_NETWORK=true` **and restrict `OUTBOUND_ALLOWED_HOSTS` to exact approved hostnames**. That switch affects all outbound requests and weakens protection, including access to local infrastructure. Do not expose arbitrary webhook configuration to untrusted users. Include `api.telegram.org` and your ntfy host in the allowlist when those channels are used. TLS certificate verification remains enabled; no insecure-certificate bypass is provided.

Notification tokens contain 192 random bits, expire after 45 days, are hashed in storage, and capture their server-resolved entity and version. Only POST executes them. Reusing a completed token returns its saved result. A different old token for a now-changed state returns a conflict rather than reapplying a payment or extension. UI mutations require a session, a custom anti-CSRF header, and matching Origin when present.

A running webhook is claimed before the network call, and repeated execution of the **same token** does not send it twice. A stable `Idempotency-Key` is passed to the remote endpoint. Remote side effects are not part of a SQLite transaction: timeouts/crashes can leave an unknown remote outcome. Interrupted jobs are marked `WEBHOOK_UNCERTAIN` on restart and are **not automatically resent**. Check the remote job before intentionally issuing a new token. Different deliberately issued webhook tokens are separate attempts; your endpoint should also implement idempotency for critical jobs.

## Authentication, secrets and deployment

Passwords are scrypt-hashed, sessions are random hashed tokens in SQLite, and cookies are HttpOnly/SameSite=Strict. Password login is rate limited per connected IP. Setting `APP_PASSWORD` overrides the setup password; changing/removing that override revokes existing sessions. For password recovery, set a new strong `APP_PASSWORD` and restart. Removing it restores the stored setup password if one exists, otherwise first-run setup is required again.

For remote access, use HTTPS at a reverse proxy and set `APP_URL=https://your-host.example` exactly (no subpath). Secure cookies are enabled when that origin uses HTTPS. The app does not trust proxy headers for authentication; keep the backend port private. Complete first-run setup before allowing untrusted inbound access. After setup, this is a single-owner tool, not a multi-tenant permission boundary.

Sensitive notification configuration and webhook configuration are AES-256-GCM encrypted. `/data/secret.key` is generated automatically with restrictive permissions, or `APP_SECRET_KEY` supplies a 32-byte hex key. Losing/changing that key makes saved configuration unreadable. Encryption prevents plaintext configuration leaks in ordinary DB/response handling; it does **not** protect secrets from an attacker who owns the host and has both database and key. No tokens, raw remote error bodies, headers or request URLs are written to application logs. Configure reverse-proxy access logs to redact `/api/actions/*/execute` and never publicly share a database backup.

## Backup and restore

Do not copy only a live `.sqlite` file while WAL writes are running. Use the supplied consistent SQLite `VACUUM INTO` backup command, with a **new destination filename** each time:

```sh
mkdir -p backups
docker compose exec app node dist/server/main.js --backup /data/backups/lifecycle-2026-09-07.sqlite
docker compose cp app:/data/backups/lifecycle-2026-09-07.sqlite ./backups/
docker compose cp app:/data/secret.key ./backups/secret.key
```

If `APP_SECRET_KEY` is used instead of a key file, securely back up that environment key. Also preserve relevant `.env` overrides separately. Backups contain personal service/payment history, session hashes and encrypted configuration: store them privately.

To restore, stop the application, place the backup at `/data/lifecycle.sqlite` in its volume, remove **old** `lifecycle.sqlite-wal` and `lifecycle.sqlite-shm` sidecars from the stopped target, restore the matching `secret.key` (or environment key), and ensure ownership permits the image's `node` user to read/write the directory. Restart and verify service history and notification configuration. Never swap a database underneath a running process. `PRAGMA user_version` provides schema versioning and newer-than-supported databases are rejected.

## Environment reference

| Variable | Default / purpose |
| --- | --- |
| `APP_URL` | `http://localhost:3210`; exact browser origin and ntfy callback origin, no subpath. |
| `APP_PASSWORD` | Empty: first-run setup. Nonempty: override with a 12-256-character password. |
| `APP_SECRET_KEY` | Empty: generated key file. Otherwise exactly 64 hex characters. |
| `DATABASE_PATH` | Native: `./data/lifecycle.sqlite`; Docker: `/data/lifecycle.sqlite`. |
| `KEY_FILE` | `secret.key` in the database directory; native override available. |
| `HOST`, `PORT` | Native bind `127.0.0.1:3210`; image binds `0.0.0.0:3210` internally. |
| `BIND_ADDRESS`, `APP_PORT` | Compose published address/port: `127.0.0.1`, `3210`. Changing the port also requires updating `APP_URL`. |
| `SEED_DEMO` | `false`; `true` seeds once if workspace is empty. |
| `SCHEDULER_SECONDS` | `600`; integer 60-86400. |
| `WALLET_HORIZON_DAYS` | `30`; integer 1-365 for reminder coverage. The UI planning window is separate. |
| `ALLOW_PRIVATE_NETWORK` | `false`; `true` permits private destinations for all outbound adapters. |
| `OUTBOUND_ALLOWED_HOSTS` | Empty means no hostname allowlist; otherwise comma-separated exact hostnames. |
| `TELEGRAM_ENABLED`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Nonempty values override saved Telegram settings. |
| `NTFY_ENABLED`, `NTFY_SERVER_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | Nonempty values override saved ntfy settings. |
| `SMOKE_URL`, `SMOKE_PASSWORD` | Test scripts only. Never run destructive smoke tests against personal data. |
| `CHROMIUM_PATH` | Optional browser executable for the Python end-to-end test. |

The native Node process reads **process environment**, not `.env` automatically. Docker Compose loads `.env` for its interpolation. On native Node, export variables or invoke `node --env-file=.env dist/server/main.js` after building.

## Development and tests

```sh
npm ci
npm test              # Compiles and runs the Node test suite.
npm run typecheck
npm run dev           # TypeScript watch + server restart + static asset copy.
```

For a regular native run:

```sh
npm run build
SEED_DEMO=true npm start
```

`npm run seed` builds then seeds the configured database. `npm run backup -- /path/new-backup.sqlite` snapshots an already-built app's database. Refresh your browser after client changes; there is no hot-module-reload framework.

The suite covers interval/expiry logic, anchored calendar recurrence, exact money, incoming/outgoing settlement, wallet projection and currency validation, cancellation, action replay/staleness, concurrent webhook execution, failures and crash recovery, secret masking/encryption, provider payloads, reminder retry/deduplication, callback authorization, SSRF controls, auth/session rotation, stale balance edits and real HTTP routes.

`scripts/smoke.mjs` runs against an actual **disposable fresh demo** and intentionally changes its records. `scripts/persistence-check.mjs` checks those changes survive a restart. `scripts/browser-smoke.py` exercises the real UI in Chromium (install Python Playwright 1.57.0 and its browser). The CI workflow builds/tests, starts Docker Compose, runs HTTP smoke, restarts and checks persistence, verifies a backup, resets only its disposable volume, and runs browser checks. It uses no real Telegram or ntfy credentials.

See [API notes](docs/api.md) and [verification evidence and limits](docs/verification.md).

## Current limits and sensible next steps

This MVP is intentionally single-user, single-process, date-based and manually settled. It does not do actual transfers, automatic bank reconciliation, currency conversion, full budgets, arbitrary cron schedules, multitenant roles, OAuth, background job queues or a workflow DSL. There is no import/export UI or password-change UI. All collections are small-workspace oriented, and the UI receives the latest 150 global events (service history shows up to 30 from that window); the database retains the older history. Notification logs show the latest 50 deliveries. Keep one application instance per database/bot.

A webhook timeout has no automatic undo. Notification providers can deliver duplicates around crash boundaries. Real Telegram/ntfy delivery needs operator-owned credentials and a reachable network. Backups and reverse-proxy TLS configuration remain the operator's responsibility. Runtime images track the Node 24 major rather than an immutable digest; rebuild periodically to receive upstream patches.

The next useful improvements are paginated per-service history, import/export and a tested restore helper, then optional user-selected time zones/localization. None should replace the event-driven core with a flat subscription table.
