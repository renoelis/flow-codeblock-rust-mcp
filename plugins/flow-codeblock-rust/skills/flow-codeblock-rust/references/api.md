# API 说明

服务默认监听 `http://127.0.0.1:3003`。除健康检查、测试工具静态资源和按 ID 执行已发布脚本外，接口均要求内部访问令牌：

```http
Authorization: Bearer <INTERNAL_ACCESS_TOKEN>
```

也兼容 `accessToken: <INTERNAL_ACCESS_TOKEN>`。浏览器从有 Origin 的页面调用写接口时，还需要由 `/flow/test-tool/csrf` 取得的 `X-CSRF-Token`；内置测试工具会自动处理该令牌。

## 响应约定

成功响应包含 `success: true`、业务字段、`timestamp` 和 UUID v4 格式的 `request_id`。执行接口还包含：

```json
{
  "success": true,
  "result": {"value": 42},
  "timing": {"executionTime": 3.247, "totalTime": 8.912},
  "timestamp": "2026-07-26 12:00:00",
  "request_id": "00000000-0000-4000-8000-000000000000"
}
```

`executionTime` 是用户 JavaScript 代码生命周期的耗时，单位为毫秒，最多保留三位小数；它包含用户代码触发的异步等待，不包含执行队列等待、运行环境初始化和结果序列化。`totalTime` 是服务端从收到请求到构造最终响应体的预估总耗时，包含请求体读取、校验、排队、执行和响应处理，但不包含客户端与服务端之间的网络往返。浏览器 Network、Postman 或 curl 显示的 Response Time 由客户端自行测量，通常会大于该字段。错误响应包含 `error.type` 与 `error.message`。

## 健康与监控

| 方法 | 路径 | 认证 | 说明 |
| --- | --- | --- | --- |
| GET | `/` | 否 | 服务标识与请求 ID |
| GET | `/flow/health` | 否 | 进程存活检查 |
| GET | `/flow/health/ready` | 否 | MySQL 与执行器就绪检查 |
| GET | `/flow/metrics` | 是 | 依赖与执行池状态 |

## 直接执行

`POST /flow/codeblock` 需要认证。请求体中的 `codebase64` 是 UTF-8 JavaScript 的 Base64 编码；代码必须包含 `return` 或合法的 `qf_output` 赋值。

```json
{
  "codebase64": "cmV0dXJuIHsgdmFsdWU6IGlucHV0Lm51bWJlciAqIDIgfTs=",
  "input": {"number": 21},
  "qingcodeTimeout": 15000
}
```

超时时间可省略，且必须位于 `MIN_EXECUTION_TIMEOUT_MS` 与 `MAX_EXECUTION_TIMEOUT_MS` 之间。`xlsx` 脚本会自动路由到专用池。

## 脚本管理

除紧急恢复解锁接口外，以下接口均需要内部访问令牌认证。浏览器环境调用写接口时仍须通过 CSRF 校验。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/flow/scripts` | 创建脚本 |
| POST | `/flow/scripts/validate` | 只读校验代码、IP 白名单和完整文档或 RFC 6902 补丁 |
| GET | `/flow/scripts` | 分页查询脚本 |
| GET | `/flow/scripts/{script_id}` | 查询当前脚本或指定版本 |
| PUT | `/flow/scripts/{script_id}` | 更新脚本、描述、IP 白名单、完整文档、RFC 6902 补丁或回滚版本 |
| GET | `/flow/scripts/{script_id}/documentation` | 查询当前或指定版本的接口文档 |
| POST | `/flow/scripts/{script_id}/documentation` | 校验并规范化 JSON 接口文档，不写入数据库 |
| PUT | `/flow/scripts/{script_id}/documentation` | 保存接口文档并创建新的文档版本 |
| DELETE | `/flow/scripts/{script_id}` | 删除脚本及全部历史版本 |
| POST | `/flow/scripts/{script_id}/lock` | 使用所有者名称和锁定口令锁定脚本 |
| POST | `/flow/scripts/{script_id}/unlock` | 使用所有者名称和锁定口令正常解锁脚本 |
| POST | `/flow/scripts/{script_id}/unlock/recovery` | 仅运维使用的紧急恢复解锁；仅在配置恢复令牌时注册 |

创建请求：

```json
{
  "code_base64": "cmV0dXJuIGlucHV0Ow==",
  "description": "示例脚本",
  "ip_whitelist": ["10.10.0.0/16"]
}
```

更新请求可选择性传入 `expected_version`、`code_base64`、`description`、`ip_whitelist`、`interface_doc`、`interface_doc_patch` 或 `rollback_to_version`。`interface_doc` 与 `interface_doc_patch` 互斥；补丁仅允许已有脚本，必须携带正整数 `expected_version`。服务端先 canonical 化当前文档，再按顺序应用最多 256 个 RFC 6902 操作并完整校验，版本冲突返回 HTTP 409 `VersionConflictError`。创建脚本禁止补丁；`code_base64` 与 `rollback_to_version` 不能同时出现。

接口文档使用 `script-interface-doc.v1` 规范。请求方式仅支持脚本运行时的 `GET`、`POST`；`endpoint.path` 创建时可省略，更新时使用 `/flow/codeblock/<实际脚本ID>`。对外完整地址由用户提供的域名拼接 `/flow/codeblock/{{脚本ID}}`。请求体和响应体中的 `schema` 使用 JSON Schema；同一响应状态码可以按不同业务结果记录多项说明。文档可以通过 `document`、`raw_document` 或已有文档上的 `document_patch` 提交；补丁路径使用 JSON Pointer，预览结果只返回操作数量、路径、警告和版本信息，不回显完整合并文档。仅修改脚本描述或 IP 白名单不会递增脚本版本号；canonical 文档或代码变更才会创建新版本。

最终用户交付按模式区分：非脚本模式展示完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和完整 `execution_url`；脚本模式默认不展示 JavaScript 或原始 `interface_doc`，只展示接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的完整 `script_url`，除非用户明确索要源码或原始文档。

示例：

```json
{
  "document": {
    "schema_version": "script-interface-doc.v1",
    "title": "客户信息查询",
    "summary": "按客户编号查询客户信息。",
    "endpoint": {
      "methods": ["GET"],
      "description": "通过客户编号查询客户信息的只读接口。"
    },
    "request": {
      "query": [{
        "name": "customer_id",
        "type": "string",
        "required": true,
        "description": "客户编号",
        "example": "C10001"
      }],
      "headers": []
    },
    "responses": [{
      "status": 200,
      "description": "查询成功",
      "content_type": "application/json",
      "schema": {
        "type": "object",
        "properties": {"success": {"type": "boolean"}},
        "required": ["success"],
        "additionalProperties": false
      },
      "example": {"success": true}
    }],
    "logic_description": "校验客户编号后查询客户信息；查询失败时返回对应错误响应。"
  }
}
```

列表查询默认使用偏移分页，例如：

```text
GET /flow/scripts?page=1&size=20&keyword=invoice&sort=updated_at&order=desc
```

游标分页使用 `pagination=cursor`，首次不传 `cursor`，后续使用上一响应返回的游标：

```text
GET /flow/scripts?pagination=cursor&size=20&sort=updated_at&order=desc&cursor=<cursor>
```

游标分页仅支持 `updated_at`、`created_at` 和 `code_length` 排序；最大 `size` 为 100。

### 紧急恢复解锁

`POST /flow/scripts/{script_id}/unlock/recovery` 用于锁定口令遗失时的运维恢复。服务仅在环境变量 `SCRIPT_LOCK_RECOVERY_TOKEN` 已配置且非空时注册此路由；未配置时该路径返回 `404`。恢复成功会清除锁定状态、锁定时间、所有者名称和口令哈希，并刷新脚本缓存。

该接口**不使用** `Authorization`、`accessToken` 或 CSRF 令牌，而是要求请求头精确携带恢复令牌。令牌的原始值须为 32-4096 字节的 RFC 6750 Bearer Token 格式字符串；请求头中不要添加 `Bearer ` 前缀。接口拒绝浏览器上下文请求，不应从测试工具、前端页面或任何浏览器代码调用，也不得将恢复令牌下发给客户端。

请求体为空。示例（仅在受控运维终端执行，勿将令牌写入脚本、命令历史或日志）：

```bash
curl --request POST "${FLOW_BASE_URL}/flow/scripts/${SCRIPT_ID}/unlock/recovery" \
  --header "X-Script-Lock-Recovery-Token: ${SCRIPT_LOCK_RECOVERY_TOKEN}"
```

成功时返回 `200`，响应中的 `lock` 字段为：

```json
{
  "is_locked": false,
  "locked_at": null,
  "lock_owner_name_hint": null
}
```

常见失败状态：`401` 表示恢复令牌缺失或不匹配；`403` 表示请求带有 `Origin`、`X-CSRF-Token` 或 `Sec-Fetch-*` 等浏览器上下文请求头；`400` 表示脚本 ID 无效；`404` 表示恢复接口未启用或脚本不存在；`503` 表示脚本存储服务不可用。

## 按脚本 ID 执行

`GET|POST /flow/codeblock/{script_id}` 面向企业内网调用方，不要求访问令牌。服务仍会校验脚本状态、来源 IP 白名单、代码安全规则和执行超时。不要把该接口暴露到不受控网络，也不要在脚本中处理不可审计的外部副作用。

POST 请求体、查询参数、请求头和 Cookie 会按既有输入契约映射为脚本的 `input`。脚本返回对象中可设置 `flow_redirect_url` 与可选的 `flow_redirect_code`（301、302、303、307、308）来触发安全的 HTTP(S) 重定向。

## 内置测试工具

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/flow/test-tool` | 测试工具页面 |
| GET | `/flow/test-tool/csrf` | 获取浏览器 CSRF 令牌 |
| GET | `/flow/assets/{asset_path}` | 测试工具静态资源 |
