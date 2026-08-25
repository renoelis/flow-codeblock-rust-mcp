# flow-codeblock-rust-mcp

Flow Codeblock Rust+Bun 的本地 stdio MCP Server。它只调用服务端 Rust REST API，不在用户电脑执行脚本；用户 JavaScript 仍由服务端 Bun 执行器运行。

## 安装和启动

需要 Bun 1.4.0 或更高版本：

```bash
bunx --bun flow-codeblock-rust-mcp@0.1.2
```

配置环境变量：

```bash
export FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
export FLOW_CODEBLOCK_TOKEN='<YOUR_INTERNAL_ACCESS_TOKEN>'
```

`FLOW_CODEBLOCK_TOKEN` 是当前 Flow Codeblock 服务的内部访问令牌。生产部署应使用 HTTPS 地址，不要将真实 Token 写入仓库、npm 包、命令行历史或公开客户端配置。

## stdio 配置

```json
{
  "mcpServers": {
    "flow-codeblock-rust": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.2"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_INTERNAL_ACCESS_TOKEN>"
      }
    }
  }
}
```

## 工具边界

工具覆盖代码生成、未发布代码测试、脚本列表、版本读取、接口文档校验/预览/保存、脚本创建/更新、锁定/解锁和已发布脚本执行。创建或代码更新可提交完整接口文档或 RFC 6902 `interface_doc_patch`；预览会调用 `/flow/scripts/validate`，应用时会再次透传补丁并使用事务级 `expected_version` 检测并发冲突。所有脚本写操作需要预览后显式 `confirm: true`。

最终用户交付按模式区分：`non_script` 输出完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和完整 `execution_url`；`script` 默认不主动回显 JavaScript 或原始 `interface_doc`，只输出接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的完整 `script_url`。脚本代码与 `interface_doc` 仍由 MCP 内部用于预览、校验和发布，除非用户明确索要源码或原始文档。

MCP 不提供脚本删除、紧急恢复解锁、Token 查询、执行统计、所有权转移或任意 HTTP 代理工具。当前版本只提供本地 stdio 连接，不提供远程 HTTP、SSE 或 Streamable HTTP 连接。

## MCP 工具契约

服务器初始化时会通过 MCP `instructions` 下发完整的工具选择、脚本预览/确认流程、代码运行时约束和接口文档规则，因此不依赖额外 Skill 也可以直接调用工具。客户端应优先使用工具 description 和 input schema 中的字段说明，不要通过试错猜测参数。

接口文档必须包含 `schema_version`、`title`、`summary`、`endpoint`、`request`、`responses`、`logic_description`；`endpoint` 必须有 `methods` 和 `description`，`request.query` 与 `request.headers` 必须存在（没有参数时传 `[]`）。POST 还必须提供 `request.body`，其 `content_type`、`schema`、`example` 均必填；每个响应的 `status`、`description`、`content_type`、`schema`、`example` 均必填；查询参数和请求头的每个字段必须有 `name`、`type`、`required`、`description`、`example`。

接口文档的 `endpoint.path` 使用相对路径：创建时省略，更新时使用 `/flow/codeblock/<实际脚本ID>`。对外展示完整请求地址时，将用户提供的服务域名与 `/flow/codeblock/{{脚本ID}}` 拼接；不要把真实令牌、密码、Cookie 或 Authorization 值写入代码、文档、示例或 URL。

`interface_doc_patch` / `document_patch` 必须携带正整数 `expected_version`，最多 256 个 `add/remove/replace/move/copy/test` 操作。补丁预览仅返回操作数量、JSON Pointer 路径、警告和版本信息，不返回完整合并文档。

## 安全行为

- 管理请求使用 `Authorization: Bearer`，执行已发布脚本时不会把 MCP Token 转发到脚本输入。
- 用户传入的 Authorization、accessToken、Cookie、CSRF、测试工具标识和 `Forwarded`/`X-Real-IP`/`X-Forwarded-*` 等代理来源头会被过滤。
- 请求有 30 秒超时，预览有 10 分钟 TTL 和 256 条上限。
