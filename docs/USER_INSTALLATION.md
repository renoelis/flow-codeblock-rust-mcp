# Flow Codeblock Rust MCP 安装说明

本文说明如何在支持本地 stdio MCP 的客户端中使用 `flow-codeblock-rust-mcp`。

## 1. 准备环境

安装 Bun `1.4.0` 或更高版本，并确认：

```bash
bun --version
```

从 Flow Codeblock 管理员获取当前用户专用的 `FLOW_CODEBLOCK_TOKEN`。Token 只用于 MCP 到 Rust API 的管理请求，不能写入用户脚本或接口文档。

## 2. 通用配置

```json
{
  "mcpServers": {
    "flow-codeblock-rust": {
      "command": "bunx",
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.3"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_FLOW_CODEBLOCK_TOKEN>"
      }
    }
  }
}
```

`FLOW_CODEBLOCK_BASE_URL` 是 Rust REST API 地址，默认值为 `http://127.0.0.1:3003`。不要把它误配置为远程 MCP 地址。公网部署必须使用 HTTPS，否则 Bearer Token 会以明文传输。

也可以在终端做启动检查：

```bash
export FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
export FLOW_CODEBLOCK_TOKEN='<YOUR_FLOW_CODEBLOCK_TOKEN>'
bunx --bun flow-codeblock-rust-mcp@0.1.3
```

进程启动后会等待客户端通过 stdio 通信，这是正常行为。

## 3. 使用边界

支持：

- 脚本列表、当前或历史版本读取；
- 接口文档读取、只读校验、预览和确认保存；
- 脚本创建、代码/描述/IP 白名单更新和版本回滚；
- 脚本锁定、正常解锁；
- 已发布脚本执行和未发布代码测试。

不支持：

- 删除脚本；
- 紧急恢复解锁；
- Token 查询、Token 管理、执行统计或所有权转移；
- 任意 HTTP 代理；
- 远程 HTTP、SSE 或 Streamable HTTP MCP。

## 4. 脚本写入流程

MCP 工具遵循以下顺序，不依赖额外 Skill：

1. 先读取脚本当前版本和接口文档；
2. 预览代码或文档变更，预览阶段调用服务端只读校验；
3. 向用户展示变更摘要，等待用户明确确认；
4. 应用时传入 `confirm: true`，服务端在事务内检查 `expected_version`。

如果版本发生变化、预览超过 10 分钟或预览内容校验失败，应用会被拒绝，需要重新读取和预览。预览内存最多保留 256 条，访问时清理过期记录，应用成功或失败都会释放记录。

生成或修改脚本时，`interface_doc` 必须包含 `schema_version`、`title`、`summary`、`endpoint`、`request`、`responses`、`logic_description`；`endpoint.methods`、`endpoint.description`、`request.query`、`request.headers` 必填，没有参数使用 `[]`。POST 还必须填写 body 的 `content_type`、`schema`、`example`；每个查询参数、请求头必须填写 `name`、`type`、`required`、`description`、`example`；每个响应必须填写 `status`、`description`、`content_type`、`schema`、`example`。完整脚本调用地址使用用户提供的域名 + `/flow/codeblock/{{脚本ID}}`，不要把凭据写入 URL 或示例。

最终交付按模式区分：非脚本模式展示完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和 `execution_url`；脚本模式默认不展示 JavaScript 或原始 `interface_doc`，只展示接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的 `script_url`，用户明确索要源码或原始文档时除外。

## 5. 安全说明

- 管理请求使用 `Authorization: Bearer`；已发布脚本执行不会转发该认证头。
- 用户提供的 Authorization、accessToken、Cookie、CSRF、测试工具标识和 MCP 标识会被过滤。
- 所有 API 请求采用 30 秒超时，错误只保留 HTTP 状态和服务端错误体的脱敏信息。
- Token 应由客户端密钥管理注入，不要提交到 Git、npm 包或公开配置。
