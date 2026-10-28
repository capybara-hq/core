import { createHash } from "node:crypto";
import {
  type AgentTemplate,
  type Connector,
  type ConnectorTemplateFile,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type Logger,
  type PluginManifest,
  parseAgentTemplate,
  parseConnectorTemplateFile,
} from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { KernelDatabase, KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import type { ExtensionHost } from "../extensions/host.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { can, type OrgAction, roleAtLeast } from "../orgs/roles.js";
import { packagePath } from "../packages/tgz.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { StorageService } from "../storage/storage.service.js";
import type { ConnectorTemplateRef, CreateConnectorInput } from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import { type CatalogItemView, itemView } from "./catalog.service.js";
import type {
  ConnectorInstallInput,
  PluginInstaller,
  PluginInstallInput,
  PluginInstallView,
} from "./plugin-install.js";
import { iconProblem } from "./plugin-package.js";
import type { PluginUpgradeInput, PluginUpgrader, UpgradePreview } from "./plugin-upgrade.js";
import type { CatalogRequestsService, CatalogRequestView } from "./requests.service.js";
import { upgradeInfo } from "./upgrade-targets.js";
import { satisfiesRange } from "./versions.js";

type Trx = Transaction<KernelDatabase>;

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

export interface OrgCatalogDeps {
  db: KernelSchemaDb;
  storage: StorageService;
  host: Pick<ExtensionHost, "manifests">;
  /** The connector `kind` provided by extension `plugin` loaded on this replica. */
  findConnector: TemplateDeps["findConnector"];
  requests: CatalogRequestsService;
  pluginInstaller: Pick<PluginInstaller, "install" | "preflight">;
  pluginUpgrader: Pick<PluginUpgrader, "preview" | "check" | "upgrade">;
  log?: Pick<Logger, "warn">;
}

/** Upgrade result: 200 upgraded (the install view); 202 needs enterprise admin approval, a request was created. */
export type OrgUpgradeResult =
  | { status: 200; install: PluginInstallView }
  | { status: 202; request: CatalogRequestView };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const itemDisabled = () =>
  new ApiError(
    "catalog.item_disabled",
    "This catalog item is disabled by the enterprise admin and cannot be newly installed",
  );
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

/** Locks the org row in the caller's transaction and re-checks the actor can do every action (else `forbidden`). */
export async function lockOrgForActions(
  t: Trx,
  orgId: string,
  actor: string,
  actions: OrgAction[],
): Promise<void> {
  const [first, ...rest] = actions as [OrgAction, ...OrgAction[]];
  const { role } = await lockOrgAndAuthorize(t, orgId, actor, first);
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

/**
 * Organizations browse and install from the enterprise catalog (C22): members browse (without
 * disabled items) and request, org admins install. Every item is a plugin, installed with its
 * dependencies by {@link PluginInstaller}; installing requires the union of the component actions
 * of the plugins it brings in ({@link requiredActions}), re-checked inside the org row lock; item
 * disabled -> `catalog.item_disabled`; a dependency unresolved / disabled / in a cycle ->
 * `catalog.dependency_*`; an extension or a template's connector not on the deployment ->
 * `catalog.not_deployed`; needs_approval without a grant -> a stage deployment request (HTTP 202;
 * dependencies are not approved separately, spec §10). No in-process state.
 */
export class OrgCatalogService {
  constructor(private readonly d: OrgCatalogDeps) {}

  /** The org's view of the items; members (not admins) don't see disabled items. */
  async list(orgId: string, accountId: string, itemId?: string): Promise<OrgCatalogItem[]> {
    const m = await this.d.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    const isAdmin = m !== undefined && roleAtLeast(m.role, "admin");
    let q = this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("name")
      .orderBy("id");
    if (itemId !== undefined) q = q.where("id", "=", itemId);
    if (!isAdmin) q = q.where("policy", "<>", "disabled");
    const items = await q.execute();
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const [versions, grants, requests, pluginInstalls] = await Promise.all([
      this.d.db
        .selectFrom("catalog_item_versions")
        .select(["item_id", "version", "source", "manifest", "object_prefix", "files"])
        .where("item_id", "in", ids)
        .execute(),
      this.d.db
        .selectFrom("catalog_org_grants")
        .select("item_id")
        .where("org_id", "=", orgId)
        .execute(),
      this.d.requests.latestByItem(orgId),
      this.d.db
        .selectFrom("plugin_installs")
        .select(["id", "item_id", "version"])
        .where("org_id", "=", orgId)
        .where("status", "in", ["installing", "installed", "upgrading"])
        .execute(),
    ]);
    const upgrades = await upgradeInfo(
      this.d.db,
      this.d.host,
      pluginInstalls.flatMap((a) => {
        const item = items.find((i) => i.id === a.item_id);
        return item ? [{ itemId: a.item_id, name: item.name, version: a.version }] : [];
      }),
    );
    const granted = new Set(grants.map((g) => g.item_id));
    const undeployed = await this.undeployed(
      items.flatMap((i) => {
        const v = versions.find((x) => x.item_id === i.id && x.version === i.latest_version);
        return v ? [v] : [];
      }),
    );
    const out: OrgCatalogItem[] = [];
    for (const i of items) {
      const vs = versions.filter((v) => v.item_id === i.id);
      const {
        installs: _installs,
        marketplaceId: _source,
        latestMarketplaceVersion: _latest,
        newerInMarketplace: _newer,
        ...view
      } = itemView(i, vs);
      const latest = vs.find((v) => v.version === i.latest_version);
      let installable: OrgCatalogItem["installable"];
      if (i.policy === "disabled") installable = "disabled";
      else if (latest && undeployed.has(i.id)) {
        installable = "not_deployed";
      } else if (i.policy === "needs_approval") {
        installable = granted.has(i.id) ? "granted" : "needs_approval";
      } else installable = "yes";
      const a = pluginInstalls.find((x) => x.item_id === i.id);
      out.push({
        ...view,
        installable,
        installed: a
          ? {
              pluginInstallId: a.id,
              version: a.version,
              upgradeAvailable: upgrades.get(`${a.item_id}@${a.version}`)?.upgradeAvailable ?? null,
            }
          : null,
        request: requests.get(i.id) ?? null,
      });
    }
    return out;
  }

  /**
   * Item detail (for the install wizard): the same view as the list (members don't see disabled
   * items, not visible means `catalog.item_not_found`), plus the latest version's extension,
   * connector templates (endpoint preset, editable paths, auth preset), dependencies, skills and
   * agent templates.
   */
  async detail(orgId: string, accountId: string, itemId: string): Promise<OrgCatalogDetail> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const [item] = await this.list(orgId, accountId, itemId);
    if (!item) throw itemNotFound();
    const v = await this.d.db
      .selectFrom("catalog_item_versions")
      .select(["manifest", "object_prefix", "files"])
      .where("item_id", "=", itemId)
      .where("version", "=", item.latestVersion)
      .executeTakeFirst();
    if (!v) throw itemNotFound();
    const m = v.manifest as PluginManifest;
    return {
      item,
      hasIcon: m.icon !== undefined,
      extension: m.extension ? m.name : null,
      templates: (await readCatalogTemplates(this.d.storage, v)).map((t) =>
        orgTemplateView(t.id, t.file),
      ),
      dependencies: (m.dependencies ?? []).map((d) => ({ name: d.name, range: d.version })),
      skills: (m.skills ?? []).map((s) => packagePath(s.path)),
      agents: (m.agents ?? []).map((a) => packagePath(a.path)),
    };
  }

  /**
   * The item's icon; members don't see disabled items (-> `catalog.item_not_found`, decided before
   * reading storage).
   */
  icon(itemId: string, isAdmin: boolean): Promise<CatalogIcon> {
    return readCatalogIcon(this.d.db, this.d.storage, itemId, isAdmin);
  }

  /** For the admin item detail: whether the latest version has an icon. */
  hasIcon(itemId: string): Promise<boolean> {
    return catalogHasIcon(this.d.db, itemId);
  }

  /**
   * The items (latest versions) this replica cannot install now: the plugin's extension is not
   * loaded, or a connector template's connector extension is not (or not at the template's
   * `pluginVersion`). Dependencies are judged at install. A template that cannot be read counts as
   * deployed here (the install reads it again).
   */
  private async undeployed(
    versions: ({ item_id: string } & CatalogVersionFiles)[],
  ): Promise<Set<string>> {
    const loaded = new Map(this.d.host.manifests().map((m) => [m.name, m.version]));
    const deps: TemplateDeps = {
      findConnector: this.d.findConnector,
      pluginVersion: (n) => loaded.get(n),
    };
    const out = new Set<string>();
    await Promise.all(
      versions.map(async (v) => {
        const m = v.manifest as PluginManifest;
        if (m.extension && !loaded.has(m.name)) {
          out.add(v.item_id);
          return;
        }
        if ((m.connectorTemplates ?? []).length === 0) return;
        try {
          const templates = await readCatalogTemplates(this.d.storage, v);
          if (templates.some((t) => templatePluginProblem(deps, t.file.template) !== undefined)) {
            out.add(v.item_id);
          }
        } catch (e) {
          // Unreadable here: counted as deployed, the install reports it
          this.d.log?.warn("catalog template read failed in the org list", {
            itemId: v.item_id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
    return out;
  }

  /** Installs a plugin in the org (see the class comment). */
  async install(
    orgId: string,
    actor: string,
    itemId: string,
    body: OrgInstallInput,
    actorTokenId?: string,
  ): Promise<OrgInstallResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    // The role first (forbidden when it can install nothing), then item errors: a member cannot
    // probe the existence or versions of a disabled item through error codes
    await this.d.db.transaction().execute(async (t) => {
      const { role } = await lockOrgAndAuthorize(t, orgId, actor, "catalog.read");
      const canAny = (
        ["org.extensions.manage", "connectors.manage", "skills.manage"] as const
      ).some((a) => can(role, a));
      if (!canAny) throw new ApiError("forbidden", "Insufficient organization role");
    });
    const item = await this.d.db
      .selectFrom("catalog_items")
      .selectAll()
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw itemNotFound();
    const version = body.version ?? item.latest_version;
    const v = await this.d.db
      .selectFrom("catalog_item_versions")
      .select("version")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v)
      throw new ApiError("catalog.item_not_found", `Version ${version} of this item not found`);
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};
    if (item.policy === "disabled") throw itemDisabled();
    // Dependencies resolved, extensions deployed, template connectors available: before a request
    // is created. The actions are the union over the plugins the install brings in
    const { actions } = await this.d.pluginInstaller.preflight(orgId, actor, itemId, version);

    // 1. Role and policy under the lock; needs_approval without a grant -> a request (202). Approval
    //    follows this plugin's policy only, not its dependencies' (spec §10)
    const pending = await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, actions);
      const locked = await t
        .selectFrom("catalog_items")
        .select(["policy", "deleted_at"])
        .where("id", "=", itemId)
        .forShare()
        .executeTakeFirst();
      if (!locked || locked.deleted_at !== null) throw itemNotFound();
      if (locked.policy === "disabled") throw itemDisabled();
      if (locked.policy === "needs_approval") {
        const grant = await t
          .selectFrom("catalog_org_grants")
          .select("item_id")
          .where("item_id", "=", itemId)
          .where("org_id", "=", orgId)
          .executeTakeFirst();
        if (!grant) {
          return this.d.requests.requestDeployment(t, orgId, actor, item, version, opts);
        }
      }
      return undefined;
    });
    if (pending !== undefined) {
      return { status: 202, request: await this.d.requests.view(this.d.db, pending) };
    }

    // 2. Install (each step re-checks the item policy in its own transaction)
    const { version: _version, ...input } = body;
    const view = await this.d.pluginInstaller.install(orgId, actor, itemId, version, input, opts);
    return {
      status: 201,
      installed: { itemId, version, pluginInstallId: view.id },
      install: view,
    };
  }

  /** The upgrade preview of an org install (spec §10, see `PluginUpgrader`). */
  async upgradePreview(
    orgId: string,
    actor: string,
    installId: string,
    version: string,
  ): Promise<UpgradePreview> {
    await this.assertCanInstall(orgId, actor);
    return this.d.pluginUpgrader.preview(orgId, actor, installId, version);
  }

  /**
   * Upgrades an org install in place (spec §10, Decision 11): the preview's `diffHash` is checked
   * first (`plugin.upgrade_stale`); the item disabled -> `catalog.item_disabled`; needs_approval
   * without a grant -> a stage deployment request for the target version (202; after approval the
   * org admin runs the upgrade again); otherwise the upgrade runs (200, the install view).
   */
  async upgrade(
    orgId: string,
    actor: string,
    installId: string,
    body: PluginUpgradeInput,
    actorTokenId?: string,
  ): Promise<OrgUpgradeResult> {
    await this.assertCanInstall(orgId, actor);
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};
    const { itemId, actions, diff } = await this.d.pluginUpgrader.check(
      orgId,
      actor,
      installId,
      body,
    );
    const pending = await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, actions);
      const locked = await t
        .selectFrom("catalog_items")
        .select(["id", "name", "policy", "deleted_at"])
        .where("id", "=", itemId)
        .forShare()
        .executeTakeFirst();
      if (!locked || locked.deleted_at !== null) throw itemNotFound();
      if (locked.policy === "disabled") throw itemDisabled();
      if (locked.policy !== "needs_approval") return undefined;
      const grant = await t
        .selectFrom("catalog_org_grants")
        .select("item_id")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (grant) return undefined;
      return this.d.requests.requestDeployment(t, orgId, actor, locked, body.version, opts);
    });
    if (pending !== undefined) {
      return { status: 202, request: await this.d.requests.view(this.d.db, pending) };
    }
    return {
      status: 200,
      install: await this.d.pluginUpgrader.upgrade(orgId, actor, installId, body, opts, diff),
    };
  }

  /** The actor can install something in the org (forbidden otherwise), checked before item errors. */
  private async assertCanInstall(orgId: string, actor: string): Promise<void> {
    await this.d.db.transaction().execute(async (t) => {
      const { role } = await lockOrgAndAuthorize(t, orgId, actor, "catalog.read");
      const canAny = (
        ["org.extensions.manage", "connectors.manage", "skills.manage"] as const
      ).some((a) => can(role, a));
      if (!canAny) throw new ApiError("forbidden", "Insufficient organization role");
    });
  }
}
