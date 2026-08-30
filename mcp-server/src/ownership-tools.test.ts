import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type ApiRequest = {
  accessToken: string | null;
  body: unknown;
  method: string;
  path: string;
};

const apiRequests: ApiRequest[] = [];
const apiServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const bodyText = await request.text();
    apiRequests.push({
      accessToken: request.headers.get("accessToken"),
      body: bodyText ? JSON.parse(bodyText) : null,
      method: request.method,
      path: `${url.pathname}${url.search}`,
    });
    return Response.json({ success: true, data: { is_locked: false, lock_owner_name_hint: null } });
  },
});

const client = new Client({ name: "flow-codeblock-ownership-test", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_ownership_test",
    FLOW_CODEBLOCK_OWNER_NAME: "Default Owner",
  },
  stderr: "pipe",
});
const missingOwnerClient = new Client({ name: "flow-codeblock-missing-owner-test", version: "1.0.0" });
const missingOwnerTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["run", "src/index.ts"],
  cwd: import.meta.dir.replace(/\/src$/, ""),
  env: {
    FLOW_CODEBLOCK_BASE_URL: apiServer.url.origin,
    FLOW_CODEBLOCK_TOKEN: "flow_missing_owner_test",
  },
  stderr: "pipe",
});

beforeAll(async () => {
  await client.connect(transport);
  await missingOwnerClient.connect(missingOwnerTransport);
});

afterAll(async () => {
  await client.close();
  await missingOwnerClient.close();
  await apiServer.stop(true);
});

describe("direct script lock tools", () => {
  test("locks with the configured owner name and supplied password", async () => {
    await client.callTool({
      name: "flow_lock_script",
      arguments: {
        script_id: "script default name",
        lock_password: "123456",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { owner_name: "Default Owner", lock_password: "123456" },
      method: "POST",
      path: "/flow/scripts/script%20default%20name/lock",
    });
  });

  test("unlocks with the configured owner name and supplied password", async () => {
    await client.callTool({
      name: "flow_unlock_script",
      arguments: {
        script_id: "script explicit",
        lock_password: "654321",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { owner_name: "Default Owner", lock_password: "654321" },
      method: "POST",
      path: "/flow/scripts/script%20explicit/unlock",
    });
  });

  test("prefers an explicitly supplied owner name", async () => {
    await client.callTool({
      name: "flow_lock_script",
      arguments: {
        script_id: "script explicit name",
        lock_password: "654321",
        owner_name: "Explicit Owner",
      },
    });

    expect(apiRequests.at(-1)).toEqual({
      accessToken: "flow_ownership_test",
      body: { owner_name: "Explicit Owner", lock_password: "654321" },
      method: "POST",
      path: "/flow/scripts/script%20explicit%20name/lock",
    });
  });

  test("returns a clear error when owner name is unavailable", async () => {
    const response = await missingOwnerClient.callTool({
      name: "flow_unlock_script",
      arguments: { script_id: "script without owner", lock_password: "123456" },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("owner_name is required"),
    });
  });
});
