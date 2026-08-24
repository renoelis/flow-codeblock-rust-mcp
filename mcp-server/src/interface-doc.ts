type JsonObject = Record<string, unknown>;

export const interfaceDocRequiredFields = {
  document: ["schema_version", "title", "summary", "endpoint", "request", "responses", "logic_description"],
  endpoint: ["methods", "description"],
  request: ["query", "headers", "body (POST only)"],
  parameter: ["name", "type", "required", "description", "example"],
  body: ["content_type", "schema", "example"],
  response: ["status", "description", "content_type", "schema", "example"],
  optional: ["endpoint.path (omit on create; actual path on update)", "usage_refs"],
};

export const interfaceDocNestedRules = [
  "Every JSON Schema node declares type. Object schemas use properties for fixed fields or a complete additionalProperties schema for dynamic keys.",
  "Every array schema has items. Object array items have complete properties, and every example item covers those properties.",
  "At every nesting level, schema properties and example fields cover each other. Optional properties still appear in the complete example.",
  "required contains only runtime-required fields. Use separate responses when success and error payloads have different shapes.",
];

export const interfaceDocInputDescription = [
  "A complete script-interface-doc.v1 document is required when creating a script or changing code.",
  `Required structure: ${Object.entries(interfaceDocRequiredFields).map(([key, fields]) => `${key}=[${fields.join(", ")}]`).join("; ")}.`,
  ...interfaceDocNestedRules,
].join(" ");

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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
): void {
  if (typeof schema.type !== "string") {
    issues.push(`${schemaPath}.type is required`);
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
    example.forEach((item, index) => validateSchemaExampleCoverage(
      schema.items as JsonObject,
      item,
      `${schemaPath}.items`,
      `${examplePath}[${index}]`,
      issues,
    ));
    return;
  }
  if (schema.type !== "object") return;

  const properties = isObject(schema.properties) ? schema.properties : undefined;
  const additionalProperties = isObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
  if (!properties && !additionalProperties) {
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
        );
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
      );
    } else {
      issues.push(`${schemaPath}.properties does not define example field ${key}`);
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
  value.forEach((parameter, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isObject(parameter)) {
      issues.push(`${itemPath} must be an object`);
      return;
    }
    requireText(parameter, "name", itemPath, issues);
    requireText(parameter, "description", itemPath, issues);
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
  return issues;
}

export function assertCompleteInterfaceDoc(document: unknown, operation: "create" | "update"): void {
  const issues = interfaceDocCompletenessIssues(document, operation);
  if (issues.length > 0) {
    throw new Error(`interface_doc completeness validation failed:\n- ${issues.join("\n- ")}\nRules:\n- ${interfaceDocNestedRules.join("\n- ")}`);
  }
}
