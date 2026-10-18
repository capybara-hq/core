import { createHash } from "node:crypto";

/**
 * 应用端点的通用处理（与连接器无关，按约定：顶层名为 `url` 或以 `Url` 结尾的字符串字段是 URL，如 MCP 的 `url`、
 * OpenAPI 的 `specUrl` / `baseUrl`；`headers` 是固定头）：端点配置对 `apps.use` 的成员可见，
 * 不能放凭据——凭据走应用的认证设置（加密存储、按调用注入、结果打码）。
 */

/** 端点里按「大段文本」处理的顶层字段名（如 OpenAPI 的 `specText`）：应用视图只给字节数与 sha256。 */
const isTextField = (key: string): boolean => key === "text" || /^[a-z][A-Za-z0-9]*Text$/.test(key);

/** 端点里按 URL 处理的顶层字段名。 */
const isUrlField = (key: string): boolean => key === "url" || /^[a-z][A-Za-z0-9]*Url$/.test(key);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 凭据样式的头名（小写比较）：authorization 各变体、api key、token、secret、cookie。 */
const CREDENTIAL_HEADER =
  /^(?:(?:proxy-)?authorization|x-authorization|cookie|(?:x-)?api-?key|x-auth-token|.*-token|.*-secret)$/;

/** 凭据样式的 query 参数名（小写比较）。 */
const CREDENTIAL_QUERY = new Set([
  "key",
  "api_key",
  "apikey",
  "api-key",
  "token",
  "access_token",
  "secret",
]);

const USE_CREDENTIALS = "configure it in the app's credential settings instead";

/** 端点里凭据样式的头 / query 参数 / URL 用户信息；path 相对 `endpoint`。 */
export function endpointCredentialIssues(endpoint: unknown): { path: string; message: string }[] {
  if (!isObj(endpoint)) return [];
  const out: { path: string; message: string }[] = [];
  if (isObj(endpoint.headers)) {
    for (const name of Object.keys(endpoint.headers)) {
      if (CREDENTIAL_HEADER.test(name.toLowerCase())) {
        out.push({
          path: `endpoint.headers.${name}`,
          message: `Header "${name}" looks like a credential; ${USE_CREDENTIALS}`,
        });
      }
    }
  }
  for (const [field, value] of Object.entries(endpoint)) {
    if (!isUrlField(field) || typeof value !== "string") continue;
    let u: URL | undefined;
    try {
      u = new URL(value);
    } catch {
      u = undefined; // 格式错误交给连接器的 schema
    }
    if (!u) continue;
    if (u.username !== "" || u.password !== "") {
      out.push({
        path: `endpoint.${field}`,
        message: `The URL must not contain a user name or password; ${USE_CREDENTIALS}`,
      });
    }
    const bad = [...new Set([...u.searchParams.keys()])].filter((k) =>
      CREDENTIAL_QUERY.has(k.toLowerCase()),
    );
    if (bad.length > 0) {
      out.push({
        path: `endpoint.${field}`,
        message: `Query parameter ${bad.map((k) => `"${k}"`).join(", ")} looks like a credential; ${USE_CREDENTIALS}`,
      });
    }
  }
  return out;
}

/**
 * 给没有 `apps.manage` 的人看的端点：URL 字段（`url` / `*Url`）只留源（scheme + host + port），有路径时打码为
 * `<origin>/…`（去掉路径、query、fragment 与用户信息）；`headers` 只留头名（`headerNames`）。
 * 路径、固定头值与 query 可能含租户号等管理员不想公开的信息。
 */
export function publicEndpoint(endpoint: unknown): unknown {
  if (!isObj(endpoint)) return endpoint;
  const { headers, ...rest } = endpoint;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(rest)) {
    if (!isUrlField(field) || typeof value !== "string") {
      out[field] = value;
      continue;
    }
    try {
      const u = new URL(value);
      out[field] = u.pathname === "/" || u.pathname === "" ? u.origin : `${u.origin}/…`;
    } catch {
      // 不是合法 URL：不展示
    }
  }
  if (isObj(headers)) out.headerNames = Object.keys(headers);
  return out;
}

/**
 * 应用列表 / 详情里给所有人看的端点（Ruling A21）：`text` / `*Text` 字段（如最大 2 MB 的 OpenAPI 文档）不回显全文，
 * 换成 `<field>Bytes`（UTF-8 字节数）与 `<field>Sha256`；要改文档时管理员重新上传。存储与连接器拿到的仍是全文。
 */
export function endpointView(endpoint: unknown): unknown {
  if (!isObj(endpoint)) return endpoint;
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(endpoint)) {
    if (isTextField(field) && typeof value === "string") {
      out[`${field}Bytes`] = Buffer.byteLength(value, "utf8");
      out[`${field}Sha256`] = createHash("sha256").update(value).digest("hex");
    } else {
      out[field] = value;
    }
  }
  return out;
}
