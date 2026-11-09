import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import type { ReportBodyInput } from "./client.schemas.js";
import { ClientAccess } from "./client-access.service.js";

/** Reports older than this (by `last_at`) are deleted by the daily prune (spec §10.4). */
export const REPORT_RETENTION_DAYS = 30;

/**
 * Crash and load reports of client code (client extensions spec §10.4): one row per (plugin,
 * build, org, contribution, kind), upserted so a crash loop is one row with a count. A report is
 * accepted only for a build the reporter could fetch ({@link ClientAccess.canFetch}) and, in an
 * org, an extension enabled there, so nobody writes rows about plugins or orgs they cannot see;
 * anything else is the same 404 `client.not_found` the delivery route answers.
 */
@Injectable()
export class ClientReports {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ClientAccess) private readonly access: ClientAccess,
  ) {}

  /** A report from a workspace page of org `orgId`. */
  async recordForOrg(accountId: string, orgId: string, body: ReportBodyInput): Promise<void> {
    const enabled = await this.db.db
      .selectFrom(enabledExtensionsQuery(this.db.db, orgId).as("en"))
      .select("en.plugin")
      .where("en.plugin", "=", body.plugin)
      .executeTakeFirst();
    if (enabled === undefined) throw notFound();
    if (!(await this.access.canFetch(accountId, false, body.plugin, body.build))) throw notFound();
    await this.upsert(orgId, body);
  }

  /** A report from the admin console (no org; super admins only, the caller checks that). */
  async recordForAdmin(accountId: string, body: ReportBodyInput): Promise<void> {
    if (!(await this.access.canFetch(accountId, true, body.plugin, body.build))) throw notFound();
    await this.upsert(null, body);
  }

  @Transactional()
  private async upsert(orgId: string | null, b: ReportBodyInput): Promise<void> {
    await this.db.db
      .insertInto("extension_client_reports")
      .values({
        plugin: b.plugin,
        build: b.build,
        org_id: orgId,
        contribution: b.contribution,
        kind: b.kind,
        last_message: b.message,
      })
      .onConflict((oc) =>
        oc
          .expression(
            sql`plugin, build, (coalesce(org_id, '')), (coalesce(contribution, '')), kind`,
          )
          .doUpdateSet({
            count: sql`extension_client_reports.count + 1`,
            last_at: sql`now()`,
            last_message: b.message,
          }),
      )
      .execute();
  }

  /** Deletes the reports last seen more than {@link REPORT_RETENTION_DAYS} days ago; the count. */
  async prune(): Promise<number> {
    const r = await this.db.db
      .deleteFrom("extension_client_reports")
      .where("last_at", "<", sql<Date>`now() - make_interval(days => ${REPORT_RETENTION_DAYS})`)
      .executeTakeFirst();
    return Number(r.numDeletedRows);
  }
}

const notFound = () => new ApiError("client.not_found", "Client file not found");
