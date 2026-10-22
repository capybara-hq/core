import { createHash } from "node:crypto";
import {
  type AppManifest,
  type Connector,
  type ConnectorTemplateSection,
  type ConnectorTemplateSpec,
  type LocalizedName,
  type PackageKind,
  parseAppManifest,
} from "@capybara-hq/plugin-sdk";
import type { Transaction } from "kysely";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import { can, type OrgAction, roleAtLeast } from "../orgs/roles.js";
import type { PluginHost } from "../plugins/host.js";
import type { OrgPluginConfigs } from "../plugins/org-config.js";
import { checkSkillFiles, SkillArchiveError, type SkillPackageFile } from "../skills/package.js";
import type { SkillsService } from "../skills/skills.service.js";
import type { StorageService } from "../storage/storage.service.js";
import type {
  ConnectorsService,
  ConnectorTemplateRef,
  CreateConnectorInput,
} from "../tools/connectors.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import type { AppInstaller, AppInstallInput } from "./app-install.js";
import { type DirectoryItemView, itemView } from "./directory.service.js";
import type { DirectoryRequestsService, DirectoryRequestView } from "./requests.service.js";

type Trx = Transaction<KernelDatabase>;

/** 组织视角的目录条目（`GET /orgs/:orgId/directory`）。 */
export interface OrgDirectoryItem extends Omit<DirectoryItemView, "installs"> {
  /**
   * `yes` 可直接安装；`needs_approval` 需企业管理员批准（安装返回 202 并建申请）；`granted` 已批准本组织安装；
   * `disabled` 企业管理员禁用（成员看不到）；`not_deployed` 依赖的插件没有装到部署上。
   */
  installable: "yes" | "needs_approval" | "granted" | "disabled" | "not_deployed";
  installed: {
    connectorId?: string;
    skillId?: string;
    plugin?: string;
    appInstallId?: string;
    version: string;
  } | null;
  /** 本组织对该条目最新的一条申请。 */
  request: { id: string; stage: "org" | "deployment"; status: string } | null;
}

/** 安装连接器模板时组织能填的部分（C30）。 */
export type ConnectorInstallInput = AppInstallInput["connectors"][string];

/** `POST /orgs/:orgId/directory/:itemId/install` 的输入。 */
export interface OrgInstallInput {
  version?: string;
  connector?: ConnectorInstallInput;
  app?: AppInstallInput;
}

/** 安装结果：201 已安装；202 需企业管理员批准，已建（或升级）申请。 */
export type OrgInstallResult =
  | {
      status: 201;
      installed: {
        kind: PackageKind;
        itemId: string;
        version: string;
        connectorId?: string;
        skillId?: string;
        skillVersion?: number;
        plugin?: string;
        appInstallId?: string;
      };
    }
  | { status: 202; request: DirectoryRequestView };

export interface OrgDirectoryDeps {
  db: KernelDb;
  storage: StorageService;
  host: Pick<PluginHost, "manifests">;
  /** 本副本已加载的连接器：插件 `plugin` 提供的 `Connector.kind === kind`。 */
  findConnector: (plugin: string, kind: string) => Connector | undefined;
  connectors: Pick<ConnectorsService, "create">;
  skills: Pick<SkillsService, "createVersionFromFiles">;
  orgConfigs: Pick<OrgPluginConfigs, "put" | "isEnabled">;
  requests: DirectoryRequestsService;
  apps: Pick<AppInstaller, "install">;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemNotFound = () => new ApiError("directory.item_not_found", "Directory item not found");
const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

/** 各种类在组织里安装需要的动作（都在组织行锁内复核）。 */
export const INSTALL_ACTIONS: Record<PackageKind, OrgAction[]> = {
  skill: ["skills.manage"],
  "connector-template": ["connectors.manage"],
  plugin: ["org.plugins.manage"],
  app: ["org.plugins.manage", "connectors.manage", "skills.manage"],
};

/** 在调用方事务里锁组织行，并复核发起人能执行全部 `actions`（否则 `forbidden`）。 */
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

function getPath(v: unknown, path: string): unknown {
  let node: unknown = v;
  for (const seg of path.split(".")) {
    if (!isObj(node) || !Object.hasOwn(node, seg)) return undefined;
    node = node[seg];
  }
  return node;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split(".");
  let node = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(node[seg])) node[seg] = {};
    node = node[seg] as Record<string, unknown>;
  }
  node[segs[segs.length - 1] as string] = value;
}

/**
 * 由连接器模板与组织填的部分拼出安装连接器的输入（C30）：端点以模板为准，只有 `editableEndpoint` 列出的路径（或其下的
 * 字段）可以由组织改，改了别的路径 → `validation_failed`；认证方式取模板，组织只给凭据（静态凭据走 `credential`，
 * OAuth 走 `client`）。按此刻本副本加载的连接器复核模板的插件与 kind（没加载 → `directory.not_deployed`）；
 * 端点（合并后的整体）按 schema、凭据样式检查与 OAuth 地址策略的复核由 `ConnectorsService.create` 执行。
 */
export function templateConnectorInput(
  findConnector: OrgDirectoryDeps["findConnector"],
  template: ConnectorTemplateSpec,
  ref: ConnectorTemplateRef,
  input: ConnectorInstallInput | undefined,
  defaultName: string,
  at = "connector",
): CreateConnectorInput {
  if (!findConnector(template.plugin, template.connector)) {
    throw new ApiError(
      "directory.not_deployed",
      `Connector plugin ${template.plugin} providing "${template.connector}" is not deployed; ask the enterprise admin to install and enable it`,
    );
  }
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
export async function readDirectoryFiles(
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
        `Directory file ${f.path} is missing from object storage`,
      );
    }
    const data = new Uint8Array(await new Response(got.body).arrayBuffer());
    if (createHash("sha256").update(data).digest("hex") !== f.sha256) {
      throw new ApiError("internal", `Directory file ${f.path} does not match its recorded hash`);
    }
    out.push({ path: f.path.slice(dir.length), size: data.byteLength, sha256: f.sha256, data });
  }
  return out;
}

/** 校验技能文件并取名字与描述（导入时已校验过；这里防存储被改）。 */
export function skillOf(files: SkillPackageFile[]): { name: string; description: string } {
  try {
    return checkSkillFiles(files);
  } catch (e) {
    if (e instanceof SkillArchiveError) {
      throw new ApiError("internal", `Stored skill is invalid: ${e.problems.join("; ")}`);
    }
    throw e;
  }
}

/** 读应用版本的 app.yaml（在版本的对象前缀下）。 */
export async function readAppManifest(
  storage: StorageService,
  v: { object_prefix: string | null; files: { path: string; size: number; sha256: string }[] },
): Promise<AppManifest> {
  const f = v.files.filter((x) => x.path === "app.yaml");
  const [file] = await readDirectoryFiles(storage, v.object_prefix, f);
  if (!file) throw new ApiError("internal", "The app version has no app.yaml");
  const parsed = parseAppManifest(new TextDecoder().decode(file.data), {
    isKnownConnectorPlugin: () => true,
  });
  if ("errors" in parsed) {
    throw new ApiError("internal", `Stored app.yaml is invalid: ${parsed.errors.join("; ")}`);
  }
  return parsed;
}

const displayNameOf = (n: LocalizedName | null | undefined, fallback: string) => n?.en ?? fallback;

/**
 * 组织从企业目录浏览与安装（C22）：成员浏览（看不到 disabled）与申请，组织管理员安装。安装按条目种类要求
 * `skills.manage` / `connectors.manage` / `org.plugins.manage`（应用三者都要），在组织行锁内复核；条目
 * disabled → `directory.item_disabled`；needs_approval 且没有授予 → 建 stage deployment 的申请（HTTP 202）；
 * 依赖的插件没装到部署 → `directory.not_deployed`。真正创建组件时（启用插件、建连接器、导入技能）各自的事务里
 * 再按条目策略复核一次（`assertItemInstallable`）。无进程内状态。
 */
export class OrgDirectoryService {
  constructor(private readonly d: OrgDirectoryDeps) {}

  /** 组织视角的条目列表；成员（非管理员）看不到 disabled 的条目。 */
  async list(orgId: string, accountId: string, kind?: PackageKind): Promise<OrgDirectoryItem[]> {
    const m = await this.d.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    const isAdmin = m !== undefined && roleAtLeast(m.role, "admin");
    let q = this.d.db
      .selectFrom("directory_items")
      .selectAll()
      .where("deleted_at", "is", null)
      .orderBy("kind")
      .orderBy("name")
      .orderBy("id");
    if (kind !== undefined) q = q.where("kind", "=", kind);
    if (!isAdmin) q = q.where("policy", "<>", "disabled");
    const items = await q.execute();
    if (items.length === 0) return [];
    const ids = items.map((i) => i.id);
    const [versions, grants, requests, skills, connectors, apps, enabled] = await Promise.all([
      this.d.db
        .selectFrom("directory_item_versions")
        .select(["item_id", "version", "source", "section", "resolved"])
        .where("item_id", "in", ids)
        .execute(),
      this.d.db
        .selectFrom("directory_org_grants")
        .select("item_id")
        .where("org_id", "=", orgId)
        .execute(),
      this.d.requests.latestByItem(orgId),
      this.d.db
        .selectFrom("skills")
        .select(["id", "directory_item_id", "directory_version"])
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .where("directory_item_id", "in", ids)
        .orderBy("created_at")
        .execute(),
      this.d.db
        .selectFrom("connectors")
        .select(["id", "directory_item_id", "directory_version"])
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .where("directory_item_id", "in", ids)
        .orderBy("created_at")
        .execute(),
      this.d.db
        .selectFrom("app_installs")
        .select(["id", "item_id", "version"])
        .where("org_id", "=", orgId)
        .where("status", "in", ["installing", "installed"])
        .execute(),
      this.d.db
        .selectFrom("plugin_org_configs")
        .select("plugin")
        .where("org_id", "=", orgId)
        .where("enabled", "=", true)
        .execute(),
    ]);
    const granted = new Set(grants.map((g) => g.item_id));
    const enabledPlugins = new Set(enabled.map((e) => e.plugin));
    const loaded = new Map(this.d.host.manifests().map((x) => [x.name, x.version]));
    const out: OrgDirectoryItem[] = [];
    for (const i of items) {
      const vs = versions.filter((v) => v.item_id === i.id);
      const { installs: _installs, ...view } = itemView(i, vs);
      const latest = vs.find((v) => v.version === i.latest_version);
      let installable: OrgDirectoryItem["installable"];
      if (i.policy === "disabled") installable = "disabled";
      else if (!this.deployed(i.kind, i.name, latest)) installable = "not_deployed";
      else if (i.policy === "needs_approval") {
        installable = granted.has(i.id) ? "granted" : "needs_approval";
      } else installable = "yes";
      let installed: OrgDirectoryItem["installed"] = null;
      if (i.kind === "skill") {
        const s = skills.filter((x) => x.directory_item_id === i.id).at(-1);
        if (s) installed = { skillId: s.id, version: s.directory_version ?? "" };
      } else if (i.kind === "connector-template") {
        const c = connectors.filter((x) => x.directory_item_id === i.id).at(-1);
        if (c) installed = { connectorId: c.id, version: c.directory_version ?? "" };
      } else if (i.kind === "plugin") {
        if (enabledPlugins.has(i.name)) {
          installed = { plugin: i.name, version: loaded.get(i.name) ?? "" };
        }
      } else {
        const a = apps.find((x) => x.item_id === i.id);
        if (a) installed = { appInstallId: a.id, version: a.version };
      }
      out.push({ ...view, installable, installed, request: requests.get(i.id) ?? null });
    }
    return out;
  }

  /**
   * 条目依赖的插件此刻是否装在部署上（本副本已加载）：插件条目 = 该插件；连接器模板 = 提供该 kind 的连接器插件；
   * 应用 = `resolved.plugins` 全部（列表不读 app.yaml，可选插件也算；安装时可选插件没装会跳过）。
   */
  private deployed(
    kind: PackageKind,
    name: string,
    latest: { section: unknown; resolved: unknown } | undefined,
  ): boolean {
    const loaded = new Set(this.d.host.manifests().map((m) => m.name));
    if (kind === "plugin") return loaded.has(name);
    if (kind === "connector-template") {
      const t = (latest?.section as ConnectorTemplateSection | undefined)?.template;
      return t !== undefined && this.d.findConnector(t.plugin, t.connector) !== undefined;
    }
    if (kind === "app") {
      const plugins = (latest?.resolved as { plugins?: { name: string }[] } | null)?.plugins ?? [];
      return plugins.every((p) => loaded.has(p.name));
    }
    return true;
  }

  /** 安装（见类注释）。 */
  async install(
    orgId: string,
    actor: string,
    itemId: string,
    input: OrgInstallInput,
    actorTokenId?: string,
  ): Promise<OrgInstallResult> {
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const item = await this.d.db
      .selectFrom("directory_items")
      .selectAll()
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item) throw itemNotFound();
    const version = input.version ?? item.latest_version;
    const v = await this.d.db
      .selectFrom("directory_item_versions")
      .selectAll()
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    if (!v)
      throw new ApiError("directory.item_not_found", `Version ${version} of this item not found`);
    if (input.connector !== undefined && item.kind !== "connector-template") {
      throw fail("connector", "Only connector template items take connector");
    }
    if (input.app !== undefined && item.kind !== "app") {
      throw fail("app", "Only app items take app");
    }
    const opts = actorTokenId !== undefined ? { actorTokenId } : {};

    // 1. 锁内复核角色与策略；needs_approval 且未授予 → 建申请（202）
    const pending = await this.d.db.transaction().execute(async (t) => {
      await lockOrgForActions(t, orgId, actor, INSTALL_ACTIONS[item.kind]);
      const locked = await t
        .selectFrom("directory_items")
        .select(["policy", "deleted_at"])
        .where("id", "=", itemId)
        .forShare()
        .executeTakeFirst();
      if (!locked || locked.deleted_at !== null) throw itemNotFound();
      if (locked.policy === "disabled") {
        throw new ApiError(
          "directory.item_disabled",
          "This directory item is disabled by the enterprise admin and cannot be newly installed",
        );
      }
      if (!this.deployed(item.kind, item.name, v) && item.kind !== "app") {
        throw new ApiError(
          "directory.not_deployed",
          `The plugin this ${item.kind} needs is not deployed; ask the enterprise admin to install and enable it`,
        );
      }
      if (locked.policy === "needs_approval") {
        const grant = await t
          .selectFrom("directory_org_grants")
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

    // 2. 安装（各自的事务里再按条目策略复核）
    let installed: Extract<OrgInstallResult, { status: 201 }>["installed"];
    const base = { kind: item.kind, itemId, version };
    if (item.kind === "app") {
      const r = await this.d.apps.install(
        orgId,
        actor,
        itemId,
        version,
        input.app ?? { connectors: {} },
        opts,
      );
      return { status: 201, installed: { ...base, appInstallId: r.installId } };
    }
    if (item.kind === "skill") {
      const files = await readDirectoryFiles(this.d.storage, v.object_prefix, v.files);
      const r = await this.d.skills.createVersionFromFiles(
        orgId,
        actor,
        { ...skillOf(files), files },
        { directory: { itemId, version }, ...opts },
      );
      installed = { ...base, skillId: r.skill.id, skillVersion: r.version };
    } else if (item.kind === "connector-template") {
      const section = v.section as ConnectorTemplateSection;
      const r = await this.d.connectors.create(
        orgId,
        actor,
        templateConnectorInput(
          this.d.findConnector,
          section.template,
          { itemId, version },
          input.connector,
          displayNameOf(item.display_name, item.name),
        ),
        actorTokenId,
      );
      installed = { ...base, connectorId: r.connector.id };
    } else {
      await this.d.orgConfigs.put(orgId, item.name, { enabled: true }, actor, actorTokenId, {
        viaItem: itemId,
      });
      installed = { ...base, plugin: item.name };
    }

    // 3. 收尾：成员申请标为已批准，审计
    await this.d.db.transaction().execute(async (t) => {
      await this.d.requests.resolveByInstall(t, orgId, itemId, actor, opts);
      await audit(t, {
        actorAccountId: actor,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "directory.installed",
        target: itemId,
        detail: { ...installed, name: item.name },
      });
    });
    return { status: 201, installed };
  }
}
