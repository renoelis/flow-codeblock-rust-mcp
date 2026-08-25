import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FlowApiClient } from "../src/api.js";
import { createMcpServer } from "../src/server.js";
import { PreviewStore } from "../src/preview-store.js";

type RequestRecord = { method: string; url: string; headers: Headers; body: unknown };

async function withMockApi(
  handler: (request: RequestRecord) => Response | Promise<Response>,
  run: (baseUrl: string, requests: RequestRecord[]) => Promise<void>,
): Promise<void> {
  const requests: RequestRecord[] = [];
  const http = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      let body: unknown = undefined;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      const record = { method: request.method, url: request.url, headers: request.headers, body };
      requests.push(record);
      return handler(record);
    },
  });
  try {
    await run(http.url.origin, requests);
  } finally {
    http.stop(true);
  }
}

async function callTool(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
) {
  const api = new FlowApiClient({ baseUrl, token: "test-token" });
  const server = createMcpServer({ api });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

const json = (data: unknown, status = 200) =>
  Response.json({ success: true, data }, { status });

describe("Flow Codeblock Rust MCP", () => {
  test("publishes server instructions and actionable tool metadata", async () => {
    const api = new FlowApiClient({ baseUrl: "http://127.0.0.1:3003", token: "test-token" });
    const server = createMcpServer({ api });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("flow_preview_script_change");
      expect(instructions).toContain("/flow/codeblock/{{脚本ID}}");
      expect(instructions).toContain("content_type=application/json");
      expect(instructions).toContain("最终用户交付按模式区分");
      expect(instructions).toContain("script 默认不主动回显 JavaScript 或原始 interface_doc");
      const listed = await client.listTools();
      const writeCode = listed.tools.find((tool) => tool.name === "flow_write_code");
      expect(writeCode?.description).toContain("完整 script-interface-doc.v1");
      expect(writeCode?.description).toContain("最终交付默认只展示接口调用说明");
      expect(writeCode?.inputSchema.properties?.base_url).toBeDefined();
      const baseUrlSchema = writeCode?.inputSchema.properties?.base_url as { description?: string } | undefined;
      expect(baseUrlSchema?.description).toContain("/flow/codeblock/{{script_id}}");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("returns the caller-domain script endpoint template", async () => {
    const response = await callTool("http://127.0.0.1:3003", "flow_write_code", {
      mode: "script",
      requirement: "查询订单状态",
      base_url: "https://flow.example.com/",
    });
    const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
    const payload = JSON.parse(text) as { endpoint_url_template?: string };
    expect(payload.endpoint_url_template).toBe("https://flow.example.com/flow/codeblock/{{script_id}}");
    expect(payload.final_deliverables).toEqual([
      "接口调用说明",
      "请求参数及示例",
      "执行逻辑",
      "成功/错误输出示例",
      "发布后的完整 script_url",
    ]);
    expect(payload.internal_artifacts).toEqual([
      "只含可执行代码的 JavaScript 代码块（提交预览、校验和发布；默认不回显）",
      "独立且完整的 script-interface-doc.v1 JSON 对象（提交预览、校验和发布；默认不回显）",
    ]);

    const nonScript = await callTool("http://127.0.0.1:3003", "flow_write_code", {
      mode: "non_script",
      requirement: "处理输入并返回结果",
    });
    const nonScriptText = (nonScript.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
    expect(JSON.parse(nonScriptText).execution_url).toBe("http://127.0.0.1:3003/flow/codeblock");
    expect(payload).not.toHaveProperty("execution_url");
    expect(payload).not.toHaveProperty("script_url");
  });

  test("publishes the current module contract without removed crypto-js or invalid Excel entries", async () => {
    const response = await callTool("http://127.0.0.1:3003", "flow_write_code", {
      mode: "non_script",
      requirement: "生成一个需要拼音和 Excel 往返的处理脚本",
    });
    const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
    const payload = JSON.parse(text) as {
      allowed_modules?: unknown;
      require_policy?: { other_modules?: string };
      code_rules?: string[];
    };
    const allowed = payload.allowed_modules as string[];
    expect(allowed).toContain("pinyin-pro");
    expect(allowed).toContain("read-excel-file");
    expect(allowed).toContain("write-excel-file");
    expect(allowed).toContain("xlsx");
    expect(allowed).not.toContain("crypto-js");
    expect(payload.require_policy?.other_modules).toContain("read-excel-file/node");
    expect(payload.require_policy?.other_modules).toContain("write-excel-file/utility");
    expect(payload.code_rules?.join(" ")).toContain("node:crypto");
    expect(payload.code_rules?.join(" ")).toContain("crypto-js");
  });

  test("uses bearer authentication for management requests", async () => {
    await withMockApi(
      (request) => {
        expect(request.method).toBe("GET");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.url).toContain("/flow/scripts?page=1&size=20");
        return json({ scripts: [], has_more: false, next_cursor: null });
      },
      async (baseUrl) => {
        const response = await callTool(baseUrl, "flow_list_scripts", {
          page: 1,
          size: 20,
        });
        expect(JSON.stringify(response)).not.toContain("test-token");
      },
    );
  });

  test("previews without writing and applies only after version revalidation", async () => {
    await withMockApi(
      (request) => {
        if (request.method === "GET") {
          return json({ available_versions: [1], current_version: 1, data: [{ version: 1 }] });
        }
        if (request.method === "PUT") {
          expect(request.body).toEqual({ description: "updated", expected_version: 1 });
          return json({ script_id: "abc", version: 1 });
        }
        return new Response("unexpected write", { status: 500 });
      },
      async (baseUrl, requests) => {
        const api = new FlowApiClient({ baseUrl, token: "test-token" });
        const previewStore = new PreviewStore<Record<string, unknown>>();
        const server = createMcpServer({ api, previews: previewStore });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const preview = await client.callTool({
          name: "flow_preview_script_change",
          arguments: { operation: "update", script_id: "abc", expected_version: 1, description: "updated" },
        });
        expect(preview.isError).not.toBe(true);
        expect(requests.map((request) => request.method)).toEqual(["GET"]);
        const previewResult = preview as unknown as { content?: Array<{ type?: string; text?: string }> };
        const text = previewResult.content?.[0];
        expect(text?.type).toBe("text");
        const previewData = JSON.parse(text?.type === "text" && text.text ? text.text : "{}");
        const applied = await client.callTool({
          name: "flow_apply_script_change",
          arguments: { preview_id: previewData.preview_id, confirm: true },
        });
        const appliedText = (applied.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        expect(JSON.parse(appliedText).data.script_url).toBe(`${baseUrl}/flow/codeblock/abc`);
        expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PUT"]);
        await client.close();
        await server.close();
      },
    );
  });

  test("previews RFC 6902 patches as a compact summary and revalidates before publish", async () => {
    await withMockApi(
      (request) => {
        if (request.method === "GET") {
          return json({ available_versions: [2], current_version: 2, data: [{ version: 2 }] });
        }
        if (request.method === "POST") {
          expect(request.url).toContain("/flow/scripts/validate");
          expect(request.body).toEqual({
            script_id: "abc",
            expected_version: 2,
            interface_doc_patch: [{ op: "replace", path: "/summary", value: "new summary" }],
          });
          return json({
            valid: true,
            warnings: ["warning"],
            interface_doc: { summary: "SENSITIVE_MERGED_DOCUMENT" },
          });
        }
        if (request.method === "PUT") {
          expect(request.body).toEqual({
            expected_version: 2,
            interface_doc_patch: [{ op: "replace", path: "/summary", value: "new summary" }],
          });
          return json({ script_id: "abc", version: 3 });
        }
        return new Response("unexpected write", { status: 500 });
      },
      async (baseUrl, requests) => {
        const api = new FlowApiClient({ baseUrl, token: "test-token" });
        const previews = new PreviewStore<Record<string, unknown>>();
        const server = createMcpServer({ api, previews });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "test-client", version: "0.1.0" }, { capabilities: {} });
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const patch = [{ op: "replace", path: "/summary", value: "new summary" }];
        const preview = await client.callTool({
          name: "flow_preview_script_change",
          arguments: { operation: "update", script_id: "abc", expected_version: 2, interface_doc_patch: patch },
        });
        const text = (preview.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        expect(text).toContain("operation_count");
        expect(text).toContain("/summary");
        expect(text).not.toContain("SENSITIVE_MERGED_DOCUMENT");
        const previewData = JSON.parse(text) as { preview_id?: string };
        await client.callTool({
          name: "flow_apply_script_change",
          arguments: { preview_id: previewData.preview_id, confirm: true },
        });
        expect(requests.map((request) => request.method)).toEqual(["GET", "POST", "GET", "POST", "PUT"]);
        await client.close();
        await server.close();
      },
    );
  });

  test("filters reserved headers and maps repeated query parameters for execution", async () => {
    await withMockApi(
      (request) => {
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("x-flow-test-tool")).toBeNull();
        expect(request.headers.get("x-real-ip")).toBeNull();
        expect(request.headers.get("x-forwarded-for")).toBeNull();
        expect(request.headers.get("forwarded")).toBeNull();
        expect(request.headers.get("cf-connecting-ip")).toBeNull();
        expect(request.headers.get("x-flow-execution-origin")).toBe("mcp");
        expect(request.headers.get("x-client")).toBe("ok");
        const url = new URL(request.url);
        expect(url.searchParams.getAll("tag")).toEqual(["one", "two"]);
        expect(url.searchParams.get("qingcodeTimeout")).toBe("5000");
        return json({ result: { ok: true } });
      },
      async (baseUrl) => {
        const response = await callTool(baseUrl, "flow_execute_script", {
          script_id: "abc",
          method: "POST",
          query: { tag: ["one", "two"] },
          headers: {
            Authorization: "should-be-filtered",
            "CF-Connecting-IP": "203.0.113.12",
            Forwarded: "for=203.0.113.11",
            "X-Flow-Test-Tool": "1",
            "X-Forwarded-For": "203.0.113.10",
            "X-Real-IP": "203.0.113.9",
            "x-client": "ok",
          },
          body: { value: 1 },
          timeout_ms: 5000,
        });
        expect(JSON.stringify(response)).toContain("ok");
        const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        expect(JSON.parse(text).script_url).toBe(`${baseUrl}/flow/codeblock/abc`);
      },
    );
  });

  test("marks direct MCP execution and does not expose credentials to the code input", async () => {
    await withMockApi(
      (request) => {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe("Bearer test-token");
        expect(request.headers.get("x-flow-execution-origin")).toBe("mcp");
        expect(request.body).toEqual({ codebase64: Buffer.from("return input;").toString("base64"), input: { ok: true } });
        return json({ result: { ok: true } });
      },
      async (baseUrl) => {
        const response = await callTool(baseUrl, "flow_execute_code", {
          code: "return input;",
          input: { ok: true },
        });
        expect(JSON.stringify(response)).toContain("ok");
        const text = (response.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
        expect(JSON.parse(text).execution_url).toBe(`${baseUrl}/flow/codeblock`);
        expect(JSON.stringify(response)).not.toContain("test-token");
      },
    );
  });

  test("rejects incomplete interface documentation before any write", async () => {
    await withMockApi(
      () => new Response("unexpected request", { status: 500 }),
      async (baseUrl, requests) => {
        const response = await callTool(baseUrl, "flow_preview_script_change", {
          operation: "create",
          code: "return input;",
          interface_doc: { schema_version: "script-interface-doc.v1" },
        });
        expect(response.isError).toBe(true);
        expect(requests).toHaveLength(0);
      },
    );
  });

  test("preview store expires entries and enforces its upper bound", () => {
    let now = 1_000;
    const store = new PreviewStore<Record<string, unknown>>({ maxEntries: 1, ttlMs: 10, now: () => now });
    store.put("one", "script_change", { value: 1 });
    expect(store.size).toBe(1);
    expect(() => store.put("two", "script_change", { value: 2 })).toThrow("Too many pending previews");
    now = 1_011;
    expect(store.get("one")).toBeUndefined();
    store.put("two", "script_change", { value: 2 });
    expect(store.size).toBe(1);
  });
});
