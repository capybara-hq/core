/**
 * 应用端点的通用处理（与连接器无关，按约定的 `url` / `headers` 两个字段）：端点配置对 `apps.use` 的成员可见，
 * 不能放凭据——凭据走应用的认证设置（加密存储、按调用注入、结果打码）。
 */

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
  if (typeof endpoint.url === "string") {
    let u: URL | undefined;
    try {
      u = new URL(endpoint.url);
    } catch {
      u = undefined; // 格式错误交给连接器的 schema
    }
    if (u) {
      if (u.username !== "" || u.password !== "") {
        out.push({
          path: "endpoint.url",
          message: `The URL must not contain a user name or password; ${USE_CREDENTIALS}`,
        });
      }
      const bad = [...new Set([...u.searchParams.keys()])].filter((k) =>
        CREDENTIAL_QUERY.has(k.toLowerCase()),
      );
      if (bad.length > 0) {
        out.push({
          path: "endpoint.url",
          message: `Query parameter ${bad.map((k) => `"${k}"`).join(", ")} looks like a credential; ${USE_CREDENTIALS}`,
        });
      }
    }
  }
  return out;
}

/**
 * 给没有 `apps.manage` 的人看的端点：`url` 去掉 query、fragment 与用户信息，`headers` 只留头名（`headerNames`）。
 * 固定头值与 query 可能含租户号等管理员不想公开的信息。
 */
export function publicEndpoint(endpoint: unknown): unknown {
  if (!isObj(endpoint)) return endpoint;
  const { headers, url, ...rest } = endpoint;
  const out: Record<string, unknown> = { ...rest };
  if (typeof url === "string") {
    try {
      const u = new URL(url);
      out.url = `${u.origin}${u.pathname}`;
    } catch {
      // 不是合法 URL：不展示
    }
  }
  if (isObj(headers)) out.headerNames = Object.keys(headers);
  return out;
}
