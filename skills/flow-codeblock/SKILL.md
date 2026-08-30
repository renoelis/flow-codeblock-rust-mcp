---
name: flow-codeblock
description: Use Flow Codeblock MCP tools to write non-script JavaScript or create, validate, publish, execute, inspect, and lock persistent scripts. Refuse unsupported ownership and deletion requests and direct the user to the existing web UI or REST API.
---

# Flow Codeblock

This Skill works with the bundled stdio MCP server. The server calls only the Flow Codeblock Rust API; user JavaScript always runs in the server-side Bun Supervisor.

## Boundaries

- The MCP server requires `FLOW_CODEBLOCK_BASE_URL` and `FLOW_CODEBLOCK_TOKEN`; optional `FLOW_CODEBLOCK_OWNER_NAME` provides a default for lock/unlock tools. Explicit tool arguments take precedence.
- Non-script execution uses `FLOW_CODEBLOCK_BASE_URL/flow/codeblock`. Script create, update, and execution use the returned `script_url` at `FLOW_CODEBLOCK_BASE_URL/flow/codeblock/{script_id}`. Do not ask for a domain or put platform tokens in inputs, code, or documents.
- MCP provides no script deletion, token-query, ownership-release, ownership-transfer, or arbitrary HTTP-proxy tool. Refuse unsupported requests and direct the user to the Flow Codeblock web UI or REST API.
- Execution uses the MCP Web worker lane and still applies authentication, quota, rate limiting, security checks, auditing, and statistics.
- Lock and unlock only through `flow_lock_script` and `flow_unlock_script`, passing the Rust API's `owner_name` and `lock_password` fields. Never expose lock passwords in code or logs.

## Tool routing

For any code-writing or interface implementation request, call `flow_write_code` first and select `non_script` or `script`.

- `non_script` generates JavaScript for immediate execution and does not create a persistent script. Use `flow_execute_code` only when the user explicitly requests a test or execution.
- `script` generates JavaScript and a complete `script-interface-doc.v1` document internally. Do not show either in the final response unless the user asks for them.
- Read the current script with `flow_get_script` and only `script_id`; the server uses `version=0`. Read a historical version only with an explicit version from the user or `available_versions`.
- Read current and historical interface documents with their matching documentation tools. Do not guess versions.

## Script change flow

1. Create: generate code and a complete interface document.
2. Update: read current code and documentation first, use the returned `current_version` as `expected_version`, and submit only the fields the user asked to change. Use `interface_doc_patch` for field-only documentation changes.
3. Call `flow_preview_script_change` once after a complete recursive self-check. `interface_doc` and `interface_doc_patch` are mutually exclusive. A successful `preview_id` means normalizations are already stored and `requires_repreview=false`; do not rewrite or preview again.
4. Show the successful preview and wait for explicit confirmation. Only then call `flow_apply_script_change` with the same `preview_id` and `confirm=true`.
5. After a successful create, call `flow_execute_script` only when execution was requested. Pass POST business JSON directly as `body`; do not wrap it as `input` or `input.body`.

The authoritative code-generation rules are in [AGENT_PROMPT.md](references/AGENT_PROMPT.md). `flow_write_code` also returns the complete [dangerous_patterns.json](references/dangerous_patterns.json) content so generated code can avoid every forbidden identifier and member. The complete document contract is in [script-interface-doc.schema.json](references/script-interface-doc.schema.json), and the incremental contract is in [script-interface-doc.patch.schema.json](references/script-interface-doc.patch.schema.json). The MCP validator performs the same recursive checks before calling the remote API, so correct all reported paths in one pass.

## Delivery

- `non_script`: after every initial generation, fix, or later update, return the complete latest JavaScript source produced in the current turn, caller-facing invocation instructions, parameters/examples, logic, success/error examples, and the complete `execution_url`; never return only a patch, changed fragment, explanation, or execution result.
- `script`: return caller-facing invocation instructions, parameters/examples, logic, success/error examples, and the published `script_url`; omit internal code and raw interface JSON unless requested.

## References

- REST fields and errors: [api.md](references/api.md)
- Allowed npm modules: [modules.json](references/modules.json)
- Security checks: [dangerous_patterns.json](references/dangerous_patterns.json)
