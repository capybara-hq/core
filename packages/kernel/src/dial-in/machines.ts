import { randomBytes } from "node:crypto";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { isDeviceBootId } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { sha256Hex } from "../identity/hash.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { PermissionCeilingWrites } from "../sandbox/permission-ceiling-writes.js";
import { deviceRevokedTopic } from "./keys.js";
import { DialInRelay } from "./relay.js";

/** The machine credential's prefix (`cap_dev_` plus 32 random bytes, base64url). */
export const MACHINE_CREDENTIAL_PREFIX = "cap_dev_";
const CREDENTIAL_RE = /^cap_dev_[A-Za-z0-9_-]{43}$/;

/**
 * Why a machine was revoked, for the machine and for the provider (`onClose`): `revoked`
 * (signed out, or a sign-in whose credential never reached its program) or `deleted`
 * (its device was deleted), both told to stop first; `replaced` (the device signed in from
 * another machine): no stop, which could reach the replacement instead, and its connection
 * closes as replaced (4002).
 */
export type MachineRevocationReason = "revoked" | "deleted" | "replaced";

/** The payload of `device.revoked.<deviceId>`. */
export interface MachineRevokedMessage {
  machineId: string;
  reason: MachineRevocationReason;
}

/** What a machine credential stands for. */
export interface MachineIdentity {
  machineId: string;
  orgId: string;
  deviceId: string;
  accountId: string;
}

/** The machine connected to a device (its unrevoked row). */
export interface ActiveMachine {
  id: string;
  orgId: string;
  accountId: string;
  name: string;
  os: string;
  arch: string;
  programVersion: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
}

/**
 * Connected machines and their credentials (environments spec §13.2). One active machine per
 * dial-in device: issuing a credential revokes the device's previous machine. A
 * credential is `cap_dev_` plus 32 random bytes; only its sha256 is stored. It is accepted only
 * by the device connection route ({@link authenticate}), never by `/api`: it is no `Principal`.
 *
 * A revoked machine is told so after the commit: a `stop` relayed while a replica holds its
 * connection (fire-and-forget, ruling R14) and `device.revoked.<deviceId>` published with
 * {@link MachineRevokedMessage}, so the holder closes that machine's connection (and tells the
 * provider why).
 */
@Injectable()
export class DialInMachines {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(DialInRelay) private readonly relay: Pick<DialInRelay, "stop">,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Inject(PermissionCeilingWrites) private readonly ceilings: PermissionCeilingWrites,
  ) {}

  /**
   * A new machine for the device and its credential (returned once). Revokes the
   * device's active machine first. Joins the caller's transaction (the device confirmation),
   * which has already checked the device is the person's own live dial-in device.
   */
  @Transactional()
  async issue(input: {
    orgId: string;
    deviceId: string;
    accountId: string;
    name: string;
    os: string;
    arch: string;
    programVersion: string;
  }): Promise<{ machineId: string; credential: string }> {
    // the machine the device was last served from (revoked or not)
    const prev = await this.db
      .selectFrom("device_machines")
      .select(["name", "os", "arch"])
      .where("device_id", "=", input.deviceId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    // another machine has other files (maintainer decision 2026-11-08)
    const moved = prev !== undefined && !sameMachine(prev, input);
    // no stop frame: it would wait on the list and could reach the replacement machine instead
    await this.revokeActive(input.deviceId, "replaced");
    await this.resetInstance(input.deviceId, moved);
    const credential = MACHINE_CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
    const row = await this.db
      .insertInto("device_machines")
      .values({
        org_id: input.orgId,
        device_id: input.deviceId,
        account_id: input.accountId,
        credential_hash: sha256Hex(credential),
        name: input.name,
        os: input.os,
        arch: input.arch,
        program_version: input.programVersion,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { machineId: row.id, credential };
  }

  /**
   * Ruling R23: the new machine may serve the device from another directory or mode (other
   * roots), and a login recreates a directory that was lost (ruling R24). So the instance row
   * forgets its instance (status `none`, no handle) and its files count as there again; the next
   * use creates a fresh instance on the machine (with its roots: a new `device_paths` event
   * follows). The fence moves on, so a lifecycle holder of the old instance fails its next write.
   * The reset count (`fs_resets`) moves on when the files the next instance sees are not the old
   * ones, so conversations that used the old files are told their files were reset, not that they
   * were kept: lost files come back as an empty directory, and another machine (`moved`: name, OS
   * or arch differ from the device's previous machine) has other files. Another directory on
   * the same machine is known only to the provider (from the new machine's first hello).
   */
  private async resetInstance(deviceId: string, moved: boolean): Promise<void> {
    await this.db
      .updateTable("device_instances")
      .set((eb) => ({
        status: "none",
        handle: null,
        fs_status: sql<"none" | "ready">`CASE WHEN fs_handle IS NULL THEN 'none' ELSE 'ready' END`,
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        generation: eb("generation", "+", 1),
        fs_resets: moved
          ? sql<number>`fs_resets + 1`
          : sql<number>`CASE WHEN fs_status = 'lost' THEN fs_resets + 1 ELSE fs_resets END`,
      }))
      .where("device_id", "=", deviceId)
      .execute();
  }

  /**
   * Who a machine credential stands for, or null: the machine is not revoked, its device is
   * live, the org is not deleted (ruling R12), and the person is an active account still a member
   * of the org. Read live on every call (a connection re-checks it as it sees fit). Whether the
   * device's provider takes its machines now (it declares the dial-in channel and is on in the
   * org) is the connection's next check (`DialInHandlers.forDevice`).
   */
  async authenticate(credential: string): Promise<MachineIdentity | null> {
    if (!CREDENTIAL_RE.test(credential)) return null;
    const row = await this.db
      .selectFrom("device_machines as m")
      .innerJoin("devices as e", "e.id", "m.device_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .innerJoin("memberships as ms", (j) =>
        j.onRef("ms.org_id", "=", "m.org_id").onRef("ms.account_id", "=", "m.account_id"),
      )
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .select(["m.id", "m.org_id", "m.device_id", "m.account_id"])
      .where("m.credential_hash", "=", sha256Hex(credential))
      .where("m.revoked_at", "is", null)
      .whereRef("e.org_id", "=", "m.org_id")
      .where("e.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .where("a.status", "=", "active")
      .executeTakeFirst();
    return row
      ? {
          machineId: row.id,
          orgId: row.org_id,
          deviceId: row.device_id,
          accountId: row.account_id,
        }
      : null;
  }

  /** Whether the device is deleted (soft-deleted, or gone): why its credential stopped working. */
  async isDeviceDeleted(deviceId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("devices")
      .select("deleted_at")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    return row === undefined || row.deleted_at !== null;
  }

  /**
   * What a machine's hello envelope says about its program, recorded once the connection holds the
   * device's lease (before the provider's `onHello`): its version, OS and architecture, and the
   * host's boot identity (none clears the stored one). Marks the machine seen. A revoked machine
   * is left alone.
   */
  @Transactional()
  async recordConnect(
    machineId: string,
    program: { version: string; os: string; arch: string; bootId?: string },
  ): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({
        program_version: program.version,
        os: program.os,
        arch: program.arch,
        boot_id:
          program.bootId !== undefined && isDeviceBootId(program.bootId) ? program.bootId : null,
        last_seen_at: sql<Date>`now()`,
      })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** Marks the machine seen (a ping); writes at most once every 60 seconds. */
  async touch(machineId: string): Promise<void> {
    await this.db
      .updateTable("device_machines")
      .set({ last_seen_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("last_seen_at", "is", null),
          eb("last_seen_at", "<", sql<Date>`now() - interval '60 seconds'`),
        ]),
      )
      .execute();
  }

  /**
   * Revokes the device's active machine, if any, in the caller's transaction, and after the
   * commit tells it to stop (not when `replaced`) and closes its connection for `reason`. Returns
   * the revoked machine's id. Used by {@link issue} (`replaced`) and the device's deletion
   * (`deleted`).
   */
  @Transactional()
  async revokeActive(deviceId: string, reason: MachineRevocationReason): Promise<string | null> {
    const device = await this.db
      .selectFrom("devices")
      .select("org_id")
      .where("id", "=", deviceId)
      .executeTakeFirstOrThrow();
    await this.ceilings.lock({ orgId: device.org_id, deviceId }, "device");
    await this.ceilings.publishLocked({ orgId: device.org_id, deviceId }, "device", true, true);
    const row = await this.db
      .updateTable("device_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return null;
    const machineId = row.id;
    afterCommit(() => this.disconnect(deviceId, machineId, reason));
    return machineId;
  }

  /**
   * Revokes one machine by id (a sign-in whose credential never reached the program), with the
   * same post-commit disconnect as a replacement (no stop frame). True when it was active.
   */
  @Transactional()
  async revokeMachine(machineId: string): Promise<boolean> {
    const machine = await this.db
      .selectFrom("device_machines")
      .select(["org_id", "device_id"])
      .where("id", "=", machineId)
      .executeTakeFirst();
    if (!machine) return false;
    await this.ceilings.lock({ orgId: machine.org_id, deviceId: machine.device_id }, "device");
    await this.ceilings.publishLocked(
      { orgId: machine.org_id, deviceId: machine.device_id },
      "device",
      true,
      true,
    );
    const row = await this.db
      .updateTable("device_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .returning("device_id")
      .executeTakeFirst();
    if (!row) return false;
    const deviceId = row.device_id;
    afterCommit(() => this.disconnect(deviceId, machineId, "revoked", { stop: false }));
    return true;
  }

  /** The device's active machine, or null. */
  async activeFor(deviceId: string): Promise<ActiveMachine | null> {
    const r = await this.db
      .selectFrom("device_machines")
      .select([
        "id",
        "org_id",
        "account_id",
        "name",
        "os",
        "arch",
        "program_version",
        "last_seen_at",
        "created_at",
      ])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return r
      ? {
          id: r.id,
          orgId: r.org_id,
          accountId: r.account_id,
          name: r.name,
          os: r.os,
          arch: r.arch,
          programVersion: r.program_version,
          lastSeenAt: r.last_seen_at,
          createdAt: r.created_at,
        }
      : null;
  }

  /**
   * After a revocation commits: `stop` is queued only while a replica holds the connection (an
   * offline machine must not find it on the list later), then the revocation is published.
   * Failures are logged; the revocation itself stands.
   */
  private async disconnect(
    deviceId: string,
    machineId: string,
    reason: MachineRevocationReason,
    opts: { stop?: boolean } = {},
  ): Promise<void> {
    try {
      // fenced to this machine; queued only while a replica holds its connection
      if (reason !== "replaced" && opts.stop !== false)
        await this.relay.stop(deviceId, "stop", { machineId });
    } catch (err) {
      this.log.warn("could not tell a revoked machine to stop", { deviceId, machineId, err });
    }
    try {
      const message: MachineRevokedMessage = { machineId, reason };
      await this.bus.publish(deviceRevokedTopic(deviceId), message);
    } catch (err) {
      this.log.warn("could not publish a machine revocation", { deviceId, machineId, err });
    }
  }
}

/** Two machine rows (or a login) name the same machine: same name, OS and arch. */
export function sameMachine(
  a: { name: string; os: string; arch: string },
  b: { name: string; os: string; arch: string },
): boolean {
  return a.name === b.name && a.os === b.os && a.arch === b.arch;
}
