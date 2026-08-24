import { createHash } from "node:crypto";

export type PreviewOperation = "script_change" | "documentation";

export interface PreviewRecord<T extends Record<string, unknown>> {
  operation: PreviewOperation;
  payload: T;
  expectedVersion?: number;
  fingerprint: string;
  expiresAt: number;
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
};

export function fingerprint(operation: PreviewOperation, payload: unknown): string {
  return createHash("sha256")
    .update(stableJson({ operation, payload }))
    .digest("hex");
}

export class PreviewStore<T extends Record<string, unknown>> {
  private readonly records = new Map<string, PreviewRecord<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 256;
    this.now = options.now ?? Date.now;
  }

  purge(): void {
    const now = this.now();
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(id);
    }
  }

  put(id: string, operation: PreviewOperation, payload: T, expectedVersion?: number): PreviewRecord<T> {
    this.purge();
    if (!this.records.has(id) && this.records.size >= this.maxEntries) {
      throw new Error("Too many pending previews; apply or wait for an existing preview to expire");
    }
    const record: PreviewRecord<T> = {
      operation,
      payload,
      expectedVersion,
      fingerprint: fingerprint(operation, payload),
      expiresAt: this.now() + this.ttlMs,
    };
    this.records.set(id, record);
    return record;
  }

  get(id: string): PreviewRecord<T> | undefined {
    this.purge();
    return this.records.get(id);
  }

  delete(id: string): void {
    this.records.delete(id);
  }

  get size(): number {
    this.purge();
    return this.records.size;
  }
}
