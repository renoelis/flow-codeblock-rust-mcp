---
name: flow-codeblock-rust
description: 使用 Flow Codeblock Rust+Bun MCP 工具查询、校验、发布和执行脚本；涉及删除脚本或紧急恢复解锁时必须拒绝并引导用户使用受控 REST/运维流程。
---

# Flow Codeblock Rust+Bun

此 Skill 配合插件的本地 stdio MCP Server 使用。MCP Server 只调用当前项目的 Rust HTTP API；用户 JavaScript 仍由服务端固定版本的 Bun 执行器运行。

## 认证和边界

- MCP Server 从进程环境读取 `FLOW_CODEBLOCK_BASE_URL`，默认 `http://127.0.0.1:3003`。
- 管理请求使用 `FLOW_CODEBLOCK_TOKEN` 作为 `Authorization: Bearer`，工具不要求把 Token 放入业务参数。
- 执行已发布脚本时，MCP Token、Authorization、Cookie、CSRF 和测试工具标识不会进入脚本输入。
- MCP 不提供删除脚本、紧急恢复解锁、Token 管理、统计、所有权转移或任意 HTTP 代理工具。
- 第一版只提供本地 stdio MCP Server，不承诺远程 HTTP、SSE 或 Streamable HTTP。

## 工具选择

- `flow_list_scripts`：分页列出脚本，支持当前 API 的页码或游标分页。
- `flow_get_script`：读取当前或指定历史版本的代码和元数据。
- `flow_get_script_documentation`：读取当前或历史接口文档。
- `flow_validate_script_documentation`：校验并规范化文档，不写入数据库。
- `flow_write_code`：按当前 Bun 运行时、模块白名单和接口文档完整性规则生成非脚本或脚本代码契约，不写库、不执行。
- `flow_preview_script_change`：预览并调用服务端统一校验接口；创建或代码更新必须同时提交完整接口文档。
- `flow_apply_script_change`：仅应用已预览内容，必须传 `confirm: true`。
- `flow_preview_script_documentation` / `flow_apply_script_documentation`：预览、确认并保存接口文档。
- `flow_lock_script` / `flow_unlock_script`：使用所有者名称和锁定口令，必须传 `confirm: true`。
- `flow_execute_script`：执行已发布脚本，支持 GET/POST、query、headers、body 和 timeout_ms。
- `flow_execute_code`：执行未发布的非脚本代码，明确要求测试时才使用。

## 脚本变更流程

1. 更新前先调用 `flow_get_script`，记录当前 `version`，并将其作为 `expected_version` 传给预览。
2. 调用 `flow_preview_script_change`。创建必须提交代码和完整 `interface_doc`；更新代码时也必须提交完整文档，纯描述/IP 白名单变更可以省略文档，回滚不能与代码或文档同时提交。
3. 只有用户明确确认后，才调用对应的 `flow_apply_*` 工具并传 `confirm: true`。
4. 应用工具会再次读取当前版本，并把 `expected_version` 交给 Rust API 的事务级版本校验。版本变化、预览过期或预览内容校验失败时停止并要求重新读取、预览。

`POST /flow/scripts/validate` 是只读统一校验接口。MCP 预览会先调用它检查代码、IP 白名单和接口文档；最终写入仍会再次校验，并在事务内处理 `expected_version` 冲突（HTTP 409）。

## 接口文档规则

接口文档必须符合 `script-interface-doc.v1`，方法只能是 GET 或 POST，路径由服务端按脚本 ID 规范化。文档应独立作为 JSON 对象提交，不要把接口契约写进 JavaScript 注释，也不要写入真实 Token、密码、Cookie、Authorization 或其他敏感凭据。

生成或修改脚本时先阅读：

- [API 约定](references/api.md)
- [接口文档 Schema](references/script-interface-doc.schema.json)
- [危险模式](references/dangerous_patterns.json)
- [允许模块](references/modules.json)

## 代码生成规则

用户代码必须使用 `input` 接收输入并通过顶层 `return` 或合法的 `qf_output` 返回结果；只使用允许模块，遵守代码、输入、结果和超时限制。向用户展示生成结果时，把可执行 JavaScript 和可提交的 `interface_doc` JSON 分成两个独立代码块。
