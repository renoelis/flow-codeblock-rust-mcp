#!/usr/bin/env bun

import { createHash, randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { codeWriterContext } from "./code-writer";
import {
  interfaceDocPatchSchema,
  interfaceDocToolInputSchema,
  normalizeInterfaceDocument,
} from "./interface-doc";
import { assertScriptChangeInput } from "./script-change";

const configuredBaseUrl = process.env.FLOW_CODEBLOCK_BASE_URL?.trim();
const accessToken = process.env.FLOW_CODEBLOCK_TOKEN?.trim();
const configuredOwnerName = process.env.FLOW_CODEBLOCK_OWNER_NAME?.trim();
const previewTtlMs = 10 * 60 * 1000;
const requestTimeoutMs = 30_000;

function resolveOwnerName(ownerName: string | undefined): string {
  const resolved = ownerName ?? configuredOwnerName;
  if (!resolved) {
    throw new Error("owner_name is required; provide it in the tool arguments or configure FLOW_CODEBLOCK_OWNER_NAME");
  }
  return resolved;
}

if (!configuredBaseUrl) {
  throw new Error("FLOW_CODEBLOCK_BASE_URL is required; configure https://qingcode.oalite.com or an explicit local Flow Codeblock API URL");
}

let baseUrl: string;
try {
  const parsedBaseUrl = new URL(configuredBaseUrl);
  if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  baseUrl = configuredBaseUrl.replace(/\/+$/, "");
} catch {
  throw new Error("FLOW_CODEBLOCK_BASE_URL must be a valid HTTP(S) URL");
}

if (!accessToken) {
  throw new Error("FLOW_CODEBLOCK_TOKEN is required");
}

if (configuredOwnerName && (configuredOwnerName.length < 1 || configuredOwnerName.length > 64)) {
  throw new Error("FLOW_CODEBLOCK_OWNER_NAME must be 1-64 characters after trimming");
}

const previewStore = new Map<string, { expiresAt: number; fingerprint: string; operation: "create" | "update"; payload: Record<string, unknown> }>();

class ApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Flow-codeblock API returned HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(redactTokenFields(value), null, 2);
}

function scriptUrl(scriptId: string): string {
  return `${baseUrl}/flow/codeblock/${encodeURIComponent(scriptId)}`;
}

function withScriptUrl(value: unknown, fallbackScriptId?: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return value;
  const data = response.data as Record<string, unknown>;
  const scriptId = typeof data.script_id === "string" && data.script_id.length > 0
    ? data.script_id
    : fallbackScriptId;
  if (typeof scriptId !== "string" || scriptId.length === 0) return value;
  return {
    ...response,
    data: {
      ...data,
      script_url: scriptUrl(scriptId),
    },
  };
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: jsonText(value) }] };
}

const sensitiveTokenKeys = new Set([
  "accesstoken",
  "authorization",
  "flowpagesession",
  "flowverifysession",
  "idtoken",
  "qingcodetoken",
  "refreshtoken",
  "token",
  "tokenvalue",
]);

function isSensitiveTokenKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return sensitiveTokenKeys.has(normalized) || normalized.endsWith("token");
}

function redactToken(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= 8) return "***";
    return `${value.slice(0, 4)}***${value.slice(-4)}`;
  }
  if (Array.isArray(value)) return value.map((item) => redactToken(item));
  if (value && typeof value === "object") return redactTokenFields(value);
  return value;
}

function redactTokenFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactTokenFields(item));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      isSensitiveTokenKey(key) ? redactToken(nestedValue) : redactTokenFields(nestedValue),
    ]),
  );
}

function cleanHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const normalized = key.toLowerCase();
    if ([
      "accesstoken",
      "access-token",
      "authorization",
      "cookie",
      "x-csrf-token",
      "x-flow-execution-origin",
      "x-flow-test-tool",
    ].includes(normalized)) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

async function apiRequest(path: string, init: RequestInit = {}, execution = false): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  const headers = new Headers(init.headers);
  headers.set("accessToken", accessToken!);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (execution) headers.set("X-Flow-Execution-Origin", "mcp");
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) throw new ApiError(response.status, payload);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function apiError(error: unknown): never {
  if (error instanceof ApiError) {
    throw new Error(jsonText({ status: error.status, error: error.payload }));
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new Error("Flow-codeblock API request timed out");
  }
  throw error;
}

function encodeCode(code: string | undefined, codeBase64: string | undefined): string {
  if ((code === undefined) === (codeBase64 === undefined)) {
    throw new Error("Provide exactly one of code or code_base64");
  }
  return codeBase64 ?? Buffer.from(code!, "utf8").toString("base64");
}

function compactPatchValidation(value: unknown, patch: unknown, currentVersion?: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) return value;
  const data = response.data as Record<string, unknown>;
  const operations = Array.isArray(patch) ? patch : [];
  return {
    ...response,
    data: {
      ...data,
      interface_doc: undefined,
      interface_doc_patch_summary: {
        operation_count: operations.length,
        paths: operations.flatMap((operation) => {
          if (!operation || typeof operation !== "object" || Array.isArray(operation)) return [];
          const item = operation as Record<string, unknown>;
          const paths = typeof item.path === "string" ? [item.path] : [];
          return typeof item.from === "string" ? [...paths, item.from] : paths;
        }),
        ...(typeof currentVersion === "number" ? {
          expected_version: currentVersion,
          current_version: currentVersion,
        } : {}),
      },
    },
  };
}

function decodeScriptCode(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) return undefined;

  const bytes = Buffer.from(normalized, "base64");
  const canonical = bytes.toString("base64").replace(/=+$/, "");
  if (canonical !== normalized.replace(/=+$/, "")) return undefined;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

const userEnvironmentAccessPattern =
  /\bprocess\s*(?:(?:\?\s*)?\.\s*env\b|(?:\?\s*\.\s*)?\[\s*(["'])env\1\s*\])/;

function assertNoUserEnvironmentAccess(code: string | undefined, codeBase64: string | undefined): void {
  const source = code ?? (codeBase64 === undefined ? undefined : decodeScriptCode(codeBase64));
  if (source !== undefined && userEnvironmentAccessPattern.test(source)) {
    throw new Error(
      "User code must not read process.env or server environment variables; third-party API keys must be supplied by the caller in the request body, query parameters, or business headers and documented in the interface contract",
    );
  }
}

function decodeScriptReadResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const response = payload as Record<string, unknown>;
  const data = response.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return payload;
  const dataRecord = data as Record<string, unknown>;
  const collectionKey = ["data", "scripts"].find((key) => Array.isArray(dataRecord[key]));
  if (!collectionKey) return payload;
  const versions = dataRecord[collectionKey] as unknown[];

  const decodedVersions = versions.map((version) => {
    if (!version || typeof version !== "object" || Array.isArray(version)) return version;
    const versionRecord = version as Record<string, unknown>;
    if (typeof versionRecord.code_base64 !== "string") return version;
    const code = decodeScriptCode(versionRecord.code_base64);
    if (code === undefined) return version;
    const { code_base64: _codeBase64, ...decodedVersion } = versionRecord;
    return { ...decodedVersion, code };
  });

  return { ...response, data: { ...dataRecord, [collectionKey]: decodedVersions } };
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

function fingerprint(operation: "create" | "update", payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ operation, payload })).digest("hex");
}

function purgePreviews(): void {
  const now = Date.now();
  for (const [id, preview] of previewStore) {
    if (preview.expiresAt <= now) previewStore.delete(id);
  }
}

function currentIpWhitelist(script: Record<string, unknown>): unknown {
  const versions = script.data;
  const currentVersion = script.current_version;
  if (!Array.isArray(versions)) return undefined;
  const current = versions.find((version) => (
    version !== null &&
    typeof version === "object" &&
    !Array.isArray(version) &&
    (version as Record<string, unknown>).version === currentVersion
  ));
  if (
    !current ||
    !Object.prototype.hasOwnProperty.call(current, "ip_whitelist")
  ) {
    return undefined;
  }
  return (current as Record<string, unknown>).ip_whitelist;
}

function normalizeComparableIpWhitelist(value: unknown): string[] | undefined {
  if (value === null) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  return value;
}

function ipWhitelistsEqual(current: unknown, submitted: unknown): boolean {
  const currentEntries = normalizeComparableIpWhitelist(current);
  const submittedEntries = normalizeComparableIpWhitelist(submitted);
  return currentEntries !== undefined &&
    submittedEntries !== undefined &&
    currentEntries.length === submittedEntries.length &&
    currentEntries.every((entry, index) => entry === submittedEntries[index]);
}

async function assertUpdateTarget(scriptId: string, expectedVersion: number): Promise<Record<string, unknown>> {
  const response = await apiRequest(`/flow/scripts/${encodeURIComponent(scriptId)}`);
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    throw new Error("Flow-codeblock API returned an invalid script detail response");
  }
  const data = (response as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Flow-codeblock API returned an invalid script detail response");
  }
  const script = data as Record<string, unknown>;
  const currentVersion = script.current_version;
  if (typeof currentVersion !== "number" || !Number.isInteger(currentVersion) || currentVersion <= 0) {
    throw new Error("Flow-codeblock API returned an invalid current script version");
  }
  if (currentVersion !== expectedVersion) {
    throw new ApiError(409, {
      success: false,
      error: {
        type: "VersionConflictError",
        message: "The script version changed; read the script again before previewing",
        details: {
          script_id: scriptId,
          expected_version: expectedVersion,
          current_version: currentVersion,
        },
      },
    });
  }
  return script;
}

async function readCurrentDocumentation(scriptId: string): Promise<unknown> {
  return apiRequest(`/flow/scripts/${encodeURIComponent(scriptId)}/documentation`);
}

async function revalidatePreview(
  operation: "create" | "update",
  payload: Record<string, unknown>,
): Promise<unknown> {
  assertScriptChangeInput({ operation, ...payload });
  if (operation === "update") {
    await assertUpdateTarget(String(payload.script_id), Number(payload.expected_version));
    if (payload.interface_doc_patch !== undefined) {
      await readCurrentDocumentation(String(payload.script_id));
    }
  }
  const hasCode = typeof payload.code_base64 === "string";
  const hasDocument = payload.interface_doc !== undefined && payload.interface_doc !== null;
  const hasPatch = payload.interface_doc_patch !== undefined;
  const hasWhitelist = payload.ip_whitelist !== undefined;
  if (!hasCode && !hasDocument && !hasPatch && !hasWhitelist) return { valid: true, warnings: [] };
  return apiRequest("/flow/scripts/validate", {
    method: "POST",
    body: JSON.stringify({
      ...(hasCode ? { code_base64: payload.code_base64 } : {}),
      ...(operation === "update" ? { script_id: payload.script_id } : {}),
      ...(hasPatch ? { expected_version: payload.expected_version } : {}),
      ...(payload.ip_whitelist !== undefined ? { ip_whitelist: payload.ip_whitelist } : {}),
      ...(hasDocument ? { interface_doc: payload.interface_doc } : {}),
      ...(hasPatch ? { interface_doc_patch: payload.interface_doc_patch } : {}),
    }),
  });
}

const serverInstructions = [
  "Flow Codeblock MCP is self-contained. Before writing code, call flow_write_code and follow the returned authoritative AGENT_PROMPT.md and dangerous-pattern rules.",
  "Use flow_execute_code only when a non-script test or execution is explicitly requested. Use flow_preview_script_change before every script create/update, then call flow_apply_script_change only after the user explicitly confirms the displayed preview.",
  "For current script reads use flow_get_script with only script_id; historical reads require an explicit version from the user or available_versions. Do not guess versions.",
  "The server injects platform authentication from environment variables. Never place platform tokens, cookies, authorization headers, or lock passwords in business code or user code.",
  "MCP does not provide script deletion. Direct the user to the Flow Codeblock web UI or REST API; the current Rust API only exposes direct lock and unlock operations using owner_name and lock_password.",
].join("\n");

const server = new McpServer(
  { name: "flow-codeblock", version: "2.0.0" },
  { instructions: serverInstructions },
);

server.registerTool(
  "flow_write_code",
  {
    title: "Get the Flow JavaScript authoring contract",
    description: "Call this before writing any Flow Codeblock JavaScript. It returns the authoritative AGENT_PROMPT.md, complete dangerous-pattern rules, and mode-specific next steps; this tool never generates, stores, or executes code. Use non_script unless the user requests a persistent script or HTTP redirect; use script for those cases. Set include_full_schema=true only when the complete interface or Patch Schema is required.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      mode: z.enum(["non_script", "script"]).describe(
        "Generation mode. Use non_script when unspecified for immediate, non-persistent execution. Use script for persistent create/update or HTTP redirects and produce a separate interface document.",
      ),
      requirement: z.string().min(1).max(20_000).describe(
        "The complete business requirement, input fields, expected output, external APIs, and edge cases. Script mode does not require a caller domain; publishing uses FLOW_CODEBLOCK_BASE_URL to return script_url. Do not include access tokens.",
      ),
      include_full_schema: z.boolean().optional().describe(
        "Whether to include the complete authoritative script-interface-doc.schema.json object. Omit or set false to save tokens; set true when constructing a complex document field by field.",
      ),
    },
  },
  async ({ mode, requirement, include_full_schema }) => {
    const context = codeWriterContext(mode, requirement, include_full_schema ?? false);
    return result(mode === "non_script"
      ? { ...context, execution_url: `${baseUrl}/flow/codeblock` }
      : context);
  },
);

server.registerTool(
  "flow_list_scripts",
  {
    title: "List scripts",
    description: "Read-only paginated list of scripts owned by the current token. Use it to locate a script by description or script ID and obtain a current-version summary. Omitted parameters use server defaults; call flow_get_script for code, IP allowlists, or the exact current_version.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      page: z.number().int().positive().optional().describe("Page number starting at 1; defaults to page 1."),
      size: z.number().int().min(1).max(100).optional().describe("Items per page, 1-100; defaults to the server value of 20."),
      keyword: z.string().optional().describe("Optional search text matched against script description and script_id."),
      sort: z.enum(["updated_at", "created_at", "executions"]).optional().describe(
        "Sort field: updated_at, created_at, or executions; defaults to updated_at.",
      ),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction; defaults to desc."),
    },
  },
  async ({ page, size, keyword, sort, order }) => {
    try {
      const query = new URLSearchParams();
      if (page !== undefined) query.set("page", String(page));
      if (size !== undefined) query.set("size", String(size));
      if (keyword !== undefined) query.set("keyword", keyword);
      if (sort !== undefined) query.set("sort", sort);
      if (order !== undefined) query.set("order", order);
      const payload = await apiRequest(`/flow/scripts${query.size ? `?${query}` : ""}`);
      return result(decodeScriptReadResponse(payload));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script",
  {
    title: "Get the current script",
    description: "Read the current version of one script, including decoded UTF-8 code, description, IP allowlist, lock state, current_version, and available versions. Pass only script_id; this tool always requests version=0. Before an update, use the returned current_version as expected_version. Use flow_get_script_version for an explicitly requested historical version.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target script ID from flow_list_scripts, a create result, or the user."),
    },
  },
  async ({ script_id }) => {
    try {
      return result(decodeScriptReadResponse(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}?version=0`)));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script_version",
  {
    title: "Get a historical script version",
    description: "Read one explicitly requested historical script version, including decoded UTF-8 code, description, IP allowlist, lock state, current_version, and available versions. Call only when the user requests a specific version; version must come from the user or available_versions and must never be guessed. Historical versions cannot be updated.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target script ID from a script list, current details, or the user."),
      version: z.number().int().positive().describe("Explicit historical version from the user or available_versions; never guess it."),
    },
  },
  async ({ script_id, version }) => {
    try {
      return result(decodeScriptReadResponse(await apiRequest(
        `/flow/scripts/${encodeURIComponent(script_id)}?version=${encodeURIComponent(String(version))}`,
      )));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script_documentation",
  {
    title: "Get the current script interface document",
    description: "Read the script-interface-doc.v1 for the current script version. Pass only script_id; the current document is version-independent. Read it before changing code or documentation and preserve valid fields. document may be null when none is saved; use flow_get_script_documentation_version for history.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target script ID from a script list, a create result, or the user."),
    },
  },
  async ({ script_id }) => {
    try {
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/documentation`));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_get_script_documentation_version",
  {
    title: "Get a historical script interface document",
    description: "Read the script-interface-doc.v1 saved for one explicitly requested historical version. version must come from the user or available_versions and must never be guessed. document may be null when none is saved; historical documents cannot be used for updates.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target script ID from a script list, current details, or the user."),
      version: z.number().int().positive().describe("Explicit historical version from the user or available_versions; never guess it."),
    },
  },
  async ({ script_id, version }) => {
    try {
      return result(await apiRequest(
        `/flow/scripts/${encodeURIComponent(script_id)}/documentation?version=${encodeURIComponent(String(version))}`,
      ));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_lock_script",
  {
    title: "Lock a script",
    description: "Lock an unlocked script directly with its owner name and lock password. Locking prevents edits to code, interface documents, descriptions, IP allowlists, rollback, and deletion until unlock. Call only after the user explicitly requests locking and provides the password.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target script ID from flow_list_scripts, a create result, or the user."),
      owner_name: z.string().trim().min(1).max(64).optional().describe(
        "Displayed script owner name, 1-64 characters after trimming; omit to use FLOW_CODEBLOCK_OWNER_NAME.",
      ),
      lock_password: z.string().min(6).max(128).describe("Lock password, 6-128 UTF-8 bytes; never include it in code or logs."),
    },
  },
  async ({ script_id, owner_name, lock_password }) => {
    try {
      const resolvedOwnerName = resolveOwnerName(owner_name);
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/lock`, {
        method: "POST",
        body: JSON.stringify({ owner_name: resolvedOwnerName, lock_password }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_unlock_script",
  {
    title: "Unlock a script",
    description: "Unlock a locked script directly with the stored owner name and lock password. Unlocking restores editing, rollback, and deletion permissions. Call only after the user explicitly requests unlocking and provides the password.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Target locked script ID from flow_list_scripts, flow_get_script, or the user."),
      owner_name: z.string().trim().min(1).max(64).optional().describe(
        "Stored script owner name, 1-64 characters after trimming; omit to use FLOW_CODEBLOCK_OWNER_NAME.",
      ),
      lock_password: z.string().min(6).max(128).describe("The lock password set for this script, 6-128 UTF-8 bytes; never include it in code or logs."),
    },
  },
  async ({ script_id, owner_name, lock_password }) => {
    try {
      const resolvedOwnerName = resolveOwnerName(owner_name);
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/unlock`, {
        method: "POST",
        body: JSON.stringify({ owner_name: resolvedOwnerName, lock_password }),
      }));
    } catch (error) {
      return apiError(error);
    }
  },
);

const changeSchema = {
  operation: z.enum(["create", "update"]).optional().describe(
    "Prefer explicit operation: create adds a script and update changes an existing script. If omitted, MCP infers create without script_id and update with script_id. Create requires code/code_base64 and a complete interface_doc and forbids script_id/expected_version; update requires script_id/expected_version and exactly one of interface_doc or interface_doc_patch.",
  ),
  script_id: z.string().min(1).optional().describe("Required for update and forbidden for create; target script ID."),
  code: z.string().min(1).optional().describe(
    "UTF-8 JavaScript source, mutually exclusive with code_base64. Script code reads requests from input.query/header/body/cookies and returns a JSON-serializable value with top-level return; it must not read process.env. Third-party API keys must be caller inputs. Code updates require a complete interface_doc or interface_doc_patch.",
  ),
  code_base64: z.string().min(1).optional().describe(
    "Base64-encoded UTF-8 JavaScript, mutually exclusive with code; prefer code when possible. Code updates require a complete interface_doc or interface_doc_patch.",
  ),
  description: z.string().optional().describe(
    "Script list display name/description. For create, summarize to at most 15 characters only when the user did not provide a name; preserve an explicitly supplied longer name. Changing description alone does not create a new version.",
  ),
  ip_whitelist: z.array(z.string()).nullable().optional().describe(
    "Submit only when the user explicitly requests an allowlist change. Array of allowed script IP/CIDR values; omit to keep the current value (server default on create), null or [] to clear, and a non-empty array to set. Omit for documentation-only updates; changing it alone does not create a new version.",
  ),
  interface_doc: interfaceDocToolInputSchema.optional(),
  interface_doc_patch: interfaceDocPatchSchema.optional().describe(
    "RFC 6902 JSON Patch operations for update only. Read the current interface document first and interpret paths against its canonical array indexes. Mutually exclusive with interface_doc and forbidden for create.",
  ),
  responses: z.unknown().optional().describe(
    "Compatibility recovery only: responses misplaced at the tool-argument level are moved to interface_doc.responses. New calls must put them directly in interface_doc.",
  ),
  logic_description: z.unknown().optional().describe(
    "Compatibility recovery only: logic_description misplaced at the tool-argument level is moved to interface_doc.logic_description. New calls must put it directly in interface_doc.",
  ),
  expected_version: z.number().int().nonnegative().optional().describe(
    "Required for update and greater than 0; use the current_version returned by the latest flow_get_script call. A changed version returns 409, so read again and preview again. Omit for create; an accidentally supplied 0 is ignored for compatibility.",
  ),
};

server.registerTool(
  "flow_preview_script_change",
  {
    title: "Preview and validate a script change",
    description: "Required step 1 for every script create or update. It does not write the database or consume execution quota and returns a preview_id valid for 10 minutes. Call flow_write_code(mode=script) first when code and the document contract are not ready. For updates, use interface_doc_patch for field-only changes. The tool performs deterministic normalization and validation; a successful preview_id means normalized content is already stored with preview_ready=true and requires_repreview=false, so do not rewrite or preview again. Create requires code/code_base64 and a complete interface_doc without script_id/expected_version. Update requires a freshly read script_id and expected_version plus at least one change. Keep interface_doc and interface_doc_patch mutually exclusive and omit ip_whitelist for documentation-only updates. Show the successful preview to the user; never publish automatically. MCP does not provide deletion.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: changeSchema,
  },
  async (input) => {
    try {
      purgePreviews();
      const {
        responses: misplacedResponses,
        logic_description: misplacedLogicDescription,
        operation: requestedOperation,
        ...rawChangeInput
      } = input;
      const inputNormalizations: string[] = [];
      const inferredOperation = requestedOperation ?? (rawChangeInput.script_id === undefined ? "create" : "update");
      const changeInput = { ...rawChangeInput, operation: inferredOperation };
      if (requestedOperation === undefined) {
        inputNormalizations.push(
          rawChangeInput.script_id === undefined
            ? "operation omitted; inferred create because script_id was not provided"
            : "operation omitted; inferred update because script_id was provided",
        );
      }
      if (changeInput.operation === "create" && changeInput.expected_version === 0) {
        delete changeInput.expected_version;
        inputNormalizations.push("expected_version=0 was ignored for create; this field applies only to update");
      }
      if (
        changeInput.interface_doc === undefined &&
        (misplacedResponses !== undefined || misplacedLogicDescription !== undefined)
      ) {
        throw new Error("Tool-level responses/logic_description are compatibility fields for an existing interface_doc and cannot replace interface_doc");
      }
      const interfaceDocNormalization = changeInput.interface_doc === undefined
        ? { document: undefined, changes: [], recovered: {} }
        : normalizeInterfaceDocument(changeInput.interface_doc, {
            responses: misplacedResponses,
            logic_description: misplacedLogicDescription,
          });
      if (
        changeInput.ip_whitelist !== undefined &&
        Object.prototype.hasOwnProperty.call(interfaceDocNormalization.recovered, "ip_whitelist")
      ) {
        delete interfaceDocNormalization.recovered.ip_whitelist;
        interfaceDocNormalization.changes.push(
          "interface_doc.ip_whitelist ignored because the tool-level ip_whitelist is present",
        );
      }
      if (
        changeInput.description !== undefined &&
        Object.prototype.hasOwnProperty.call(interfaceDocNormalization.recovered, "description")
      ) {
        delete interfaceDocNormalization.recovered.description;
        interfaceDocNormalization.changes.push(
          "Misplaced interface_doc.description ignored because the tool-level description is present",
        );
      }
      const preparedInput = changeInput.interface_doc === undefined
        ? changeInput
        : {
            ...changeInput,
            ...(Object.prototype.hasOwnProperty.call(interfaceDocNormalization.recovered, "description")
              ? { description: interfaceDocNormalization.recovered.description }
              : {}),
            ...(Object.prototype.hasOwnProperty.call(interfaceDocNormalization.recovered, "ip_whitelist")
              ? { ip_whitelist: interfaceDocNormalization.recovered.ip_whitelist }
              : {}),
            interface_doc: interfaceDocNormalization.document,
          };
      try {
        assertNoUserEnvironmentAccess(preparedInput.code, preparedInput.code_base64);
        assertScriptChangeInput(preparedInput);
      } catch (error) {
        const normalizations = [...inputNormalizations, ...interfaceDocNormalization.changes];
        if (error instanceof Error && normalizations.length > 0) {
          throw new Error(
            `${error.message}\nAutomatic normalizations applied in this call:\n- ${normalizations.join("\n- ")}`,
          );
        }
        throw error;
      }
      const effectiveInput = { ...preparedInput };
      const ignoredChanges: string[] = [];
      let currentVersion: number | undefined;
      if (effectiveInput.operation === "update") {
        const currentScript = await assertUpdateTarget(effectiveInput.script_id!, effectiveInput.expected_version!);
        currentVersion = currentScript.current_version as number;
        if (effectiveInput.interface_doc_patch !== undefined) {
          await readCurrentDocumentation(effectiveInput.script_id!);
        }
        if (
          effectiveInput.ip_whitelist !== undefined &&
          ipWhitelistsEqual(currentIpWhitelist(currentScript), effectiveInput.ip_whitelist)
        ) {
          delete effectiveInput.ip_whitelist;
          ignoredChanges.push("ip_whitelist matches the current value and was omitted from this change");
          assertScriptChangeInput(effectiveInput);
        }
      }
      const hasCode = effectiveInput.code !== undefined || effectiveInput.code_base64 !== undefined;
      const codeBase64 = hasCode ? encodeCode(effectiveInput.code, effectiveInput.code_base64) : undefined;
      const hasInterfaceDocPatch = effectiveInput.interface_doc_patch !== undefined;
      const validation = hasCode || effectiveInput.interface_doc !== undefined || hasInterfaceDocPatch || effectiveInput.ip_whitelist !== undefined
        ? await apiRequest("/flow/scripts/validate", {
            method: "POST",
            body: JSON.stringify({
              ...(codeBase64 !== undefined ? { code_base64: codeBase64 } : {}),
              ...(effectiveInput.operation === "update" ? { script_id: effectiveInput.script_id } : {}),
              ...(hasInterfaceDocPatch ? { expected_version: effectiveInput.expected_version } : {}),
              ...(effectiveInput.ip_whitelist !== undefined ? { ip_whitelist: effectiveInput.ip_whitelist } : {}),
              ...(effectiveInput.interface_doc !== undefined ? { interface_doc: effectiveInput.interface_doc } : {}),
              ...(hasInterfaceDocPatch ? { interface_doc_patch: effectiveInput.interface_doc_patch } : {}),
            }),
          })
        : { valid: true, warnings: [], message: "No code or interface document submitted; only description/IP allowlist will be updated" };
      const previewValidation = hasInterfaceDocPatch
        ? compactPatchValidation(validation, effectiveInput.interface_doc_patch, currentVersion)
        : validation;
      const payload: Record<string, unknown> = {
        ...(effectiveInput.operation === "update" ? { script_id: effectiveInput.script_id, expected_version: effectiveInput.expected_version } : {}),
        ...(codeBase64 !== undefined ? { code_base64: codeBase64 } : {}),
        ...(effectiveInput.description !== undefined ? { description: effectiveInput.description } : {}),
        ...(effectiveInput.ip_whitelist !== undefined ? { ip_whitelist: effectiveInput.ip_whitelist } : {}),
        ...(effectiveInput.interface_doc !== undefined ? { interface_doc: effectiveInput.interface_doc } : {}),
        ...(hasInterfaceDocPatch ? { interface_doc_patch: effectiveInput.interface_doc_patch } : {}),
      };
      const previewId = randomUUID();
      const storedPayload = effectiveInput.operation === "create" && effectiveInput.interface_doc !== undefined
        ? { ...payload, interface_doc: removeCreatePath(effectiveInput.interface_doc) }
        : payload;
      const preview = {
        preview_id: previewId,
        preview_ready: true,
        requires_repreview: false,
        operation: effectiveInput.operation,
        expires_at: new Date(Date.now() + previewTtlMs).toISOString(),
        validation: previewValidation,
        ...(inputNormalizations.length > 0 ? { input_normalizations: inputNormalizations } : {}),
        ...(interfaceDocNormalization.changes.length > 0
          ? { interface_doc_normalizations: interfaceDocNormalization.changes }
          : {}),
        ...(ignoredChanges.length > 0 ? { ignored_changes: ignoredChanges } : {}),
        changes: {
          code: codeBase64 === undefined ? false : effectiveInput.code !== undefined ? "provided" : "base64 provided",
          description: effectiveInput.description !== undefined,
          ip_whitelist: effectiveInput.ip_whitelist !== undefined,
          interface_doc: effectiveInput.interface_doc !== undefined
            ? true
            : hasInterfaceDocPatch
              ? "patch"
              : false,
          interface_doc_patch: hasInterfaceDocPatch,
        },
      };
      previewStore.set(previewId, {
        expiresAt: Date.now() + previewTtlMs,
        fingerprint: fingerprint(effectiveInput.operation, storedPayload),
        operation: effectiveInput.operation,
        payload: storedPayload,
      });
      return result(preview);
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_apply_script_change",
  {
    title: "Confirm and apply a script change",
    description: "Step 2 for a script change. Call only after flow_preview_script_change succeeded, the preview was shown, and the user explicitly confirmed publication. Pass the same preview_id from this MCP process (valid for 10 minutes) and confirm=true. Content, update version, expiration, 404, lock, and 409 checks are repeated; failures require a fresh read and preview. On success, create or atomically update the script and return data.script_url built from FLOW_CODEBLOCK_BASE_URL. This tool cannot delete scripts or infer publication confirmation from the original request.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      preview_id: z.string().uuid().describe("preview_id from a successful flow_preview_script_change call; valid for 10 minutes in this MCP process."),
      confirm: z.literal(true).describe("Must be true and submitted only after the user has viewed and explicitly confirmed the preview."),
    },
  },
  async ({ preview_id }) => {
    try {
      purgePreviews();
      const preview = previewStore.get(preview_id);
      if (!preview) throw new Error("Preview is missing or expired");
      const currentFingerprint = fingerprint(preview.operation, preview.payload);
      if (currentFingerprint !== preview.fingerprint) throw new Error("Preview contents changed");
      await revalidatePreview(preview.operation, preview.payload);
      const path = preview.operation === "create"
        ? "/flow/scripts"
        : `/flow/scripts/${encodeURIComponent(String(preview.payload.script_id))}`;
      const body = { ...preview.payload };
      delete body.script_id;
      delete body.expected_version;
      const response = await apiRequest(path, {
        method: preview.operation === "create" ? "POST" : "PUT",
        body: JSON.stringify(preview.operation === "update"
          ? { ...body, expected_version: preview.payload.expected_version }
          : body),
      });
      previewStore.delete(preview_id);
      return result(withScriptUrl(response, preview.payload.script_id));
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_execute_script",
  {
    title: "Execute a published script",
    description: "Call a published script with GET or POST for a real test or business execution and return its complete script_url. Prefer flow_get_script_documentation first and follow it exactly. POST body is the caller's business JSON and must not be wrapped in input or body; query and headers are caller inputs. Do not pass platform accessToken, Cookie, CSRF, or x-flow-* headers; MCP injects platform authentication. Each call consumes quota and is rate-limited, audited, and executed in the Web worker lane. Call only when execution or testing is requested.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      script_id: z.string().min(1).describe("Published script ID to execute."),
      method: z.enum(["GET", "POST"]).default("POST").describe("HTTP method supported by the script interface document; defaults to POST."),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe(
        "Caller URL query parameters; values may be strings, numbers, or booleans. Do not include qingcodeToken; use timeout_ms for timeouts.",
      ),
      headers: z.record(z.string(), z.string()).optional().describe(
        "Caller business request headers. Do not include accessToken, Authorization, Cookie, CSRF, or internal x-flow-* headers; they are filtered.",
      ),
      body: z.unknown().optional().describe(
        "Caller business JSON for POST only; it must match the interface document. Pass the business object directly without input, input.body, or body wrapping; omit for GET.",
      ),
      timeout_ms: z.number().int().positive().optional().describe("Optional script execution timeout in milliseconds, still subject to server limits."),
    },
  },
  async ({ script_id, method, query, headers, body, timeout_ms }) => {
    try {
      const url = new URL(`${baseUrl}/flow/codeblock/${encodeURIComponent(script_id)}`);
      for (const [key, value] of Object.entries(query ?? {})) {
        if (key.toLowerCase() === "qingcodetoken") {
          throw new Error("qingcodeToken is not accepted by the MCP execution tool; configure FLOW_CODEBLOCK_TOKEN");
        }
        if (key.toLowerCase() === "qingcodetimeout") {
          throw new Error("Use timeout_ms instead of qingcodeTimeout");
        }
        url.searchParams.set(key, String(value));
      }
      if (timeout_ms !== undefined) url.searchParams.set("qingcodeTimeout", String(timeout_ms));
      const safeHeaders = cleanHeaders(headers);
      const response = await apiRequest(url.pathname + url.search, {
        method,
        headers: safeHeaders,
        body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
      }, true);
      return result({
        script_url: scriptUrl(script_id),
        quota_notice: "This execution was handled as a normal request and consumed quota.",
        response,
      });
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_execute_code",
  {
    title: "Execute non-script JavaScript",
    description: "Execute non-script JavaScript once without saving it and return the complete execution_url built from FLOW_CODEBLOCK_BASE_URL. Generate the code using flow_write_code(mode=non_script): read business data and third-party keys from global input, never process.env, and return a JSON-serializable value with top-level return. Provide exactly one of code or code_base64. Execution consumes quota and is rate-limited, security-checked, audited, and run in the Web worker lane. Do not call for code-only requests; call only when testing or execution is explicitly requested.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      code: z.string().min(1).optional().describe("UTF-8 JavaScript source, mutually exclusive with code_base64; prefer direct code."),
      code_base64: z.string().min(1).optional().describe("Base64-encoded UTF-8 JavaScript, mutually exclusive with code."),
      input: z.unknown().optional().describe("Business input copied to global input; defaults to {}. Do not wrap it as {input: ...}."),
      timeout_ms: z.number().int().positive().optional().describe("Optional execution timeout in milliseconds, still subject to server limits."),
    },
  },
  async ({ code, code_base64, input: executionInput, timeout_ms }) => {
    try {
      assertNoUserEnvironmentAccess(code, code_base64);
      const payload = {
        codebase64: encodeCode(code, code_base64),
        input: executionInput ?? {},
        ...(timeout_ms === undefined ? {} : { qingcodeTimeout: timeout_ms }),
      };
      const response = await apiRequest("/flow/codeblock", {
        method: "POST",
        body: JSON.stringify(payload),
      }, true);
      return result({
        mode: "non_script",
        execution_url: `${baseUrl}/flow/codeblock`,
        quota_notice: "This non-script execution was handled as a normal request and consumed quota.",
        response,
      });
    } catch (error) {
      return apiError(error);
    }
  },
);

server.registerTool(
  "flow_script_stats",
  {
    title: "Get script execution statistics",
    description: "Read-only execution statistics for one script owned by the current token. Use either date for one day or start_date and end_date together for a range; omit all three for the most recent 7 days. Dates use YYYY-MM-DD.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      script_id: z.string().min(1).describe("Script ID whose statistics should be queried."),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Single-day date, YYYY-MM-DD; do not combine with start_date/end_date."),
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Range start date, YYYY-MM-DD; must be paired with end_date."),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Range end date, YYYY-MM-DD; must be paired with start_date."),
    },
  },
  async ({ script_id, date, start_date, end_date }) => {
    try {
      const query = new URLSearchParams();
      if (date !== undefined) query.set("date", date);
      if (start_date !== undefined) query.set("start_date", start_date);
      if (end_date !== undefined) query.set("end_date", end_date);
      return result(await apiRequest(`/flow/scripts/${encodeURIComponent(script_id)}/stats${query.size ? `?${query}` : ""}`));
    } catch (error) {
      return apiError(error);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
