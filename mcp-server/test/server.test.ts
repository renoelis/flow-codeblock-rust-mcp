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
        await client.callTool({
          name: "flow_apply_script_change",
          arguments: { preview_id: previewData.preview_id, confirm: true },
        });
        expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "PUT"]);
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
