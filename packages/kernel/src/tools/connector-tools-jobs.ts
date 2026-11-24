// The connector tool list jobs' queue, names, ids and data: no service imports, read by
// ConnectorsService (the producer, through the outbox), ConnectorToolsProcessor (the consumer) and
// the health overview (which counts the queue).

import { Module } from "@nestjs/common";
import { QueueModule } from "../infra/queue/queue.module.js";

/**
 * The queue of connector tool listings that follow a write (plugin pages spec §5.2.1): the
 * listing is an outbound call, so it never runs inside the transaction that owes it.
 */
export const CONNECTOR_TOOLS_QUEUE = "cap-connector-tools";

/** Lists a connector's tools and stores them through the refresh path's compare-and-write. */
export const CONNECTOR_TOOLS_JOB = "connector-tools-list";

/**
 * What owed the listing: the connector was `created` ready, it turned ready when an org admin
 * saved its missing input (`configured`), or a member saved the first credential of a personal
 * connector with no tool list yet (`connected`).
 */
export type ConnectorToolsTrigger = "created" | "configured" | "connected";

/** Data of a {@link CONNECTOR_TOOLS_JOB}; `accountId` is the member whose credential lists. */
export interface ConnectorToolsJobData {
  orgId: string;
  connectorId: string;
  accountId?: string;
}

/**
 * `connector-tools-<connectorId>-<trigger>[-<accountId>]-<seq>`: `seq` is the owing transaction's
 * start time in milliseconds (`now()` in PG), so each owing has its own id and the same owing is
 * one job; a `connected` owing names the member, so two members connecting in the same
 * millisecond owe two jobs (one id with different data would be refused). Connector and account
 * ids are UUIDs: the id has no `:`.
 */
export const connectorToolsJobId = (
  connectorId: string,
  trigger: ConnectorToolsTrigger,
  seq: string,
  accountId?: string,
): string =>
  `connector-tools-${connectorId}-${trigger}${accountId === undefined ? "" : `-${accountId}`}-${seq}`;

const CONNECTOR_TOOLS_QUEUE_REGISTRATION = QueueModule.registerQueue(CONNECTOR_TOOLS_QUEUE);

/**
 * The connector tools queue, registered once and shared: imported by `ToolsModule` (every role
 * owes the jobs) and by the admin module (the health overview counts it).
 */
@Module({
  imports: [CONNECTOR_TOOLS_QUEUE_REGISTRATION],
  exports: [CONNECTOR_TOOLS_QUEUE_REGISTRATION],
})
export class ConnectorToolsQueueModule {}
