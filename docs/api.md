# API notes

All requests/responses are JSON. Money is a decimal string, dates are `YYYY-MM-DD` in UTC, event timestamps are ISO UTC. Errors use `{ "error": "safe message" }`. Action failures may use `{ "ok": false, "message": "..." }` with HTTP 502.

## Authentication

`GET /api/session` reports `authenticated` and `setup_required`. `POST /api/setup` sets the first password once. `POST /api/login` signs in; both accept `{ "password": "..." }` and set the session cookie. `POST /api/logout` revokes it.

All administrative mutations require `Content-Type: application/json` when carrying a body, `X-App-Request: chore`, and a matching configured `Origin` if present. JSON bodies are limited to 64 KiB. Browser credentials are same-origin cookies (`chore_session`). There is no general-purpose API key in this MVP.

## Read model and CRUD

`GET /api/snapshot?horizon=30` returns services, rules, cashflows, wallets, counterparties, public actions, recent events, coverage and obligations. Horizon is 1-365 days. Configuration secrets are excluded.

Collections support GET, POST and GET/PUT/PATCH/DELETE by UUID:

```
/api/services
/api/rules
/api/cashflows
/api/wallets
/api/counterparties
/api/actions
```

Important behavior: deleting a service means cancellation; deleting a pending cash flow retains a skipped history row and stops that recurrence; settled cash flows and referenced wallets/counterparties cannot be deleted. Include the returned `version` when editing services, rules, cashflows or actions to reject stale edits. Include `expected_balance` when editing a wallet to reject a stale balance replacement.

Minimal creation examples:

```json
{"name":"An account with no billing"}
```

```json
{"service_id":"<service uuid>","type":"interval_since_event","event_type":"LOGIN","interval_days":40,"anchor_at":"2026-08-20","remind_before_days":[7,3,1]}
```

```json
{"service_id":"<service uuid>","direction":"IN","counterparty_id":"<person uuid>","amount":"180.00","currency":"CNY","due_at":"2026-09-08","recurrence":"monthly","interval":1}
```

```json
{"name":"Apple TR","currency":"TRY","balance":"320.00"}
```

Rule types: `fixed_expiry`, `interval_since_event`, `extend_by`. Non-interval rules require `expiry_at`; `extend_days` defaults to 30. Recurrence is `none`, `monthly`, `yearly` or `days`, with an integer `interval`.

Custom actions use `kind: state|url|webhook`, `service_id`, `label` and `enabled`. State actions additionally use `operation` and, except cancellation, `rule_id`. URL actions use `url`. Webhook actions use `webhook_url`, `method`, `headers` (JSON object), `body` (JSON), optional `rule_id`, and optional `success_event`.

## Scoped execution

Authenticated `POST /api/action-tokens`:

```json
{"operation":"mark_login","entity_id":"<rule uuid>"}
```

Returns `token` and `expires_at`. Execute with:

```
POST /api/actions/<token>/execute
Content-Type: application/json

{}
```

That execution endpoint intentionally does not require the admin session: the unguessable token is its scoped authorization. It accepts no client-selected target overrides and only allows POST. GET never changes state. Tokens are sensitive and should not enter proxy logs or publicly shared notification topics.

Operations and target types:

| Operation | Entity |
| --- | --- |
| `mark_login` | An enabled interval rule; records that rule's event type. |
| `mark_renewed` | A non-interval rule; renews from max(today, current expiry). |
| `extend_expiry` | A non-interval rule; adds to existing expiry. |
| `mark_cashflow_paid` | A pending OUT cash flow. |
| `mark_cashflow_received` | A pending IN cash flow. |
| `skip_cashflow` | A pending cash flow. |
| `cancel_service` | A service. |
| `custom_action` | A configured state/URL/webhook action; server resolves the target. |

A successful result is `{ "ok": true, "message": "...", "event_id": "..." }`. Replayed tokens include `replayed: true`. HTTP 409 indicates a stale/inactive/in-flight action, 410 an expired token, 404 an unknown token. Webhook failures are retained and return 502 on repeat instead of sending again.

## Notifications and diagnostics

- `GET/PUT /api/settings/notifications`: public configuration and write-only secrets. Empty secret strings preserve existing values; `telegram_token_clear`/`ntfy_token_clear: true` explicitly clear stored tokens. Nonempty environment overrides win.
- `GET /api/notifications/preview`: inert payloads with non-executable placeholder tokens.
- `POST /api/notifications/test`: `{ "channel": "telegram" }` or `ntfy`; performs real external delivery.
- `POST /api/notifications/run`: `{}`; scans and delivers currently eligible reminders.
- `GET /api/notifications/logs`: latest 50 delivery rows, sanitized errors.
- `POST /api/demo-seed`: `{}`; once, only in an empty workspace.
- `GET /api/events`: latest 150 events.
- `GET /healthz`: unauthenticated liveness/read check, no configuration data.

A saved notification configuration is not evidence that external delivery works. Use test delivery with real credentials and inspect the log. Preview and the automated tests can be used without credentials.
