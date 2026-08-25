# Flow Codeblock Rust MCP

这是 Flow Codeblock Rust+Bun 服务的独立 MCP 与 Codex Plugin 仓库。MCP Server 通过本地 `stdio` 接收 MCP 请求，再调用 Flow Codeblock Rust REST API；用户 JavaScript 始终由服务端 Bun 执行器运行。

本仓库与已有的 `flow-codeblock-mcp` 分开维护。已有仓库面向另一套旧 API，本仓库对应当前 Rust API，npm 包名为 `flow-codeblock-rust-mcp`。

## 安装

需要 Bun `1.4.0` 或更高版本：

```bash
bunx --bun flow-codeblock-rust-mcp@0.1.3
```

启动前由 MCP 客户端注入以下环境变量：

```text
FLOW_CODEBLOCK_BASE_URL=http://127.0.0.1:3003
FLOW_CODEBLOCK_TOKEN=<由服务管理员签发的访问令牌>
```

`FLOW_CODEBLOCK_BASE_URL` 默认是 `http://127.0.0.1:3003`。生产环境请使用 HTTPS 地址，并通过客户端密钥管理保存 Token，不要把真实 Token 写入仓库、截图、命令行历史或公开配置。

## stdio 配置

支持本地 stdio MCP 的客户端可以使用：

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

地址是 Rust REST API 地址，不是远程 MCP 地址。本版本只承诺本地 stdio，不提供远程 HTTP、SSE 或 Streamable HTTP 入口。

## Codex Plugin

插件目录为：

```text
plugins/flow-codeblock-rust/.codex-plugin/plugin.json
plugins/flow-codeblock-rust/.mcp.json
plugins/flow-codeblock-rust/skills/flow-codeblock-rust/SKILL.md
```

Skill 要求脚本写入遵循“读取当前版本 -> 预览 -> 服务端校验 -> 用户明确确认 -> 应用”的流程。更新时会使用 `expected_version` 保护并发修改；接口文档支持 RFC 6902 `interface_doc_patch` 增量提交，补丁与完整文档互斥，创建脚本禁止补丁。版本冲突、预览过期或校验失败时必须重新读取并预览。

最终用户交付按模式区分：`non_script` 输出完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和完整 `execution_url`；`script` 默认不主动回显 JavaScript 或原始 `interface_doc`，只输出接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的完整 `script_url`。脚本代码与 `interface_doc` 仍由 MCP 内部用于预览、校验和发布，除非用户明确索要源码或原始文档。

## 工具边界

代码契约使用当前 Rust+Bun 模块白名单：`crypto-js` 已移除，加密应使用 `node:crypto`。Excel 仅允许 `read-excel-file/node`、`read-excel-file/universal`、`write-excel-file/node`、`write-excel-file/universal` 和 `write-excel-file/utility` 入口；这些模块由服务端共享重型执行池承载。

MCP 提供脚本列表、当前/历史版本读取、接口文档读取与校验、代码和文档的预览/确认保存、锁定/解锁、已发布脚本执行，以及未发布代码测试。管理请求使用 `Authorization: Bearer <token>`；执行已发布脚本时不会把 MCP Token 转发给用户脚本。

MCP 明确不提供脚本删除、紧急恢复解锁、Token 查询或管理、执行统计、所有权转移和任意 HTTP 代理工具。用户传入的 Authorization、accessToken、Cookie、CSRF、测试工具标识、MCP 标识以及 `Forwarded`/`X-Real-IP`/`X-Forwarded-*` 等代理来源头会被过滤，请求统一使用 30 秒超时。

## 仅使用 MCP 时的工具契约

MCP Server 会在初始化响应中通过 `instructions` 提供完整的工具选择和调用流程，不要求客户端额外安装 Skill。创建或修改代码时，接口文档必须包含 `schema_version`、`title`、`summary`、`endpoint`、`request`、`responses`、`logic_description`；接口方式和接口说明位于 `endpoint.methods`、`endpoint.description`。`request.query`、`request.headers` 始终存在，没有参数使用 `[]`；POST 还必须填写 body 的 `content_type`、`schema`、`example`。每个查询参数、请求头必须填写 `name`、`type`、`description`、`example`（以及 `required`），每个响应必须填写 `status`、`description`、`content_type`、`schema`、`example`。

脚本调用地址由用户提供的服务域名拼接 `/flow/codeblock/{{脚本ID}}`。接口文档的 `endpoint.path` 只保留相对路径：创建时省略，更新时填写 `/flow/codeblock/<实际脚本ID>`；不要将真实 Token、密码、Cookie 或 Authorization 写入代码、文档、示例或 URL。

补丁最多包含 256 个 `add/remove/replace/move/copy/test` 操作，路径使用 JSON Pointer；预览结果只展示操作数量、路径、警告和版本，不回显合并后的完整文档。

## 目录结构

```text
mcp-server/                         # npm 包 flow-codeblock-rust-mcp
plugins/flow-codeblock-rust/        # Codex Plugin 与 Skill
docs/USER_INSTALLATION.md           # 客户端安装说明
```

## 本地开发

```bash
cd mcp-server
bun install
bun run check
bun test
npm pack --dry-run
npm publish --dry-run --access public
```

MCP 只依赖服务端 REST API。Rust API 契约、接口文档 Schema、模块白名单和危险模式参考文件保存在 `plugins/flow-codeblock-rust/skills/flow-codeblock-rust/references/`，服务端实现变更时需要同步评估。

## 许可证

MIT，见 [LICENSE](LICENSE)。
