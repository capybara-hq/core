import type { RunLifecyclePayload } from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { deployedSnapshot } from "./deployed-snapshots.js";
import { isExtensionEnabled } from "./enabled.js";

/** Queue of lifecycle hook deliveries (no `:` in the name); also carries `run.lifecycle`. */
export const LIFECYCLE_QUEUE = "cap-kernel-lifecycle";
/** The job name of a `run.lifecycle` delivery (registered in `infra/outbox/registry.ts`). */
export const RUN_LIFECYCLE_JOB = "hook-run-lifecycle";

/** Job data of a `run.lifecycle` delivery (the lifecycle queue's job shape). */
export interface RunLifecycleJob {
  mount: "run.lifecycle";
  plugin: string;
  payload: RunLifecyclePayload;
}

type Phase = RunLifecyclePayload["phase"];

/**
 * Whether `plugin` is to be told about runs of `orgId`: its approved, deployed permission snapshot
 * declares `run.lifecycle` in `permissions.hooks`, and the org has it enabled.
 */
export async function subscribesToRunLifecycle(
  db: KernelSchemaDb,
  orgId: string,
  plugin: string,
): Promise<boolean> {
  const declared = await db
    .selectFrom("extension_permission_snapshots as s")
    .select("s.plugin")
    .where("s.plugin", "=", plugin)
    .where(sql<boolean>`s.permissions -> 'permissions' -> 'hooks' ? 'run.lifecycle'`)
    .where(deployedSnapshot)
    .limit(1)
    .executeTakeFirst();
  return declared !== undefined && (await isExtensionEnabled(db, orgId, plugin));
}

/** The deterministic job id of a delivery (no `:`; kernel ids carry none). */
export function runLifecycleJobId(parts: {
  id: string;
  phase: Phase;
  waitId?: string | undefined;
}): string {
  return [
    "hook-run-lifecycle",
    parts.id,
    parts.phase === "offer_declined" ? "declined" : parts.phase,
  ]
    .concat(parts.waitId === undefined ? [] : [parts.waitId])
    .join("-")
    .replaceAll(":", "-");
}

async function owe(
  outbox: Pick<OutboxService, "add">,
  plugin: string,
  payload: RunLifecyclePayload,
  jobId: string,
): Promise<void> {
  const data: RunLifecycleJob = { mount: "run.lifecycle", plugin, payload };
  await outbox.add({
    queue: LIFECYCLE_QUEUE,
    name: RUN_LIFECYCLE_JOB,
    jobId,
    data,
    orgId: payload.orgId,
  });
}

/**
 * Owes `run.lifecycle` for a run of a conversation with a subject, in the caller's transaction
 * (the one that changed the run: the outbox row commits or rolls back with it). Nothing when the
 * conversation has no subject, the run is unknown, or the subject's plugin does not subscribe.
 * Observe-only: the delivery never affects the run. `waitId` keeps each wait of one run apart.
 */
export async function oweRunLifecycleIn(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  a: {
    runId: string;
    phase: Exclude<Phase, "offer_declined">;
    waitingOn?: "approval" | "question" | "input";
    waitId?: string;
  },
): Promise<void> {
  const row = await db
    .selectFrom("runs")
    .innerJoin("conversations", "conversations.id", "runs.conversation_id")
    .select([
      "conversations.org_id",
      "conversations.id as conversation_id",
      "conversations.agent_id",
      "conversations.account_id",
      "conversations.subject",
      "runs.agent_version",
      "runs.trigger_account_id",
    ])
    .where("runs.id", "=", a.runId)
    .executeTakeFirst();
  const subject = row?.subject;
  if (!row || !subject) return;
  if (!(await subscribesToRunLifecycle(db, row.org_id, subject.source))) return;
  const payload: RunLifecyclePayload = {
    orgId: row.org_id,
    accountId: row.trigger_account_id ?? row.account_id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    conversationId: row.conversation_id,
    runId: a.runId,
    phase: a.phase,
    subject: { kind: subject.kind, id: subject.id },
    ...(a.waitingOn !== undefined && { waitingOn: a.waitingOn }),
  };
  await owe(
    outbox,
    subject.source,
    payload,
    runLifecycleJobId({ id: a.runId, phase: a.phase, waitId: a.waitId }),
  );
}

/**
 * Owes `run.lifecycle` `offer_declined` to `plugin` (the plugin that emitted the directed event
 * `eventId`), in the caller's transaction. Nothing when the plugin does not subscribe in the org.
 */
export async function oweOfferDeclinedIn(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  a: {
    orgId: string;
    plugin: string;
    eventId: string;
    accountId: string;
    agentId: string;
    subject: { kind: string; id: string };
    reason: "declined" | "off" | "paused";
  },
): Promise<void> {
  if (!(await subscribesToRunLifecycle(db, a.orgId, a.plugin))) return;
  await owe(
    outbox,
    a.plugin,
    {
      orgId: a.orgId,
      accountId: a.accountId,
      agentId: a.agentId,
      phase: "offer_declined",
      subject: { kind: a.subject.kind, id: a.subject.id },
      reason: a.reason,
    },
    runLifecycleJobId({ id: a.eventId, phase: "offer_declined" }),
  );
}
