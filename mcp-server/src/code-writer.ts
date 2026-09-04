const agentPromptSource = "skills/flow-codeblock/references/AGENT_PROMPT.md";
const dangerousPatternsSource = "skills/flow-codeblock/references/dangerous_patterns.json";
const moduleBlacklistSource = "skills/flow-codeblock/references/module_blacklist.json";
const interfaceDocSchemaSource = "skills/flow-codeblock/references/script-interface-doc.schema.json";
const interfaceDocPatchSchemaSource = "skills/flow-codeblock/references/script-interface-doc.patch.schema.json";
const referencesDirectory = new URL("../../skills/flow-codeblock/references/", import.meta.url);

async function readRequiredReference(fileName: string): Promise<string> {
  const contents = await Bun.file(new URL(fileName, referencesDirectory)).text();
  if (contents.trim().length === 0) {
    throw new Error(`Flow Codeblock reference file is empty: ${fileName}`);
  }
  return contents;
}

export const agentPrompt = await readRequiredReference("AGENT_PROMPT.md");

const dangerousPatternsText = await readRequiredReference("dangerous_patterns.json");
export const dangerousPatterns: unknown = (() => {
  try {
    return JSON.parse(dangerousPatternsText);
  } catch (error) {
    throw new Error(`Flow Codeblock dangerous-pattern rules are invalid JSON: ${String(error)}`);
  }
})();

const moduleBlacklistText = await readRequiredReference("module_blacklist.json");
export const moduleBlacklist: unknown = (() => {
  try {
    return JSON.parse(moduleBlacklistText);
  } catch (error) {
    throw new Error(`Flow Codeblock module blacklist is invalid JSON: ${String(error)}`);
  }
})();

const interfaceDocSchemaText = await readRequiredReference("script-interface-doc.schema.json");
export const interfaceDocSchema: unknown = (() => {
  try {
    return JSON.parse(interfaceDocSchemaText);
  } catch (error) {
    throw new Error(`Flow Codeblock interface document schema is invalid JSON: ${String(error)}`);
  }
})();

const interfaceDocPatchSchemaText = await readRequiredReference("script-interface-doc.patch.schema.json");
export const interfaceDocPatchSchema: unknown = (() => {
  try {
    return JSON.parse(interfaceDocPatchSchemaText);
  } catch (error) {
    throw new Error(`Flow Codeblock interface document patch schema is invalid JSON: ${String(error)}`);
  }
})();

export function codeWriterContext(
  mode: "non_script" | "script",
  requirement: string,
  includeFullSchema = false,
): Record<string, unknown> {
  const common = {
    contract_version: "flow-code-writer.v4",
    mode,
    requirement,
    mutates_or_executes: false,
    instruction: "Follow authoritative_rules.content, dangerous_patterns.value, and module_blacklist.value in full; all are loaded directly from the authoritative reference files, not summaries.",
    authoritative_rules: {
      source: agentPromptSource,
      content: agentPrompt,
    },
    dangerous_patterns: {
      source: dangerousPatternsSource,
      value: dangerousPatterns,
    },
    module_blacklist: {
      source: moduleBlacklistSource,
      value: moduleBlacklist,
    },
  };

  if (mode === "non_script") {
    return {
      ...common,
      next_tools: {
        execute_only_when_requested: "flow_execute_code",
      },
    };
  }

  return {
    ...common,
    interface_document_schema: {
      source: interfaceDocSchemaSource,
      included: includeFullSchema,
      ...(includeFullSchema ? { value: interfaceDocSchema } : {}),
      loading: includeFullSchema
        ? "The authoritative JSON Schema was loaded and returned directly"
        : "Call flow_write_code again with include_full_schema=true when the raw JSON Schema is required",
    },
    interface_document_patch_schema: {
      source: interfaceDocPatchSchemaSource,
      included: includeFullSchema,
      ...(includeFullSchema ? { value: interfaceDocPatchSchema } : {}),
      loading: includeFullSchema
        ? "The RFC 6902 JSON Patch Schema was loaded and returned directly"
        : "Use interface_doc_patch for existing-document updates; call flow_write_code again with include_full_schema=true when the raw Patch Schema is required",
    },
    next_tools: {
      preview_after_recursive_self_check: "flow_preview_script_change",
      apply_only_after_explicit_user_confirmation: "flow_apply_script_change",
      execute_after_create_when_requested: "flow_execute_script",
    },
  };
}
