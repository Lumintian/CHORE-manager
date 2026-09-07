# Verification record

## Local execution (2026-09-07)

Environment: Node 22.16.0, TypeScript 5.8.3, Linux, SQLite via `node:sqlite`. The three development packages were provided by the environment at exactly the locked versions; a fresh networked `npm ci` was not possible in this local environment.

- `npm test`: **35 tests passed, zero failures** (includes a clean TypeScript build).
- `npm run typecheck`: checked separately before final submission.
- Actual application process started with file-backed SQLite and seeded demo; `/healthz` returned `{"status":"ok"}`.
- `scripts/smoke.mjs`: passed against that process. Checked authentication, all seven page routes and both assets, 38 TRY demo shortfall, PT +40-day reset, +30-day extension, received cash-flow history and next occurrence, token replay, CRUD, secret masking, inert previews, and logout.
- Consistent `VACUUM INTO` backup created while the application was running; opening the backup and `PRAGMA integrity_check` returned `ok`.
- Chromium isolated-DOM checks with the real compiled client and seeded fixture responses rendered the Action Center, Services, Cash flows, Funding sources, People/providers and Notifications; modal and preview interactions passed with zero page errors. Desktop 1440px and mobile 390px screenshots were inspected; the mobile document had no horizontal overflow. This is fixture-based UI verification, **not a live browser-to-server end-to-end test**.

## Explicit environment limits

The local environment has no Docker CLI/daemon, so **local `docker compose up` was not executed**. Its managed Chromium blocks all page navigation, so live browser end-to-end navigation could not be run locally. The isolated DOM check did not change browser policy or make network requests.

No real Telegram bot token, chat, ntfy credential or operator-owned webhook was supplied. Automated tests verify both provider payloads, callback execution and deduplication with mocks; real local HTTP servers verify outbound policy/response handling. This is **not proof of actual delivery through either third-party provider**.

## Reproducible hosted verification

`.github/workflows/ci.yml` is configured to perform a fresh npm install, tests, production Docker build, Compose startup/health, real HTTP smoke, a container restart/persistence check, backup integrity, and real Chromium UI checks against a fresh disposable demo. It uploads UI screenshots and prints container logs. See the actual PR checks for their run status; the presence of the workflow is not a claim it has passed.

The smoke scripts deliberately mutate data. Run them only on a disposable workspace. CI's `down -v` is for its throwaway volume, never an instruction to destroy a user's live data.
