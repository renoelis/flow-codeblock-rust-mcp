import { describe, expect, test } from "bun:test";
import { codeWriterContext } from "./code-writer";

const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== "object" || Array.isArray(field)) {
    throw new Error(`${key} must be an object`);
  }
  return field as Record<string, unknown>;
}

describe("codeWriterContext", () => {
  test("does not include preset business examples", () => {
    const context = codeWriterContext("script", "按用户需求创建接口");
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("u_10001");
    expect(serialized).not.toContain("Alice");
    expect(serialized).not.toContain("complete_example");
  });

  test("uses the configured MCP base URL without asking for a user domain", () => {
    const context = codeWriterContext("script", "按用户需求创建接口");
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("FLOW_CODEBLOCK_BASE_URL");
    expect(serialized).toContain("data.script_url");
    expect(serialized).not.toContain("ask the user for a domain");
  });

  test("distinguishes fixed objects from homogeneous dynamic dictionaries", () => {
    const context = codeWriterContext("script", "创建包含嵌套对象的接口");
    const rules = objectField(context, "authoritative_rules");
    expect(rules.content).toContain("Known object keys use `properties`");
    expect(rules.content).toContain("empty object Schema as an arbitrary-value fallback");
    expect(rules.content).toContain("Keep successful and error shapes in separate responses");
  });

  test("requires complete latest source after every non-script update", () => {
    const context = codeWriterContext("non_script", "更新现有代码");
    const rules = objectField(context, "authoritative_rules");
    expect(rules.content).toContain("complete latest JavaScript source produced in the current turn");
    expect(rules.content).toContain("Never return only a patch, changed fragment, explanation, or execution result");
  });

  test("returns AGENT_PROMPT.md verbatim as the authoritative rule source", async () => {
    const expectedPrompt = await Bun.file(new URL("AGENT_PROMPT.md", referencesDirectory)).text();
    const context = codeWriterContext("non_script", "处理输入");
    const authoritativeRules = objectField(context, "authoritative_rules");

    expect(context.contract_version).toBe("flow-code-writer.v4");
    expect(authoritativeRules.source).toBe("skills/flow-codeblock/references/AGENT_PROMPT.md");
    expect(authoritativeRules.content).toBe(expectedPrompt);
  });

  test("returns the dangerous-pattern rules needed to avoid safe-looking forbidden members", async () => {
    const expectedPatterns = JSON.parse(
      await Bun.file(new URL("dangerous_patterns.json", referencesDirectory)).text(),
    );
    const context = codeWriterContext("non_script", "解析日期");
    const patterns = objectField(context, "dangerous_patterns");

    expect(patterns.source).toBe("skills/flow-codeblock/references/dangerous_patterns.json");
    expect(patterns.value).toEqual(expectedPatterns);
    expect(objectField(patterns.value as Record<string, unknown>, "identifiers").exec).toBe("exec detected");
  });

  test("returns the parsed authoritative interface schema only when requested", async () => {
    const expectedSchema = JSON.parse(
      await Bun.file(new URL("script-interface-doc.schema.json", referencesDirectory)).text(),
    );
    const compactContext = codeWriterContext("script", "创建脚本");
    const fullContext = codeWriterContext("script", "创建脚本", true);
    const compactSchema = objectField(compactContext, "interface_document_schema");
    const fullSchema = objectField(fullContext, "interface_document_schema");
    const compactPatchSchema = objectField(compactContext, "interface_document_patch_schema");
    const fullPatchSchema = objectField(fullContext, "interface_document_patch_schema");

    expect(compactSchema.included).toBe(false);
    expect(compactSchema).not.toHaveProperty("value");
    expect(fullSchema.included).toBe(true);
    expect(fullSchema.value).toEqual(expectedSchema);
    expect(compactPatchSchema.included).toBe(false);
    expect(compactPatchSchema).not.toHaveProperty("value");
    expect(fullPatchSchema.included).toBe(true);
    expect(fullPatchSchema.value).toEqual(JSON.parse(
      await Bun.file(new URL("script-interface-doc.patch.schema.json", referencesDirectory)).text(),
    ));
  });
});
