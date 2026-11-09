import { connectorToolKey, type ToolSpec } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";
import type { ConnectorAuth } from "./credentials.js";
import { policyFromAnnotations, type ToolPolicy } from "./registry.js";

/**
 * Why a member cannot set a tool's policy: the org switched the tool off (or it is not offered:
 * pending review, gone), or the org set its default to deny. Either way it stays denied.
 */
export type MemberPolicyLock = "disabled" | "org_deny";

/** One tool on the member's 权限 sheet (`GET …/connectors/:id/tool-policies/me`). */
export interface MemberToolPolicyView {
  name: string;
  key: string;
  title: string | null;
  description: string;
  /** The org's default for the tool (`connector_tools.default_policy`): what applies without a setting. */
  defaultPolicy: ToolPolicy;
  /** What the tool's annotations alone give (`readOnlyHint: true` allows, anything else asks). */
  annotationPolicy: "allow" | "ask";
  /** The member's own setting, null without one. */
  policy: ToolPolicy | null;
  /** Locked by the org: the member's setting does not apply, the tool is denied. */
  locked: MemberPolicyLock | null;
}

/** Whether a connector's credential is per member: its calls are made with the member's connection. */
export const personalAuth = (auth: unknown): boolean => {
  const a = auth as ConnectorAuth | null;
  return a !== null && a.type !== "none" && (a as { ownership?: unknown }).ownership === "personal";
};

const notPersonal = () =>
  new ApiError(
    "connector.not_personal",
    "This connector uses one credential for the whole organization; only a connector each member connects to with their own credential has per-member tool policies",
  );
const notFound = () => new ApiError("connector.not_found", "Connector not found");

/**
 * A member's own tool policies for their own connection of a personal-credential connector
 * (maintainer decision 2026-11-09, the connector card's 权限). They apply to every agent the
 * member uses; an agent's tool policy overrides them; a tool the org switched off or set to deny
 * stays denied (`tools/policy.ts` `connectorPolicy`). Only the account itself reads or writes its
 * rows: the routes take the account from the session, never from the request.
 */
@Injectable()
export class ConnectorAccountPolicies {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  /** The kernel-schema handle of the current context (its transaction, else the pool). */
  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The connector's tools with the account's settings; not personal -> 409 `connector.not_personal`. */
  async read(
    orgId: string,
    connectorId: string,
    accountId: string,
  ): Promise<MemberToolPolicyView[]> {
    const c = await this.connector(orgId, connectorId);
    const tools = await this.db
      .selectFrom("connector_tools")
      .select(["name", "spec", "status", "default_policy", "missing_since"])
      .where("connector_id", "=", connectorId)
      .orderBy("name")
      .execute();
    const mine = new Map(
      (
        await this.db
          .selectFrom("connector_tool_account_policies")
          .select(["tool_name", "policy"])
          .where("connector_id", "=", connectorId)
          .where("account_id", "=", accountId)
          .execute()
      ).map((r) => [r.tool_name, r.policy]),
    );
    return tools.map((t) => {
      const spec = t.spec as ToolSpec;
      const locked: MemberPolicyLock | null =
        t.status !== "enabled" || t.missing_since !== null
          ? "disabled"
          : t.default_policy === "deny"
            ? "org_deny"
            : null;
      return {
        name: t.name,
        key: connectorToolKey(c.slug, t.name),
        title: typeof spec.title === "string" ? spec.title : null,
        description: spec.description,
        defaultPolicy: t.default_policy,
        annotationPolicy: policyFromAnnotations(spec.annotations),
        policy: mine.get(t.name) ?? null,
        locked,
      };
    });
  }

  /**
   * Sets (a policy) or clears (null) the account's policies for some of the connector's tools;
   * an unknown tool -> 404 `connector.tool_not_found`. Locked tools may hold a setting: it does not
   * apply while the lock lasts. Audits `connector.member_policies_changed`.
   */
  @Transactional()
  async set(
    orgId: string,
    connectorId: string,
    accountId: string,
    changes: Record<string, ToolPolicy | null>,
    actorTokenId?: string,
  ): Promise<void> {
    await this.orgLock.lockAndAuthorize(orgId, accountId, "connectors.use");
    await this.connector(orgId, connectorId);
    const names = Object.keys(changes);
    if (names.length === 0) return;
    const known = new Set(
      (
        await this.db
          .selectFrom("connector_tools")
          .select("name")
          .where("connector_id", "=", connectorId)
          .where("name", "in", names)
          .execute()
      ).map((r) => r.name),
    );
    const unknown = names.find((n) => !known.has(n));
    if (unknown !== undefined) {
      throw new ApiError("connector.tool_not_found", `No tool ${unknown} in this connector`);
    }
    const cleared = names.filter((n) => changes[n] === null);
    if (cleared.length > 0) {
      await this.db
        .deleteFrom("connector_tool_account_policies")
        .where("connector_id", "=", connectorId)
        .where("account_id", "=", accountId)
        .where("tool_name", "in", cleared)
        .execute();
    }
    const set = names.flatMap((n) => {
      const p = changes[n];
      return p === null || p === undefined ? [] : [{ name: n, policy: p }];
    });
    if (set.length > 0) {
      await this.db
        .insertInto("connector_tool_account_policies")
        .values(
          set.map((x) => ({
            org_id: orgId,
            connector_id: connectorId,
            account_id: accountId,
            tool_name: x.name,
            policy: x.policy,
          })),
        )
        .onConflict((oc) =>
          oc.columns(["connector_id", "account_id", "tool_name"]).doUpdateSet({
            policy: (eb) => eb.ref("excluded.policy"),
            updated_at: sql<Date>`now()`,
          }),
        )
        .execute();
    }
    await audit(this.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "connector.member_policies_changed",
      target: connectorId,
      detail: { tools: changes },
    });
  }

  /** The org's live personal-credential connector, else 404 / 409. */
  private async connector(orgId: string, connectorId: string): Promise<{ slug: string }> {
    const c = await this.db
      .selectFrom("connectors")
      .select(["slug", "auth"])
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!c) throw notFound();
    if (!personalAuth(c.auth)) throw notPersonal();
    return { slug: c.slug };
  }
}
