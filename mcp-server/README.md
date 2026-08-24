# flow-codeblock-rust-mcp

Flow Codeblock Rust+Bun 的本地 stdio MCP Server。它只调用服务端 Rust REST API，不在用户电脑执行脚本；用户 JavaScript 仍由服务端 Bun 执行器运行。

## 安装和启动

需要 Bun 1.4.0 或更高版本：

```bash
bunx --bun flow-codeblock-rust-mcp@0.1.0
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
      "args": ["--bun", "flow-codeblock-rust-mcp@0.1.0"],
      "env": {
        "FLOW_CODEBLOCK_BASE_URL": "https://flow.example.com",
        "FLOW_CODEBLOCK_TOKEN": "<YOUR_INTERNAL_ACCESS_TOKEN>"
      }
    }
  }
}
```

## 工具边界

工具覆盖代码生成、未发布代码测试、脚本列表、版本读取、接口文档校验/预览/保存、脚本创建/更新、锁定/解锁和已发布脚本执行。创建或代码更新要求完整接口文档；预览会调用 `/flow/scripts/validate`，应用时使用事务级 `expected_version` 检测并发冲突。所有脚本写操作需要预览后显式 `confirm: true`。

MCP 不提供脚本删除、紧急恢复解锁、Token 查询、执行统计、所有权转移或任意 HTTP 代理工具。当前版本只提供本地 stdio 连接，不提供远程 HTTP、SSE 或 Streamable HTTP 连接。

## 安全行为

- 管理请求使用 `Authorization: Bearer`，执行已发布脚本时不会把 MCP Token 转发到脚本输入。
- 用户传入的 Authorization、accessToken、Cookie、CSRF、测试工具标识和 `Forwarded`/`X-Real-IP`/`X-Forwarded-*` 等代理来源头会被过滤。
- 请求有 30 秒超时，预览有 10 分钟 TTL 和 256 条上限。
