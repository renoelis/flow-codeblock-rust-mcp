# 项目协作约束

1. 回复使用简体中文。
2. 本项目运行时为 Bun 1.4.0，依赖版本必须保持锁定。
3. 修改 MCP 工具、Skill、权威规则或 npm 包内容时，默认递增 `package.json`、`mcp-server/package.json` 和 MCP Server 自报版本，并同步 README 示例。
4. 发布前必须运行 `bun run prepack`，确认 MCP 元数据和工具契约测试全部通过。
5. 不得提交 Token、验证码、Cookie、Authorization 或其他敏感凭据。
6. 完成修改后，默认检查 `git diff --check` 与 `git status --short`，运行下方完整验证命令，并核对 `npm pack --dry-run --json` 输出的包版本、入口和文件清单；确认运行文件完整且不包含测试文件、临时文件或敏感凭据后，自动创建只包含本次任务改动的 Git 提交。
7. 默认发布，将已验证的提交推送到 `origin/main` 以触发 `.github/workflows/publish.yml`，等待工作流结束，并通过 `npm view <包名>@<版本> version` 确认 npm 版本可用；不得将仅推送成功视为发布成功。

## 验证

```bash
bun install --cwd mcp-server --frozen-lockfile
bun run prepack
npm pack --dry-run --json
```
