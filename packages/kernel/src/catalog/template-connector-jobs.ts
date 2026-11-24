// The template connector jobs' queue, name, id, data and producer: a leaf module (type imports
// only), so the installer (`markInstalled`) and the org extension switch (`OrgExtensionConfigs`,
// below the catalog) owe them without the consumer, and the health overview counts the queue.

import { Module } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";

/**
 * The queue of template connector ensures (ruling R27): after an install commits or an org
 * switches an extension on, the org's missing template connectors are created by a worker, since
 * the connector extension may load on the replica only after the commit.
 */
export const TEMPLATE_CONNECTORS_QUEUE = "cap-template-connectors";

/** Creates the org's template connectors it never had (`TemplateConnectorEnsurer`). */
export const TEMPLATE_CONNECTORS_JOB = "template-connectors-ensure";

/** Data of a {@link TEMPLATE_CONNECTORS_JOB}. */
export interface TemplateConnectorsJobData {
  orgId: string;
}

/**
 * `ensure-<orgId>-<xact>`: `xact` is the owing transaction's id, so two owings in one transaction
 * are one job and a later transaction's job is never swallowed by an earlier one. Org ids are
 * UUIDs: the id has no `:`.
 */
export const templateConnectorsJobId = (orgId: string, xact: string): string =>
  `ensure-${orgId}-${xact}`;

/** Owes the org's template connector ensure in the transaction in context. */
export async function oweTemplateConnectors(
  outbox: Pick<OutboxService, "add">,
  db: KernelSchemaDb,
  orgId: string,
): Promise<void> {
  const r = await sql<{ xact: string }>`SELECT pg_current_xact_id()::text AS xact`.execute(db);
  const xact = r.rows[0]?.xact;
  if (xact === undefined) throw new Error("no transaction id");
  await outbox.add<TemplateConnectorsJobData>({
    queue: TEMPLATE_CONNECTORS_QUEUE,
    name: TEMPLATE_CONNECTORS_JOB,
    jobId: templateConnectorsJobId(orgId, xact),
    data: { orgId },
    orgId,
  });
}

const TEMPLATE_CONNECTORS_QUEUE_REGISTRATION = QueueModule.registerQueue(TEMPLATE_CONNECTORS_QUEUE);

/**
 * The template connectors queue, registered once and shared: imported by the catalog module (the
 * outbox dispatcher adds the owed jobs through it) and by the admin module (the health overview).
 */
@Module({
  imports: [TEMPLATE_CONNECTORS_QUEUE_REGISTRATION],
  exports: [TEMPLATE_CONNECTORS_QUEUE_REGISTRATION],
})
export class TemplateConnectorsQueueModule {}
