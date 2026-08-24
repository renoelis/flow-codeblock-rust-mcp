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

function encodedScriptId(scriptId: string): string {
  return encodeURIComponent(scriptId);
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
  document: z.unknown().optional(),
  raw_document: z.string().optional(),
  format: z.literal("json").optional(),
};

const changeSchema = z.object({
  operation: z.enum(["create", "update"]),
  script_id: z.string().min(1).optional(),
  code: z.string().optional(),
  code_base64: z.string().optional(),
  description: z.string().optional(),
  ip_whitelist: z.array(z.string()).nullable().optional(),
  interface_doc: z.unknown().optional().describe(interfaceDocInputDescription),
  rollback_to_version: z.number().int().positive().optional(),
  expected_version: z.number().int().positive().optional(),
});

const documentationSchema = z.object({
  script_id: z.string().min(1),
  ...documentationFields,
}).superRefine((input, context) => {
  if ((input.document === undefined) === (input.raw_document === undefined)) {
    context.addIssue({ code: "custom", message: "Provide exactly one of document or raw_document" });
  }
});

function documentationBody(input: z.infer<typeof documentationSchema>): Record<string, unknown> {
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
      && input.interface_doc === undefined && input.rollback_to_version === undefined) {
      throw new Error("Update preview requires code, description, ip_whitelist, interface_doc, or rollback_to_version");
    }
    if (hasCode && input.interface_doc === undefined) {
      throw new Error("Updating code requires a complete interface_doc");
    }
  }
  if (input.rollback_to_version !== undefined && (hasCode || input.interface_doc !== undefined)) {
    throw new Error("rollback_to_version cannot be combined with code or interface_doc");
  }
  if (input.interface_doc !== undefined) {
    assertCompleteInterfaceDoc(input.interface_doc, input.operation);
  }
}

async function validateScriptChange(
  api: FlowApiClient,
  operation: "create" | "update",
  payload: Record<string, unknown>,
): Promise<unknown> {
  const hasCode = typeof payload.code_base64 === "string";
  const hasDocument = payload.interface_doc !== undefined && payload.interface_doc !== null;
  const hasWhitelist = payload.ip_whitelist !== undefined;
  if (!hasCode && !hasDocument && !hasWhitelist) {
    return { success: true, data: { valid: true, warnings: [] } };
  }
  return api.post("/flow/scripts/validate", {
    ...(hasCode ? { code_base64: payload.code_base64 } : {}),
    ...(operation === "update" ? { script_id: payload.script_id } : {}),
    ...(hasWhitelist ? { ip_whitelist: payload.ip_whitelist } : {}),
    ...(hasDocument ? { interface_doc: payload.interface_doc } : {}),
  });
}

function assertPreview(record: ReturnType<PreviewStore<Record<string, unknown>>["get"]>, operation: "script_change" | "documentation") {
  if (!record || record.operation !== operation) throw new Error("Preview is missing, expired, or has the wrong operation");
  if (fingerprint(record.operation, record.payload) !== record.fingerprint) {
    throw new Error("Preview contents changed");
  }
  return record;
}

export function createMcpServer({ api, previews = new PreviewStore() }: McpServerOptions): McpServer {
  const server = new McpServer({ name: "flow-codeblock-rust", version: "0.1.0" });

  server.registerTool(
    "flow_write_code",
    {
      description: "返回符合当前 Flow Codeblock Rust+Bun 运行时、输入和接口文档约束的代码生成契约。本工具不写数据库也不执行代码。",
      inputSchema: {
        mode: z.enum(["non_script", "script"]),
        requirement: z.string().min(1).max(20_000),
        input_example: z.unknown().optional(),
        include_full_schema: z.boolean().optional(),
      },
    },
    async ({ mode, requirement, input_example, include_full_schema }) =>
      result(codeWriterContext(mode, requirement, input_example, include_full_schema ?? false)),
  );

  server.registerTool(
    "flow_list_scripts",
    {
      description: "分页查询当前 Flow Codeblock 服务中的脚本。",
      inputSchema: {
        page: z.number().int().positive().optional(),
        size: z.number().int().min(1).max(100).optional(),
        keyword: z.string().optional(),
        sort: z.enum(["updated_at", "created_at", "code_length", "version"]).optional(),
        order: z.enum(["asc", "desc"]).optional(),
        pagination: z.literal("cursor").optional(),
        cursor: z.string().optional(),
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
      description: "读取脚本的当前版本或指定历史版本。",
      inputSchema: { script_id: z.string().min(1), version: z.number().int().min(0).optional() },
    },
    withApiErrors(async ({ script_id, version }) => {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await api.get(`/flow/scripts/${encodedScriptId(script_id)}${query}`));
    }),
  );

  server.registerTool(
    "flow_get_script_documentation",
    {
      description: "读取当前或指定历史版本的脚本接口文档。",
      inputSchema: { script_id: z.string().min(1), version: z.number().int().min(0).optional() },
    },
    withApiErrors(async ({ script_id, version }) => {
      const query = version === undefined ? "" : `?version=${encodeURIComponent(String(version))}`;
      return result(await api.get(`/flow/scripts/${encodedScriptId(script_id)}/documentation${query}`));
    }),
  );

  server.registerTool(
    "flow_validate_script_documentation",
    {
      description: "校验并规范化接口文档，不写入数据库。",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      if (parsed.document !== undefined) {
        assertCompleteInterfaceDoc(parsed.document, "update");
      }
      const validation = await api.post(
        `/flow/scripts/${encodedScriptId(parsed.script_id)}/documentation`,
        documentationBody(parsed),
      );
      const document = responseData(validation).document;
      if (document === undefined) throw new Error("Documentation validation response did not include document");
      assertCompleteInterfaceDoc(document, "update");
      return result(validation);
    }),
  );

  server.registerTool(
    "flow_preview_script_change",
    {
      description: "预览脚本创建或更新。预览不会写数据库，应用必须再次传 confirm=true。",
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
      if (normalized !== undefined) payload.interface_doc = normalized;
      const previewId = randomUUID();
      const storedPreview = previews.put(previewId, "script_change", payload, expectedVersion);
      return result({
        preview_id: previewId,
        operation: parsed.operation,
        expected_version: expectedVersion,
        expires_at: new Date(storedPreview.expiresAt).toISOString(),
        validation: {
          valid: true,
          server_validation: validation,
        },
        changes: {
          code: codeBase64 !== undefined,
          description: parsed.description !== undefined,
          ip_whitelist: parsed.ip_whitelist !== undefined,
          interface_doc: parsed.interface_doc !== undefined,
          rollback_to_version: parsed.rollback_to_version !== undefined,
        },
      });
    }),
  );

  server.registerTool(
    "flow_apply_script_change",
    {
      description: "应用已预览的创建或更新，必须传入 confirm=true；不支持删除脚本。",
      inputSchema: { preview_id: z.string().uuid(), confirm: z.literal(true) },
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
          const body = { ...payload };
          delete body.script_id;
          response = await api.put(`/flow/scripts/${encodedScriptId(scriptId)}`, body);
        } else {
          response = await api.post("/flow/scripts", payload);
        }
        return result(response);
      } finally {
        previews.delete(preview_id);
      }
    }),
  );

  server.registerTool(
    "flow_preview_script_documentation",
    {
      description: "预览并校验接口文档保存，不写数据库。",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      const expectedVersion = await fetchCurrentVersion(api, parsed.script_id);
      const rawBody = documentationBody(parsed);
      const validation = parsed.raw_document !== undefined
        ? await api.post(`/flow/scripts/${encodedScriptId(parsed.script_id)}/documentation`, rawBody)
        : await api.post("/flow/scripts/validate", {
            script_id: parsed.script_id,
            interface_doc: rawBody.document,
          });
      const document = responseData(validation).interface_doc ?? responseData(validation).document;
      if (document === undefined) throw new Error("Documentation validation response did not include document");
      assertCompleteInterfaceDoc(document, "update");
      const previewId = randomUUID();
      const storedPreview = previews.put(previewId, "documentation", { script_id: parsed.script_id, document }, expectedVersion);
      return result({
        preview_id: previewId,
        script_id: parsed.script_id,
        expected_version: expectedVersion,
        expires_at: new Date(storedPreview.expiresAt).toISOString(),
        validation: responseData(validation),
      });
    }),
  );

  server.registerTool(
    "flow_apply_script_documentation",
    {
      description: "应用已预览的接口文档，必须传入 confirm=true。",
      inputSchema: { preview_id: z.string().uuid(), confirm: z.literal(true) },
    },
    withApiErrors(async ({ preview_id }) => {
      try {
        const record = assertPreview(previews.get(preview_id), "documentation");
        const scriptId = String(record.payload.script_id);
        const actualVersion = await fetchCurrentVersion(api, scriptId);
        if (actualVersion !== record.expectedVersion) {
          throw new Error(`Script version changed from ${record.expectedVersion} to ${actualVersion}; read and preview again`);
        }
        const response = await api.put(`/flow/scripts/${encodedScriptId(scriptId)}/documentation`, {
          document: record.payload.document,
          expected_version: record.expectedVersion,
        });
        return result(response);
      } finally {
        previews.delete(preview_id);
      }
    }),
  );

  const lockSchema = {
    script_id: z.string().min(1),
    owner_name: z.string().min(1),
    lock_password: z.string().min(6),
    confirm: z.literal(true),
  };

  server.registerTool(
    "flow_lock_script",
    { description: "锁定脚本。必须显式传入 confirm=true；锁定口令不会被 MCP 保存。", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/lock`, { owner_name, lock_password }))),
  );

  server.registerTool(
    "flow_unlock_script",
    { description: "解锁脚本。必须显式传入 confirm=true；锁定口令不会被 MCP 保存。", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/unlock`, { owner_name, lock_password }))),
  );

  const queryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
  server.registerTool(
    "flow_execute_script",
    {
      description: "执行已发布脚本。执行请求不向脚本转发 MCP 认证凭据、Cookie、CSRF 或测试工具标识。",
      inputSchema: {
        script_id: z.string().min(1),
        method: z.enum(["GET", "POST"]).default("POST"),
        query: z.record(z.string(), queryValueSchema).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        timeout_ms: z.number().int().positive().optional(),
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
      return result({ response });
    }),
  );

  server.registerTool(
    "flow_execute_code",
    {
      description: "执行未发布的非脚本 JavaScript。使用当前认证、配额、安全策略和 MCP Web lane；不会把认证信息写入用户脚本输入。",
      inputSchema: {
        code: z.string().min(1).optional(),
        code_base64: z.string().min(1).optional(),
        input: z.unknown().optional(),
        timeout_ms: z.number().int().positive().optional(),
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
