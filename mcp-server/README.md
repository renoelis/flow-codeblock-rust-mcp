# flow-codeblock-rust-mcp

Local stdio MCP server for Flow Codeblock Rust+Bun. It calls the server-side Rust REST API and never executes scripts on the user's machine; user JavaScript runs in the server-side Bun executor.

## Installation and startup

Bun 1.4.0 or newer is required:

```bash
bunx --bun flow-codeblock-rust-mcp@0.1.11
```

Configure the environment:

```bash
export FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
export FLOW_CODEBLOCK_TOKEN='<YOUR_INTERNAL_ACCESS_TOKEN>'
```

`FLOW_CODEBLOCK_TOKEN` is the internal access token for the current Flow Codeblock service. Use HTTPS in production and never put a real token in the repository, npm package, shell history, or public client configuration.

## Stdio configuration

```json
{
  "mcpServers": {
    "flow-codeblock-rust": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.11"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_INTERNAL_ACCESS_TOKEN>"
      }
    }
  }
}
```

## Tool boundaries

Generated code treats `input` as a reserved, read-only runtime binding: never declare, rebind, or shadow it in any scope; use an alias such as `const payload = input` when a local name is needed. Review the complete source for input shadowing before every execution and retry.

The code contract follows the current Rust+Bun module allowlist. `crypto-js` has been removed; use `node:crypto` for cryptography. Excel imports are limited to `read-excel-file/node`, `read-excel-file/universal`, `write-excel-file/node`, `write-excel-file/universal`, and `write-excel-file/utility`; these modules run in the server's shared heavy execution pool.

The tools cover code-contract generation, unpublished-code tests, script listing, version reads, documentation validation/preview/save, script creation/update, locking/unlocking, and published-script execution. Creates and code updates can submit a complete interface document or RFC 6902 `interface_doc_patch`; preview calls `/flow/scripts/validate`, and apply re-submits patches with transactional `expected_version` conflict detection. Every script write requires a preview and explicit `confirm: true`.

The authoring context treats forbidden identifiers as forbidden in properties and method calls too; for example, generated code uses `text.match(regex)` or `regex.test(text)` instead of `RegExp.exec`. When generated code and the available safe input are sufficient for a meaningful runtime test, the client executes it immediately without waiting for user confirmation. If required input or credentials are missing, it reports that runtime verification was not performed instead of inventing them. Final delivery is mode-specific. Every initial `non_script` generation and every later revision returns the complete latest generated JavaScript, never only a patch, diff, or partial snippet, even after runtime verification; it also includes invocation instructions, request parameters and examples, execution logic, success/error examples, and a complete `execution_url`. `script` omits JavaScript and raw `interface_doc` by default and returns invocation instructions, request parameters and examples, execution logic, success/error examples, and the published `script_url`. Script code and `interface_doc` remain internal inputs to MCP preview, validation, and publication unless the user explicitly requests source or raw documentation.

Execution errors preserve a concise `message` and verified user-code locations in `error.details.line`, `error.details.column`, and `error.details.lineContent` with one-based line and column numbers. Source location, matched text, and source line are not duplicated in security-policy messages. The details are omitted when the location cannot be verified; direct parse and execution-policy failures use `SyntaxError` and `SecurityError` respectively and return HTTP 422 with `retryable: false`.

MCP does not provide script deletion, emergency recovery unlock, token lookup, execution statistics, ownership transfer, or arbitrary HTTP proxy tools. This release provides local stdio only; it does not expose remote HTTP, SSE, or Streamable HTTP transports.

## MCP tool contract

At initialization the server sends complete tool selection, preview/confirmation, runtime, and interface-documentation rules through MCP `instructions`. Clients should prefer tool descriptions and input-schema field descriptions instead of guessing parameters through trial and error.

Interface documents must include `schema_version`, `title`, `summary`, `endpoint`, `request`, `responses`, and `logic_description`. `endpoint` requires `methods` and `description`; `request.query` and `request.headers` must exist (use `[]` when empty). POST documents also require `request.body` with `content_type`, `schema`, and `example`. Every response requires `status`, `description`, `content_type`, `schema`, and `example`; every query/header parameter requires `name`, `type`, `required`, `description`, and `example`.

Every nested schema property, array item, and object-form `additionalProperties` node requires `type`, `description`, and `example`, with examples covering declared fields. MCP accepts one legacy JSON-text parse, fills examples only from matching parent examples, and uses a neutral description when one is omitted.

`endpoint.path` is relative: omit it when creating and use `/flow/codeblock/<actual-script-id>` when updating. Public request URLs combine the caller-provided service origin with `/flow/codeblock/{{script_id}}`. Never put real tokens, passwords, cookies, or Authorization values in code, documents, examples, or URLs.

`interface_doc_patch` and `document_patch` require a positive integer `expected_version` and support at most 256 `add/remove/replace/move/copy/test` operations. Patch previews return operation counts, JSON Pointer paths, warnings, and version information, never the complete merged document.

## Security behavior

- Management requests use `Authorization: Bearer`; the MCP token is not forwarded into published-script input.
- User-supplied Authorization, accessToken, Cookie, CSRF, test-tool, MCP, `Forwarded`, `X-Real-IP`, and `X-Forwarded-*` headers are filtered.
- Requests have a 30-second timeout; previews have a 10-minute TTL and a 256-entry limit.
