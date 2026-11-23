import type { ConnectorTemplateFile } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ComponentScopeService } from "../../catalog/component-scope.service.js";
import { connectorTemplateState } from "../../catalog/component-state.js";
import {
  CatalogConnectorInput,
  ConnectorTemplatePathParams,
  OrgTemplateConnectorSchema,
} from "../../catalog/org-catalog.schemas.js";
import { PluginInstaller } from "../../catalog/plugin-install.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import {
  ConnectorCreateSchema,
  ConnectorGuideAckSchema,
  ConnectorPathParams,
  ConnectorPreviewSchema,
  ConnectorUpdateSchema,
  GitPushPolicyBody,
} from "../../tools/connectors.schemas.js";
import {
  type ConnectorDetail,
  type ConnectorPreview,
  type ConnectorSummary,
  ConnectorsService,
} from "../../tools/connectors.service.js";
import type { ConnectorAuth } from "../../tools/credentials.js";
import { publicEndpoint } from "../../tools/endpoint.js";
import {
  clientProblem,
  connectorCredential,
  connectorPersonFields,
  headersWebOnly,
} from "../connector-person-fields.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { type PersonFieldTarget, personFieldParams } from "../person-fields.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { withPersonInputs } from "./person-inputs.js";
import { roleOf } from "./role.js";
import { named, orElse } from "./summary.js";

const PAGE = 50;

/** The result text of `connectors.connect` (platform web parity spec §4.4); model-visible English. */
export const CONNECT_SHOWN_TEXT =
  "The person was shown a Connect button; check connectors.get for the connection state.";

const ConnectorId = ConnectorPathParams.shape.connectorId.max(100);
const EXAMPLE_ID = "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60";

/** The OAuth client id of a connector (the client secret is a person field, ruling R3). */
const ClientParam = z
  .object({ clientId: z.string().min(1).max(500) })
  .strict()
  .describe(
    "The OAuth client registered at the authorization server (oauth_client, or oauth_code with client manual): its id; the person enters the client secret in a secure input request.",
  );

/** `connectors.create`: the create body without the credential, the client id and askPerson. */
const CreateInput = ConnectorCreateSchema.omit({ credential: true })
  .extend({ client: ClientParam.optional(), askPerson: personFieldParams.askPerson })
  .strict();

/** `connectors.update`: the PATCH body without per-tool policies (ruling R4). */
const UpdateInput = z
  .object({ connectorId: ConnectorId })
  .extend(ConnectorUpdateSchema.omit({ tools: true, allowUnannotated: true }).shape)
  .strict();

/** `connectors.add-from-template`: the route's name and its `config` flattened, no secrets. */
const FromTemplateInput = z
  .object({
    templateId: ConnectorTemplatePathParams.shape.templateId.max(100),
    name: OrgTemplateConnectorSchema.shape.name,
    slug: CatalogConnectorInput.shape.slug,
    endpoint: CatalogConnectorInput.shape.endpoint,
    client: ClientParam.optional(),
    askPerson: personFieldParams.askPerson,
  })
  .strict();

/** The card's word for what the person enters: the OAuth client, or whose credential it is. */
const ownershipOf = (auth: ConnectorAuth) => {
  if (auth.type === "oauth_client" || auth.type === "oauth_code") {
    return { zh: "OAuth 客户端", en: "OAuth client" };
  }
  return auth.type !== "none" && auth.ownership === "personal"
    ? { zh: "个人凭据", en: "personal" }
    : { zh: "组织凭据", en: "org" };
};

/** The card target of a connector's credential ("Connector GitHub (org)"). */
const connectorTarget = (name: string, auth: ConnectorAuth): PersonFieldTarget["target"] => {
  const o = ownershipOf(auth);
  return { zh: `连接器「${named(name)}」（${o.zh}）`, en: `Connector ${named(name)} (${o.en})` };
};

/** The person fields named on a card summary: the plan's (`personAsk`), else none. */
const entersText = (ctx: Pick<OperationContext, "personAsk">) => {
  const ask = ctx.personAsk ?? [];
  return ask.length === 0
    ? { zh: "", en: "" }
    : { zh: `；由本人填写 ${ask.join("、")}`, en: `; the person enters ${ask.join(", ")}` };
};

/** The refusal of a credential the card cannot ask for (custom headers; ruling R1's code). */
const webOnly = (message: string | null): PrecheckResult =>
  message === null ? { ok: true } : { ok: false, code: "platform.secret_record_web_only", message };

/** A preview as the tool returns it: compact tool rows, no input schemas. */
const previewOf = (p: ConnectorPreview) => ({
  tools:
    p.tools?.map((t) => ({
      name: t.name,
      key: t.key,
      description: t.description,
      defaultPolicy: t.defaultPolicy,
      issue: t.issue,
    })) ?? null,
  issues: p.issues,
  authHints: p.authHints,
  operations: p.operations?.length ?? 0,
});

/** `connectors.set-git-push-policy`: the route's path param and body. */
const SetGitPushPolicyInput = z
  .object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) })
  .extend(GitPushPolicyBody.shape)
  .strict();

/**
 * A connector without anything secret: the auth method and who holds the credential (the org or
 * each person), never the auth preset's fields or a credential. The endpoint is always the public
 * one (origin only, header names only), as the route shows readers without `connectors.manage`,
 * whatever the actor's role: the result enters a log other people read.
 */
const summary = (c: ConnectorSummary) => ({
  id: c.id,
  slug: c.slug,
  name: c.name,
  connector: c.connector,
  endpoint: publicEndpoint(c.endpoint),
  auth: {
    type: c.auth.type,
    ownership: "ownership" in c.auth ? (c.auth.ownership ?? null) : null,
  },
  status: c.status,
  platformTemplateId: c.platformTemplateId,
  description: c.description,
  updatedAt: c.updatedAt,
});

/** A connector's detail: its tools (name, description, state, default policy) and your credential state. */
const detail = (c: ConnectorDetail) => ({
  ...summary(c),
  // the org's default for git pushes through its credential, when it serves git hosts
  gitPushPolicy: c.git !== null ? c.gitPushPolicy : null,
  credential: c.credential,
  tools: c.tools.map((t) => ({
    name: t.name,
    description: t.description,
    status: t.status,
    defaultPolicy: t.defaultPolicy,
    missing: t.missing,
    pendingReview: t.pending !== null,
  })),
});

/**
 * Connector operations of the `Platform` tool (spec §7; platform web parity spec §7.2): reads,
 * the kinds and a preview, creating a connector (custom or from a platform template), editing it,
 * credentials, the setup guide acknowledgement, deleting and refreshing. Credentials are person
 * fields (ruling R3): the model names them in `askPerson`, the person types them in a secure
 * input request, and the write gets them only through `personInputs`. Per-tool policies stay
 * on the web (ruling R4: the agent's own permissions).
 */
@Injectable()
export class ConnectorsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(ConnectorsService) private readonly connectors: ConnectorsService,
    @Inject(ComponentScopeService) private readonly components: ComponentScopeService,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The actor's org role (the guide routes take it), `forbidden` when not a member. */
  private async org(ctx: OperationContext) {
    const role = await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId);
    if (role === null) throw new ApiError("forbidden", "Insufficient organization role");
    return { orgId: ctx.orgId, role };
  }

  /**
   * The setup guide of a connector made from a template, as `connectors.guide-ack` takes it (the
   * current guide's version and hash, and the drift since it was set up), or null without one.
   */
  private async guideOf(ctx: OperationContext, c: ConnectorDetail) {
    if (c.platformTemplateId === null) return null;
    const org = await this.org(ctx);
    const [states, current] = await Promise.all([
      this.connectors.guideStates(org, [c.id]),
      this.connectors.currentGuide(org, c.id).catch((e: unknown) => {
        if (e instanceof ApiError && e.code === "catalog.guide_not_found") return null;
        throw e;
      }),
    ]);
    if (current === null) return null;
    return {
      guideId: current.guideId,
      version: current.version,
      hash: current.hash,
      drift: states.get(c.id)?.guideDrift ?? null,
    };
  }

  /** A platform connector template on in the org: its card name and auth method. */
  private async template(orgId: string, templateId: string) {
    // a platform template id is a uuid (the route's service checks the same before reading)
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId);
    const state = uuid ? await connectorTemplateState(this.kdb.db, orgId, templateId) : "absent";
    if (state === "absent") {
      throw new ApiError(
        "component.not_found",
        "The connector template does not exist or is not available in this organization",
      );
    }
    const row = await this.kdb.db
      .selectFrom("platform_connector_templates")
      .select("file")
      .where("id", "=", templateId)
      .executeTakeFirstOrThrow();
    const file = row.file as ConnectorTemplateFile;
    return {
      name: file.displayName?.en ?? templateId,
      zh: file.displayName?.zh ?? templateId,
      auth: file.template.auth as unknown as ConnectorAuth,
    };
  }

  private connectorName(ctx: OperationContext, connectorId: string): Promise<string> {
    return orElse(
      async () =>
        named((await this.connectors.get(ctx.orgId, connectorId, ctx.actorAccountId)).name),
      connectorId,
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "connectors.list",
        description:
          "List the org's connectors: name, protocol, endpoint, auth method and status, never credentials. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "connectors.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) =>
          pageOf((await this.connectors.list(ctx.orgId)).map(summary), startOf(input.cursor), PAGE),
      }),
      defineOperation({
        id: "connectors.get",
        description:
          "Read one connector: its tools with their state and default policy, whether your credential for it is connected, and for one made from a template its setup guide (version, hash for connectors.guide-ack, and whether the guide changed since it was set up). Credentials are never returned: the person enters them in the secure input request of connectors.set-org-credential or connectors.set-my-credential.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors/:connectorId"],
        confirm: "read",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        run: async (input, ctx) => {
          const c = await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId);
          return { connector: { ...detail(c), setupGuide: await this.guideOf(ctx, c) } };
        },
      }),
      defineOperation({
        id: "connectors.templates",
        description:
          "List the platform connector templates offered to this org, with whether each is on here: the templates connectors.add-from-template creates connectors from. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/components"],
        // connector templates only, every plugin's
        omits: ["kind", "itemId"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const all = await this.components.orgList(ctx.orgId, { kind: "connector_template" });
          const templates = all.map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            plugin: t.plugin,
            itemId: t.itemId,
            version: t.version,
            on: t.on,
            switchable: t.switchable,
            owner: t.owner,
            // where the template's setup guide is (catalog item and guide id), null without one
            guide: t.guide ?? null,
          }));
          return pageOf(templates, startOf(input.cursor), PAGE);
        },
      }),
      defineOperation({
        id: "connectors.delete",
        description:
          "Delete a connector of the org (org admins): its credentials are deleted too and agents that use it lose its tools.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/connectors/:connectorId"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `删除连接器「${n}」及其全部凭据；使用它的智能体将失去其工具`,
            en: `Delete connector "${n}" and all its credentials; agents that use it lose its tools`,
          };
        },
        run: async (input, ctx) => {
          await this.connectors.remove(
            ctx.orgId,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            viaAgent("connectors.delete", ctx),
          );
          return { id: input.connectorId, deleted: true };
        },
      }),
      defineOperation({
        id: "connectors.refresh",
        description:
          "Fetch the connector's tool list again (org admins) and compare it with the stored one: new or changed tools wait for review on the connector's web page, vanished tools are switched off. Returns the connector and which tools were added, changed or removed. It calls the connector's server with the org's credential, or yours for a personal one.",
        input: z.object({ connectorId: ConnectorPathParams.shape.connectorId.max(100) }).strict(),
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors/:connectorId/refresh"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "credential.missing",
            next: "Your credential for this connector is missing: set it with connectors.set-my-credential (the person enters it on the card; for an OAuth connector call connectors.connect, which shows the person a Connect button), then refresh again.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `刷新连接器「${n}」的工具列表（会访问该连接器的服务）`,
            en: `Refresh the tool list of connector "${n}" (calls the connector's server)`,
          };
        },
        run: async (input, ctx) => {
          const r = await this.connectors.refresh(
            ctx.orgId,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            { auditDetail: viaAgent("connectors.refresh", ctx) },
          );
          return { connector: detail(r.connector), issues: r.issues, changes: r.changes };
        },
        handoff: (input, result) => {
          const c = (result as { changes?: { added?: unknown[]; changed?: unknown[] } } | null)
            ?.changes;
          if ((c?.added?.length ?? 0) + (c?.changed?.length ?? 0) === 0) return null;
          return {
            kind: "handoff",
            title: {
              zh: "审阅连接器新增或变更的工具",
              en: "Review the connector's new or changed tools",
            },
            target: { type: "link", url: `/connectors/${encodeURIComponent(input.connectorId)}` },
          };
        },
      }),
      defineOperation<z.infer<typeof SetGitPushPolicyInput>>({
        id: "connectors.set-git-push-policy",
        description:
          "Set the org's default for git pushes through a connector's credential in sandboxes (org admins): deny refuses every push, ask asks the person for each repository, allow pushes without asking. Through this tool it may only be tightened (allow to ask or deny, ask to deny); loosening needs a person on the connector's settings page. Only a connector that declares git hosts.",
        input: SetGitPushPolicyInput,
        example: { connectorId: "5d2e8f1a-0b3c-4d5e-8f9a-1b2c3d4e5f60", policy: "deny" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/connectors/:connectorId/git-push-policy"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "connector.git_push_widen_not_allowed",
            next: {
              orgAdmin:
                "Loosen the git push policy yourself on the connector's settings page on the web.",
              member:
                "Ask an org admin to loosen the git push policy on the connector's settings page on the web.",
            },
          },
          {
            code: "validation_failed",
            next: "The connector declares no git hosts, so it has no git push policy; connectors.get shows gitPushPolicy null for such a connector.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.connectors.checkGitPushPolicy(ctx.orgId, i.connectorId, i.policy, true),
          ),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          const zh = { allow: "允许", ask: "需审批", deny: "禁止" }[i.policy];
          return {
            zh: `把连接器「${n}」的 git 推送默认策略设为「${zh}」`,
            en: `Set the default git push policy of connector "${n}" to ${i.policy}`,
          };
        },
        run: async (input, ctx) => ({
          connector: detail(
            await this.connectors.setGitPushPolicy(
              ctx.orgId,
              input.connectorId,
              ctx.actorAccountId,
              input.policy,
              {
                auditDetail: viaAgent("connectors.set-git-push-policy", ctx),
                onlyNarrows: true,
              },
            ),
          ),
        }),
      }),
      defineOperation({
        id: "connectors.kinds",
        description:
          "List the connector kinds this org can create connectors of (org admins), each with the plugin providing it: the connector values connectors.create and connectors.preview take. Empty when no connector extension is on in the org.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "connectors.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/connectors/kinds"],
        confirm: "read",
        run: async (_input, ctx) => ({ kinds: await this.connectors.kinds(ctx.orgId) }),
      }),
      defineOperation({
        id: "connectors.preview",
        description:
          "Preview a custom connector before creating it (org admins): reads the endpoint's description (auth hints, operations) and, when it needs no credential (auth none or omitted), lists its tools with their default policy and issues. Writes nothing. No credential is passed here, so tools behind a credential come back as null (unknown until the connector is created). Calls the endpoint's server.",
        input: ConnectorPreviewSchema.omit({ credential: true }).strict(),
        example: { connector: "mcp", endpoint: { url: "https://mcp.example.com/mcp" } },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors/preview"],
        omits: ["credential"],
        withoutSecrets:
          "a read never asks the person: without the credential, tools behind it stay unknown until connectors.create",
        confirm: "read",
        errors: [
          {
            code: "connector.kind_unavailable",
            next: "No enabled extension provides this connector kind here; list the kinds with connectors.kinds.",
          },
          {
            code: "catalog.custom_disabled",
            next: "The platform does not allow custom connectors; create one from a template (connectors.templates, connectors.add-from-template).",
          },
          {
            code: "connector.connect_failed",
            next: "The connector's server could not be reached or refused the credential or OAuth client (the error says which); check the endpoint with connectors.preview, then call again so the person enters the credential anew.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
        ],
        run: async (input, ctx) => previewOf(await this.connectors.preview(ctx.orgId, input)),
      }),
      defineOperation<z.infer<typeof CreateInput>>({
        id: "connectors.create",
        description:
          "Create a custom connector (org admins): name, connector kind (connectors.kinds), endpoint and auth method; it connects, lists the tools and stores them for review. The credential is never a param: the person enters it in a secure input request (bearer and api_key: credential.token; basic: credential.username and credential.password; oauth_client, or oauth_code with client manual: client.clientSecret, with the client id in client). Required credential fields are asked even when not listed in askPerson. Custom header credentials are entered on the web. Preview first with connectors.preview.",
        input: CreateInput,
        example: {
          name: "Docs",
          connector: "mcp",
          endpoint: { url: "https://mcp.example.com/mcp" },
          auth: { type: "bearer", ownership: "org" },
          askPerson: ["credential.token"],
        },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors"],
        omits: ["credential"],
        extras: ["client", "askPerson"],
        confirm: "org",
        errors: [
          {
            code: "connector.slug_taken",
            next: "Another connector of the org has this slug; pass another slug.",
          },
          {
            code: "connector.kind_unavailable",
            next: "No enabled extension provides this connector kind here; list the kinds with connectors.kinds.",
          },
          {
            code: "catalog.custom_disabled",
            next: "The platform does not allow custom connectors; create one from a template (connectors.templates, connectors.add-from-template).",
          },
          {
            code: "connector.connect_failed",
            next: "The connector's server could not be reached or refused the credential or OAuth client (the error says which); check the endpoint with connectors.preview, then call again so the person enters the credential anew.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to enter the credential on the connector's web page (Connectors).",
          },
        ],
        precheck: async (i) => {
          const auth = i.auth as ConnectorAuth;
          const client = clientProblem(auth, i.client, "This connector");
          if (client !== null) return { ok: false, code: "validation_failed", message: client };
          return webOnly(headersWebOnly(auth, "This connector"));
        },
        personFields: async (i) => ({
          target: connectorTarget(i.name, i.auth as ConnectorAuth),
          fields: connectorPersonFields(i.auth as ConnectorAuth, new Set()),
        }),
        summary: (i, ctx) => {
          const e = entersText(ctx);
          return {
            zh: `创建连接器「${named(i.name)}」（${named(i.connector)}，认证 ${i.auth.type}）${e.zh}`,
            en: `Create connector "${named(i.name)}" (${named(i.connector)}, auth ${i.auth.type})${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const { askPerson: _ask, client, ...body } = input;
          const auth = body.auth as ConnectorAuth;
          const r = await withPersonInputs("connectors.create", ctx, (entered, auditDetail) => {
            const credential = connectorCredential(auth, entered, client?.clientId);
            return this.connectors.create(
              ctx.orgId,
              ctx.actorAccountId,
              { ...body, auth, ...(credential !== undefined && { credential }) },
              undefined,
              auditDetail,
            );
          });
          return { connector: detail(r.connector), issues: r.issues };
        },
      }),
      defineOperation<z.infer<typeof UpdateInput>>({
        id: "connectors.update",
        description:
          "Edit a connector (org admins): rename it, set or clear its own description (description; null clears it), switch it off or on (status), or use an org-credential connector that declares git hosts for git in sandboxes (useForGit; pushes are then the bot's). Its endpoint and credential are not edited here (credentials: connectors.set-org-credential); per-tool state and default policies stay on the connector's web page.",
        input: UpdateInput,
        example: { connectorId: EXAMPLE_ID, name: "Docs (staging)" },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/connectors/:connectorId"],
        // per-tool policies decide what agents may call without asking (ruling R4)
        omits: ["tools", "allowUnannotated"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          const zh: string[] = [];
          const en: string[] = [];
          if (i.name !== undefined) {
            zh.push(`改名为「${named(i.name)}」`);
            en.push(`rename it to "${named(i.name)}"`);
          }
          if (i.status !== undefined) {
            zh.push(i.status === "active" ? "启用" : "停用");
            en.push(i.status === "active" ? "switch it on" : "switch it off");
          }
          if (i.description !== undefined) {
            const text = i.description?.trim() ?? "";
            zh.push(text === "" ? "清除说明" : `说明改为「${named(text)}」`);
            en.push(
              text === "" ? "clear its description" : `set its description to "${named(text)}"`,
            );
          }
          if (i.useForGit !== undefined) {
            zh.push(i.useForGit ? "用于沙箱中的 git" : "不再用于沙箱中的 git");
            en.push(i.useForGit ? "use it for git in sandboxes" : "stop using it for git");
          }
          return {
            zh: `修改连接器「${n}」：${zh.join("，") || "不改动"}`,
            en: `Edit connector "${n}": ${en.join(", ") || "no change"}`,
          };
        },
        run: async (input, ctx) => {
          const { connectorId, ...patch } = input;
          return {
            connector: detail(
              await this.connectors.update(
                ctx.orgId,
                connectorId,
                ctx.actorAccountId,
                patch,
                undefined,
                viaAgent("connectors.update", ctx),
              ),
            ),
          };
        },
      }),
      defineOperation({
        id: "connectors.set-org-credential",
        description:
          "Replace the org's credential of an org-credential connector (org admins): the person enters it in a secure input request (bearer and api_key: credential.token; basic: credential.username and credential.password). For an OAuth connector it replaces the OAuth client: pass its id in client, the person enters client.clientSecret. Every field of the credential is asked. Custom header credentials are entered by a person in the connector's settings in the web app.",
        input: z
          .object({
            connectorId: ConnectorId,
            client: ClientParam.optional(),
            askPerson: personFieldParams.askPerson,
          })
          .strict(),
        example: { connectorId: EXAMPLE_ID, askPerson: ["credential.token"] },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/org"],
        extras: ["client", "askPerson"],
        confirm: "org",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "connector.connect_failed",
            next: "The connector's server could not be reached or refused the credential or OAuth client (the error says which); check the endpoint with connectors.preview, then call again so the person enters the credential anew.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to enter the credential on the connector's web page (Connectors).",
          },
        ],
        precheck: async (i, ctx) => {
          const c = await this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId);
          const refuse = (message: string): PrecheckResult => ({
            ok: false,
            code: "validation_failed",
            message,
          });
          const a = c.auth;
          if (a.type === "none") return refuse("This connector uses no credential");
          if (a.type === "oauth_code" && a.client !== "manual") {
            return refuse(
              "The OAuth client of this connector was registered automatically and cannot be replaced",
            );
          }
          const client = clientProblem(a, i.client, `Connector ${named(c.name)}`);
          if (client !== null) return refuse(client);
          if (a.type !== "oauth_code" && a.type !== "oauth_client" && a.ownership === "personal") {
            return refuse(
              "This connector uses each member's own credential, not an org one; each person sets theirs with connectors.set-my-credential",
            );
          }
          return webOnly(headersWebOnly(a, `Connector ${named(c.name)}`));
        },
        personFields: async (i, ctx) => {
          const c = await this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId);
          return {
            target: connectorTarget(c.name, c.auth),
            fields: connectorPersonFields(c.auth, new Set()),
          };
        },
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          const e = entersText(ctx);
          return {
            zh: `替换连接器「${n}」的组织凭据${e.zh}`,
            en: `Replace the org credential of connector "${n}"${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const c = await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId);
          await withPersonInputs("connectors.set-org-credential", ctx, (entered, auditDetail) =>
            this.connectors.setCredential(
              ctx.orgId,
              input.connectorId,
              ctx.actorAccountId,
              "org",
              connectorCredential(c.auth, entered, input.client?.clientId),
              undefined,
              auditDetail,
            ),
          );
          return {
            connector: detail(
              await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId),
            ),
          };
        },
      }),
      defineOperation({
        id: "connectors.set-my-credential",
        description:
          "Set your own credential for a connector that uses each member's own credential: the person enters it in a secure input request (bearer and api_key: credential.token; basic: credential.username and credential.password). An OAuth connector is connected with connectors.connect instead (it shows the person a Connect button). Every field of the credential is asked.",
        input: z
          .object({ connectorId: ConnectorId, askPerson: personFieldParams.askPerson })
          .strict(),
        example: { connectorId: EXAMPLE_ID, askPerson: ["credential.token"] },
        authz: { orgAction: "connectors.use" },
        mirrors: ["PUT /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me"],
        extras: ["askPerson"],
        confirm: "personal",
        rememberable: false,
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to enter the credential on the connector's web page (Connectors).",
          },
        ],
        precheck: async (i, ctx) => {
          const c = await this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId);
          if (c.auth.type === "none" || c.auth.ownership === "org") {
            return {
              ok: false,
              code: "validation_failed",
              message:
                c.auth.type === "none"
                  ? "This connector uses no credential"
                  : "This connector uses one org credential, not each member's own; an org admin sets it with connectors.set-org-credential",
            };
          }
          if (c.auth.type === "oauth_code") {
            return {
              ok: false,
              code: "validation_failed",
              message:
                "This connector connects each person's account through OAuth: call connectors.connect, which shows the person a Connect button",
            };
          }
          return webOnly(headersWebOnly(c.auth, `Connector ${named(c.name)}`));
        },
        personFields: async (i, ctx) => {
          const c = await this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId);
          return {
            target: connectorTarget(c.name, c.auth),
            fields: connectorPersonFields(c.auth, new Set()),
          };
        },
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          const e = entersText(ctx);
          return {
            zh: `设置你在连接器「${n}」上的个人凭据${e.zh}`,
            en: `Set your own credential for connector "${n}"${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const c = await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId);
          await withPersonInputs("connectors.set-my-credential", ctx, (entered, auditDetail) =>
            this.connectors.setCredential(
              ctx.orgId,
              input.connectorId,
              ctx.actorAccountId,
              "personal",
              connectorCredential(c.auth, entered, undefined),
              undefined,
              auditDetail,
            ),
          );
          return {
            connector: detail(
              await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId),
            ),
          };
        },
      }),
      defineOperation({
        id: "connectors.connect",
        description:
          "Connect your own account to an OAuth connector (oauth_code, each member's own account): shows the person a Connect button in the conversation; the authorization runs in their browser, never through the tool. Starts nothing by itself and returns the connector's current connection state; call connectors.get afterwards to see whether the person connected.",
        input: z.object({ connectorId: ConnectorId }).strict(),
        example: { connectorId: EXAMPLE_ID },
        authz: { orgAction: "connectors.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors/:connectorId/connect"],
        // the web card starts the flow from the person's session and returns to the conversation
        omits: ["returnTo"],
        confirm: "read",
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
          {
            code: "validation_failed",
            next: "Only an active OAuth authorization-code connector is connected this way: a token connector takes connectors.set-my-credential, a disabled one needs an org admin to enable it.",
          },
        ],
        // nothing is written: the route's start (state, PKCE, the browser binding cookie) stays
        // in the person's browser, through the web card
        run: async (input, ctx) => {
          const c = await this.connectors.get(ctx.orgId, input.connectorId, ctx.actorAccountId);
          // the checks the route's start makes, so no Connect button is shown for nothing (a read
          // runs without a card, so these are the run's own refusals rather than a precheck)
          if (c.auth.type !== "oauth_code") {
            throw new ApiError("validation_failed", "Request validation failed", [
              {
                path: "auth",
                message: "Only OAuth authorization-code connectors are connected this way",
              },
            ]);
          }
          if (c.status !== "active") {
            throw new ApiError("validation_failed", "Request validation failed", [
              {
                path: "status",
                message: "The connector is disabled; ask an administrator to enable it",
              },
            ]);
          }
          return {
            connector: { ...summary(c), credential: c.credential },
            next: CONNECT_SHOWN_TEXT,
          };
        },
        handoff: (input, result) => {
          const name = (result as { connector?: { name?: unknown } } | null)?.connector?.name;
          const n = typeof name === "string" ? named(name) : input.connectorId;
          return {
            kind: "handoff",
            title: { zh: `连接「${n}」`, en: `Connect ${n}` },
            target: { type: "connect", connectorId: input.connectorId },
          };
        },
      }),
      defineOperation({
        id: "connectors.clear-my-credential",
        description:
          "Delete your own stored credential for a connector that uses each member's own credential (the org's credential is untouched). Agents then cannot use the connector as you until you set it again.",
        input: z.object({ connectorId: ConnectorId }).strict(),
        example: { connectorId: EXAMPLE_ID },
        authz: { orgAction: "connectors.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/connectors/:connectorId/credentials/me"],
        confirm: "personal",
        // destructive: agents lose the connector as this person
        rememberable: false,
        errors: [
          { code: "connector.not_found", next: "Check the connector id with connectors.list." },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.connectors.get(ctx.orgId, i.connectorId, ctx.actorAccountId)),
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `删除你在连接器「${n}」上的个人凭据`,
            en: `Delete your own credential for connector "${n}"`,
          };
        },
        run: async (input, ctx) => {
          await this.connectors.clearMyCredential(
            ctx.orgId,
            input.connectorId,
            ctx.actorAccountId,
            undefined,
            viaAgent("connectors.clear-my-credential", ctx),
          );
          return { id: input.connectorId, credentialCleared: true };
        },
      }),
      defineOperation<z.infer<typeof FromTemplateInput>>({
        id: "connectors.add-from-template",
        description:
          "Create one more connector from a platform connector template that is on in the org (org admins; connectors.templates lists them): an optional name and slug (defaults: the first free ones), the endpoint fields the template lets the org edit, and for an OAuth template the client id in client. The credential is never a param: the person enters it in a secure input request (credential.token; credential.username and credential.password; client.clientSecret). Required credential fields are asked even when not listed in askPerson.",
        input: FromTemplateInput,
        example: {
          templateId: "3f1c2a9e-5b7d-4e21-9c0a-1d2e3f4a5b6c",
          name: "GitHub (ops)",
          askPerson: ["credential.token"],
        },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connector-templates/:templateId/connectors"],
        // the route's config is flattened into slug, endpoint and client; its secrets are person fields
        omits: ["config"],
        extras: ["slug", "endpoint", "client", "askPerson"],
        confirm: "org",
        errors: [
          {
            code: "component.not_found",
            next: "The template is not available in this org; list the templates with connectors.templates.",
          },
          {
            code: "component.off",
            next: "The template (or its plugin) is off in this org; switch it on first (plugins.set-enabled for its plugin, or components.set-enabled for the template).",
          },
          {
            code: "connector.slug_taken",
            next: "Another connector of the org has this slug; pass another slug or leave it out.",
          },
          {
            code: "connector.connect_failed",
            next: "The connector's server could not be reached or refused the credential or OAuth client (the error says which); check the endpoint with connectors.preview, then call again so the person enters the credential anew.",
          },
          {
            code: "validation_failed",
            next: "The error's details name the fields; correct the params (or have the person enter the credential again) and call again.",
          },
          {
            code: "platform.secret_record_web_only",
            next: "Tell the person to enter the credential on the connector's web page (Connectors).",
          },
        ],
        precheck: async (i, ctx) => {
          const t = await this.template(ctx.orgId, i.templateId);
          const where = `Connector template ${named(t.name)}`;
          const client = clientProblem(t.auth, i.client, where);
          if (client !== null) return { ok: false, code: "validation_failed", message: client };
          return webOnly(headersWebOnly(t.auth, where));
        },
        personFields: async (i, ctx) => {
          const t = await this.template(ctx.orgId, i.templateId);
          return {
            // the template's own name: the model's name for the new connector is in the summary
            target: connectorTarget(t.name, t.auth),
            fields: connectorPersonFields(t.auth, new Set()),
          };
        },
        summary: async (i, ctx) => {
          const t = await this.template(ctx.orgId, i.templateId);
          const e = entersText(ctx);
          const name = i.name === undefined ? "" : `「${named(i.name)}」`;
          return {
            zh: `从连接器模板「${named(t.zh)}」新建连接器${name}${e.zh}`,
            en: `Create a connector${i.name === undefined ? "" : ` "${named(i.name)}"`} from the connector template "${named(t.name)}"${e.en}`,
          };
        },
        run: async (input, ctx) => {
          const t = await this.template(ctx.orgId, input.templateId);
          const r = await withPersonInputs(
            "connectors.add-from-template",
            ctx,
            (entered, auditDetail) => {
              const value = connectorCredential(t.auth, entered, input.client?.clientId);
              const oauth = t.auth.type === "oauth_client" || t.auth.type === "oauth_code";
              return this.installer.addTemplateConnector(
                ctx.orgId,
                ctx.actorAccountId,
                input.templateId,
                {
                  ...(input.name !== undefined && { name: input.name }),
                  config: {
                    ...(input.slug !== undefined && { slug: input.slug }),
                    ...(input.endpoint !== undefined && { endpoint: input.endpoint }),
                    ...(value !== undefined &&
                      (oauth
                        ? { client: value as { clientId: string; clientSecret?: string } }
                        : { credential: value })),
                  },
                },
                { auditDetail },
              );
            },
          );
          return { connector: detail(r.connector), issues: r.issues };
        },
      }),
      defineOperation({
        id: "connectors.guide-ack",
        description:
          "Record that the person updated the app on the third-party platform after a connector template's setup guide changed (org admins): pass the guide hash connectors.get shows under setupGuide. The card states exactly that, and the person confirms it; a guide that changed again since is refused.",
        input: z.object({ connectorId: ConnectorId, ...ConnectorGuideAckSchema.shape }).strict(),
        example: {
          connectorId: EXAMPLE_ID,
          hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        authz: { orgAction: "connectors.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack"],
        confirm: "personal",
        // a person's attestation: confirmed each time, never remembered
        rememberable: false,
        errors: [
          {
            code: "connector.not_found",
            next: "Check the connector id with connectors.list.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The connector has no setup guide from a template; there is nothing to acknowledge.",
          },
          {
            code: "connector.guide_changed",
            next: "The setup guide changed again: read it with setup.read, walk the person through it, then call again with the hash connectors.get shows now.",
          },
        ],
        precheck: async (i, ctx) => {
          let hash = "";
          const r = await precheckBy(async () => {
            hash = (await this.connectors.currentGuide(await this.org(ctx), i.connectorId)).hash;
          });
          if (!r.ok) return r;
          return hash === i.hash
            ? { ok: true }
            : {
                ok: false,
                code: "connector.guide_changed",
                message: "The connector template's setup guide changed since it was shown",
              };
        },
        summary: async (i, ctx) => {
          const n = await this.connectorName(ctx, i.connectorId);
          return {
            zh: `我已按连接器「${n}」更新后的设置指南，在第三方平台上更新了应用`,
            en: `I updated the app on the third-party platform after the setup guide of connector "${n}" changed`,
          };
        },
        run: async (input, ctx) => ({
          connector: detail(
            await this.connectors.ackGuide(
              await this.org(ctx),
              input.connectorId,
              input.hash,
              ctx.actorAccountId,
              undefined,
              viaAgent("connectors.guide-ack", ctx),
            ),
          ),
        }),
      }),
    ]);
  }
}
