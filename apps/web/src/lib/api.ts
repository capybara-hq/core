/**
 * 浏览器端 API 客户端：请求同源的 `/api/*`（由 Next 路由处理器代理到内核）。
 * 只在客户端组件中使用。
 */

/** 内核要求非安全方法带的 CSRF 头。 */
export const CSRF_HEADER = "X-Capybara-Csrf";

const REFRESH_PATH = "/api/v1/auth/refresh";
const AUTH_PREFIX = "/api/v1/auth/";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 触发一次 refresh 再重试的错误码。`cap_at` Cookie 的 maxAge 等于 access token 的有效期，
 * 过期后浏览器会直接丢掉它，内核此时看到的是「没有 token」（`auth.required`）而不是
 * `auth.token_expired`，所以两者都先尝试用 `cap_rt` 刷新。
 */
const REFRESHABLE = new Set(["auth.token_expired", "auth.required"]);

/** 错误信封中的逐项细节（如 `validation_failed` 的 `{ path, message }`）。 */
export interface ApiErrorDetail {
  path: string;
  message: string;
  /** 原因码（如 `app.connect_failed` 的 `dcr_unsupported`）。 */
  reason?: string;
}

/**
 * API 调用失败。`code` 为内核错误码，或客户端自己的 `network` / `http_error`；
 * `details` 为错误信封里形如 `{ path, message }` 的细节（没有时为空数组）。
 */
export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    /** 错误信封里原样的 `details`（如 `plugin.dependency_missing` 的 `{ capability }`）。 */
    readonly rawDetails: unknown[] = [],
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (!SAFE_METHODS.has(method)) headers.set(CSRF_HEADER, "1");
  if (typeof init.body === "string" && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  try {
    return await fetch(path, { ...init, method, headers, credentials: "same-origin" });
  } catch (e) {
    throw new ApiClientError(0, "network", e instanceof Error ? e.message : String(e));
  }
}

/** 只取带 `message` 字符串的细节（`path` 缺省为空串，保留字符串 `reason`），其余忽略。 */
function toDetails(raw: unknown): ApiErrorDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((d): ApiErrorDetail[] => {
    if (typeof d !== "object" || d === null) return [];
    const { path, message, reason } = d as Record<string, unknown>;
    if (typeof message !== "string") return [];
    return [
      {
        path: typeof path === "string" ? path : "",
        message,
        ...(typeof reason === "string" ? { reason } : {}),
      },
    ];
  });
}

async function toError(res: Response): Promise<ApiClientError> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as {
      error?: { code?: unknown; message?: unknown; details?: unknown };
    };
    const { code, message, details } = body.error ?? {};
    if (typeof code === "string") {
      return new ApiClientError(
        res.status,
        code,
        typeof message === "string" ? message : code,
        toDetails(details),
        Array.isArray(details) ? details : [],
      );
    }
  } catch {
    // 非 JSON（例如网关的 HTML 错误页），落到下面的通用错误。
  }
  return new ApiClientError(res.status, "http_error", `HTTP ${res.status}`);
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/**
 * 同一页面内并发请求同时遇到过期时共用一次 refresh（内核轮换 refresh token，
 * 并发刷新会得到 `auth.refresh_race`）。只是浏览器标签页内的去重，不涉及服务端状态。
 */
let refreshing: Promise<void> | undefined;

function refreshOnce(): Promise<void> {
  refreshing ??= (async () => {
    try {
      const res = await send(REFRESH_PATH, { method: "POST" });
      if (!res.ok) throw await toError(res);
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

/**
 * 调用内核 API 并解析 JSON（204 / 空 body → `undefined`）。
 * 非 GET 自动带 `X-Capybara-Csrf: 1`；401 `auth.token_expired`（或 Cookie 已过期导致的
 * `auth.required`）时先 `POST /api/v1/auth/refresh` 一次再重试；失败抛 {@link ApiClientError}。
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await send(path, init);
  if (res.status === 401 && !path.startsWith(AUTH_PREFIX)) {
    const err = await toError(res);
    if (!REFRESHABLE.has(err.code)) throw err;
    await refreshOnce();
    res = await send(path, init);
  }
  if (!res.ok) throw await toError(res);
  return parse<T>(res);
}

/** 错误的逐项明细（如 `plugin.config_invalid` 的 `{ path, message }`）排成 `path: message` 行。 */
export function issueLines(e: unknown): string[] {
  return e instanceof ApiClientError
    ? e.details.map((d) => (d.path === "" ? d.message : `${d.path}: ${d.message}`))
    : [];
}
