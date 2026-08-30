import {
  interfaceDocNestedRules,
  interfaceDocPatchJsonSchema,
  interfaceDocRequiredFields,
} from "./interface-doc.js";

const allowedModules = [
  "axios",
  "cheerio",
  "csv-parser",
  "fast-xml-parser",
  "form-data",
  "lodash",
  "pinyin-pro",
  "qs",
  "read-excel-file",
  "sm-crypto-v2",
  "uuid",
  "write-excel-file",
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
        path: {
          type: "string",
          pattern: "^/flow/codeblock/",
          description: "Relative path; omit it when creating a script, and use /flow/codeblock/<actual-script-id> when updating one. The complete URL is built separately from the caller-provided domain.",
        },
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
        schema: { $ref: "#/$defs/schema_root" },
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
        schema: { $ref: "#/$defs/schema_root" },
        example: {},
      },
    },
    schema_root: {
      type: "object",
      required: ["type"],
      additionalProperties: true,
      properties: {
        type: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        example: {},
        properties: { type: "object", additionalProperties: { $ref: "#/$defs/schema_node" } },
        items: { $ref: "#/$defs/schema_node" },
        additionalProperties: { anyOf: [{ $ref: "#/$defs/schema_node" }, { type: "boolean" }] },
        required: { type: "array", items: { type: "string" } },
      },
    },
    schema_node: {
      type: "object",
      required: ["type", "description", "example"],
      additionalProperties: true,
      properties: {
        type: { type: "string", minLength: 1 },
        description: { type: "string", minLength: 1 },
        example: {},
        properties: { type: "object", additionalProperties: { $ref: "#/$defs/schema_node" } },
        items: { $ref: "#/$defs/schema_node" },
        additionalProperties: { anyOf: [{ $ref: "#/$defs/schema_node" }, { type: "boolean" }] },
        required: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function schemaFromExample(value: unknown, fieldName = "value"): Record<string, unknown> {
  const metadata = { description: `Value for ${fieldName}.`, example: structuredClone(value) };
  if (Array.isArray(value)) {
    return {
      type: "array",
      ...metadata,
      items: value.length > 0 ? schemaFromExample(value[0], `${fieldName} item`) : {
        type: "string",
        description: `Value for ${fieldName} item.`,
        example: "",
      },
    };
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      type: "object",
      ...metadata,
      properties: Object.fromEntries(entries.map(([key, item]) => [key, schemaFromExample(item, key)])),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (value === null) return { type: "null", ...metadata };
  if (typeof value === "number") return { type: Number.isInteger(value) ? "integer" : "number", ...metadata };
  return { type: typeof value, ...metadata };
}

export function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  inputExample: unknown,
  includeFullSchema: boolean,
  baseUrl?: string,
  scriptDescription?: string,
): Record<string, unknown> {
  const common = {
    contract_version: "flow-code-writer.v1",
    mode,
    requirement,
    mutates_or_executes: false,
    runtime: "Bun 1.4+ fresh worker; no state is shared between executions.",
    runtime_limits: {
      execution_timeout_ms: { minimum_default: 100, default_maximum: 15_000 },
      code_bytes: 65_535,
      input_bytes: 2 * 1024 * 1024,
      result_bytes: 10 * 1024 * 1024,
    },
    execution_error_contract: {
      source_location: {
        fields: ["line", "column", "lineContent"],
        indexing: "line and column are one-based",
        message_policy: "message contains the concise rule or runtime reason; source location is not duplicated in message",
        included_for: [
          "pre-execution syntax errors",
          "dangerous-pattern policy failures",
          "verified Bun user-code runtime failures",
        ],
        omitted_when: "the source location cannot be verified",
      },
      direct_execution_types: {
        parse_failure: "SyntaxError",
        execution_policy_failure: "SecurityError",
        user_code_http_status: 422,
        retryable: false,
      },
      script_validation_policy_type: "ValidationError",
    },
    code_rules: [
      "Read all business data from the global input only; do not read environment variables, persistent globals, or other external state. Return values must be JSON-serializable.",
      "Treat input as a reserved, read-only runtime binding. Never declare, redeclare, rebind, or destructure a local binding named input in any scope, including const/let/var declarations, function parameters, catch bindings, and nested callbacks. If a local name is needed, alias it to payload or another name, for example const payload = input. Review the complete source for input shadowing before every execution and retry.",
      "Use top-level return by default. Use qf_output only for event-style/asynchronous flows or when explicitly requested, and assign it as a bare qf_output = { ... } object literal. Never mix it with top-level return or shadow the identifier.",
      "Prefer standard JavaScript, Bun-native fetch, real axios, and node:crypto. Network requests use Bun's native network stack. Use a whitelisted CommonJS literal require only when native capabilities cannot meet the requirement and the user explicitly requests it. crypto-js has been removed and must not be generated.",
      "Do not use import/export, dynamic require, browser APIs, timers, forbidden identifiers or members, or blacklisted Node modules. Never write real credentials.",
      "Treat every forbidden identifier as forbidden in every syntactic position, including property names and method calls. Never generate RegExp.exec or .exec(...); use text.match(regex) for capture groups or regex.test(text) for boolean checks. Review the complete source and rewrite every forbidden identifier, member, or module before execution.",
      "Put business logic and asynchronous operations in try-catch; return errors as strings or plain objects.",
      "Do not create unbounded loops, unsettled Promises, or background tasks that outlive execution; every request must be awaited or returned.",
      "Validate external URLs, headers, query parameters, and request bodies for type, length, and allowed ranges. Check HTTP status and handle JSON, text, and empty responses separately.",
    ],
    async_lifecycle: [
      "Do not use setTimeout, setInterval, setImmediate, polling, delays, or background retries.",
      "Requests must finish within the execution timeout; do not leave fetch operations unawaited.",
    ],
    require_policy: {
      allowed_call_form: "Only a single string-literal require('module-name') call is allowed; indirect calls, dynamic module names, and import/export are forbidden.",
      dayjs_exception: "Prefer the native Date API for date handling; use dayjs only for complex date parsing, formatting, or time-zone work.",
      other_modules: "Except for dayjs, use a whitelisted module only when native capabilities cannot implement the requirement and the user explicitly requests it. Excel is limited to read-excel-file/node, read-excel-file/universal, write-excel-file/node, write-excel-file/universal, and write-excel-file/utility.",
    },
    forbidden: {
      identifiers: [
        "eval", "Function", "Proxy", "constructor", "__proto__", "child_process", "exec", "execFile", "execSync", "fork", "spawn",
        "module", "exports", "setImmediate", "setInterval", "setTimeout",
      ],
      members: [
        "Object.getPrototypeOf", "Object.setPrototypeOf", "Reflect.construct", "Reflect.apply", "Reflect.get", "Reflect.set",
        "process.env", "process.exit", "process.kill", "process.binding", "process._linkedBinding", "process.dlopen",
      ],
      modules: [
        "child_process", "cluster", "dgram", "dns", "fs", "node:fs", "http", "http2", "https", "inspector", "internal", "module", "node:module",
        "net", "os", "perf_hooks", "async_hooks", "bun", "process", "readline", "repl", "tls", "undici", "v8", "vm", "vm2", "worker_threads", "ws",
      ],
    },
    output_rules: [
      "Return only plain serializable values or Promises; do not return circular references, BigInt, functions, Symbols, unhandled complex class instances, or unbounded arrays/strings.",
      "The platform places immediate-interface return values in the outer HTTP response's result field; script interfaces usually return the business value directly. Prefer { success: true, data: value } or { success: false, error: message }.",
    ],
    verification_rule: "After generating code, run a meaningful execution test immediately when the available requirement and safe input are sufficient; execution-only verification does not require user confirmation. If required input or credentials are missing, state that runtime verification was not performed instead of inventing them.",
    allowed_modules: allowedModules,
  };
  if (mode === "non_script") {
    return {
      ...common,
      input_contract: {
        method: "POST",
        path: "/flow/codeblock",
        rule: "The request body's input is injected unchanged as global input and defaults to {}; the platform body may contain codebase64, input, and qingcodeTimeout.",
        example: { codebase64: "<base64 JavaScript>", input: inputExample ?? {} },
      },
      generation_decisions: [
        "Generate immediate non_script mode when the user does not specify a mode.",
        "If the requirement includes an HTTP redirect, use script mode with /flow/codeblock/{{script_id}}.",
      ],
      deliverables: ["The complete latest javascript code block containing executable JavaScript only", "Input and output contracts"],
      test_tool: { name: "flow_execute_code", arguments: { code: "<JavaScript>", input: inputExample ?? {}, timeout_ms: 3000 } },
      rule: "Call flow_execute_code immediately when the available requirement and safe input are sufficient for a meaningful test; do not wait for user confirmation.",
      response_format: [
        "Unless the user explicitly requests code only, explain the mode and output first, then provide the JavaScript code block, followed by request/response examples.",
        "For every initial generation and every later revision of a non_script interface, always deliver the complete latest generated JavaScript in the final response, even after runtime verification; never deliver only a patch, diff, or partial snippet. Also include invocation instructions, request parameters and examples, execution logic, success/error output examples, and execution_url.",
      ],
    };
  }

  const bodyExample = inputExample && typeof inputExample === "object" ? inputExample : { value: "example" };
  const normalizedBaseUrl = baseUrl?.trim().replace(/\/+$/, "");
  const endpointPathTemplate = "/flow/codeblock/{{script_id}}";
  return {
    ...common,
    script_description: scriptDescription,
    input_contract: {
      endpoint: "GET|POST /flow/codeblock/{{script_id}}",
      shape: { query: {}, header: {}, body: {}, cookies: {} },
      mapping: {
        query: "input.query; a single value is a string and repeated parameters are string arrays; do not include qingcodeToken or qingcodeTimeout.",
        headers: "input.header; the server filters x-original-cookie; use cookie when a Cookie value is needed.",
        body: "input.body; POST JSON request body, defaulting to {}; callers send business data directly as the HTTP body, never wrapped as { input: ... } or { body: ... }.",
        cookies: "input.cookies; a cookie name/value object that may be absent when no cookies are supplied.",
      },
      script_binding_rule: "Published script code receives the envelope, not the raw business body. Read body fields from input.body.<field>, query values from input.query.<field>, headers from input.header.<field>, and cookies from input.cookies.<name>; input.<business_field> is always wrong.",
      script_binding_template: "const envelope = input || {}; const payload = envelope.body && typeof envelope.body === \"object\" && !Array.isArray(envelope.body) ? envelope.body : {};",
      reserved_query: ["qingcodeToken", "qingcodeTimeout"],
    },
    test_tool: {
      name: "flow_execute_code",
      arguments: {
        code: "<generated code>",
        input: { body: bodyExample, query: {}, header: {}, cookies: {} },
        timeout_ms: 3000,
      },
      rule: "For script-mode code, use this envelope-shaped input so unpublished verification matches published execution. Direct non_script code uses the raw business object instead.",
    },
    endpoint_url_template: normalizedBaseUrl
      ? `${normalizedBaseUrl}${endpointPathTemplate}`
      : endpointPathTemplate,
    endpoint_url_rule: "When a domain is provided, output that domain plus /flow/codeblock/{{script_id}}; URLs must not contain credentials.",
    internal_artifacts: [
      "A JavaScript code block containing executable code only (submitted for preview, validation, and publication; not echoed by default)",
      "A standalone complete script-interface-doc.v1 JSON object (submitted for preview, validation, and publication; not echoed by default)",
    ],
    final_deliverables: [
      "Invocation instructions",
      "Request parameters and examples",
      "Execution logic",
      "Success/error output examples",
      "The complete published script_url",
    ],
    interface_doc_contract: {
      strict_preview_gate: true,
      required_fields: interfaceDocRequiredFields,
      nested_rules: interfaceDocNestedRules,
      common_schema_mistakes: [
        "Put the sample payload in the schema node's example field, not in schema.properties.example unless example is a real business field.",
      ],
      body_example_schema: schemaFromExample(bodyExample),
      full_json_schema: includeFullSchema ? interfaceDocSchema : undefined,
      patch_json_schema: includeFullSchema ? interfaceDocPatchJsonSchema : undefined,
      separation: [
        "The javascript code block must contain executable code only and no interface-documentation comments.",
        "The json code block must contain exactly one valid script-interface-doc.v1 object, with no Markdown, comments, or trailing commas.",
      ],
    },
    redirect_contract: {
      rule: "Only script interfaces interpret flow_redirect_url and flow_redirect_code; immediate interfaces return them as ordinary result fields.",
      url: "flow_redirect_url must be a single-slash relative path or an http/https URL with a host, without whitespace or control characters.",
      code: "flow_redirect_code must be 301, 302, 303, 307, or 308, as a number or numeric string.",
    },
    workflow: [
      "For script creates, pass the supplied script_description as flow_preview_script_change.description; it must be 1-20 characters.",
      "For updates, call flow_get_script first to read the current version; for documentation updates, flow_get_script_documentation may be called first.",
      "Generate code and a complete interface_doc together; call flow_preview_script_change once for a create or code update.",
      "Call flow_apply_script_change or flow_apply_script_documentation only after explicit user confirmation, with confirm=true.",
      "When the available requirement and safe input are sufficient for a meaningful test, immediately call flow_execute_code for unpublished code or flow_execute_script for published code; execution-only verification does not require user confirmation.",
      "On a version conflict, expired preview, or validation failure, stop and read/preview again; never retry an old preview_id.",
    ],
    response_format: [
      "Script mode does not echo JavaScript or the raw interface_doc by default; show invocation instructions, request parameters and examples, execution logic, success/error output examples, and the published script_url unless the user explicitly asks for source or raw documentation.",
      "Script code and interface_doc must still be submitted internally to the preview, validation, and publication tools.",
      "Describe request parameters, primary business behavior, responses, and error handling, with HTTP method, path, Headers/Query/Body/Cookie, and response examples matching the selected mode.",
    ],
  };
}
