import { randomUUID } from "node:crypto";
import {
  type AuthHint,
  type AuthInjection,
  type ConnectorOperation,
  type ToolAnnotations,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { z } from "zod";
import { assertItemInstallable } from "../catalog/requests.service.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { assertCustomAllowed } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
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
import { deriveSlug, isValidSlug, SLUG_RULE, toolKey } from "./naming.js";
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
import { policyFromAnnotations, type ToolPolicy, ToolRegistry } from "./registry.js";
import { recordToolSpecs } from "./specs.js";

export type { ToolIssue } from "./drift.js";

type ToolStatus = "enabled" | "disabled" | "pending_review";
type ToolSource = "connector" | "resources";

/** 连接器工具视图；`issue` 非空表示该工具不能启用的原因（如 key 超长）。 */
export interface ConnectorToolView {
  name: string;
  key: string;
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

/** 列表项：不含工具与凭据（`auth` 只有类型与非密钥字段）。 */
export interface ConnectorSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: unknown;
  auth: ConnectorAuth;
  status: "active" | "disabled";
  createdBy: string;
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
   * Install from an enterprise catalog connector template (T26, filled in by the catalog service,
   * not accepted over HTTP): the connector records its source item and version, the item policy is
   * re-checked in the transaction (a template inside an app passes the app item); once the tool
   * snapshot exists, `defaultToolPolicies` set the default policies (`policy_source 'template'`).
   * Absent = custom; rejected when the deployment setting `customConnectors` is deny
   * (`catalog.custom_disabled`).
   */
  template?: ConnectorTemplateRef | undefined;
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
}

/**
 * A connector updated to another version of its catalog template (an org plugin upgrade, package
 * ecosystem spec §10): only template-owned fields change (endpoint preset, auth preset, default tool
 * policies still at the template default); the name, slug, status, tools and credentials stay,
 * unless `resetCredentials`.
 */
export interface TemplateUpdateInput {
  /** The new template's endpoint preset with the org's values at its editable paths. */
  endpoint: unknown;
  auth: ConnectorAuth;
  /** The template version (itemId, version, templateId, defaultToolPolicies). */
  template: ConnectorTemplateRef;
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
}

const notFound = () => new ApiError("connector.not_found", "Connector not found");

const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

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
    /** Extension manifests (a slug may not take an extension's name; R6). */
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "manifests">,
    @Inject(Credentials) private readonly credentials: Credentials,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(ToolDrift) private readonly drift: ToolDrift,
    /** The org row lock (orgs/org-lock.ts; R12): joins the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
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
   */
  checkCreateInput(
    actorAccountId: string,
    input: CreateConnectorInput,
  ): { slug: string; endpoint: unknown; owner?: CredentialOwner; secret?: StaticSecret } {
    const slug = this.resolveSlug(input);
    const endpoint = this.parseEndpoint(input.connector, input.endpoint);
    if (this.extensions.manifests().some((m) => m.name === slug)) {
      throw fail("slug", `Slug "${slug}" is the name of an installed plugin; choose another`);
    }
    const auth = input.auth;
    const credential = input.credential ?? undefined;
    if (!isOAuth(auth)) {
      if (credential === undefined) return { slug, endpoint };
      if (auth.type === "none") throw fail("credential", "Auth type none takes no credential");
      const owner: CredentialOwner =
        auth.ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
      this.credentials.validate(auth, owner, credential);
      return { slug, endpoint, owner, secret: credential };
    }
    if (!this.config.get().http.publicUrl) throw publicUrlRequired();
    const http = oauthHttpOptions(this.config.get());
    const checked = (path: string, url: string) => {
      try {
        checkOAuthUrl(url, http);
      } catch (e) {
        throw fail(path, e instanceof Error ? e.message : "Invalid URL");
      }
    };
    if (auth.type === "oauth_client") {
      parseOAuthClient(credential, true);
      checked("auth.tokenUrl", auth.tokenUrl);
      return { slug, endpoint };
    }
    if (auth.client === "manual") parseOAuthClient(credential, false);
    else if (credential !== undefined) {
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
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    // 自建被禁止时先拒绝（事务里再复核一次）：不该为此触发外连
    if (!input.template) await assertCustomAllowed(this.db, "customConnectors");
    const { slug, endpoint, owner, secret } = this.checkCreateInput(actorAccountId, input);
    const id = randomUUID();
    const auth = input.auth;
    const publicUrl = this.config.get().http.publicUrl;
    // 先做不需要连接的检查：冲突的 slug 不该触发一次外连
    if (await this.slugTaken(this.db, orgId, slug)) {
      throw new ApiError("connector.slug_taken", "Connector slug is already taken");
    }
    const oauth = isOAuth(auth)
      ? await this.prepareOAuth(auth, endpoint, input.credential, publicUrl as string)
      : undefined;
    let rows: SnapshotRow[] = [];
    let issues: ToolIssue[] = [];
    if (auth.type !== "oauth_code") {
      const listed = await this.drift.listTools(
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
        { orgId, slug },
      );
      ({ rows, issues } = snapshot(slug, listed.specs, listed.resources));
    }

    return this.createIn(orgId, actorAccountId, input, actorTokenId, {
      id,
      slug,
      endpoint,
      owner,
      secret,
      oauth,
      rows,
      issues,
    });
  }

  /** The org-locked, re-checked insert of {@link create} (the outbound checks ran before). */
  @Transactional()
  private async createIn(
    orgId: string,
    actorAccountId: string,
    input: CreateConnectorInput,
    actorTokenId: string | undefined,
    c: {
      id: string;
      slug: string;
      endpoint: unknown;
      owner: CredentialOwner | undefined;
      secret: StaticSecret | undefined;
      oauth: OAuthSetup | undefined;
      rows: SnapshotRow[];
      issues: ToolIssue[];
    },
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[] }> {
    const { id, slug, endpoint, owner, secret, oauth, rows, issues } = c;
    const auth = input.auth;
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    if (input.template) {
      await assertItemInstallable(
        t,
        orgId,
        input.template.itemId,
        input.template.approvedBy ?? input.template.itemId,
      );
    } else await assertCustomAllowed(t, "customConnectors");
    if (await this.slugTaken(t, orgId, slug)) {
      throw new ApiError("connector.slug_taken", "Connector slug is already taken");
    }
    await t
      .insertInto("connectors")
      .values({
        id,
        org_id: orgId,
        slug,
        name: input.name,
        connector: input.connector,
        endpoint: JSON.stringify(endpoint),
        auth: JSON.stringify(auth),
        created_by: actorAccountId,
        catalog_item_id: input.template?.itemId ?? null,
        catalog_version: input.template?.version ?? null,
        // 授权码连接器安装时没有快照：模板的默认策略留到首个快照时应用
        template_tool_policies: input.template?.defaultToolPolicies
          ? JSON.stringify(input.template.defaultToolPolicies)
          : null,
        // 授权码连接器安装时不拍快照（A16）：留空，首个快照按安装处理
        ...(auth.type !== "oauth_code" && { tools_synced_at: sql<Date>`now()` }),
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
    return { connector: await this.detail(t, orgId, id, actorAccountId), issues };
  }

  /**
   * Checks a template update before anything is written (an org plugin upgrade): the endpoint
   * against the connector's schema, and with `resetCredentials` the new credential's shape, or for
   * OAuth the client setup (discovery, dynamic registration or the client credentials token; an
   * outbound failure -> 502 `connector.connect_failed`). Writes nothing.
   */
  async prepareTemplateUpdate(
    actorAccountId: string,
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
      const owner: CredentialOwner =
        auth.ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
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
    actorAccountId: string,
    p: PreparedTemplateUpdate,
    actorTokenId?: string,
  ): Promise<void> {
    const t = this.db;
    await this.row(t, orgId, connectorId, true);
    const { input } = p;
    const policies = input.template.defaultToolPolicies;
    await t
      .updateTable("connectors")
      .set({
        endpoint: JSON.stringify(p.endpoint),
        auth: JSON.stringify(input.auth),
        catalog_item_id: input.template.itemId,
        catalog_version: input.template.version,
        template_tool_policies: policies ? JSON.stringify(policies) : null,
        updated_at: sql`now()`,
      })
      .where("id", "=", connectorId)
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
      },
    });
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

    // 先校验凭据形状，再做任何外连
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
        inspection = await connector.inspect({ endpoint, signal: AbortSignal.timeout(timeoutMs) });
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
      const listed = await this.drift.listTools(input.connector, endpoint, inject, {
        orgId,
        preview: true,
      });
      const snap = snapshot(slug, listed.specs, listed.resources);
      issues = snap.issues;
      tools = snap.rows.map((r) => ({
        name: r.name,
        key: toolKey(slug, r.name),
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

  private summary(r: Awaited<ReturnType<ConnectorsService["row"]>>): ConnectorSummary {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      connector: r.connector,
      // 大段文本（如 OpenAPI 文档）不回显全文，见 endpoint.ts
      endpoint: endpointView(r.endpoint),
      auth: r.auth as unknown as ConnectorAuth,
      status: r.status,
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
    const s = this.summary(r);
    const auth = s.auth;
    const status = await this.credentials.status(orgId, connectorId, auth, viewerAccountId);
    return {
      ...s,
      tools: tools.map((t) => {
        const spec = t.spec as ToolSpec;
        const next = t.pending_spec as ToolSpec | null;
        return {
          name: t.name,
          key: toolKey(r.slug, t.name),
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

  /** 本组织未删除的连接器（按创建时间）。 */
  async list(orgId: string): Promise<ConnectorSummary[]> {
    const rows = await this.db
      .selectFrom("connectors")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((r) => this.summary(r));
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
    if (problems.length > 0) {
      throw new ApiError("validation_failed", "Request validation failed", problems);
    }

    if (patch.name !== undefined || patch.status !== undefined) {
      await t
        .updateTable("connectors")
        .set({
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.status !== undefined && { status: patch.status }),
          updated_at: sql`now()`,
        })
        .where("id", "=", connectorId)
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
        ...(patch.name !== undefined && { name: { from: app.name, to: patch.name } }),
        ...(patch.status !== undefined && { status: { from: app.status, to: patch.status } }),
        ...(toolChanges.length > 0 && { tools: Object.fromEntries(toolChanges) }),
        ...(allowed.length > 0 && { allowedUnannotated: allowed }),
      },
    });
    return this.detail(t, orgId, connectorId, actorAccountId);
  }

  /** 软删除，并删除该连接器的全部凭据（`connectors.manage`）。 */
  @Transactional()
  async remove(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    await this.removeIn(orgId, connectorId, actorAccountId, actorTokenId);
  }

  /**
   * 在调用方事务里软删除连接器（调用方已锁组织行并按需复核角色；应用安装的回滚与卸载用）：删全部凭据与授权，
   * 审计 `connector.deleted`（`reason` 并进 detail）。已删除 / 不存在 → `connector.not_found`。
   */
  @Transactional({ propagation: "mandatory" })
  async removeIn(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
    reason?: string,
  ): Promise<void> {
    const t = this.db;
    const app = await this.row(t, orgId, connectorId, true);
    await t
      .updateTable("connectors")
      .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
      .where("id", "=", connectorId)
      .execute();
    await this.credentials.clearConnector(orgId, connectorId);
    // 授权绑定连接器 id（软删除不触发外键级联）：一并删掉，不留给任何后来的连接器
    await t.deleteFrom("tool_grants").where("connector_id", "=", connectorId).execute();
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
      detail: { slug: app.slug, ...(reason !== undefined && { reason }) },
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
    opts: { trigger?: "first_connect" } = {},
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[]; changes: DriftChanges }> {
    const app = await this.row(this.db, orgId, connectorId);
    const auth = app.auth as unknown as ConnectorAuth;
    const { specs, resources } = await this.drift.listTools(
      app.connector,
      app.endpoint,
      () => this.credentials.injection(orgId, connectorId, auth, actorAccountId),
      { orgId, connectorId },
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
    opts: { trigger?: "first_connect" },
    rows: SnapshotRow[],
    issues: ToolIssue[],
  ): Promise<{ connector: ConnectorDetail; issues: ToolIssue[]; changes: DriftChanges }> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(
      orgId,
      actorAccountId,
      opts.trigger === "first_connect" ? "connectors.use" : "connectors.manage",
    );
    const locked = await this.row(t, orgId, connectorId, true);
    const changes = await this.drift.apply(locked, rows);
    // 首个快照（授权码连接器首个成员连接后）：按目录模板的 defaultToolPolicies 设默认策略（policy_source 'template'）
    const templatePolicies = locked.template_tool_policies;
    if (locked.tools_synced_at === null && templatePolicies) {
      for (const [name, policy] of Object.entries(templatePolicies)) {
        await t
          .updateTable("connector_tools")
          .set({ default_policy: policy, policy_source: "template" })
          .where("connector_id", "=", connectorId)
          .where("name", "=", name)
          .where("policy_source", "=", "derived")
          .execute();
      }
    }
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.tools_refreshed",
      target: connectorId,
      detail: { ...changes, ...(opts.trigger && { trigger: opts.trigger }) },
    });
    return {
      connector: await this.detail(t, orgId, connectorId, actorAccountId),
      issues,
      changes,
    };
  }

  /**
   * 复核一个待复核的工具（`connectors.manage`，spec 7.3）。`approve`：采用待复核的新定义（若有）并启用，
   * `reviewed_at` 记为现在；默认策略按新定义的注解重新推导，除非管理员设过（`policy_source = admin`）且来源没变。
   * `reject`：停用，丢弃待复核的新定义、保留旧定义；从未复核过的工具被拒后 `reviewed_at` 仍为空（仍可再批准）。
   * 工具不存在 → 404 `connector.tool_not_found`；不可复核（已复核且无待复核定义，或已消失）→ 409 `connector.tool_not_pending`；新定义不合规（如 key 不合法）不能通过 → `validation_failed`。
   * 采用新定义即换了指纹：旧的「以后都允许」/「本会话都允许」授权按指纹比对自然失效（D8）。审计 `connector.tool_reviewed`。
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
  ): Promise<void> {
    if (ownership === "org") {
      const app = await this.row(this.db, orgId, connectorId);
      const auth = app.auth as unknown as ConnectorAuth;
      if (isOAuth(auth)) {
        await this.rotateOAuthClient(orgId, connectorId, actorAccountId, auth, value, actorTokenId);
        return;
      }
    }
    await this.setCredentialIn(orgId, connectorId, actorAccountId, ownership, value, actorTokenId);
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
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(
      orgId,
      actorAccountId,
      ownership === "org" ? "connectors.manage" : "connectors.use",
    );
    const app = await this.row(t, orgId, connectorId);
    const auth = app.auth as unknown as ConnectorAuth;
    const owner: CredentialOwner =
      ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
    this.credentials.validate(auth, owner, value);
    await this.credentials.setStatic(orgId, connectorId, auth, owner, value);
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.credential.set",
      target: connectorId,
      detail: { type: auth.type, ownership },
    });
  }

  /**
   * 轮换 OAuth 客户端（Ruling A18，组织凭据接口，`connectors.manage`）：值为 `{ clientId, clientSecret }`。
   * 客户端凭据连接器先用新客户端取一次 token 验证（失败 → 502 `connector.connect_failed`，什么都不改），再替换客户端并以
   * 新 token 替换缓存的组织 token；授权码连接器只限手填 client，只替换客户端（成员的 token 保留，之后刷新若得到
   * invalid_client 会作废）。审计只记类型与归属。
   */
  private async rotateOAuthClient(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    auth: OAuthAuth,
    value: unknown,
    actorTokenId?: string,
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
      throw new ApiError(
        "connector.connect_failed",
        "The connector has no registered OAuth client; reinstall it",
      );
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
  ): Promise<void> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actorAccountId, "connectors.manage");
    await this.row(t, orgId, connectorId, true);
    await this.credentials.setOAuthClient(orgId, connectorId, client);
    if (tokens) await this.credentials.setOAuthTokens(orgId, connectorId, { kind: "org" }, tokens);
    await audit(t, {
      actorAccountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.credential.set",
      target: connectorId,
      detail: { type: auth.type, ownership: "org" },
    });
  }

  /** 删除发起人自己的个人凭据（`connectors.use`）；本来就没有也成功。 */
  @Transactional()
  async clearMyCredential(
    orgId: string,
    connectorId: string,
    actorAccountId: string,
    actorTokenId?: string,
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
      detail: { type: (app.auth as unknown as ConnectorAuth).type, ownership: "personal" },
    });
  }
}
