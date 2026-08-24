export interface FlowApiClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface FlowRequestOptions extends RequestInit {
  authenticated?: boolean;
  execution?: boolean;
}

const SENSITIVE_KEYS = new Set([
  "access_token",
  "accesstoken",
  "access-token",
  "authorization",
  "cookie",
  "password",
  "lock_password",
  "token",
  "x-csrf-token",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : redact(child);
  }
  return result;
}

export class FlowApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown) {
    super(`Flow Codeblock API returned HTTP ${status}`);
    this.name = "FlowApiError";
    this.status = status;
    this.payload = redact(payload);
  }
}

export class FlowApiClient {
  readonly baseUrl: string;
  readonly token: string;
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FlowApiClientOptions) {
    const baseUrl = options.baseUrl.trim().replace(/\/+$/, "");
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(baseUrl);
    } catch {
      throw new Error("FLOW_CODEBLOCK_BASE_URL must be a valid URL");
    }
    if (!/^https?:$/i.test(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
      throw new Error("FLOW_CODEBLOCK_BASE_URL must use http or https");
    }
    const token = options.token.trim();
    if (!token) throw new Error("FLOW_CODEBLOCK_TOKEN is required");
    if ([...token].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)) {
      throw new Error("FLOW_CODEBLOCK_TOKEN contains control characters");
    }
    this.baseUrl = baseUrl;
    this.token = token;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(path: string, options: FlowRequestOptions = {}): Promise<unknown> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new Error("Flow Codeblock API paths must be relative absolute paths");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    if (options.authenticated !== false) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }
    if (options.execution === true) {
      headers.set("X-Flow-Execution-Origin", "mcp");
    }
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const { authenticated: _authenticated, execution: _execution, ...init } = options;
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        signal: controller.signal,
      });
      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text;
      }
      if (!response.ok) throw new FlowApiError(response.status, payload);
      return payload;
    } catch (error) {
      if (error instanceof FlowApiError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Flow Codeblock API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  get(path: string, authenticated = true): Promise<unknown> {
    return this.request(path, { method: "GET", authenticated });
  }

  post(path: string, body: unknown, authenticated = true): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      authenticated,
    });
  }

  put(path: string, body: unknown, authenticated = true): Promise<unknown> {
    return this.request(path, {
      method: "PUT",
      body: JSON.stringify(body),
      authenticated,
    });
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof FlowApiError) {
    return JSON.stringify({ status: error.status, error: error.payload }, null, 2);
  }
  return error instanceof Error ? error.message : String(error);
}

export function responseData(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = (payload as Record<string, unknown>).data;
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

export function currentVersion(payload: unknown): number {
  const data = responseData(payload);
  if (typeof data.current_version === "number" && Number.isInteger(data.current_version)) {
    return data.current_version;
  }
  const versions = data.data;
  if (Array.isArray(versions)) {
    const versionsWithNumbers = versions.filter(
      (value): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value) && typeof value.version === "number",
    );
    const current = versionsWithNumbers.find((value) => value.version === data.current_version);
    if (current && typeof current.version === "number") return current.version;
    if (versionsWithNumbers.length === 1) return versionsWithNumbers[0].version as number;
  }
  throw new Error("Flow Codeblock response did not include current_version");
}
