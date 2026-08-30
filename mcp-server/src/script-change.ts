import { assertCompleteInterfaceDoc, assertInterfaceDocPatch } from "./interface-doc";

type ScriptChangeInput = {
  operation: "create" | "update";
  script_id?: unknown;
  code?: unknown;
  code_base64?: unknown;
  description?: unknown;
  ip_whitelist?: unknown;
  interface_doc?: unknown;
  interface_doc_patch?: unknown;
  expected_version?: unknown;
};

export function assertScriptChangeInput(input: ScriptChangeInput): void {
  const hasCode = input.code !== undefined || input.code_base64 !== undefined;
  if (input.code !== undefined && input.code_base64 !== undefined) {
    throw new Error("Provide exactly one of code or code_base64");
  }

  if (input.operation === "create") {
    if (input.script_id !== undefined || input.expected_version !== undefined) {
      throw new Error("Create preview must not include script_id or expected_version");
    }
    if (!hasCode) throw new Error("Create preview requires code or code_base64");
    if (input.interface_doc_patch !== undefined) {
      throw new Error("Create preview requires a complete interface_doc; interface_doc_patch is only for update");
    }
    if (input.interface_doc === undefined) {
      throw new Error("Create preview requires a complete interface_doc");
    }
  } else {
    if (input.interface_doc !== undefined && input.interface_doc_patch !== undefined) {
      throw new Error("Provide exactly one of interface_doc or interface_doc_patch");
    }
    if (
      typeof input.script_id !== "string" ||
      input.script_id.length === 0 ||
      !Number.isInteger(input.expected_version) ||
      Number(input.expected_version) <= 0
    ) {
      throw new Error("Update preview requires script_id and expected_version");
    }
    if (
      !hasCode &&
      input.description === undefined &&
      input.ip_whitelist === undefined &&
      input.interface_doc === undefined &&
      input.interface_doc_patch === undefined
    ) {
      throw new Error("Update preview must include code, description, ip_whitelist, interface_doc, or interface_doc_patch");
    }
    if (hasCode && input.interface_doc === undefined && input.interface_doc_patch === undefined) {
      throw new Error("Updating code requires interface_doc or interface_doc_patch");
    }
  }

  if (input.interface_doc !== undefined) {
    assertCompleteInterfaceDoc(input.interface_doc, input.operation);
  }
  if (input.interface_doc_patch !== undefined) {
    assertInterfaceDocPatch(input.interface_doc_patch);
  }
}
