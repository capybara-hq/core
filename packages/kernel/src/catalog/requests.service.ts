import { randomUUID } from "node:crypto";
import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { AgentDefinition } from "../agents/definition.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { readOrgMarketplaceBrowse } from "../identity/settings.js";
import { SuperAdminLock } from "../identity/super-admin.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { WithLock } from "../infra/lock/with-lock.decorator.js";
import { orgAllows } from "../local-devices/network-grants.js";
import { OrgLock } from "../orgs/org-lock.js";
import { roleAtLeast } from "../orgs/roles.js";
import {
  effectiveSandboxEgress,
  ORG_SANDBOX_ALLOW_HOSTS_MAX,
  OrgSettingsService,
  readOrgSettings,
} from "../orgs/settings.service.js";
import { CatalogService, type MarketplaceImportResult } from "./catalog.service.js";
import { CatalogScopeService } from "./catalog-scope.service.js";
import { assertEntryNotDeprecated, loadMarketplaceEntry } from "./marketplaces.service.js";
import { OrgCatalogService } from "./org-catalog.service.js";
import { PluginImport } from "./plugin-import.js";
import type { RequestActorOpts } from "./request-rules.js";
import { itemsSeenBy } from "./scope-state.js";

export type CatalogRequestKind =
  | "access"
  | "import"
  | "enable"
  | "connector_setup"
  | "network_allowlist";
export type CatalogRequestStatus = "pending" | "approved" | "rejected" | "cancelled";

/**
 * What a `network_allowlist` request asks for (network ask-to-allow spec §5.3): the hosts (sorted,
 * lowercased, exact) and the conversation and agent of the blocked command, when the member gave
 * them. Stored in `catalog_requests.detail`; the member's note is the request's `note`.
 */
export interface NetworkRequestDetail {
  hosts: string[];
  conversationId: string | null;
  agentId: string | null;
}

/** A member's network request input (`POST /orgs/:orgId/catalog-requests/network`). */
export interface NetworkRequestInput {
  hosts: string[];
  note?: string | undefined;
  conversationId?: string | undefined;
  agentId?: string | undefined;
}

/** A pending connector a `connector_setup` request waits for (ruling P4-T6-5). */
export interface SetupRequestConnector {
  /** The agent's `pendingConnectors[].key` (the bind route's `:key`). */
  key: string;
  label: string;
  /** `template`: made from a platform connector template; `needs`: a hand-configured one. */
  kind: "template" | "needs";
  /**
   * What configures it, so an org admin acts from the request without opening the agent (fix
   * round 1): `template.id` is the platform connector template's id (pick an org connector made
   * from it, or `POST connector-templates/:id/connectors`), `displayName` its display name (null
   * once the template row is gone); `needs` the protocol (the connector kind to pick), the endpoint
   * and the tools of the hand-configured connector the template recorded.
   */
  source:
    | { template: { id: string; displayName: LocalizedName | null } }
    | { needs: { protocol: "mcp" | "openapi"; endpoint: string; tools: string[] } };
  /** The tool names the agent takes once bound; null = all of the connector's tools. */
  tools: string[] | null;
  /** The tool names the entry tightens a policy for (names only, sorted). */
  policies: string[];
}

/**
 * A catalog request (spec §5.1): the inbox's `catalog_request` (pending `enable` and
 * `connector_setup` requests, for the org admins) and `catalog_request_decided` (the requester's
 * decided requests), and the super admin's list (`access` and `import`). `item` is null for an
 * `import` request until its confirm writes the item, and always for `connector_setup`; `entry` is
 * the marketplace entry of an `import` request. A `connector_setup` request (ruling P4-7) names its
 * agent (`agent`) and what it still waits for (`connectors`); both are null for other kinds.
 */
export interface CatalogRequestView {
  id: string;
  orgId: string;
  orgName: string;
  kind: CatalogRequestKind;
  item: { id: string; name: string; displayName: LocalizedName | null } | null;
  entry: { marketplaceId: string | null; name: string; version: string | null } | null;
  /**
   * The agent of a `connector_setup` request: its current name, `deleted` once soft-deleted (the
   * request is then cancelled). Null for other kinds.
   */
  agent: { id: string; name: string; deleted: boolean } | null;
  /**
   * The pending connectors a `connector_setup` request waits for, with their labels from the
   * agent's current version (keys it no longer has are left out; empty once closed). Null for
   * other kinds.
   */
  connectors: SetupRequestConnector[] | null;
  /** The hosts, conversation and agent of a `network_allowlist` request; null for other kinds. */
  network: NetworkRequestDetail | null;
  status: CatalogRequestStatus;
  note: string;
  /** The optional reason of a rejection. */
  reason: string | null;
  requestedBy: string | null;
  /** 申请人的显示名（账号已删除为 null）。 */
  requestedByName: string | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The prepared import of an approved `import` request that is not confirmed yet. */
  stagingId: string | null;
  createdAt: string;
}

/** A decision: approve, or reject with an optional reason the requester sees. */
export interface CatalogDecision {
  approve: boolean;
  reason?: string | undefined;
}

/** 申请列表一次最多返回的条数。 */
export const CATALOG_REQUESTS_LIST_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestNotFound = () =>
  new ApiError("catalog.request_not_found", "Catalog request not found");
const itemNotFound = () => new ApiError("catalog.item_not_found", "Catalog item not found");
const itemDisabled = () =>
  new ApiError(
    "catalog.item_disabled",
    "This catalog item is disabled by the super admin and cannot be requested",
  );
const alreadyDecided = () =>
  new ApiError("catalog.request_decided", "This request has already been decided");
const pendingExists = () =>
  new ApiError(
    "catalog.request_pending",
    "This organization already has a pending request of this kind for it",
  );

const deploymentEgressNone = () =>
  new ApiError(
    "catalog.request_invalid",
    "The platform turned sandbox network off; only a super admin can turn it on",
  );

/** A unique violation (the partial index of pending requests). */
const isUniqueViolation = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/** The deployment-level kinds (decided by the super admin). */
const DEPLOYMENT_KINDS = ["access", "import"] as const;

/** The org-level kinds (decided by the org admins). */
const ORG_KINDS = ["enable", "connector_setup", "network_allowlist"] as const;

/**
 * Catalog requests under plugin scope (spec §5.1). Three kinds, one pending request per (org,
 * kind, item or entry) (partial unique indexes; org-side writes run inside the org row lock):
 * - `enable`: a member asks the org admins to switch on an item that is off in the org (an
 *   `optional` item); an org admin approving it switches the item on, as that admin;
 * - `access`: an org admin asks the super admin for a `named` item shown to orgs outside its
 *   list; approving adds the org to the list (`CatalogScopeService.addOrg`), the scope sync then
 *   installs it;
 * - `import`: an org admin asks for a marketplace entry not in the catalog (deployment setting
 *   `orgMarketplaceBrowse`); approving prepares the import and returns its staging, the request
 *   resolves when the super admin confirms it (scope default `named` = the requesting org);
 * - `connector_setup` (ruling P4-7): one per agent (`agent_id`, `pending_keys`), asking the org
 *   admins to set up an agent's pending connectors; written by the agents module
 *   (`PendingConnectorRequests`), closed by binding (`approved`) or the agent's deletion
 *   (`cancelled`); here it is listed and rejected;
 * - `network_allowlist` (network ask-to-allow spec §5.3): a member asks the org admins to add hosts
 *   to the org's sandbox egress allowlist; approving merges them into the org's `sandboxEgress`.
 * A rejection stores an optional reason. Decided requests show in the requester's inbox until
 * dismissed. No in-process state.
 */
@Injectable()
export class CatalogRequestsService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    /** The org row and super admin locks: both join the caller's transaction. */
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(SuperAdminLock) private readonly adminLock: SuperAdminLock,
    @Inject(OrgCatalogService) private readonly orgCatalog: OrgCatalogService,
    @Inject(CatalogScopeService) private readonly scope: CatalogScopeService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(PluginImport) private readonly pluginImport: PluginImport,
    /** Approving a network request writes the org's `sandboxEgress` through the settings path. */
    @Inject(OrgSettingsService) private readonly orgSettings: OrgSettingsService,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** Serializes the approvals of one `import` request (`@WithLock`). */
    @Inject(LockService) readonly lockService: LockService,
  ) {}

  /** The kernel-schema handle of the current context (the transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * A request for a catalog item (`POST /orgs/:orgId/catalog/:itemId/requests`): `enable`
   * (`catalog.request`, members and up) or `access` (`catalog.decide`, org admins), checked first.
   * The item as the org sees it: absent (missing, deleted, hidden, disabled for a member) ->
   * `catalog.item_not_found`; disabled -> `catalog.item_disabled` for an org admin; its extension
   * unable to run on the platform -> `catalog.request_invalid`; `access` needs
   * `not_offered`, `enable` needs `off` (else `catalog.request_invalid`); a pending request of the
   * kind -> `catalog.request_pending`. Audits `catalog.requested`.
   */
  async requestItem(
    orgId: string,
    actor: string,
    itemId: string,
    input: { kind: "access" | "enable"; note?: string | undefined },
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    const action = input.kind === "access" ? "catalog.decide" : "catalog.request";
    await this.authorize(orgId, actor, action);
    if (!UUID_RE.test(itemId)) throw itemNotFound();
    const [item] = await this.orgCatalog.list(orgId, actor, itemId);
    if (!item) throw itemNotFound();
    if (item.state === "unavailable" && item.reason === "plugin_disabled") throw itemDisabled();
    if (item.state === "unavailable") {
      throw new ApiError(
        "catalog.request_invalid",
        `This plugin's extension cannot run on the platform now (${item.reason ?? "unavailable"}); only the super admin can fix that`,
      );
    }
    const want = input.kind === "access" ? "not_offered" : "off";
    if (item.state !== want) {
      throw new ApiError(
        "catalog.request_invalid",
        input.kind === "access"
          ? "This plugin is already offered to this organization"
          : "This plugin is not off in this organization (or not one an org admin switches on)",
      );
    }
    const id = await this.writeItemRequest(orgId, actor, item.name, itemId, input, opts);
    return this.view(id);
  }

  /** The role check alone, before any item error (a member cannot probe items by error codes). */
  @Transactional()
  private async authorize(
    orgId: string,
    actor: string,
    action: "catalog.request" | "catalog.decide",
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, actor, action);
  }

  @Transactional()
  private async writeItemRequest(
    orgId: string,
    actor: string,
    name: string,
    itemId: string,
    input: { kind: "access" | "enable"; note?: string | undefined },
    opts: RequestActorOpts,
  ): Promise<string> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(
      orgId,
      actor,
      input.kind === "access" ? "catalog.decide" : "catalog.request",
    );
    const existing = await t
      .selectFrom("catalog_requests")
      .select("id")
      .where("org_id", "=", orgId)
      .where("item_id", "=", itemId)
      .where("kind", "=", input.kind)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (existing) throw pendingExists();
    const id = randomUUID();
    try {
      await t
        .insertInto("catalog_requests")
        .values({
          id,
          org_id: orgId,
          item_id: itemId,
          kind: input.kind,
          // still written for the old NOT NULL / CHECK, never read
          stage: input.kind === "enable" ? "org" : "deployment",
          requested_by: actor,
          note: input.note ?? "",
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e)) throw pendingExists();
      throw e;
    }
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.requested",
      target: id,
      detail: { itemId, name, kind: input.kind, ...opts.auditDetail },
    });
    return id;
  }

  /**
   * A member asks the org admins to allow hosts in the org's sandbox egress (`POST /orgs/:orgId/
   * catalog-requests/network`, `catalog.request`; spec §5.3). The hosts arrive validated (exact,
   * lowercased) and are deduped and sorted here. The deployment egress `none` ->
   * `catalog.request_invalid` (only a super admin can turn sandbox network on); every host already
   * allowed by the org's effective egress -> `catalog.request_invalid`; a conversation or agent not
   * in the org -> `catalog.request_invalid`. A pending request of the same requester for the same
   * host set is returned as is (no second request). Audits `catalog.requested`.
   */
  async requestNetwork(
    orgId: string,
    actor: string,
    input: NetworkRequestInput,
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    const id = await this.writeNetworkRequest(orgId, actor, input, opts);
    return this.view(id);
  }

  @Transactional()
  private async writeNetworkRequest(
    orgId: string,
    actor: string,
    input: NetworkRequestInput,
    opts: RequestActorOpts,
  ): Promise<string> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.request");
    const hosts = [...new Set(input.hosts.map((h) => h.toLowerCase()))].sort();
    const deployment = this.orgSettings.deployment().sandboxEgress;
    if (deployment.mode === "none") throw deploymentEgressNone();
    const settings = await readOrgSettings(t, orgId);
    const effective = effectiveSandboxEgress(
      { egress: deployment.mode, allowHosts: deployment.allowHosts },
      settings.sandboxEgress,
    );
    if (hosts.every((h) => orgAllows(h, effective))) {
      throw new ApiError(
        "catalog.request_invalid",
        "This organization's sandbox network already allows these hosts; nothing to request",
      );
    }
    if (input.conversationId !== undefined) {
      const c = await t
        .selectFrom("conversations")
        .select("id")
        .where("id", "=", input.conversationId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!c) {
        throw new ApiError(
          "catalog.request_invalid",
          "The conversation is not in this organization",
        );
      }
    }
    if (input.agentId !== undefined) {
      const a = await t
        .selectFrom("agents")
        .select("id")
        .where("id", "=", input.agentId)
        .where("org_id", "=", orgId)
        .executeTakeFirst();
      if (!a) {
        throw new ApiError("catalog.request_invalid", "The agent is not in this organization");
      }
    }
    // The same requester asking for the same hosts again gets the pending request back (the org
    // row lock above serializes concurrent asks)
    const existing = await t
      .selectFrom("catalog_requests")
      .select("id")
      .where("org_id", "=", orgId)
      .where("kind", "=", "network_allowlist")
      .where("requested_by", "=", actor)
      .where("status", "=", "pending")
      .where(sql<boolean>`detail -> 'hosts' = ${JSON.stringify(hosts)}::jsonb`)
      .executeTakeFirst();
    if (existing) return existing.id;
    const detail: NetworkRequestDetail = {
      hosts,
      conversationId: input.conversationId ?? null,
      agentId: input.agentId ?? null,
    };
    const id = randomUUID();
    await t
      .insertInto("catalog_requests")
      .values({
        id,
        org_id: orgId,
        item_id: null,
        kind: "network_allowlist",
        // still written for the old NOT NULL / CHECK, never read
        stage: "org",
        detail: JSON.stringify(detail),
        requested_by: actor,
        note: input.note ?? "",
      })
      .execute();
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.requested",
      target: id,
      detail: { kind: "network_allowlist", hosts, ...opts.auditDetail },
    });
    return id;
  }

  /**
   * An org admin asks for a marketplace entry to be imported (`POST /orgs/:orgId/
   * marketplace-requests`, `catalog.decide`). The deployment setting `orgMarketplaceBrowse` off ->
   * `catalog.marketplace_browse_disabled`; the marketplace or the entry / version missing ->
   * `marketplace.not_found` / `marketplace.entry_not_found`; a deprecated version ->
   * `marketplace.entry_deprecated`; a live item of that name ->
   * `catalog.request_invalid` (ask for access instead) when the org can see or request that item
   * (a hidden one is not revealed: the request is accepted); a pending request for the entry ->
   * `catalog.request_pending`. Audits `catalog.requested`.
   */
  async requestImport(
    orgId: string,
    actor: string,
    input: { marketplaceId: string; name: string; version: string; note?: string | undefined },
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    const id = await this.writeImportRequest(orgId, actor, input, opts);
    return this.view(id);
  }

  @Transactional()
  private async writeImportRequest(
    orgId: string,
    actor: string,
    input: { marketplaceId: string; name: string; version: string; note?: string | undefined },
    opts: RequestActorOpts,
  ): Promise<string> {
    const t = this.db;
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.decide");
    if (!(await readOrgMarketplaceBrowse(t))) {
      throw new ApiError(
        "catalog.marketplace_browse_disabled",
        "Organizations cannot browse the marketplaces or request imports in this deployment",
      );
    }
    const { entry } = await loadMarketplaceEntry(
      t,
      this.config.get(),
      input.marketplaceId,
      input.name,
      input.version,
    );
    assertEntryNotDeprecated(entry);
    const live = await t
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", input.name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    // Only an item the org can see or request is named back to it; a hidden `named` item stays
    // unknown and the request is accepted (approving it adds the org to that item's list)
    if (live && (await itemsSeenBy(t, orgId, [live.id])).has(live.id)) {
      throw new ApiError(
        "catalog.request_invalid",
        `Plugin ${input.name} is already in the catalog; request access to it instead`,
      );
    }
    const existing = await t
      .selectFrom("catalog_requests")
      .select("id")
      .where("org_id", "=", orgId)
      .where("kind", "=", "import")
      .where("marketplace_id", "=", input.marketplaceId)
      .where("entry_name", "=", input.name)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (existing) throw pendingExists();
    const id = randomUUID();
    try {
      await t
        .insertInto("catalog_requests")
        .values({
          id,
          org_id: orgId,
          item_id: null,
          kind: "import",
          stage: "deployment",
          marketplace_id: input.marketplaceId,
          entry_name: input.name,
          entry_version: input.version,
          requested_by: actor,
          note: input.note ?? "",
        })
        .execute();
    } catch (e) {
      if (isUniqueViolation(e)) throw pendingExists();
      throw e;
    }
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId,
      action: "catalog.requested",
      target: id,
      detail: {
        kind: "import",
        marketplaceId: input.marketplaceId,
        name: input.name,
        version: input.version,
        ...opts.auditDetail,
      },
    });
    return id;
  }

  /**
   * An org admin decides a member's `enable`, `network_allowlist` or `connector_setup` request
   * (`catalog.decide`). Not this org's request of those kinds -> `catalog.request_not_found`;
   * decided -> `catalog.request_decided`. Approving a `network_allowlist` request merges its hosts
   * into the org's `sandboxEgress` (`approveNetwork`). Approving an `enable` request switches the
   * item on in the org as the deciding admin ({@link OrgCatalogService.setSwitch}: its errors, e.g. inputs the install
   * needs, leave the request pending); the install itself resolves the request. A
   * `connector_setup` request is approved only by binding its connectors (ruling P4-T6-6):
   * approving it -> `catalog.request_invalid`. Rejecting stores the reason. Audits
   * `catalog.request_decided`.
   */
  async decideOrg(
    orgId: string,
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts = {},
  ): Promise<CatalogRequestView> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    if (decision.approve) {
      const itemId = await this.pendingOrgRequest(orgId, actor, requestId);
      // a network request is approved inside the decision (writeDecision), under the row lock
      if (itemId !== null) {
        await this.orgCatalog.setSwitch(orgId, actor, itemId, { enabled: true }, opts.actorTokenId);
      }
    }
    await this.writeDecision(requestId, actor, decision, opts, { orgId });
    return this.view(requestId);
  }

  /**
   * The item of a pending `enable` request of the org, null for a `network_allowlist` one (the
   * decider re-checked).
   */
  @Transactional()
  private async pendingOrgRequest(
    orgId: string,
    actor: string,
    requestId: string,
  ): Promise<string | null> {
    await this.orgLock.lockAndAuthorize(orgId, actor, "catalog.decide");
    const row = await this.db
      .selectFrom("catalog_requests")
      .select(["item_id", "status", "kind"])
      .where("id", "=", requestId)
      .where("org_id", "=", orgId)
      .where("kind", "in", [...ORG_KINDS])
      .executeTakeFirst();
    if (!row) throw requestNotFound();
    if (row.status !== "pending") throw alreadyDecided();
    if (row.kind === "connector_setup") {
      throw new ApiError(
        "catalog.request_invalid",
        "A connector setup request is resolved by binding the agent's connectors; reject it to refuse",
      );
    }
    if (row.kind === "network_allowlist") return null;
    if (row.item_id === null) throw requestNotFound();
    return row.item_id;
  }

  /**
   * A super admin decides an `access` or `import` request (re-checked inside the super
   * admin lock; the request row FOR UPDATE). Missing or an `enable` request ->
   * `catalog.request_not_found`; decided -> `catalog.request_decided`. Approving `access`: the item
   * deleted or disabled -> `catalog.item_disabled`, the org deleted -> not found; otherwise the org
   * joins the item's `named` list. Approving `import` prepares the import of the entry and returns
   * it; the request stays pending, linked to the staging, until that confirm commits (approving
   * again prepares a new one). Audits `catalog.request_decided` (`catalog.request_import_prepared`
   * for an import's approval).
   */
  async decideDeployment(
    actor: string,
    requestId: string,
    decision: CatalogDecision,
    opts: RequestActorOpts = {},
  ): Promise<{ request: CatalogRequestView; import?: MarketplaceImportResult }> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    const row = await this.pendingDeploymentRequest(actor, requestId);
    if (decision.approve && row.kind === "import")
      return this.approveImport(actor, requestId, opts);
    await this.writeDecision(requestId, actor, decision, opts, { deployment: true });
    return { request: await this.view(requestId) };
  }

  /**
   * Approves an `import` request, one approval of a request at a time (across replicas): an item
   * of the entry's name that holds the requested version already (one hidden from the org, which
   * is why the request was accepted) -> the org joins its `named` list at once, nothing imported;
   * a staging linked by an earlier approval and not expired -> that staging again; otherwise the
   * import is prepared and linked. The confirm of a staging adds the org to an item that exists by
   * then (`PluginImport.commit`).
   */
  @WithLock({ key: "catalog-request-#{1}", ttl: 60_000, waitTimeout: 180_000 })
  private async approveImport(
    actor: string,
    requestId: string,
    opts: RequestActorOpts,
  ): Promise<{ request: CatalogRequestView; import?: MarketplaceImportResult }> {
    const row = await this.pendingDeploymentRequest(actor, requestId);
    if (row.marketplace_id === null || row.entry_name === null) {
      throw new ApiError(
        "catalog.request_invalid",
        "The marketplace of this request was deleted; reject it",
      );
    }
    const existing = await this.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .select("i.id")
      .where("i.name", "=", row.entry_name)
      .where("i.deleted_at", "is", null)
      .where("v.version", "=", row.entry_version ?? "")
      .executeTakeFirst();
    if (existing) {
      await this.writeDecision(requestId, actor, { approve: true }, opts, {
        deployment: true,
        grantItem: existing.id,
      });
      return { request: await this.view(requestId) };
    }
    if (row.staging_id !== null) {
      const staged = await this.pluginImport.staged(row.staging_id).catch(() => undefined);
      if (staged) {
        return {
          request: await this.view(requestId),
          import: {
            stagingId: staged.stagingId,
            review: staged.review,
            permissionsMismatch: staged.permissionsMismatch ?? null,
          },
        };
      }
    }
    const prepared = await this.catalog.importFromMarketplace(
      actor,
      {
        marketplaceId: row.marketplace_id,
        name: row.entry_name,
        ...(row.entry_version !== null && { version: row.entry_version }),
      },
      opts,
    );
    await this.linkStaging(actor, requestId, prepared.stagingId, opts);
    return { request: await this.view(requestId), import: prepared };
  }

  /** A pending `access` / `import` request (the row locked; the super admin re-checked). */
  @Transactional()
  private async pendingDeploymentRequest(actor: string, requestId: string) {
    await this.adminLock.lockAndAuthorize(actor);
    const row = await this.db
      .selectFrom("catalog_requests")
      .select(["kind", "status", "marketplace_id", "entry_name", "entry_version", "staging_id"])
      .where("id", "=", requestId)
      .where("kind", "in", [...DEPLOYMENT_KINDS])
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw requestNotFound();
    if (row.status !== "pending") throw alreadyDecided();
    return row;
  }

  /** Links a still pending `import` request to its prepared staging. */
  @Transactional()
  private async linkStaging(
    actor: string,
    requestId: string,
    stagingId: string,
    opts: RequestActorOpts,
  ): Promise<void> {
    await this.adminLock.lockAndAuthorize(actor);
    const row = await this.db
      .selectFrom("catalog_requests")
      .select(["org_id", "status", "entry_name"])
      .where("id", "=", requestId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.status !== "pending") throw alreadyDecided();
    await this.db
      .updateTable("catalog_requests")
      .set({ staging_id: stagingId })
      .where("id", "=", requestId)
      .execute();
    await audit(this.db, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: row.org_id,
      action: "catalog.request_import_prepared",
      target: requestId,
      detail: { name: row.entry_name, stagingId },
    });
  }

  /**
   * Writes a decision (the request row FOR UPDATE): org side (`orgId`: the org admin re-checked,
   * `enable` only) or deployment side (the super admin re-checked, `access` / `import`). An
   * approval of an `enable` request may find it approved already by the install it triggered.
   */
  @Transactional()
  private async writeDecision(
    requestId: string,
    actor: string,
    decision: CatalogDecision,
    opts: RequestActorOpts,
    side: { orgId: string } | { deployment: true; grantItem?: string },
  ): Promise<void> {
    const t = this.db;
    if ("orgId" in side) await this.orgLock.lockAndAuthorize(side.orgId, actor, "catalog.decide");
    else await this.adminLock.lockAndAuthorize(actor);
    let q = t
      .selectFrom("catalog_requests")
      .select(["id", "org_id", "item_id", "kind", "status", "decided_by", "detail"])
      .where("id", "=", requestId);
    q =
      "orgId" in side
        ? q.where("org_id", "=", side.orgId).where("kind", "in", [...ORG_KINDS])
        : q.where("kind", "in", [...DEPLOYMENT_KINDS]);
    const row = await q.forUpdate().executeTakeFirst();
    if (!row) throw requestNotFound();
    if (row.status !== "pending") {
      // The switch-on of this approval already resolved it (the install approves pending requests)
      if (decision.approve && row.kind === "enable" && row.status === "approved") return;
      throw alreadyDecided();
    }
    if (decision.approve && row.kind === "access" && row.item_id !== null) {
      const item = await t
        .selectFrom("catalog_items")
        .select(["deleted_at", "disabled"])
        .where("id", "=", row.item_id)
        .executeTakeFirst();
      if (!item || item.deleted_at !== null || item.disabled) throw itemDisabled();
      const org = await t
        .selectFrom("orgs")
        .select("deleted_at")
        .where("id", "=", row.org_id)
        .executeTakeFirst();
      if (!org || org.deleted_at !== null) throw requestNotFound();
      await this.scope.addOrg(actor, row.item_id, row.org_id, { ...opts, requestId });
    }
    if (decision.approve && row.kind === "network_allowlist") {
      await this.approveNetwork(row.org_id, actor, requestId, row.detail, opts);
    }
    // An `import` request whose entry is in the catalog already: the org joins that item's list
    const grantItem = "grantItem" in side ? side.grantItem : undefined;
    if (decision.approve && row.kind === "import" && grantItem !== undefined) {
      await this.scope.addOrg(actor, grantItem, row.org_id, { ...opts, requestId });
    }
    await t
      .updateTable("catalog_requests")
      .set({
        status: decision.approve ? "approved" : "rejected",
        reason: decision.approve ? null : (decision.reason ?? null),
        ...(grantItem !== undefined && { item_id: grantItem }),
        decided_by: actor,
        decided_at: sql<Date>`now()`,
      })
      .where("id", "=", requestId)
      .execute();
    await audit(t, {
      actorAccountId: actor,
      ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
      orgId: row.org_id,
      action: "catalog.request_decided",
      target: requestId,
      detail: {
        itemId: row.item_id,
        kind: row.kind,
        decision: decision.approve ? "approve" : "reject",
        ...(!decision.approve && decision.reason !== undefined && { reason: decision.reason }),
      },
    });
  }

  /**
   * Approves a `network_allowlist` request inside its decision's transaction: the hosts the org's
   * effective egress does not allow yet are added to the org's `sandboxEgress.allowHosts` through
   * {@link OrgSettingsService.update} (audited `org.settings_updated` with `requestId`). An org
   * following the deployment default starts from the deployment's list (it keeps its own list from
   * then on). The deployment egress `none`, or the org's `none` -> `catalog.request_invalid`; more
   * than {@link ORG_SANDBOX_ALLOW_HOSTS_MAX} hosts -> `catalog.request_invalid`. Hosts all allowed
   * already: nothing is written.
   */
  private async approveNetwork(
    orgId: string,
    actor: string,
    requestId: string,
    detail: unknown,
    opts: RequestActorOpts,
  ): Promise<void> {
    const hosts = (detail as Partial<NetworkRequestDetail> | null)?.hosts ?? [];
    const deployment = this.orgSettings.deployment().sandboxEgress;
    if (deployment.mode === "none") throw deploymentEgressNone();
    const current = (await readOrgSettings(this.db, orgId)).sandboxEgress;
    if (current?.mode === "none") {
      throw new ApiError(
        "catalog.request_invalid",
        "The organization has sandbox network turned off; turn it on in the organization settings first",
      );
    }
    const effective = effectiveSandboxEgress(
      { egress: deployment.mode, allowHosts: deployment.allowHosts },
      current,
    );
    const missing = hosts.filter((h) => !orgAllows(h, effective));
    if (missing.length === 0) return;
    const base = current?.allowHosts ?? deployment.allowHosts;
    const allowHosts = [...new Set([...base, ...missing])];
    if (allowHosts.length > ORG_SANDBOX_ALLOW_HOSTS_MAX) {
      throw new ApiError(
        "catalog.request_invalid",
        `The organization's sandbox allowlist would exceed ${ORG_SANDBOX_ALLOW_HOSTS_MAX} hosts; remove some in the organization settings first`,
      );
    }
    await this.orgSettings.update(
      orgId,
      { sandboxEgress: { mode: "allowlist", allowHosts } },
      actor,
      opts.actorTokenId,
      { requestId },
    );
  }

  /**
   * The requester dismisses a decided request from the inbox (`POST /orgs/:orgId/
   * catalog-requests/:id/dismiss`). Not the requester's decided request in this org ->
   * `catalog.request_not_found`.
   */
  async dismiss(orgId: string, accountId: string, requestId: string): Promise<void> {
    if (!UUID_RE.test(requestId)) throw requestNotFound();
    const r = await this.db
      .updateTable("catalog_requests")
      .set({ dismissed_at: sql<Date>`now()` })
      .where("id", "=", requestId)
      .where("org_id", "=", orgId)
      .where("requested_by", "=", accountId)
      .where("status", "in", ["approved", "rejected"])
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) throw requestNotFound();
  }

  /** 超级管理员的申请列表（`access` / `import`；`status` 缺省 pending），新的在前。 */
  async listDeployment(q: { status?: CatalogRequestStatus } = {}): Promise<CatalogRequestView[]> {
    const rows = await this.baseQuery()
      .where("r.kind", "in", [...DEPLOYMENT_KINDS])
      .where("r.status", "=", q.status ?? "pending")
      .where("o.deleted_at", "is", null)
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    return this.toViews(rows);
  }

  /** 待超级管理员处理的申请数（后台概览）。 */
  async countPendingDeployment(): Promise<number> {
    const r = await this.db
      .selectFrom("catalog_requests as r")
      .innerJoin("orgs as o", "o.id", "r.org_id")
      .select(sql<string>`count(*)`.as("n"))
      .where("r.kind", "in", [...DEPLOYMENT_KINDS])
      .where("r.status", "=", "pending")
      .where("o.deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /**
   * The inbox: when the account is an org admin of the org (the role read live), the members'
   * pending `enable` and `network_allowlist` requests and the pending `connector_setup` requests,
   * newest first; otherwise none.
   */
  async listForOrgAdmin(orgId: string, accountId: string): Promise<CatalogRequestView[]> {
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    if (!m || !roleAtLeast(m.role, "admin")) return [];
    const rows = await this.baseQuery()
      .where("r.org_id", "=", orgId)
      .where("r.kind", "in", [...ORG_KINDS])
      .where("r.status", "=", "pending")
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    // A request on an item the org can no longer see (its scope hid it since) is left out, so
    // nothing reveals the item's name to the org; a setup request of a deleted agent too
    const ids = [...new Set(rows.flatMap((r) => (r.item_id !== null ? [r.item_id] : [])))];
    const seen = await itemsSeenBy(this.db, orgId, ids);
    return this.toViews(
      rows.filter((r) =>
        r.kind === "connector_setup"
          ? r.agent_id !== null && r.agent_deleted_at === null
          : r.kind === "network_allowlist" || (r.item_id !== null && seen.has(r.item_id)),
      ),
    );
  }

  /** The inbox: the account's decided requests in the org it has not dismissed, newest first. */
  async listDecidedForRequester(orgId: string, accountId: string): Promise<CatalogRequestView[]> {
    const rows = await this.baseQuery()
      .where("r.org_id", "=", orgId)
      .where("r.requested_by", "=", accountId)
      .where("r.status", "in", ["approved", "rejected"])
      .where("r.dismissed_at", "is", null)
      .orderBy("r.decided_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    return this.toViews(rows);
  }

  /**
   * The account's own requests in the org, pending and decided (dismissed ones too), newest first;
   * cancelled ones are left out (the Platform tool's `requests.list-mine`).
   */
  async listForRequester(orgId: string, accountId: string): Promise<CatalogRequestView[]> {
    const rows = await this.baseQuery()
      .where("r.org_id", "=", orgId)
      .where("r.requested_by", "=", accountId)
      .where("r.status", "in", ["pending", "approved", "rejected"])
      .orderBy("r.created_at", "desc")
      .orderBy("r.id")
      .limit(CATALOG_REQUESTS_LIST_MAX)
      .execute();
    return this.toViews(rows);
  }

  async view(id: string): Promise<CatalogRequestView> {
    const row = await this.baseQuery().where("r.id", "=", id).executeTakeFirst();
    if (!row) throw requestNotFound();
    return (await this.toViews([row]))[0] as CatalogRequestView;
  }

  /** The views of `rows`, with the display names of the connector templates setup requests name. */
  private async toViews(rows: RequestRow[]): Promise<CatalogRequestView[]> {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.kind !== "connector_setup") continue;
      const def = r.agent_definition as Pick<AgentDefinition, "pendingConnectors"> | null;
      for (const c of def?.pendingConnectors ?? []) {
        if ("template" in c.source && UUID_RE.test(c.source.template)) ids.add(c.source.template);
      }
    }
    const names = new Map<string, LocalizedName | null>();
    if (ids.size > 0) {
      const found = await this.db
        .selectFrom("platform_connector_templates")
        .select(["id", "file"])
        .where("id", "in", [...ids])
        .execute();
      for (const t of found) {
        const dn = (t.file as { displayName?: LocalizedName } | null)?.displayName;
        names.set(t.id, dn ?? null);
      }
    }
    return rows.map((r) => toView(r, names));
  }

  private baseQuery() {
    return (
      this.db
        .selectFrom("catalog_requests as r")
        .leftJoin("catalog_items as i", "i.id", "r.item_id")
        .innerJoin("orgs as o", "o.id", "r.org_id")
        .leftJoin("accounts as a", "a.id", "r.requested_by")
        // a connector_setup request's agent and its current version (name, pending connectors)
        .leftJoin("agents as ag", "ag.id", "r.agent_id")
        .leftJoin("agent_versions as av", (j) =>
          j.onRef("av.agent_id", "=", "ag.id").onRef("av.version", "=", "ag.current_version"),
        )
        .select([
          "r.agent_id",
          "r.pending_keys",
          "ag.deleted_at as agent_deleted_at",
          "av.definition as agent_definition",
          "r.id",
          "r.org_id",
          "o.name as org_name",
          "r.kind",
          "r.item_id",
          "i.name",
          "i.display_name",
          "r.marketplace_id",
          "r.entry_name",
          "r.entry_version",
          "r.status",
          "r.note",
          "r.reason",
          "r.requested_by",
          "a.display_name as requested_by_name",
          "r.decided_by",
          "r.decided_at",
          "r.staging_id",
          "r.detail",
          "r.created_at",
        ])
    );
  }
}

/** The view fields of a `connector_setup` request (ruling P4-T6-5); null for other kinds. */
function setupFields(
  r: {
    kind: CatalogRequestKind;
    agent_id: string | null;
    pending_keys: string[] | null;
    agent_deleted_at: Date | null;
    agent_definition: unknown;
  },
  templateNames: ReadonlyMap<string, LocalizedName | null>,
): Pick<CatalogRequestView, "agent" | "connectors"> {
  if (r.kind !== "connector_setup" || r.agent_id === null) return { agent: null, connectors: null };
  const def = (r.agent_definition ?? null) as Pick<
    AgentDefinition,
    "name" | "pendingConnectors"
  > | null;
  const pending = new Map((def?.pendingConnectors ?? []).map((c) => [c.key, c]));
  const connectors: SetupRequestConnector[] = [];
  for (const key of r.pending_keys ?? []) {
    const c = pending.get(key);
    if (c === undefined) continue;
    const src = c.source;
    connectors.push({
      key,
      label: c.label,
      kind: "template" in src ? "template" : "needs",
      source:
        "template" in src
          ? { template: { id: src.template, displayName: templateNames.get(src.template) ?? null } }
          : {
              needs: {
                protocol: src.needs.protocol,
                endpoint: src.needs.endpoint,
                tools: [...src.needs.tools],
              },
            },
      tools: c.tools !== undefined && c.tools.length > 0 ? [...c.tools] : null,
      // jsonb keeps no key order: sorted
      policies: Object.keys(c.policies ?? {}).sort(),
    });
  }
  return {
    agent: { id: r.agent_id, name: def?.name ?? "", deleted: r.agent_deleted_at !== null },
    connectors,
  };
}

/** The detail of a `network_allowlist` request; null for other kinds. */
function networkFields(r: {
  kind: CatalogRequestKind;
  detail: unknown;
}): NetworkRequestDetail | null {
  if (r.kind !== "network_allowlist") return null;
  const d = (r.detail ?? {}) as Partial<NetworkRequestDetail>;
  return {
    hosts: Array.isArray(d.hosts) ? d.hosts.filter((h) => typeof h === "string") : [],
    conversationId: typeof d.conversationId === "string" ? d.conversationId : null,
    agentId: typeof d.agentId === "string" ? d.agentId : null,
  };
}

type RequestRow = {
  id: string;
  org_id: string;
  org_name: string;
  kind: CatalogRequestKind;
  agent_id: string | null;
  pending_keys: string[] | null;
  agent_deleted_at: Date | null;
  agent_definition: unknown;
  item_id: string | null;
  name: string | null;
  display_name: LocalizedName | null;
  marketplace_id: string | null;
  entry_name: string | null;
  entry_version: string | null;
  status: CatalogRequestStatus;
  note: string;
  reason: string | null;
  requested_by: string | null;
  requested_by_name: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  staging_id: string | null;
  detail: unknown;
  created_at: Date;
};

function toView(
  r: RequestRow,
  templateNames: ReadonlyMap<string, LocalizedName | null>,
): CatalogRequestView {
  return {
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    kind: r.kind,
    item:
      r.item_id !== null && r.name !== null
        ? { id: r.item_id, name: r.name, displayName: r.display_name }
        : null,
    entry:
      r.entry_name !== null
        ? { marketplaceId: r.marketplace_id, name: r.entry_name, version: r.entry_version }
        : null,
    ...setupFields(r, templateNames),
    network: networkFields(r),
    status: r.status,
    note: r.note,
    reason: r.reason,
    requestedBy: r.requested_by,
    requestedByName: r.requested_by_name,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    stagingId: r.status === "pending" ? r.staging_id : null,
    createdAt: r.created_at.toISOString(),
  };
}
