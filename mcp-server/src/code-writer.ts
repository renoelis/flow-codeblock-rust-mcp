import { interfaceDocNestedRules, interfaceDocRequiredFields } from "./interface-doc.js";

const allowedModules = [
  "axios",
  "cheerio",
  "crypto-js",
  "csv-parser",
  "fast-xml-parser",
  "form-data",
  "lodash",
  "qs",
  "sm-crypto-v2",
  "uuid",
  "xlsx",
  "dayjs",
];

export const interfaceDocSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description"],
  additionalProperties: false,
  properties: {
    schema_version: { const: "script-interface-doc.v1" },
    title: { type: "string", minLength: 1, maxLength: 200 },
    summary: { type: "string", minLength: 1, maxLength: 2000 },
    endpoint: {
      type: "object",
      required: ["methods", "description"],
      additionalProperties: false,
      properties: {
        methods: { type: "array", minItems: 1, maxItems: 2, uniqueItems: true, items: { enum: ["GET", "POST"] } },
        path: { type: "string", pattern: "^/flow/codeblock/" },
        description: { type: "string", minLength: 1, maxLength: 4000 },
      },
    },
    request: {
      type: "object",
      required: ["query", "headers"],
      additionalProperties: false,
      properties: {
        query: { $ref: "#/$defs/parameters" },
        headers: { $ref: "#/$defs/parameters" },
        body: { $ref: "#/$defs/body" },
      },
    },
    responses: { type: "array", minItems: 1, maxItems: 50, items: { $ref: "#/$defs/response" } },
    logic_description: { type: "string", minLength: 20, maxLength: 20_000 },
    usage_refs: { type: "array", maxItems: 100 },
  },
  $defs: {
    parameters: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        required: ["name", "type", "required", "description", "example"],
        additionalProperties: false,
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          type: { enum: ["string", "integer", "number", "boolean", "array", "object"] },
          required: { type: "boolean" },
          description: { type: "string", minLength: 1, maxLength: 4000 },
          example: {},
          default: {},
          format: { type: "string", maxLength: 100 },
          enum_values: { type: "array", maxItems: 100 },
        },
      },
    },
    body: {
      type: "object",
      required: ["content_type", "schema", "example"],
      additionalProperties: false,
      properties: {
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
    response: {
      type: "object",
      required: ["status", "description", "content_type", "schema", "example"],
      additionalProperties: false,
      properties: {
        status: { type: "integer", minimum: 100, maximum: 599 },
        description: { type: "string", minLength: 1, maxLength: 4000 },
        content_type: { const: "application/json" },
        schema: {},
        example: {},
      },
    },
  },
};

function schemaFromExample(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length > 0 ? schemaFromExample(value[0]) : { type: "string" } };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([key, item]) => [key, schemaFromExample(item)])),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (value === null) return { type: "null" };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number" };
  return { type: typeof value };
}

export function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  inputExample: unknown,
  includeFullSchema: boolean,
): Record<string, unknown> {
  const common = {
    contract_version: "flow-code-writer.v1",
    mode,
    requirement,
    mutates_or_executes: false,
    runtime: "Bun 1.4+ fresh worker; no state is shared between executions.",
    code_rules: [
      "Read business input only from the global input object and return a JSON-serializable value.",
      "Use a top-level return by default. Use qf_output only when explicitly requested, never both.",
      "Prefer standard JavaScript and native fetch. Await or return every asynchronous operation.",
      "Do not use import/export, dynamic require, browser APIs, timers, blocked identifiers, blocked Node modules, or real credentials.",
    ],
    allowed_modules: allowedModules,
  };
  if (mode === "non_script") {
    return {
      ...common,
      input_contract: "POST /flow/codeblock makes request.body.input the global input object.",
      deliverables: ["Executable JavaScript", "Input and output contract"],
      test_tool: { name: "flow_execute_code", arguments: { code: "<JavaScript>", input: inputExample ?? {}, timeout_ms: 3000 } },
      rule: "Do not execute unless the user explicitly asks to test the code.",
    };
  }

  const bodyExample = inputExample && typeof inputExample === "object" ? inputExample : { value: "example" };
  return {
    ...common,
    input_contract: {
      endpoint: "GET|POST /flow/codeblock/{script_id}",
      shape: { query: {}, header: {}, body: {}, cookies: {} },
      note: "POST callers send their business JSON directly; do not wrap it in input or input.body.",
    },
    deliverables: ["Executable JavaScript", "A separate complete script-interface-doc.v1 JSON object"],
    interface_doc_contract: {
      strict_preview_gate: true,
      required_fields: interfaceDocRequiredFields,
      nested_rules: interfaceDocNestedRules,
      body_example_schema: schemaFromExample(bodyExample),
      full_json_schema: includeFullSchema ? interfaceDocSchema : undefined,
    },
    workflow: [
      "Read the current version before updating.",
      "Generate code and documentation together, then call flow_preview_script_change once.",
      "Apply only after explicit user confirmation.",
      "Run flow_execute_script only when the user asks to test the published script.",
    ],
  };
}
