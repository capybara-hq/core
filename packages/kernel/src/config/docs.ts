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
  ].join("\n");
}
