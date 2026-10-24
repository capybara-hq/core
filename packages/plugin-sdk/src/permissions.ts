import { POLICY_HOOKS, type PolicyHook } from "./hooks.js";
import type { UiContribution } from "./ui.js";

/** 插件权限清单：治理而非沙箱，未声明的平台能力访问抛 ExtensionPermissionError。 */
export interface ExtensionPermissions {
  /** ctx.secrets */
  secrets?: boolean;
  /** ctx.http.route 注册的路由（`public` 表示免登录）。 */
  http?: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; public?: boolean }[];
  /** ctx.tools.register 的工具名。 */
  tools?: string[];
  /**
   * Hook mount points (`ctx.hooks.on`). From M7, five mount points are registrable; see
   * `HOOKS_AVAILABLE`.
   */
  hooks?: HookMountPoint[];
  /**
   * Mount points where the plugin registers `policy` hooks (each must also be in `hooks`; only
   * `POLICY_HOOKS`). Deployment state reads it: while the plugin is enabled and approved but not loaded
   * on a replica, calls on these mount points fail closed there.
   */
  policyHooks?: PolicyHook[];
  /** 预留：模型用途，键须为 `<插件名>.<名称>`。 */
  models?: { purpose: string; kind: "chat" | "embedding"; label: { zh: string; en: string } }[];
  /** ctx.storage（对象存储，键限定在 `plugins/<插件名>/<orgId>/` 下）。 */
  storage?: boolean;
  /** 访问的域名，只展示不拦截。 */
  network?: string[];
  /**
   * 界面贡献的 id（与清单 `ui` 一一对应）：`views` 记入快照但不卡加载；
   * `embeds` 卡加载、需批准，并标为敏感项。
   */
  ui?: { views?: string[]; embeds?: string[] };
}

/** hook 挂载点（封闭列表，见总设计 2.4）。 */
export const HOOK_MOUNT_POINTS = [
  "session.start",
  "session.end",
  "agent.preStep",
  "model.request",
  "model.response",
  "tool.preExecute",
  "tool.postExecute",
  "usage.report",
] as const;

/** hook 挂载点名。 */
export type HookMountPoint = (typeof HOOK_MOUNT_POINTS)[number];

const HOOKS: ReadonlySet<string> = new Set(HOOK_MOUNT_POINTS);

/** 访问了清单里没有声明的平台能力。 */
export class ExtensionPermissionError extends Error {
  constructor(plugin: string, what: string) {
    super(`extension ${plugin}: not allowed; declare "${what}" in the extension manifest`);
    this.name = "ExtensionPermissionError";
  }
}

/** 取用的能力不可用（未安装、未启用或该组织未启用）。 */
export class ExtensionPointUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionPointUnavailableError";
  }
}

const KEYS = new Set([
  "secrets",
  "http",
  "tools",
  "hooks",
  "policyHooks",
  "models",
  "storage",
  "network",
  "ui",
]);
const POLICY: ReadonlySet<string> = new Set(POLICY_HOOKS);
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
  if (p.hooks !== undefined) {
    for (const h of strList("permissions.hooks", p.hooks, errs)) {
      if (!HOOKS.has(h)) {
        errs.push(
          `permissions.hooks has unknown hook "${h}" (allowed: ${HOOK_MOUNT_POINTS.join(", ")})`,
        );
      }
    }
  }
  if (p.policyHooks !== undefined) {
    const declared = Array.isArray(p.hooks) ? p.hooks : [];
    for (const h of strList("permissions.policyHooks", p.policyHooks, errs)) {
      if (!POLICY.has(h)) {
        errs.push(
          `permissions.policyHooks has "${h}", which takes no policy hooks (allowed: ${POLICY_HOOKS.join(", ")})`,
        );
      } else if (!declared.includes(h)) {
        errs.push(`permissions.policyHooks has "${h}", which is missing from permissions.hooks`);
      }
    }
  }
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
  if (p.ui !== undefined) {
    if (!isObj(p.ui)) errs.push("permissions.ui must be an object");
    else {
      for (const k of Object.keys(p.ui)) {
        if (k !== "views" && k !== "embeds") errs.push(`unknown permissions.ui key "${k}"`);
      }
      const views =
        p.ui.views === undefined ? [] : strList("permissions.ui.views", p.ui.views, errs);
      const embeds =
        p.ui.embeds === undefined ? [] : strList("permissions.ui.embeds", p.ui.embeds, errs);
      for (const id of views) {
        if (embeds.includes(id)) errs.push(`permissions.ui id "${id}" is in both views and embeds`);
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

const UI_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const UI_TITLE_MAX = 100;
const UI_PLACES: readonly unknown[] = ["conversation", "page"];
const UI_EMBED_PREFIX = "/ui/";

/**
 * 校验清单 `ui` 并与权限清单交叉核对，返回错误列表（空表示合法）：
 * 每个贡献的 id 恰好出现在 `permissions.ui.views`（kind view）或 `permissions.ui.embeds`（kind embed）里，
 * `permissions.ui` 里也不能有清单 `ui` 没有的 id；embed 的 path 以 `/ui/` 开头并在 `permissions.http` 中声明为 GET。
 * 假定 `permissions` 已经过 {@link validatePermissions}。
 */
export function validateUiContributions(ui: unknown, permissions: unknown): string[] {
  const perms = isObj(permissions) ? permissions : {};
  const pui = isObj(perms.ui) ? perms.ui : {};
  const listed = (k: "views" | "embeds"): string[] =>
    Array.isArray(pui[k])
      ? (pui[k] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  const views = listed("views");
  const embeds = listed("embeds");
  const gets = new Set(
    (Array.isArray(perms.http) ? perms.http : [])
      .filter((r): r is Record<string, unknown> => isObj(r) && r.method === "GET")
      .map((r) => r.path),
  );
  const errs: string[] = [];
  const contributions: unknown[] = [];
  if (ui !== undefined) {
    if (!Array.isArray(ui)) errs.push("ui must be an array");
    else contributions.push(...ui);
  }
  const seen = new Map<string, UiContribution["kind"]>();
  contributions.forEach((c, i) => {
    const at = `ui[${i}]`;
    if (!isObj(c)) {
      errs.push(`${at} must be an object`);
      return;
    }
    if (typeof c.id !== "string" || !UI_ID_RE.test(c.id)) {
      errs.push(`${at}.id must match ${UI_ID_RE}`);
      return;
    }
    const id = c.id;
    const title = isObj(c.title) ? c.title : undefined;
    if (
      !title ||
      [title.zh, title.en].some((t) => typeof t !== "string" || t === "" || t.length > UI_TITLE_MAX)
    )
      errs.push(`ui "${id}" title needs non-empty zh and en of at most ${UI_TITLE_MAX} characters`);
    if (!UI_PLACES.includes(c.place)) errs.push(`ui "${id}" place must be conversation or page`);
    if (c.kind !== "view" && c.kind !== "embed") {
      errs.push(`ui "${id}" kind must be view or embed`);
      return;
    }
    if (seen.has(id)) errs.push(`ui has duplicate id "${id}"`);
    seen.set(id, c.kind);
    if (c.kind === "view") {
      if (c.path !== undefined) errs.push(`ui "${id}" path is only allowed for kind embed`);
      if (!views.includes(id))
        errs.push(`ui "${id}" (view) must be listed in permissions.ui.views`);
      return;
    }
    if (!embeds.includes(id))
      errs.push(`ui "${id}" (embed) must be listed in permissions.ui.embeds`);
    if (typeof c.path !== "string" || !c.path.startsWith(UI_EMBED_PREFIX)) {
      errs.push(`ui "${id}" (embed) path must start with "${UI_EMBED_PREFIX}"`);
    } else if (!gets.has(c.path)) {
      errs.push(`ui "${id}" (embed) path must be declared in permissions.http as "GET ${c.path}"`);
    }
  });
  for (const [k, kind, ids] of [
    ["views", "view", views],
    ["embeds", "embed", embeds],
  ] as const) {
    for (const id of ids) {
      if (seen.get(id) !== kind)
        errs.push(`permissions.ui.${k} entry "${id}" has no matching ${kind} contribution in ui`);
    }
  }
  return errs;
}
