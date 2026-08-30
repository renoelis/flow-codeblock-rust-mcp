import { z } from "zod";

type JsonObject = Record<string, unknown>;

export type InterfaceDocRecoveryFields = {
  responses?: unknown;
  logic_description?: unknown;
};

export type InterfaceDocNormalization = {
  document: unknown;
  changes: string[];
  recovered: {
    description?: unknown;
    ip_whitelist?: unknown;
  };
};

export const interfaceDocRequiredFields = {
  document: ["schema_version", "title", "summary", "endpoint", "responses", "logic_description"],
  endpoint: ["methods", "description"],
  request: ["query/headers/body (include only fields that actually exist)"],
  parameter: ["name", "type", "description", "example", "required (runtime requirement)"],
  body: ["content_type", "schema", "example"],
  response: ["status", "description", "content_type", "schema", "example"],
  conditionally_optional: ["request (omit when there are no query, header, or body fields)", "endpoint.path (omit on create, use the actual path on update)", "usage_refs (always optional)"],
};

export const interfaceDocNestedRules = [
  "The root Schema node for every request or response body must include type; every nested Schema node, including properties values, array.items, and object-form additionalProperties values, must include type, description, and example.",
  "Each Schema node's example must match its type, properties, and required fields; never put a complete outer response example in an inner field example.",
  "Schema keyword names must be valid standard or extension identifiers beginning with a letter or $, and damaged keys such as :{ must be removed; business property names are unrestricted.",
  "Use properties for objects whose keys are known from code or examples. Use object-form additionalProperties only for homogeneous dictionaries with runtime-only keys. Use additionalProperties=true only for opaque upstream JSON passed through unchanged; never use an empty object Schema as an arbitrary-value fallback.",
  "Every type=array node must define items with type, description, and example; object items must also define complete items.properties, and each array example object must cover those fields.",
  "Every field in any example must be declared by properties or additionalProperties and have a matching JSON type; required fields must appear in examples, while runtime-optional fields may be omitted.",
  "required declares only fields that are truly required at runtime; split success and error shapes into separate responses.",
];

export const interfaceDocRepairRules = [
  "Preserve every original interface_doc field not named by an error and repair only the reported paths; do not rewrite or remove responses, logic_description, or request to fix one field.",
  "Keep responses and logic_description at the interface_doc root; keep request.body.example beside schema, and keep properties, required, items, and additionalProperties inside schema. The normalizer repairs only unambiguous placements, derives examples from parent or snake_case/camelCase aliases, and removes invalid non-object usage_refs entries.",
  "When an object's keys are known, replace an incorrect additionalProperties shape with explicit properties. Do not nest empty additionalProperties when the parent keys are known.",
  "Documentation prose must use caller-facing URL query parameters, HTTP headers, HTTP bodies, and Cookies; internal input.query/input.header/input.body/input.cookies terms are normalized when unambiguous, while business values in example, default, and enum_values remain unchanged.",
];

export const interfaceDocInputDescription = [
  "A complete script-interface-doc.v1 is required for create and code updates; description and ip_whitelist-only updates may omit it.",
  "Root fields are schema_version='script-interface-doc.v1', title, summary, endpoint, request?, responses, logic_description, and usage_refs?. endpoint={methods,path?,description}; request={query?,headers?,body?}; query and headers are parameter arrays; body={content_type='application/json',schema,example}; each response={status,description,content_type='application/json',schema,example}.",
  "usage_refs is only for real application references, each shaped as {app_name,app_id?,location?,note?}; put normal prose in logic_description, not a string array in usage_refs.",
  `Required structure: ${Object.entries(interfaceDocRequiredFields).map(([key, fields]) => `${key}=[${fields.join(",")}]`).join("; ")}.`,
  ...interfaceDocRepairRules,
  ...interfaceDocNestedRules,
].join(" ");

const looseSchemaNode = z.looseObject({
  type: z.string().optional().describe("JSON Schema type, such as object, array, string, integer, number, or boolean."),
  description: z.string().optional().describe("Description of the business field or data structure represented by this node."),
  example: z.unknown().optional().describe("A concrete value matching this node's type."),
  properties: z.object({}).catchall(z.unknown()).optional().describe(
    "Map fixed object fields to child Schemas; each field name is a properties key.",
  ),
  items: z.unknown().optional().describe("The complete child Schema for each array item."),
  additionalProperties: z.unknown().optional().describe(
    "Use an object Schema for homogeneous dynamic-key dictionaries; true is only for opaque upstream JSON passed through unchanged, and false disallows undeclared fields.",
  ),
  required: z.array(z.string()).optional().describe("Names of properties that are truly required at runtime."),
});

const parameterInputSchema = z.looseObject({
  name: z.string().optional().describe("The query parameter or request-header name used by the caller."),
  type: z.enum(["string", "integer", "number", "boolean", "array", "object"]).optional().describe(
    "The parameter JSON type.",
  ),
  required: z.boolean().optional().describe("Whether the parameter is required at runtime."),
  description: z.string().optional().describe("The parameter's purpose and constraints."),
  example: z.unknown().optional().describe("A concrete example value for the parameter."),
  default: z.unknown().optional().describe("An optional default value."),
  format: z.string().optional().describe("An optional format hint."),
  enum_values: z.array(z.unknown()).optional().describe("An optional list of allowed values."),
});

const bodyInputSchema = z.looseObject({
  content_type: z.literal("application/json").optional().describe("Must be application/json."),
  schema: looseSchemaNode.optional().describe("The caller-facing JSON Schema for the POST body."),
  example: z.unknown().optional().describe("A complete request-body example beside schema with the same shape."),
});

const responseInputSchema = z.looseObject({
  status: z.number().int().min(100).max(599).optional().describe("HTTP status code from 100 through 599."),
  description: z.string().optional().describe("The business meaning of this response branch."),
  content_type: z.literal("application/json").optional().describe("Must be application/json."),
  schema: looseSchemaNode.optional().describe("The response-body JSON Schema."),
  example: z.unknown().optional().describe("A complete response example beside schema with the same shape."),
});

const patchPathSchema = z.string().describe("RFC 6901 JSON Pointer path; array paths use indexes in the current canonical document.");
const interfaceDocPatchOperationSchema = z.union([
  z.object({ op: z.literal("add"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("remove"), path: patchPathSchema }).strict(),
  z.object({ op: z.literal("replace"), path: patchPathSchema, value: z.unknown() }).strict(),
  z.object({ op: z.literal("move"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("copy"), from: patchPathSchema, path: patchPathSchema }).strict(),
  z.object({ op: z.literal("test"), path: patchPathSchema, value: z.unknown() }).strict(),
]);

export const interfaceDocPatchSchema = z.array(interfaceDocPatchOperationSchema)
  .min(1)
  .max(256)
  .describe("An ordered RFC 6902 JSON Patch operation array; mutually exclusive with a complete interface_doc.");

export const interfaceDocToolInputSchema = z.looseObject({
  schema_version: z.literal("script-interface-doc.v1").optional().describe("The fixed document contract version."),
  title: z.string().optional().describe("The interface-document title."),
  summary: z.string().optional().describe("A one-sentence caller-facing summary."),
  endpoint: z.looseObject({
    methods: z.array(z.enum(["GET", "POST"])).optional().describe("HTTP methods supported by the endpoint."),
    path: z.string().optional().describe("The actual /flow/codeblock/{script_id} path for updates."),
    description: z.string().optional().describe("What the endpoint does."),
  }).optional().describe("The script HTTP endpoint contract."),
  request: z.looseObject({
    query: z.array(parameterInputSchema).optional().describe("Caller-facing URL query parameters."),
    headers: z.array(parameterInputSchema).optional().describe("Caller-facing business request headers."),
    body: bodyInputSchema.optional().describe("POST body; example must be beside schema."),
  }).optional().describe("Caller request contract; only query, headers, and body are allowed."),
  responses: z.array(responseInputSchema).optional().describe("Complete response branches at the interface_doc root."),
  logic_description: z.string().optional().describe("Endpoint processing logic at the interface_doc root; at least 20 characters."),
  usage_refs: z.array(z.unknown()).optional().describe(
    "Array of real application references, each {app_name,app_id?,location?,note?}; do not put ordinary prose here.",
  ),
}).describe(interfaceDocInputDescription);

export function assertInterfaceDocPatch(patch: unknown): void {
  const parsed = interfaceDocPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(`Invalid interface_doc_patch format: ${parsed.error.message}`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

const schemaPlacementKeys = ["properties", "required", "items", "additionalProperties"] as const;

function comparableFieldName(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

function normalizeSchemaNodeExamples(
  schema: JsonObject,
  example: unknown,
  path: string,
  changes: string[],
): void {
  if (schema.type === "array" && isObject(schema.items)) {
    if (!hasOwn(schema.items, "example") && Array.isArray(example) && example.length > 0) {
      schema.items.example = structuredClone(example[0]);
      changes.push(`${path}.items.example was filled from the first array example item`);
    }
    normalizeSchemaNodeExamples(schema.items, schema.items.example, `${path}.items`, changes);
    return;
  }

  if (schema.type !== "object") return;
  const misplacedRequired = isObject(schema.properties) && Array.isArray(schema.properties.required)
    ? schema.properties.required
    : undefined;
  if (misplacedRequired && misplacedRequired.every((field) => typeof field === "string")) {
    if (!hasOwn(schema, "required")) {
      schema.required = structuredClone(misplacedRequired);
      changes.push(`${path}.properties.required moved to ${path}.required`);
    } else {
      changes.push(`${path}.properties.required removed because ${path}.required already exists`);
    }
    delete (schema.properties as JsonObject).required;
  }
  const misplacedAdditionalProperties = isObject(schema.properties)
    ? schema.properties.additionalProperties
    : undefined;
  if (typeof misplacedAdditionalProperties === "boolean") {
    if (!hasOwn(schema, "additionalProperties")) {
      schema.additionalProperties = misplacedAdditionalProperties;
      changes.push(`${path}.properties.additionalProperties moved to ${path}.additionalProperties`);
    } else {
      changes.push(`${path}.properties.additionalProperties removed because ${path}.additionalProperties already exists`);
    }
    delete (schema.properties as JsonObject).additionalProperties;
  }
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const objectExample = isObject(example) ? example : undefined;
  if (properties) {
    const entries = Object.entries(properties);

    for (const [key, propertySchema] of entries) {
      if (
        isObject(propertySchema) &&
        !hasOwn(propertySchema, "example") &&
        objectExample &&
        hasOwn(objectExample, key)
      ) {
        propertySchema.example = structuredClone(objectExample[key]);
        changes.push(`${path}.properties.${key}.example was filled from the parent example`);
      }
    }

    // Resolve aliases only after every property has had a chance to use the parent example.
    for (const [key, propertySchema] of entries) {
      if (!isObject(propertySchema)) continue;
      if (!hasOwn(propertySchema, "example")) {
        const alias = entries.find(([candidateKey, candidateSchema]) => (
          candidateKey !== key &&
          comparableFieldName(candidateKey) === comparableFieldName(key) &&
          isObject(candidateSchema) &&
          hasOwn(candidateSchema, "example")
        ));
        if (alias && isObject(alias[1])) {
          propertySchema.example = structuredClone(alias[1].example);
          changes.push(`${path}.properties.${key}.example was filled from alias ${path}.properties.${alias[0]}.example`);
        }
      }
    }

    for (const [key, propertySchema] of entries) {
      if (!isObject(propertySchema)) continue;
      normalizeSchemaNodeExamples(
        propertySchema,
        propertySchema.example,
        `${path}.properties.${key}`,
        changes,
      );
    }
  }

  if (isObject(schema.additionalProperties)) {
    const knownKeys = new Set(properties ? Object.keys(properties) : []);
    const dynamicExample = objectExample
      ? Object.entries(objectExample).find(([key]) => !knownKeys.has(key))?.[1]
      : undefined;
    if (!hasOwn(schema.additionalProperties, "example") && dynamicExample !== undefined) {
      schema.additionalProperties.example = structuredClone(dynamicExample);
      changes.push(`${path}.additionalProperties.example was filled from a dynamic-field example`);
    }
    normalizeSchemaNodeExamples(
      schema.additionalProperties,
      schema.additionalProperties.example,
      `${path}.additionalProperties`,
      changes,
    );
  }
}

function exampleMatchesType(type: unknown, example: unknown): boolean {
  switch (type) {
    case "array": return Array.isArray(example);
    case "object": return isObject(example);
    case "string": return typeof example === "string";
    case "integer": return typeof example === "number" && Number.isInteger(example);
    case "number": return typeof example === "number";
    case "boolean": return typeof example === "boolean";
    case "null": return example === null;
    default: return true;
  }
}

function isRootObjectExample(schema: JsonObject, example: unknown, ignoredProperty?: string): boolean {
  if (schema.type !== "object" || !isObject(schema.properties) || !isObject(example)) return false;
  const propertyNames = new Set(Object.keys(schema.properties).filter((name) => name !== ignoredProperty));
  const exampleNames = Object.keys(example);
  return exampleNames.length > 0 && exampleNames.every((name) => propertyNames.has(name));
}

function recoverMisplacedContainerExample(container: JsonObject, path: string, changes: string[]): void {
  if (hasOwn(container, "example") || !isObject(container.schema) || !isObject(container.schema.properties)) return;

  const schema = container.schema;
  const properties = schema.properties;
  if (
    hasOwn(properties, "example") &&
    isRootObjectExample(schema, properties.example, "example")
  ) {
    container.example = structuredClone(properties.example);
    delete properties.example;
    changes.push(`${path}.example was promoted from ${path}.schema.properties.example`);
    return;
  }

  for (const [name, propertySchema] of Object.entries(properties)) {
    if (
      !isObject(propertySchema) ||
      !hasOwn(propertySchema, "example") ||
      exampleMatchesType(propertySchema.type, propertySchema.example) ||
      !isRootObjectExample(schema, propertySchema.example)
    ) {
      continue;
    }
    container.example = structuredClone(propertySchema.example);
    delete propertySchema.example;
    changes.push(`${path}.example was promoted from misplaced ${path}.schema.properties.${name}.example`);
    return;
  }
}

function normalizeSchemaContainer(container: JsonObject, path: string, changes: string[]): void {
  if (!isObject(container.schema)) return;

  for (const key of schemaPlacementKeys) {
    if (hasOwn(container, key) && !hasOwn(container.schema, key)) {
      container.schema[key] = container[key];
      delete container[key];
      changes.push(`${path}.${key} moved to ${path}.schema.${key}`);
    }
  }

  if (!hasOwn(container, "example") && hasOwn(container.schema, "example")) {
    container.example = structuredClone(container.schema.example);
    changes.push(`${path}.example was promoted from ${path}.schema.example`);
  }
  recoverMisplacedContainerExample(container, path, changes);
  normalizeSchemaNodeExamples(container.schema, container.example, `${path}.schema`, changes);
}

function normalizeUsageRefs(document: JsonObject, changes: string[]): void {
  if (!Array.isArray(document.usage_refs)) return;
  const validRefs = document.usage_refs.filter(isObject);
  const removedCount = document.usage_refs.length - validRefs.length;
  if (removedCount === 0) return;

  if (validRefs.length === 0) {
    delete document.usage_refs;
  } else {
    document.usage_refs = validRefs;
  }
  changes.push(
    `Removed ${removedCount} non-object entries from interface_doc.usage_refs; ordinary prose belongs in logic_description`,
  );
}

const documentationProseKeys = new Set(["summary", "description", "logic_description", "note"]);
const documentationValueKeys = new Set(["example", "default", "enum_values"]);
const internalInputTermPattern = /\binput\.(?:query|header|body|cookies)\b/i;
const internalInputPhraseReplacements: Array<[RegExp, string]> = [
  [/\u4ece\s*\binput\.query\b\s*\u8bfb\u53d6(?:URL\s*)?\u67e5\u8be2\u53c2\u6570/gi, "URL query parameters"],
  [/\u4ece\s*\binput\.header\b\s*\u8bfb\u53d6(?:HTTP\s*)?\u8bf7\u6c42\u5934/gi, "HTTP headers"],
  [/\u4ece\s*\binput\.body\b\s*\u8bfb\u53d6(?:HTTP\s*)?\u8bf7\u6c42\u4f53/gi, "HTTP body"],
  [/\u4ece\s*\binput\.cookies\b\s*\u8bfb\u53d6\s*Cookie/gi, "Cookies"],
];
const internalInputTermReplacements: Array<[RegExp, string]> = [
  [/\binput\.query\b/gi, "URL query parameters"],
  [/\binput\.header\b/gi, "HTTP headers"],
  [/\binput\.body\b/gi, "HTTP body"],
  [/\binput\.cookies\b/gi, "Cookies"],
];

function publicDocumentationText(value: string): string {
  const phraseRewritten = internalInputPhraseReplacements.reduce(
    (rewritten, [pattern, replacement]) => rewritten.replace(pattern, replacement),
    value,
  );
  const rewritten = internalInputTermReplacements.reduce(
    (rewritten, [pattern, replacement]) => rewritten.replace(pattern, replacement),
    phraseRewritten,
  );
  return rewritten
    .replace(/(URL query parameters|HTTP headers|HTTP body|Cookies)\s+(?=[\u3400-\u9fff])/g, "$1");
}

function normalizeInternalInputTerms(value: unknown, path: string, changes: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => normalizeInternalInputTerms(item, `${path}[${index}]`, changes));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (documentationProseKeys.has(key) && typeof item === "string") {
      const rewritten = publicDocumentationText(item);
      if (rewritten !== item) {
        value[key] = rewritten;
        changes.push(`${itemPath} converted an internal input term to caller-facing HTTP terminology`);
      }
      continue;
    }
    if (!documentationValueKeys.has(key)) {
      normalizeInternalInputTerms(item, itemPath, changes);
    }
  }
}

function recoverInterfaceDocRootFields(
  document: JsonObject,
  recoveryFields: InterfaceDocRecoveryFields,
  changes: string[],
): void {
  for (const key of ["responses", "logic_description"] as const) {
    if (recoveryFields[key] === undefined) continue;
    if (hasOwn(document, key)) {
      changes.push(`Tool-level ${key} was ignored because interface_doc.${key} already exists`);
      continue;
    }
    document[key] = structuredClone(recoveryFields[key]);
    changes.push(`Tool-level ${key} moved to interface_doc.${key}`);
  }
}

function recoverDocumentRootFields(
  document: JsonObject,
  container: JsonObject,
  path: string,
  changes: string[],
): void {
  for (const key of ["responses", "logic_description"] as const) {
    if (!hasOwn(container, key)) continue;
    if (hasOwn(document, key)) {
      delete container[key];
      changes.push(`${path}.${key} removed because interface_doc.${key} already exists`);
      continue;
    }
    document[key] = container[key];
    delete container[key];
    changes.push(`${path}.${key} moved to interface_doc.${key}`);
  }
}

function recoverToolField(
  container: JsonObject,
  path: string,
  key: "description" | "ip_whitelist",
  recovered: InterfaceDocNormalization["recovered"],
  changes: string[],
): void {
  if (!hasOwn(container, key)) return;
  if (!hasOwn(recovered, key)) recovered[key] = container[key];
  delete container[key];
  changes.push(`${path}.${key} moved back to flow_preview_script_change.${key}`);
}

export function normalizeInterfaceDocument(
  document: unknown,
  recoveryFields: InterfaceDocRecoveryFields = {},
): InterfaceDocNormalization {
  if (!isObject(document)) return { document, changes: [], recovered: {} };

  const normalized = structuredClone(document) as JsonObject;
  const changes: string[] = [];
  const recovered: InterfaceDocNormalization["recovered"] = {};
  recoverToolField(normalized, "interface_doc", "description", recovered, changes);
  recoverToolField(normalized, "interface_doc", "ip_whitelist", recovered, changes);
  const request = isObject(normalized.request) ? normalized.request : undefined;
  const body = request && isObject(request.body) ? request.body : undefined;
  const bodySchema = body && isObject(body.schema) ? body.schema : undefined;
  if (request) recoverToolField(request, "interface_doc.request", "description", recovered, changes);
  if (request) recoverToolField(request, "interface_doc.request", "ip_whitelist", recovered, changes);
  if (body) recoverToolField(body, "interface_doc.request.body", "description", recovered, changes);
  if (body) recoverToolField(body, "interface_doc.request.body", "ip_whitelist", recovered, changes);
  if (bodySchema) recoverToolField(bodySchema, "interface_doc.request.body.schema", "ip_whitelist", recovered, changes);
  if (request) recoverDocumentRootFields(normalized, request, "interface_doc.request", changes);
  if (body) recoverDocumentRootFields(normalized, body, "interface_doc.request.body", changes);
  if (bodySchema) recoverDocumentRootFields(normalized, bodySchema, "interface_doc.request.body.schema", changes);
  recoverInterfaceDocRootFields(normalized, recoveryFields, changes);
  normalizeUsageRefs(normalized, changes);
  if (isObject(normalized.request) && isObject(normalized.request.body)) {
    if (hasOwn(normalized.request, "example")) {
      if (!hasOwn(normalized.request.body, "example")) {
        normalized.request.body.example = structuredClone(normalized.request.example);
        changes.push("interface_doc.request.example moved to interface_doc.request.body.example");
      } else {
        changes.push("interface_doc.request.example removed because interface_doc.request.body.example already exists");
      }
      delete normalized.request.example;
    }
    normalizeSchemaContainer(normalized.request.body, "interface_doc.request.body", changes);
  }
  if (Array.isArray(normalized.responses)) {
    normalized.responses.forEach((response, index) => {
      if (isObject(response)) {
        const responsePath = `interface_doc.responses[${index}]`;
        if (hasOwn(response, "responses_placeholder") && response.responses_placeholder === null) {
          delete response.responses_placeholder;
          changes.push(`${responsePath}.responses_placeholder empty placeholder removed`);
        }
        normalizeSchemaContainer(response, responsePath, changes);
      }
    });
  }
  normalizeInternalInputTerms(normalized, "interface_doc", changes);
  return { document: normalized, changes, recovered };
}

function requireText(object: JsonObject, key: string, path: string, issues: string[], minLength = 1): void {
  const value = object[key];
  if (typeof value !== "string" || value.trim().length < minLength) {
    issues.push(`${path}.${key} must be a non-empty string with at least ${minLength} character(s)`);
  }
}

function rejectUnsupportedFields(
  object: JsonObject,
  supportedFields: readonly string[],
  path: string,
  issues: string[],
): void {
  for (const key of Object.keys(object)) {
    if (!supportedFields.includes(key)) {
      issues.push(`${path}.${key} is not a supported field`);
    }
  }
}

function validateFieldSchemaMetadata(schema: JsonObject, schemaPath: string, issues: string[]): void {
  if (typeof schema.type !== "string" || schema.type.trim().length === 0) {
    issues.push(`${schemaPath}.type is required`);
  }
  requireText(schema, "description", schemaPath, issues);
  if (!hasOwn(schema, "example")) {
    issues.push(`${schemaPath}.example must provide a field example`);
  }
}

function validateSchemaExampleCoverage(
  schema: JsonObject,
  example: unknown,
  schemaPath: string,
  examplePath: string,
  issues: string[],
  root = true,
  metadataValidated = false,
): void {
  if (root) {
    if (typeof schema.type !== "string" || schema.type.trim().length === 0) {
      issues.push(`${schemaPath}.type is required`);
    }
  } else if (!metadataValidated) {
    validateFieldSchemaMetadata(schema, schemaPath, issues);
  }

  if (
    schema.type !== "array" &&
    schema.type !== "object" &&
    !exampleMatchesType(schema.type, example)
  ) {
    issues.push(`${examplePath} must match ${schemaPath}.type=${String(schema.type)}`);
    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(example)) {
      issues.push(`${examplePath} must be an array`);
      return;
    }
    if (!isObject(schema.items) || Object.keys(schema.items).length === 0) {
      issues.push(`${schemaPath}.items must fully describe array elements`);
      return;
    }
    validateFieldSchemaMetadata(schema.items, `${schemaPath}.items`, issues);
    example.forEach((item, index) => validateSchemaExampleCoverage(
      schema.items as JsonObject,
      item,
      `${schemaPath}.items`,
      `${examplePath}[${index}]`,
      issues,
      false,
      true,
    ));
    return;
  }

  if (schema.type !== "object") return;
  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const additionalPropertiesValue = schema.additionalProperties;
  const additionalProperties = isObject(additionalPropertiesValue) ? additionalPropertiesValue : undefined;
  const allowsOpaqueProperties = additionalPropertiesValue === true;
  if (
    hasOwn(schema, "additionalProperties") &&
    typeof additionalPropertiesValue !== "boolean" &&
    !additionalProperties
  ) {
    issues.push(`${schemaPath}.additionalProperties must be a boolean or object Schema`);
  }
  if (!properties && !additionalProperties && !allowsOpaqueProperties) {
    issues.push(`${schemaPath} must use properties for fixed fields, object-form additionalProperties for homogeneous dynamic keys, or additionalProperties=true for opaque upstream JSON`);
    return;
  }
  if (!isObject(example)) {
    issues.push(`${examplePath} must be an object matching ${schemaPath}.properties`);
    return;
  }

  if (additionalProperties) {
    validateFieldSchemaMetadata(additionalProperties, `${schemaPath}.additionalProperties`, issues);
  }

  if (properties) {
    const requiredFields = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((field): field is string => typeof field === "string")
        : [],
    );
    for (const [key, propertySchema] of Object.entries(properties)) {
      const propertyPath = `${schemaPath}.properties.${key}`;
      if (!isObject(propertySchema)) {
        issues.push(`${propertyPath} must be an object Schema with type, description, and example`);
        continue;
      }
      validateFieldSchemaMetadata(propertySchema, propertyPath, issues);
      if (!hasOwn(example, key)) {
        if (requiredFields.has(key)) {
          issues.push(`${examplePath} is missing required field ${key}`);
        }
      } else {
        validateSchemaExampleCoverage(propertySchema, example[key], propertyPath, `${examplePath}.${key}`, issues, false, true);
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
        false,
        true,
      );
    } else if (allowsOpaqueProperties) {
      continue;
    } else {
      issues.push(`${schemaPath}.properties is missing a Schema for field ${key}`);
    }
  }
}

const schemaKeywordPattern = /^\$?[A-Za-z][A-Za-z0-9_.-]*$/;

function validateSchemaKeywordNames(schema: JsonObject, path: string, issues: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!schemaKeywordPattern.test(key)) {
      issues.push(`${path}.${key} is not a valid JSON Schema keyword`);
    }
  }

  if (isObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (isObject(propertySchema)) {
        validateSchemaKeywordNames(propertySchema, `${path}.properties.${name}`, issues);
      }
    }
  }
  if (isObject(schema.items)) {
    validateSchemaKeywordNames(schema.items, `${path}.items`, issues);
  }
  if (isObject(schema.additionalProperties)) {
    validateSchemaKeywordNames(schema.additionalProperties, `${path}.additionalProperties`, issues);
  }
}

function validateDeclaredSchemaExamples(schema: JsonObject, path: string, issues: string[]): void {
  if (hasOwn(schema, "example")) {
    validateSchemaExampleCoverage(
      schema,
      schema.example,
      path,
      `${path}.example`,
      issues,
      false,
      true,
    );
  }

  if (isObject(schema.properties)) {
    for (const [name, propertySchema] of Object.entries(schema.properties)) {
      if (isObject(propertySchema)) {
        validateDeclaredSchemaExamples(propertySchema, `${path}.properties.${name}`, issues);
      }
    }
  }
  if (isObject(schema.items)) {
    validateDeclaredSchemaExamples(schema.items, `${path}.items`, issues);
  }
  if (isObject(schema.additionalProperties)) {
    validateDeclaredSchemaExamples(schema.additionalProperties, `${path}.additionalProperties`, issues);
  }
}

function validateSchemaAndExample(object: JsonObject, path: string, issues: string[]): void {
  if (object.content_type !== "application/json") {
    issues.push(`${path}.content_type must be application/json`);
  }
  if (!isObject(object.schema) || Object.keys(object.schema).length === 0) {
    issues.push(`${path}.schema must be a non-empty request or response JSON Schema`);
  }
  if (!hasOwn(object, "example")) {
    issues.push(`${path}.example must provide a complete value matching schema`);
  }
  if (isObject(object.schema)) {
    validateSchemaKeywordNames(object.schema, `${path}.schema`, issues);
    validateDeclaredSchemaExamples(object.schema, `${path}.schema`, issues);
    if (hasOwn(object, "example")) {
      validateSchemaExampleCoverage(object.schema, object.example, `${path}.schema`, `${path}.example`, issues);
    }
  }
}

function validateParameters(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push(`${path} must be an array when provided`);
    return;
  }
  value.forEach((parameter, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(parameter)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    rejectUnsupportedFields(
      parameter,
      ["name", "type", "required", "description", "example", "default", "format", "enum_values"],
      itemPath,
      issues,
    );
    requireText(parameter, "name", itemPath, issues);
    requireText(parameter, "description", itemPath, issues);
    if (!["string", "integer", "number", "boolean", "array", "object"].includes(String(parameter.type))) {
      issues.push(`${itemPath}.type must be a supported parameter type`);
    }
    if (typeof parameter.required !== "boolean") {
      issues.push(`${itemPath}.required must be a boolean`);
    }
    if (!hasOwn(parameter, "example")) {
      issues.push(`${itemPath}.example must provide a concrete example value`);
    }
  });
}

function validateUsageRefs(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push("interface_doc.usage_refs must be an array of objects when provided");
    return;
  }
  if (value.length > 100) {
    issues.push("interface_doc.usage_refs may contain at most 100 entries");
  }
  value.forEach((usageRef, index) => {
    const path = `interface_doc.usage_refs[${index}]`;
    if (!isObject(usageRef)) {
      issues.push(`${path} must be an object`);
      return;
    }
    requireText(usageRef, "app_name", path, issues);
    for (const key of ["app_id", "location", "note"]) {
      if (usageRef[key] !== undefined && typeof usageRef[key] !== "string") {
        issues.push(`${path}.${key} must be a string when provided`);
      }
    }
    for (const key of Object.keys(usageRef)) {
      if (!["app_id", "app_name", "location", "note"].includes(key)) {
        issues.push(`${path}.${key} is not a supported field`);
      }
    }
  });
}

function rejectInternalInputTerms(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectInternalInputTerms(item, `${path}[${index}]`, issues));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, item] of Object.entries(value)) {
    const itemPath = `${path}.${key}`;
    if (
      documentationProseKeys.has(key) &&
      typeof item === "string" &&
      internalInputTermPattern.test(item)
    ) {
      issues.push(`${itemPath} is caller-facing prose and must not contain internal input.query/input.header/input.body/input.cookies structures`);
    }
    if (!documentationValueKeys.has(key)) {
      rejectInternalInputTerms(item, itemPath, issues);
    }
  }
}

export function interfaceDocCompletenessIssues(
  document: unknown,
  operation: "create" | "update",
): string[] {
  const issues: string[] = [];
  if (!isObject(document)) return ["interface_doc must be a JSON object"];

  rejectInternalInputTerms(document, "interface_doc", issues);
  rejectUnsupportedFields(
    document,
    ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description", "usage_refs"],
    "interface_doc",
    issues,
  );

  if (document.schema_version !== "script-interface-doc.v1") {
    issues.push("interface_doc.schema_version must be script-interface-doc.v1");
  }
  requireText(document, "title", "interface_doc", issues);
  requireText(document, "summary", "interface_doc", issues);
  requireText(document, "logic_description", "interface_doc", issues, 20);
  validateUsageRefs(document.usage_refs, issues);

  let methods: unknown[] = [];
  if (!isObject(document.endpoint)) {
    issues.push("interface_doc.endpoint must be an object");
  } else {
    rejectUnsupportedFields(document.endpoint, ["methods", "path", "description"], "interface_doc.endpoint", issues);
    requireText(document.endpoint, "description", "interface_doc.endpoint", issues);
    if (!Array.isArray(document.endpoint.methods) || document.endpoint.methods.length === 0) {
      issues.push("interface_doc.endpoint.methods must contain GET or POST");
    } else {
      methods = document.endpoint.methods;
      if (methods.some((method) => method !== "GET" && method !== "POST")) {
        issues.push("interface_doc.endpoint.methods may contain only GET or POST");
      }
    }
    if (operation === "update") {
      if (
        typeof document.endpoint.path !== "string" ||
        !document.endpoint.path.startsWith("/flow/codeblock/") ||
        document.endpoint.path.includes("{script_id}")
      ) {
        issues.push("interface_doc.endpoint.path must be the actual /flow/codeblock/{script_id} path when updating");
      }
    } else if (
      document.endpoint.path !== undefined &&
      (typeof document.endpoint.path !== "string" || !document.endpoint.path.startsWith("/flow/codeblock/"))
    ) {
      issues.push("interface_doc.endpoint.path must start with /flow/codeblock/ when provided");
    }
  }

  const hasPost = methods.includes("POST");
  if (document.request === undefined) {
    // No request fields need documenting.
  } else if (!isObject(document.request)) {
    issues.push("interface_doc.request must be an object when provided");
  } else {
    rejectUnsupportedFields(document.request, ["query", "headers", "body"], "interface_doc.request", issues);
    validateParameters(document.request.query, "interface_doc.request.query", issues);
    validateParameters(document.request.headers, "interface_doc.request.headers", issues);
    if (document.request.body !== undefined) {
      if (!hasPost) {
        issues.push("GET-only endpoints must not define interface_doc.request.body");
      } else if (!isObject(document.request.body)) {
        issues.push("interface_doc.request.body must be an object when provided");
      } else {
        rejectUnsupportedFields(
          document.request.body,
          ["content_type", "schema", "example"],
          "interface_doc.request.body",
          issues,
        );
        validateSchemaAndExample(document.request.body, "interface_doc.request.body", issues);
      }
    }
  }

  if (!Array.isArray(document.responses) || document.responses.length === 0) {
    issues.push("interface_doc.responses must contain at least one complete response");
  } else {
    document.responses.forEach((response, index) => {
      const path = `interface_doc.responses[${index}]`;
      if (!isObject(response)) {
        issues.push(`${path} must be an object`);
        return;
      }
      rejectUnsupportedFields(response, ["status", "description", "content_type", "schema", "example"], path, issues);
      if (!Number.isInteger(response.status) || Number(response.status) < 100 || Number(response.status) > 599) {
        issues.push(`${path}.status must be an integer from 100 through 599`);
      }
      requireText(response, "description", path, issues);
      validateSchemaAndExample(response, path, issues);
    });
  }

  return [...new Set(issues)].sort();
}

function formatInterfaceDocIssues(issues: string[]): string {
  const details = issues.map((issue) => {
    const separator = issue.indexOf(" ");
    if (separator <= 0) {
      return { path: "interface_doc", problem: issue, required_fix: "Correct the reported document value." };
    }
    return {
      path: issue.slice(0, separator),
      problem: issue.slice(separator + 1),
      required_fix: "Correct this path according to the script-interface-doc.v1 Schema.",
    };
  });
  return JSON.stringify(details, null, 2);
}

export function assertCompleteInterfaceDoc(document: unknown, operation: "create" | "update"): void {
  const issues = interfaceDocCompletenessIssues(document, operation);
  if (issues.length > 0) {
    throw new Error(
      `interface_doc validation failed. Correct only the listed paths and preserve all other fields:\n${formatInterfaceDocIssues(issues)}`,
    );
  }
}
