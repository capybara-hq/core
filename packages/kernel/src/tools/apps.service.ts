import { randomUUID } from "node:crypto";
import {
  type AuthHint,
  type AuthInjection,
  type ConnectorOperation,
  type ToolAnnotations,
  ToolError,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockOrgAndAuthorize } from "../orgs/org-lock.js";
import type { PluginHost } from "../plugins/host.js";
import {
  type AppAuth,
  CredentialMissing,
  type CredentialOwner,
  type Credentials,
  isOAuth,
  type OAuthAuth,
  type StaticSecret,
} from "./credentials.js";
import {
  type DriftChanges,
  type SnapshotRow,
  snapshot,
  type ToolDrift,
  type ToolIssue,
  toolIssue,
} from "./drift.js";
import { endpointCredentialIssues } from "./endpoint.js";
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
import { callbackUrl, publicUrlRequired } from "./oauth/flow.js";
import {
  type OAuthClientRecord,
  OAuthGrantError,
  type OAuthTokenRecord,
  OAuthUnavailable,
  tokenRequest,
} from "./oauth/tokens.js";
import { policyFromAnnotations, type ToolPolicy, type ToolRegistry } from "./registry.js";
import { recordToolSpecs } from "./specs.js";

type Trx = Transaction<KernelDatabase>;

export type { ToolIssue } from "./drift.js";

type ToolStatus = "enabled" | "disabled" | "pending_review";
type ToolSource = "connector" | "resources";

/** 应用工具视图；`issue` 非空表示该工具不能启用的原因（如 key 超长）。 */
export interface AppToolView {
  name: string;
  key: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations | null;
  status: ToolStatus;
  defaultPolicy: ToolPolicy;
  specHash: string;
  issue: string | null;
  /** `resources`：内核为支持 resources 的应用补上的工具（见 resources.ts）。 */
  source: ToolSource;
  /** 默认策略的来历：`derived` 按注解推导（定义变化复核通过后重新推导），`admin` 管理员设定（保留）。 */
  policySource: "derived" | "admin";
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
    specHash: string;
    source: ToolSource;
  } | null;
}

/** 列表项：不含工具与凭据（`auth` 只有类型与非密钥字段）。 */
export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: unknown;
  auth: AppAuth;
  status: "active" | "disabled";
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppDetail extends AppSummary {
  tools: AppToolView[];
  /** 当前用户视角的凭据状态；`ownership` 为 null 表示无需凭据（auth none）。 */
  credential: { ownership: "org" | "personal" | null; status: "connected" | "missing" };
}

export interface CreateAppInput {
  name: string;
  slug?: string | undefined;
  connector: string;
  endpoint: unknown;
  auth: AppAuth;
  credential?: unknown;
}

export interface PreviewAppInput {
  name?: string | undefined;
  slug?: string | undefined;
  connector: string;
  endpoint: unknown;
  auth?: AppAuth | undefined;
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
 * 应用预览（Ruling A20）：`tools` 为 null 表示没有列工具（没给认证方式、需要凭据但没给、OAuth 授权码流）；
 * `authHints` / `operations` 来自连接器的 `inspect`（不实现时为空 / 缺省）。
 */
export interface AppPreview {
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

export interface UpdateAppInput {
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

const notFound = () => new ApiError("app.not_found", "App not found");

const fail = (path: string, message: string) =>
  new ApiError("validation_failed", "Request validation failed", [{ path, message }]);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** OAuth 应用在安装时可带的客户端（手填 client / 客户端凭据流）。 */
const OAuthClientCredential = z.strictObject({
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().min(1).max(4000).optional(),
});

/** 发现 / 注册 / 取 token 的失败 → 502 `app.connect_failed`，details 带原因码（向导据 `dcr_unsupported` 改为手填 client）。 */
function connectFailed(e: unknown): ApiError {
  if (e instanceof OAuthSetupError) {
    return new ApiError("app.connect_failed", e.message, [
      { reason: e.reason, message: e.message },
    ]);
  }
  if (e instanceof OAuthGrantError) {
    const message = `The authorization server rejected the client credentials (${e.error})`;
    return new ApiError("app.connect_failed", message, [{ reason: "token_failed", message }]);
  }
  const message =
    e instanceof OAuthUnavailable ? e.message : "Could not complete OAuth setup with the app";
  return new ApiError("app.connect_failed", message, [{ reason: "token_failed", message }]);
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
interface OAuthSetup {
  client: OAuthClientRecord;
  tokens?: OAuthTokenRecord;
}

/** 无注解 = 既没有 readOnlyHint 也没有 destructiveHint。 */
const unannotated = (a: ToolAnnotations | undefined) =>
  a?.readOnlyHint === undefined && a?.destructiveHint === undefined;

/**
 * 应用（已安装的连接器实例）与其工具快照、凭据。写操作都在组织行锁内复核发起人权限并写审计
 * （detail 只有凭据类型与归属，没有值）。连接器会话按操作打开、用完即关，不在进程内缓存。
 */
export class AppsService {
  constructor(
    private readonly db: KernelDb,
    private readonly registry: ToolRegistry,
    private readonly host: PluginHost,
    private readonly credentials: Credentials,
    private readonly config: () => KernelConfig,
    private readonly drift: ToolDrift,
  ) {}

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

  private async slugTaken(db: KernelDb | Trx, orgId: string, slug: string): Promise<boolean> {
    const row = await db
      .selectFrom("apps")
      .select("id")
      .where("org_id", "=", orgId)
      .where("slug", "=", slug)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row !== undefined;
  }

  private resolveSlug(input: CreateAppInput): string {
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
   * OAuth 应用安装前的准备（A16）：授权码流按 `discovery` 取端点（MCP 发现或手填）、按 `client` 动态注册或用请求里
   * 手填的 client（不做首次 listTools）；客户端凭据流用请求里的 client 取一次组织 token。
   * 外连失败一律 502 `app.connect_failed`（details 带原因码），什么都不写。
   */
  private async prepareOAuth(
    auth: OAuthAuth,
    endpoint: unknown,
    credential: unknown,
    publicUrl: string,
  ): Promise<OAuthSetup> {
    const http = oauthHttpOptions(this.config());
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
   * 安装应用（A4）：校验 → 用请求里的凭据（尚未落库）连接并 listTools → 一个事务内写应用、工具快照、
   * 凭据与审计。连接失败时什么都不写。组织凭据型应用的 `credential` 是组织凭据，个人型是创建者自己的。
   * OAuth（A16，要求 `http.publicUrl`）：授权码应用不做首次 listTools（首个成员连接后刷新），只存客户端；
   * 客户端凭据应用用安装时取到的组织 token listTools，存客户端与 token。
   */
  async create(
    orgId: string,
    actorAccountId: string,
    input: CreateAppInput,
    actorTokenId?: string,
  ): Promise<{ app: AppDetail; issues: ToolIssue[] }> {
    const slug = this.resolveSlug(input);
    const endpoint = this.parseEndpoint(input.connector, input.endpoint);
    if (this.host.manifests().some((m) => m.name === slug)) {
      throw fail("slug", `Slug "${slug}" is the name of an installed plugin; choose another`);
    }
    const id = randomUUID();
    const auth = input.auth;
    let owner: CredentialOwner | undefined;
    let secret: StaticSecret | undefined;
    const publicUrl = this.config().http.publicUrl;
    if (isOAuth(auth) && !publicUrl) throw publicUrlRequired();
    if (!isOAuth(auth) && input.credential !== undefined && input.credential !== null) {
      if (auth.type === "none") throw fail("credential", "Auth type none takes no credential");
      owner =
        auth.ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
      this.credentials.validate(auth, owner, input.credential);
      secret = input.credential;
    }
    // 先做不需要连接的检查：冲突的 slug 不该触发一次外连
    if (await this.slugTaken(this.db, orgId, slug)) {
      throw new ApiError("app.slug_taken", "App slug is already taken");
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

    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      if (await this.slugTaken(t, orgId, slug)) {
        throw new ApiError("app.slug_taken", "App slug is already taken");
      }
      await t
        .insertInto("apps")
        .values({
          id,
          org_id: orgId,
          slug,
          name: input.name,
          connector: input.connector,
          endpoint: JSON.stringify(endpoint),
          auth: JSON.stringify(auth),
          created_by: actorAccountId,
          // 授权码应用安装时不拍快照（A16）：留空，首个快照按安装处理
          ...(auth.type !== "oauth_code" && { tools_synced_at: sql<Date>`now()` }),
        })
        .execute();
      await this.insertTools(t, id, rows);
      if (secret && owner) await this.credentials.setStatic(orgId, id, auth, owner, secret, t);
      if (oauth) {
        await this.credentials.setOAuthClient(orgId, id, oauth.client, t);
        if (oauth.tokens) {
          await this.credentials.setOAuthTokens(orgId, id, { kind: "org" }, oauth.tokens, t);
        }
      }
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.created",
        target: id,
        detail: {
          slug,
          connector: input.connector,
          auth: { type: auth.type, ...(auth.type !== "none" && { ownership: auth.ownership }) },
          tools: rows.length,
          credentialProvided: secret !== undefined || oauth !== undefined,
        },
      });
      return { app: await this.detail(t, orgId, id, actorAccountId), issues };
    });
  }

  /**
   * 预览应用（Ruling A20，安装向导用）：校验连接器、端点（含凭据样式检查）与凭据形状后，用 `connector.inspect`
   * 读端点描述（认证提示、操作清单），能认证（静态凭据 / 客户端凭据流取到的 token）或 auth none 时再列工具并按
   * slug 拼 key、推导默认策略与问题。什么都不写（不落库、不审计）；OAuth 授权码流不列工具（不做动态注册）。
   * 外连失败一律 502 `app.connect_failed`，说明里只有连接器给的英文说明（按注入的凭据打码）或错误类名。
   */
  async preview(orgId: string, input: PreviewAppInput): Promise<AppPreview> {
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

    const timeoutMs = this.config().tools.timeoutMs;
    let inspection: Awaited<ReturnType<NonNullable<typeof connector.inspect>>> | undefined;
    if (connector.inspect) {
      try {
        inspection = await connector.inspect({ endpoint, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const message =
          e instanceof ToolError
            ? `Could not read the app description: ${e.message.slice(0, MAX_INSPECT_DETAIL)}`
            : `Could not read the app description (${e instanceof Error ? e.name : "Error"})`;
        throw new ApiError("app.connect_failed", message);
      }
    }

    if (oauthClient && auth?.type === "oauth_client") {
      const oauth = await this.prepareOAuth(
        auth,
        endpoint,
        credential,
        this.config().http.publicUrl ?? "",
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

  private async insertTools(t: Trx, appId: string, rows: SnapshotRow[]): Promise<void> {
    if (rows.length === 0) return;
    await recordToolSpecs(t, rows);
    await t
      .insertInto("app_tools")
      .values(
        rows.map((r) => ({
          app_id: appId,
          name: r.name,
          spec: JSON.stringify(r.spec),
          spec_hash: r.specHash,
          status: r.issue ? ("disabled" as const) : ("enabled" as const),
          default_policy: policyFromAnnotations(r.spec.annotations),
          source: r.source,
          // 安装即复核
          ...(!r.issue && { reviewed_at: sql<Date>`now()` }),
        })),
      )
      .execute();
  }

  /** 读本组织未删除的应用行；不存在 → `app.not_found`。`lock` 时 FOR UPDATE。 */
  private async row(db: KernelDb | Trx, orgId: string, appId: string, lock = false) {
    let q = db
      .selectFrom("apps")
      .selectAll()
      .where("id", "=", appId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r) throw notFound();
    return r;
  }

  private summary(r: Awaited<ReturnType<AppsService["row"]>>): AppSummary {
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      connector: r.connector,
      endpoint: r.endpoint,
      auth: r.auth as unknown as AppAuth,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private async detail(
    db: KernelDb | Trx,
    orgId: string,
    appId: string,
    viewerAccountId: string,
  ): Promise<AppDetail> {
    const r = await this.row(db, orgId, appId);
    const tools = await db
      .selectFrom("app_tools")
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
      .where("app_id", "=", appId)
      .orderBy("name")
      .execute();
    const s = this.summary(r);
    const auth = s.auth;
    const status = await this.credentials.status(
      orgId,
      appId,
      auth,
      viewerAccountId,
      db === this.db ? undefined : (db as Trx),
    );
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
                  specHash: t.pending_spec_hash,
                  source: t.pending_source ?? t.source,
                }
              : null,
        };
      }),
      credential: { ownership: auth.type === "none" ? null : auth.ownership, status },
    };
  }

  /** 本组织未删除的应用（按创建时间）。 */
  async list(orgId: string): Promise<AppSummary[]> {
    const rows = await this.db
      .selectFrom("apps")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    return rows.map((r) => this.summary(r));
  }

  async get(orgId: string, appId: string, viewerAccountId: string): Promise<AppDetail> {
    return this.detail(this.db, orgId, appId, viewerAccountId);
  }

  /** 改名、启停应用、工具启停与默认策略、批量把无注解工具改为 allow（`apps.manage`）。 */
  async update(
    orgId: string,
    appId: string,
    actorAccountId: string,
    patch: UpdateAppInput,
    actorTokenId?: string,
  ): Promise<AppDetail> {
    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      const app = await this.row(t, orgId, appId, true);
      const current = await t
        .selectFrom("app_tools")
        .select(["name", "spec", "status", "default_policy", "missing_since", "pending_spec_hash"])
        .where("app_id", "=", appId)
        .forUpdate()
        .execute();
      const byName = new Map(current.map((c) => [c.name, c]));
      const toolChanges = Object.entries(patch.tools ?? {});
      const problems: { path: string; message: string }[] = [];
      for (const [name, change] of toolChanges) {
        const c = byName.get(name);
        if (!c) {
          problems.push({ path: `tools.${name}`, message: "No such tool in this app" });
          continue;
        }
        if (change.status === "enabled") {
          const path = `tools.${name}.status`;
          // 待复核（新增或定义变了）的工具只能经复核接口启用：这里启用会绕过复核、或把旧定义暴露给模型
          if (c.status === "pending_review" || c.pending_spec_hash !== null) {
            problems.push({
              path,
              message: `Tool is pending review; approve it with POST /apps/${appId}/tools/${name}/review`,
            });
            continue;
          }
          if (c.missing_since !== null) {
            problems.push({ path, message: "The app no longer provides this tool" });
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
          .updateTable("apps")
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.status !== undefined && { status: patch.status }),
            updated_at: sql`now()`,
          })
          .where("id", "=", appId)
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
            .updateTable("app_tools")
            .set({ default_policy: "allow", policy_source: "admin" })
            .where("app_id", "=", appId)
            .where("name", "in", allowed)
            .execute();
        }
      }
      for (const [name, change] of toolChanges) {
        if (change.status === undefined && change.defaultPolicy === undefined) continue;
        await t
          .updateTable("app_tools")
          .set({
            ...(change.status !== undefined && { status: change.status }),
            // 启用即视为已复核（待复核的工具在上面已拒绝，只能走复核接口）
            ...(change.status === "enabled" && { reviewed_at: sql`now()` }),
            ...(change.defaultPolicy !== undefined && {
              default_policy: change.defaultPolicy,
              policy_source: "admin" as const,
            }),
          })
          .where("app_id", "=", appId)
          .where("name", "=", name)
          .execute();
      }
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.updated",
        target: appId,
        detail: {
          ...(patch.name !== undefined && { name: { from: app.name, to: patch.name } }),
          ...(patch.status !== undefined && { status: { from: app.status, to: patch.status } }),
          ...(toolChanges.length > 0 && { tools: Object.fromEntries(toolChanges) }),
          ...(allowed.length > 0 && { allowedUnannotated: allowed }),
        },
      });
      return this.detail(t, orgId, appId, actorAccountId);
    });
  }

  /** 软删除，并删除该应用的全部凭据（`apps.manage`）。 */
  async remove(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      const app = await this.row(t, orgId, appId, true);
      await t
        .updateTable("apps")
        .set({ deleted_at: sql`now()`, updated_at: sql`now()` })
        .where("id", "=", appId)
        .execute();
      await this.credentials.clearApp(orgId, appId, t);
      // 授权绑定应用 id（软删除不触发外键级联）：一并删掉，不留给任何后来的应用
      await t.deleteFrom("tool_grants").where("app_id", "=", appId).execute();
      await t.deleteFrom("conversation_tool_grants").where("app_id", "=", appId).execute();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.deleted",
        target: appId,
        detail: { slug: app.slug },
      });
    });
  }

  /**
   * 重新 listTools 并按漂移检测的规则比对写入（见 drift.ts）：新增 / 定义变化的工具待复核（旧定义保留供对比），
   * 消失的工具停用；应用从未拍过快照时首个快照直接启用。
   * 组织凭据型应用用组织凭据，个人型用发起人自己的凭据（缺 → `credential.missing`）。OAuth 应用收到 401 时
   * 在刷新锁内刷新 token 后重试一次。`trigger: "first_connect"`：OAuth 授权码应用首个成员连接后由连接流程调用
   * （A16），只要求 `apps.use`。审计 `app.tools_refreshed`（变化的工具名，不含定义）。
   */
  async refresh(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
    opts: { trigger?: "first_connect" } = {},
  ): Promise<{ app: AppDetail; issues: ToolIssue[]; changes: DriftChanges }> {
    const app = await this.row(this.db, orgId, appId);
    const auth = app.auth as unknown as AppAuth;
    const { specs, resources } = await this.drift.listTools(
      app.connector,
      app.endpoint,
      () => this.credentials.injection(orgId, appId, auth, actorAccountId),
      { orgId, appId },
      (last) => this.credentials.onUnauthorized(orgId, appId, auth, actorAccountId, last),
    );
    const { rows, issues } = snapshot(app.slug, specs, resources);

    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        opts.trigger === "first_connect" ? "apps.use" : "apps.manage",
      );
      const locked = await this.row(t, orgId, appId, true);
      const changes = await this.drift.apply(t, locked, rows);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.tools_refreshed",
        target: appId,
        detail: { ...changes, ...(opts.trigger && { trigger: opts.trigger }) },
      });
      return { app: await this.detail(t, orgId, appId, actorAccountId), issues, changes };
    });
  }

  /**
   * 复核一个待复核的工具（`apps.manage`，spec 7.3）。`approve`：采用待复核的新定义（若有）并启用，
   * `reviewed_at` 记为现在；默认策略按新定义的注解重新推导，除非管理员设过（`policy_source = admin`）且来源没变。
   * `reject`：停用，丢弃待复核的新定义、保留旧定义。工具不存在 → 404 `app.tool_not_found`；
   * 不在待复核状态 → 409 `app.tool_not_pending`；新定义不合规（如 key 不合法）不能通过 → `validation_failed`。
   * 采用新定义即换了指纹：旧的「以后都允许」/「本会话都允许」授权按指纹比对自然失效（D8）。审计 `app.tool_reviewed`。
   */
  async reviewTool(
    orgId: string,
    appId: string,
    name: string,
    action: "approve" | "reject",
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<AppDetail> {
    return this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      const app = await this.row(t, orgId, appId, true);
      const tool = await t
        .selectFrom("app_tools")
        .select([
          "status",
          "source",
          "spec",
          "policy_source",
          "pending_spec",
          "pending_spec_hash",
          "pending_source",
        ])
        .where("app_id", "=", appId)
        .where("name", "=", name)
        .forUpdate()
        .executeTakeFirst();
      if (!tool) throw new ApiError("app.tool_not_found", "Tool not found in this app");
      if (tool.status !== "pending_review" && tool.pending_spec_hash === null) {
        throw new ApiError("app.tool_not_pending", "Tool is not pending review");
      }
      const next = (tool.pending_spec ?? tool.spec) as ToolSpec;
      const nextSource = tool.pending_source ?? tool.source;
      if (action === "approve") {
        const issue = toolIssue(app.slug, next);
        if (issue) throw fail("action", issue);
      }
      const rederive = tool.policy_source === "derived" || nextSource !== tool.source;
      await t
        .updateTable("app_tools")
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
          reviewed_at: sql<Date>`now()`,
        })
        .where("app_id", "=", appId)
        .where("name", "=", name)
        .execute();
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.tool_reviewed",
        target: appId,
        detail: { tool: name, action },
      });
      return this.detail(t, orgId, appId, actorAccountId);
    });
  }

  /**
   * 写凭据（组织凭据：`apps.manage`；个人凭据：`apps.use`，只写发起人自己的那一条）。
   * 形状与归属不符 → `validation_failed`。审计只记类型与归属。
   */
  async setCredential(
    orgId: string,
    appId: string,
    actorAccountId: string,
    ownership: "org" | "personal",
    value: unknown,
    actorTokenId?: string,
  ): Promise<void> {
    if (ownership === "org") {
      const app = await this.row(this.db, orgId, appId);
      const auth = app.auth as unknown as AppAuth;
      if (isOAuth(auth)) {
        await this.rotateOAuthClient(orgId, appId, actorAccountId, auth, value, actorTokenId);
        return;
      }
    }
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(
        t,
        orgId,
        actorAccountId,
        ownership === "org" ? "apps.manage" : "apps.use",
      );
      const app = await this.row(t, orgId, appId);
      const auth = app.auth as unknown as AppAuth;
      const owner: CredentialOwner =
        ownership === "org" ? { kind: "org" } : { kind: "user", accountId: actorAccountId };
      this.credentials.validate(auth, owner, value);
      await this.credentials.setStatic(orgId, appId, auth, owner, value, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.credential.set",
        target: appId,
        detail: { type: auth.type, ownership },
      });
    });
  }

  /**
   * 轮换 OAuth 客户端（Ruling A18，组织凭据接口，`apps.manage`）：值为 `{ clientId, clientSecret }`。
   * 客户端凭据应用先用新客户端取一次 token 验证（失败 → 502 `app.connect_failed`，什么都不改），再替换客户端并以
   * 新 token 替换缓存的组织 token；授权码应用只限手填 client，只替换客户端（成员的 token 保留，之后刷新若得到
   * invalid_client 会作废）。审计只记类型与归属。
   */
  private async rotateOAuthClient(
    orgId: string,
    appId: string,
    actorAccountId: string,
    auth: OAuthAuth,
    value: unknown,
    actorTokenId?: string,
  ): Promise<void> {
    if (auth.type === "oauth_code" && auth.client !== "manual") {
      throw fail(
        "auth.client",
        "The OAuth client of this app was registered automatically and cannot be replaced",
      );
    }
    const next = parseOAuthClient(value, auth.type === "oauth_client", "");
    const current = await this.credentials.oauthClient(orgId, appId);
    if (!current) {
      throw new ApiError(
        "app.connect_failed",
        "The app has no registered OAuth client; reinstall it",
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
          oauthHttpOptions(this.config()),
        );
      } catch (e) {
        throw connectFailed(e);
      }
    }
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.manage");
      await this.row(t, orgId, appId, true);
      await this.credentials.setOAuthClient(orgId, appId, client, t);
      if (tokens) await this.credentials.setOAuthTokens(orgId, appId, { kind: "org" }, tokens, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.credential.set",
        target: appId,
        detail: { type: auth.type, ownership: "org" },
      });
    });
  }

  /** 删除发起人自己的个人凭据（`apps.use`）；本来就没有也成功。 */
  async clearMyCredential(
    orgId: string,
    appId: string,
    actorAccountId: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (t) => {
      await lockOrgAndAuthorize(t, orgId, actorAccountId, "apps.use");
      const app = await this.row(t, orgId, appId);
      await this.credentials.clear(orgId, appId, { kind: "user", accountId: actorAccountId }, t);
      await audit(t, {
        actorAccountId,
        ...(actorTokenId !== undefined && { actorTokenId }),
        orgId,
        action: "app.credential.cleared",
        target: appId,
        detail: { type: (app.auth as unknown as AppAuth).type, ownership: "personal" },
      });
    });
  }
}
