import {
  DeviceAccessError,
  LOOPBACK_DATABASE_PORTS,
  LOOPBACK_MAX_PORTS_PER_SERVICE,
  type LoopbackGrantSource,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";
import { type Selectable, sql } from "kysely";
import type { DeviceLoopbackGrantsTable, KernelSchemaDb } from "../db/kernel-schema.js";
import { audit } from "../identity/audit.js";
import { asPlatform } from "../infra/database/org-scope.js";
import type { OutboxService } from "../infra/outbox/outbox.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import type { DeviceSandbox } from "./device-sandbox.js";

/**
 * Loopback port grants (browser loopback port grants design §4, §6): one device service of a
 * person's own device may reach one loopback port of that device for one conversation tree. The
 * records in `device_loopback_grants` are the live set; every change to it (a grant, a revoke, an
 * expiry, a conversation's deletion, a narrowing ceiling) owes a `device-loopback-refresh` job per
 * affected (device, service), which sends the whole live set to an `ifRunning` ensure of the
 * service. A ceiling narrows by revocation: the refresh job revokes (`outside-sandbox-off`) when
 * the device refuses loopback grants now.
 */

/** A grant's lifetime from issue. */
export const LOOPBACK_GRANT_TTL_HOURS = 24;

/** The refresh of one (device, service)'s live set (outbox job on the maintenance queue). */
export const LOOPBACK_REFRESH_JOB = "device-loopback-refresh";

/** The data of {@link LOOPBACK_REFRESH_JOB}: `orgId` gives the job its org scope (`runJob`). */
export interface LoopbackRefreshJobData {
  orgId: string;
  deviceId: string;
  serviceId: string;
  /** The change that owed it (the job id's last part), so a follow-up names its own id. */
  change?: string;
  /** The follow-up number after failed sends (absent for the first job). */
  followUp?: number;
}

/**
 * The most follow-ups one change owes after failed sends, about a day at
 * {@link LOOPBACK_FOLLOW_UP_MAX_DELAY_MS}: a device the kernel records as running keeps getting
 * the live set until one send lands, so a narrowing never stays on the machine because a send
 * failed.
 */
export const LOOPBACK_MAX_FOLLOW_UPS = 300;
/** The first follow-up's delay; it doubles up to {@link LOOPBACK_FOLLOW_UP_MAX_DELAY_MS}. */
export const LOOPBACK_FOLLOW_UP_DELAY_MS = 30_000;
export const LOOPBACK_FOLLOW_UP_MAX_DELAY_MS = 300_000;

/**
 * Owes the follow-up of a refresh whose send failed (`-t<n>` after its change), delayed with a
 * doubling backoff; false past {@link LOOPBACK_MAX_FOLLOW_UPS}.
 */
export async function oweLoopbackFollowUp(
  outbox: Pick<OutboxService, "add">,
  data: LoopbackRefreshJobData,
): Promise<boolean> {
  const n = (data.followUp ?? 0) + 1;
  if (n > LOOPBACK_MAX_FOLLOW_UPS) return false;
  const change = data.change ?? "x";
  const delay = Math.min(
    LOOPBACK_FOLLOW_UP_DELAY_MS * 2 ** (n - 1),
    LOOPBACK_FOLLOW_UP_MAX_DELAY_MS,
  );
  const next: LoopbackRefreshJobData = {
    orgId: data.orgId,
    deviceId: data.deviceId,
    serviceId: data.serviceId,
    change,
    followUp: n,
  };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: LOOPBACK_REFRESH_JOB,
    jobId: loopbackRefreshJobId(data.deviceId, data.serviceId, `${change}-t${n}`),
    data: next,
    runAt: new Date(Date.now() + delay),
    orgId: data.orgId,
  });
  return true;
}

/**
 * The deterministic job id of a refresh (no `:`). `change` names what owed it: `g<grantId>` (a
 * grant), `r<grantId>` (a revoke, an expiry or a deletion), `c<level>-<subjectId>-<epoch>` (a
 * ceiling publication, the epoch after its bump).
 */
export const loopbackRefreshJobId = (deviceId: string, serviceId: string, change: string): string =>
  `dlr-${deviceId}-${serviceId}-${change}`;

/** The budget of one refresh job's device calls. */
export const LOOPBACK_REFRESH_TIMEOUT_MS = 30_000;

/** What names one grant: the root conversation holds it, sub-agents use their root's. */
export interface LoopbackGrantKey {
  orgId: string;
  deviceId: string;
  /** `<extension>.<name>`. */
  serviceId: string;
  rootConversationId: string;
  port: number;
}

/** One grant record as the kernel's callers read it. */
export interface LoopbackGrantRow {
  id: string;
  port: number;
  source: LoopbackGrantSource;
  /** ISO 8601. */
  expiresAt: string;
  runId: string | null;
  callId: string | null;
  attempt: number | null;
}

/** Why a grant ended (`device_loopback_grants.revoke_reason`). */
export type LoopbackRevokeReason =
  | "revoked"
  | "expired"
  | "conversation-deleted"
  | "outside-sandbox-off";

/** A grant past {@link LOOPBACK_MAX_PORTS_PER_SERVICE} live ports of one (device, service). */
export class LoopbackLimitError extends DeviceAccessError {
  constructor() {
    super(
      "loopback_limit",
      `This device service already has ${LOOPBACK_MAX_PORTS_PER_SERVICE} local ports open; revoke one in the browser panel before granting another.`,
    );
    this.name = "LoopbackLimitError";
  }
}

/**
 * Why a loopback grant is refused on this device now, in the note's words; null when grantable.
 * `escalationRefusal` is why a call could not run outside the sandbox here (the ceiling, an
 * unattended run), null or undefined when it could.
 */
export function loopbackRefusal(
  box: DeviceSandbox,
  support: SandboxPermissionSupport | null,
  escalationRefusal: string | null | undefined,
): string | null {
  if (escalationRefusal !== null && escalationRefusal !== undefined)
    return `running outside the sandbox is not possible here (${escalationRefusal})`;
  if (
    support?.network.loopbackPorts !== true &&
    support?.limitedBy?.loopbackPorts === "device-update"
  )
    return "capybara-device on this device is too old; update capybara-device to let the browser reach local ports";
  if (support?.network.loopbackPorts !== true || !box.loopbackPorts)
    return "this device's provider cannot open a local port to a device service";
  return null;
}

export const rowOf = (r: Selectable<DeviceLoopbackGrantsTable>): LoopbackGrantRow => ({
  id: r.id,
  port: r.port,
  source: r.source as LoopbackGrantSource,
  expiresAt: new Date(r.expires_at).toISOString(),
  runId: r.run_id,
  callId: r.call_id,
  attempt: r.attempt,
});

export const isDatabasePort = (port: number): boolean =>
  (LOOPBACK_DATABASE_PORTS as readonly number[]).includes(port);

/** Owes the refresh of one (device, service). */
export async function oweRefresh(
  outbox: Pick<OutboxService, "add">,
  target: LoopbackRefreshJobData,
  change: string,
): Promise<void> {
  const data: LoopbackRefreshJobData = {
    orgId: target.orgId,
    deviceId: target.deviceId,
    serviceId: target.serviceId,
    change,
  };
  await outbox.add({
    queue: MAINTENANCE_QUEUE_NAME,
    name: LOOPBACK_REFRESH_JOB,
    jobId: loopbackRefreshJobId(target.deviceId, target.serviceId, change),
    data,
    orgId: target.orgId,
  });
}

/**
 * Owes one refresh per (device, service) with live grants under the subject, in the caller's
 * transaction (a ceiling publication, `PermissionCeilingWrites.publishLocked`): every org at the
 * platform level, the org's, the device's, or the root conversation's grants. Returns how many it
 * owed. The job decides whether the ceiling now refuses and revokes then.
 */
export async function oweLoopbackRefreshes(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  under: {
    level: "platform" | "org" | "device" | "root";
    orgId?: string;
    deviceId?: string;
    rootConversationId?: string;
  },
  change: string,
): Promise<number> {
  const need = (v: string | undefined): string => {
    if (!v) throw new Error(`A ${under.level} loopback refresh needs its subject`);
    return v;
  };
  const rows =
    under.level === "platform"
      ? await asPlatform("platform ceiling publication: loopback grants of every org", () => {
          // org-filter: deployment-wide platform-level writer under the exclusive platform lock:
          // the live grants it may narrow lie in every org; each refresh runs in its own org
          return db
            .selectFrom("device_loopback_grants")
            .select(["org_id", "device_id", "service_id"])
            .distinct()
            .where("revoked_at", "is", null)
            .orderBy("org_id")
            .orderBy("device_id")
            .orderBy("service_id")
            .execute();
        })
      : await db
          .selectFrom("device_loopback_grants")
          .select(["org_id", "device_id", "service_id"])
          .distinct()
          .where("org_id", "=", need(under.orgId))
          .where("revoked_at", "is", null)
          .$if(under.level === "device", (q) => q.where("device_id", "=", need(under.deviceId)))
          .$if(under.level === "root", (q) =>
            q.where("conversation_id", "=", need(under.rootConversationId)),
          )
          .orderBy("device_id")
          .orderBy("service_id")
          .execute();
  for (const r of rows)
    await oweRefresh(
      outbox,
      { orgId: r.org_id, deviceId: r.device_id, serviceId: r.service_id },
      change,
    );
  return rows.length;
}

/**
 * Revokes a deleted device's live grants (reason `revoked`, audited with `cause: "device-deleted"`)
 * and owes their refreshes, in the caller's transaction (the device's deletion or its owner's
 * offboarding).
 */
export async function revokeLoopbackGrantsOfDevice(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  target: { orgId: string; deviceId: string },
): Promise<void> {
  const rows = await db
    .updateTable("device_loopback_grants")
    .set({ revoked_at: sql<Date>`now()`, revoke_reason: "revoked" })
    .where("org_id", "=", target.orgId)
    .where("device_id", "=", target.deviceId)
    .where("revoked_at", "is", null)
    .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
    .execute();
  await endedGrants(db, outbox, rows, "revoked", null, "device-deleted");
}

/**
 * Revokes a deleted root's live grants (reason `conversation-deleted`, audited) and owes their
 * refreshes, in the caller's transaction (the conversation's deletion). A sub-agent's
 * conversation holds no grant, so its id finds none.
 */
export async function revokeLoopbackGrantsOfConversation(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  target: { orgId: string; rootConversationId: string },
): Promise<void> {
  const rows = await db
    .updateTable("device_loopback_grants")
    .set({ revoked_at: sql<Date>`now()`, revoke_reason: "conversation-deleted" })
    .where("org_id", "=", target.orgId)
    .where("conversation_id", "=", target.rootConversationId)
    .where("revoked_at", "is", null)
    .returning(["id", "org_id", "device_id", "service_id", "conversation_id", "port"])
    .execute();
  await endedGrants(db, outbox, rows, "conversation-deleted", null);
}

/**
 * Audits ended grants (`device.loopback_revoked`) and owes one refresh per (device, service),
 * named by its first grant.
 */
export async function endedGrants(
  db: KernelSchemaDb,
  outbox: Pick<OutboxService, "add">,
  rows: readonly {
    id: string;
    org_id: string;
    device_id: string;
    service_id: string;
    conversation_id: string;
    port: number;
  }[],
  reason: LoopbackRevokeReason,
  actorAccountId: string | null,
  /** What ended them when the reason alone does not say (`device-deleted`, `provider-support`). */
  cause?: string,
): Promise<void> {
  const owed = new Map<string, { target: LoopbackRefreshJobData; grantId: string }>();
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    await audit(db, {
      actorAccountId,
      orgId: r.org_id,
      action: "device.loopback_revoked",
      target: r.device_id,
      detail: {
        grantId: r.id,
        deviceId: r.device_id,
        serviceId: r.service_id,
        conversationId: r.conversation_id,
        port: r.port,
        reason,
        ...(cause !== undefined && { cause }),
      },
    });
    const key = `${r.device_id}\n${r.service_id}`;
    if (!owed.has(key))
      owed.set(key, {
        target: { orgId: r.org_id, deviceId: r.device_id, serviceId: r.service_id },
        grantId: r.id,
      });
  }
  for (const { target, grantId } of owed.values()) await oweRefresh(outbox, target, `r${grantId}`);
}
