import type { ConnectorTemplateFile } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { ConnectorsService } from "../tools/connectors.service.js";
import { connectorTemplatesOn } from "./component-state.js";
import { PluginInstaller } from "./plugin-install.js";

/** One connector template of an installed plugin the org never had a connector from. */
interface Missing {
  orgId: string;
  itemId: string;
  platformTemplateId: string;
  templateId: string;
  file: ConnectorTemplateFile;
}

/** What one ensure did. */
export interface EnsureResult {
  /** Connectors created. */
  created: number;
  /** Templates refused by the create's checks (kind off in the org, planning failed): logged. */
  skipped: number;
  /** Templates whose connector extension is not loaded on this replica (yet): not attempted. */
  notLoaded: number;
}

/**
 * Creates the template connectors an org never had (ruling R27): for every plugin installed in the
 * org (or only `itemId`), each connector template that is on there and that the org never had a
 * connector from. "Never had" means no connector of the org (live or deleted) was made from the
 * platform template, and no install of the plugin in the org recorded a connector for its
 * template id. So a connector an admin deleted is never made again. The platform templates
 * (`platform_connector_templates`, one version per deployment) are the authority, as for the
 * switch-on (ruling R24).
 *
 * Each connector is created in its own transaction under the org row lock. That transaction
 * re-checks the "never had" rule and that the template is on, then creates it as an install
 * would (`PluginInstaller.createSwitchedOnTemplateConnectorIn`: `planConnector` +
 * `createDeferredIn`, no outbound call, `needs_config` when it needs an org credential or OAuth
 * client, recorded on the install). The create re-checks that the connector kind is available
 * in the org. A refusal (an `ApiError` from those checks) is logged and skipped. Any other error
 * is thrown: the caller's job retries, or the startup pass stops without its mark. A template
 * whose connector extension is not loaded on this replica is counted in `notLoaded` and not
 * attempted: the queued ensure retries until it loads.
 *
 * Callers: the `template-connectors-ensure` job (owed by an install's commit and by an org
 * switching an extension on), the plugin scope sync after it added a plugin's dependencies, and
 * the one-off startup reconciliation (`TemplateConnectorReconciler`).
 */
@Injectable()
export class TemplateConnectorEnsurer {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    /** The connector kinds each org can create connectors of (the sweep's availability check). */
    @Inject(ConnectorsService) private readonly connectors: Pick<ConnectorsService, "kinds">,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** The live orgs with at least one template connector they never had (the startup pass). */
  async orgsMissing(): Promise<string[]> {
    const rows = await this.missingQuery(undefined, undefined).execute();
    return [...new Set(rows.map((r) => r.org_id))];
  }

  /**
   * The backstop sweep (ruling R30, `CatalogJobs.sweepTemplateConnectors`): runs
   * {@link ensureTemplateConnectorsIn} for at most `limit` orgs that have a template connector
   * they never had whose connector kind is available there now (loaded on this replica and its
   * extension enabled in the org). It catches what no event re-triggers: a kind that loaded only
   * after the queued ensure gave up, or an always-on connector extension (it writes no org switch,
   * so it owes no ensure). One query lists the candidates; it already leaves out templates of
   * connector extensions not loaded here and templates plainly off in the org (switched off, or
   * shipped default-off and not switched on). Then one kinds read per candidate org, in org id
   * order, until `limit` orgs are found. Templates off by their scope are left to the ensure's
   * exact check.
   */
  async sweep(opts: { limit: number; signal?: AbortSignal }): Promise<{
    orgs: number;
    created: number;
  }> {
    const loaded = new Set(this.installer.loadedConnectors().map((c) => c.plugin));
    if (loaded.size === 0) return { orgs: 0, created: 0 };
    const rows = await this.missingQuery(undefined, undefined)
      .innerJoin("catalog_items as i", "i.id", "a.item_id")
      .where(sql<string>`t.file->'template'->>'plugin'`, "in", [...loaded])
      .where("t.disabled", "=", false)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("component_org_switches as s")
              .select("s.component_id")
              .where("s.kind", "=", "connector_template")
              .whereRef("s.component_id", "=", "t.id")
              .whereRef("s.org_id", "=", "a.org_id")
              .where("s.enabled", "=", false),
          ),
        ),
      )
      .where(({ or, eb, exists, selectFrom }) =>
        or([
          eb(sql<string>`coalesce(t.file->>'defaultEnabled', 'true')`, "<>", "false"),
          eb("i.builtin", "=", true),
          exists(
            selectFrom("component_org_switches as s")
              .select("s.component_id")
              .where("s.kind", "=", "connector_template")
              .whereRef("s.component_id", "=", "t.id")
              .whereRef("s.org_id", "=", "a.org_id")
              .where("s.enabled", "=", true),
          ),
        ]),
      )
      .execute();
    const kindsByOrg = new Map<string, { plugin: string; connector: string }[]>();
    for (const r of rows) {
      const t = (r.file as ConnectorTemplateFile).template;
      kindsByOrg.set(r.org_id, [
        ...(kindsByOrg.get(r.org_id) ?? []),
        { plugin: t.plugin, connector: t.connector },
      ]);
    }
    const orgs: string[] = [];
    for (const [orgId, wanted] of kindsByOrg) {
      if (orgs.length >= opts.limit) break;
      opts.signal?.throwIfAborted();
      const available = await this.connectors.kinds(orgId);
      if (
        wanted.some((w) => available.some((k) => k.kind === w.connector && k.plugin === w.plugin))
      )
        orgs.push(orgId);
    }
    let created = 0;
    for (const orgId of orgs) {
      opts.signal?.throwIfAborted();
      const r = await this.ensureTemplateConnectorsIn(orgId, undefined, {
        ...(opts.signal !== undefined && { signal: opts.signal }),
        via: "sweep",
      });
      created += r.created;
    }
    return { orgs: orgs.length, created };
  }

  /**
   * Creates the org's template connectors it never had (see the class comment); `itemId` limits
   * it to one plugin. `signal` stops it between connectors.
   */
  async ensureTemplateConnectorsIn(
    orgId: string,
    itemId?: string,
    opts: { signal?: AbortSignal; via?: string } = {},
  ): Promise<EnsureResult> {
    const result: EnsureResult = { created: 0, skipped: 0, notLoaded: 0 };
    const byItem = new Map<string, Missing[]>();
    for (const r of await this.missingQuery(orgId, itemId).execute()) {
      const m: Missing = {
        orgId: r.org_id,
        itemId: r.item_id,
        platformTemplateId: r.platform_template_id,
        templateId: r.template_id,
        file: r.file as ConnectorTemplateFile,
      };
      byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), m]);
    }
    const deps = this.installer.templateDeps();
    for (const [item, list] of byItem) {
      // which are on, read once per plugin; re-checked for each create under the org lock
      const on = await connectorTemplatesOn(
        this.db,
        orgId,
        item,
        list.map((m) => m.templateId),
      );
      for (const m of list) {
        if (!on.has(m.templateId)) continue;
        opts.signal?.throwIfAborted();
        const t = m.file.template;
        if (!deps.findConnector(t.plugin, t.connector)) {
          result.notLoaded += 1;
          continue;
        }
        try {
          if (await this.createOne(m, opts.via ?? "ensure")) result.created += 1;
        } catch (e) {
          if (!(e instanceof ApiError)) throw e;
          result.skipped += 1;
          this.log.warn("template connector not created", {
            orgId,
            itemId: m.itemId,
            templateId: m.templateId,
            code: e.code,
            error: e.message,
          });
        }
      }
    }
    return result;
  }

  /**
   * The connector templates of the org's installed plugins (in live orgs) the org never had a
   * connector from; `orgId` / `itemId` undefined: every org / plugin.
   */
  private missingQuery(orgId: string | undefined, itemId: string | undefined) {
    let q = this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .innerJoin("platform_connector_templates as t", "t.catalog_item_id", "a.item_id")
      .select(["a.org_id", "a.item_id", "t.id as platform_template_id", "t.template_id", "t.file"])
      .where("a.status", "=", "installed")
      .where("o.deleted_at", "is", null)
      .where("t.deleted_at", "is", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("connectors as c")
              .select("c.id")
              .whereRef("c.org_id", "=", "a.org_id")
              .whereRef("c.platform_template_id", "=", "t.id"),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("plugin_install_components as l")
              .innerJoin("plugin_installs as b", "b.id", "l.install_id")
              .select("l.ref")
              .whereRef("b.org_id", "=", "a.org_id")
              .whereRef("b.item_id", "=", "a.item_id")
              .where("l.kind", "=", "connector")
              .whereRef("l.template_id", "=", "t.template_id"),
          ),
        ),
      );
    if (orgId !== undefined) q = q.where("a.org_id", "=", orgId);
    if (itemId !== undefined) q = q.where("a.item_id", "=", itemId);
    return q.orderBy("a.org_id").orderBy("a.item_id").orderBy("t.template_id");
  }

  /**
   * Creates one connector in its own transaction under the org row lock: none for an org deleted
   * meanwhile, a template the org has had a connector from since, or one now off there.
   */
  @Transactional()
  private async createOne(m: Missing, via: string): Promise<boolean> {
    if ((await this.orgLock.tryLock(m.orgId)) === undefined) return false;
    const still = await this.missingQuery(m.orgId, m.itemId)
      .where("t.id", "=", m.platformTemplateId)
      .executeTakeFirst();
    if (still === undefined) return false;
    const on = await connectorTemplatesOn(this.db, m.orgId, m.itemId, [m.templateId]);
    if (!on.has(m.templateId)) return false;
    const id = await this.installer.createSwitchedOnTemplateConnectorIn(
      m.orgId,
      null,
      m.platformTemplateId,
      { auditDetail: { via } },
    );
    return id !== undefined;
  }
}
