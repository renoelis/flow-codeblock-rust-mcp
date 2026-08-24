import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FlowApiClient } from "./api.js";
import { createMcpServer } from "./server.js";

const token = process.env.FLOW_CODEBLOCK_TOKEN?.trim();
if (!token) throw new Error("FLOW_CODEBLOCK_TOKEN is required");

const baseUrl = (process.env.FLOW_CODEBLOCK_BASE_URL ?? "http://127.0.0.1:3003").trim();
const api = new FlowApiClient({ baseUrl, token });
const server: McpServer = createMcpServer({ api });
await server.connect(new StdioServerTransport());
