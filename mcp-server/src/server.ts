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
  interfaceDocToolInputSchema,
  normalizeInterfaceDocument,
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
  "This is the Flow Codeblock Rust+Bun MCP server. All tools except flow_write_code call the server-side REST API; flow_write_code returns an authoring contract only. Do not guess REST paths or put MCP credentials in business arguments.",
  "User code runs in a server-side Bun async function context with modern JavaScript, async/await, Promises, arrow functions, and top-level return. Default limits are 100 ms minimum timeout, 15,000 ms maximum timeout, 65,535 code bytes, 2 MiB input, and 10 MiB result.",
  "User-code execution failures preserve the server error type, concise message, and stack when available. Verified source locations are in error.details with one-based line, column, and lineContent; details are omitted when the location cannot be verified. Security-policy messages contain the rule reason only; do not parse source locations from message or expect duplicated location text. Direct execution uses SyntaxError for parse failures and SecurityError for execution policy failures; these user-code failures are non-retryable HTTP 422 responses. Script-save validation may retain ValidationError for policy failures.",
  "Tool routing: flow_write_code only generates code and its contract; flow_execute_code tests unpublished generated code; flow_execute_script runs published scripts. When the generated code and available safe input are sufficient for a meaningful runtime test, execute it immediately without waiting for user confirmation. If required input or credentials are missing, report that runtime verification was not performed instead of inventing them.",
  "Script workflow: read the current version with flow_get_script before updates; creates require a complete interface_doc, while code or document updates may use a complete interface_doc or an RFC 6902 interface_doc_patch (never both, and patches require expected_version). Preview with flow_preview_script_change, then call flow_apply_script_change(confirm=true) only after explicit user confirmation. Documentation-only changes use flow_preview_script_documentation -> flow_apply_script_documentation.",
  "Script-mode generation and creation require a non-empty description of at most 20 Unicode characters; provide it in flow_write_code.description and flow_preview_script_change.description. API timestamp, created_at, updated_at, and locked_at fields use Asia/Shanghai (UTC+08:00).",
  "Preview IDs are single-use and time-limited. On a version conflict, expired preview, or validation failure, stop, read again, and preview again; never retry an old preview_id. Every flow_apply_* call requires confirm=true.",
  "Interface-document validation reports every discovered nested schema issue in one response; fix the complete list before making another preview call.",
  "script-interface-doc.v1 requires schema_version, title, summary, endpoint, request, responses, and logic_description. endpoint requires methods and description; request.query and request.headers are required arrays (use [] when empty); POST requires request.body and GET-only documents must omit it. JSON Patch supports at most 256 add/remove/replace/move/copy/test operations; preview responses show operation counts and paths, not merged documents.",
  "Every query parameter and request header requires name, type, required, description, and example. Request bodies and responses require content_type=application/json, schema, and example; every response also requires status and description. Every root JSON Schema node declares type; every nested property, array item, and object-form additionalProperties node declares type, description, and example. Arrays must define items, fixed object properties must be covered by the complete example, and additionalProperties=true is reserved for opaque upstream JSON.",
  "Keep endpoint.path relative and omit it on create; on update MCP canonicalizes it to /flow/codeblock/<actual-script-id> from script_id. Public call URLs use the caller-provided domain plus /flow/codeblock/{{script_id}}; never put real tokens, passwords, cookies, or Authorization values in code, documents, examples, or URLs.",
  "Execution input differs by mode: flow_execute_code uses body.input unchanged as the direct business object; published /flow/codeblock/{script_id} always injects an envelope with business body at input.body, query parameters at input.query, headers at input.header, and cookies at input.cookies when present. Script code must never read business fields as input.<field>; use const envelope = input || {}; const payload = envelope.body && typeof envelope.body === \"object\" && !Array.isArray(envelope.body) ? envelope.body : {};. Treat input as a reserved, read-only runtime binding: never declare, redeclare, rebind, or destructure a local binding named input in any scope, including function parameters and nested callbacks. Use top-level return by default; use a bare qf_output assignment only for event-style/asynchronous flows or when explicitly requested, never both.",
  "For every initial generation and every later revision in non-script mode, final delivery always includes the complete latest generated JavaScript, even after runtime verification; never return only a patch, diff, or partial snippet. Also include caller-facing invocation instructions, parameters/examples, logic, success/error examples, and execution_url. Script delivery omits JavaScript and raw interface_doc by default and includes invocation instructions, parameters/examples, logic, success/error examples, and the published script_url unless the user asks for source or raw documentation. Code and interface_doc remain internal preview/validation/publication inputs.",
  "Prefer native JavaScript, URL/URLSearchParams, Bun-native fetch, and node:crypto; crypto-js has been removed. Treat every forbidden identifier as forbidden in every syntactic position, including property names and method calls. Never generate RegExp.exec or .exec(...); use text.match(regex) for capture groups or regex.test(text) for boolean checks. Before execution, review the complete source and rewrite every forbidden identifier, member, or module. Do not generate browser APIs, timers, dynamic module loading, constructor-based code generation, or blacklisted Node modules (including fs/node:fs). Excel imports are limited to read-excel-file/node, read-excel-file/universal, write-excel-file/node, write-excel-file/universal, and write-excel-file/utility. Check HTTP status and handle JSON, text, and empty responses; await or return every async task.",
  "Script execution accepts only GET or POST. MCP authentication, cookies, CSRF, proxy-source headers, and test-tool markers are filtered. There is no script deletion, emergency unlock, or arbitrary HTTP proxy tool; direct those requests to the web UI or controlled REST/operations flow.",
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

function canonicalizeInterfaceDocument(
  document: unknown,
  operation: "create" | "update",
  scriptId?: string,
): unknown {
  const normalized = normalizeInterfaceDocument(document);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized;
  const endpoint = (normalized as Record<string, unknown>).endpoint;
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)) return normalized;
  if (operation === "create") {
    delete (endpoint as Record<string, unknown>).path;
  } else if (scriptId) {
    (endpoint as Record<string, unknown>).path = `/flow/codeblock/${scriptId}`;
  }
  return normalized;
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
  document: interfaceDocToolInputSchema.optional().describe(`Normalized script-interface-doc.v1 JSON object. Choose exactly one of document, raw_document, or document_patch; complete documents are required for saves and code updates. ${interfaceDocInputDescription}`),
  raw_document: z.string().optional().describe("JSON/OpenAPI document text for server parsing. Choose exactly one of document, raw_document, or document_patch; format=json parses JSON."),
  format: z.literal("json").optional().describe("Format of raw_document; only json is supported."),
  document_patch: interfaceDocPatchSchema.optional().describe("RFC 6902 patch for an existing script only. Choose exactly one of document, raw_document, or document_patch."),
  expected_version: z.number().int().positive().optional().describe("Current script version for a patch; required with document_patch and must come from a fresh current-version read."),
};

const scriptDescriptionSchema = z.string()
  .trim()
  .min(1)
  .max(20, "Script description must be 1-20 characters")
  .refine((value) => [...value].length <= 20, "Script description must be 1-20 characters")
  .describe("Short script description shown in script lists; required on create and limited to 20 characters.");

const changeSchema = z.object({
  operation: z.enum(["create", "update"]).describe("create adds a script; update changes an existing script."),
  script_id: z.string().min(1).optional().describe("Target script ID for update; forbidden for create."),
  code: z.string().optional().describe("UTF-8 JavaScript source, mutually exclusive with code_base64. Required when creating or changing code; provide executable JavaScript only."),
  code_base64: z.string().optional().describe("Non-empty Base64-encoded JavaScript, mutually exclusive with code."),
  description: scriptDescriptionSchema.optional().describe("Short script description shown in script lists; required on create and limited to 20 characters."),
  ip_whitelist: z.array(z.string()).nullable().optional().describe("Source IP/CIDR allowlist. Omit on update to keep the current value; null or [] clears the restriction."),
  interface_doc: interfaceDocToolInputSchema.optional().describe(interfaceDocInputDescription),
  interface_doc_patch: interfaceDocPatchSchema.optional().describe("RFC 6902 patch for update only; mutually exclusive with interface_doc and forbidden for create."),
  rollback_to_version: z.number().int().positive().optional().describe("Historical version to restore. Use only as a standalone update and never with code, interface_doc, or interface_doc_patch."),
  expected_version: z.number().int().positive().optional().describe("Required for update and must be the current_version from flow_get_script for concurrency protection; forbidden for create."),
});

const documentationSchema = z.object({
  script_id: z.string().min(1).describe("Target script ID, not a full URL; validate or preview its documentation."),
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
    if (input.description === undefined) throw new Error("Create preview requires a script description of 1-20 characters");
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
    input.interface_doc = canonicalizeInterfaceDocument(input.interface_doc, input.operation, input.script_id);
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
    { name: "flow-codeblock-rust", version: "0.1.14" },
    { instructions: serverInstructions },
  );

  server.registerTool(
    "flow_write_code",
    {
      title: "Get the Flow JavaScript authoring contract",
      description: "Call this before writing or revising Flow Codeblock JavaScript. It returns the mode-specific authoring contract, including forbidden-identifier and reserved-input replacement rules, and never writes the database, publishes a script, or executes code. Script mode requires a non-empty description of at most 20 Unicode characters. For every non_script generation or revision, always deliver the complete latest generated JavaScript plus execution_url, never only a patch or partial snippet; use script for persistent GET/POST /flow/codeblock/{{script_id}} code with a complete script-interface-doc.v1 for preview, validation, and publication. Script delivery includes invocation instructions, parameters/examples, logic, success/error examples, and script_url rather than source or raw interface_doc unless requested. Set base_url only when a caller-facing URL template is needed.",
      inputSchema: {
        mode: z.enum(["non_script", "script"]).describe("Generation mode. Use non_script for immediate, non-persistent execution; use script for a persistent GET/POST endpoint or HTTP redirects."),
        requirement: z.string().min(1).max(20_000).describe("Complete business requirements, input fields, expected output, external APIs, synchronization/async needs, and error behavior. Include only requirements relevant to this code."),
        description: scriptDescriptionSchema.optional(),
        input_example: z.unknown().optional().describe("Business input example. In script mode it helps generate request.body/schema/example; in non_script mode it supplies flow_execute_code test input. Never include real credentials."),
        include_full_schema: z.boolean().optional().describe("Whether to include the complete recursive JSON Schema in the response; defaults to true for script mode to avoid a follow-up schema call. Set false only when the caller already has the schema."),
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
          .describe("Optional caller service origin such as https://flow.example.com. Used only to render /flow/codeblock/{{script_id}}; credentials and control characters are forbidden."),
      },
    },
    async ({ mode, requirement, description, input_example, include_full_schema, base_url }) => {
      if (mode === "script" && description === undefined) {
        throw new Error("Script mode requires a description of 1-20 characters");
      }
      const context = codeWriterContext(mode, requirement, input_example, include_full_schema ?? mode === "script", base_url, description);
      return result(mode === "non_script" ? { ...context, execution_url: executionUrl(api) } : context);
    },
  );

  server.registerTool(
    "flow_list_scripts",
    {
      title: "List scripts",
      description: "Read-only paginated script listing. Use page/size offset pagination by default, or pagination=cursor for sequential traversal (omit cursor on the first call and use the returned cursor afterward). This tool does not create, update, or execute scripts.",
      inputSchema: {
        page: z.number().int().positive().optional().describe("Offset page number starting at 1; omit when using cursor pagination."),
        size: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100; the server supplies the default."),
        keyword: z.string().optional().describe("Optional keyword filter for scripts."),
        sort: z.enum(["updated_at", "created_at", "code_length", "version"]).optional().describe("Sort field; cursor pagination supports updated_at, created_at, and code_length."),
        order: z.enum(["asc", "desc"]).optional().describe("Sort direction; the server supplies the default."),
        pagination: z.literal("cursor").optional().describe("Set to cursor to enable cursor pagination; omit cursor on the first call."),
        cursor: z.string().optional().describe("Cursor returned by the previous page; use only with pagination=cursor."),
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
      title: "Get a script",
      description: "Read-only script code, metadata, and version information. Call this before updates and use the returned current_version as flow_preview_script_change.expected_version.",
      inputSchema: {
        script_id: z.string().min(1).describe("Script ID, not a full URL."),
        version: z.number().int().min(0).optional().describe("Optional historical version; omit to read the current version."),
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
      title: "Get script interface documentation",
      description: "Read-only script-interface-doc.v1 documentation for the current or a specified historical version. Read the current version before changing documentation and keep its version information.",
      inputSchema: {
        script_id: z.string().min(1).describe("Script ID, not a full URL."),
        version: z.number().int().min(0).optional().describe("Optional historical version; omit to read the current document."),
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
      title: "Validate script interface documentation",
      description: "Read-only validation and normalization for a script-interface-doc.v1 document; this tool never writes to the database. Provide exactly one of document, raw_document, or an RFC 6902 document_patch. Patches require expected_version, and this response cannot be used as publication confirmation.",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      if (parsed.document !== undefined) {
        parsed.document = canonicalizeInterfaceDocument(parsed.document, "update", parsed.script_id);
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
      title: "Preview script change",
      description: "Preview a script create or update without writing to the database. A create requires code or code_base64, a non-empty description of at most 20 Unicode characters, and a complete interface_doc; it must not include script_id or expected_version. An update requires script_id and a freshly read expected_version; changing code also requires a complete interface_doc or interface_doc_patch. After a successful preview, call flow_apply_script_change(confirm=true) only after explicit user confirmation.",
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
          ? { interface_doc: parsed.interface_doc }
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
      title: "Apply previewed script change",
      description: "Apply the single-use preview_id returned by flow_preview_script_change. confirm=true is required; the tool rechecks the current version and destroys the preview after success or failure. A successful publication returns a complete script_url built from FLOW_CODEBLOCK_BASE_URL. Script deletion is not supported. On a version conflict, read the script and preview again.",
      inputSchema: {
        preview_id: z.string().uuid().describe("UUID returned by the latest script-change preview; expired or already applied IDs cannot be reused."),
        confirm: z.literal(true).describe("Must be true to confirm that the user explicitly approved the write."),
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
      title: "Preview documentation change",
      description: "Preview a script-interface-doc.v1 save without writing to the database. Read the script's current version first. Provide exactly one of document, raw_document, or document_patch; patches require expected_version and complete documents must include every required field. After a successful preview, only flow_apply_script_documentation(confirm=true) can write the change.",
      inputSchema: documentationSchema.shape,
    },
    withApiErrors(async (input) => {
      const parsed = documentationSchema.parse(input);
      if (parsed.document !== undefined) {
        parsed.document = canonicalizeInterfaceDocument(parsed.document, "update", parsed.script_id);
        assertCompleteInterfaceDoc(parsed.document, "update");
      }
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
      title: "Apply previewed documentation change",
      description: "Apply the single-use preview returned by flow_preview_script_documentation. confirm=true is required; the tool rechecks the script version and destroys the preview after success or failure. A successful save returns a complete script_url. On a version conflict, read the script and preview again.",
      inputSchema: {
        preview_id: z.string().uuid().describe("UUID returned by the latest documentation preview; expired or already applied IDs cannot be reused."),
        confirm: z.literal(true).describe("Must be true to confirm that the user explicitly approved the write."),
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
    script_id: z.string().min(1).describe("Script ID to lock or unlock."),
    owner_name: z.string().min(1).describe("Owner name to set when locking and verify when unlocking."),
    lock_password: z.string().min(6).describe("Lock password; sent only to the server and never stored in MCP previews or logs."),
    confirm: z.literal(true).describe("Must be true to confirm that the user explicitly approved locking or unlocking."),
  };

  server.registerTool(
    "flow_lock_script",
    { title: "Lock script", description: "Lock a script to prevent concurrent writes. confirm=true is required; the lock password is never stored by MCP. Script changes and documentation saves may be rejected while the script is locked.", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/lock`, { owner_name, lock_password }))),
  );

  server.registerTool(
    "flow_unlock_script",
    { title: "Unlock script", description: "Unlock a script using its owner name and password. confirm=true is required; the lock password is never stored by MCP. Emergency recovery unlock is not provided.", inputSchema: lockSchema },
    withApiErrors(async ({ script_id, owner_name, lock_password }) =>
      result(await api.post(`/flow/scripts/${encodedScriptId(script_id)}/unlock`, { owner_name, lock_password }))),
  );

  const queryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))]);
  server.registerTool(
    "flow_execute_script",
    {
      title: "Execute published script",
      description: "Execute a published script when requested or when the available safe input is sufficient to verify newly generated code; execution-only verification does not require user confirmation. method must be GET or POST; the result includes a complete script_url built from FLOW_CODEBLOCK_BASE_URL and script_id. A POST body is sent directly and is exposed to script code at input.body; query, header, and cookie values are exposed at input.query, input.header, and input.cookies. User-code failures preserve verified error.details source locations when available. MCP authentication, cookies, CSRF, proxy-source headers, and test-tool markers are filtered; qingcodeToken and qingcodeTimeout cannot be supplied as business parameters.",
      inputSchema: {
        script_id: z.string().min(1).describe("Published script ID; the tool calls /flow/codeblock/{script_id}."),
        method: z.enum(["GET", "POST"]).default("POST").describe("Script request method, either GET or POST; defaults to POST."),
        query: z.record(z.string(), queryValueSchema).optional().describe("Business query parameters. Values may be string/number/boolean or arrays of those types; arrays become repeated query parameters. Do not send qingcodeToken or qingcodeTimeout."),
        headers: z.record(z.string(), z.string()).optional().describe("Business request headers. Authentication, cookies, CSRF, Forwarded, X-Real-IP, and other reserved headers are filtered."),
        body: z.unknown().optional().describe("POST JSON request body; GET requests do not send a body. Do not wrap script-mode business data as input or input.body."),
        timeout_ms: z.number().int().positive().optional().describe("Execution timeout in milliseconds; configure it only with this field, never with qingcodeTimeout in query."),
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
      title: "Execute unpublished code",
      description: "Execute unpublished generated JavaScript when requested or when the available safe input is sufficient for a meaningful runtime test; execution-only verification does not require user confirmation. The result includes a complete execution_url. The request is always POST /flow/codeblock, and body.input is injected unchanged as global input; input is a reserved runtime binding and generated code must never declare, rebind, or shadow it; use an alias such as const payload = input. Provide exactly one of code or code_base64. User-code failures preserve verified error.details source locations when available. MCP authentication is never written into user input, and this tool does not create or publish scripts.",
      inputSchema: {
        code: z.string().min(1).optional().describe("UTF-8 JavaScript source, mutually exclusive with code_base64."),
        code_base64: z.string().min(1).optional().describe("Non-empty Base64-encoded JavaScript source, mutually exclusive with code."),
        input: z.unknown().optional().describe("Business data injected into global input; defaults to {}. Do not include tokens, passwords, cookies, or Authorization values. In generated code, input is a reserved binding; never declare, rebind, or shadow it."),
        timeout_ms: z.number().int().positive().optional().describe("Test execution timeout in milliseconds; it must be within the server's allowed range."),
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
