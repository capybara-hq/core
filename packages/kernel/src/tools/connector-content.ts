import type {
  AuthInjection,
  ConnectorSession,
  Logger,
  PromptInfo,
  ToolResult,
} from "@capybara-hq/plugin-sdk";
import { ToolError } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { Breaker } from "./breaker.js";
import { type ConnectorAuth, CredentialMissing, Credentials } from "./credentials.js";
import { renderResult } from "./outputs.js";
import { redactDeep, redactorFor } from "./redact.js";
import { ToolRegistry } from "./registry.js";
import { READ_RESOURCE } from "./resources.js";

/**
 * 用户直接使用连接器内容（D4，仿 Claude Code）：`/` 斜杠命令（MCP prompts）与 `@` 资源引用。
 *
 * 与工具调用不同，这些操作由用户本人发起、不经模型：用发起人的凭据（组织凭据 / 本人的个人凭据）打开连接器会话，
 * 结果按本次注入的凭据打码（同 Review Focus 3）。不经工具策略与审批（用户自己在用），只要求 `connectors.use`、
 * 连接器为 active；熔断打开的连接器直接跳过 / 报错，不计入熔断（列表请求是界面行为，不应让工具调用熔断）。
 * 会话按次打开、用完关闭，不缓存（多副本）。
 */

/** 列表请求里每个连接器的超时上限（毫秒；取它与 `tools.timeoutMs` 的较小值）。 */
const LIST_TIMEOUT_MS = 10_000;
/** One connector's listing shows at most this many resources. */
const MAX_CONNECTOR_RESOURCES = 200;
const UI_TEMPLATE_MIME = "text/html;profile=mcp-app";
/** The cap on a rendered prompt's text (the same as a message's text). */
const MAX_PROMPT_CHARS = 100_000;
/** 每个附件的正文上限（字符）。 */
export const MAX_ATTACHMENT_CHARS = 50_000;
/** 一条消息最多附件数。 */
export const MAX_ATTACHMENTS = 5;
/** 解析一条消息全部附件的总时限上限（毫秒；取它与 `tools.timeoutMs` 的较小值，附件并行读取）。 */
const ATTACHMENTS_TIMEOUT_MS = 30_000;
/** 错误说明里带的上游错误消息最多字符数。 */
const MAX_DETAIL = 500;

export interface ConnectorPromptView {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  name: string;
  title?: string;
  description?: string;
  arguments: PromptInfo["arguments"];
}

export interface ConnectorResourceView {
  connectorId: string;
  connectorSlug: string;
  connectorName: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

/** 列表时某个连接器不可用：发起人没有连接个人凭据，或连接 / 列出失败（含熔断打开）。 */
export interface ConnectorUnavailable {
  connectorId: string;
  connectorName: string;
  reason: "not_connected" | "failed";
}

/**
 * 附件元数据（存在 user_message 里，界面据此显示附件而不是正文）。字段名是事件 payload 的一部分，
 * 改名后仍为 `appId` / `appName`（C27：日志确定性）。
 */
export interface AttachmentMeta {
  appId: string;
  appName: string;
  uri: string;
  name: string;
}

interface ConnectorRow {
  id: string;
  slug: string;
  name: string;
  connector: string;
  endpoint: unknown;
  auth: unknown;
}

/** An MCP app UI template (not content a person can attach): `ui:` URI or the mcp-app HTML profile. */
export function isUiTemplate(r: { uri: string; mimeType?: string }): boolean {
  if (r.mimeType !== undefined && r.mimeType.replace(/\s+/g, "").toLowerCase() === UI_TEMPLATE_MIME)
    return true;
  return /^ui:/i.test(r.uri);
}

/** Whether a resource is offered to a person: not a UI template, not empty. */
export function listableResource(r: {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}): boolean {
  return !isUiTemplate(r) && r.size !== 0;
}

/** One resource a message references, as read for it (the body redacted and capped). */
export interface ReadResource {
  connectorId: string;
  connectorName: string;
  uri: string;
  /** The listed name, or the URI. */
  name: string;
  body: string;
}

/**
 * The model-visible block of a read resource: its placeholder first when it was a token
 * (`[resource: <label> from <connector label>] `), then the English head and the body.
 */
export const resourceBlockText = (r: ReadResource, placeholder?: string): string =>
  `${placeholder === undefined ? "" : `${placeholder} `}Attached resource ${JSON.stringify(r.name)} (${r.uri}) from the connector ${r.connectorName}:\n\n${r.body}`;

/** The `payload.attachments` entry of a read resource (field names kept, C27). */
export const attachmentMeta = (r: ReadResource): AttachmentMeta => ({
  appId: r.connectorId,
  appName: r.connectorName,
  uri: r.uri,
  name: r.name,
});

const errName = (e: unknown): string =>
  e instanceof Error && typeof e.name === "string" && e.name !== "" ? e.name : "Error";

@Injectable()
export class ConnectorContent {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, "findConnector">,
    @Inject(Credentials)
    private readonly credentials: Pick<Credentials, "injection" | "onUnauthorized">,
    @Inject(Breaker) private readonly breaker: Pick<Breaker, "check">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
  ) {}

  private async activeConnectors(orgId: string): Promise<ConnectorRow[]> {
    return this.db
      .selectFrom("connectors")
      .select(["id", "slug", "name", "connector", "endpoint", "auth"])
      .where("org_id", "=", orgId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute();
  }

  private async connectorRow(orgId: string, connectorId: string): Promise<ConnectorRow> {
    const r = await this.db
      .selectFrom("connectors")
      .select(["id", "slug", "name", "connector", "endpoint", "auth"])
      .where("org_id", "=", orgId)
      .where("id", "=", connectorId)
      .where("status", "=", "active")
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!r) throw new ApiError("connector.not_found", "Connector not found");
    return r;
  }

  /**
   * 读取资源受管理员对该连接器 `read_resource` 工具（`source = 'resources'`）的启停约束（Ruling A23）：
   * 返回其中该工具为 enabled 的连接器 id。
   */
  private async resourcesEnabled(connectorIds: string[]): Promise<Set<string>> {
    if (connectorIds.length === 0) return new Set();
    const rows = await this.db
      .selectFrom("connector_tools")
      .select("connector_id")
      .where("connector_id", "in", connectorIds)
      .where("source", "=", "resources")
      .where("name", "=", READ_RESOURCE)
      .where("status", "=", "enabled")
      .execute();
    return new Set(rows.map((r) => r.connector_id));
  }

  /**
   * 以 `accountId` 的凭据打开连接器会话执行 `work`，结果按本次注入的凭据打码，会话无论成败都关闭。
   * 缺凭据 → `credential.missing`；熔断打开、连接 / 远端失败 → 502 `connector.connect_failed`（消息打码、限长）。
   * `work` 返回 undefined 表示该连接器不支持这项能力。
   */
  private async withSession<T>(
    orgId: string,
    app: ConnectorRow,
    accountId: string,
    timeoutMs: number,
    work: (s: ConnectorSession) => Promise<T>,
  ): Promise<T> {
    const connector = this.registry.findConnector(app.connector);
    if (!connector) {
      throw new ApiError(
        "connector.connect_failed",
        `The connector ${app.connector} is not installed`,
      );
    }
    const breaker = await this.breaker.check(orgId, app.id);
    if (breaker.open) {
      throw new ApiError(
        "connector.connect_failed",
        `The connector is temporarily unavailable; retry in ${breaker.retryAfterSeconds}s`,
      );
    }
    const auth = app.auth as ConnectorAuth;
    const injected: AuthInjection[] = [];
    let cached: Promise<AuthInjection> | undefined;
    const getAuth = () => {
      cached ??= this.credentials.injection(orgId, app.id, auth, accountId).then((inj) => {
        injected.push(inj);
        return inj;
      });
      return cached;
    };
    const redact = () => redactorFor(injected);
    let session: ConnectorSession | undefined;
    try {
      await getAuth(); // 缺凭据（CredentialMissing）在打开会话之前就确定
      session = await connector.open({
        endpoint: app.endpoint,
        auth: getAuth,
        onUnauthorized: async () => {
          const stale = injected.at(-1);
          cached = undefined;
          await this.credentials.onUnauthorized(orgId, app.id, auth, accountId, stale);
        },
        signal: AbortSignal.timeout(timeoutMs),
        orgId,
      });
      return redactDeep(await work(session), redact()) as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      this.log.warn("connector content request failed", { orgId, connectorId: app.id, err: e });
      const detail =
        e instanceof ToolError
          ? `: ${redact()(e.message).slice(0, MAX_DETAIL)}`
          : ` (${errName(e)})`;
      throw new ApiError("connector.connect_failed", `The connector request failed${detail}`);
    } finally {
      await session?.close().catch((err: unknown) => {
        this.log.warn("connector session close failed", { orgId, connectorId: app.id, err });
      });
    }
  }

  /** 对每个 active 连接器并行执行 `work`；缺凭据 / 失败的连接器进 `unavailable`，不支持的（undefined）跳过。 */
  private async acrossConnectors<T>(
    orgId: string,
    accountId: string,
    work: (s: ConnectorSession, app: ConnectorRow) => Promise<T[] | undefined>,
  ): Promise<{ items: T[]; unavailable: ConnectorUnavailable[] }> {
    const apps = await this.activeConnectors(orgId);
    const timeoutMs = Math.min(this.config.get().tools.timeoutMs, LIST_TIMEOUT_MS);
    const results = await Promise.all(
      apps.map(async (app) => {
        try {
          return {
            app,
            items: await this.withSession(orgId, app, accountId, timeoutMs, (s) => work(s, app)),
          };
        } catch (e) {
          const reason: ConnectorUnavailable["reason"] =
            e instanceof CredentialMissing ? "not_connected" : "failed";
          return { app, unavailable: { connectorId: app.id, connectorName: app.name, reason } };
        }
      }),
    );
    const items: T[] = [];
    const unavailable: ConnectorUnavailable[] = [];
    for (const r of results) {
      if ("unavailable" in r) unavailable.push(r.unavailable);
      else if (r.items) items.push(...r.items);
    }
    return { items, unavailable };
  }

  /** 发起人可用的全部提示模板（按连接器创建顺序，连接器内按远端顺序）。 */
  async listPrompts(
    orgId: string,
    accountId: string,
  ): Promise<{ prompts: ConnectorPromptView[]; unavailable: ConnectorUnavailable[] }> {
    const { items, unavailable } = await this.acrossConnectors(orgId, accountId, async (s, app) => {
      if (!s.listPrompts) return undefined;
      return (await s.listPrompts()).map(
        (p): ConnectorPromptView => ({
          connectorId: app.id,
          connectorSlug: app.slug,
          connectorName: app.name,
          name: p.name,
          ...(p.title !== undefined && { title: p.title }),
          ...(p.description !== undefined && { description: p.description }),
          arguments: p.arguments,
        }),
      );
    });
    return { prompts: items, unavailable };
  }

  /**
   * 渲染一个提示模板为文本（供用户放进输入框再发送）：各消息的文本按顺序以空行连接，assistant 消息加
   * `Assistant:` 前缀；非文本内容给类型说明。连接器不支持 prompts → 404 `connector.not_found`。
   */
  async getPrompt(
    orgId: string,
    connectorId: string,
    name: string,
    args: Record<string, string>,
    accountId: string,
  ): Promise<{ text: string }> {
    const app = await this.connectorRow(orgId, connectorId);
    const rendered = await this.withSession(
      orgId,
      app,
      accountId,
      this.config.get().tools.timeoutMs,
      async (s) => (s.getPrompt ? s.getPrompt(name, args) : undefined),
    );
    if (!rendered)
      throw new ApiError("connector.not_found", "This connector does not provide prompts");
    let text = rendered.messages
      .map((m) => {
        const t = renderResult({ content: m.content }).text;
        return m.role === "assistant" ? `Assistant: ${t}` : t;
      })
      .join("\n\n");
    if (text.length > MAX_PROMPT_CHARS) text = text.slice(0, MAX_PROMPT_CHARS);
    return { text };
  }

  /**
   * One connector's resources the sender can use (the `@` menu's second level, composer inline
   * tokens spec §5): one session on that connector with the sender's credential, UI templates and
   * empty resources hidden, at most {@link MAX_CONNECTOR_RESOURCES}; `query` filters by name, URI
   * or description substring (case insensitive). A connector that is not live and active →
   * `connector.not_found`; one whose `read_resource` is off → `connector.resources_disabled`; a
   * missing credential or a failed connection is thrown (`credential.missing`,
   * `connector.connect_failed`).
   */
  async listResources(
    orgId: string,
    accountId: string,
    opts: { connectorId: string; query?: string },
  ): Promise<{ resources: ConnectorResourceView[] }> {
    const q = opts.query?.trim().toLowerCase() ?? "";
    const view = (
      app: ConnectorRow,
      r: Awaited<ReturnType<NonNullable<ConnectorSession["listResources"]>>>[number],
    ): ConnectorResourceView => ({
      connectorId: app.id,
      connectorSlug: app.slug,
      connectorName: app.name,
      uri: r.uri,
      name: r.name,
      ...(r.description !== undefined && { description: r.description }),
      ...(r.mimeType !== undefined && { mimeType: r.mimeType }),
      ...(r.size !== undefined && { size: r.size }),
    });
    const matches = (r: { name: string; uri: string; description?: string }) =>
      q === "" || [r.name, r.uri, r.description ?? ""].some((v) => v.toLowerCase().includes(q));
    const app = await this.connectorRow(orgId, opts.connectorId);
    if (!(await this.resourcesEnabled([app.id])).has(app.id)) {
      throw new ApiError(
        "connector.resources_disabled",
        "Reading resources is disabled for this connector",
      );
    }
    // A failing connector throws credential.missing / connector.connect_failed: the caller asked
    // about this one connector only.
    const items = await this.withSession(
      orgId,
      app,
      accountId,
      Math.min(this.config.get().tools.timeoutMs, LIST_TIMEOUT_MS),
      async (s) => (s.listResources ? s.listResources() : []),
    );
    return {
      resources: items
        .filter((r) => listableResource(r) && matches(r))
        .slice(0, MAX_CONNECTOR_RESOURCES)
        .map((r) => view(app, r)),
    };
  }

  /**
   * Reads the resources a message references with the sender's credentials, **in parallel**
   * (redacted, each capped at {@link MAX_ATTACHMENT_CHARS} characters; total time limit
   * min(`tools.timeoutMs`, 30s)), in request order. The name is the one in the resource listing
   * (the URI when the listing does not have it). Refusals, any of which fails the whole message
   * (nothing is written):
   * - the connector is not live and active, or provides no resources → `connector.not_found`;
   * - its `read_resource` tool is switched off by an admin (Ruling A23), or `readOffered` is given
   *   and does not hold the connector (the conversation's agent is not offered that tool) →
   *   409 `connector.resources_disabled`;
   * - an MCP Apps UI template, or a body that is empty after trimming → 422
   *   `connector.resource_unreadable` (`details: [{ connectorId, uri, reason }]`).
   */
  async readResources(
    orgId: string,
    accountId: string,
    refs: readonly { connectorId: string; uri: string }[],
    readOffered?: ReadonlySet<string>,
  ): Promise<ReadResource[]> {
    const apps = new Map<string, ConnectorRow>();
    for (const id of new Set(refs.map((r) => r.connectorId))) {
      // the refusal names the connector, so the sender's composer can mark its tokens
      const app = await this.connectorRow(orgId, id).catch((e: unknown) => {
        throw e instanceof ApiError && e.code === "connector.not_found"
          ? new ApiError("connector.not_found", e.message, [{ connectorId: id }])
          : e;
      });
      apps.set(id, app);
    }
    const enabled = await this.resourcesEnabled([...apps.keys()]);
    for (const id of apps.keys()) {
      if (!enabled.has(id) || (readOffered !== undefined && !readOffered.has(id))) {
        throw new ApiError(
          "connector.resources_disabled",
          readOffered !== undefined && enabled.has(id)
            ? "This agent cannot read resources of this connector"
            : "Reading resources is turned off for this connector",
          [{ connectorId: id }],
        );
      }
    }
    const timeoutMs = Math.min(this.config.get().tools.timeoutMs, ATTACHMENTS_TIMEOUT_MS);
    const unreadable = (
      ref: { connectorId: string; uri: string },
      reason: "ui_template" | "empty",
    ) =>
      new ApiError(
        "connector.resource_unreadable",
        reason === "ui_template"
          ? `${ref.uri} is a UI template with nothing to read; remove it`
          : `${ref.uri} is empty; remove it`,
        [{ connectorId: ref.connectorId, uri: ref.uri, reason }],
      );
    return Promise.all(
      refs.map(async (ref) => {
        const app = apps.get(ref.connectorId) as ConnectorRow;
        const got = await this.withSession(orgId, app, accountId, timeoutMs, async (s) => {
          if (!s.readResource) return undefined;
          const listed = s.listResources
            ? (await s.listResources().catch(() => [])).find((r) => r.uri === ref.uri)
            : undefined;
          if (isUiTemplate(listed ?? { uri: ref.uri })) return "ui_template" as const;
          const result: ToolResult = await s.readResource(ref.uri);
          const text = renderResult(result).text;
          // no content at all renders as a placeholder line, which is no content either
          const empty = (result.content?.length ?? 0) === 0 || text.trim() === "";
          return { name: listed?.name ?? ref.uri, text, empty };
        });
        if (!got)
          throw new ApiError("connector.not_found", "This connector does not provide resources", [
            { connectorId: ref.connectorId, uri: ref.uri },
          ]);
        if (got === "ui_template") throw unreadable(ref, "ui_template");
        if (got.empty) throw unreadable(ref, "empty");
        let body = got.text;
        if (body.length > MAX_ATTACHMENT_CHARS) {
          body = `${body.slice(0, MAX_ATTACHMENT_CHARS)}\n[Attachment truncated: showing the first ${MAX_ATTACHMENT_CHARS} of ${got.text.length} characters.]`;
        }
        return {
          connectorId: app.id,
          connectorName: app.name,
          uri: ref.uri,
          name: got.name,
          body,
        };
      }),
    );
  }
}
