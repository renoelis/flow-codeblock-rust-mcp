# flow-codeblock-rust-mcp

Local stdio MCP server and Codex Skill for Flow Codeblock. The MCP server calls the Flow Codeblock Rust REST API; it never executes user JavaScript on the user's computer. User code runs in the server's pinned Bun Supervisor.

## Installation

Requires Bun 1.4.0 or newer:

```bash
bunx --bun flow-codeblock-rust-mcp@2.0.2
```

Required environment:

```bash
FLOW_CODEBLOCK_BASE_URL=https://qingcode.oalite.com
FLOW_CODEBLOCK_TOKEN=flow_xxx
# Optional default owner name for lock/unlock operations
FLOW_CODEBLOCK_OWNER_NAME=Default Owner
```

`FLOW_CODEBLOCK_BASE_URL` is the deployed Flow Codeblock Rust API base URL and the base for returned call URLs. Non-script tools return `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock` as `execution_url`; script create, update, and execution tools return `${FLOW_CODEBLOCK_BASE_URL}/flow/codeblock/{script_id}` as `script_url`. Other management tools do not return a call URL. Use `https://qingcode.oalite.com` for the public service, or the matching localhost URL for a local Rust deployment. Store the token in the client's environment or secret manager; never put it in prompts, tool arguments, or public files.

When `FLOW_CODEBLOCK_OWNER_NAME` is configured, `owner_name` may be omitted from `flow_lock_script` and `flow_unlock_script`; explicit arguments win. Both tools call the Rust API directly with `owner_name` and `lock_password`. The current API has no ownership challenge, release, or transfer routes.

## Generic stdio configuration

```json
{
  "mcpServers": {
    "flow-codeblock": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@2.0.2"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://qingcode.oalite.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>",
        "FLOW_CODEBLOCK_OWNER_NAME": "Default Owner"
      }
    }
  }
}
```

The npm package includes the MCP runtime, the `flow-codeblock` Skill, `AGENT_PROMPT.md`, module and dangerous-pattern rules, and interface-document Schemas. Ordinary MCP clients do not install the Codex Skill automatically; `flow_write_code` reads the authoritative authoring and dangerous-pattern rules from the package at runtime and returns both.

## Calling rules

- Call `flow_write_code` before writing code. Non-script code reads `input.<field>`; script code reads `input.query/header/body/cookies` internally.
- After every non-script generation, fix, or update, return the complete latest JavaScript source; never return only a patch, fragment, explanation, or execution result.
- Script changes require `flow_preview_script_change`, display of the successful preview, explicit user confirmation, and then `flow_apply_script_change`. Code-only updates may omit `interface_doc` and `interface_doc_patch`, preserving the current interface document. A successful preview already contains all normalizations and does not need a second preview.
- Use `flow_get_script` with only `script_id` for the current version. Use history tools only for an explicitly requested version. The MCP server decodes valid `code_base64` to UTF-8 `code`.
- POST script execution receives the caller's business JSON directly as `body`; do not wrap it in `input` or `input.body`.
- Third-party API keys are business inputs supplied through the documented body, query, or business headers. User code must not read `process.env`; `FLOW_CODEBLOCK_TOKEN` is platform authentication only.
- All JSON outputs recursively redact credential fields such as `token`, `access_token`, `authorization`, `refresh_token`, and `qingcodeToken`. Statistics such as `token_cache` and `unique_tokens` are not credentials.
- Lock and unlock scripts directly with `owner_name` and `lock_password`. MCP does not expose ownership challenge, release, transfer, or script deletion tools; use the Flow Codeblock web UI or REST API for unsupported operations.
- Execution performs normal authentication, rate limiting, quota accounting, security validation, auditing, and statistics.

## License

MIT
