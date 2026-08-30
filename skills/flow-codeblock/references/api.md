# Flow Codeblock API Reference

This reference follows the current implementation and lists the public endpoints and important fields used by the MCP server.

## Authentication

- Regular and administrator tokens may be sent as `accessToken`, `access-token`, or `Authorization: Bearer <TOKEN>`.
- Administrator endpoints require an administrator token.
- `/flow/codeblock/{scriptId}` uses the script-bound token by default; `qingcodeToken` may temporarily override it.
- Token rate limiting returns `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` headers.
- `RateLimit-Limit` uses `<limit>;w=<windowSeconds>` and `RateLimit-Reset` is the remaining number of seconds.

## Execution lanes

- The Web worker pool always starts and is isolated from the Standard worker pool. `test_tool.enabled` controls only the web test page.
- Web test requests must send `x-flow-test-tool: 1`. MCP script execution requests must send `X-Flow-Execution-Origin: mcp`. Ordinary HTTP requests send neither marker and use the Standard lane.
- MCP markers always select the Web lane; ordinary HTTP requests always select the Standard lane.

The MCP server authenticates API calls with `FLOW_CODEBLOCK_TOKEN`. MCP JSON outputs recursively redact `token`, `access_token`, `authorization`, `refresh_token`, and `qingcodeToken` fields, preserving the first and last four characters. Lock passwords are request-only credentials and must never be included in code, logs, or documentation examples.

## Conventions

- Default content type is `application/json`.
- `qingcodeTimeout` is milliseconds and a query parameter takes precedence over the request body.
- `codebase64` (execution endpoint) and `code_base64` (script endpoint) contain Base64-encoded JavaScript.
- Dates use `YYYY-MM-DD`; timestamps use `YYYY-MM-DD HH:mm:ss`.

## Response formats

### Standard success response

```json
{
  "success": true,
  "data": {},
  "message": "success",
  "timestamp": "2025-01-01 12:00:00",
  "request_id": "uuid"
}
```

### Standard error response

```json
{
  "success": false,
  "error": {
    "message": "Validation message",
    "type": "ValidationError",
    "details": {}
  },
  "timestamp": "2025-01-01 12:00:00",
  "request_id": "uuid"
}
```

Common `error.details` fields are `field`/`reason`, `retryAfter` for rate limiting, and `limitInfo` when available. Token rate-limit errors use `TokenRateLimitError` and include the rate-limit headers.

### Execution responses

- `POST /flow/codeblock` returns `{ success, result, timing, timestamp, request_id }`; `timing.executionTime` and `timing.totalTime` are milliseconds.
- A failed code execution includes `error.type`, `error.message`, and optionally `error.stack`.
- Errors that can be reliably mapped to user source use one-based `error.details.line`, `column`, and `lineContent`, including pre-validation syntax failures, dangerous-code policy violations, and Bun user-code runtime failures. The API does not fabricate a location when the source frame cannot be verified. Security policy violations on code execution remain `SecurityError`; script-save validation keeps its existing `ValidationError` type.
- `GET|POST /flow/codeblock/{scriptId}` returns the script result directly on success and an error structure with `timing` on failure.
- If the client closes either execution HTTP request before it completes (for example, browser `AbortController`, Postman Cancel, or an interrupted MCP HTTP call), the server cancels that execution and terminates its Bun Worker. The server still writes the failed execution record and refunds the execution quota; no cancellation response is sent after the client disconnects.
- The server generates `X-Request-ID` for every request and ignores a caller-supplied value. CORS success responses expose it through `Access-Control-Expose-Headers`.
- Neither execution endpoint provides business idempotency. Repeated or concurrent calls independently execute, consume quota, and write statistics after validation.
- Code execution does not read `Idempotency-Key`; that header applies only to endpoints that explicitly support it.

## Error types

| error.type | Meaning | Typical HTTP status |
| --- | --- | --- |
| AuthenticationError | Missing or invalid credentials | 401 |
| AuthorizationError | Insufficient permission or invalid administrator token | 403 |
| ValidationError | Parameter validation failed | 400 |
| BadRequestError | Invalid request format or content | 400 |
| NotFoundError | Resource does not exist | 404 |
| RateLimitError | Global rate limit or quota limit | 429 |
| TokenRateLimitError | Token-level rate limit | 429 |
| IPRateLimitError | IP-level rate limit | 429 |
| TokenExpiredError | Token expired | 401/410 |
| TokenInactiveError | Token disabled | 403/410 |
| QuotaExceededError | Quota exhausted | 429 |
| ExecutionTimeoutError | Execution timed out | 400 |
| CancelledError | Client interrupted the execution HTTP request; the server cancels the execution and refunds its execution quota | not returned after disconnect |
| ExecutionError | Code execution failed | 400 |
| SyntaxError | User code cannot be parsed before execution | 422 |
| SecurityError | User code violates an execution security or output protocol policy | 422 |
| ScriptError | Aggregated script error | 400/404/409/429 |
| DuplicateScriptError | Duplicate script code | 409 |
| ScriptQuotaExceededError | Script count quota exceeded | 429 |
| ScriptLockedError | Script is locked; editing, rollback, and deletion are forbidden | 423 |
| VersionNotFoundError | Script version does not exist | 404 |
| IPNotAllowedError | Caller IP is not allowlisted | 403 |
| ServiceUnavailableError | Service unavailable, circuit open, or synchronizing | 503 |
| InternalError | Internal server error | 500 |
| CORSError | Cross-origin request denied | 403 |

## Data structures

### CodeScript

`id`, `description`, `code_base64`, `code_hash`, `code_length`, `version`, `ip_whitelist`, `created_at`, `updated_at`, optional `available_versions`, and `lock` (`is_locked`, `locked_at`, `lock_owner_name_hint`). The owner name is masked in read responses.

### QuotaLog

`id`, `token`, `ws_id`, `email`, `quota_before`, `quota_after`, `quota_change`, `action`, `request_id`, `execution_success`, `execution_error_type`, `execution_error_message`, and `created_at`.

### ScriptListItem

`id`, `description`, `version`, `code_length`, `updated_at`, and `lock`. Business timestamps are formatted in Shanghai time as `YYYY-MM-DD HH:mm:ss`; nulls remain null. `specific_date` and `expires_at` accept RFC3339 input.

### Statistics structures

- `ScriptStatsOverview`: `period`, `summary`, `daily_trend`, and optional `top_scripts`; summary includes execution counts, success rate, average/max execution time, script ID, latest version, code length, and description.
- `ScriptDailyTrend`: `date`, `total`, `success`, `failed`.
- `ScriptTopItem`: `script_id`, `description`, `executions`, `success_rate`, `avg_time_ms`.
- `GlobalScriptStats`: period, script/version/execution totals, success/failure metrics, `error_stats`, optional `cache_stats`, `top_scripts`, and `daily_trend`.
- `GlobalErrorStats`: `quota_exceeded`, `ip_blocked`, `not_found`, `cache_update_failed`.
- `GlobalCacheStats`: `hit_count`, `miss_count`, `hit_rate`.
- `ModuleInfo`: `name`, `version`, `installed`, `size`, `description`, `license`.
- `ModuleBlacklistDetail`: `blacklist` loaded at startup and passed to Bun Supervisor, plus `count`.
- `ModuleStatsResponse`: query, summary, and module usage rows with counts, success rates, active days, and percentages.
- `ModuleDetailStats`: module, period, usage summary, daily trend, and top users.
- `UserActivityStatsResponse`: query, summary, pagination, and user rows with calls, success rates, module usage, and optional timestamps.
- `TokenCacheStats`: hot/warm/cold cache counters, performance rates, and `redis_enabled`.
- `RateLimitStats`: `enabled`, `backend`, `redis_enabled`, `allowed`, `denied`, and `errors`.
- `CacheWritePoolStats`: submission, processing, success/failure/timeout, queue, worker, and running-state counters.
- `ScriptCleanupResult`: trigger and timing fields, deleted-record counts, and optional error/skip fields.

## Endpoint details

### Health and status

- `GET /`: no authentication (global IP limit); returns `data={service,version,status}`.
- `GET /health`: unauthenticated liveness check; returns `data={status:"ok"}`.
- `GET /health/ready`: unauthenticated readiness check; returns 200 with `ready` or 503 with `not_ready`; checks startup completion, MySQL, enabled Redis, and the Bun Supervisor pool.
- `GET /flow/health`: administrator health details. `mode=ready` or `mode=readiness` returns dependency checks, runtime saturation, execution counters, success rate, and memory.
- `GET /flow/status`: administrator runtime status, uptime, engine/version, memory, executor statistics, caches, limits, and optional rate-limiter/token-cache details.
- `GET /flow/limits`: administrator execution, concurrency, cache, circuit-breaker, rate-limit, database, Redis, and token-cache settings.

### Test page

- `GET /flow/test-tool`: unauthenticated HTML test page under the global IP limit. Session configuration may set a session cookie.

### Code execution

- `POST /flow/codeblock`: Token authentication. Body fields are required `codebase64`, optional `input` (default `{}`), and optional `qingcodeTimeout`; a query timeout overrides the body. Returns execution result or error and automatically generates `X-Request-ID`.
- `GET|POST /flow/codeblock/{scriptId}`: script-token and IP-allowlist checks. `qingcodeToken` may override the bound token, `qingcodeTimeout` configures timeout, other query values become business query input, and POST JSON becomes business body input. MCP sends `accessToken` and `X-Flow-Execution-Origin: mcp`; no browser cookies or CSRF token are required. Script redirect results may use `flow_redirect_url` and optional `flow_redirect_code` (301/302/303/307/308).

### Administrator token management

- `POST /flow/tokens`: create or extend a token with `ws_id`, `email`, `operation` (`add|set|unlimited`), quota settings, rate limits, and `max_scripts`. `add` requires positive `days`; `set` requires `specific_date`; count/hybrid quotas require positive `total_quota`. Legacy `per_minute`, `burst`, and `window_seconds` are unsupported.
- `PUT /flow/tokens/{token}`: administrator update with optional `Idempotency-Key`; supports expiration, rate limits, quota operation (`add|set|reset`), quota amount/total, quota type, and `max_scripts`.
- `DELETE /flow/tokens/{token}`: atomically disables the token and writes cache invalidation. A 503 for delivery failure may be safely retried with the same request.
- `GET /flow/tokens/{token}/quota`: returns time-mode status or quota totals and remaining/consumed values for other modes.
- `GET /flow/tokens/{token}/quota/logs`: paginated quota logs with optional date range.
- `GET /flow/quota/cleanup/stats` and `POST /flow/quota/cleanup/trigger`: cleanup configuration, last result, and manual trigger status.
- `GET /flow/cache/stats`, `DELETE /flow/cache`, `GET /flow/rate-limit/stats`, `DELETE /flow/rate-limit/{token}`, and `GET /flow/cache-write-pool/stats`: administrator cache, rate-limit, and write-pool operations.

### Token-authenticated script management

- `POST /flow/scripts`: create with `code_base64`, optional `description`, `ip_whitelist`, and a complete `interface_doc`; creation stores code and documentation as version 1 and does not accept patches.
- `PUT /flow/scripts/{scriptId}`: update with optional `expected_version`, code, description, IP allowlist, complete `interface_doc`, mutually exclusive `interface_doc_patch`, or `rollback_to_version`. Code-only updates preserve the current interface document. Code and rollback are mutually exclusive. Identical code changes only metadata and return `code_changed=false`; locked scripts return 423.
- `POST /flow/scripts/validate`: authenticate, normalize, and validate code/document inputs without database writes or execution quota consumption. It accepts complete `interface_doc` or `interface_doc_patch`, not both.
- `DELETE /flow/scripts/{scriptId}`: allowed only when unlocked; locked scripts return `ScriptLockedError`.
- `POST /flow/scripts/{scriptId}/lock`: requires `{owner_name,lock_password}`; owner names are trimmed, limited to 64 characters, and cannot contain control characters; lock passwords are 6-128 bytes and are stored as a hash.
- `POST /flow/scripts/{scriptId}/unlock`: requires the same `{owner_name,lock_password}` used when locking; a successful unlock clears the lock state and stored credentials.
- `GET /flow/scripts/{scriptId}`: `version=0` or omitted means current; positive integers request history. Returns available versions, current version, and version rows with code and metadata.
- `GET /flow/scripts`: paginated list with keyword, stable sort, and order controls; returns scripts, totals, page data, and remaining quota.
- `GET /flow/scripts/{scriptId}/stats`: single date or date range; defaults to the most recent seven days and returns `ScriptStatsOverview`.

### Administrator script management

- Emergency lock recovery is available only through the separately configured Rust recovery route; MCP does not expose it.
- `GET /flow/scripts/stats`: global script statistics with optional date range and pagination.
- `GET /flow/scripts/cleanup/stats` and `POST /flow/scripts/cleanup/trigger`: cleanup configuration and trigger result.

### Administrator statistics

- `GET /flow/stats/modules`: module usage for a single date or up to a 31-day range; defaults to the current day.
- `GET /flow/stats/modules/{module_name}`: detailed module usage for the same date rules.
- `GET /flow/stats/users`: user activity with date range, pagination, minimum calls, sort, and optional workspace ID.

### Administrator module and security management

- `GET /flow/modules`: list installed modules; `include_size` defaults true.
- `GET /flow/modules/blacklist`: return the read-only blacklist snapshot loaded at startup.
- `GET /flow/modules/{name}`: return one module's metadata.
- `GET /flow/security/dangerous_patterns`: return dangerous identifiers, members, counts, and config path.
- Module installation/synchronization and dangerous-pattern reload have no HTTP API; update the host-mounted configuration and restart the service.

### Static assets

`GET /flow/assets/*` serves static assets. Legacy flat aliases include Ace files under `assets/codemirror/` and `/flow/assets/logo.png` mapped to `assets/elements/LOGO.png`. Common paths include `ace.js`, JavaScript/JSON modes and workers, `theme-monokai.js`, `ext-searchbox.js`, `logo.png`, `verify-code.js`, test-tool assets, and script-manager files.

## Interface documents

Script interface documents use normalized `script-interface-doc.v1` JSON stored in version snapshots. Documentation endpoints use script-management authentication, rate limits, and permissions and are not included in public execution responses or execution caches.

- `GET /flow/scripts/{script_id}/documentation?version=...`: read the current or an explicit historical document. `data.document` is null when absent; historical documents are read-only.
- `POST /flow/scripts/{script_id}/documentation`: validate and normalize without database writes. Accept either `document` or a JSON `raw_document`; do not send YAML. Root fields, request/response examples, Schema metadata, method ordering, cardinality limits, and caller-facing terminology must satisfy the complete contract.
- `PUT /flow/scripts/{script_id}/documentation`: same input rules plus positive `expected_version`; send exactly one of `document`, `raw_document`, or up to 256 RFC 6902 `document_patch` operations. The server re-normalizes and validates before saving; bad paths return 400 and version conflicts return 409.
- `PUT /flow/scripts/{script_id}` also accepts `interface_doc_patch`; patches are mutually exclusive with `interface_doc`, require `expected_version`, and create a new version only when code or canonical documentation changes.

Use the MCP tools rather than manually constructing these requests. They perform the local preflight, normalization, and confirmation workflow described in `AGENT_PROMPT.md`.
