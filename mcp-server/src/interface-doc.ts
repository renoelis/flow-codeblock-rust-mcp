import { z } from "zod";

type JsonObject = Record<string, unknown>;

export const interfaceDocRequiredFields = {
  document: ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description"],
  endpoint: ["methods", "description"],
  request: ["query", "headers", "body (required for POST; omit for GET-only)"],
  parameter: ["name", "type", "required", "description", "example"],
  body: ["content_type", "schema", "example"],
  response: ["status", "description", "content_type", "schema", "example"],
  optional: ["endpoint.path (omit on create; actual relative path on update)", "usage_refs"],
};

export const interfaceDocNestedRules = [
  "title is the document title; summary is a one-sentence summary; endpoint.description explains the callable interface; logic_description explains the business logic.",
  "request.query and request.headers are always present arrays; use [] when the interface has no query or header parameters.",
  "Each query/header parameter requires name, type, required, description, and example. Do not use the internal input.query/input.header/input.body/input.cookies names in the caller-facing document.",
  "For POST, request.body is required and content_type must be application/json; for GET-only documents, omit request.body.",
  "Each response requires status, description, content_type, schema, and example. Describe every response shape returned by the script, including errors when applicable.",
  "Every JSON Schema node declares type. Object schemas use properties for fixed fields or a complete additionalProperties schema for dynamic keys.",
  "Every array schema has items. Object array items have complete properties, and every example item covers those properties.",
  "At every nesting level, schema properties and example fields cover each other. Optional properties still appear in the complete example.",
  "required contains only runtime-required fields. Use separate responses when success and error payloads have different shapes.",
];

export const interfaceDocInputDescription = [
  "A complete script-interface-doc.v1 document is required when creating a script, changing code, or saving documentation.",
  "Submit interface_doc/document as a JSON object. Legacy JSON text is accepted and parsed once by MCP for compatibility. MCP fills nested examples only from matching parent examples, uses a neutral description when one is omitted, and never guesses a missing type.",
  `Required structure: ${Object.entries(interfaceDocRequiredFields).map(([key, fields]) => `${key}=[${fields.join(", ")}]`).join("; ")}.`,
  ...interfaceDocNestedRules,
  "endpoint.path is relative and must be /flow/codeblock/<actual-script-id> on update; the final public URL is the caller-provided domain followed by /flow/codeblock/<script-id>.",
  "Never include real tokens, passwords, cookies, Authorization values, or other credentials in the document or examples.",
].join(" ");

const patchPathSchema = z.string().describe("RFC 6901 JSON Pointer path; array paths use indexes from the current canonical document.");
const interfaceDocPatchOperationSchema = z.union([
  z.object({ op: z.literal("add"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: patchPathSchema }).strict(),
  z.object({ op: z.literal("replace"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("move"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("copy"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("test"), path: patchPathSchema, value: z.unknown() }).strict(),
]).superRefine((operation, context) => {
  if (["add", "replace", "test"].includes(operation.op) && !Object.prototype.hasOwnProperty.call(operation, "value")) {
    context.addIssue({ code: "custom", path: ["value"], message: "value is required for this operation" });
  }
});

export const interfaceDocPatchSchema = z.array(interfaceDocPatchOperationSchema)
  .min(1)
  .max(256)
  .describe("RFC 6902 JSON Patch operation array; operations are applied in order and cannot be provided with a complete interface_doc.");

export const interfaceDocPatchJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://flow-codeblock.local/schemas/script-interface-doc.patch.v1.json",
  title: "script-interface-doc.v1 JSON Patch",
  description: "RFC 6902 operations applied in order to an existing canonical script interface document.",
  type: "array",
  minItems: 1,
  maxItems: 256,
  items: {
    oneOf: [
      { type: "object", additionalProperties: false, required: ["op", "path", "value"], properties: { op: { const: "add" }, path: { type: "string" }, value: {} } },
      { type: "object", additionalProperties: false, required: ["op", "path"], properties: { op: { const: "remove" }, path: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "path", "value"], properties: { op: { const: "replace" }, path: { type: "string" }, value: {} } },
      { type: "object", additionalProperties: false, required: ["op", "from", "path"], properties: { op: { const: "move" }, from: { type: "string" }, path: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "from", "path"], properties: { op: { const: "copy" }, from: { type: "string" }, path: { type: "string" } } },
      { type: "object", additionalProperties: false, required: ["op", "path", "value"], properties: { op: { const: "test" }, path: { type: "string" }, value: {} } },
    ],
  },
} as const;

let schemaNodeInputSchema: z.ZodTypeAny;
schemaNodeInputSchema = z.lazy(() => z.looseObject({
  type: z.string().min(1).describe("JSON Schema type such as object, array, string, integer, number, or boolean."),
  description: z.string().min(1).describe("Description of this nested field or data structure."),
  example: z.unknown().describe("A concrete value matching this nested schema node."),
  properties: z.record(z.string(), schemaNodeInputSchema).optional().describe("Map fixed object field names to child schema nodes."),
  items: schemaNodeInputSchema.optional().describe("Child schema node for each array item."),
  additionalProperties: z.union([z.boolean(), schemaNodeInputSchema]).optional().describe("Boolean or child schema for dynamic object keys."),
  required: z.array(z.string()).optional().describe("Runtime-required object field names."),
}));

const schemaRootInputSchema = z.looseObject({
  type: z.string().min(1).describe("JSON Schema type such as object, array, string, integer, number, or boolean."),
  description: z.string().optional().describe("Description of the root data structure."),
  example: z.unknown().optional().describe("Complete example matching this root schema."),
  properties: z.record(z.string(), schemaNodeInputSchema).optional().describe("Map fixed object field names to child schema nodes."),
  items: schemaNodeInputSchema.optional().describe("Child schema node for each array item."),
  additionalProperties: z.union([z.boolean(), schemaNodeInputSchema]).optional().describe("Boolean or child schema for dynamic object keys."),
  required: z.array(z.string()).optional().describe("Runtime-required object field names."),
});

const parameterInputSchema = z.looseObject({
  name: z.string().min(1).describe("Caller-facing query parameter or HTTP header name."),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]).describe("Parameter JSON type."),
  required: z.boolean().describe("Whether the parameter is required at runtime."),
  description: z.string().min(1).describe("Purpose and constraints of the parameter."),
  example: z.unknown().describe("Concrete example value for the parameter."),
  default: z.unknown().optional().describe("Optional default value."),
  format: z.string().optional().describe("Optional format hint."),
  enum_values: z.array(z.unknown()).optional().describe("Optional allowed values."),
});

const interfaceDocToolInputObjectSchema = z.looseObject({
  schema_version: z.literal("script-interface-doc.v1").describe("Fixed document contract version."),
  title: z.string().min(1).describe("Interface document title."),
  summary: z.string().min(1).describe("One-sentence caller-facing summary."),
  endpoint: z.looseObject({
    methods: z.array(z.enum(["GET", "POST"])).min(1).describe("HTTP methods supported by the endpoint."),
    path: z.string().optional().describe("Actual /flow/codeblock/{script_id} path on update."),
    description: z.string().min(1).describe("What the callable endpoint does."),
  }).describe("HTTP endpoint contract."),
  request: z.looseObject({
    query: z.array(parameterInputSchema).describe("Caller-facing URL query parameters; use [] when empty."),
    headers: z.array(parameterInputSchema).describe("Caller-facing HTTP headers; use [] when empty."),
    body: z.looseObject({
      content_type: z.literal("application/json").describe("Must be application/json."),
      schema: schemaRootInputSchema.describe("Request body JSON Schema."),
      example: z.unknown().describe("Complete request body example matching schema."),
    }).optional().describe("POST request body."),
  }).describe("Caller request contract."),
  responses: z.array(z.looseObject({
    status: z.number().int().min(100).max(599).describe("HTTP status code from 100 through 599."),
    description: z.string().min(1).describe("Business meaning of this response branch."),
    content_type: z.literal("application/json").describe("Must be application/json."),
    schema: schemaRootInputSchema.describe("Response body JSON Schema."),
    example: z.unknown().describe("Complete response example matching schema."),
  })).min(1).describe("Complete response branches at the document root."),
  logic_description: z.string().min(20).describe("Endpoint processing logic; at least 20 characters."),
  usage_refs: z.array(z.unknown()).optional().describe("Real application references only."),
});

function parseLegacyJsonDocument(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

// Keep the advertised shape object-based while accepting one legacy JSON string parse.
export const interfaceDocToolInputSchema = z.preprocess(
  parseLegacyJsonDocument,
  interfaceDocToolInputObjectSchema,
).describe(interfaceDocInputDescription);

export function assertInterfaceDocPatch(patch: unknown): void {
  const parsed = interfaceDocPatchSchema.safeParse(patch);
  if (!parsed.success) throw new Error(`Invalid interface_doc_patch format: ${parsed.error.message}`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeSchemaNode(
  schema: JsonObject,
  parentExample: unknown,
  fieldName: string,
  root = false,
): void {
  // ponytail: first array item supplies nested examples; use a heterogeneous-array schema if that ceiling matters.
  if (!root) {
    if (typeof schema.description !== "string" || !schema.description.trim()) {
      schema.description = `Value for field "${fieldName}".`;
    }
    if (!hasOwn(schema, "example") && parentExample !== undefined) {
      schema.example = structuredClone(parentExample);
    }
  }
  const example = hasOwn(schema, "example") ? schema.example : parentExample;
  if (schema.type === "array") {
    if (isObject(schema.items)) {
      const itemExample = Array.isArray(example) && example.length > 0 ? example[0] : undefined;
      normalizeSchemaNode(schema.items, itemExample, `${fieldName} item`);
    }
    return;
  }
  if (schema.type !== "object") return;
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!isObject(propertySchema)) continue;
      const childExample = isObject(example) && hasOwn(example, key) ? example[key] : undefined;
      normalizeSchemaNode(propertySchema, childExample, key);
    }
  }
  if (isObject(schema.additionalProperties)) {
    const knownKeys = new Set(properties ? Object.keys(properties) : []);
    const dynamicExample = isObject(example)
      ? Object.entries(example).find(([key]) => !knownKeys.has(key))?.[1]
      : undefined;
    normalizeSchemaNode(schema.additionalProperties, dynamicExample, `${fieldName} value`);
  }
}

export function normalizeInterfaceDocument(document: unknown): unknown {
  if (!isObject(document)) return document;
  const normalized = structuredClone(document) as JsonObject;
  const containers: JsonObject[] = [];
  if (isObject(normalized.request) && isObject(normalized.request.body)) {
    containers.push(normalized.request.body);
  }
  if (Array.isArray(normalized.responses)) {
    containers.push(...normalized.responses.filter(isObject));
  }
  for (const container of containers) {
    const schema = isObject(container.schema) ? container.schema : undefined;
    if (!schema) continue;
    if (!hasOwn(container, "example") && hasOwn(schema, "example")) {
      container.example = structuredClone(schema.example);
    }
    normalizeSchemaNode(schema, container.example, "root", true);
  }
  return normalized;
}

function requireText(object: JsonObject, key: string, path: string, issues: string[], minLength = 1): void {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length < minLength) {
    issues.push(`${path}.${key} must be a non-empty string with at least ${minLength} characters`);
  }
}

function validateSchemaExampleCoverage(
  schema: JsonObject,
  example: unknown,
  schemaPath: string,
  examplePath: string,
  issues: string[],
  requireMetadata = false,
): void {
  if (typeof schema.type !== "string") {
    issues.push(`${schemaPath}.type is required`);
  }
  if (requireMetadata) {
    requireText(schema, "description", schemaPath, issues);
    if (!hasOwn(schema, "example")) {
      issues.push(`${schemaPath}.example is required`);
    }
  }
  if (schema.type === "array") {
    if (!isObject(schema.items)) {
      issues.push(`${schemaPath}.items is required for array schemas`);
    }
    if (!Array.isArray(example)) {
      issues.push(`${examplePath} must be an array`);
      return;
    }
    if (!isObject(schema.items) || Object.keys(schema.items).length === 0) {
      issues.push(`${schemaPath}.items must fully describe array elements`);
      return;
    }
    example.forEach((item, index) => validateSchemaExampleCoverage(
      schema.items as JsonObject,
      item,
      `${schemaPath}.items`,
      `${examplePath}[${index}]`,
      issues,
      true,
    ));
    return;
  }
  if (schema.type !== "object") return;

  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const additionalProperties = isObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
  const allowsAdditionalProperties = additionalProperties !== undefined || schema.additionalProperties === true;
  if (!properties && !allowsAdditionalProperties) {
    issues.push(`${schemaPath} must define properties or an additionalProperties schema`);
    return;
  }
  if (!isObject(example)) {
    issues.push(`${examplePath} must be an object matching ${schemaPath}`);
    return;
  }
  if (properties) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (!hasOwn(example, key)) {
        issues.push(`${examplePath} is missing ${key}`);
      } else if (isObject(propertySchema)) {
        validateSchemaExampleCoverage(
          propertySchema,
          example[key],
          `${schemaPath}.properties.${key}`,
          `${examplePath}.${key}`,
          issues,
          true,
        );
      } else {
        issues.push(`${schemaPath}.properties.${key} must be a JSON Schema object`);
      }
    }
  }
  for (const [key, value] of Object.entries(example)) {
    if (properties && hasOwn(properties, key)) continue;
    if (additionalProperties) {
      validateSchemaExampleCoverage(
        additionalProperties,
        value,
        `${schemaPath}.additionalProperties`,
        `${examplePath}.${key}`,
        issues,
        true,
      );
    } else if (schema.additionalProperties !== true) {
      issues.push(`${schemaPath}.properties does not define example field ${key}`);
    } else {
      // additionalProperties=true explicitly allows opaque upstream JSON.
    }
  }
}

function validateSchemaAndExample(object: JsonObject, path: string, issues: string[]): void {
  if (object.content_type !== "application/json") {
    issues.push(`${path}.content_type must be application/json`);
  }
  if (!isObject(object.schema) || Object.keys(object.schema).length === 0) {
    issues.push(`${path}.schema must be a non-empty JSON Schema`);
  }
  if (!hasOwn(object, "example")) {
    issues.push(`${path}.example is required`);
  }
  if (isObject(object.schema) && hasOwn(object, "example")) {
    validateSchemaExampleCoverage(object.schema, object.example, `${path}.schema`, `${path}.example`, issues);
  }
}

function validateParameters(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push(`${path} must be present; use [] when there are no parameters`);
    return;
  }
  if (value.length > 100) issues.push(`${path} must contain at most 100 parameters`);
  const names = new Set<string>();
  value.forEach((parameter, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(parameter)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    requireText(parameter, "name", itemPath, issues);
    requireText(parameter, "description", itemPath, issues);
    if (typeof parameter.name === "string") {
      const name = parameter.name.trim();
      if (name && names.has(name)) issues.push(`${itemPath}.name must be unique within ${path}`);
      if (name) names.add(name);
    }
    if (!["string", "integer", "number", "boolean", "array", "object"].includes(String(parameter.type))) {
      issues.push(`${itemPath}.type is unsupported`);
    }
    if (typeof parameter.required !== "boolean") issues.push(`${itemPath}.required must be boolean`);
    if (!hasOwn(parameter, "example")) issues.push(`${itemPath}.example is required`);
  });
}

function rejectInternalInputTerms(value: unknown, path: string, issues: string[]): void {
  if (typeof value === "string") {
    if (/\binput\.(?:query|header|body|cookies)\b/i.test(value)) {
      issues.push(`${path} must describe the caller contract, not the internal input envelope`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInternalInputTerms(item, `${path}[${index}]`, issues));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) rejectInternalInputTerms(item, `${path}.${key}`, issues);
  }
}

export function interfaceDocCompletenessIssues(document: unknown, operation: "create" | "update"): string[] {
  const issues: string[] = [];
  if (!isObject(document)) return ["interface_doc must be a JSON object"];
  rejectInternalInputTerms(document, "interface_doc", issues);
  if (document.schema_version !== "script-interface-doc.v1") {
    issues.push("interface_doc.schema_version must be script-interface-doc.v1");
  }
  requireText(document, "title", "interface_doc", issues);
  requireText(document, "summary", "interface_doc", issues);
  requireText(document, "logic_description", "interface_doc", issues, 20);

  let methods: unknown[] = [];
  if (!isObject(document.endpoint)) {
    issues.push("interface_doc.endpoint must be an object");
  } else {
    requireText(document.endpoint, "description", "interface_doc.endpoint", issues);
    if (!Array.isArray(document.endpoint.methods) || document.endpoint.methods.length === 0) {
      issues.push("interface_doc.endpoint.methods must contain GET or POST");
    } else {
      methods = document.endpoint.methods;
      if (methods.some((method) => method !== "GET" && method !== "POST")) {
        issues.push("interface_doc.endpoint.methods may contain only GET or POST");
      }
      if (new Set(methods).size !== methods.length) {
        issues.push("interface_doc.endpoint.methods must not contain duplicates");
      }
    }
    if (operation === "update") {
      if (typeof document.endpoint.path !== "string" || !document.endpoint.path.startsWith("/flow/codeblock/") || document.endpoint.path.includes("{script_id}")) {
        issues.push("interface_doc.endpoint.path must contain the actual script path when updating");
      }
    } else if (document.endpoint.path !== undefined && (typeof document.endpoint.path !== "string" || !document.endpoint.path.startsWith("/flow/codeblock/"))) {
      issues.push("interface_doc.endpoint.path must start with /flow/codeblock/ when provided");
    }
  }

  if (!isObject(document.request)) {
    issues.push("interface_doc.request must be an object");
  } else {
    validateParameters(document.request.query, "interface_doc.request.query", issues);
    validateParameters(document.request.headers, "interface_doc.request.headers", issues);
    if (methods.includes("POST")) {
      if (!isObject(document.request.body)) issues.push("POST documentation requires interface_doc.request.body");
      else validateSchemaAndExample(document.request.body, "interface_doc.request.body", issues);
    } else if (document.request.body !== undefined) {
      issues.push("GET-only documentation must not include interface_doc.request.body");
    }
  }

  if (!Array.isArray(document.responses) || document.responses.length === 0) {
    issues.push("interface_doc.responses must contain at least one response");
  } else {
    if (document.responses.length > 50) issues.push("interface_doc.responses must contain at most 50 responses");
    document.responses.forEach((response, index) => {
      const path = `interface_doc.responses[${index}]`;
      if (!isObject(response)) {
        issues.push(`${path} must be an object`);
        return;
      }
      if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) {
        issues.push(`${path}.status must be an integer from 100 to 599`);
      }
      requireText(response, "description", path, issues);
      validateSchemaAndExample(response, path, issues);
    });
  }
  return [...new Set(issues)];
}

export function assertCompleteInterfaceDoc(document: unknown, operation: "create" | "update"): void {
  const issues = interfaceDocCompletenessIssues(document, operation);
  if (issues.length > 0) {
    throw new Error(`interface_doc completeness validation failed:\n- ${issues.join("\n- ")}\nRules:\n- ${interfaceDocNestedRules.join("\n- ")}`);
  }
}
