import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requestTargets: string[] = [];
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    requestTargets.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/flow/scripts/script-current" || url.pathname === "/flow/scripts/script-history") {
      return Response.json({
        success: true,
        data: {
          current_version: 3,
        data: [
            {
              version: 3,
              code_base64: Buffer.from("const result = { ok: true };\nreturn result;", "utf8").toString("base64"),
            },
            { version: 2, code_base64: "not-valid-base64" },
          ],
          access_token: "flow_access_secret_1234",
          authorization: "Bearer authorization-secret",
          nested: { token: "flow_token_secret_5678" },
        },
      });
    }
    if (url.pathname === "/flow/scripts") {
      return Response.json({
        success: true,
        data: {
          scripts: [{
            id: "script-list",
            code_base64: Buffer.from("return { listed: true };", "utf8").toString("base64"),
          }],
        },
      });
    }
    return Response.json({ success: true, data: {} });
  },
});

const client = new Client({ name: "flow-codeblock-script-read-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_script_read_test",
  },
  stderr: "pipe",
});

beforeAll(async () => {
  await client.connect(transport);
});

afterAll(async () => {
  await client.close();
  await apiServer.stop(true);
});

describe("script read tool routes", () => {
  test("uses version zero for current script reads and positive versions only for explicit history tools", async () => {
    const currentResponse = await client.callTool({ name: "flow_get_script", arguments: { script_id: "script-current" } });
    const historyResponse = await client.callTool({
      name: "flow_get_script_version",
      arguments: { script_id: "script-history", version: 3 },
    });
    await client.callTool({
      name: "flow_get_script_documentation",
      arguments: { script_id: "document-current" },
    });
    await client.callTool({
      name: "flow_get_script_documentation_version",
      arguments: { script_id: "document-history", version: 2 },
    });

    expect(requestTargets).toEqual([
      "/flow/scripts/script-current?version=0",
      "/flow/scripts/script-history?version=3",
      "/flow/scripts/document-current/documentation",
      "/flow/scripts/document-history/documentation?version=2",
    ]);

    const currentPayload = JSON.parse(currentResponse.content[0].type === "text" ? currentResponse.content[0].text : "{}");
    const historyPayload = JSON.parse(historyResponse.content[0].type === "text" ? historyResponse.content[0].text : "{}");
    for (const payload of [currentPayload, historyPayload]) {
      expect(payload.data.data[0].code).toBe("const result = { ok: true };\nreturn result;");
      expect(payload.data.data[0].code_base64).toBeUndefined();
      expect(payload.data.data[1].code_base64).toBe("not-valid-base64");
    }
  });

  test("redacts token fields in ordinary nested API results", async () => {
    const response = await client.callTool({ name: "flow_get_script", arguments: { script_id: "script-current" } });
    const payload = JSON.parse(response.content[0].type === "text" ? response.content[0].text : "{}");
    expect(payload.data.access_token).toBe("flow***1234");
    expect(payload.data.nested.token).toBe("flow***5678");
    expect(payload.data.authorization).toBe("Bear***cret");
    expect(JSON.stringify(payload)).not.toContain("flow_access_secret_1234");
    expect(JSON.stringify(payload)).not.toContain("flow_token_secret_5678");
  });

  test("decodes script code if a list response includes it", async () => {
    const response = await client.callTool({ name: "flow_list_scripts", arguments: {} });
    const payload = JSON.parse(response.content[0].type === "text" ? response.content[0].text : "{}");

    expect(payload.data.scripts[0].code).toBe("return { listed: true };");
    expect(payload.data.scripts[0].code_base64).toBeUndefined();
  });
});
