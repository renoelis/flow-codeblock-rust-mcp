---
name: flow-codeblock-rust
description: Use the Flow Codeblock Rust+Bun MCP tools to query, validate, publish, and execute scripts. Refuse script deletion and emergency recovery unlock requests and direct the user to a controlled REST/operations workflow.
---

# Flow Codeblock Rust+Bun

This Skill works with the plugin's local stdio MCP server. The MCP server calls the current project's Rust HTTP API; user JavaScript continues to run in the server's fixed-version Bun executor.

## Authentication and boundaries

- The MCP server reads `FLOW_CODEBLOCK_BASE_URL` from the process environment, defaulting to `http://127.0.0.1:3003`.
- Management requests use `FLOW_CODEBLOCK_TOKEN` as `Authorization: Bearer`; tools do not require tokens in business arguments.
- When executing a published script, the MCP token, Authorization, Cookie, CSRF, and test-tool markers are not placed in script input.
- MCP does not provide script deletion, emergency recovery unlock, token management, statistics, ownership transfer, or arbitrary HTTP proxy tools.
- This release provides a local stdio MCP server only; it does not promise remote HTTP, SSE, or Streamable HTTP transports.

## Tool selection

- `flow_list_scripts`: list scripts with the current API's page or cursor pagination; `keyword` matches both script description and script ID.
- `flow_get_script`: read the current or a historical version's code and metadata.
- `flow_get_script_documentation`: read current or historical interface documentation.
- `flow_validate_script_documentation`: validate and normalize documentation without writing to the database.
- `flow_write_code`: generate a non-script or script code contract under the current Bun runtime, module allowlist, and documentation-completeness rules; it does not write or execute.
- `flow_preview_script_change`: preview a change and call the server's unified validation endpoint; creates and code updates require a complete interface document.
- `flow_apply_script_change`: apply only previewed content; `confirm: true` is required.
- `flow_preview_script_documentation` / `flow_apply_script_documentation`: preview, confirm, and save interface documentation.
- `flow_lock_script` / `flow_unlock_script`: use an owner name and lock password; `confirm: true` is required.
- `flow_execute_script`: execute a published script with GET/POST, query, headers, body, and timeout_ms.
- `flow_execute_code`: execute unpublished generated code with mode-appropriate input.

## Script change workflow

1. Before an update, call `flow_get_script`, record the current `version`, and pass it as `expected_version` to the preview.
2. Call `flow_preview_script_change`. Creates require code and a complete `interface_doc` and forbid patches. Code or documentation updates may use a complete document or an RFC 6902 `interface_doc_patch`, but not both; patches require the current `expected_version`. Description/IP-only changes may omit documentation, and rollback cannot be combined with code, a complete document, or a patch.
3. Call the corresponding `flow_apply_*` tool only after explicit user confirmation and pass `confirm: true`.
4. Apply tools read the current version again and pass `expected_version` to the Rust API's transactional version check. On a version change, expired preview, or preview-content validation failure, stop and read/preview again.

`POST /flow/scripts/validate` is the read-only unified validation endpoint. MCP previews use it for code, IP allowlists, complete documents, and patches. Final writes re-submit patches and validate the current document and `expected_version` in a transaction; version conflicts return HTTP 409. Patch previews never echo the complete merged document.

Script-mode generation requires a non-empty `description` of at most 20 Unicode characters; MCP validates it before any preview or publication call. API `timestamp`, `created_at`, `updated_at`, and `locked_at` fields use `Asia/Shanghai` (`UTC+08:00`).

Execution errors preserve the server's error type, concise message, and stack when available. Verified user-code locations are returned in `error.details.line`, `error.details.column`, and `error.details.lineContent` using one-based line and column numbers; details are omitted when the location cannot be verified. Security-policy messages contain only the concise rule reason; source location, matched text, and source line are not duplicated in `message`. Direct execution uses `SyntaxError` for parse failures and `SecurityError` for execution policy failures; these user-code failures return HTTP 422 with `retryable: false`. Script-save validation may retain `ValidationError` for policy failures.

## Interface-documentation rules

Documents must follow `script-interface-doc.v1`. Methods are limited to GET and POST, and the server normalizes paths by script ID. Required top-level fields are `schema_version`, `title`, `summary`, `endpoint`, `request`, `responses`, and `logic_description`; `endpoint.methods` and `endpoint.description` are required. `request.query` and `request.headers` must exist; use `[]` when empty. POST documents require `request.body` with `content_type`, `schema`, and `example`. Every query/header parameter requires `name`, `type`, `required`, `description`, and `example`; every response requires `status`, `description`, `content_type`, `schema`, and `example`. Submit the interface contract as a standalone JSON object, never as JavaScript comments, and never include real tokens, passwords, cookies, Authorization values, or other credentials. Omit `endpoint.path` when creating; use `/flow/codeblock/<actual-script-id>` when updating. A public URL combines the caller-provided service origin with `/flow/codeblock/{{script_id}}`.

Patches contain at most 256 operations and support `add`, `remove`, `replace`, `move`, `copy`, and `test` using RFC 6901 JSON Pointer paths. The complete and patch schemas are in `references/script-interface-doc.schema.json` and `references/script-interface-doc.patch.schema.json`.

Read these references before generating or changing scripts:

- [API contract](references/api.md)
- [Interface-documentation schema](references/script-interface-doc.schema.json)
- [Dangerous patterns](references/dangerous_patterns.json)
- [Allowed modules](references/modules.json)

## Code-generation rules

Treat `input` as a reserved, read-only runtime binding: never declare, redeclare, rebind, or destructure a local binding named `input` in any scope, including function parameters and nested callbacks. If a local name is needed, alias it to `payload` or another name, for example `const payload = input`; review the complete source for input shadowing before every execution and retry.

User code must read input from `input` and return through top-level `return` or a valid `qf_output`; use only allowed modules and follow code, input, result, and timeout limits. Treat forbidden identifiers as forbidden in every syntactic position, including properties and method calls. Never generate `RegExp.exec` or `.exec(...)`; use `text.match(regex)` for capture groups or `regex.test(text)` for boolean checks, and review the complete source for forbidden identifiers, members, and modules before execution. After generating code, run a meaningful execution test immediately when the available requirement and safe input are sufficient; execution-only verification does not require user confirmation. If required input or credentials are missing, report that runtime verification was not performed instead of inventing them. Script mode internally generates executable JavaScript and a submit-ready `interface_doc` JSON for preview, validation, and publication. Final output hides JavaScript and raw `interface_doc` by default and shows invocation instructions, request parameters and examples, execution logic, success/error examples, and the published `script_url` unless source or raw documentation is explicitly requested. For every initial generation and every later non-script revision, always show the complete latest generated JavaScript in the final response, even after runtime verification; never show only a patch, diff, or partial snippet. Also include invocation instructions, request parameters and examples, execution logic, success/error examples, and `execution_url`.

Use Bun-native `fetch` or real axios for network requests and `node:crypto` for cryptography; never generate the removed `crypto-js`. Constructor-based code generation, `process.env`, and `fs`/`node:fs` are forbidden. Excel imports are limited to `read-excel-file/node`, `read-excel-file/universal`, `write-excel-file/node`, `write-excel-file/universal`, and `write-excel-file/utility`; do not use the root, browser, or web-worker entry points of these packages.
