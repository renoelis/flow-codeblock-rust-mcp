import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";

const expectedToolNames = [
  "flow_apply_script_change",
  "flow_execute_code",
  "flow_execute_script",
  "flow_get_script",
  "flow_get_script_documentation",
  "flow_get_script_documentation_version",
  "flow_get_script_version",
  "flow_list_scripts",
  "flow_lock_script",
  "flow_preview_script_change",
  "flow_script_stats",
  "flow_unlock_script",
  "flow_write_code",
];

const client = new Client({ name: "flow-codeblock-metadata-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: "http://127.0.0.1:1",
    FLOW_CODEBLOCK_TOKEN: "flow_metadata_test",
  },
  stderr: "pipe",
});

let tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];

beforeAll(async () => {
  await client.connect(transport);
  tools = (await client.listTools()).tools;
});

afterAll(async () => {
  await client.close();
});

describe("MCP tool metadata", () => {
  test("publishes standalone server instructions and the complete safe tool set", () => {
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toContain("self-contained");
    expect(instructions).toContain("Use flow_preview_script_change before every script create/update");
    expect(instructions).toContain("MCP does not provide script deletion");
    expect(instructions).toContain("Do not guess versions");
    expect(instructions).toContain("platform tokens");
    expect(tools.map((tool) => tool.name).sort()).toEqual(expectedToolNames);
    expect(tools.some((tool) => tool.name.includes("delete"))).toBe(false);
  });

  test("every tool and exposed argument has an LLM-visible description", () => {
    for (const tool of tools) {
      expect(tool.title?.trim().length, `${tool.name} title`).toBeGreaterThan(0);
      expect(tool.description?.trim().length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.annotations, `${tool.name} annotations`).toBeDefined();

      const properties = tool.inputSchema.properties ?? {};
      for (const [name, schema] of Object.entries(properties)) {
        const description = (schema as { description?: unknown }).description;
        expect(typeof description, `${tool.name}.${name} description type`).toBe("string");
        expect(String(description).trim().length, `${tool.name}.${name} description`).toBeGreaterThan(10);
      }
    }
  });

  test("keeps published static metadata and documentation in English", async () => {
    const cjkPattern = /[\u3400-\u9fff]/;
    const visit = (value: unknown, path: string): void => {
      if (typeof value === "string") {
        expect(cjkPattern.test(value), path).toBe(false);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    };

    tools.forEach((tool) => visit(tool, `tool:${tool.name}`));
    const root = join(import.meta.dir, "../..");
    for (const relativePath of [
      "README.md",
      ".mcp.json",
      "skills/flow-codeblock/SKILL.md",
      "skills/flow-codeblock/references/AGENT_PROMPT.md",
      "skills/flow-codeblock/references/api.md",
      "skills/flow-codeblock/references/dangerous_patterns.json",
      "skills/flow-codeblock/references/module_blacklist.json",
      "skills/flow-codeblock/references/script-interface-doc.schema.json",
      "skills/flow-codeblock/references/script-interface-doc.patch.schema.json",
    ]) {
      const content = await Bun.file(join(root, relativePath)).text();
      expect(cjkPattern.test(content), relativePath).toBe(false);
    }
  });

  test("publishes direct password-based lock and unlock inputs", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const toolName of ["flow_lock_script", "flow_unlock_script"] as const) {
      const tool = byName.get(toolName);
      expect(tool?.inputSchema.required ?? [], `${toolName}.lock_password required`).toContain("lock_password");
      expect(tool?.inputSchema.required ?? [], `${toolName}.owner_name required`).not.toContain("owner_name");
      expect(tool?.inputSchema.properties?.lock_password?.minLength, `${toolName}.lock_password minLength`).toBe(6);
      expect(tool?.inputSchema.properties?.lock_password?.maxLength, `${toolName}.lock_password maxLength`).toBe(128);
      expect(tool?.inputSchema.properties?.owner_name?.maxLength, `${toolName}.owner_name maxLength`).toBe(64);
      expect(tool?.inputSchema.properties?.owner_name?.description, `${toolName}.owner_name description`)
        .toContain("FLOW_CODEBLOCK_OWNER_NAME");
    }
  });

  test("avoids propertyNames in the structured interface document schema", () => {
    function visit(value: unknown, path: string): void {
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, `${path}[${index}]`));
        return;
      }
      if (typeof value !== "object" || value === null) return;
      expect(Object.prototype.hasOwnProperty.call(value, "propertyNames"), path).toBe(false);
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }

    const previewTool = tools.find((tool) => tool.name === "flow_preview_script_change");
    visit(previewTool?.inputSchema.properties?.interface_doc, "flow_preview_script_change.interface_doc");
  });

  test("distinguishes both code input models and locks the preview/apply workflow", () => {
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("flow_write_code")?.description).toContain("authoritative AGENT_PROMPT.md");
    expect(byName.get("flow_execute_script")?.description).toContain("must not be wrapped in input or body");
    expect(byName.get("flow_execute_script")?.description).toContain("script_url");
    expect(byName.get("flow_execute_code")?.description).toContain("global input");
    expect(byName.get("flow_execute_code")?.description).toContain("execution_url");
    expect(byName.get("flow_execute_code")?.description).toContain("never process.env");
    expect(byName.get("flow_preview_script_change")?.description).toContain("interface_doc_patch");
    expect(byName.get("flow_preview_script_change")?.description).toContain("code-only updates may omit both document fields");
    expect(byName.get("flow_preview_script_change")?.description).toContain("preview_ready=true");
    expect(byName.get("flow_preview_script_change")?.description).toContain("requires_repreview=false");
    expect(byName.get("flow_preview_script_change")?.description).toContain("deterministic normalization and validation");
    expect(byName.get("flow_preview_script_change")?.inputSchema.required ?? []).not.toContain("operation");
    expect(byName.get("flow_preview_script_change")?.inputSchema.properties?.operation?.description)
      .toContain("MCP infers create without script_id and update with script_id");
    expect(byName.get("flow_preview_script_change")?.inputSchema.properties?.ip_whitelist?.description)
      .toContain("Omit for documentation-only updates");
    expect(byName.get("flow_preview_script_change")?.inputSchema.properties?.code?.description)
      .toContain("code may be submitted without interface_doc or interface_doc_patch");
    expect(byName.get("flow_apply_script_change")?.description).toContain("user explicitly confirmed publication");
    for (const currentToolName of ["flow_get_script", "flow_get_script_documentation"]) {
      const currentTool = byName.get(currentToolName);
      expect(Object.keys(currentTool?.inputSchema.properties ?? {}), currentToolName).toEqual(["script_id"]);
      expect(currentTool?.description, currentToolName).toContain("Pass only script_id");
    }

    expect(byName.get("flow_get_script")?.description).toContain("decoded UTF-8 code");
    expect(byName.get("flow_get_script_version")?.description).toContain("decoded UTF-8 code");
    for (const historyToolName of ["flow_get_script_version", "flow_get_script_documentation_version"]) {
      const historyTool = byName.get(historyToolName);
      expect(historyTool?.inputSchema.required, historyToolName).toContain("version");
      expect(historyTool?.description, historyToolName).toContain("explicitly requested");
      expect(historyTool?.description, historyToolName).toContain("never be guessed");
    }

    const interfaceDoc = byName.get("flow_preview_script_change")?.inputSchema.properties?.interface_doc as
      | {
          description?: string;
          type?: string;
          properties?: Record<string, unknown>;
        }
      | undefined;
    const interfaceDocPatch = byName.get("flow_preview_script_change")?.inputSchema.properties?.interface_doc_patch as
      | { type?: string; maxItems?: number; items?: unknown; description?: string }
      | undefined;
    expect(interfaceDocPatch?.type).toBe("array");
    expect(interfaceDocPatch?.maxItems).toBe(256);
    expect(interfaceDocPatch?.items).toBeDefined();
    expect(interfaceDoc?.type).toBe("object");
    expect(interfaceDoc?.properties).toMatchObject({
      schema_version: { const: "script-interface-doc.v1" },
      endpoint: { type: "object" },
      request: { type: "object" },
      responses: { type: "array" },
      logic_description: { type: "string" },
    });
    const requestSchema = interfaceDoc?.properties?.request as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(requestSchema?.properties).toMatchObject({
      query: { type: "array" },
      headers: { type: "array" },
      body: { type: "object" },
    });
    const bodySchema = requestSchema?.properties?.body as
      | { properties?: Record<string, unknown> }
      | undefined;
    expect(bodySchema?.properties).toMatchObject({
      content_type: { const: "application/json" },
      schema: { type: "object" },
      example: { description: expect.stringContaining("complete request-body example") },
    });
    expect(interfaceDoc?.description).toContain("logic_description");
    expect(interfaceDoc?.description).toContain("usage_refs is only for real application references");
    expect(interfaceDoc?.description).toContain("app_id");
    expect(interfaceDoc?.description).toContain("numeric-looking IDs");
    expect(interfaceDocPatch?.description).toContain("app_id is a string, not a number");
    expect(interfaceDoc?.description).toContain("request={query?,headers?,body?}");
    expect(interfaceDoc?.description).toContain("root Schema node for every request or response body");
    expect(interfaceDoc?.description).toContain("homogeneous dictionaries with runtime-only keys");
    expect(interfaceDoc?.description).toContain("additionalProperties=true");
    expect(interfaceDoc?.description).toContain("empty object Schema as an arbitrary-value fallback");
    expect(interfaceDoc?.description).toContain("ip_whitelist-only updates may omit it");
    expect(interfaceDoc?.description).toContain("properties, required, items, and additionalProperties inside schema");
    expect(interfaceDoc?.description).toContain("Every type=array node must define items");
    expect(interfaceDoc?.description).toContain("caller-facing URL query parameters");
    expect(byName.get("flow_preview_script_change")?.inputSchema.properties?.responses?.description)
      .toContain("misplaced at the tool-argument level");
    expect(byName.get("flow_preview_script_change")?.inputSchema.properties?.logic_description?.description)
      .toContain("misplaced at the tool-argument level");
    expect(byName.get("flow_write_code")?.inputSchema.properties?.requirement?.description)
      .toContain("does not require a caller domain");
    expect(byName.get("flow_apply_script_change")?.description).toContain("built from FLOW_CODEBLOCK_BASE_URL");
    expect(byName.get("flow_apply_script_change")?.description).toContain("data.script_url");

    const toolsWithoutCallUrls = [
      "flow_list_scripts",
      "flow_get_script",
      "flow_get_script_version",
      "flow_get_script_documentation",
      "flow_get_script_documentation_version",
      "flow_preview_script_change",
      "flow_script_stats",
      "flow_lock_script",
      "flow_unlock_script",
    ];
    for (const toolName of toolsWithoutCallUrls) {
      const description = byName.get(toolName)?.description ?? "";
      expect(description, toolName).not.toContain("script_url");
      expect(description, toolName).not.toContain("execution_url");
    }
  });

  test("returns a full execution URL only for non-script writing", async () => {
    const nonScriptResponse = await client.callTool({
      name: "flow_write_code",
      arguments: { mode: "non_script", requirement: "处理输入并返回结果" },
    });
    const scriptResponse = await client.callTool({
      name: "flow_write_code",
      arguments: { mode: "script", requirement: "创建一个持久脚本" },
    });
    const nonScriptPayload = JSON.parse(
      nonScriptResponse.content[0].type === "text" ? nonScriptResponse.content[0].text : "{}",
    );
    const scriptPayload = JSON.parse(
      scriptResponse.content[0].type === "text" ? scriptResponse.content[0].text : "{}",
    );

    expect(nonScriptPayload.execution_url).toBe("http://127.0.0.1:1/flow/codeblock");
    expect(scriptPayload).not.toHaveProperty("execution_url");
    expect(scriptPayload).not.toHaveProperty("script_url");
  });

  test("returns all requested authoritative files unchanged through the MCP transport", async () => {
    const response = await client.callTool({
      name: "flow_write_code",
      arguments: {
        mode: "script",
        requirement: "创建一个符合当前需求的脚本",
        include_full_schema: true,
      },
    });
    const textContent = response.content.find((item) => item.type === "text");
    if (!textContent || textContent.type !== "text") throw new Error("flow_write_code did not return text");
    const payload = JSON.parse(textContent.text) as Record<string, unknown>;
    const rules = payload.authoritative_rules as Record<string, unknown>;
    const patterns = payload.dangerous_patterns as Record<string, unknown>;
    const blacklist = payload.module_blacklist as Record<string, unknown>;
    const schema = payload.interface_document_schema as Record<string, unknown>;
    const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);
    const expectedPrompt = await Bun.file(new URL("AGENT_PROMPT.md", referencesDirectory)).text();
    const expectedPatterns = JSON.parse(
      await Bun.file(new URL("dangerous_patterns.json", referencesDirectory)).text(),
    );
    const expectedBlacklist = JSON.parse(
      await Bun.file(new URL("module_blacklist.json", referencesDirectory)).text(),
    );
    const expectedSchema = JSON.parse(
      await Bun.file(new URL("script-interface-doc.schema.json", referencesDirectory)).text(),
    );

    expect(rules.content).toBe(expectedPrompt);
    expect(patterns.value).toEqual(expectedPatterns);
    expect(blacklist.value).toEqual(expectedBlacklist);
    expect(schema.value).toEqual(expectedSchema);
  });
});
