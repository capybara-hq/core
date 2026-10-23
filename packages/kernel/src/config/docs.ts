import type { core } from "zod";
import { configFields, describeSchema } from "./fields.js";

/** `db.poolMax` -> `CAPYBARA_DB__POOL_MAX`（与 envOverrides 的映射互为逆运算）。 */
export function envName(path: string): string {
  const seg = path.split(".").map((s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase());
  return `CAPYBARA_${seg.join("__")}`;
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const code = (s: string): string => `\`${cell(s)}\``;

/** 默认值列：无默认 -> 必填（可选字段为「可选」）；密钥 -> 永不打印（—）。 */
function defaultCell(secret: boolean, d: ReturnType<typeof describeSchema>): string {
  if (!d.hasDefault) return d.optional ? "可选" : "必填";
  if (secret) return "—";
  const v =
    typeof d.defaultValue === "function" ? (d.defaultValue as () => unknown)() : d.defaultValue;
  return code(JSON.stringify(v) ?? "undefined");
}

/**
 * 把配置 schema 渲染成确定性的 Markdown 表格：点路径、环境变量、类型、默认值、可热更、密钥、说明。
 * 密钥字段的默认值一律打印为「—」，不会进入文档。
 */
export function renderConfigDocs(schema: core.$ZodType): string {
  const rows = configFields(schema).map((f) => {
    const d = describeSchema(f.schema);
    const secret = f.meta?.secret === true;
    return `| ${[
      code(f.path),
      code(envName(f.path)),
      code(d.type),
      defaultCell(secret, d),
      f.meta?.hot === true ? "是" : "否",
      secret ? "是" : "否",
      cell(f.meta?.description ?? ""),
    ].join(" | ")} |`;
  });
  return [
    "# 配置项",
    "",
    "<!-- 由 `pnpm gen:config-docs` 生成，请勿手工修改。 -->",
    "",
    "配置来源由 `CAPYBARA_CONFIG_SOURCE` 选择（`file` 或 `nacos`）；环境变量优先级最高，",
    "嵌套键用双下划线，例如 `CAPYBARA_DB__URL` 对应 `db.url`。",
    "密钥字段的默认值不会出现在本文档中。",
    "",
    "| 配置项 | 环境变量 | 类型 | 默认值 | 可热更 | 密钥 | 说明 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "## Nacos 配置来源",
    "",
    "`CAPYBARA_CONFIG_SOURCE=nacos` 时由下列环境变量指定 Nacos（它们不是配置项，不能写进配置文件）：",
    "",
    "| 环境变量 | 说明 |",
    "| --- | --- |",
    "| `CAPYBARA_NACOS_SERVER` | Nacos 地址（如 `nacos:8848`，缺省协议为 http），必填 |",
    "| `CAPYBARA_NACOS_NAMESPACE` | 命名空间 ID，必填 |",
    "| `CAPYBARA_NACOS_DATA_ID` | 配置的 dataId（YAML），必填；分组固定为 `DEFAULT_GROUP` |",
    "| `CAPYBARA_NACOS_USERNAME` / `CAPYBARA_NACOS_PASSWORD` | Nacos 开启鉴权时的用户名与密码：登录换取 accessToken，用到 `tokenTtl` 的 80% 或收到 403 时重新登录；须成对设置 |",
    "| `CAPYBARA_NACOS_ACCESS_TOKEN` | 直接使用的 accessToken（不调用登录接口）；不能与用户名密码同时设置 |",
    "",
    // 网页层的环境变量与默认值以 apps/web/src/lib/kernel-proxy.ts（内核地址、请求体与包上传上限）、
    // apps/web/server.mjs（PORT / CAPYBARA_WEB_HOST）、apps/web/src/dev/catalog/routes.tsx（CAPYBARA_DEV_UI）为准，改那边时同步改这里
    // CAPYBARA_WEB_TRUST_PROXY: apps/web/src/lib/peer.ts; CAPYBARA_WEB_SHUTDOWN_GRACE_MS: apps/web/server.mjs.
    "## 网页层（apps/web）的环境变量",
    "",
    "网页层是独立进程（经 `apps/web/server.mjs` 启动），不读内核配置，只认下列环境变量：",
    "",
    "| 环境变量 | 说明 |",
    "| --- | --- |",
    "| `CAPYBARA_KERNEL_URL` | 内核地址，`/api/*` 代理转发到这里；默认 `http://localhost:8080` |",
    "| `PORT` / `CAPYBARA_WEB_HOST` | 网页层的监听端口（默认 3000）与地址 |",
    "| `CAPYBARA_WEB_TRUST_PROXY` | Proxies in front of the web tier (TLS proxy, load balancer) trusted to report the client address in `X-Forwarded-For`: a hop count (`1` = the nearest proxy) or comma-separated IPs / CIDRs (recommended). Unset (default) trusts nothing: the socket peer is the client, so behind a proxy every user shares the proxy's address for login rate limiting. A hop count is only safe when the web tier is reachable solely through exactly that many proxies. Either way the kernel receives one sanitized client address; a malformed value stops the web tier at startup |",
    "| `CAPYBARA_WEB_SHUTDOWN_GRACE_MS` | Production only: after SIGTERM / SIGINT, how long in-flight requests (including SSE streams) may run before the process exits; default 5000 |",
    "| `CAPYBARA_WEB_MAX_BODY_BYTES` | `/api/*` 代理的请求体上限，默认 1 MiB（与内核的 bodyLimit 一致） |",
    "| `CAPYBARA_WEB_MAX_PACKAGE_BYTES` | 插件包、目录包与应用包上传（`/api/v1/admin/plugins/packages/file`、`/api/v1/admin/directory/import/file`、`/api/v1/admin/directory/apps/prepare/file`）的请求体上限，默认 50 MiB，边读边转发。这是网页层的上限，内核另按 `packages.maxBytes` 拒绝；调大 `packages.maxBytes` 时两个一起调，否则经网页上传的大包先被网页层以 413 拒绝 |",
    "| `CAPYBARA_DEV_UI` | 设为 `1` 时生产构建也开放 `/dev/ui` 组件目录页（默认关闭） |",
    "",
  ].join("\n");
}
