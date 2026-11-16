import { POLICY_HOOKS, type PolicyHook } from "./hooks.js";
import { HTTP_ACCESS, type HttpPermission } from "./http-access.js";
import { SETUP_CHECK_ID_RE, SETUP_CHECK_LIMITS } from "./setup-check.js";
import { UI_ICONS, type UiContribution } from "./ui.js";
import { parseSlotRef, uiSlot } from "./ui-slots.js";

/** Extension permission manifest: governance, not a sandbox; using an undeclared platform API throws ExtensionPermissionError. */
export interface ExtensionPermissions {
  /** ctx.secrets */
  secrets?: boolean;
  /** Routes registered with ctx.http.route; each declares who may call it (`access`). */
  http?: HttpPermission[];
  /** Tool names for ctx.tools.register. */
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
  /**
   * Model purposes (`ctx.models`): each key must be `<extension name>.<name>`; an org admin maps
   * each to a model of its `kind`. `ctx.models.embed` / `describe` accept the `embedding` ones.
   */
  models?: { purpose: string; kind: "chat" | "embedding"; label: { zh: string; en: string } }[];
  /** ctx.storage (object storage, keys confined under `plugins/<plugin name>/<orgId>/`). */
  storage?: boolean;
  /** Domains accessed; displayed only, not enforced. */
  network?: string[];
  /**
   * Client code: the package's `client` section (a browser bundle the web app loads for the
   * extension's orgs). Sensitive and blocking; required when `ui.components` lists anything.
   */
  client?: boolean;
  /**
   * The ids of the `ui` contributions, one list per kind (each id in exactly one list): `views`
   * are recorded in the snapshot without blocking the load; `embeds` and `components` block the
   * load until approved and are sensitive. `components` needs `client: true`.
   */
  ui?: { views?: string[]; embeds?: string[]; components?: string[] };
  /**
   * Setup check ids registered with `ctx.setup.check` (each matches `SETUP_CHECK_ID_RE`, at most
   * `SETUP_CHECK_LIMITS.idsPerExtension`). Recorded in the snapshot and shown at review as
   * `setupCheck:<id>`, but never blocks loading: a check receives only data the extension already
   * receives for the same target.
   */
  setupChecks?: string[];
}

/** Hook mount points (a closed list, see the overall design 2.4). */
export const HOOK_MOUNT_POINTS = [
  "session.start",
  "session.end",
  "agent.preStep",
  "model.request",
  "model.response",
  "tool.preExecute",
  "tool.postExecute",
  "usage.report",
  "org.member_removed",
  "agent.deleted",
  "org.deleted",
] as const;

/** A hook mount point name. */
export type HookMountPoint = (typeof HOOK_MOUNT_POINTS)[number];

const HOOKS: ReadonlySet<string> = new Set(HOOK_MOUNT_POINTS);

/** A platform API not declared in the manifest was used. */
export class ExtensionPermissionError extends Error {
  constructor(plugin: string, what: string) {
    super(`extension ${plugin}: not allowed; declare "${what}" in the extension manifest`);
    this.name = "ExtensionPermissionError";
  }
}

/** The consumed extension point is unavailable (not installed, not enabled, or not enabled in that org). */
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
  "client",
  "setupChecks",
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

/** Validates the permission manifest and returns the list of errors (empty means valid). */
export function validatePermissions(plugin: string, p: unknown): string[] {
  if (p === undefined) return [];
  if (!isObj(p)) return ["permissions must be an object"];
  const errs: string[] = [];
  for (const k of Object.keys(p)) {
    if (!KEYS.has(k)) errs.push(`unknown permissions key "${k}"`);
  }
  for (const k of ["secrets", "storage", "client"]) {
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
          typeof r.access !== "string" ||
          !(HTTP_ACCESS as readonly string[]).includes(r.access)
        ) {
          errs.push(
            "permissions.http entries need method GET/POST/PUT/DELETE, a path starting with /, and access public/embed/member/admin",
          );
          continue;
        }
        const key = `${r.method} ${r.path}`;
        if (seen.has(key)) errs.push(`permissions.http has duplicate route "${key}"`);
        seen.add(key);
        if (r.path === "/orgs" || r.path.startsWith("/orgs/")) {
          errs.push(
            `permissions.http route "${key}" must not start with /orgs/ (reserved for org routes)`,
          );
        }
        if (r.access === "embed" && !r.path.startsWith(UI_EMBED_PREFIX)) {
          errs.push(`permissions.http embed route "${key}" must be under ${UI_EMBED_PREFIX}`);
        }
        if (
          (r.access === "member" || r.access === "admin") &&
          // anywhere, not only after a slash: find-my-way lets a later duplicate param win, so
          // `/x-:orgId` would override the mount's `:orgId`
          /:orgId(?![A-Za-z0-9_])/.test(r.path)
        ) {
          errs.push(
            `permissions.http route "${key}" must not contain :orgId (the org comes from the mount)`,
          );
        }
      }
    }
  }
  if (p.ui !== undefined) {
    if (!isObj(p.ui)) errs.push("permissions.ui must be an object");
    else {
      for (const k of Object.keys(p.ui)) {
        if (k !== "views" && k !== "embeds" && k !== "components")
          errs.push(`unknown permissions.ui key "${k}"`);
      }
      if (p.ui.components !== undefined)
        strList("permissions.ui.components", p.ui.components, errs);
      const views =
        p.ui.views === undefined ? [] : strList("permissions.ui.views", p.ui.views, errs);
      const embeds =
        p.ui.embeds === undefined ? [] : strList("permissions.ui.embeds", p.ui.embeds, errs);
      for (const id of views) {
        if (embeds.includes(id)) errs.push(`permissions.ui id "${id}" is in both views and embeds`);
      }
    }
  }
  if (p.setupChecks !== undefined) {
    const ids = strList("permissions.setupChecks", p.setupChecks, errs);
    for (const id of ids) {
      if (!SETUP_CHECK_ID_RE.test(id)) {
        errs.push(`permissions.setupChecks id "${id}" must match ${SETUP_CHECK_ID_RE}`);
      }
    }
    if (ids.length > SETUP_CHECK_LIMITS.idsPerExtension) {
      errs.push(`permissions.setupChecks has more than ${SETUP_CHECK_LIMITS.idsPerExtension} ids`);
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
const UI_EMBED_PREFIX = "/ui/";

/**
 * Checks the structure of the manifest's `ui` and cross-checks it with the permission manifest;
 * returns the problems (empty = valid). Only structural problems (UI slots spec §3.2, client
 * extensions spec §5.1): each contribution's id is listed in the list of its kind,
 * `permissions.ui.views` (view), `permissions.ui.embeds` (embed) or `permissions.ui.components`
 * (component), an id is in at most one of the three, and `permissions.ui` lists no id the `ui`
 * lacks; `permissions.ui.components` needs `permissions.client: true`; an embed's path starts with
 * `/ui/` and is declared in `permissions.http` as GET, a view or component has no path; exactly one
 * of `slot` (a well-formed slot reference) and `place` (a known place); for a slot the catalog
 * knows at the version named, a kind it accepts and, unless an alias, the icon it requires. An
 * unknown slot id or version is not a problem here: `resolveUiSlots` drops that contribution and
 * the rest of the extension loads.
 * Assumes `permissions` passed {@link validatePermissions}.
 */
export function validateUiContributions(ui: unknown, permissions: unknown): string[] {
  const perms = isObj(permissions) ? permissions : {};
  const pui = isObj(perms.ui) ? perms.ui : {};
  const listed = (k: "views" | "embeds" | "components"): string[] =>
    Array.isArray(pui[k])
      ? (pui[k] as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
  const views = listed("views");
  const embeds = listed("embeds");
  const components = listed("components");
  // an id in more than one list is reported once, not again as a mismatch of each list
  const multiListed = new Set<string>();
  for (const id of new Set([...views, ...embeds, ...components])) {
    if ([views, embeds, components].filter((l) => l.includes(id)).length > 1) multiListed.add(id);
  }
  const gets = new Set(
    (Array.isArray(perms.http) ? perms.http : [])
      .filter(
        (r): r is Record<string, unknown> =>
          isObj(r) && r.method === "GET" && r.access === "public",
      )
      .map((r) => r.path),
  );
  const errs: string[] = [];
  for (const id of multiListed)
    errs.push(
      `ui "${id}" is listed in more than one of permissions.ui.views / embeds / components`,
    );
  if (components.length > 0 && perms.client !== true)
    errs.push("permissions.ui.components needs permissions.client: true");
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
    // the slot it names, when it is well formed (known to the catalog or not)
    const slotRef = typeof c.slot === "string" ? parseSlotRef(c.slot) : null;
    if (slotRef === null)
      errs.push(`ui "${id}" slot must be a slot reference like "org.page" or "org.page@1"`);
    if (c.after !== undefined && typeof c.after !== "string")
      errs.push(`ui "${id}" after must be a string`);
    if (c.kind !== "view" && c.kind !== "embed" && c.kind !== "component") {
      errs.push(`ui "${id}" kind must be view, embed or component`);
      return;
    }
    if (c.icon !== undefined && !(UI_ICONS as readonly unknown[]).includes(c.icon))
      errs.push(`ui "${id}" icon must be one of ${UI_ICONS.join(", ")}`);
    // the slot checks describe only the catalog's version: another version is left to
    // resolveUiSlots, which drops it (unsupported-version) without failing the extension
    const known = slotRef === null ? undefined : uiSlot(slotRef.id);
    const spec = known !== undefined && known.version === slotRef?.version ? known : undefined;
    if (spec !== undefined) {
      if (!spec.accepts.includes(c.kind))
        errs.push(`ui "${id}" slot ${spec.id} does not accept kind ${c.kind}`);
      if (spec.icon === "required" && c.icon === undefined)
        errs.push(`ui "${id}" slot ${spec.id} needs an icon`);
    }
    if (seen.has(id)) errs.push(`ui has duplicate id "${id}"`);
    seen.set(id, c.kind);
    if (c.kind === "view") {
      if (c.path !== undefined) errs.push(`ui "${id}" path is only allowed for kind embed`);
      if (!views.includes(id) && !multiListed.has(id))
        errs.push(`ui "${id}" (view) must be listed in permissions.ui.views`);
      return;
    }
    if (c.kind === "component") {
      if (c.path !== undefined) errs.push(`ui "${id}" is a component and cannot have a path`);
      if (!components.includes(id) && !multiListed.has(id))
        errs.push(`ui "${id}" is a component; list it in permissions.ui.components`);
      return;
    }
    if (!embeds.includes(id) && !multiListed.has(id))
      errs.push(`ui "${id}" (embed) must be listed in permissions.ui.embeds`);
    if (typeof c.path !== "string" || !c.path.startsWith(UI_EMBED_PREFIX)) {
      errs.push(`ui "${id}" (embed) path must start with "${UI_EMBED_PREFIX}"`);
    } else if (!gets.has(c.path)) {
      errs.push(
        `ui "${id}" embed path "${c.path}" must be declared in permissions.http as GET with access public`,
      );
    }
  });
  for (const [k, kind, ids] of [
    ["views", "view", views],
    ["embeds", "embed", embeds],
  ] as const) {
    for (const id of ids) {
      if (seen.get(id) !== kind && !multiListed.has(id))
        errs.push(`permissions.ui.${k} entry "${id}" has no matching ${kind} contribution in ui`);
    }
  }
  for (const id of components) {
    if (seen.get(id) !== "component" && !multiListed.has(id))
      errs.push(`permissions.ui.components lists "${id}", which is not a component contribution`);
  }
  return errs;
}
