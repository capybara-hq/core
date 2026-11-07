import { createHash } from "node:crypto";
import { extensionToolKey } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type DisabledToolRef, extensionToolDisabled } from "../agents/definition.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionHost } from "../extensions/host.js";
import { extensionVisibleTo } from "../extensions/org-config.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OrgLock } from "../orgs/org-lock.js";

/** One tool of an extension with its switch in the org. */
export interface OrgToolSwitch {
  tool: string;
  enabled: boolean;
}

/** An org agent whose current version selects the tool being switched off. */
export interface AffectedAgent {
  id: string;
  name: string;
}

/**
 * The result of {@link OrgToolSwitches.set}: the PCM §5 rule 8 preview of a switch-off (the org's
 * agents that selected the tool and the hash to confirm it with), or the switch applied.
 */
export type OrgToolSwitchResult =
  | { applied: false; affectedAgents: AffectedAgent[]; confirm: string }
  | { applied: true };

/** Model-visible (English): why a turned-off extension tool is not offered. */
export const toolTurnedOffReason = (key: string) =>
  `Tool ${key} is turned off in this organization`;

/** The confirm hash of a switch-off preview. */
function switchOffHash(
  orgId: string,
  plugin: string,
  tool: string,
  agents: readonly AffectedAgent[],
): string {
  return createHash("sha256")
    .update(JSON.stringify({ orgId, plugin, tool, agents: agents.map((a) => a.id) }))
    .digest("hex");
}

/**
 * Per-org switches of single extension tools (layering spec A §7, table `org_tool_switches`): an
 * org admin turns off one tool an extension registers (`ctx.tools.register`); it is then not
 * offered to any agent of the org (`ToolRegistry.forAgent`) and refused if called
 * (`ToolPipeline`). No row means on. A row of a tool the extension stops registering is kept and
 * applies again if the tool comes back. Builtin and connector tools are out of scope. Read from PG
 * on every use, no in-process state.
 */
@Injectable()
export class OrgToolSwitches {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ExtensionHost) private readonly host: Pick<ExtensionHost, "tools">,
    /** The org row lock: re-checks `org.extensions.manage` under the lock. */
    @Inject(OrgLock) private readonly orgLock: Pick<OrgLock, "lockAndAuthorize">,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The tool names `plugin` registers on this replica, in registration order. */
  private registered(plugin: string): string[] {
    return [
      ...new Set(
        this.host
          .tools()
          .filter((t) => t.plugin === plugin)
          .map((t) => t.spec.name),
      ),
    ];
  }

  /**
   * The tools of an extension the org sees: running here and visible under plugin scope, else 404
   * `extension.not_found` (an invisible one is answered like an unknown one).
   */
  private async toolsFor(orgId: string, plugin: string): Promise<string[]> {
    const tools = this.registered(plugin);
    if (tools.length === 0 || !(await extensionVisibleTo(this.db, orgId, plugin))) {
      throw new ApiError("extension.not_found", `Extension ${plugin} is not installed`);
    }
    return tools;
  }

  /** The stored switches of the org (all extensions, or one), `false` ones only matter. */
  private async offRows(
    orgId: string,
    plugin?: string,
  ): Promise<{ plugin: string; tool: string }[]> {
    let q = this.db
      .selectFrom("org_tool_switches")
      .select(["plugin", "tool"])
      .where("org_id", "=", orgId)
      .where("enabled", "=", false);
    if (plugin !== undefined) q = q.where("plugin", "=", plugin);
    return q.execute();
  }

  /** Every tool the extension registers on this replica with its switch (default on). */
  async list(orgId: string, plugin: string): Promise<OrgToolSwitch[]> {
    const tools = await this.toolsFor(orgId, plugin);
    const off = new Set((await this.offRows(orgId, plugin)).map((r) => r.tool));
    return tools.map((tool) => ({ tool, enabled: !off.has(tool) }));
  }

  /** The model-visible keys (`plugin__<extension>__<tool>`) of the tools turned off in the org. */
  async offKeys(orgId: string): Promise<Set<string>> {
    return new Set((await this.offRows(orgId)).map((r) => extensionToolKey(r.plugin, r.tool)));
  }

  /** Whether the org turned off this tool. */
  async isToolOff(orgId: string, plugin: string, tool: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("org_tool_switches")
      .select("enabled")
      .where("org_id", "=", orgId)
      .where("plugin", "=", plugin)
      .where("tool", "=", tool)
      .executeTakeFirst();
    return row?.enabled === false;
  }

  /**
   * Switches one tool in the org. On applies at once. Off, while the tool is on: without
   * `confirm` the preview (the org's agents whose current version selects the tool) and its hash,
   * with the current hash the switch is written (a changed preview -> 409 `plugin.switch_stale`).
   * A tool the extension does not register -> 404 `extension.tool_not_found`. A change writes the
   * audit row `extension.tool_switched`.
   */
  @Transactional()
  async set(
    orgId: string,
    plugin: string,
    tool: string,
    enabled: boolean,
    actor: { accountId: string; tokenId?: string | undefined },
    confirm?: string,
  ): Promise<OrgToolSwitchResult> {
    await this.orgLock.lockAndAuthorize(orgId, actor.accountId, "org.extensions.manage");
    const tools = await this.toolsFor(orgId, plugin);
    if (!tools.includes(tool)) {
      throw new ApiError(
        "extension.tool_not_found",
        `Extension ${plugin} does not register a tool named ${tool}`,
      );
    }
    const from = !(await this.isToolOff(orgId, plugin, tool));
    if (from === enabled) return { applied: true };
    if (!enabled) {
      const affectedAgents = await this.agentsSelecting(orgId, plugin, tool);
      const hash = switchOffHash(orgId, plugin, tool, affectedAgents);
      if (confirm === undefined) return { applied: false, affectedAgents, confirm: hash };
      if (confirm !== hash) {
        throw new ApiError(
          "plugin.switch_stale",
          "What switching this tool off affects has changed; review it and confirm again",
        );
      }
    }
    await this.db
      .insertInto("org_tool_switches")
      .values({ org_id: orgId, plugin, tool, enabled, updated_by: actor.accountId })
      .onConflict((oc) =>
        oc.columns(["org_id", "plugin", "tool"]).doUpdateSet({
          enabled,
          updated_by: actor.accountId,
          updated_at: sql<Date>`now()` as unknown as Date,
        }),
      )
      .execute();
    await audit(this.db, {
      actorAccountId: actor.accountId,
      ...(actor.tokenId !== undefined && { actorTokenId: actor.tokenId }),
      orgId,
      action: "extension.tool_switched",
      target: extensionToolKey(plugin, tool),
      detail: { plugin, tool, from, to: enabled },
    });
    return { applied: true };
  }

  /**
   * The org's live agents whose current version has extension tool `tool` of `plugin` on: tools
   * are on by default (tools default-on spec §4), so every agent that does not turn it off.
   */
  private async agentsSelecting(
    orgId: string,
    plugin: string,
    tool: string,
  ): Promise<AffectedAgent[]> {
    const rows = await this.db
      .selectFrom("agents as a")
      .innerJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "a.id").onRef("v.version", "=", "a.current_version"),
      )
      .select(["a.id", "v.definition"])
      .where("a.org_id", "=", orgId)
      .where("a.deleted_at", "is", null)
      .orderBy("a.id")
      .execute();
    const out: AffectedAgent[] = [];
    for (const r of rows) {
      const def = r.definition as { name?: unknown; disabledTools?: unknown } | null;
      const off = Array.isArray(def?.disabledTools)
        ? extensionToolDisabled(def.disabledTools as DisabledToolRef[], plugin, tool)
        : false;
      if (!off) out.push({ id: r.id, name: typeof def?.name === "string" ? def.name : r.id });
    }
    return out;
  }
}
