import { randomUUID } from "node:crypto";
import {
  type AuthHint,
  type AuthInjection,
  type ConnectorOperation,
  connectorToolKey,
  type GitSource,
  type ToolAnnotations,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { z } from "zod";
import { connectorTemplateState } from "../catalog/component-state.js";
import { assertItemInstallable } from "../catalog/request-rules.js";
import { productName } from "../config/product-name.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import {
  type ConnectionGuideState,
  type GuideAck,
  PluginGuides,
} from "../extensions/plugin-guides.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import type { WriteActor } from "../identity/write-actor.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { OrgLock } from "../orgs/org-lock.js";
import { firstOrgOwner } from "../orgs/org-owner.js";
import type { OrgRole } from "../orgs/roles.js";
import { UUID_RE } from "../ui/registry.js";
import { type ConnectorSetup, connectorSetup, connectorSetups } from "./connector-setup.js";
import {
  CONNECTOR_TOOLS_JOB,
  CONNECTOR_TOOLS_QUEUE,
  type ConnectorToolsJobData,
  type ConnectorToolsTrigger,
  connectorToolsJobId,
} from "./connector-tools-jobs.js";
import {
  type ConnectorAuth,
  CredentialMissing,
  type CredentialOwner,
  Credentials,
  isOAuth,
  type OAuthAuth,
  type StaticSecret,
} from "./credentials.js";
import {
  type DriftChanges,
  type SnapshotRow,
  snapshot,
  ToolDrift,
  type ToolIssue,
  toolIssue,
} from "./drift.js";
import { endpointCredentialIssues, endpointView } from "./endpoint.js";
import { deriveSlug, isValidSlug, SLUG_RULE } from "./naming.js";
import {
  checkOAuthUrl,
  discoverMcp,
  type McpAuthMetadata,
  OAuthSetupError,
  oauthHttpOptions,
  pickAuthMethod,
  registerClient,
} from "./oauth/discovery.js";
import { callbackUrl, publicUrlRequired } from "./oauth/flow-paths.js";
import {
  type OAuthClientRecord,
  OAuthGrantError,
  type OAuthTokenRecord,
  OAuthUnavailable,
  tokenRequest,
} from "./oauth/tokens.js";
import { stricter } from "./policy.js";
import { policyFromAnnotations, type ToolPolicy, ToolRegistry } from "./registry.js";
import { recordToolSpecs } from "./specs.js";

export type { ToolIssue } from "./drift.js";

type ToolStatus = "enabled" | "disabled" | "pending_review";
type ToolSource = "connector" | "resources";

/** 连接器工具视图；`issue` 非空表示该工具不能启用的原因（如 key 超长）。 */
export interface ConnectorToolView {
  name: string;
  key: string;
  /** The reviewed definition's display-only title (`ToolSpec.title`), or null. */
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations | null;
  /**
   * 连接器的不透明路由数据（Ruling A21，如 OpenAPI 的方法 / 路径 / 服务器地址），供复核对比；没有时为 null。
   * 只给 `connectors.manage`（读者视图里置 null，见 connectors.controller.ts）。
   */
  connectorData: Record<string, unknown> | null;
  status: ToolStatus;
  defaultPolicy: ToolPolicy;
  specHash: string;
  issue: string | null;
  /** `resources`：内核为支持 resources 的连接器补上的工具（见 resources.ts）。 */
  source: ToolSource;
  /**
   * 默认策略的来历：`derived` 按注解推导（定义变化复核通过后重新推导），`admin` 管理员设定（保留），
   * `template` 来自目录模板的 `defaultToolPolicies`（与 admin 一样保留）。
   */
  policySource: "derived" | "admin" | "template";
  /** 远端已不再提供该工具（随之停用；又出现时待复核）。 */
  missing: boolean;
  reviewedAt: Date | null;
  /**
   * 定义变化后待复核的新定义（漂移检测，Task 17）；上面的 description / inputSchema / annotations / specHash /
   * source 是当前（上次复核通过的）定义，供对比。新增的待复核工具没有旧定义，此处为 null。
   */
  pending: {
    description: string;
    inputSchema: Record<string, unknown>;
    annotations: ToolAnnotations | null;
    connectorData: Record<string, unknown> | null;
    specHash: string;
    source: ToolSource;
  } | null;
}

/** A connector's own description as stored: trimmed, blank or absent as null. */
function ownDescription(v: string | null | undefined): string | null {
  const text = v?.trim() ?? "";
  return text === "" ? null : text;
}

/** 列表项：不含工具与凭据（`auth` 只有类型与非密钥字段）。 */
export interface ConnectorSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: unknown;
  auth: ConnectorAuth;
  status: "active" | "disabled";
  /**
   * Derived on every read, never stored (plugin pages spec §5.2.1): `needs_config` while the org
   * input its auth needs (an OAuth client or an org credential) is absent; such a connector is
   * never called. Independent of `status`.
   */
  setup: ConnectorSetup;
  /**
   * The platform connector template it was made from (`connectors.platform_template_id`), null for
   * a custom one: the web offers it for a pending connector of that template (ruling P4-7).
   */
  platformTemplateId: string | null;
  /** The plugin (catalog item) its template came from (`connectors.catalog_item_id`), else null. */
  catalogItemId: string | null;
  /**
   * The git hosts its credential serves in sandboxes (`connectors.git_hosts`; sandbox git
   * credentials spec §6.1), null when it declares none.
   */
  git: GitSource | null;
  /**
   * An org-ownership connector serves as a git source (`connectors.use_for_git`, set by an org
   * admin); personal connectors with `git` always do and keep this false.
   */
  useForGit: boolean;
  /**
   * The org's default for pushes through this connector's credential (`connectors.git_push_policy`,
   * the virtual tool `git_push`; sandbox git credentials spec §7); meaningful only with `git`.
   */
  gitPushPolicy: ToolPolicy;
  /**
   * Its own description, set by an org admin (`connectors.description`); null: none (the pages
   * then show its template's, `templateDescription` on the connector routes).
   */
  description: string | null;
  /** Null: the kernel created it as no person (a plugin scope sync, ruling R17). */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectorDetail extends ConnectorSummary {
  tools: ConnectorToolView[];
  /** 当前用户视角的凭据状态；`ownership` 为 null 表示无需凭据（auth none）。 */
  credential: { ownership: "org" | "personal" | null; status: "connected" | "missing" };
}

export interface CreateConnectorInput {
  name: string;
  slug?: string | undefined;
  connector: string;
  endpoint: unknown;
  auth: ConnectorAuth;
  credential?: unknown;
  /**
   * The git hosts the connector's credential serves in sandboxes (a template's `git`, or the
   * create body's; validated by the SDK's `GitSourceSchema`), stored in `connectors.git_hosts`.
   */
  git?: GitSource | undefined;
  /** The connector's own description (`connectors.description`; blank or absent: none). */
  description?: string | undefined;
  /**
   * Install from a platform catalog connector template (T26, filled in by the catalog service,
   * not accepted over HTTP): the connector records its source item and version, the item policy is
   * re-checked in the transaction (a template inside an app passes the app item); once the tool
   * snapshot exists, `defaultToolPolicies` set the default policies (`policy_source 'template'`).
   * Absent = custom; rejected when the deployment setting `customConnectors` is deny
   * (`catalog.custom_disabled`).
   */
  template?: ConnectorTemplateRef | undefined;
  /**
   * The name and slug are chosen under the org lock (one more connector from a template, ruling
   * P4-T6-10; not accepted over HTTP; `slug` must be absent): the first free of `name` (else
   * `display`) with its derived slug, then `<display> 2` with `_2`, `3` with `_3`, … (a given
   * `name` is kept, only its slug suffixed), among the org's live connectors and the installed
   * plugins' names. Chosen after the outbound calls, so a race never repeats them.
   */
  slugDefault?: { display: string; name?: string | undefined } | undefined;
}

/** What {@link ConnectorsService}'s shared insert writes besides the request's input. */
interface ConnectorWrite {
  id: string;
  slug: string;
  endpoint: unknown;
  owner: CredentialOwner | undefined;
  secret: StaticSecret | undefined;
  oauth: OAuthSetup | undefined;
  /** The tool listing (none for an authorization-code connector or a deferred create). */
  listed: { specs: unknown; resources: boolean } | undefined;
  /** The template's setup guide it is set up with (null: none, or a custom connector). */
  guideAck: GuideAck | null;
}

/** 连接器来自哪个目录条目的哪个模板。 */
export interface ConnectorTemplateRef {
  itemId: string;
  version: string;
  /** 应用里的模板 id；独立的连接器模板条目为空。 */
  templateId?: string | undefined;
  defaultToolPolicies?: Record<string, ToolPolicy> | undefined;
  /** The item whose policy approves this install (a dependency's template: the installed plugin). */
  approvedBy?: string | undefined;
  /**
   * One more connector from a platform connector template (ruling P4-T6-8): the template must be
   * on in the org, re-checked under the org lock (`component.off` / `component.not_found`).
   */
  mustBeOn?: boolean | undefined;
}

/**
 * A connector updated to another version of its catalog template (the platform plugin update fans
 * a changed template out to every connector with its `platform_template_id`, ruling E2): only
 * template-owned fields change (endpoint preset, auth preset, default tool
 * policies still at the template default); the name, slug, status, tools and credentials stay,
 * unless `resetCredentials`.
 */
export interface TemplateUpdateInput {
  /** The new template's endpoint preset with the org's values at its editable paths. */
  endpoint: unknown;
  auth: ConnectorAuth;
  /** The template version (itemId, version, templateId, defaultToolPolicies). */
  template: ConnectorTemplateRef;
  /** The new template's git hosts (template-owned: replaces `git_hosts`; absent clears them). */
  git?: GitSource | undefined;
  /**
   * The auth method or the credentials it needs changed: the connector's credentials (org and
   * personal, OAuth client and tokens) are cleared and `credential` (an org or the actor's static
   * credential, or the OAuth client) is set.
   */
  resetCredentials: boolean;
  credential?: unknown;
}

/** A {@link TemplateUpdateInput} checked by {@link ConnectorsService.prepareTemplateUpdate}. */
export interface PreparedTemplateUpdate {
  input: TemplateUpdateInput;
  endpoint: unknown;
  owner?: CredentialOwner;
  secret?: StaticSecret;
  oauth?: OAuthSetup;
}

export interface PreviewConnectorInput {
  name?: string | undefined;
  slug?: string | undefined;
  connector: string;
  endpoint: unknown;
  auth?: ConnectorAuth | undefined;
  credential?: unknown;
}

/** 预览里的一个工具：与安装后的工具视图同形的子集（`issue` 非空 = 安装后只能停用）。 */
export interface ToolPreview {
  name: string;
  key: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations | null;
  defaultPolicy: ToolPolicy;
  issue: string | null;
  source: ToolSource;
}

/**
 * 连接器预览（Ruling A20）：`tools` 为 null 表示没有列工具（没给认证方式、需要凭据但没给、OAuth 授权码流）；
 * `authHints` / `operations` 来自连接器的 `inspect`（不实现时为空 / 缺省）。
 */
export interface ConnectorPreview {
  tools: ToolPreview[] | null;
  /** 列工具时被停用 / 跳过的工具及原因（与安装时的 issues 相同；同名工具只保留第一个）。 */
  issues: ToolIssue[];
  authHints: AuthHint[];
  operations?: ConnectorOperation[];
}

/** 预览时没给 slug、也推导不出时，拼 key 用的占位 slug。 */
const PREVIEW_SLUG = "app";

/** 预览里 inspect 失败的说明里带上的 ToolError 消息最多字符数。 */
const MAX_INSPECT_DETAIL = 500;

export interface UpdateConnectorInput {
  name?: string | undefined;
  status?: "active" | "disabled" | undefined;
  tools?:
    | Record<
        string,
        { status?: "enabled" | "disabled" | undefined; defaultPolicy?: ToolPolicy | undefined }
      >
    | undefined;
  /** 把「没有 readOnlyHint / destructiveHint 注解」的工具默认策略批量改为 allow。 */
  allowUnannotated?: boolean | undefined;
  /**
   * Use this connector's credential for git in sandboxes (sandbox git credentials spec §6.2): only
   * an org-ownership connector that declares git hosts; pushes are then the bot's.
   */
  useForGit?: boolean | undefined;
  /** The connector's own description; null or blank removes it. */
  description?: string | null | undefined;
}

const notFound = () => new ApiError("connector.not_found", "Connector not found");

const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

/**
 * Whether a connector's default git push policy may become `policy` (pure): only a connector that
 * declares git hosts has one (400 on `policy`); `onlyNarrows` (the Platform tool, API tokens) refuses
 * a change that loosens it (`deny` -> `ask` -> `allow`) with `connector.git_push_widen_not_allowed`:
 * only a person in a session loosens it, as the org's sandbox settings.
 */
function assertGitPushSettable(
  gitHosts: readonly unknown[] | null,
  before: ToolPolicy,
  policy: ToolPolicy,
  onlyNarrows: boolean,
): void {
  if (gitHosts === null || gitHosts.length === 0) {
    throw fail("policy", "This connector declares no git hosts");
  }
  if (onlyNarrows && stricter(policy, before) !== policy) {
    throw new ApiError(
      "connector.git_push_widen_not_allowed",
      "Loosening the connector's git push policy needs a person on the connector's settings page.",
    );
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** OAuth 连接器在安装时可带的客户端（手填 client / 客户端凭据流）。 */
const OAuthClientCredential = z.strictObject({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(4000).optional(),
});

/** 发现 / 注册 / 取 token 的失败 → 502 `connector.connect_failed`，details 带原因码（向导据 `dcr_unsupported` 改为手填 client）。 */
function connectFailed(e: unknown): ApiError {
  if (e instanceof OAuthSetupError) {
    return new ApiError("connector.connect_failed", e.message, [
      { reason: e.reason, message: e.message },
    ]);
  }
  if (e instanceof OAuthGrantError) {
    const message = `The authorization server rejected the client credentials (${e.error})`;
    return new ApiError("connector.connect_failed", message, [{ reason: "token_failed", message }]);
  }
  const message =
    e instanceof OAuthUnavailable ? e.message : "Could not complete OAuth setup with the connector";
  return new ApiError("connector.connect_failed", message, [{ reason: "token_failed", message }]);
}

/**
 * 解析请求里的 OAuth 客户端 `{ clientId, clientSecret? }`（安装时的 `credential`、轮换时的组织凭据）；
 * 错误只带路径与英文说明，不回显值。
 */
function parseOAuthClient(
  credential: unknown,
  requireSecret: boolean,
  prefix = "credential",
): z.infer<typeof OAuthClientCredential> {
  if (credential === undefined || credential === null) {
    throw fail(
      prefix,
      "Provide the OAuth client registered with the authorization server ({ clientId, clientSecret })",
    );
  }
  const r = OAuthClientCredential.safeParse(credential);
  if (!r.success) {
    throw new ApiError(
      "validation_failed",
      "Invalid credential",
      r.error.issues.map((i) => ({
        path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
        message: i.message,
      })),
    );
  }
  if (requireSecret && r.data.clientSecret === undefined) {
    throw fail(
      prefix ? `${prefix}.clientSecret` : "clientSecret",
      "A client secret is required for the client credentials flow",
    );
  }
  return r.data;
}

/** OAuth 安装准备的结果：要存的客户端，以及（客户端凭据流）安装时取到的组织 token。 */
export interface OAuthSetup {
  client: OAuthClientRecord;
  tokens?: OAuthTokenRecord;
}

/** 无注解 = 既没有 readOnlyHint 也没有 destructiveHint。 */
const unannotated = (a: ToolAnnotations | undefined) =>
  a?.readOnlyHint === undefined && a?.destructiveHint === undefined;

/**
 * 连接器（远端服务实例）与其工具快照、凭据。写操作都在组织行锁内复核发起人权限并写审计
 * （detail 只有凭据类型与归属，没有值）。连接器会话按操作打开、用完即关，不在进程内缓存。
 */
@Injectable()
export class ConnectorsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(ToolRegistry) private readonly registry: ToolRegistry,
    /**
     * Extension manifests: a derived default slug avoids an extension's name (an explicit slug may
     * take one; connector and extension tool keys live in separate namespaces).
     */
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "manifests">,
    @Inject(Credentials) private readonly credentials: Credentials,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ToolDrift) private readonly drift: ToolDrift,
    /** The org row lock (orgs/org-lock.ts): joins the caller's transaction. */
    @Inject(OrgLock)
    private readonly orgLock: Pick<OrgLock, "lock" | "tryLock" | "lockAndAuthorize">,
    /** Owed work: the tool listings that follow a deferred create or a setup (§5.2.1). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** The cross-replica lock of a deferred connector's lazy client registration (R16). */
    @Inject(LockService) private readonly locks: Pick<LockService, "run">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Setup guides of connector templates (spec 2026-11-09-setup-guides-v2-design.md §11). */
    @Inject(PluginGuides)
    private readonly guides: Pick<PluginGuides, "templateAck" | "connectorStates">,
  ) {}

  /** The kernel-schema handle of the current context (its transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * 校验连接器存在、端点按其 schema 合法、不含凭据样式的头 / query 参数 / URL 用户信息（端点对成员可见，
   * 凭据须走认证设置）；返回解析后的端点。
   */
  private parseEndpoint(connector: string, endpoint: unknown): unknown {
    const c = this.registry.findConnector(connector);
    if (!c) {
      const kinds = this.registry.connectorKinds();
      throw fail(
        "connector",
        `Unknown connector "${connector}"; installed connectors: ${kinds.length > 0 ? kinds.join(", ") : "none"}`,
      );
    }
    const r = c.endpointSchema.safeParse(endpoint);
    if (!r.success) {
      throw new ApiError(
        "validation_failed",
        "Request validation failed",
        r.error.issues.map((i: { path: PropertyKey[]; message: string }) => ({
          path: ["endpoint", ...i.path.map(String)].join("."),
          message: i.message,
        })),
      );
    }
    const leaks = endpointCredentialIssues(r.data);
    if (leaks.length > 0)
      throw new ApiError("validation_failed", "Request validation failed", leaks);
    return r.data;
  }

  private async slugTaken(db: KernelSchemaDb, orgId: string, slug: string): Promise<boolean> {
    const row = await db
      .selectFrom("connectors")
      .select("id")
      .where("org_id", "=", orgId)
      .where("slug", "=", slug)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The first free default name and slug ({@link CreateConnectorInput.slugDefault}), read in the
   * caller's transaction under the org lock.
   */
  private async freeName(
    t: KernelSchemaDb,
    orgId: string,
    d: { display: string; name?: string | undefined },
  ): Promise<{ name: string; slug: string }> {
    const base = deriveSlug(d.name ?? d.display) ?? deriveSlug(d.display);
    if (base === null) {
      throw fail("slug", `Cannot derive a slug from the name; provide one. ${SLUG_RULE}`);
    }
    const taken = new Set(
      (
        await t
          .selectFrom("connectors")
          .select("slug")
          .where("org_id", "=", orgId)
          .where("deleted_at", "is", null)
          .execute()
      ).map((r) => r.slug),
    );
    for (const m of this.extensions.manifests()) taken.add(m.name);
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : `_${n}`;
      const slug = `${base.slice(0, 24 - suffix.length).replace(/_+$/, "")}${suffix}`;
      if (!isValidSlug(slug) || taken.has(slug)) continue;
      const nth = ` ${n}`;
      const name =
        d.name ??
        (n === 1 ? d.display : `${[...d.display].slice(0, 80 - nth.length).join("")}${nth}`);
      return { name: [...name].slice(0, 80).join(""), slug };
    }
  }

  private resolveSlug(input: CreateConnectorInput): string {
    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) throw fail("slug", SLUG_RULE);
      return input.slug;
    }
    const derived = deriveSlug(input.name);
    if (!derived) {
      throw fail("slug", `Cannot derive a slug from the name; provide one. ${SLUG_RULE}`);
    }
    return derived;
  }

  /**
   * OAuth 连接器安装前的准备（A16）：授权码流按 `discovery` 取端点（MCP 发现或手填）、按 `client` 动态注册或用请求里
   * 手填的 client（不做首次 listTools）；客户端凭据流用请求里的 client 取一次组织 token。
   * 外连失败一律 502 `connector.connect_failed`（details 带原因码），什么都不写。
   */
  private async prepareOAuth(
    auth: OAuthAuth,
    endpoint: unknown,
    credential: unknown,
    publicUrl: string,
  ): Promise<OAuthSetup> {
    const http = oauthHttpOptions(this.config.get());
    const parseClient = (requireSecret: boolean) => parseOAuthClient(credential, requireSecret);
    const checked = (path: string, url: string) => {
      try {
        checkOAuthUrl(url, http);
      } catch (e) {
        throw fail(path, e instanceof Error ? e.message : "Invalid URL");
      }
      return url;
    };

    if (auth.type === "oauth_client") {
      const manual = parseClient(true);
      const client: OAuthClientRecord = {
        clientId: manual.clientId,
        ...(manual.clientSecret !== undefined && { clientSecret: manual.clientSecret }),
        authMethod: auth.tokenAuthMethod ?? "client_secret_basic",
        tokenEndpoint: checked("auth.tokenUrl", auth.tokenUrl),
        ...(auth.scopes && { scopes: auth.scopes }),
      };
      try {
        const tokens = await tokenRequest(
          client,
          { grant_type: "client_credentials", scope: auth.scopes?.join(" ") },
          http,
          { tokenTypes: auth.tokenTypes },
        );
        return { client, tokens };
      } catch (e) {
        throw connectFailed(e);
      }
    }

    const manual = auth.client === "manual" ? parseClient(false) : undefined;
    if (!manual && credential !== undefined && credential !== null) {
      throw fail(
        "credential",
        "With client dcr the client is registered automatically; omit credential or use client manual",
      );
    }
    let meta: McpAuthMetadata | undefined;
    let endpoints: {
      authorizationEndpoint: string;
      tokenEndpoint: string;
      resource?: string;
      scopes?: string[];
    };
    if (auth.discovery === "mcp") {
      const url = isObj(endpoint) && typeof endpoint.url === "string" ? endpoint.url : undefined;
      if (url === undefined)
        throw fail("endpoint.url", "MCP OAuth discovery needs an endpoint URL");
      try {
        meta = await discoverMcp(url, http);
      } catch (e) {
        throw connectFailed(e);
      }
      endpoints = {
        authorizationEndpoint: meta.authorizationEndpoint,
        tokenEndpoint: meta.tokenEndpoint,
        resource: meta.resource,
        ...(meta.scopes && { scopes: meta.scopes }),
      };
    } else {
      endpoints = {
        authorizationEndpoint: checked("auth.authorizationUrl", auth.authorizationUrl ?? ""),
        tokenEndpoint: checked("auth.tokenUrl", auth.tokenUrl ?? ""),
      };
    }
    const scopes = auth.scopes ?? endpoints.scopes;
    if (manual) {
      return {
        client: {
          clientId: manual.clientId,
          ...(manual.clientSecret !== undefined && { clientSecret: manual.clientSecret }),
          authMethod:
            manual.clientSecret === undefined
              ? "none"
              : (auth.tokenAuthMethod ?? pickAuthMethod(meta?.authMethods, true)),
          authorizationEndpoint: endpoints.authorizationEndpoint,
          tokenEndpoint: endpoints.tokenEndpoint,
          ...(endpoints.resource !== undefined && { resource: endpoints.resource }),
          ...(meta && { issuer: meta.issuer }),
          ...(scopes && { scopes }),
        },
      };
    }
    if (!meta) throw fail("auth.client", "Dynamic client registration requires discovery mcp");
    try {
      const client = await registerClient(
        { ...meta, ...(scopes && { scopes }) },
        callbackUrl(publicUrl),
        http,
        productName(this.config.get()),
        auth.tokenAuthMethod,
      );
      return { client };
    } catch (e) {
      throw connectFailed(e);
    }
  }

  /**
   * The checks of {@link create} that need neither a connection nor the database: the slug, the
   * endpoint against the connector's schema, the credential shape, the OAuth client and the OAuth
   * URL policy. `create` runs them first; a plugin install runs them for every template before it
   * creates anything, so bad input is a 400 rather than a failed install. Returns what they parsed.
   * `deferred` ({@link createDeferredIn}): an OAuth connector takes no client (an org admin saves
   * it on the connector later) and needs no `http.publicUrl` yet (the connect flow requires it).
   */
  checkCreateInput(
    actorAccountId: string | null,
    input: CreateConnectorInput,
    opts: { deferred?: boolean } = {},
  ): { slug: string; endpoint: unknown; owner?: CredentialOwner; secret?: StaticSecret } {
    const slug = this.resolveSlug(input);
    const endpoint = this.parseEndpoint(input.connector, input.endpoint);
    const auth = input.auth;
    const credential = input.credential ?? undefined;
    if (!isOAuth(auth)) {
      if (credential === undefined) return { slug, endpoint };
      if (auth.type === "none") throw fail("credential", "Auth type none takes no credential");
      if (auth.ownership !== "org" && actorAccountId === null) {
        throw new Error("a member's credential needs the acting account");
      }
      const owner: CredentialOwner =
        auth.ownership === "org"
          ? { kind: "org" }
          : { kind: "user", accountId: actorAccountId as string };
      this.credentials.validate(auth, owner, credential);
      return { slug, endpoint, owner, secret: credential };
    }
    if (opts.deferred && credential !== undefined && credential !== null) {
      throw fail("credential", "The OAuth client is saved on the connector once it exists");
    }
    if (!opts.deferred && !this.config.get().http.publicUrl) throw publicUrlRequired();
    const http = oauthHttpOptions(this.config.get());
    const checked = (path: string, url: string) => {
      try {
        checkOAuthUrl(url, http);
      } catch (e) {
        throw fail(path, e instanceof Error ? e.message : "Invalid URL");
      }
    };
    if (auth.type === "oauth_client") {
      if (!opts.deferred) parseOAuthClient(credential, true);
      checked("auth.tokenUrl", auth.tokenUrl);
      return { slug, endpoint };
    }
    if (auth.client === "manual") {
      if (!opts.deferred) parseOAuthClient(credential, false);
    } else if (credential !== undefined) {
      throw fail(
        "credential",
        "With client dcr the client is registered automatically; omit credential or use client manual",
      );
    }
    if (auth.discovery === "mcp") {
      if (!isObj(endpoint) || typeof endpoint.url !== "string") {
        throw fail("endpoint.url", "MCP OAuth discovery needs an endpoint URL");
      }
      return { slug, endpoint };
    }
    checked("auth.authorizationUrl", auth.authorizationUrl ?? "");
    checked("auth.tokenUrl", auth.tokenUrl ?? "");
    if (auth.client !== "manual") {
      throw fail("auth.client", "Dynamic client registration requires discovery mcp");
    }
    return { slug, endpoint };
  }

  /**
   * 安装连接器（A4）：校验 → 用请求里的凭据（尚未落库）连接并 listTools → 一个事务内写连接器、工具快照、
   * 凭据与审计。连接失败时什么都不写。组织凭据型连接器的 `credential` 是组织凭据，个人型是创建者自己的。
   * OAuth（A16，要求 `http.publicUrl`）：授权码连接器不做首次 listTools（首个成员连接后刷新），只存客户端；
   * 客户端凭据连接器用安装时取到的组织 token listTools，存客户端与 token。
   */
  async create(
    orgId: string,
    actorAccountId: string,
    input: CreateConnectorInput,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    // 自建被禁止时先拒绝（事务里再复核一次）：不该为此触发外连
    if (!input.template) await assertCustomAllowed(this.db, "customConnectors");
    await this.assertKindAvailable(orgId, input.connector);
    const { slug, endpoint, owner, secret } = this.checkCreateInput(actorAccountId, input);
    const id = randomUUID();
    const auth = input.auth;
    const publicUrl = this.config.get().http.publicUrl;
    // 先做不需要连接的检查：冲突的 slug 不该触发一次外连 (a defaulted slug is chosen under the lock)
    if (!input.slugDefault && (await this.slugTaken(this.db, orgId, slug))) {
      throw new ApiError("connector.slug_taken", "Connector slug is already taken");
    }
    const oauth = isOAuth(auth)
      ? await this.prepareOAuth(auth, endpoint, input.credential, publicUrl as string)
      : undefined;
    let listed: { specs: unknown; resources: boolean } | undefined;
    if (auth.type !== "oauth_code") {
      listed = await this.drift.listTools(
        orgId,
        input.connector,
        endpoint,
        async () => {
          if (auth.type === "none") return { headers: {} };
          if (oauth?.tokens) {
            return this.credentials.injectionFor(id, auth, { token: oauth.tokens.access_token });
          }
          if (!secret) throw new CredentialMissing(id, auth.ownership);
          return this.credentials.injectionFor(id, auth, secret);
        },
        { slug },
      );
    }

    // the guide the wizard and 补充配置 showed: the template's current one (spec §11)
    const tpl = input.template;
    const guideAck =
      tpl?.templateId !== undefined
        ? await this.guides.templateAck(tpl.itemId, tpl.templateId)
        : null;
    return this.createIn(orgId, actorAccountId, input, actorTokenId, auditDetail, {
      id,
      slug,
      endpoint,
      owner,
      secret,
      oauth,
      listed,
      guideAck,
    });
  }

  /** The org-locked, re-checked insert of {@link create} (the outbound checks ran before). */
  @Transactional()
  private async createIn(
    orgId: string,
    actorAccountId: string,
    input: CreateConnectorInput,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
    c: ConnectorWrite,
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    const issues = await this.writeConnectorIn(
      orgId,
      actorAccountId,
      input,
      actorTokenId,
      auditDetail,
      c,
    );
    return { connector: await this.detail(this.db, orgId, c.id, actorAccountId), issues };
  }

  /**
   * Creates a connector without listing its tools (plugin pages spec §5.2.1 "Tool lists without
   * a network call in a transaction"): for plugin installs, scope syncs and upgrades, which create
   * connectors inside their own transaction. It makes no outbound call: the row is written with an
   * empty tool list (`tools_synced_at` null, so the first listing counts as the install's and
   * applies the template's default policies), a static credential in `input` is stored, and an
   * OAuth connector takes no client (an org admin saves it, which turns the connector ready).
   * When the connector is `ready` and its credential is not personal, the listing is owed in the
   * same transaction (`connector-tools-list`, trigger `created`); a personal one is listed on its
   * first member credential. `actorAccountId` null: the kernel itself (a scope sync); the
   * connector then has no creator (`created_by` null, ruling R17) and the audit no actor. With an
   * actor, `connectors.manage` is checked under the org lock. A `client: "dcr"` connector
   * registers its client on the first connect ({@link clientForConnect}). Returns the id.
   */
  @Transactional()
  async createDeferredIn(
    orgId: string,
    actorAccountId: string | null,
    input: CreateConnectorInput,
    opts: { actorTokenId?: string; auditDetail?: Record<string, unknown> } = {},
  ): Promise<string> {
    await this.assertKindAvailable(orgId, input.connector);
    const { slug, endpoint, owner, secret } = this.checkCreateInput(actorAccountId, input, {
      deferred: true,
    });
    const id = randomUUID();
    await this.writeConnectorIn(orgId, actorAccountId, input, opts.actorTokenId, opts.auditDetail, {
      id,
      slug,
      endpoint,
      owner,
      secret,
      oauth: undefined,
      listed: undefined,
      // nobody was shown the template's guide
      guideAck: null,
    });
    const auth = input.auth;
    const personal = auth.type !== "none" && auth.ownership === "personal";
    if (!personal && (await connectorSetup(this.credentials, orgId, id, auth)) === "ready") {
      await this.oweToolList(orgId, id, "created");
    }
    return id;
  }

  /**
   * The org-locked, re-checked insert shared by {@link createIn} and {@link createDeferredIn}
   * (joins their transaction); returns the snapshot's issues.
   */
  @Transactional({ propagation: "mandatory" })
  private async writeConnectorIn(
    orgId: string,
    actorAccountId: string | null,
    input: CreateConnectorInput,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
    c: ConnectorWrite,
  ): Promise<ToolIssue[]> {
    const { id, endpoint, owner, secret, oauth } = c;
    const auth = input.auth;
    const t = this.db;
    if (actorAccountId === null) await this.orgLock.lock(orgId);
    else await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    if (input.template) {
      await assertItemInstallable(
        t,
        orgId,
        input.template.itemId,
        input.template.approvedBy ?? input.template.itemId,
      );
    } else await assertCustomAllowed(t, "customConnectors");
    let slug = c.slug;
    let name = input.name;
    if (input.slugDefault) ({ slug, name } = await this.freeName(t, orgId, input.slugDefault));
    else if (await this.slugTaken(t, orgId, slug)) {
      throw new ApiError("connector.slug_taken", "Connector slug is already taken");
    }
    // the snapshot's keys name the final slug
    const { rows, issues } =
      c.listed === undefined
        ? { rows: [] as SnapshotRow[], issues: [] as ToolIssue[] }
        : snapshot(slug, c.listed.specs, c.listed.resources);
    // A connector made from a platform connector template stays linked to it (ruling E2)
    const tpl = input.template;
    const platformTemplate =
      tpl?.templateId !== undefined
        ? await t
            .selectFrom("platform_connector_templates")
            .select("id")
            .where("catalog_item_id", "=", tpl.itemId)
            .where("template_id", "=", tpl.templateId)
            .where("deleted_at", "is", null)
            .executeTakeFirst()
        : undefined;
    if (tpl?.mustBeOn) {
      const state =
        platformTemplate === undefined
          ? "absent"
          : await connectorTemplateState(t, orgId, platformTemplate.id);
      if (state === "absent") {
        throw new ApiError(
          "component.not_found",
          "The connector template does not exist or is not available in this organization",
        );
      }
      if (state === "off") {
        throw new ApiError(
          "component.off",
          "This connector template is off in this organization; switch it (or its plugin) on first",
        );
      }
    }
    await t
      .insertInto("connectors")
      .values({
        id,
        org_id: orgId,
        slug,
        name,
        connector: input.connector,
        endpoint: JSON.stringify(endpoint),
        auth: JSON.stringify(auth),
        git_hosts: input.git !== undefined ? JSON.stringify(input.git.hosts) : null,
        description: ownDescription(input.description),
        // null: created by the kernel as no person (ruling R17)
        created_by: actorAccountId,
        catalog_item_id: input.template?.itemId ?? null,
        catalog_version: input.template?.version ?? null,
        platform_template_id: platformTemplate?.id ?? null,
        // linked to its template only through the platform component (drift is judged there)
        guide_ack:
          platformTemplate !== undefined && c.guideAck !== null ? JSON.stringify(c.guideAck) : null,
        // 授权码连接器安装时没有快照：模板的默认策略留到首个快照时应用
        template_tool_policies: input.template?.defaultToolPolicies
          ? JSON.stringify(input.template.defaultToolPolicies)
          : null,
        // no listing (an authorization-code connector, A16, or a deferred create): left empty,
        // the first snapshot counts as the install's
        ...(c.listed !== undefined && { tools_synced_at: sql<Date>`now()` }),
      })
      .execute();
    await this.insertTools(id, rows, input.template?.defaultToolPolicies);
    if (secret && owner) await this.credentials.setStatic(orgId, id, auth, owner, secret);
    if (oauth) {
      await this.credentials.setOAuthClient(orgId, id, oauth.client);
      if (oauth.tokens) {
        await this.credentials.setOAuthTokens(orgId, id, { kind: "org" }, oauth.tokens);
      }
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.created",
      target: id,
      detail: {
        ...auditDetail,
        slug,
        connector: input.connector,
        auth: { type: auth.type, ...(auth.type !== "none" && { ownership: auth.ownership }) },
        tools: rows.length,
        credentialProvided: secret !== undefined || oauth !== undefined,
        ...(input.template && {
          catalog: {
            itemId: input.template.itemId,
            version: input.template.version,
            ...(input.template.templateId !== undefined && {
              templateId: input.template.templateId,
            }),
          },
        }),
      },
    });
    return issues;
  }

  /**
   * Owes a listing of the connector's tools in the caller's transaction (`connector-tools-list`,
   * processed by `ConnectorToolsProcessor` after the commit). `accountId`: the member whose
   * credential lists a personal connector.
   */
  @Transactional({ propagation: "mandatory" })
  private async oweToolList(
    orgId: string,
    connectorId: string,
    trigger: ConnectorToolsTrigger,
    accountId?: string,
  ): Promise<void> {
    // the transaction's start time: one id per owing transaction
    const { rows } = await sql<{
      seq: string;
    }>`SELECT (extract(epoch FROM now()) * 1000)::bigint::text AS seq`.execute(this.db);
    await this.outbox.add<ConnectorToolsJobData>({
      queue: CONNECTOR_TOOLS_QUEUE,
      name: CONNECTOR_TOOLS_JOB,
      jobId: connectorToolsJobId(connectorId, trigger, rows[0]?.seq ?? "0", accountId),
      data: { orgId, connectorId, ...(accountId !== undefined && { accountId }) },
      orgId,
    });
  }

  /**
   * Checks a template update before anything is written (the platform plugin update): the endpoint
   * against the connector's schema, and with `resetCredentials` the new credential's shape, or for
   * OAuth the client setup (discovery, dynamic registration or the client credentials token; an
   * outbound failure -> 502 `connector.connect_failed`). Writes nothing.
   */
  async prepareTemplateUpdate(
    actorAccountId: string | null,
    connector: string,
    input: TemplateUpdateInput,
  ): Promise<PreparedTemplateUpdate> {
    const endpoint = this.parseEndpoint(connector, input.endpoint);
    const out: PreparedTemplateUpdate = { input, endpoint };
    if (!input.resetCredentials) return out;
    const auth = input.auth;
    const credential = input.credential ?? undefined;
    if (!isOAuth(auth)) {
      if (credential === undefined) return out;
      if (auth.type === "none") throw fail("credential", "Auth type none takes no credential");
      if (auth.ownership !== "org" && actorAccountId === null) {
        throw new Error("a member's credential needs the acting account");
      }
      const owner: CredentialOwner =
        auth.ownership === "org"
          ? { kind: "org" }
          : { kind: "user", accountId: actorAccountId as string };
      this.credentials.validate(auth, owner, credential);
      return { ...out, owner, secret: credential };
    }
    const publicUrl = this.config.get().http.publicUrl;
    if (!publicUrl) throw publicUrlRequired();
    return { ...out, oauth: await this.prepareOAuth(auth, endpoint, credential, publicUrl) };
  }

  /**
   * Applies a prepared template update in the caller's transaction (the caller holds the org row
   * lock and checked the actor): the endpoint, auth and template version of the connector, the
   * template's default policies (`template_tool_policies`) and the policies the org did not set
   * (`policy_source` `template` or `derived`): a tool the new template names takes its policy
   * (`template`), an unnamed `template` tool returns to the policy derived from its annotations,
   * unnamed `derived` tools and the org's own (`admin`) stay (spec §10). Tool definitions are untouched (the next refresh takes the new endpoint through drift review). With `resetCredentials` the credentials are replaced.
   * Audits `connector.template_applied`. Deleted / missing -> `connector.not_found`.
   */
  @Transactional({ propagation: "mandatory" })
  async applyTemplateIn(
    orgId: string,
    connectorId: string,
    /** null: the kernel itself (a platform update the bootstrap step runs). */
    actorAccountId: string | null,
    p: PreparedTemplateUpdate,
    actorTokenId?: string,
  ): Promise<void> {
    const t = this.db;
    const before = await this.row(t, orgId, connectorId, true);
    const { input } = p;
    const policies = input.template.defaultToolPolicies;
    const botCapable =
      input.git !== undefined &&
      input.git.hosts.length > 0 &&
      input.auth.type !== "none" &&
      input.auth.ownership === "org";
    await t
      .updateTable("connectors")
      .set({
        endpoint: JSON.stringify(p.endpoint),
        auth: JSON.stringify(input.auth),
        git_hosts: input.git !== undefined ? JSON.stringify(input.git.hosts) : null,
        // "use for git" needs org ownership and git hosts: a template that drops either clears it
        ...(!botCapable && { use_for_git: false }),
        catalog_item_id: input.template.itemId,
        catalog_version: input.template.version,
        template_tool_policies: policies ? JSON.stringify(policies) : null,
        updated_at: sql`now()`,
      })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .execute();
    // Tools at a default the org did not set (template or derived): a tool the new template names
    // takes its policy (`template`); an unnamed `template` one returns to the derived policy;
    // unnamed derived ones and the org's own (`admin`) stay
    const atDefault = await t
      .selectFrom("connector_tools")
      .select(["name", "spec", "default_policy", "policy_source"])
      .where("connector_id", "=", connectorId)
      .where("policy_source", "in", ["template", "derived"])
      .forUpdate()
      .execute();
    const policyChanges: Record<string, { from: ToolPolicy; to: ToolPolicy }> = {};
    for (const tool of atDefault) {
      const named = policies !== undefined && Object.hasOwn(policies, tool.name);
      if (!named && tool.policy_source === "derived") continue;
      const next = named
        ? (policies[tool.name] as ToolPolicy)
        : policyFromAnnotations((tool.spec as ToolSpec).annotations);
      await t
        .updateTable("connector_tools")
        .set({ default_policy: next, policy_source: named ? "template" : "derived" })
        .where("connector_id", "=", connectorId)
        .where("name", "=", tool.name)
        .execute();
      if (next !== tool.default_policy) {
        policyChanges[tool.name] = { from: tool.default_policy, to: next };
      }
    }
    if (input.resetCredentials) {
      await this.credentials.clearConnector(orgId, connectorId);
      if (p.secret && p.owner) {
        await this.credentials.setStatic(orgId, connectorId, input.auth, p.owner, p.secret);
      }
      if (p.oauth) {
        await this.credentials.setOAuthClient(orgId, connectorId, p.oauth.client);
        if (p.oauth.tokens) {
          await this.credentials.setOAuthTokens(
            orgId,
            connectorId,
            { kind: "org" },
            p.oauth.tokens,
          );
        }
      }
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.template_applied",
      target: connectorId,
      detail: {
        catalog: {
          itemId: input.template.itemId,
          version: input.template.version,
          ...(input.template.templateId !== undefined && {
            templateId: input.template.templateId,
          }),
        },
        auth: {
          type: input.auth.type,
          ...(input.auth.type !== "none" && { ownership: input.auth.ownership }),
        },
        credentialsReset: input.resetCredentials,
        credentialProvided: p.secret !== undefined || p.oauth !== undefined,
        policies: policyChanges,
        ...(before.use_for_git && !botCapable && { useForGit: { from: true, to: false } }),
      },
    });
  }

  /** Refuses a loaded kind whose extension is not enabled in the org (the same notion as {@link kinds}). */
  private async assertKindAvailable(orgId: string, kind: string): Promise<void> {
    if (!this.registry.findConnector(kind)) return; // unknown kinds fail in parseEndpoint
    if (!(await this.registry.connectorKindAvailable(orgId, kind))) {
      throw new ApiError(
        "connector.kind_unavailable",
        `Connector kind "${kind}" is not enabled for this organization; enable its plugin first`,
      );
    }
  }

  /**
   * The connector kinds the org can create connectors of (the install wizard's protocol step): a
   * kind is listed when its `connector@1` extension is loaded and enabled in the org.
   */
  kinds(orgId: string): Promise<{ kind: string; plugin: string }[]> {
    return this.registry.connectorKindsFor(orgId);
  }

  /**
   * Previews a connector (Ruling A20, for the install wizard): after checking the connector, the
   * endpoint (credential pattern check included) and the credential shape, reads the endpoint
   * description with `connector.inspect` (auth hints, operations), and when it can authenticate
   * (static credentials / a token from the client credentials flow) or auth is none, also lists the
   * tools, builds keys from the slug and derives default policies and issues. Writes nothing (no
   * rows, no audit); the OAuth authorization code flow lists no tools (no dynamic registration).
   * Any outbound failure is 502 `connector.connect_failed`, the message holding only the
   * connector's English explanation (redacted by the injected credentials) or the error class name.
   * `customConnectors: deny` -> `catalog.custom_disabled`.
   */
  async preview(orgId: string, input: PreviewConnectorInput): Promise<ConnectorPreview> {
    // 部署禁止组织自建连接器时也不替组织去连任意端点（目录安装不走预览）
    await assertCustomAllowed(this.db, "customConnectors");
    await this.assertKindAvailable(orgId, input.connector);
    const endpoint = this.parseEndpoint(input.connector, input.endpoint);
    const connector = this.registry.findConnector(input.connector);
    if (!connector) throw fail("connector", `Unknown connector "${input.connector}"`);
    let slug = PREVIEW_SLUG;
    if (input.slug !== undefined) {
      if (!isValidSlug(input.slug)) throw fail("slug", SLUG_RULE);
      slug = input.slug;
    } else if (input.name !== undefined) {
      slug = deriveSlug(input.name) ?? PREVIEW_SLUG;
    }

    // check the credential shape before any outbound call
    const auth = input.auth;
    const credential = input.credential ?? undefined;
    let inject: (() => Promise<AuthInjection>) | undefined;
    let oauthClient = false;
    if (auth === undefined) {
      if (credential !== undefined && credential !== null) {
        throw fail("credential", "Provide auth together with credential");
      }
    } else if (auth.type === "none") {
      if (credential !== undefined && credential !== null) {
        throw fail("credential", "Auth type none takes no credential");
      }
      inject = async () => ({ headers: {} });
    } else if (!isOAuth(auth)) {
      if (credential !== undefined && credential !== null) {
        // 预览按「安装者自己的凭据」校验归属：组织型是组织凭据，个人型是自己的
        const owner: CredentialOwner =
          auth.ownership === "org" ? { kind: "org" } : { kind: "user", accountId: "preview" };
        this.credentials.validate(auth, owner, credential);
        const secret = credential;
        inject = async () => this.credentials.injectionFor("preview", auth, secret);
      }
    } else if (auth.type === "oauth_client" && credential !== undefined && credential !== null) {
      oauthClient = true;
    }

    const timeoutMs = this.config.get().tools.timeoutMs;
    let inspection: Awaited<ReturnType<NonNullable<typeof connector.inspect>>> | undefined;
    if (connector.inspect) {
      try {
        inspection = await connector.inspect({
          endpoint,
          signal: AbortSignal.timeout(timeoutMs),
          orgId,
        });
      } catch (e) {
        const message =
          e instanceof ToolError
            ? `Could not read the connector description: ${e.message.slice(0, MAX_INSPECT_DETAIL)}`
            : `Could not read the connector description (${e instanceof Error ? e.name : "Error"})`;
        throw new ApiError("connector.connect_failed", message);
      }
    }

    if (oauthClient && auth?.type === "oauth_client") {
      const oauth = await this.prepareOAuth(
        auth,
        endpoint,
        credential,
        this.config.get().http.publicUrl ?? "",
      );
      const token = oauth.tokens?.access_token;
      if (token) inject = async () => this.credentials.injectionFor("preview", auth, { token });
    }

    let tools: ToolPreview[] | null = null;
    let issues: ToolIssue[] = [];
    if (inject) {
      const listed = await this.drift.listTools(orgId, input.connector, endpoint, inject, {
        preview: true,
      });
      const snap = snapshot(slug, listed.specs, listed.resources);
      issues = snap.issues;
      tools = snap.rows.map((r) => ({
        name: r.name,
        key: connectorToolKey(slug, r.name),
        description: r.spec.description,
        inputSchema: r.spec.inputSchema,
        annotations: r.spec.annotations ?? null,
        defaultPolicy: policyFromAnnotations(r.spec.annotations),
        issue: r.issue,
        source: r.source,
      }));
    }
    return {
      tools,
      issues,
      authHints: inspection?.authHints ?? [],
      ...(inspection?.operations !== undefined && { operations: inspection.operations }),
    };
  }

  private async insertTools(
    connectorId: string,
    rows: SnapshotRow[],
    templatePolicies?: Record<string, ToolPolicy>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const t = this.db;
    await recordToolSpecs(t, rows);
    const fromTemplate = (name: string): ToolPolicy | undefined =>
      templatePolicies && Object.hasOwn(templatePolicies, name)
        ? templatePolicies[name]
        : undefined;
    await t
      .insertInto("connector_tools")
      .values(
        rows.map((r) => ({
          connector_id: connectorId,
          name: r.name,
          spec: JSON.stringify(r.spec),
          spec_hash: r.specHash,
          status: r.issue ? ("disabled" as const) : ("enabled" as const),
          default_policy: fromTemplate(r.name) ?? policyFromAnnotations(r.spec.annotations),
          ...(fromTemplate(r.name) !== undefined && { policy_source: "template" as const }),
          source: r.source,
          // 安装即复核
          ...(!r.issue && { reviewed_at: sql<Date>`now()` }),
        })),
      )
      .execute();
  }

  /** 读本组织未删除的连接器行；不存在 → `connector.not_found`。`lock` 时 FOR UPDATE。 */
  private async row(db: KernelSchemaDb, orgId: string, connectorId: string, lock = false) {
    let q = db
      .selectFrom("connectors")
      .selectAll()
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw notFound();
    return r;
  }

  /** The connector's derived setup state (spec §5.2.1), from its org input's key presence. */
  setupOf(
    orgId: string,
    r: Pick<Awaited<ReturnType<ConnectorsService["row"]>>, "id" | "auth">,
  ): Promise<ConnectorSetup> {
    return connectorSetup(this.credentials, orgId, r.id, r.auth as unknown as ConnectorAuth);
  }

  private summary(
    r: Awaited<ReturnType<ConnectorsService["row"]>>,
    setup: ConnectorSetup,
  ): ConnectorSummary {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      connector: r.connector,
      // a large text (such as an OpenAPI document) is not echoed in full: see endpoint.ts
      endpoint: endpointView(r.endpoint),
      auth: r.auth as unknown as ConnectorAuth,
      status: r.status,
      setup,
      platformTemplateId: r.platform_template_id ?? null,
      catalogItemId: r.catalog_item_id ?? null,
      git: r.git_hosts !== null && r.git_hosts.length > 0 ? { hosts: r.git_hosts } : null,
      useForGit: r.use_for_git,
      gitPushPolicy: r.git_push_policy,
      description: r.description ?? null,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async detail(
    db: KernelSchemaDb,
    orgId: string,
    connectorId: string,
    viewerAccountId: string,
  ): Promise<ConnectorDetail> {
    const r = await this.row(db, orgId, connectorId);
    const tools = await db
      .selectFrom("connector_tools")
      .select([
        "name",
        "spec",
        "spec_hash",
        "status",
        "default_policy",
        "source",
        "policy_source",
        "missing_since",
        "reviewed_at",
        "pending_spec",
        "pending_spec_hash",
        "pending_source",
      ])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    const s = this.summary(r, await this.setupOf(orgId, r));
    const auth = s.auth;
    const status = await this.credentials.status(orgId, connectorId, auth, viewerAccountId);
    return {
      ...s,
      tools: tools.map((t) => {
        const spec = t.spec as ToolSpec;
        const next = t.pending_spec as ToolSpec | null;
        return {
          name: t.name,
          key: connectorToolKey(r.slug, t.name),
          title: typeof spec.title === "string" ? spec.title : null,
          description: spec.description,
          inputSchema: spec.inputSchema,
          annotations: spec.annotations ?? null,
          connectorData: spec.connectorData ?? null,
          status: t.status,
          defaultPolicy: t.default_policy,
          specHash: t.spec_hash,
          issue: toolIssue(r.slug, next ?? spec),
          source: t.source,
          policySource: t.policy_source,
          missing: t.missing_since !== null,
          reviewedAt: t.reviewed_at,
          pending:
            next && t.pending_spec_hash !== null
              ? {
                  description: next.description,
                  inputSchema: next.inputSchema,
                  annotations: next.annotations ?? null,
                  connectorData: next.connectorData ?? null,
                  specHash: t.pending_spec_hash,
                  source: t.pending_source ?? t.source,
                }
              : null,
        };
      }),
      credential: { ownership: auth.type === "none" ? null : auth.ownership, status },
    };
  }

  /**
   * The setup guide fields of the org's connectors (`setupGuide`, `guideDrift`; spec
   * 2026-11-09-setup-guides-v2-design.md §9.3, §11): resolved through each connector's platform
   * template to its item's guide for that template; custom connectors get nulls.
   */
  async guideStates(
    org: { orgId: string; role: OrgRole },
    connectorIds: string[],
  ): Promise<Map<string, ConnectionGuideState>> {
    if (connectorIds.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("connectors as c")
      .leftJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
      .select(["c.id", "c.guide_ack", "t.catalog_item_id", "t.template_id"])
      .where("c.org_id", "=", org.orgId)
      .where("c.id", "in", [...new Set(connectorIds)])
      .where("c.deleted_at", "is", null)
      .execute();
    return this.guides.connectorStates(
      rows.map((r) => ({
        id: r.id,
        itemId: r.catalog_item_id ?? null,
        templateId: r.template_id ?? null,
        guideAck: r.guide_ack ?? null,
      })),
      org,
    );
  }

  /**
   * 「我已更新应用」 for a connector made from a template: records the template's current guide as
   * the one it is set up with. `hash` is the admin drift hash of the guide the person was shown;
   * when the plugin moved on since, 409 `connector.guide_changed` (show the new guide first). A
   * connector without a template guide, or whose item the org's catalog does not show -> 404
   * `catalog.guide_not_found`.
   */
  async ackGuide(
    org: { orgId: string; role: OrgRole },
    connectorId: string,
    hash: string,
    actorAccountId: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<ConnectorDetail> {
    const ack = await this.currentGuide(org, connectorId);
    if (ack.hash !== hash) {
      throw new ApiError(
        "connector.guide_changed",
        "The connector template's setup guide changed since it was shown; review the new guide first",
      );
    }
    return this.ackIn(org.orgId, connectorId, ack, actorAccountId, actorTokenId, auditDetail);
  }

  /**
   * The setup guide a connector made from a template would be acknowledged with now (the
   * template's guide in its item's latest version, with its admin drift hash). An unknown
   * connector -> 404 `connector.not_found`; one without a template guide, or whose item the org's
   * catalog does not show -> 404 `catalog.guide_not_found`.
   */
  async currentGuide(
    org: { orgId: string; role: OrgRole },
    connectorId: string,
  ): Promise<GuideAck> {
    const r = await this.db
      .selectFrom("connectors as c")
      .leftJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
      .select(["c.id", "t.catalog_item_id", "t.template_id"])
      .where("c.id", "=", connectorId)
      .where("c.org_id", "=", org.orgId)
      .where("c.deleted_at", "is", null)
      .executeTakeFirst();
    if (!r) throw notFound();
    const ack =
      r.catalog_item_id && r.template_id
        ? // the guide read's visibility: an item the org's catalog does not show has no guide
          await this.guides.templateAck(r.catalog_item_id, r.template_id, org)
        : null;
    if (ack === null) {
      throw new ApiError("catalog.guide_not_found", "The connector has no template setup guide");
    }
    return ack;
  }

  /** The row and audit of {@link ackGuide}, in one transaction under the org lock. */
  @Transactional()
  private async ackIn(
    orgId: string,
    connectorId: string,
    ack: GuideAck,
    actorAccountId: string,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<ConnectorDetail> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    const updated = await t
      .updateTable("connectors")
      .set({ guide_ack: JSON.stringify(ack), updated_at: sql<Date>`now()` })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw notFound();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.guide_confirmed",
      target: connectorId,
      detail: { ...auditDetail, guideId: ack.guideId, version: ack.version },
    });
    return this.detail(t, orgId, connectorId, actorAccountId);
  }

  /** The org's connectors that are not deleted (by creation time). */
  async list(orgId: string): Promise<ConnectorSummary[]> {
    const rows = await this.db
      .selectFrom("connectors")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    const setups = await connectorSetups(
      this.credentials,
      orgId,
      rows.map((r) => ({ id: r.id, auth: r.auth as unknown as ConnectorAuth })),
    );
    return rows.map((r) => this.summary(r, setups.get(r.id) ?? "needs_config"));
  }

  /**
   * Where a live connector of the org takes its icon from: its platform template and its plugin
   * (catalog item). Unknown -> `connector.not_found`.
   */
  async iconRef(
    orgId: string,
    connectorId: string,
  ): Promise<{ templateId: string | null; itemId: string | null }> {
    if (!UUID_RE.test(connectorId)) throw notFound();
    const r = await this.row(this.db, orgId, connectorId);
    return { templateId: r.platform_template_id ?? null, itemId: r.catalog_item_id ?? null };
  }

  async get(orgId: string, connectorId: string, viewerAccountId: string): Promise<ConnectorDetail> {
    return this.detail(this.db, orgId, connectorId, viewerAccountId);
  }

  /** 改名、启停连接器、工具启停与默认策略、批量把无注解工具改为 allow（`connectors.manage`）。 */
  @Transactional()
  async update(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    patch: UpdateConnectorInput,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<ConnectorDetail> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    const app = await this.row(t, orgId, connectorId, true);
    const current = await t
      .selectFrom("connector_tools")
      .select([
        "name",
        "spec",
        "status",
        "default_policy",
        "missing_since",
        "pending_spec_hash",
        "reviewed_at",
      ])
      .where("connector_id", "=", connectorId)
      .forUpdate()
      .execute();
    const byName = new Map(current.map((c) => [c.name, c]));
    const toolChanges = Object.entries(patch.tools ?? {});
    const problems: { path: string; message: string }[] = [];
    for (const [name, change] of toolChanges) {
      const c = byName.get(name);
      if (!c) {
        problems.push({ path: `tools.${name}`, message: "No such tool in this connector" });
        continue;
      }
      if (change.status === "enabled") {
        const path = `tools.${name}.status`;
        // 待复核（新增或定义变了）的工具只能经复核接口启用：这里启用会绕过复核、或把旧定义暴露给模型
        if (c.status === "pending_review" || c.pending_spec_hash !== null) {
          problems.push({
            path,
            message: `Tool is pending review; approve it with POST /connectors/${connectorId}/tools/${name}/review`,
          });
          continue;
        }
        if (c.missing_since !== null) {
          problems.push({ path, message: "The connector no longer provides this tool" });
          continue;
        }
        // 从未复核过的工具（如被拒绝的新工具）：启用等于跳过复核，只能经复核接口批准
        if (c.reviewed_at === null) {
          problems.push({
            path,
            message: `Tool has never been reviewed; approve it with POST /connectors/${connectorId}/tools/${name}/review`,
          });
          continue;
        }
        const issue = toolIssue(app.slug, c.spec as ToolSpec);
        if (issue) problems.push({ path, message: issue });
      }
    }
    const appAuth = app.auth as unknown as ConnectorAuth;
    if (patch.useForGit === true) {
      if (appAuth.type === "none" || appAuth.ownership !== "org") {
        problems.push({
          path: "useForGit",
          message:
            "Only an org-credential connector can be used for git; members' own connections always are",
        });
      } else if (app.git_hosts === null || app.git_hosts.length === 0) {
        problems.push({ path: "useForGit", message: "This connector declares no git hosts" });
      }
    }
    if (problems.length > 0) {
      throw new ApiError("validation_failed", "Request validation failed", problems);
    }

    const gitChanged = patch.useForGit !== undefined && patch.useForGit !== app.use_for_git;
    const description =
      patch.description !== undefined ? ownDescription(patch.description) : undefined;
    const descriptionChanged = description !== undefined && description !== app.description;
    if (
      patch.name !== undefined ||
      patch.status !== undefined ||
      gitChanged ||
      descriptionChanged
    ) {
      await t
        .updateTable("connectors")
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          // An explicit status change is the org's own decision: a plugin switch-off no longer
          // owns this connector, so a later switch-on must not turn it back on
          ...(patch.status !== undefined && {
            status: patch.status,
            disabled_by_plugin_id: null,
          }),
          ...(gitChanged && { use_for_git: patch.useForGit === true }),
          ...(descriptionChanged && { description }),
          updated_at: sql`now()`,
        })
        .where("id", "=", connectorId)
        .where("org_id", "=", orgId)
        .execute();
    }
    const allowed: string[] = [];
    if (patch.allowUnannotated) {
      for (const c of current) {
        const explicit = patch.tools?.[c.name]?.defaultPolicy !== undefined;
        if (
          !explicit &&
          c.default_policy === "ask" &&
          unannotated((c.spec as ToolSpec).annotations)
        ) {
          allowed.push(c.name);
        }
      }
      if (allowed.length > 0) {
        await t
          .updateTable("connector_tools")
          .set({ default_policy: "allow", policy_source: "admin" })
          .where("connector_id", "=", connectorId)
          .where("name", "in", allowed)
          .execute();
      }
    }
    for (const [name, change] of toolChanges) {
      if (change.status === undefined && change.defaultPolicy === undefined) continue;
      await t
        .updateTable("connector_tools")
        .set({
          ...(change.status !== undefined && { status: change.status }),
          ...(change.defaultPolicy !== undefined && {
            default_policy: change.defaultPolicy,
            policy_source: "admin" as const,
          }),
        })
        .where("connector_id", "=", connectorId)
        .where("name", "=", name)
        .execute();
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.updated",
      target: connectorId,
      detail: {
        ...auditDetail,
        ...(patch.name !== undefined && { name: { from: app.name, to: patch.name } }),
        ...(patch.status !== undefined && { status: { from: app.status, to: patch.status } }),
        ...(gitChanged && { useForGit: { from: app.use_for_git, to: patch.useForGit } }),
        ...(descriptionChanged && { description: { from: app.description, to: description } }),
        ...(toolChanges.length > 0 && { tools: Object.fromEntries(toolChanges) }),
        ...(allowed.length > 0 && { allowedUnannotated: allowed }),
      },
    });
    return this.detail(t, orgId, connectorId, actorAccountId);
  }

  /**
   * The read-only checks of {@link setGitPushPolicy} (the Platform operation's precheck): the
   * connector exists (`connector.not_found`) and declares git hosts (400 on `policy`); with
   * `onlyNarrows`, the change does not loosen it ({@link assertGitPushSettable}).
   */
  async checkGitPushPolicy(
    orgId: string,
    connectorId: string,
    policy: ToolPolicy,
    onlyNarrows: boolean,
  ): Promise<void> {
    const app = await this.row(this.db, orgId, connectorId);
    assertGitPushSettable(app.git_hosts, app.git_push_policy, policy, onlyNarrows);
  }

  /**
   * Sets the org's default git push policy for the connector (sandbox git credentials spec §7, the
   * virtual tool `git_push`; `connectors.manage`): read on every push by `decideGitPush`. Only a
   * connector that declares git hosts (else 400 on `policy`). `onlyNarrows` (the Platform tool,
   * API tokens): it may only tighten ({@link assertGitPushSettable}). Audits `connector.git_push_policy_changed`.
   */
  @Transactional()
  async setGitPushPolicy(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    policy: ToolPolicy,
    opts: {
      actorTokenId?: string | undefined;
      auditDetail?: Record<string, unknown> | undefined;
      onlyNarrows?: boolean;
    } = {},
  ): Promise<ConnectorDetail> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    const app = await this.row(t, orgId, connectorId, true);
    assertGitPushSettable(app.git_hosts, app.git_push_policy, policy, opts.onlyNarrows === true);
    if (policy !== app.git_push_policy) {
      await t
        .updateTable("connectors")
        .set({ git_push_policy: policy, updated_at: sql`now()` })
        .where("id", "=", connectorId)
        .where("org_id", "=", orgId)
        .execute();
      await audit(t, {
        actorAccountId,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        orgId,
        action: "connector.git_push_policy_changed",
        target: connectorId,
        detail: { from: app.git_push_policy, to: policy, ...opts.auditDetail },
      });
    }
    return this.detail(t, orgId, connectorId, actorAccountId);
  }

  /**
   * The org id of a live connector of a live org (the platform paths address a connector by its
   * global id); else `connector.not_found`.
   */
  private async liveOrgOf(connectorId: string): Promise<string> {
    const r = await this.db
      .selectFrom("connectors as c")
      .innerJoin("orgs as o", "o.id", "c.org_id")
      .select("c.org_id")
      .where("c.id", "=", connectorId)
      .where("c.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!r) throw notFound();
    return r.org_id;
  }

  /**
   * Disables a connector because its plugin was switched off in the org (spec §5 rule 8): its
   * endpoint and credentials stay. Only a connector that was active is marked with the plugin
   * (`connectors.disabled_by_plugin_id`), so switching the plugin back on re-enables exactly what
   * this call disabled; one an org admin disabled by hand keeps no marker and stays disabled. The
   * caller holds the org row lock and runs in its transaction.
   */
  @Transactional({ propagation: "mandatory" })
  async disableWithPluginIn(orgId: string, connectorId: string, itemId: string): Promise<void> {
    const t = this.db;
    const row = await t
      .selectFrom("connectors")
      .select(["status"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return;
    await t
      .updateTable("connectors")
      .set({
        status: "disabled",
        // An admin's disable is not the plugin's: it is not marked and so stays off on switch-on
        ...(row.status === "active" && { disabled_by_plugin_id: itemId }),
        updated_at: sql`now()`,
      })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .execute();
  }

  /**
   * Re-enables a connector the given plugin's switch-off disabled
   * ({@link disableWithPluginIn}) when the plugin is switched back on and its install takes the
   * connector back through the reuse path. A connector an org admin disabled by hand (no marker)
   * or one another state left disabled stays disabled. Returns whether it switched it on.
   */
  @Transactional()
  async enableIfPluginDisabledIn(
    orgId: string,
    connectorId: string,
    itemId: string,
  ): Promise<boolean> {
    const r = await this.db
      .updateTable("connectors")
      .set({ status: "active", disabled_by_plugin_id: null, updated_at: sql`now()` })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where("status", "=", "disabled")
      .where("disabled_by_plugin_id", "=", itemId)
      .returning("id")
      .executeTakeFirst();
    return r !== undefined;
  }

  /**
   * Disables or enables a connector on the platform's behalf (a super admin who need not be a
   * member of the org; the caller checks the super admin): org row lock, the status update, audit
   * `connector.updated` with `via: "platform"`. `auditDetail` (a Platform tool write's
   * `viaAgent`) is merged into the detail; `via` stays `"platform"`.
   */
  @Transactional()
  async setStatusAsPlatform(
    connectorId: string,
    status: "active" | "disabled",
    actor: WriteActor,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const t = this.db;
    const orgId = await this.liveOrgOf(connectorId);
    await this.orgLock.lock(orgId);
    const app = await this.row(t, orgId, connectorId, true);
    await t
      .updateTable("connectors")
      // The platform's explicit choice replaces a plugin switch-off's: a later plugin switch-on
      // leaves the connector as the platform set it
      .set({ status, disabled_by_plugin_id: null, updated_at: sql`now()` })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .execute();
    await audit(t, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "connector.updated",
      target: connectorId,
      detail: { ...auditDetail, status: { from: app.status, to: status }, via: "platform" },
    });
  }

  /**
   * Deletes a connector on the platform's behalf (see {@link setStatusAsPlatform}): org row lock,
   * then {@link removeIn} with `via: "platform"` in the audit detail (merged over `auditDetail`,
   * a Platform tool write's `viaAgent`).
   */
  @Transactional()
  async removeAsPlatform(
    connectorId: string,
    actor: WriteActor,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const orgId = await this.liveOrgOf(connectorId);
    await this.orgLock.lock(orgId);
    await this.removeIn(orgId, connectorId, actor.accountId, actor.tokenId, undefined, {
      ...auditDetail,
      via: "platform",
    });
  }

  /** 软删除，并删除该连接器的全部凭据（`connectors.manage`）。 */
  @Transactional()
  async remove(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    await this.removeIn(orgId, connectorId, actorAccountId, actorTokenId, undefined, auditDetail);
  }

  /**
   * 在调用方事务里软删除连接器（调用方已锁组织行并按需复核角色；应用安装的回滚与卸载用）：删全部凭据与授权，
   * 审计 `connector.deleted`（`reason` 并进 detail）。已删除 / 不存在 → `connector.not_found`。
   */
  @Transactional({ propagation: "mandatory" })
  async removeIn(
    orgId: string,
    connectorId: string,
    /** null: the kernel itself (the plugin scope sync uninstalling a plugin). */
    actorAccountId: string | null,
    actorTokenId?: string,
    reason?: string,
    /** Merged into the audit detail (a write made through the Platform tool). */
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const t = this.db;
    const app = await this.row(t, orgId, connectorId, true);
    await t
      .updateTable("connectors")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .execute();
    await this.credentials.clearConnector(orgId, connectorId);
    // 授权绑定连接器 id（软删除不触发外键级联）：一并删掉，不留给任何后来的连接器
    await t
      .deleteFrom("tool_grants")
      .where("org_id", "=", orgId)
      .where("connector_id", "=", connectorId)
      .execute();
    await t
      .deleteFrom("conversation_tool_grants")
      .where("connector_id", "=", connectorId)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.deleted",
      target: connectorId,
      detail: { slug: app.slug, ...(reason !== undefined && { reason }), ...auditDetail },
    });
  }

  /**
   * 重新 listTools 并按漂移检测的规则比对写入（见 drift.ts）：新增 / 定义变化的工具待复核（旧定义保留供对比），
   * 消失的工具停用；连接器从未拍过快照时首个快照直接启用。
   * 组织凭据型连接器用组织凭据，个人型用发起人自己的凭据（缺 → `credential.missing`）。OAuth 连接器收到 401 时
   * 在刷新锁内刷新 token 后重试一次。`trigger: "first_connect"`：OAuth 授权码连接器首个成员连接后由连接流程调用
   * （A16），只要求 `connectors.use`。审计 `connector.tools_refreshed`（变化的工具名，不含定义）。
   */
  async refresh(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
    opts: { trigger?: "first_connect"; auditDetail?: Record<string, unknown> } = {},
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[]; changes: DriftChanges }> {
    const app = await this.row(this.db, orgId, connectorId);
    const auth = app.auth as unknown as ConnectorAuth;
    const { specs, resources } = await this.drift.listTools(
      orgId,
      app.connector,
      app.endpoint,
      () => this.credentials.injection(orgId, connectorId, auth, actorAccountId),
      { connectorId },
      (last) => this.credentials.onUnauthorized(orgId, connectorId, auth, actorAccountId, last),
    );
    const { rows, issues } = snapshot(app.slug, specs, resources);

    return this.refreshIn(orgId, connectorId, actorAccountId, actorTokenId, opts, rows, issues);
  }

  /** The org-locked compare-and-write of {@link refresh} (the tool list was fetched before). */
  @Transactional()
  private async refreshIn(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId: string | undefined,
    opts: { trigger?: "first_connect"; auditDetail?: Record<string, unknown> },
    rows: SnapshotRow[],
    issues: ToolIssue[],
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[]; changes: DriftChanges }> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(
      orgId,
      actorAccountId,
      opts.trigger === "first_connect" ? "connectors.use" : "connectors.manage",
    );
    const changes = await this.drift.apply(await this.row(t, orgId, connectorId, true), rows);
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.tools_refreshed",
      target: connectorId,
      detail: { ...changes, ...(opts.trigger && { trigger: opts.trigger }), ...opts.auditDetail },
    });
    return {
      connector: await this.detail(t, orgId, connectorId, actorAccountId),
      issues,
      changes,
    };
  }

  /**
   * The consumer of a `connector-tools-list` job (`ConnectorToolsProcessor`, after the commit
   * that owed it): lists the connector's tools as {@link refresh} does and stores them with the
   * same compare-and-write, as the kernel itself (audit `connector.tools_refreshed` without an
   * actor). Idempotent: listing again compares against the stored snapshot and changes nothing.
   * Skipped (nothing written) when the connector is gone, disabled or `needs_config`, or the
   * credential to list with is missing (a later save owes a new job); an outbound failure throws,
   * so the queue retries it, and leaves the connector `ready` without tools (the drift scan
   * lists a connector without a snapshot too).
   */
  async listToolsForJob(data: ConnectorToolsJobData): Promise<"listed" | "skipped"> {
    const { orgId, connectorId, accountId } = data;
    const app = await this.db
      .selectFrom("connectors")
      .selectAll()
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (app?.status !== "active") return "skipped";
    const auth = app.auth as unknown as ConnectorAuth;
    const personal = auth.type !== "none" && auth.ownership === "personal";
    if (personal && accountId === undefined) return "skipped";
    if ((await this.setupOf(orgId, app)) === "needs_config") return "skipped";
    // a personal credential is that member's; an org credential needs an account id only
    // nominally: the creator, else the org's owner
    const as = accountId ?? app.created_by ?? (await firstOrgOwner(this.db, orgId));
    if (as === undefined) return "skipped";
    let listed: { specs: unknown; resources: boolean };
    try {
      listed = await this.drift.listTools(
        orgId,
        app.connector,
        app.endpoint,
        () => this.credentials.injection(orgId, connectorId, auth, as),
        { connectorId, job: CONNECTOR_TOOLS_JOB },
        (last) => this.credentials.onUnauthorized(orgId, connectorId, auth, as, last),
      );
    } catch (e) {
      if (e instanceof CredentialMissing) return "skipped";
      throw e;
    }
    const { rows } = snapshot(app.slug, listed.specs, listed.resources);
    return (await this.storeListedIn(orgId, connectorId, rows, accountId)) ? "listed" : "skipped";
  }

  /**
   * The org-locked write of {@link listToolsForJob}; false (nothing written) when the org or the
   * connector is gone, disabled or `needs_config` by now.
   */
  @Transactional()
  private async storeListedIn(
    orgId: string,
    connectorId: string,
    rows: SnapshotRow[],
    accountId: string | undefined,
  ): Promise<boolean> {
    const t = this.db;
    if (!(await this.orgLock.tryLock(orgId))) return false;
    const locked = await t
      .selectFrom("connectors")
      .selectAll()
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    // switched off or lost its input since the listing: write nothing (a later save owes a job)
    if (locked?.status !== "active") return false;
    if ((await this.setupOf(orgId, locked)) !== "ready") return false;
    const changes = await this.drift.apply(locked, rows);
    await audit(t, {
      orgId,
      action: "connector.tools_refreshed",
      target: connectorId,
      detail: { ...changes, trigger: "job", ...(accountId !== undefined && { accountId }) },
    });
    return true;
  }

  /**
   * Reviews a tool pending review (`connectors.manage`, spec 7.3). `approve`: adopts the pending
   * definition (if any) and enables it, `reviewed_at` set to now; the default policy is derived
   * again from the new definition's annotations unless an admin set it (`policy_source = admin`)
   * and the source did not change. `reject`: disables it, drops the pending definition and keeps
   * the old one; a never-reviewed tool keeps `reviewed_at` empty after a rejection (it can still
   * be approved). A missing tool -> 404 `connector.tool_not_found`; not reviewable (reviewed with
   * nothing pending, or gone) -> 409 `connector.tool_not_pending`; a non-compliant new definition
   * (such as an invalid key) cannot pass -> `validation_failed`. Adopting a new definition changes
   * the fingerprint: earlier "always allow" / "allow for this conversation" grants stop matching
   * (D8). Audits `connector.tool_reviewed`.
   */
  @Transactional()
  async reviewTool(
    orgId: string,
    connectorId: string,
    name: string,
    action: "approve" | "reject",
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<ConnectorDetail> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    const app = await this.row(t, orgId, connectorId, true);
    const tool = await t
      .selectFrom("connector_tools")
      .select([
        "status",
        "source",
        "spec",
        "policy_source",
        "pending_spec",
        "pending_spec_hash",
        "pending_source",
        "reviewed_at",
        "missing_since",
      ])
      .where("connector_id", "=", connectorId)
      .where("name", "=", name)
      .forUpdate()
      .executeTakeFirst();
    if (!tool) throw new ApiError("connector.tool_not_found", "Tool not found in this connector");
    // 可复核：待复核、有待复核的新定义，或从未复核过（如被拒绝的新工具，仍可再批准）；已消失的不可复核
    const reviewable =
      tool.status === "pending_review" ||
      tool.pending_spec_hash !== null ||
      tool.reviewed_at === null;
    if (!reviewable || tool.missing_since !== null) {
      throw new ApiError("connector.tool_not_pending", "Tool is not pending review");
    }
    const next = (tool.pending_spec ?? tool.spec) as ToolSpec;
    const nextSource = tool.pending_source ?? tool.source;
    if (action === "approve") {
      const issue = toolIssue(app.slug, next);
      if (issue) throw fail("action", issue);
    }
    const rederive = tool.policy_source === "derived" || nextSource !== tool.source;
    await t
      .updateTable("connector_tools")
      .set({
        ...(action === "approve"
          ? {
              status: "enabled" as const,
              ...(tool.pending_spec_hash !== null && {
                spec: JSON.stringify(next),
                spec_hash: tool.pending_spec_hash,
                source: nextSource,
              }),
              ...(rederive && {
                default_policy: policyFromAnnotations(next.annotations),
                policy_source: "derived" as const,
              }),
            }
          : { status: "disabled" as const }),
        pending_spec: null,
        pending_spec_hash: null,
        pending_source: null,
        // 拒绝从未复核过的工具不算「复核通过过」：reviewed_at 保持为空（之后不能经 PATCH 启用）
        ...((action === "approve" || tool.reviewed_at !== null) && {
          reviewed_at: sql<Date>`now()`,
        }),
      })
      .where("connector_id", "=", connectorId)
      .where("name", "=", name)
      .execute();
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.tool_reviewed",
      target: connectorId,
      detail: { tool: name, action },
    });
    return this.detail(t, orgId, connectorId, actorAccountId);
  }

  /**
   * 写凭据（组织凭据：`connectors.manage`；个人凭据：`connectors.use`，只写发起人自己的那一条）。
   * 形状与归属不符 → `validation_failed`。审计只记类型与归属。
   */
  async setCredential(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    ownership: "org" | "personal",
    value: unknown,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    if (ownership === "org") {
      const app = await this.row(this.db, orgId, connectorId);
      const auth = app.auth as unknown as ConnectorAuth;
      if (isOAuth(auth)) {
        await this.rotateOAuthClient(
          orgId,
          connectorId,
          actorAccountId,
          auth,
          app.endpoint,
          value,
          actorTokenId,
          auditDetail,
        );
        return;
      }
    }
    await this.setCredentialIn(
      orgId,
      connectorId,
      actorAccountId,
      ownership,
      value,
      actorTokenId,
      auditDetail,
    );
  }

  /** The org-locked static credential write of {@link setCredential}. */
  @Transactional()
  private async setCredentialIn(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    ownership: "org" | "personal",
    value: unknown,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(
      orgId,
      actorAccountId,
      ownership === "org" ? "connectors.manage" : "connectors.use",
    );
    const app = await this.row(t, orgId, connectorId, true);
    const auth = app.auth as unknown as ConnectorAuth;
    const owner: CredentialOwner =
      ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
    this.credentials.validate(auth, owner, value);
    const before = await this.setupOf(orgId, app);
    await this.credentials.setStatic(orgId, connectorId, auth, owner, value);
    if (ownership === "org" && before === "needs_config") {
      // the org credential it lacked: now ready, its tools follow (§5.2.1)
      await this.oweToolList(orgId, connectorId, "configured");
    } else if (ownership === "personal" && app.tools_synced_at === null) {
      // a personal connector with no tool list yet: the member's credential lists it
      await this.oweToolList(orgId, connectorId, "connected", actorAccountId);
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.credential.set",
      target: connectorId,
      detail: { ...auditDetail, type: auth.type, ownership },
    });
  }

  /**
   * Rotates the OAuth client (Ruling A18, the org credential route, `connectors.manage`): the
   * value is `{ clientId, clientSecret }`. A client credentials connector first fetches a token
   * with the new client to check it (failure -> 502 `connector.connect_failed`, nothing changed),
   * then replaces the client and the cached org token with the new one; an authorization-code
   * connector (manual client only) replaces only the client (members' tokens stay, and a later
   * refresh answered `invalid_client` drops them). The audit records the type and ownership only.
   * A connector with no client yet (`needs_config`, plugin pages spec §5.2.1) gets its first one
   * set up as a create does (the client credentials token, or the authorization-code endpoints
   * from discovery or the auth's URLs), outside any transaction.
   */
  private async rotateOAuthClient(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    auth: OAuthAuth,
    endpoint: unknown,
    value: unknown,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    if (auth.type === "oauth_code" && auth.client !== "manual") {
      throw fail(
        "auth.client",
        "The OAuth client of this connector was registered automatically and cannot be replaced",
      );
    }
    const next = parseOAuthClient(value, auth.type === "oauth_client", "");
    const current = await this.credentials.oauthClient(orgId, connectorId);
    if (!current) {
      // a dynamic registration is refused above, so the public URL is never used here
      const first = await this.prepareOAuth(auth, endpoint, next, "");
      await this.storeOAuthClient(
        orgId,
        connectorId,
        actorAccountId,
        auth,
        first.client,
        first.tokens,
        actorTokenId,
        auditDetail,
      );
      return;
    }
    const client: OAuthClientRecord = { ...current, clientId: next.clientId };
    delete client.clientSecret;
    if (next.clientSecret !== undefined) {
      client.clientSecret = next.clientSecret;
      client.authMethod =
        auth.tokenAuthMethod ??
        (current.authMethod === "none" ? "client_secret_basic" : current.authMethod);
    } else {
      client.authMethod = "none";
    }
    let tokens: OAuthTokenRecord | undefined;
    if (auth.type === "oauth_client") {
      try {
        tokens = await tokenRequest(
          client,
          { grant_type: "client_credentials", scope: (auth.scopes ?? client.scopes)?.join(" ") },
          oauthHttpOptions(this.config.get()),
          { tokenTypes: auth.tokenTypes },
        );
      } catch (e) {
        throw connectFailed(e);
      }
    }
    await this.storeOAuthClient(
      orgId,
      connectorId,
      actorAccountId,
      auth,
      client,
      tokens,
      actorTokenId,
      auditDetail,
    );
  }

  /** The org-locked client (and token) write of {@link rotateOAuthClient}. */
  @Transactional()
  private async storeOAuthClient(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    auth: OAuthAuth,
    client: OAuthClientRecord,
    tokens: OAuthTokenRecord | undefined,
    actorTokenId: string | undefined,
    auditDetail: Record<string, unknown> | undefined,
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    const app = await this.row(t, orgId, connectorId, true);
    const before = await this.setupOf(orgId, app);
    await this.credentials.setOAuthClient(orgId, connectorId, client);
    if (tokens) await this.credentials.setOAuthTokens(orgId, connectorId, { kind: "org" }, tokens);
    // the client it lacked: now ready; a client credentials connector lists its tools with the
    // org token (an authorization-code one waits for a member's first connection, A16)
    if (before === "needs_config" && auth.ownership === "org") {
      await this.oweToolList(orgId, connectorId, "configured");
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.credential.set",
      target: connectorId,
      detail: { ...auditDetail, type: auth.type, ownership: "org" },
    });
  }

  /**
   * The OAuth client a member's connect starts with (`OAuthFlow.start`): the stored one, else, for
   * an authorization-code connector with `client: "dcr"` created without one
   * ({@link createDeferredIn}, plugin pages spec §5.2.1, ruling R16), one registered now: discovery
   * and dynamic registration run once across replicas under the lock
   * `connector-dcr:<connectorId>` (re-read inside it, never inside a transaction), and the client
   * is stored unless another registration stored one first. Null: no client and none to register
   * (a manual client an org admin has not saved). An outbound failure is 502
   * `connector.connect_failed`.
   */
  async clientForConnect(
    orgId: string,
    connectorId: string,
    accountId: string,
  ): Promise<OAuthClientRecord | null> {
    const existing = await this.credentials.oauthClient(orgId, connectorId);
    if (existing) return existing;
    const app = await this.row(this.db, orgId, connectorId);
    const auth = app.auth as unknown as ConnectorAuth;
    if (auth.type !== "oauth_code" || auth.client !== "dcr") return null;
    const publicUrl = this.config.get().http.publicUrl;
    if (!publicUrl) throw publicUrlRequired();
    return this.locks.run(
      `connector-dcr:${connectorId}`,
      // one registration (discovery + DCR, each bounded by the 30 s OAuth timeout) per holder
      { ttlMs: 90_000, waitMs: 90_000 },
      async () => {
        const again = await this.credentials.oauthClient(orgId, connectorId);
        if (again) return again;
        const { client } = await this.prepareOAuth(auth, app.endpoint, undefined, publicUrl);
        return this.storeRegisteredClientIn(orgId, connectorId, accountId, client);
      },
    );
  }

  /** The org-locked write of {@link clientForConnect}: the first stored client wins. */
  @Transactional()
  private async storeRegisteredClientIn(
    orgId: string,
    connectorId: string,
    accountId: string,
    client: OAuthClientRecord,
  ): Promise<OAuthClientRecord> {
    await this.orgLock.lock(orgId);
    await this.row(this.db, orgId, connectorId, true);
    const stored = await this.credentials.oauthClient(orgId, connectorId);
    if (stored) return stored;
    await this.credentials.setOAuthClient(orgId, connectorId, client);
    await audit(this.db, {
      actorAccountId: accountId,
      orgId,
      // the registered client is the connector's org-level input
      action: "connector.credential.set",
      target: connectorId,
      detail: { type: "oauth_code", ownership: "org", registered: "dcr" },
    });
    return client;
  }

  /** 删除发起人自己的个人凭据（`connectors.use`）；本来就没有也成功。 */
  @Transactional()
  async clearMyCredential(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
    auditDetail?: Record<string, unknown>,
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.use");
    const app = await this.row(t, orgId, connectorId);
    await this.credentials.clear(orgId, connectorId, { kind: "user", accountId: actorAccountId });
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.credential.cleared",
      target: connectorId,
      detail: {
        ...auditDetail,
        type: (app.auth as unknown as ConnectorAuth).type,
        ownership: "personal",
      },
    });
  }
}
