import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  FlowApiClient,
  apiErrorMessage,
  currentVersion,
  responseData,
} from "./api.js";
import { codeWriterContext } from "./code-writer.js";
import {
  assertCompleteInterfaceDoc,
  assertInterfaceDocPatch,
  interfaceDocPatchSchema,
  interfaceDocInputDescription,
} from "./interface-doc.js";
import { PreviewStore, fingerprint } from "./preview-store.js";

export interface McpServerOptions {
  api: FlowApiClient;
  previews?: PreviewStore<Record<string, unknown>>;
}

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

const serverInstructions = [
  "这是 Flow Codeblock Rust+Bun MCP Server。除 flow_write_code 外，工具直接调用服务端 REST API；flow_write_code 只返回生成契约。不要猜测 REST 路径，也不要把 MCP 内部令牌放入业务参数。",
  "代码运行于服务端 Bun 异步函数上下文，支持现代 JavaScript、async/await、Promise、箭头函数和顶层 return；默认最小超时 100ms、最大超时 15000ms，代码 65535 字节、输入 2MiB、结果 10MiB。",
  "工具选择：flow_write_code 只生成代码与契约，不执行、不写库；flow_execute_code 只用于用户明确要求的未发布非脚本测试；flow_execute_script 只执行已发布脚本。",
  "脚本读取、创建和更新流程：更新前先 flow_get_script 读取当前 version；创建必须提供完整 interface_doc，更新代码或文档可提供完整 interface_doc 或 RFC 6902 interface_doc_patch（二选一，补丁必须带 expected_version）；先 flow_preview_script_change，再在用户明确确认后 flow_apply_script_change(confirm=true)。文档单独修改使用 flow_preview_script_documentation -> flow_apply_script_documentation。",
  "预览 ID 是一次性且有时效的；版本冲突、预览过期或校验失败时停止，重新读取并预览，不要重试旧 preview_id。flow_apply_* 永远需要 confirm=true。",
  "script-interface-doc.v1 必须包含 schema_version、title、summary、endpoint、request、responses、logic_description。endpoint 必须包含 methods 和 description；request.query、request.headers 必须存在（没有参数用 []）；POST 必须有 request.body，GET-only 必须省略。增量文档使用最多 256 项的 add/remove/replace/move/copy/test JSON Patch，预览只回显操作数量和路径，不回显合并文档。",
  "查询参数和请求头的每一项必须有 name、type、required、description、example。请求体和每个响应必须有 content_type=application/json、schema、example；每个响应还必须有 status、description。JSON Schema 的每个节点必须声明 type，数组必须有 items，对象和 example 必须互相覆盖。",
  "接口文档 endpoint.path 只写相对路径：创建时省略，更新时写 /flow/codeblock/<实际脚本ID>。对外展示的完整调用地址必须使用用户提供的域名拼接 /flow/codeblock/{{脚本ID}}；不要把真实 Token、密码、Cookie 或 Authorization 值写入代码、文档、示例或 URL。",
  "脚本模式输入来自 input.query、input.header、input.body、input.cookies；即时非脚本模式 POST /flow/codeblock 的 body.input 原样成为全局 input。代码默认使用顶层 return；只有事件式/异步流程或用户明确要求时才使用裸 qf_output 赋值，不能混用。",
  "最终用户交付按模式区分：non_script 输出完整 JavaScript、接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和完整 execution_url；script 默认不主动回显 JavaScript 或原始 interface_doc，只输出接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和发布后的完整 script_url，除非用户明确索要源码或原始文档。script 的代码与 interface_doc 仍必须内部提交给预览、校验和发布工具。",
  "优先原生 JavaScript、URL/URLSearchParams 和 fetch；禁止浏览器 API、定时器、动态模块加载、黑名单 Node 模块和危险标识符。HTTP 请求必须检查状态并处理 JSON/文本/空响应，所有异步任务必须显式 await 或 return。",
  "执行脚本时 method 只能是 GET 或 POST；MCP 认证、Cookie、CSRF、代理来源头和测试工具标识会被过滤。不要使用删除脚本、紧急恢复解锁或任意 HTTP 代理能力，本 MCP 不提供这些工具。",
].join("\n");

function encodedScriptId(scriptId: string): string {
  return encodeURIComponent(scriptId);
}

function scriptUrl(api: FlowApiClient, scriptId: string): string {
  return new URL(`/flow/codeblock/${encodedScriptId(scriptId)}`, api.baseUrl).toString();
}

function executionUrl(api: FlowApiClient): string {
  return new URL("/flow/codeblock", api.baseUrl).toString();
}

function withScriptUrl(
  api: FlowApiClient,
  payload: unknown,
  fallbackScriptId?: string,
): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const data = responseData(payload);
  const scriptId = typeof data.script_id === "string" && data.script_id.length > 0
    ? data.script_id
    : fallbackScriptId;
  if (!scriptId) return payload;
  return {
    ...(payload as Record<string, unknown>),
    data: {
      ...data,
      script_url: scriptUrl(api, scriptId),
    },
  };
}

function encodeCode(code: string | undefined, codeBase64: string | undefined): string | undefined {
  if (code === undefined && codeBase64 === undefined) return undefined;
  if (code !== undefined && codeBase64 !== undefined) {
    throw new Error("Provide exactly one of code or code_base64");
  }
  if (code !== undefined) {
    if (!code.length) throw new Error("code cannot be empty");
    return Buffer.from(code, "utf8").toString("base64");
  }
  if (!codeBase64?.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(codeBase64) || codeBase64.length % 4 === 1) {
    throw new Error("code_base64 must be a valid non-empty Base64 string");
  }
  return codeBase64;
}

function removeCreatePath(document: unknown): unknown {
  if (!document || typeof document !== "object" || Array.isArray(document)) return document;
  const copy = structuredClone(document) as Record<string, unknown>;
  const endpoint = copy.endpoint;
  if (endpoint && typeof endpoint === "object" && !Array.isArray(endpoint)) {
    delete (endpoint as Record<string, unknown>).path;
  }
  return copy;
}

const reservedExecutionHeaders = new Set([
  "access-token",
  "accesstoken",
  "authorization",
  "cf-connecting-ip",
  "client-ip",
  "cookie",
  "fastly-client-ip",
  "forwarded",
  "proxy-authorization",
  "true-client-ip",
  "x-appengine-user-ip",
  "x-azure-clientip",
  "x-client-ip",
  "x-cluster-client-ip",
  "x-csrf-token",
  "x-envoy-external-address",
  "x-flow-execution-origin",
  "x-flow-test-tool",
  "x-original-cookie",
  "x-real-ip",
]);

function isReservedExecutionHeader(key: string): boolean {
  const normalized = key.toLowerCase();
  return reservedExecutionHeaders.has(normalized) || normalized.startsWith("x-forwarded-");
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (isReservedExecutionHeader(key)) continue;
    output[key] = value;
  }
  return output;
}

function queryValue(value: string | number | boolean): string {
  return typeof value === "string" ? value : String(value);
}

function withApiErrors(handler: (...args: any[]) => any): (...args: any[]) => Promise<any> {
  return async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };
}

const documentationFields = {
  document: z.unknown().optional().describe(`规范化的 script-interface-doc.v1 JSON 对象。与 raw_document、document_patch 三选一；保存或代码更新时必须完整。${interfaceDocInputDescription}`),
  raw_document: z.string().optional().describe("待服务端解析的 JSON/OpenAPI 文档文本。与 document、document_patch 三选一；format=json 时按 JSON 解析。"),
  format: z.literal("json").optional().describe("raw_document 的格式，目前只支持 json。"),
  document_patch: interfaceDocPatchSchema.optional().describe("仅已有脚本使用的 RFC 6902 增量补丁；与 document、raw_document 三选一。"),
  expected_version: z.number().int().positive().optional().describe("补丁的当前脚本版本；提交补丁时必填，必须来自刚读取的当前版本。"),
};

const changeSchema = z.object({
  operation: z.enum(["create", "update"]).describe("create 创建脚本；update 更新已有脚本。"),
  script_id: z.string().min(1).optional().describe("更新目标脚本 ID。create 不得传入。"),
  code: z.string().optional().describe("UTF-8 JavaScript 源码，与 code_base64 二选一。创建或修改代码时必填；代码只包含可执行 JavaScript。"),
  code_base64: z.string().optional().describe("JavaScript 源码的非空 Base64，与 code 二选一。"),
  description: z.string().optional().describe("脚本说明。可在不改代码时单独更新。"),
  ip_whitelist: z.array(z.string()).nullable().optional().describe("来源 IP/CIDR 白名单。省略表示更新时保持原值；null 或 [] 表示清除限制。"),
  interface_doc: z.unknown().optional().describe(interfaceDocInputDescription),
  interface_doc_patch: interfaceDocPatchSchema.optional().describe("仅 update 使用的 RFC 6902 JSON Patch；与完整 interface_doc 互斥，create 禁止使用。"),
  rollback_to_version: z.number().int().positive().optional().describe("回滚到的历史版本号。只能与单独的 update 操作使用，不能和 code、interface_doc 或 interface_doc_patch 同时传入。"),
  expected_version: z.number().int().positive().optional().describe("更新时必填的当前版本号。必须来自刚读取的 flow_get_script，用于并发冲突保护；create 不得传入。"),
});

const documentationSchema = z.object({
  script_id: z.string().min(1).describe("目标脚本 ID，不是完整 URL；校验或预览现有脚本的文档。"),
  ...documentationFields,
}).superRefine((input, context) => {
  const supplied = [input.document, input.raw_document, input.document_patch].filter((value) => value !== undefined).length;
  if (supplied !== 1) {
    context.addIssue({ code: "custom", message: "Provide exactly one of document, raw_document, or document_patch" });
  }
  if (input.document_patch !== undefined && input.expected_version === undefined) {
    context.addIssue({ code: "custom", message: "document_patch requires expected_version" });
  }
});

function documentationBody(input: z.infer<typeof documentationSchema>): Record<string, unknown> {
  if (input.document_patch !== undefined) {
    return { document_patch: input.document_patch, expected_version: input.expected_version };
  }
  if (input.raw_document !== undefined) {
    return { raw_document: input.raw_document, ...(input.format ? { format: input.format } : {}) };
  }
  return { document: input.document };
}

async function fetchCurrentVersion(api: FlowApiClient, scriptId: string): Promise<number> {
  return currentVersion(await api.get(`/flow/scripts/${encodedScriptId(scriptId)}`));
}

function assertScriptChangeInput(input: z.infer<typeof changeSchema>): void {
  const hasCode = input.code !== undefined || input.code_base64 !== undefined;
  if (input.code !== undefined && input.code_base64 !== undefined) {
    throw new Error("Provide exactly one of code or code_base64");
  }
  if (input.operation === "create") {
    if (input.script_id !== undefined || input.expected_version !== undefined) {
      throw new Error("Create preview must not include script_id or expected_version");
    }
    if (!hasCode) throw new Error("Create preview requires code or code_base64");
    if (input.interface_doc_patch !== undefined) {
      throw new Error("Create preview cannot use interface_doc_patch; submit a complete interface_doc");
    }
    if (input.interface_doc === undefined) {
      throw new Error("Create preview requires a complete interface_doc");
    }
    if (input.rollback_to_version !== undefined) {
      throw new Error("Create preview must not include rollback_to_version");
    }
  } else {
    if (!input.script_id || input.expected_version === undefined) {
      throw new Error("Update preview requires script_id and expected_version");
    }
    if (!hasCode && input.description === undefined && input.ip_whitelist === undefined
      && input.interface_doc === undefined && input.interface_doc_patch === undefined && input.rollback_to_version === undefined) {
      throw new Error("Update preview requires code, description, ip_whitelist, interface_doc, interface_doc_patch, or rollback_to_version");
    }
    if (hasCode && input.interface_doc === undefined && input.interface_doc_patch === undefined) {
      throw new Error("Updating code requires a complete interface_doc or interface_doc_patch");
    }
  }
  if (input.interface_doc !== undefined && input.interface_doc_patch !== undefined) {
    throw new Error("interface_doc and interface_doc_patch are mutually exclusive");
  }
  if (input.rollback_to_version !== undefined && (hasCode || input.interface_doc !== undefined || input.interface_doc_patch !== undefined)) {
    throw new Error("rollback_to_version cannot be combined with code, interface_doc, or interface_doc_patch");
  }
  if (input.interface_doc !== undefined) {
    assertCompleteInterfaceDoc(input.interface_doc, input.operation);
  }
  if (input.interface_doc_patch !== undefined) assertInterfaceDocPatch(input.interface_doc_patch);
}

async function validateScriptChange(
  api: FlowApiClient,
  operation: "create" | "update",
  payload: Record<string, unknown>,
): Promise<unknown> {
  const hasCode = typeof payload.code_base64 === "string";
  const hasDocument = payload.interface_doc !== undefined && payload.interface_doc !== null;
  const hasPatch = payload.interface_doc_patch !== undefined;
  const hasWhitelist = payload.ip_whitelist !== undefined;
  if (!hasCode && !hasDocument && !hasPatch && !hasWhitelist) {
    return { success: true, data: { valid: true, warnings: [] } };
  }
  return api.post("/flow/scripts/validate", {
    ...(hasCode ? { code_base64: payload.code_base64 } : {}),
    ...(operation === "update" ? { script_id: payload.script_id } : {}),
    ...(hasPatch ? { expected_version: payload.expected_version } : {}),
    ...(hasWhitelist ? { ip_whitelist: payload.ip_whitelist } : {}),
    ...(hasDocument ? { interface_doc: payload.interface_doc } : {}),
    ...(hasPatch ? { interface_doc_patch: payload.interface_doc_patch } : {}),
  });
}

function compactPatchValidation(validation: unknown, patch: unknown, currentVersion?: number): Record<string, unknown> {
  const data = responseData(validation);
  const operations = Array.isArray(patch) ? patch : [];
  return {
    valid: data.valid ?? true,
    warnings: Array.isArray(data.warnings) ? data.warnings : [],
    current_version: currentVersion,
    interface_doc_patch: {
      operation_count: operations.length,
      paths: operations.map((operation) => {
        if (!operation || typeof operation !== "object") return null;
        const value = operation as Record<string, unknown>;
        return {
          op: typeof value.op === "string" ? value.op : "unknown",
          path: typeof value.path === "string" ? value.path : "",
          ...(typeof value.from === "string" ? { from: value.from } : {}),
        };
      }),
    },
  };
}

function assertPreview(record: ReturnType<PreviewStore<Record<string, unknown>>["get"]>, operation: "script_change" | "documentation") {
  if (!record || record.operation !== operation) throw new Error("Preview is missing, expired, or has the wrong operation");
  if (fingerprint(record.operation, record.payload) !== record.fingerprint) {
    throw new Error("Preview contents changed");
  }
  return record;
}

export function createMcpServer({ api, previews = new PreviewStore() }: McpServerOptions): McpServer {
  const server = new McpServer(
    { name: "flow-codeblock-rust", version: "0.1.2" },
    { instructions: serverInstructions },
  );

  server.registerTool(
    "flow_write_code",
    {
      description: "生成代码实现契约，不写数据库、不发布脚本、不执行代码。mode=non_script 生成即时 POST /flow/codeblock 代码，最终交付包含完整 execution_url；mode=script 生成 GET/POST /flow/codeblock/{{script_id}} 代码，内部生成完整 script-interface-doc.v1 供预览、校验和发布，最终交付默认只展示接口调用说明、请求参数及示例、执行逻辑、成功/错误输出示例和 script_url，除非用户明确索要源码或原始 interface_doc。脚本文档的 title、summary、endpoint.methods、endpoint.description、request、responses、logic_description 必须齐全；query/header 参数必须有 name/type/description/example，body 和 response 字段必须有 content_type/schema/example。需要展示用户指定的完整地址时可传入 base_url。",
      inputSchema: {
        mode: z.enum(["non_script", "script"]).describe("执行模式：non_script 为即时接口；script 为按脚本 ID 发布的 GET/POST 接口。未明确要求重定向时使用 non_script。"),
        requirement: z.string().min(1).max(20_000).describe("用户的业务需求、输入字段、同步/异步要求和错误行为。只写与本次代码有关的需求。"),
        input_example: z.unknown().optional().describe("业务输入示例。脚本模式下用于生成 request.body/schema/example；非脚本模式下用于 flow_execute_code 测试参数。不要放真实凭据。"),
        include_full_schema: z.boolean().optional().describe("脚本模式是否在结果中附带完整 JSON Schema；默认 false。接口文档实例仍必须按必填字段生成。"),
        base_url: z.string().url().refine((value) => {
          try {
            const parsed = new URL(value);
            return (parsed.protocol === "http:" || parsed.protocol === "https:")
              && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
              && !/[\u0000-\u001f\u007f]/.test(value);
          } catch {
            return false;
          }
        }, "base_url must be an http(s) URL without credentials or control characters").optional()
          .describe("可选的用户服务域名，例如 https://flow.example.com。仅用于输出完整调用地址，会拼接 /flow/codeblock/{{script_id}}；不得包含用户名、密码或 Token。"),
      },
    },
    async ({ mode, requirement, input_example, include_full_schema, base_url }) => {
      const context = codeWriterContext(mode, requirement, input_example, include_full_schema ?? false, base_url);
      return result(mode === "non_script" ? { ...context, execution_url: executionUrl(api) } : context);
    },
  );

  server.registerTool(
    "flow_list_scripts",
    {
      description: "只读分页查询脚本。默认使用 page/size 偏移分页；需要连续遍历时使用 pagination=cursor，首次不传 cursor，后续使用响应中的游标。不会创建、更新或执行脚本。",
      inputSchema: {
        page: z.number().int().positive().optional().describe("偏移分页页码，从 1 开始；使用游标分页时省略。"),
        size: z.number().int().min(1).max(100).optional().describe("每页数量，1-100，默认由服务端决定。"),
        keyword: z.string().optional().describe("按脚本关键词筛选。"),
        sort: z.enum(["updated_at", "created_at", "code_length", "version"]).optional().describe("排序字段。游标分页只支持 updated_at、created_at、code_length。"),
        order: z.enum(["asc", "desc"]).optional().describe("排序方向，默认由服务端决定。"),
        pagination: z.literal("cursor").optional().describe("传 cursor 启用游标分页；首次调用不要传 cursor。"),
        cursor: z.string().optional().describe("上一页返回的游标，仅与 pagination=cursor 一起使用。"),
      },
    },
    withApiErrors(async ({ page, size, keyword, sort, order, pagination, cursor }) => {
      const query = new URLSearchParams();
      if (page !== undefined) query.set("page", String(page));
      if (size !== undefined) query.set("size", String(size));
      if (keyword !== undefined) query.set("keyword", keyword);
      if (sort !== undefined) query.set("sort", sort);
      if (order !== undefined) query.set("order", order);
      if (pagination !== undefined) query.set("pagination", pagination);
      if (cursor !== undefined) query.set("cursor", cursor);
      return result(await api.get(`/flow/scripts${query.size ? `?${query}` : ""}`));
    }),
  );

  server.registerTool(
    "flow_get_script",
    {
      description: "只读读取脚本代码、元数据和版本信息。更新前必须先调用本工具并使用返回的 current_version 作为 flow_preview_script_change.expected_version。",
      inputSchema: {
        script_id: z.string().min(1).describe("脚本 ID，不是完整 URL。"),
        version: z.number().int().min(0).optional().describe("可选历史版本号；省略时读取当前版本。"),
      },
    },
    withApiErrors(async ({ script_id, version }) => {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await api.get(`/flow/scripts/${encodedScriptId(script_id)}${query}`));
    }),
  );

  server.registerTool(
    "flow_get_script_documentation",
    {
      description: "只读读取当前或指定历史版本的 script-interface-doc.v1 接口文档。修改文档前先读取当前版本并保留版本号。",
      inputSchema: {
        script_id: z.string().min(1).describe("脚本 ID，不是完整 URL。"),
        version: z.number().int().min(0).optional().describe("可选历史版本号；省略时读取当前文档。"),
      },
    },
    withApiErrors(async ({ script_id, version }) => {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await api.get(`/flow/scripts/${encodedScriptId(script_id)}/documentation${query}`));
    }),
  );

  server.registerTool(
    "flow_validate_script_documentation",
    {
      description: "只读校验并规范化指定脚本的接口文档，不写入数据库。完整 document、raw_document 和 RFC 6902 document_patch 三选一；补丁必须带 expected_version，响应不会用于发布确认。",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      if (parsed.document !== undefined) {
        assertCompleteInterfaceDoc(parsed.document, "update");
      }
      if (parsed.document_patch !== undefined) assertInterfaceDocPatch(parsed.document_patch);
      const validation = parsed.document_patch !== undefined
        ? await api.post("/flow/scripts/validate", {
            script_id: parsed.script_id,
            expected_version: parsed.expected_version,
            interface_doc_patch: parsed.document_patch,
          })
        : await api.post(
            `/flow/scripts/${encodedScriptId(parsed.script_id)}/documentation`,
            documentationBody(parsed),
          );
      const document = responseData(validation).document ?? responseData(validation).interface_doc;
      if (document === undefined) throw new Error("Documentation validation response did not include document");
      assertCompleteInterfaceDoc(document, "update");
      return result(validation);
    }),
  );

  server.registerTool(
    "flow_preview_script_change",
    {
      description: "预览脚本创建或更新，不写数据库。create 必须传 code/code_base64 和完整 interface_doc，且不得传 script_id/expected_version；update 必须传 script_id 和刚读取的 expected_version，修改代码时必须同时传完整 interface_doc 或 interface_doc_patch。预览成功后只能在用户明确确认时调用 flow_apply_script_change(confirm=true)。",
      inputSchema: changeSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = changeSchema.parse(input);
      assertScriptChangeInput(parsed);
      const codeBase64 = encodeCode(parsed.code, parsed.code_base64);
      const payload: Record<string, unknown> = {
        ...(parsed.operation === "update" ? { script_id: parsed.script_id } : {}),
        ...(parsed.operation === "update" ? { expected_version: parsed.expected_version } : {}),
        ...(codeBase64 !== undefined ? { code_base64: codeBase64 } : {}),
        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
        ...(parsed.ip_whitelist !== undefined ? { ip_whitelist: parsed.ip_whitelist } : {}),
        ...(parsed.interface_doc !== undefined
          ? { interface_doc: parsed.operation === "create" ? removeCreatePath(parsed.interface_doc) : parsed.interface_doc }
          : {}),
        ...(parsed.interface_doc_patch !== undefined ? { interface_doc_patch: parsed.interface_doc_patch } : {}),
        ...(parsed.rollback_to_version !== undefined ? { rollback_to_version: parsed.rollback_to_version } : {}),
      };
      const expectedVersion = parsed.operation === "update"
        ? await fetchCurrentVersion(api, parsed.script_id!)
        : undefined;
      if (parsed.operation === "update" && expectedVersion !== parsed.expected_version) {
        throw new Error(`Script version changed from ${parsed.expected_version} to ${expectedVersion}; read and preview again`);
      }
      const validation = await validateScriptChange(api, parsed.operation, payload);
      const normalized = responseData(validation).interface_doc;
      if (parsed.interface_doc !== undefined && normalized !== undefined) payload.interface_doc = normalized;
      const previewValidation = parsed.interface_doc_patch !== undefined
        ? compactPatchValidation(validation, parsed.interface_doc_patch, expectedVersion)
        : { valid: true, server_validation: validation };
      const previewId = randomUUID();
      const storedPreview = previews.put(previewId, "script_change", payload, expectedVersion);
      return result({
        preview_id: previewId,
        operation: parsed.operation,
        expected_version: expectedVersion,
        expires_at: new Date(storedPreview.expiresAt).toISOString(),
        validation: {
          ...previewValidation,
        },
        changes: {
          code: codeBase64 !== undefined,
          description: parsed.description !== undefined,
          ip_whitelist: parsed.ip_whitelist !== undefined,
          interface_doc: parsed.interface_doc !== undefined,
          interface_doc_patch: parsed.interface_doc_patch !== undefined,
          rollback_to_version: parsed.rollback_to_version !== undefined,
        },
      });
    }),
  );

  server.registerTool(
    "flow_apply_script_change",
    {
      description: "应用 flow_preview_script_change 返回的一次性 preview_id。必须传 confirm=true；工具会再次检查版本并在成功或失败后销毁预览。发布成功时返回由 FLOW_CODEBLOCK_BASE_URL 生成的完整 script_url。不支持删除脚本。版本冲突时重新读取并预览。",
      inputSchema: {
        preview_id: z.string().uuid().describe("最近一次脚本变更预览返回的 UUID；不能复用过期或已应用的 ID。"),
        confirm: z.literal(true).describe("必须为 true，表示用户已明确确认写入。"),
      },
    },
    withApiErrors(async ({ preview_id }) => {
      try {
        const record = assertPreview(previews.get(preview_id), "script_change");
        const payload = record.payload;
        const scriptId = typeof payload.script_id === "string" ? payload.script_id : undefined;
        let response: unknown;
        if (scriptId) {
          const actualVersion = await fetchCurrentVersion(api, scriptId);
          if (actualVersion !== record.expectedVersion) {
            throw new Error(`Script version changed from ${record.expectedVersion} to ${actualVersion}; read and preview again`);
          }
          if (payload.interface_doc_patch !== undefined) {
            await validateScriptChange(api, "update", payload);
          }
          const body = { ...payload };
          delete body.script_id;
          response = await api.put(`/flow/scripts/${encodedScriptId(scriptId)}`, body);
        } else {
          response = await api.post("/flow/scripts", payload);
        }
        return result(withScriptUrl(api, response, scriptId));
      } finally {
        previews.delete(preview_id);
      }
    }),
  );

  server.registerTool(
    "flow_preview_script_documentation",
    {
      description: "预览接口文档保存，不写数据库。先读取脚本当前版本；document、raw_document 和 document_patch 三选一，补丁必须带 expected_version，完整文档必须包含所有强制字段。成功后只有 flow_apply_script_documentation(confirm=true) 才会写入。",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      const expectedVersion = await fetchCurrentVersion(api, parsed.script_id);
      if (parsed.document_patch !== undefined && parsed.expected_version !== expectedVersion) {
        throw new Error(`Script version changed from ${parsed.expected_version} to ${expectedVersion}; read and preview again`);
      }
      const rawBody = documentationBody(parsed);
      const validation = parsed.document_patch !== undefined
        ? await api.post("/flow/scripts/validate", {
            script_id: parsed.script_id,
            expected_version: parsed.expected_version,
            interface_doc_patch: parsed.document_patch,
          })
        : parsed.raw_document !== undefined
          ? await api.post(`/flow/scripts/${encodedScriptId(parsed.script_id)}/documentation`, rawBody)
          : await api.post("/flow/scripts/validate", {
              script_id: parsed.script_id,
              interface_doc: rawBody.document,
            });
      const document = responseData(validation).interface_doc ?? responseData(validation).document;
      if (parsed.document_patch === undefined) {
        if (document === undefined) throw new Error("Documentation validation response did not include document");
        assertCompleteInterfaceDoc(document, "update");
      }
      const previewId = randomUUID();
      const storedPreview = previews.put(
        previewId,
        "documentation",
        parsed.document_patch !== undefined
          ? { script_id: parsed.script_id, expected_version: expectedVersion, document_patch: parsed.document_patch }
          : { script_id: parsed.script_id, document },
        expectedVersion,
      );
      return result({
        preview_id: previewId,
        script_id: parsed.script_id,
        expected_version: expectedVersion,
        expires_at: new Date(storedPreview.expiresAt).toISOString(),
        validation: parsed.document_patch !== undefined
          ? compactPatchValidation(validation, parsed.document_patch, expectedVersion)
          : responseData(validation),
      });
    }),
  );

  server.registerTool(
    "flow_apply_script_documentation",
    {
      description: "应用 flow_preview_script_documentation 返回的一次性预览。必须传 confirm=true；工具会再次检查脚本版本并在成功或失败后销毁预览。发布成功时返回完整 script_url。版本冲突时重新读取、预览。",
      inputSchema: {
        preview_id: z.string().uuid().describe("最近一次接口文档预览返回的 UUID；不能复用过期或已应用的 ID。"),
        confirm: z.literal(true).describe("必须为 true，表示用户已明确确认写入。"),
      },
    },
    withApiErrors(async ({ preview_id }) => {
      try {
        const record = assertPreview(previews.get(preview_id), "documentation");
        const scriptId = String(record.payload.script_id);
        const actualVersion = await fetchCurrentVersion(api, scriptId);
        if (actualVersion !== record.expectedVersion) {
          throw new Error(`Script version changed from ${record.expectedVersion} to ${actualVersion}; read and preview again`);
        }
        const patch = record.payload.document_patch;
        if (patch !== undefined) {
          assertInterfaceDocPatch(patch);
          await api.post("/flow/scripts/validate", {
            script_id: scriptId,
            expected_version: record.expectedVersion,
            interface_doc_patch: patch,
          });
        }
        const response = await api.put(`/flow/scripts/${encodedScriptId(scriptId)}/documentation`, {
          ...(patch !== undefined ? { document_patch: patch } : { document: record.payload.document }),
          expected_version: record.expectedVersion,
        });
        return result(withScriptUrl(api, response, scriptId));
      } finally {
        previews.delete(preview_id);
      }
    }),
  );

  const lockSchema = {
    script_id: z.string().min(1).describe("要锁定或解锁的脚本 ID。"),
    owner_name: z.string().min(1).describe("锁定时设置、解锁时核对的所有者名称。"),
    lock_password: z.string().min(6).describe("锁定口令；仅传给服务端，不会写入 MCP 预览或日志。"),
    confirm: z.literal(true).describe("必须为 true，表示用户明确确认锁定或解锁。"),
  };

  server.registerTool(
    "flow_lock_script",
    { description: "锁定脚本以阻止并发写入。必须显式传入 confirm=true；锁定口令不会被 MCP 保存。锁定后脚本变更和文档保存可能被服务端拒绝。", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/lock`, { owner_name, lock_password }))),
  );

  server.registerTool(
    "flow_unlock_script",
    { description: "使用所有者名称和口令正常解锁脚本。必须显式传入 confirm=true；锁定口令不会被 MCP 保存。不提供紧急恢复解锁。", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/unlock`, { owner_name, lock_password }))),
  );

  const queryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
  server.registerTool(
    "flow_execute_script",
    {
      description: "执行已发布脚本，仅用于用户明确要求测试或调用时。method 只能是 GET/POST；结果包含由 FLOW_CODEBLOCK_BASE_URL 和 script_id 生成的完整 script_url。query 数组会生成重复参数，POST 的 body 作为 JSON 发送。MCP 认证、Cookie、CSRF、代理来源头和测试工具标识会被过滤，qingcodeToken/qingcodeTimeout 不能作为业务参数传入。",
      inputSchema: {
        script_id: z.string().min(1).describe("已发布脚本 ID；工具会调用 /flow/codeblock/{script_id}。"),
        method: z.enum(["GET", "POST"]).default("POST").describe("脚本请求方法，只能是 GET 或 POST；默认 POST。"),
        query: z.record(z.string(), queryValueSchema).optional().describe("业务查询参数。值可为 string/number/boolean 或其数组；数组生成重复 query 参数。不要传 qingcodeToken/qingcodeTimeout。"),
        headers: z.record(z.string(), z.string()).optional().describe("业务请求头。认证、Cookie、CSRF、Forwarded、X-Real-IP 等保留头会被过滤。"),
        body: z.unknown().optional().describe("POST JSON 请求体；GET 不发送 body。不要把脚本模式业务 body 包装为 input 或 input.body。"),
        timeout_ms: z.number().int().positive().optional().describe("执行超时毫秒数；只能通过此字段配置，不能在 query 中传 qingcodeTimeout。"),
      },
    },
    withApiErrors(async ({ script_id, method, query, headers, body, timeout_ms }) => {
      const url = new URL(`/flow/codeblock/${encodedScriptId(script_id)}`, api.baseUrl);
      for (const [key, value] of Object.entries(query ?? {})) {
        const typedValue = value as string | number | boolean | Array<string | number | boolean>;
        const normalized = key.toLowerCase();
        if (normalized === "qingcodetimeout" || normalized === "qingcodetoken") {
          throw new Error(`${key} is reserved; use timeout_ms or FLOW_CODEBLOCK_TOKEN`);
        }
        if (Array.isArray(typedValue)) {
          for (const item of typedValue) url.searchParams.append(key, queryValue(item));
        } else {
          url.searchParams.set(key, queryValue(typedValue));
        }
      }
      if (timeout_ms !== undefined) url.searchParams.set("qingcodeTimeout", String(timeout_ms));
      const response = await api.request(url.pathname + url.search, {
        method,
        headers: cleanHeaders(headers),
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
        authenticated: false,
        execution: true,
      });
      return result({ script_url: scriptUrl(api, script_id), method, response });
    }),
  );

  server.registerTool(
    "flow_execute_code",
    {
      description: "执行未发布的非脚本 JavaScript，仅在用户明确要求测试时使用。结果包含完整 execution_url。请求固定为 POST /flow/codeblock，body.input 原样注入全局 input；代码和 code_base64 二选一。不会把 MCP 认证信息写入用户脚本输入，也不会创建或发布脚本。",
      inputSchema: {
        code: z.string().min(1).optional().describe("UTF-8 JavaScript 源码，与 code_base64 二选一。"),
        code_base64: z.string().min(1).optional().describe("JavaScript 源码的非空 Base64，与 code 二选一。"),
        input: z.unknown().optional().describe("注入全局 input 的业务数据，默认 {}。不要放 Token、密码、Cookie 或 Authorization 值。"),
        timeout_ms: z.number().int().positive().optional().describe("本次测试执行超时毫秒数；必须在服务端允许的最小/最大范围内。"),
      },
    },
    withApiErrors(async ({ code, code_base64, input, timeout_ms }) => {
      const codeBase64 = encodeCode(code, code_base64);
      const body = {
        codebase64: codeBase64,
        input: input ?? {},
        ...(timeout_ms === undefined ? {} : { qingcodeTimeout: timeout_ms }),
      };
      return result({
        mode: "non_script",
        execution_url: executionUrl(api),
        response: await api.request("/flow/codeblock", {
          method: "POST",
          body: JSON.stringify(body),
          execution: true,
        }),
      });
    }),
  );

  return server;
}
