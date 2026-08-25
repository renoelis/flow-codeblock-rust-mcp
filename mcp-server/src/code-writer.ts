import {
  interfaceDocNestedRules,
  interfaceDocPatchJsonSchema,
  interfaceDocRequiredFields,
} from "./interface-doc.js";

const allowedModules = [
  "axios",
  "cheerio",
  "csv-parser",
  "fast-xml-parser",
  "form-data",
  "lodash",
  "pinyin-pro",
  "qs",
  "read-excel-file",
  "sm-crypto-v2",
  "uuid",
  "write-excel-file",
  "xlsx",
  "dayjs",
];

export const interfaceDocSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "script-interface-doc.v1" },
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    endpoint: {
      type: "object",
      required: ["methods", "description"],
      additionalProperties: false,
      properties: {
        methods: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["GET", "POST"] } },
        path: {
          type: "string",
          pattern: "^/flow/codeblock/",
          description: "相对路径；创建时可省略，更新时必须为 /flow/codeblock/<实际脚本ID>。完整地址另行拼接调用方提供的域名。",
        },
        description: { type: "string", minLength: 1, maxLength: 4000 },
      },
    },
    request: {
      type: "object",
      required: ["query", "headers"],
      additionalProperties: false,
      properties: {
        query: { $ref: "#/$defs/parameters" },
        headers: { $ref: "#/$defs/parameters" },
        body: { $ref: "#/$defs/body" },
      },
    },
    responses: { type: "array", minItems: 1, maxItems: 50, items: { $ref: "#/$defs/response" } },
    logic_description: { type: "string", minLength: 20, maxLength: 20_000 },
    usage_refs: { type: "array", maxItems: 100 },
  },
  $defs: {
    parameters: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: ["name", "type", "required", "description", "example"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          type: { enum: ["string", "integer", "number", "boolean", "array", "object"] },
          required: { type: "boolean" },
          description: { type: "string", minLength: 1, maxLength: 4000 },
          example: {},
          default: {},
          format: { type: "string", maxLength: 100 },
          enum_values: { type: "array", maxItems: 100 },
        },
      },
    },
    body: {
      type: "object",
      required: ["content_type", "schema", "example"],
      additionalProperties: false,
      properties: {
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
    response: {
      type: "object",
      required: ["status", "description", "content_type", "schema", "example"],
      additionalProperties: false,
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        description: { type: "string", minLength: 1, maxLength: 4000 },
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
  },
};

function schemaFromExample(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? schemaFromExample(value[0]) : { type: "string" } };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([key, item]) => [key, schemaFromExample(item)])),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (value === null) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value };
}

export function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  inputExample: unknown,
  includeFullSchema: boolean,
  baseUrl?: string,
): Record<string, unknown> {
  const common = {
    contract_version: "flow-code-writer.v1",
    mode,
    requirement,
    mutates_or_executes: false,
    runtime: "Bun 1.4+ fresh worker; no state is shared between executions.",
    runtime_limits: {
      execution_timeout_ms: { minimum_default: 100, default_maximum: 15_000 },
      code_bytes: 65_535,
      input_bytes: 2 * 1024 * 1024,
      result_bytes: 10 * 1024 * 1024,
    },
    code_rules: [
      "所有业务数据只从全局 input 读取，不从环境变量、持久化全局变量或其他外部状态读取；返回值必须可 JSON 序列化。",
      "默认使用顶层 return；只有事件式/异步流程或用户明确要求时才使用 qf_output，且必须是裸的 qf_output = { ... } 对象字面量赋值，不能与顶层 return 混用，也不能遮蔽该标识符。",
      "优先标准 JavaScript、服务端原生 fetch 和 node:crypto；只有原生能力确实无法满足且用户明确要求时，才使用白名单 CommonJS 字面量 require。crypto-js 已移除，不得生成该模块调用。",
      "禁止 import/export、动态 require、浏览器 API、定时器、阻止标识符、阻止成员和黑名单 Node 模块，不得写入真实凭据。",
      "业务逻辑和异步操作放在 try-catch 中；错误转换为字符串或普通对象后返回。",
      "不得创建无界循环、未 settle 的 Promise 或执行结束后仍运行的后台任务；所有请求必须 await 或 return。",
      "外部 URL、请求头、查询参数和请求体必须校验类型、长度和允许范围；HTTP 响应检查状态并按 JSON、文本、空响应分别处理。",
    ],
    async_lifecycle: [
      "禁止 setTimeout、setInterval、setImmediate、轮询、延迟和后台重试。",
      "请求必须在执行超时内完成，不能遗留未等待的 fetch。",
    ],
    require_policy: {
      allowed_call_form: "仅允许单个字符串字面量 require('模块名')，不得间接调用、动态模块名或使用 import/export。",
      dayjs_exception: "日期处理优先原生 Date；复杂日期解析/格式化/时区才允许使用 dayjs。",
      other_modules: "除 dayjs 外，只有原生能力确实无法实现且用户明确要求时才允许白名单模块；Excel 仅允许 read-excel-file/node、read-excel-file/universal、write-excel-file/node、write-excel-file/universal 和 write-excel-file/utility。",
    },
    forbidden: {
      identifiers: [
        "eval", "Function", "Proxy", "__proto__", "child_process", "exec", "execFile", "execSync", "fork", "spawn",
        "module", "exports", "setImmediate", "setInterval", "setTimeout",
      ],
      members: [
        "Object.getPrototypeOf", "Object.setPrototypeOf", "Reflect.construct", "Reflect.apply", "Reflect.get", "Reflect.set",
        "process.exit", "process.kill", "process.binding", "process._linkedBinding", "process.dlopen",
      ],
      modules: [
        "child_process", "cluster", "dgram", "dns", "http", "http2", "https", "inspector", "internal", "module", "node:module",
        "net", "os", "perf_hooks", "async_hooks", "bun", "process", "readline", "repl", "tls", "undici", "v8", "vm", "vm2", "worker_threads", "ws",
      ],
    },
    output_rules: [
      "返回值只能是普通可序列化值或 Promise；禁止循环引用、BigInt、函数、Symbol、未处理的复杂类实例及无界数组/字符串。",
      "平台会把即时接口返回值放入外层 HTTP 响应的 result 字段；脚本接口通常直接返回业务值。推荐 { success: true, data: value } 或 { success: false, error: message }。",
    ],
    allowed_modules: allowedModules,
  };
  if (mode === "non_script") {
    return {
      ...common,
      input_contract: {
        method: "POST",
        path: "/flow/codeblock",
        rule: "请求体中的 input 原样注入全局 input，缺省为 {}；平台请求体可包含 codebase64、input、qingcodeTimeout。",
        example: { codebase64: "<base64 JavaScript>", input: inputExample ?? {} },
      },
      generation_decisions: [
        "用户未说明时生成即时执行的非脚本模式。",
        "如果需求包含 HTTP 重定向，必须改用 script 模式 /flow/codeblock/{{script_id}}。",
      ],
      deliverables: ["只含可执行 JavaScript 的 javascript 代码块", "输入和输出契约"],
      test_tool: { name: "flow_execute_code", arguments: { code: "<JavaScript>", input: inputExample ?? {}, timeout_ms: 3000 } },
      rule: "除非用户明确要求测试，否则不要调用 flow_execute_code。",
      response_format: [
        "除非用户明确要求只返回代码，否则先说明模式和输出方式，再给 JavaScript 代码块，最后给请求/响应示例。",
        "非脚本接口交付完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和 execution_url。",
      ],
    };
  }

  const bodyExample = inputExample && typeof inputExample === "object" ? inputExample : { value: "example" };
  const normalizedBaseUrl = baseUrl?.trim().replace(/\/+$/, "");
  const endpointPathTemplate = "/flow/codeblock/{{script_id}}";
  return {
    ...common,
    input_contract: {
      endpoint: "GET|POST /flow/codeblock/{{script_id}}",
      shape: { query: {}, header: {}, body: {}, cookies: {} },
      mapping: {
        query: "input.query；单值为字符串，重复参数为字符串数组；不含 qingcodeToken/qingcodeTimeout。",
        headers: "input.header；服务端过滤 x-original-cookie，需要 Cookie 时使用 cookie。",
        body: "input.body；POST JSON 请求体，空请求体为 {}；业务数据直接发送，不包装为 input 或 input.body。",
        cookies: "input.cookies；Cookie 键值对象，无 Cookie 时可能不存在。",
      },
      reserved_query: ["qingcodeToken", "qingcodeTimeout"],
    },
    endpoint_url_template: normalizedBaseUrl
      ? `${normalizedBaseUrl}${endpointPathTemplate}`
      : endpointPathTemplate,
    endpoint_url_rule: "提供域名时，输出该域名 + /flow/codeblock/{{script_id}}；URL 中不得包含凭据。",
    internal_artifacts: [
      "只含可执行代码的 JavaScript 代码块（提交预览、校验和发布；默认不回显）",
      "独立且完整的 script-interface-doc.v1 JSON 对象（提交预览、校验和发布；默认不回显）",
    ],
    final_deliverables: [
      "接口调用说明",
      "请求参数及示例",
      "执行逻辑",
      "成功/错误输出示例",
      "发布后的完整 script_url",
    ],
    interface_doc_contract: {
      strict_preview_gate: true,
      required_fields: interfaceDocRequiredFields,
      nested_rules: interfaceDocNestedRules,
      body_example_schema: schemaFromExample(bodyExample),
      full_json_schema: includeFullSchema ? interfaceDocSchema : undefined,
      patch_json_schema: includeFullSchema ? interfaceDocPatchJsonSchema : undefined,
      separation: [
        "javascript 代码块只含可执行代码，不写接口文档注释。",
        "json 代码块只含一个合法 script-interface-doc.v1 对象，不混入 Markdown、注释或尾随逗号。",
      ],
    },
    redirect_contract: {
      rule: "只有脚本接口解析 flow_redirect_url/flow_redirect_code；即时接口把它们作为普通结果。",
      url: "flow_redirect_url 必须是单斜杠相对路径或带主机的 http/https URL，不得含空白或控制字符。",
      code: "flow_redirect_code 只能是 301、302、303、307、308 或对应数字字符串。",
    },
    workflow: [
      "如果是更新，先调用 flow_get_script 读取当前版本；更新文档可先调用 flow_get_script_documentation。",
      "代码和完整 interface_doc 一起生成；创建或代码更新只调用一次 flow_preview_script_change。",
      "仅在用户明确确认后调用 flow_apply_script_change 或 flow_apply_script_documentation，并传 confirm=true。",
      "只有用户要求测试已发布脚本时才调用 flow_execute_script；仅测试未发布代码时调用 flow_execute_code。",
      "版本冲突、预览过期或校验失败时停止并重新读取、重新预览，不重试旧 preview_id。",
    ],
    response_format: [
      "脚本模式默认不回显 JavaScript 或原始 interface_doc；只展示接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的 script_url，除非用户明确索要源码或原始文档。",
      "脚本代码与 interface_doc 仍必须在内部提交给预览、校验和发布工具。",
      "说明请求参数、主要业务行为、响应和错误处理，并提供与模式匹配的 HTTP 方法、路径、Headers/Query/Body/Cookie 和响应示例。",
    ],
  };
}
