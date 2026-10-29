// Reading a catalog version's stored content (templates, skills, agent templates, icons) and the
// org install helpers (no providers), shared by PluginInstaller, PluginUpgrader and
// OrgCatalogService: kept out of org-catalog.service.ts so the installer's module never imports a
// module whose provider injects PluginInstaller (an ESM import cycle would run decorators early).
import { createHash } from "node:crypto";
import {
  type AgentTemplate,
  type Connector,
  type ConnectorTemplateFile,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type PluginManifest,
  parseAgentTemplate,
  parseConnectorTemplateFile,
} from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionRegistry } from "../extensions/registry.js";
import type { OrgLock } from "../orgs/org-lock.js";
import { can, type OrgAction } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ConnectorTemplateRef, CreateConnectorInput } from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import type { CatalogItemView } from "./catalog.service.js";
import type {
  ConnectorInstallInput,
  PluginInstallInput,
  PluginInstallView,
} from "./plugin-install.js";
import { iconProblem } from "./plugin-package.js";
import type { CatalogRequestView } from "./requests.service.js";
import { satisfiesRange } from "./versions.js";

/** A catalog item from an organization's view (`GET /orgs/:orgId/catalog`). */
export interface OrgCatalogItem
  extends Omit<
    CatalogItemView,
    "installs" | "marketplaceId" | "latestMarketplaceVersion" | "newerInMarketplace"
  > {
  /**
   * `yes` installable now; `needs_approval` needs enterprise admin approval (install returns 202 and
   * creates a request); `granted` approved for this org; `disabled` disabled by the enterprise admin
   * (members don't see it); `not_deployed` the plugin's extension is not on the deployment.
   */
  installable: "yes" | "needs_approval" | "granted" | "disabled" | "not_deployed";
  /**
   * This org's live plugin install of the item (installing, installed or upgrading);
   * `upgradeAvailable` is the version it can be upgraded to now (spec §10), null when none.
   */
  installed: { pluginInstallId: string; version: string; upgradeAvailable: string | null } | null;
  /** This org's latest request for the item. */
  request: { id: string; stage: "org" | "deployment"; status: string } | null;
}

/**
 * One connector template in an item's detail (for the install wizard): the endpoint preset, the
 * paths an org may edit and the auth preset (no credentials). `id` is the template file's base name,
 * sent as `connectors[id]` in the install body.
 */
export interface OrgCatalogTemplate {
  id: string;
  displayName: LocalizedName | null;
  description: string;
  plugin: string;
  connector: string;
  endpoint: Record<string, unknown>;
  editableEndpoint: string[];
  auth: Record<string, unknown>;
  ownership: "org" | "personal" | null;
}

/** `GET /orgs/:orgId/catalog/:itemId`: the item and what the install wizard needs (latest version). */
export interface OrgCatalogDetail {
  item: OrgCatalogItem;
  /** The latest version has an icon (`GET .../icon`). */
  hasIcon: boolean;
  /** The plugin's extension (its name), null without one. */
  extension: string | null;
  templates: OrgCatalogTemplate[];
  /** The plugin's dependencies (name and range). */
  dependencies: { name: string; range: string }[];
  /** The skill directories. */
  skills: string[];
  /** The agent template files (`agents/<name>.md`, sub-agents spec §16). */
  agents: string[];
}

/**
 * A connector template as an org sees it (the install wizard and the upgrade preview's inputs):
 * presets and editable paths, no credentials.
 */
export function orgTemplateView(id: string, file: ConnectorTemplateFile): OrgCatalogTemplate {
  const t = file.template;
  return {
    id,
    displayName: file.displayName,
    description: file.description ?? "",
    plugin: t.plugin,
    connector: t.connector,
    endpoint: t.endpoint,
    editableEndpoint: t.editableEndpoint ?? [],
    auth: t.auth as unknown as Record<string, unknown>,
    ownership:
      t.ownership ??
      (typeof t.auth.ownership === "string" ? (t.auth.ownership as "org" | "personal") : null),
  };
}

/** An item's icon (the latest version's plugin icon). */
export interface CatalogIcon {
  data: Uint8Array;
  contentType: "image/svg+xml" | "image/png";
  policy: "allow" | "needs_approval" | "disabled";
}

const iconNotFound = () => new ApiError("catalog.icon_not_found", "This catalog item has no icon");

/** The parts of a catalog version row an org install reads. */
export interface CatalogVersionFiles {
  manifest: unknown;
  object_prefix: string | null;
  files: { path: string; size: number; sha256: string }[];
}

/**
 * The item's latest version row; item missing, deleted or (when `includeDisabled` is false)
 * disabled -> `catalog.item_not_found`.
 */
async function latestVersionRow(db: KernelSchemaDb, itemId: string, includeDisabled: boolean) {
  if (!UUID_RE.test(itemId)) throw itemNotFound();
  const item = await db
    .selectFrom("catalog_items")
    .select(["latest_version", "policy"])
    .where("id", "=", itemId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  // An item the caller cannot see is "not found" before any version / storage is read, so "no icon"
  // never reveals that it exists
  if (!item || (!includeDisabled && item.policy === "disabled")) throw itemNotFound();
  const v = await db
    .selectFrom("catalog_item_versions")
    .select(["manifest", "object_prefix", "files"])
    .where("item_id", "=", itemId)
    .where("version", "=", item.latest_version)
    .executeTakeFirst();
  if (!v) throw itemNotFound();
  return { item, v };
}

/** The icon's path in the version's files (undefined without an icon). */
const iconPath = (v: CatalogVersionFiles): string | undefined => {
  const icon = (v.manifest as PluginManifest).icon;
  return icon === undefined ? undefined : packagePath(icon);
};

/** Whether the item's latest version has an icon; unreadable counts as none. */
export async function catalogHasIcon(db: KernelSchemaDb, itemId: string): Promise<boolean> {
  try {
    const { v } = await latestVersionRow(db, itemId, true);
    const path = iconPath(v);
    return path !== undefined && v.files.some((f) => f.path === path);
  } catch {
    return false;
  }
}

/**
 * Reads the icon of the item's latest version (served only through kernel routes, with nosniff and
 * a CSP sandbox in the response headers; the web only shows it with `<img>`). Item missing, deleted
 * or (when `includeDisabled` is false) disabled -> `catalog.item_not_found` (decided before reading
 * storage); no icon -> `catalog.icon_not_found`; stored content that is not a valid svg / png
 * (checked at import, this guards against tampered storage) -> `internal`.
 */
export async function readCatalogIcon(
  db: KernelSchemaDb,
  storage: StorageService,
  itemId: string,
  includeDisabled: boolean,
): Promise<CatalogIcon> {
  const { item, v } = await latestVersionRow(db, itemId, includeDisabled);
  const path = iconPath(v);
  const f = path === undefined ? undefined : v.files.find((x) => x.path === path);
  if (path === undefined || !f) throw iconNotFound();
  const [file] = await readCatalogFiles(storage, v.object_prefix, [f]);
  if (!file) throw iconNotFound();
  const problem = iconProblem(path, file.data);
  if (problem !== undefined) throw new ApiError("internal", `Stored icon is invalid: ${problem}`);
  return {
    data: file.data,
    contentType: /\.svg$/i.test(path) ? "image/svg+xml" : "image/png",
    policy: item.policy,
  };
}

export type { ConnectorInstallInput };

/** The input of `POST /orgs/:orgId/catalog/:itemId/install` (default version: the latest). */
export interface OrgInstallInput extends PluginInstallInput {
  version?: string;
}

/** Install result: 201 installed; 202 needs enterprise admin approval, a request was created (or escalated). */
export type OrgInstallResult =
  | {
      status: 201;
      installed: { itemId: string; version: string; pluginInstallId: string };
      /** The install view (its components, dependency installs included). */
      install: PluginInstallView;
    }
  | { status: 202; request: CatalogRequestView };

/** Upgrade result: 200 upgraded (the install view); 202 needs enterprise admin approval, a request was created. */
export type OrgUpgradeResult =
  | { status: 200; install: PluginInstallView }
  | { status: 202; request: CatalogRequestView };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

/**
 * The org actions installing / uninstalling a plugin needs: the union over its components (an
 * extension -> `org.extensions.manage`, skills -> `skills.manage`, connector templates ->
 * `connectors.manage`, agent templates -> `agents.manage`), re-checked inside the org row lock.
 */
export function requiredActions(m: PluginManifest): OrgAction[] {
  const out: OrgAction[] = [];
  if (m.extension) out.push("org.extensions.manage");
  if ((m.connectorTemplates ?? []).length > 0) out.push("connectors.manage");
  if ((m.skills ?? []).length > 0) out.push("skills.manage");
  if ((m.agents ?? []).length > 0) out.push("agents.manage");
  return out.length > 0 ? out : ["org.extensions.manage"];
}

/** Locks the org row in the caller's transaction (`orgLock` joins it) and re-checks the actor can do every action (else `forbidden`). */
export async function lockOrgForActions(
  orgLock: Pick<OrgLock, "lockAndAuthorize">,
  orgId: string,
  actor: string,
  actions: OrgAction[],
): Promise<void> {
  const [first, ...rest] = actions as [OrgAction, ...OrgAction[]];
  const { role } = await orgLock.lockAndAuthorize(orgId, actor, first);
  for (const a of rest) {
    if (!can(role, a)) throw new ApiError("forbidden", "Insufficient organization role");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** 对象的全部叶子点路径（数组与非对象值算叶子）。 */
function leafPaths(v: Record<string, unknown>, base = ""): string[] {
  const out: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    const p = base ? `${base}.${k}` : k;
    if (isObj(x) && Object.keys(x).length > 0) out.push(...leafPaths(x, p));
    else out.push(p);
  }
  return out;
}

/** The value at a dot path of `v` (own keys only), undefined when absent. */
export function getPath(v: unknown, path: string): unknown {
  let node: unknown = v;
  for (const seg of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

/** Sets the value at a dot path of `obj`, creating the objects on the way. */
export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node[seg])) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1] as string] = value;
}

/** The connector `kind` provided by extension `plugin` loaded on this replica (R6: the registry). */
export function findConnectorIn(
  registry: Pick<ExtensionRegistry, "list">,
  plugin: string,
  kind: string,
): Connector | undefined {
  return registry
    .list("connector")
    .find((e) => e.plugin === plugin && (e.impl as Connector | undefined)?.kind === kind)?.impl as
    | Connector
    | undefined;
}

/** What checking a template's connector extension needs. */
export interface TemplateDeps {
  /** The connector `kind` provided by extension `plugin` loaded on this replica. */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  /** The version of an extension loaded on this replica (undefined when not loaded). */
  pluginVersion: (plugin: string) => string | undefined;
}

/**
 * 模板的连接器插件此刻是否可用：插件加载且提供该 kind，并满足 `pluginVersion`（若写了）；不可用返回原因
 * （模型不可见，给管理员看的英文）。
 */
export function templatePluginProblem(
  d: TemplateDeps,
  template: ConnectorTemplateSpec,
): string | undefined {
  if (!d.findConnector(template.plugin, template.connector)) {
    return `Connector extension ${template.plugin} providing "${template.connector}" is not deployed; ask the enterprise admin to install and enable it`;
  }
  const range = template.pluginVersion;
  const version = d.pluginVersion(template.plugin);
  if (range !== undefined && version !== undefined && !satisfiesRange(version, range)) {
    return `Connector extension ${template.plugin} is deployed at version ${version}, but the template needs ${range}; ask the enterprise admin to upgrade it`;
  }
  return undefined;
}

/**
 * Builds the connector install input from a connector template plus what the org filled in (C30):
 * the endpoint comes from the template, only paths listed in `editableEndpoint` (or fields under
 * them) may be changed by the org, changing another path -> `validation_failed`; the auth method
 * comes from the template, the org only gives credentials (static credentials via `credential`,
 * OAuth via `client`). Re-checks the template's plugin, kind and `pluginVersion` against the
 * connectors loaded on this replica right now (unmet -> `catalog.not_deployed`); the endpoint
 * (merged as a whole) schema check, credential pattern check and OAuth URL policy are re-checked by
 * `ConnectorsService.create`.
 */
export function templateConnectorInput(
  deps: TemplateDeps,
  template: ConnectorTemplateSpec,
  ref: ConnectorTemplateRef,
  input: ConnectorInstallInput | undefined,
  defaultName: string,
  at = "connector",
): CreateConnectorInput {
  const problem = templatePluginProblem(deps, template);
  if (problem !== undefined) throw new ApiError("catalog.not_deployed", problem);
  const given = input ?? {};
  const editable = template.editableEndpoint ?? [];
  const endpoint = structuredClone(template.endpoint);
  if (given.endpoint !== undefined) {
    if (!isObj(given.endpoint)) throw fail(`${at}.endpoint`, "Expected an object");
    for (const p of leafPaths(given.endpoint)) {
      const segs = p.split(".");
      if (segs.some((s) => UNSAFE_KEYS.has(s))) {
        throw fail(`${at}.endpoint.${p}`, "Invalid key");
      }
      const allowed = editable.some((e) => p === e || p.startsWith(`${e}.`));
      if (!allowed) {
        throw fail(
          `${at}.endpoint.${p}`,
          "This endpoint field is set by the template and cannot be changed",
        );
      }
    }
    for (const e of editable) {
      const v = getPath(given.endpoint, e);
      if (v !== undefined) setPath(endpoint, e, v);
    }
  }
  const auth = template.auth as unknown as ConnectorAuth;
  const oauth = auth.type === "oauth_code" || auth.type === "oauth_client";
  if (oauth && given.credential !== undefined) {
    throw fail(`${at}.credential`, "This connector uses OAuth; provide client instead");
  }
  if (!oauth && given.client !== undefined) {
    throw fail(`${at}.client`, "This connector does not use OAuth; provide credential instead");
  }
  const credential = oauth ? given.client : given.credential;
  return {
    name: given.name ?? defaultName,
    ...(given.slug !== undefined && { slug: given.slug }),
    connector: template.connector,
    endpoint,
    auth,
    ...(credential !== undefined && { credential }),
    template: {
      ...ref,
      ...(template.defaultToolPolicies !== undefined && {
        defaultToolPolicies: template.defaultToolPolicies,
      }),
    },
  };
}

/** 从部署存储读目录版本里的文件（按版本行的 sha256 校验）；`under` 给出时只读该目录下的文件，路径去掉该前缀。 */
export async function readCatalogFiles(
  storage: StorageService,
  objectPrefix: string | null,
  files: { path: string; size: number; sha256: string }[],
  under?: string,
): Promise<SkillPackageFile[]> {
  storage.assertAvailable();
  if (objectPrefix === null) return [];
  const store = storage.deployment();
  const dir = under === undefined ? "" : `${under}/`;
  const out: SkillPackageFile[] = [];
  for (const f of files) {
    if (!f.path.startsWith(dir)) continue;
    const got = await store.get(`${objectPrefix}${f.path}`);
    if (!got) {
      throw new ApiError(
        "storage.unavailable",
        `Catalog file ${f.path} is missing from object storage`,
      );
    }
    const data = new Uint8Array(await new Response(got.body).arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
      throw new ApiError("internal", `Catalog file ${f.path} does not match its recorded hash`);
    }
    out.push({ path: f.path.slice(dir.length), size: data.byteLength, sha256: f.sha256, data });
  }
  return out;
}

/** 校验技能文件并取名字与描述（导入时已校验过；这里防存储被改）。 */
export function skillOf(files: SkillPackageFile[]): ReturnType<typeof checkSkillFiles> {
  try {
    // Stored files: a version imported before phase D keeps installing (its invocation keys are
    // read leniently; `skillInvocation` ignores values of the wrong type)
    return checkSkillFiles(files, { invocationKeys: false });
  } catch (e) {
    if (e instanceof SkillArchiveError) {
      throw new ApiError("internal", `Stored skill is invalid: ${e.problems.join("; ")}`);
    }
    throw e;
  }
}

/** The connector templates of a catalog version, read from storage (id = the file's base name). */
export async function readCatalogTemplates(
  storage: StorageService,
  v: CatalogVersionFiles,
): Promise<{ id: string; file: ConnectorTemplateFile }[]> {
  const refs = (v.manifest as PluginManifest).connectorTemplates ?? [];
  if (refs.length === 0) return [];
  const paths = refs.map((r) => packagePath(r.path));
  const files = await readCatalogFiles(
    storage,
    v.object_prefix,
    v.files.filter((f) => paths.includes(f.path)),
  );
  return paths.map((path) => {
    const f = files.find((x) => x.path === path);
    let parsed: ReturnType<typeof parseConnectorTemplateFile> | undefined;
    try {
      parsed = f && parseConnectorTemplateFile(JSON.parse(new TextDecoder().decode(f.data)));
    } catch {
      parsed = undefined;
    }
    if (!parsed || "errors" in parsed) {
      throw new ApiError("internal", `Stored connector template ${path} is missing or invalid`);
    }
    return { id: (path.split("/").pop() as string).replace(/\.json$/, ""), file: parsed };
  });
}

/**
 * The agent templates of a catalog version (`manifest.agents`, listed explicitly since import),
 * parsed from storage (checked at import; parsed again in case storage was changed).
 */
export async function readCatalogAgentTemplates(
  storage: StorageService,
  v: CatalogVersionFiles,
): Promise<{ path: string; template: AgentTemplate }[]> {
  const refs = (v.manifest as PluginManifest).agents ?? [];
  if (refs.length === 0) return [];
  const paths = refs.map((r) => packagePath(r.path));
  const files = await readCatalogFiles(
    storage,
    v.object_prefix,
    v.files.filter((f) => paths.includes(f.path)),
  );
  return paths.map((path) => {
    const f = files.find((x) => x.path === path);
    const parsed = f && parseAgentTemplate(new TextDecoder().decode(f.data));
    if (!parsed || "errors" in parsed) {
      throw new ApiError("internal", `Stored agent template ${path} is missing or invalid`);
    }
    return { path, template: parsed.template };
  });
}
