import { readFileSync } from "node:fs";

export interface AuthorizeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface TokenResponse {
  credential: string;
  orgId: string;
  environmentId: string;
  connectUrl: string;
  reconnectGraceSeconds: number;
}

/** An error response of the kernel: `{ error: { code, message } }`. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

/** The version in this package's package.json (src/ and dist/ are both one level below it). */
export function programVersion(): string {
  const file = new URL("../package.json", import.meta.url);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

async function post<T>(fetchFn: FetchFn, url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-capybara-csrf": "1" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError("network", `cannot reach ${url}: ${(e as Error).message}`, 0);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text === "" ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    throw new ApiError(
      typeof err?.code === "string" ? err.code : `http_${res.status}`,
      typeof err?.message === "string" ? err.message : `${url} answered ${res.status}`,
      res.status,
    );
  }
  return json as T;
}

export function authorize(
  fetchFn: FetchFn,
  baseUrl: string,
  body: { name: string; os: "darwin" | "linux"; arch: string; programVersion: string },
): Promise<AuthorizeResponse> {
  return post(fetchFn, `${baseUrl}/api/v1/device/authorize`, body);
}

export function token(
  fetchFn: FetchFn,
  baseUrl: string,
  deviceCode: string,
): Promise<TokenResponse> {
  return post(fetchFn, `${baseUrl}/api/v1/device/token`, { deviceCode });
}
