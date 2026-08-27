# API Reference

The service listens on `http://127.0.0.1:3003` by default. All endpoints except health checks, test-tool static assets, and published-script execution by ID require the internal access token:

```http
Authorization: Bearer <INTERNAL_ACCESS_TOKEN>
```

The service also accepts `accessToken: <INTERNAL_ACCESS_TOKEN>`. Browser-originated write requests additionally require an `X-CSRF-Token` obtained from `/flow/test-tool/csrf`; the built-in test tool handles this token automatically.

## Response contract

Successful responses contain `success: true`, business fields, `timestamp`, and a UUID v4 `request_id`. Execution endpoints also include:

```json
{
  "success": true,
  "result": {"value": 42},
  "timing": {"executionTime": 3.247, "totalTime": 8.912},
  "timestamp": "2026-07-26 12:00:00",
  "request_id": "00000000-0000-4000-8000-000000000000"
}
```

`executionTime` measures the lifecycle of the user's JavaScript in milliseconds, rounded to three decimal places. It includes asynchronous waits triggered by user code but excludes execution-queue wait, runtime initialization, and result serialization. `totalTime` is the server's estimated time from request receipt to construction of the final response body, including request-body reading, validation, queueing, execution, and response handling, but excluding network round trips. Response Time shown by a browser Network panel, Postman, or curl is measured by the client and is usually larger. Error responses contain `error.type` and `error.message`.

When the server can verify a user-code source location, `error.details` contains `line`, `column`, and `lineContent`; line and column are one-based. This applies to pre-execution syntax errors, dangerous-pattern policy failures, and Bun user-code runtime failures. The field is omitted when the location cannot be verified. Security-policy `message` values contain only the concise rule reason; source location, matched text, and source line are not duplicated there and must be read from `error.details`. Direct execution reports parse failures as `SyntaxError` and execution policy failures as `SecurityError`; these user-code failures return HTTP 422 with `retryable: false`. Script-save validation may retain `ValidationError` for policy failures.

Example source-location details:

```json
{
  "type": "ReferenceError",
  "message": "missing is not defined",
  "details": {
    "line": 2,
    "column": 8,
    "lineContent": "return missing;"
  }
}
```

## Health and monitoring

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | `/` | No | Service identity and request ID |
| GET | `/flow/health` | No | Process liveness check |
| GET | `/flow/health/ready` | No | MySQL and executor readiness check |
| GET | `/flow/metrics` | Yes | Dependency and execution-pool status |

## Direct execution

`POST /flow/codeblock` requires authentication. The request body's `codebase64` is Base64-encoded UTF-8 JavaScript; the code must contain `return` or a valid `qf_output` assignment.

```json
{
  "codebase64": "cmV0dXJuIHsgdmFsdWU6IGlucHV0Lm51bWJlciAqIDIgfTs=",
  "input": {"number": 21},
  "qingcodeTimeout": 15000
}
```

The timeout may be omitted, but when present it must be between `MIN_EXECUTION_TIMEOUT_MS` and `MAX_EXECUTION_TIMEOUT_MS`. Scripts importing `read-excel-file`, `write-excel-file`, or `xlsx` are automatically routed to the shared heavy pool. Excel imports are limited to `read-excel-file/{node,universal}` and `write-excel-file/{node,universal,utility}`. Use `node:crypto` for cryptography; the removed `crypto-js` package is forbidden.

## Script management

All endpoints below require the internal access token except the emergency recovery endpoint. Browser-originated write requests still require CSRF validation.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/flow/scripts` | Create a script |
| POST | `/flow/scripts/validate` | Read-only validation of code, IP allowlist, and a complete document or RFC 6902 patch |
| GET | `/flow/scripts` | Paginated script listing |
| GET | `/flow/scripts/{script_id}` | Read the current script or a historical version |
| PUT | `/flow/scripts/{script_id}` | Update code, description, IP allowlist, complete document, RFC 6902 patch, or rollback version |
| GET | `/flow/scripts/{script_id}/documentation` | Read current or historical interface documentation |
| POST | `/flow/scripts/{script_id}/documentation` | Validate and normalize JSON interface documentation without writing |
| PUT | `/flow/scripts/{script_id}/documentation` | Save interface documentation and create a new document version |
| DELETE | `/flow/scripts/{script_id}` | Delete a script and all historical versions |
| POST | `/flow/scripts/{script_id}/lock` | Lock a script with an owner name and lock password |
| POST | `/flow/scripts/{script_id}/unlock` | Normally unlock a script with an owner name and lock password |
| POST | `/flow/scripts/{script_id}/unlock/recovery` | Operations-only emergency recovery unlock; registered only when a recovery token is configured |

Create request:

```json
{
  "code_base64": "cmV0dXJuIGlucHV0Ow==",
  "description": "Example script",
  "ip_whitelist": ["10.10.0.0/16"]
}
```

An update may include `expected_version`, `code_base64`, `description`, `ip_whitelist`, `interface_doc`, `interface_doc_patch`, or `rollback_to_version`. `interface_doc` and `interface_doc_patch` are mutually exclusive; patches are allowed only for existing scripts and require a positive integer `expected_version`. The server canonicalizes the current document, applies up to 256 RFC 6902 operations in order, and validates the result. A version conflict returns HTTP 409 `VersionConflictError`. Creates forbid patches; `code_base64` and `rollback_to_version` cannot be combined.

Interface documents use `script-interface-doc.v1`. Methods are limited to the script runtime's `GET` and `POST`; `endpoint.path` may be omitted on create and must be `/flow/codeblock/<actual-script-id>` on update. A public URL is built from the caller-provided domain and `/flow/codeblock/{{script_id}}`. Request and response `schema` fields use JSON Schema; multiple entries may describe different business results for the same status code. Documents can be submitted through `document`, `raw_document`, or `document_patch` applied to an existing document. Patch paths use JSON Pointer, and preview results return only operation counts, paths, warnings, and version information. Description-only and IP-allowlist-only changes do not increment the script version; canonical document or code changes create a new version.

Final delivery is mode-specific. Non-script mode shows complete JavaScript, invocation instructions, request parameters and examples, execution logic, success/error examples, and a complete `execution_url`. Script mode hides JavaScript and raw `interface_doc` by default and shows invocation instructions, request parameters and examples, execution logic, success/error examples, and the published `script_url`, unless source or raw documentation is explicitly requested.

Example:

```json
{
  "document": {
    "schema_version": "script-interface-doc.v1",
    "title": "Customer lookup",
    "summary": "Look up customer information by customer ID.",
    "endpoint": {
      "methods": ["GET"],
      "description": "A read-only endpoint that looks up customer information by customer ID."
    },
    "request": {
      "query": [{
        "name": "customer_id",
        "type": "string",
        "required": true,
        "description": "Customer identifier",
        "example": "C10001"
      }],
      "headers": []
    },
    "responses": [{
      "status": 200,
      "description": "Lookup succeeded",
      "content_type": "application/json",
      "schema": {
        "type": "object",
        "properties": {"success": {"type": "boolean"}},
        "required": ["success"],
        "additionalProperties": false
      },
      "example": {"success": true}
    }],
    "logic_description": "Validate the customer ID, look up customer information, and return an appropriate error response when the lookup fails."
  }
}
```

List queries use offset pagination by default:

```text
GET /flow/scripts?page=1&size=20&keyword=invoice&sort=updated_at&order=desc
```

Cursor pagination uses `pagination=cursor`; omit `cursor` on the first request and use the cursor returned by the previous response:

```text
GET /flow/scripts?pagination=cursor&size=20&sort=updated_at&order=desc&cursor=<cursor>
```

Cursor pagination supports only `updated_at`, `created_at`, and `code_length` sorting; the maximum `size` is 100.

### Emergency recovery unlock

`POST /flow/scripts/{script_id}/unlock/recovery` is an operations recovery endpoint for a lost lock password. The service registers it only when `SCRIPT_LOCK_RECOVERY_TOKEN` is configured and non-empty; otherwise the path returns `404`. A successful recovery clears lock state, lock time, owner name, and password hash and refreshes the script cache.

This endpoint does **not** use `Authorization`, `accessToken`, or a CSRF token. It requires the raw recovery token in the dedicated request header. The raw value must be a 32-4096 byte RFC 6750 bearer-token-format string; do not add a `Bearer ` prefix. Browser-context requests are rejected. Do not call this endpoint from the test tool, a frontend page, or browser code, and never distribute the recovery token to clients.

The request body is empty. Example (run only from a controlled operations terminal; do not write the token to scripts, shell history, or logs):

```bash
curl --request POST "${FLOW_BASE_URL}/flow/scripts/${SCRIPT_ID}/unlock/recovery" \
  --header "X-Script-Lock-Recovery-Token: ${SCRIPT_LOCK_RECOVERY_TOKEN}"
```

On success the endpoint returns `200` with this `lock` field:

```json
{
  "is_locked": false,
  "locked_at": null,
  "lock_owner_name_hint": null
}
```

Common failure statuses: `401` means the recovery token is missing or does not match; `403` means browser-context headers such as `Origin`, `X-CSRF-Token`, or `Sec-Fetch-*` were sent; `400` means the script ID is invalid; `404` means recovery is disabled or the script does not exist; `503` means script storage is unavailable.

## Execute by script ID

`GET|POST /flow/codeblock/{script_id}` is intended for controlled enterprise callers and does not require an access token. The service still checks script state, source-IP allowlists, code safety rules, and execution timeout. Do not expose this endpoint to an uncontrolled network or use scripts for unauditable external side effects.

POST bodies, query parameters, headers, and cookies map to script `input` according to the existing input contract. A script return object may set `flow_redirect_url` and an optional `flow_redirect_code` (301, 302, 303, 307, or 308) to trigger a safe HTTP(S) redirect.

## Built-in test tool

| Method | Path | Description |
| --- | --- | --- |
| GET | `/flow/test-tool` | Test-tool page |
| GET | `/flow/test-tool/csrf` | Obtain a browser CSRF token |
| GET | `/flow/assets/{asset_path}` | Test-tool static asset |

The Ace JavaScript mode uses `/flow/assets/worker-javascript-flow.js`, which wraps the stock worker and keeps diagnostics aligned with the server-side runtime.
