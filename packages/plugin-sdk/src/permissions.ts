/** 插件权限清单：治理而非沙箱，未声明的平台能力访问抛 PluginPermissionError。 */
export interface PluginPermissions {
  /** ctx.secrets */
  secrets?: boolean;
  /** ctx.http.route 注册的路由（`public` 表示免登录）。 */
  http?: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; public?: boolean }[];
  /** ctx.tools.register 的工具名。 */
  tools?: string[];
  /** 预留（M6），只校验名字。 */
  hooks?: string[];
  /** 预留：模型用途，键须为 `<插件名>.<名称>`。 */
  models?: { purpose: string; kind: "chat" | "embedding"; label: { zh: string; en: string } }[];
  /** 预留（M5）。 */
  storage?: boolean;
  /** 访问的域名，只展示不拦截。 */
  network?: string[];
}

/** 访问了清单里没有声明的平台能力。 */
export class PluginPermissionError extends Error {
  constructor(plugin: string, what: string) {
    super(`plugin ${plugin}: not allowed; declare "${what}" in the plugin manifest`);
    this.name = "PluginPermissionError";
  }
}

/** 取用的能力不可用（未安装、未启用或该组织未启用）。 */
export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityUnavailableError";
  }
}

const KEYS = new Set(["secrets", "http", "tools", "hooks", "models", "storage", "network"]);
const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function strList(label: string, v: unknown, errs: string[]): string[] {
  if (!Array.isArray(v)) {
    errs.push(`${label} must be an array`);
    return [];
  }
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x === "") errs.push(`${label} entries must be non-empty strings`);
    else if (out.includes(x)) errs.push(`${label} has duplicate entry "${x}"`);
    else out.push(x);
  }
  return out;
}

/** 校验权限清单，返回错误列表（空表示合法）。 */
export function validatePermissions(plugin: string, p: unknown): string[] {
  if (p === undefined) return [];
  if (!isObj(p)) return ["permissions must be an object"];
  const errs: string[] = [];
  for (const k of Object.keys(p)) {
    if (!KEYS.has(k)) errs.push(`unknown permissions key "${k}"`);
  }
  for (const k of ["secrets", "storage"]) {
    if (p[k] !== undefined && typeof p[k] !== "boolean") {
      errs.push(`permissions.${k} must be a boolean`);
    }
  }
  if (p.tools !== undefined) strList("permissions.tools", p.tools, errs);
  if (p.hooks !== undefined) strList("permissions.hooks", p.hooks, errs);
  if (p.network !== undefined) {
    for (const d of strList("permissions.network", p.network, errs)) {
      if (!DOMAIN_RE.test(d)) errs.push(`permissions.network entry "${d}" is not a valid domain`);
    }
  }
  if (p.http !== undefined) {
    if (!Array.isArray(p.http)) errs.push("permissions.http must be an array");
    else {
      const seen = new Set<string>();
      for (const r of p.http) {
        if (
          !isObj(r) ||
          typeof r.method !== "string" ||
          !METHODS.has(r.method) ||
          typeof r.path !== "string" ||
          !r.path.startsWith("/") ||
          (r.public !== undefined && typeof r.public !== "boolean")
        ) {
          errs.push(
            "permissions.http entries need method GET/POST/PUT/DELETE and a path starting with /",
          );
          continue;
        }
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) errs.push(`permissions.http has duplicate route "${key}"`);
        seen.add(key);
      }
    }
  }
  if (p.models !== undefined) {
    if (!Array.isArray(p.models)) errs.push("permissions.models must be an array");
    else {
      const seen = new Set<string>();
      for (const m of p.models) {
        const label = isObj(m) && isObj(m.label) ? m.label : undefined;
        if (
          !isObj(m) ||
          typeof m.purpose !== "string" ||
          (m.kind !== "chat" && m.kind !== "embedding") ||
          !label ||
          typeof label.zh !== "string" ||
          label.zh === "" ||
          typeof label.en !== "string" ||
          label.en === ""
        ) {
          errs.push("permissions.models entries need purpose, kind chat/embedding and label zh/en");
          continue;
        }
        if (!m.purpose.startsWith(`${plugin}.`) || m.purpose.length === plugin.length + 1) {
          errs.push(`permissions.models purpose "${m.purpose}" must start with "${plugin}."`);
        }
        if (seen.has(m.purpose))
          errs.push(`permissions.models has duplicate purpose "${m.purpose}"`);
        seen.add(m.purpose);
      }
    }
  }
  return errs;
}
