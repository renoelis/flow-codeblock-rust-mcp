# Flow Codeblock Rust MCP Installation

This guide explains how to use `flow-codeblock-rust-mcp` with a client that supports a local stdio MCP server.

## 1. Prerequisites

Install Bun `1.4.0` or newer and verify it:

```bash
bun --version
```

Obtain a user-scoped `FLOW_CODEBLOCK_TOKEN` from your Flow Codeblock administrator. The token is used only for MCP-to-Rust-API management requests and must never be written into user scripts or interface documents.

## 2. General configuration

```json
{
  "mcpServers": {
    "flow-codeblock-rust": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.6"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

`FLOW_CODEBLOCK_BASE_URL` is the Rust REST API origin and defaults to `http://127.0.0.1:3003`. Do not configure it as a remote MCP URL. Public deployments must use HTTPS or the bearer token would be transmitted in clear text.

You can also check startup from a terminal:

```bash
export FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
export FLOW_CODEBLOCK_TOKEN='<YOUR_FLOW_CODEBLOCK_TOKEN>'
bunx --bun flow-codeblock-rust-mcp@0.1.6
```

After startup the process waits for the client to communicate over stdio; this is expected.

## 3. Supported boundaries

Supported:

- Script listing and current or historical version reads.
- Documentation reads, read-only validation, preview, and confirmed saves.
- Script creation, code/description/IP allowlist updates, and version rollback.
- Script locking and normal unlocking.
- Published-script execution and unpublished-code tests.

Not supported:

- Script deletion.
- Emergency recovery unlock.
- Token lookup or management, execution statistics, or ownership transfer.
- Arbitrary HTTP proxying.
- Remote HTTP, SSE, or Streamable HTTP MCP transports.

## 4. Script write workflow

MCP tools follow this order and do not require the additional Skill:

1. Read the current script version and interface document.
2. Preview the code or documentation change; preview calls the server's read-only validation endpoint.
3. Show the change summary to the user and wait for explicit confirmation.
4. Apply with `confirm: true`; the server checks `expected_version` transactionally.

If the version changes, the preview is older than 10 minutes, or its contents fail validation, apply is rejected and you must read and preview again. The in-memory preview store keeps at most 256 entries, removes expired entries when accessed, and releases an entry after either successful or failed application.

When creating or changing a script, `interface_doc` must include `schema_version`, `title`, `summary`, `endpoint`, `request`, `responses`, and `logic_description`. `endpoint.methods`, `endpoint.description`, `request.query`, and `request.headers` are required; use `[]` when there are no parameters. POST documents also require `body.content_type`, `body.schema`, and `body.example`. Every query/header parameter requires `name`, `type`, `required`, `description`, and `example`; every response requires `status`, `description`, `content_type`, `schema`, and `example`. Public script URLs combine the caller-provided service origin with `/flow/codeblock/{{script_id}}`; never put credentials in URLs or examples.

Final delivery is mode-specific. Non-script mode shows complete JavaScript, invocation instructions, request parameters and examples, execution logic, success/error examples, and `execution_url`. Script mode hides JavaScript and raw `interface_doc` by default and shows invocation instructions, request parameters and examples, execution logic, success/error examples, and the published `script_url`, unless the user explicitly asks for source or raw documentation.

## 5. Security notes

- Management requests use `Authorization: Bearer`; published-script execution does not forward that credential.
- User-supplied Authorization, accessToken, Cookie, CSRF, test-tool, MCP, `Forwarded`, `X-Real-IP`, and `X-Forwarded-*` headers are filtered.
- All API requests use a 30-second timeout. Errors retain only the HTTP status and a redacted server error body.
- Execution errors preserve a concise `message`; verified user-code locations are preserved in `error.details.line`, `error.details.column`, and `error.details.lineContent` with one-based line and column numbers. Security-policy messages do not duplicate source location, matched text, or source line. The details are omitted when the location cannot be verified. Direct parse and execution-policy failures use `SyntaxError` and `SecurityError` and return HTTP 422 with `retryable: false`.
- Inject tokens through client secret management; never commit them to Git, an npm package, or public configuration.
