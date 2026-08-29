# Flow Codeblock Rust MCP

This repository contains the standalone MCP server and Codex Plugin for the Flow Codeblock Rust+Bun service. The MCP server receives requests over local `stdio` and calls the Flow Codeblock Rust REST API; user JavaScript always runs in the server-side Bun executor.

This project is maintained separately from the existing `flow-codeblock-mcp` repository. That repository targets a different legacy API. This project targets the current Rust API and publishes the `flow-codeblock-rust-mcp` npm package.

## Installation

Bun `1.4.0` or newer is required:

```bash
bunx --bun flow-codeblock-rust-mcp@0.1.7
```

The MCP client must inject these environment variables before startup:

```text
FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
FLOW_CODEBLOCK_TOKEN=<TOKEN_ISSUED_BY_YOUR_SERVICE_ADMIN>
```

`FLOW_CODEBLOCK_BASE_URL` defaults to `http://127.0.0.1:3003`. Use an HTTPS origin in production and store the token through the client's secret management. Never commit a real token to the repository, screenshots, shell history, or public configuration.

## Stdio configuration

Clients that support local stdio MCP servers can use:

```json
{
  "mcpServers": {
    "flow-codeblock-rust": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.7"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

The base URL is the Rust REST API origin, not a remote MCP URL. This release provides local stdio only; it does not expose remote HTTP, SSE, or Streamable HTTP transports.

Execution errors preserve a concise `message` and verified user-code locations in `error.details.line`, `error.details.column`, and `error.details.lineContent` with one-based line and column numbers. Source location, matched text, and source line are not duplicated in security-policy messages. The details are omitted when the location cannot be verified; direct parse and execution-policy failures use `SyntaxError` and `SecurityError` respectively and return HTTP 422 with `retryable: false`.

## Codex Plugin

The plugin files are:

```text
plugins/flow-codeblock-rust/.codex-plugin/plugin.json
plugins/flow-codeblock-rust/.mcp.json
plugins/flow-codeblock-rust/skills/flow-codeblock-rust/SKILL.md
```

The Skill requires the workflow `read current version -> preview -> server validation -> explicit user confirmation -> apply`. Updates use `expected_version` for concurrency protection. Interface documentation supports RFC 6902 `interface_doc_patch`; patches are mutually exclusive with complete documents and are forbidden for creates. On a version conflict, expired preview, or validation failure, read again and create a new preview.

When generated code and the available safe input are sufficient for a meaningful runtime test, the client executes it immediately without waiting for user confirmation. If required input or credentials are missing, it reports that runtime verification was not performed instead of inventing them. Final delivery is mode-specific. `non_script` always returns the complete generated JavaScript, even after runtime verification, plus invocation instructions, request parameters and examples, execution logic, success/error examples, and a complete `execution_url`. `script` omits JavaScript and raw `interface_doc` by default and returns invocation instructions, request parameters and examples, execution logic, success/error examples, and the published `script_url`. Script code and `interface_doc` remain internal inputs to MCP preview, validation, and publication unless the user explicitly requests source or raw documentation.

## Tool boundaries

The code contract follows the current Rust+Bun module allowlist. `crypto-js` has been removed; use `node:crypto` for cryptography. Excel imports are limited to `read-excel-file/node`, `read-excel-file/universal`, `write-excel-file/node`, `write-excel-file/universal`, and `write-excel-file/utility`; these modules run in the server's shared heavy execution pool.

MCP provides script listing, current and historical version reads, documentation reads and validation, preview/confirmation saves for code and documentation, locking/unlocking, published-script execution, and unpublished-code tests. Management requests use `Authorization: Bearer <token>`. The MCP token is not forwarded when executing a published script.

MCP deliberately does not provide script deletion, emergency recovery unlock, token lookup or management, execution statistics, ownership transfer, or arbitrary HTTP proxy tools. User-supplied Authorization, accessToken, Cookie, CSRF, test-tool, MCP, `Forwarded`, `X-Real-IP`, and `X-Forwarded-*` headers are filtered. Requests use a 30-second timeout.

## Contract without the Skill

The MCP server sends complete tool selection, preview/confirmation, runtime, and documentation rules in the initialization `instructions`, so clients do not need to install the Skill. When creating or changing code, `interface_doc` must include `schema_version`, `title`, `summary`, `endpoint`, `request`, `responses`, and `logic_description`. `endpoint.methods` and `endpoint.description` describe the interface. `request.query` and `request.headers` are always present; use `[]` when empty. POST documents also require `body.content_type`, `body.schema`, and `body.example`. Every query/header parameter requires `name`, `type`, `description`, `example`, and `required`; every response requires `status`, `description`, `content_type`, `schema`, and `example`.

Script URLs are built from the caller-provided service origin and `/flow/codeblock/{{script_id}}`. `endpoint.path` is relative: omit it when creating and use `/flow/codeblock/<actual-script-id>` when updating. Never put real tokens, passwords, cookies, or Authorization values in code, documents, examples, or URLs.

Patches contain at most 256 `add/remove/replace/move/copy/test` operations and use JSON Pointer paths. Preview results show operation counts, paths, warnings, and version information; they do not echo the merged document.

## Repository layout

```text
mcp-server/                         # npm package flow-codeblock-rust-mcp
plugins/flow-codeblock-rust/        # Codex Plugin and Skill
docs/USER_INSTALLATION.md           # Client installation guide
```

## Local development

```bash
cd mcp-server
bun install --frozen-lockfile
bun run check
bun test
npm pack --dry-run
npm publish --dry-run --access public
```

MCP depends only on the server-side REST API. The Rust API contract, interface-documentation schema, module allowlist, and dangerous-pattern reference files live under `plugins/flow-codeblock-rust/skills/flow-codeblock-rust/references/` and should be reviewed whenever the server implementation changes.

## License

MIT; see [LICENSE](LICENSE).
