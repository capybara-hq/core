import { randomBytes } from "node:crypto";
import type { DeviceHello, DeviceStopArgs, ExtensionContext } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { audit } from "../identity/audit.js";
import { sha256Hex } from "../identity/hash.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_BUS, KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DEVICE_PROVIDER } from "../sandbox/providers.js";
import { environmentNotFound } from "../sandbox/sandbox.service.js";
import { deviceRevokedTopic } from "./keys.js";
import { DeviceRelay } from "./relay.js";

/** The machine credential's prefix (`cap_dev_` plus 32 random bytes, base64url). */
export const MACHINE_CREDENTIAL_PREFIX = "cap_dev_";
const CREDENTIAL_RE = /^cap_dev_[A-Za-z0-9_-]{43}$/;

/** How long the `stop` frame told to a revoked machine may take (it only closes the connection). */
const STOP_DEADLINE_MS = 30_000;

/** What a machine credential stands for. */
export interface MachineIdentity {
  machineId: string;
  orgId: string;
  environmentId: string;
  accountId: string;
}

/** The machine connected to an environment (its unrevoked row). */
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
 * device environment: issuing a credential revokes the environment's previous machine. A
 * credential is `cap_dev_` plus 32 random bytes; only its sha256 is stored. It is accepted only
 * by the device connection route ({@link authenticate}), never by `/api`: it is no `Principal`.
 *
 * A revoked machine is told so after the commit: `stop { reason }` relayed while a replica holds
 * its connection (fire-and-forget, ruling R14) and `device.revoked.<environmentId>` published with
 * `{ machineId }`, so the holder closes that machine's connection.
 */
@Injectable()
export class MachinesService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(DeviceRelay) private readonly relay: Pick<DeviceRelay, "holderLive" | "send">,
    @Inject(KERNEL_BUS) private readonly bus: ExtensionContext["bus"],
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /**
   * A new machine for the environment and its credential (returned once). Revokes the
   * environment's active machine first. Joins the caller's transaction (the device confirmation),
   * which has already checked the environment is the person's own live device environment.
   */
  @Transactional()
  async issue(input: {
    orgId: string;
    environmentId: string;
    accountId: string;
    name: string;
    os: string;
    arch: string;
    programVersion: string;
  }): Promise<{ machineId: string; credential: string }> {
    // no stop frame: it would wait on the list and could reach the replacement machine instead
    await this.revokeActive(input.environmentId, null);
    await this.resetInstance(input.environmentId);
    const credential = MACHINE_CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
    const row = await this.db
      .insertInto("environment_machines")
      .values({
        org_id: input.orgId,
        environment_id: input.environmentId,
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
   * Ruling R23: the new machine may serve the environment from another directory or mode (other
   * roots), and a login recreates a directory that was lost (ruling R24). So the instance row
   * forgets its instance (status `none`, no handle) and its files count as there again; the next
   * use creates a fresh instance on the machine (with its roots: a new `environment_paths` event
   * follows). The fence moves on, so a lifecycle holder of the old instance fails its next write.
   * Lost files come back as an empty directory: the reset count moves on, so conversations that
   * used the old files are told their files were reset, not that they were kept.
   */
  private async resetInstance(environmentId: string): Promise<void> {
    await this.db
      .updateTable("environment_instances")
      .set((eb) => ({
        status: "none",
        handle: null,
        fs_status: sql<"none" | "ready">`CASE WHEN fs_handle IS NULL THEN 'none' ELSE 'ready' END`,
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        generation: eb("generation", "+", 1),
        fs_resets: sql<number>`CASE WHEN fs_status = 'lost' THEN fs_resets + 1 ELSE fs_resets END`,
      }))
      .where("environment_id", "=", environmentId)
      .execute();
  }

  /**
   * Who a machine credential stands for, or null: the machine is not revoked, its environment is
   * live, the org is not deleted (ruling R12), and the person is an active account still a member
   * of the org. Read live on every call (a connection re-checks it as it sees fit).
   */
  async authenticate(credential: string): Promise<MachineIdentity | null> {
    if (!CREDENTIAL_RE.test(credential)) return null;
    const row = await this.db
      .selectFrom("environment_machines as m")
      .innerJoin("environments as e", "e.id", "m.environment_id")
      .innerJoin("orgs as o", "o.id", "m.org_id")
      .innerJoin("memberships as ms", (j) =>
        j.onRef("ms.org_id", "=", "m.org_id").onRef("ms.account_id", "=", "m.account_id"),
      )
      .innerJoin("accounts as a", "a.id", "m.account_id")
      .select(["m.id", "m.org_id", "m.environment_id", "m.account_id"])
      .where("m.credential_hash", "=", sha256Hex(credential))
      .where("m.revoked_at", "is", null)
      .whereRef("e.org_id", "=", "m.org_id")
      .where("e.deleted_at", "is", null)
      .where("e.source", "=", "device")
      .where("o.deleted_at", "is", null)
      .where("a.status", "=", "active")
      .executeTakeFirst();
    return row
      ? {
          machineId: row.id,
          orgId: row.org_id,
          environmentId: row.environment_id,
          accountId: row.account_id,
        }
      : null;
  }

  /** Stores what the program reported in its hello frame and marks the machine seen. */
  async recordHello(machineId: string, hello: DeviceHello): Promise<void> {
    await this.db
      .updateTable("environment_machines")
      .set({
        program_version: hello.programVersion,
        os: hello.os,
        arch: hello.arch,
        mode: hello.mode,
        roots: JSON.stringify(hello.roots),
        session_isolation: hello.sessionIsolation,
        last_seen_at: sql<Date>`now()`,
      })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .execute();
  }

  /** Marks the machine seen (a ping); writes at most once every 60 seconds. */
  async touch(machineId: string): Promise<void> {
    await this.db
      .updateTable("environment_machines")
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
   * Disconnects the machine of one of the person's own live device environments (`DELETE
   * /orgs/:orgId/environments/:id/machine`): revokes it and audits
   * `environment.machine_revoked`. Anyone else's environment, a cloud one or a missing one →
   * `environment.not_found`; no machine connected is a no-op.
   */
  @Transactional()
  async revoke(
    orgId: string,
    accountId: string,
    environmentId: string,
    actorTokenId?: string,
  ): Promise<void> {
    const env = await this.db
      .selectFrom("environments")
      .select("id")
      .where("id", "=", environmentId)
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("source", "=", "device")
      .where("provider", "=", DEVICE_PROVIDER)
      .where("deleted_at", "is", null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!env) throw environmentNotFound();
    const machineId = await this.revokeActive(environmentId, "revoked");
    if (machineId === null) return;
    await audit(this.db.db, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "environment.machine_revoked",
      target: environmentId,
      detail: { machineId },
    });
  }

  /**
   * Revokes the environment's active machine, if any, in the caller's transaction, and after the
   * commit tells it to stop for `reason` (none: only its connection is closed) and closes its
   * connection. Returns the revoked machine's id. Used by {@link issue} (replaced: no stop),
   * {@link revoke} and the environment's deletion (`deleted`).
   */
  async revokeActive(
    environmentId: string,
    reason: DeviceStopArgs["reason"] | null,
  ): Promise<string | null> {
    const row = await this.db
      .updateTable("environment_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("environment_id", "=", environmentId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!row) return null;
    const machineId = row.id;
    afterCommit(() => this.disconnect(environmentId, machineId, reason));
    return machineId;
  }

  /**
   * Revokes one machine by id (a sign-in whose credential never reached the program), with the
   * same post-commit disconnect as a replacement (no stop frame). True when it was active.
   */
  async revokeMachine(machineId: string): Promise<boolean> {
    const row = await this.db
      .updateTable("environment_machines")
      .set({ revoked_at: sql<Date>`now()` })
      .where("id", "=", machineId)
      .where("revoked_at", "is", null)
      .returning("environment_id")
      .executeTakeFirst();
    if (!row) return false;
    const environmentId = row.environment_id;
    afterCommit(() => this.disconnect(environmentId, machineId, null));
    return true;
  }

  /** The environment's active machine, or null. */
  async activeFor(environmentId: string): Promise<ActiveMachine | null> {
    const r = await this.db
      .selectFrom("environment_machines")
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
      .where("environment_id", "=", environmentId)
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
    environmentId: string,
    machineId: string,
    reason: DeviceStopArgs["reason"] | null,
  ): Promise<void> {
    try {
      if (reason !== null && (await this.relay.holderLive(environmentId))) {
        await this.relay.send(environmentId, "stop", { reason }, STOP_DEADLINE_MS);
      }
    } catch (err) {
      this.log.warn("could not tell a revoked machine to stop", { environmentId, machineId, err });
    }
    try {
      await this.bus.publish(deviceRevokedTopic(environmentId), { machineId });
    } catch (err) {
      this.log.warn("could not publish a machine revocation", { environmentId, machineId, err });
    }
  }
}
