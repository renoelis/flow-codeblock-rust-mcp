import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let validationRequest: Record<string, unknown> | undefined;
let createRequest: Record<string, unknown> | undefined;
let updateRequest: Record<string, unknown> | undefined;
let currentIpWhitelist: string[] | null = null;
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/flow/scripts/validate") {
      validationRequest = await request.json() as Record<string, unknown>;
      return Response.json({ success: true, data: { valid: true, warnings: [] } });
    }
    if (request.method === "POST" && url.pathname === "/flow/scripts") {
      createRequest = await request.json() as Record<string, unknown>;
      return Response.json({ success: true, data: { script_id: "created-script", version: 1 } });
    }
    if (request.method === "GET" && url.pathname.startsWith("/flow/scripts/")) {
      return Response.json({
        success: true,
        data: {
          current_version: 1,
          data: [{ version: 1, ip_whitelist: currentIpWhitelist }],
        },
      });
    }
    if (request.method === "PUT" && url.pathname.startsWith("/flow/scripts/")) {
      updateRequest = await request.json() as Record<string, unknown>;
      return Response.json({ success: true, data: { updated: true } });
    }
    return Response.json({ success: false }, { status: 404 });
  },
});

const client = new Client({ name: "flow-codeblock-script-preview-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_script_preview_test",
  },
  stderr: "pipe",
});

function misplacedInterfaceDoc() {
  return {
    schema_version: "script-interface-doc.v1",
    title: "名称校验",
    summary: "校验名称并返回成功状态",
    endpoint: { methods: ["POST"], description: "接收名称并校验" },
    request: {
      body: {
        content_type: "application/json",
        schema: { type: "object", example: { name: "示例名称" } },
        properties: {
          name: { type: "string", description: "待校验名称", example: "示例名称" },
          store_info: {
            type: "object",
            description: "蛇形门店信息",
            example: { id: "STORE-001" },
            additionalProperties: { type: "string", description: "门店字段值", example: "STORE-001" },
          },
          storeInfo: {
            type: "object",
            description: "驼峰门店信息",
            additionalProperties: { type: "string", description: "门店字段值", example: "STORE-001" },
          },
        },
        required: ["name"],
      },
    },
    responses: [{
      status: 200,
      description: "校验成功",
      content_type: "application/json",
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean", description: "是否成功", example: true },
        },
        example: { success: true },
      },
    }],
    logic_description: "读取并校验请求中的名称字段，不调用外部服务，成功时返回成功状态，失败时返回错误信息。",
    usage_refs: ["普通说明不属于应用引用"],
  };
}

function updateInterfaceDoc(scriptId: string) {
  const document = misplacedInterfaceDoc();
  (document.endpoint as Record<string, unknown>).path = `/flow/codeblock/${scriptId}`;
  return document;
}

beforeAll(async () => {
  await client.connect(transport);
});

beforeEach(() => {
  validationRequest = undefined;
  createRequest = undefined;
  updateRequest = undefined;
  currentIpWhitelist = null;
});

afterAll(async () => {
  await client.close();
  await apiServer.stop(true);
});

describe("script preview tool", () => {
  test("normalizes common interface document placement errors before API validation", async () => {
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: misplacedInterfaceDoc(),
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.preview_ready).toBe(true);
    expect(preview.requires_repreview).toBe(false);
    expect(preview.interface_doc_normalizations).toEqual([
      "Removed 1 non-object entries from interface_doc.usage_refs; ordinary prose belongs in logic_description",
      "interface_doc.request.body.properties moved to interface_doc.request.body.schema.properties",
      "interface_doc.request.body.required moved to interface_doc.request.body.schema.required",
      "interface_doc.request.body.example was promoted from interface_doc.request.body.schema.example",
      "interface_doc.request.body.schema.properties.storeInfo.example was filled from alias interface_doc.request.body.schema.properties.store_info.example",
      "interface_doc.responses[0].example was promoted from interface_doc.responses[0].schema.example",
    ]);

    const interfaceDoc = validationRequest?.interface_doc as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const bodySchema = body.schema as Record<string, unknown>;
    const responses = interfaceDoc.responses as Array<Record<string, unknown>>;
    expect(bodySchema.properties).toBeDefined();
    expect(bodySchema.required).toEqual(["name"]);
    expect(body.example).toEqual({ name: "示例名称" });
    expect(responses[0].example).toEqual({ success: true });
    expect(interfaceDoc.usage_refs).toBeUndefined();
    const properties = bodySchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.storeInfo.example).toEqual({ id: "STORE-001" });
  });

  test("returns a script URL derived from FLOW_CODEBLOCK_BASE_URL after create", async () => {
    const previewResponse = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: misplacedInterfaceDoc(),
      },
    });
    expect(previewResponse.isError).not.toBe(true);
    const previewContent = previewResponse.content.find((item) => item.type === "text");
    if (!previewContent || previewContent.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(previewContent.text) as Record<string, unknown>;

    const applyResponse = await client.callTool({
      name: "flow_apply_script_change",
      arguments: { preview_id: preview.preview_id, confirm: true },
    });
    expect(applyResponse.isError).not.toBe(true);
    const applyContent = applyResponse.content.find((item) => item.type === "text");
    if (!applyContent || applyContent.type !== "text") throw new Error("apply did not return text");
    const applied = JSON.parse(applyContent.text) as Record<string, Record<string, unknown>>;
    expect(applied.data.script_url).toBe(`${apiServer.url.origin}/flow/codeblock/created-script`);
  });

  test("ignores expected_version zero on create previews", async () => {
    const previewResponse = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        expected_version: 0,
        code: "return { success: true };",
        interface_doc: misplacedInterfaceDoc(),
      },
    });

    expect(previewResponse.isError).not.toBe(true);
    const previewContent = previewResponse.content.find((item) => item.type === "text");
    if (!previewContent || previewContent.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(previewContent.text) as Record<string, unknown>;
    expect(preview.input_normalizations).toEqual([
      "expected_version=0 was ignored for create; this field applies only to update",
    ]);

    const applyResponse = await client.callTool({
      name: "flow_apply_script_change",
      arguments: { preview_id: preview.preview_id, confirm: true },
    });
    expect(applyResponse.isError).not.toBe(true);
    expect(createRequest).not.toHaveProperty("expected_version");
  });

  test("infers create when operation and script_id are both omitted", async () => {
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        code: "return { success: true };",
        interface_doc: misplacedInterfaceDoc(),
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.operation).toBe("create");
    expect(preview.input_normalizations).toEqual([
      "operation omitted; inferred create because script_id was not provided",
    ]);
  });

  test("infers update when operation is omitted and script_id is present", async () => {
    const scriptId = "inferred-update";
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        script_id: scriptId,
        expected_version: 1,
        interface_doc: updateInterfaceDoc(scriptId),
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.operation).toBe("update");
    expect(preview.input_normalizations).toEqual([
      "operation omitted; inferred update because script_id was provided",
    ]);
  });

  test("previews and publishes an interface document patch without a full document", async () => {
    const patch = [
      { op: "replace", path: "/summary", value: "更新后的摘要" },
      { op: "add", path: "/responses/-", value: {
        status: 201,
        description: "创建成功",
        content_type: "application/json",
        schema: { type: "object" },
        example: {},
      } },
    ];
    const previewResponse = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "update",
        script_id: "patch-update",
        expected_version: 1,
        interface_doc_patch: patch,
      },
    });
    expect(previewResponse.isError).not.toBe(true);
    const previewContent = previewResponse.content.find((item) => item.type === "text");
    if (!previewContent || previewContent.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(previewContent.text) as Record<string, unknown>;
    expect(preview.changes).toMatchObject({ interface_doc: "patch", interface_doc_patch: true });
    expect(preview.validation).toMatchObject({
      data: {
        interface_doc_patch_summary: {
          operation_count: 2,
          paths: ["/summary", "/responses/-"],
          expected_version: 1,
          current_version: 1,
        },
      },
    });
    expect((validationRequest?.interface_doc_patch as unknown[])).toEqual(patch);
    expect(validationRequest?.expected_version).toBe(1);
    expect(validationRequest?.interface_doc).toBeUndefined();

    const applyResponse = await client.callTool({
      name: "flow_apply_script_change",
      arguments: { preview_id: preview.preview_id, confirm: true },
    });
    expect(applyResponse.isError).not.toBe(true);
    expect(updateRequest?.interface_doc_patch).toEqual(patch);
    expect(updateRequest?.interface_doc).toBeUndefined();
    expect(updateRequest?.expected_version).toBe(1);
  });

  test("rejects server environment access before API validation", async () => {
    for (const code of [
      "return process.env.BAIDU_MAP_AK;",
      "return process?.['env']?.BAIDU_MAP_AK;",
    ]) {
      validationRequest = undefined;
      const response = await client.callTool({
        name: "flow_preview_script_change",
        arguments: {
          operation: "create",
          code,
          interface_doc: misplacedInterfaceDoc(),
        },
      });

      expect(response.isError).toBe(true);
      const content = response.content.find((item) => item.type === "text");
      if (!content || content.type !== "text") throw new Error("preview error did not return text");
      expect(content.text).toContain("third-party API keys must be supplied by the caller");
      expect(validationRequest).toBeUndefined();
    }
  });

  test("normalizes misplaced response schema keywords and null placeholders", async () => {
    const interfaceDoc = misplacedInterfaceDoc();
    const response = interfaceDoc.responses[0] as Record<string, unknown>;
    const responseSchema = response.schema as Record<string, unknown>;
    const responseProperties = responseSchema.properties as Record<string, unknown>;
    responseProperties.required = ["success"];
    responseProperties.additionalProperties = false;
    response.responses_placeholder = null;

    const result = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(result.isError).not.toBe(true);
    const content = result.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.responses[0].responses_placeholder empty placeholder removed",
      "interface_doc.responses[0].schema.properties.required moved to interface_doc.responses[0].schema.required",
      "interface_doc.responses[0].schema.properties.additionalProperties moved to interface_doc.responses[0].schema.additionalProperties",
    ]));

    const validatedDocument = validationRequest?.interface_doc as Record<string, unknown>;
    const validatedResponses = validatedDocument.responses as Array<Record<string, unknown>>;
    const validatedResponse = validatedResponses[0];
    const validatedSchema = validatedResponse.schema as Record<string, unknown>;
    const validatedProperties = validatedSchema.properties as Record<string, unknown>;
    expect(validatedSchema.required).toEqual(["success"]);
    expect(validatedSchema.additionalProperties).toBe(false);
    expect(validatedProperties).not.toHaveProperty("required");
    expect(validatedProperties).not.toHaveProperty("additionalProperties");
    expect(validatedResponse).not.toHaveProperty("responses_placeholder");
  });

  test("reports applied normalizations when other document errors remain", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    delete interfaceDoc.logic_description;
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview error did not return text");
    expect(content.text).toContain("interface_doc.logic_description");
    expect(content.text).toContain("preserve all other fields");
    expect(content.text).toContain("Automatic normalizations applied in this call");
    expect(content.text).toContain("interface_doc.request.body.properties moved to");
  });

  test("accepts opaque upstream JSON response objects", async () => {
    const interfaceDoc = misplacedInterfaceDoc();
    const responseSchema = interfaceDoc.responses[0].schema;
    responseSchema.properties.data = {
      type: "object",
      description: "脚本原样透传且结构由上游接口决定的响应对象",
      example: { code: 0, message: "success", payload: { user_id: 1 } },
      additionalProperties: true,
    };
    responseSchema.required = ["success", "data"];
    responseSchema.example = {
      success: true,
      data: { code: 0, message: "success", payload: { user_id: 1 } },
    };

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true, data: { code: 0, message: 'success', payload: { user_id: 1 } } };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const validatedDocument = validationRequest?.interface_doc as Record<string, unknown>;
    const responses = validatedDocument.responses as Array<Record<string, unknown>>;
    const schema = responses[0].schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(properties.data.additionalProperties).toBe(true);
  });

  test("rewrites internal input terms in caller-facing documentation", async () => {
    const interfaceDoc = misplacedInterfaceDoc();
    interfaceDoc.logic_description = "脚本从 input.body 读取请求体并完成名称校验，成功时返回结果，失败时返回错误信息。";

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.logic_description converted an internal input term to caller-facing HTTP terminology",
    ]));
    const validatedDocument = validationRequest?.interface_doc as Record<string, unknown>;
    expect(validatedDocument.logic_description).toContain("HTTP body");
    expect(validatedDocument.logic_description).not.toContain("input.body");
  });

  test("recovers document fields misplaced at the tool argument level", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const responses = interfaceDoc.responses;
    const logicDescription = interfaceDoc.logic_description;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    const request = interfaceDoc.request as Record<string, unknown>;
    request.example = { name: "请求层示例" };

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
        responses,
        logic_description: logicDescription,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    const normalizations = preview.interface_doc_normalizations as string[];
    expect(normalizations).toContain("Tool-level responses moved to interface_doc.responses");
    expect(normalizations).toContain("Tool-level logic_description moved to interface_doc.logic_description");
    expect(normalizations).toContain("interface_doc.request.example moved to interface_doc.request.body.example");

    const normalizedDocument = validationRequest?.interface_doc as Record<string, unknown>;
    const normalizedRequest = normalizedDocument.request as Record<string, unknown>;
    const normalizedBody = normalizedRequest.body as Record<string, unknown>;
    const normalizedResponses = normalizedDocument.responses as Array<Record<string, unknown>>;
    expect(normalizedResponses).toHaveLength(1);
    expect(normalizedResponses[0].status).toBe(200);
    expect(normalizedResponses[0].example).toEqual({ success: true });
    expect(normalizedDocument.logic_description).toBe(logicDescription);
    expect(normalizedRequest.example).toBeUndefined();
    expect(normalizedBody.example).toEqual({ name: "请求层示例" });
  });

  test("recovers request root fields and whitelist misplaced inside interface_doc", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    request.responses = interfaceDoc.responses;
    request.logic_description = interfaceDoc.logic_description;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    interfaceDoc.ip_whitelist = ["203.0.113.10"];

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.request.responses moved to interface_doc.responses",
      "interface_doc.request.logic_description moved to interface_doc.logic_description",
      "interface_doc.ip_whitelist moved back to flow_preview_script_change.ip_whitelist",
    ]));
    expect((validationRequest as Record<string, unknown>).ip_whitelist).toEqual(["203.0.113.10"]);
    const normalized = (validationRequest as Record<string, unknown>).interface_doc as Record<string, unknown>;
    expect(normalized.responses).toHaveLength(1);
    expect(normalized.logic_description).toBeDefined();
    expect(normalized.ip_whitelist).toBeUndefined();
  });

  test("recovers deeply nested document fields before preview validation", async () => {
    const interfaceDoc = misplacedInterfaceDoc() as Record<string, unknown>;
    const request = interfaceDoc.request as Record<string, unknown>;
    const body = request.body as Record<string, unknown>;
    const schema = body.schema as Record<string, unknown>;
    const properties = body.properties as Record<string, unknown>;
    schema.responses = interfaceDoc.responses;
    schema.logic_description = interfaceDoc.logic_description;
    properties.example = schema.example;
    delete schema.example;
    delete interfaceDoc.responses;
    delete interfaceDoc.logic_description;
    request.description = "名称校验脚本";
    body.ip_whitelist = ["203.0.113.30"];

    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        interface_doc: interfaceDoc,
      },
    });

    expect(response.isError).not.toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview did not return text");
    const preview = JSON.parse(content.text) as Record<string, unknown>;
    expect(preview.changes).toMatchObject({ description: true, ip_whitelist: true, interface_doc: true });
    expect(preview.interface_doc_normalizations).toEqual(expect.arrayContaining([
      "interface_doc.request.description moved back to flow_preview_script_change.description",
      "interface_doc.request.body.ip_whitelist moved back to flow_preview_script_change.ip_whitelist",
      "interface_doc.request.body.schema.responses moved to interface_doc.responses",
      "interface_doc.request.body.schema.logic_description moved to interface_doc.logic_description",
      "interface_doc.request.body.example was promoted from interface_doc.request.body.schema.properties.example",
    ]));
    expect(validationRequest?.ip_whitelist).toEqual(["203.0.113.30"]);
    const normalized = validationRequest?.interface_doc as Record<string, unknown>;
    const normalizedRequest = normalized.request as Record<string, unknown>;
    const normalizedBody = normalizedRequest.body as Record<string, unknown>;
    expect(normalized.responses).toHaveLength(1);
    expect(normalized.logic_description).toBeDefined();
    expect(normalizedBody.example).toEqual({ name: "示例名称" });
  });

  test("rejects misplaced document fields when interface_doc is absent", async () => {
    const response = await client.callTool({
      name: "flow_preview_script_change",
      arguments: {
        operation: "create",
        code: "return { success: true };",
        responses: [],
        logic_description: "这段说明不能替代完整的接口文档对象。",
      },
    });

    expect(response.isError).toBe(true);
    const content = response.content.find((item) => item.type === "text");
    if (!content || content.type !== "text") throw new Error("preview error did not return text");
    expect(content.text).toContain("cannot replace interface_doc");
  });

  test("omits unchanged whitelist values from interface document updates", async () => {
    const scenarios: Array<{
      current: string[] | null;
      submitted: string[] | null;
      changed: boolean;
    }> = [
      { current: null, submitted: null, changed: false },
      { current: null, submitted: [], changed: false },
      { current: ["203.0.113.10"], submitted: ["203.0.113.10"], changed: false },
      { current: ["203.0.113.10"], submitted: null, changed: true },
      { current: ["203.0.113.10"], submitted: ["203.0.113.20"], changed: true },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const scriptId = `script-update-${index}`;
      currentIpWhitelist = scenario.current;
      validationRequest = undefined;
      const response = await client.callTool({
        name: "flow_preview_script_change",
        arguments: {
          operation: "update",
          script_id: scriptId,
          expected_version: 1,
          interface_doc: updateInterfaceDoc(scriptId),
          ip_whitelist: scenario.submitted,
        },
      });

      expect(response.isError).not.toBe(true);
      const content = response.content.find((item) => item.type === "text");
      if (!content || content.type !== "text") throw new Error("preview did not return text");
      const preview = JSON.parse(content.text) as Record<string, unknown>;
      const changes = preview.changes as Record<string, unknown>;
      expect(changes.ip_whitelist).toBe(scenario.changed);
      expect(Object.prototype.hasOwnProperty.call(validationRequest, "ip_whitelist")).toBe(scenario.changed);
      if (scenario.changed) {
        expect(validationRequest?.ip_whitelist).toEqual(scenario.submitted);
        expect(preview.ignored_changes).toBeUndefined();
      } else {
        expect(preview.ignored_changes).toEqual(["ip_whitelist matches the current value and was omitted from this change"]);
      }

      if (index === 0) {
        const applyResponse = await client.callTool({
          name: "flow_apply_script_change",
          arguments: { preview_id: preview.preview_id, confirm: true },
        });
        expect(applyResponse.isError).not.toBe(true);
        const applyContent = applyResponse.content.find((item) => item.type === "text");
        if (!applyContent || applyContent.type !== "text") throw new Error("apply did not return text");
        const applied = JSON.parse(applyContent.text) as Record<string, Record<string, unknown>>;
        expect(applied.data.script_url).toBe(`${apiServer.url.origin}/flow/codeblock/${scriptId}`);
        expect(Object.prototype.hasOwnProperty.call(updateRequest, "ip_whitelist")).toBe(false);
      }
    }
  });
});
