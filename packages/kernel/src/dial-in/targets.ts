import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { REDIS } from "../infra/tokens.js";
import { deviceLeaseKey, deviceTransportKey } from "./keys.js";

/**
 * Whether a local device can still be served: `active` (live and an unrevoked machine),
 * `revoked` (live, no active machine: disconnected or signed out) or `deleted` (missing or
 * deleted, or its org deleted).
 */
export type DeviceTargetState = "active" | "revoked" | "deleted";

/** A machine connection as {@link DeviceTargets.current} reads it. */
export interface DeviceConnectionInfo {
  connectionId: string;
  maxFrameBytes: number;
  programRunId?: string;
}

/**
 * Reads a dial-in device and its machine connection (PG and Redis) for the relay.
 * The relay asks {@link state} when a machine has no connection, so a revoked machine or a deleted
 * device fails a waiting call at once instead of after the reconnect grace (ruling R27).
 * Kept apart from `DialInMachines` (which depends on the relay) so there is no dependency cycle.
 */
@Injectable()
export class DeviceTargets {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LockService) private readonly locks: Pick<LockService, "holderOf">,
  ) {}

  /**
   * The negotiated transport of the machine's current connection, read only under its exact
   * authenticated gateway lease (never current config): the random connection id the gateway sent
   * in `ready` and the effective frame capacity. Null when no replica holds the machine's
   * connection, so the caller maps that through the device's state (deleted, revoked, offline);
   * throws while the holder has not published its capacity yet.
   */
  async transport(
    deviceId: string,
  ): Promise<{ connectionId: string; maxFrameBytes: number } | null> {
    const current = await this.current(deviceId);
    if (!current) return null;
    const { connectionId, maxFrameBytes } = current;
    return { connectionId, maxFrameBytes };
  }

  /**
   * {@link transport} plus the program run the connection's hello named (`programRunId`, absent
   * for a program that does not report one): the relay's evidence that the machine's program
   * restarted since it sent a request. Never part of a frame.
   */
  async current(deviceId: string): Promise<DeviceConnectionInfo | null> {
    const lease = await this.locks.holderOf(deviceLeaseKey(deviceId));
    if (!lease) return null;
    const raw = await this.redis.get(deviceTransportKey(deviceId, lease));
    const cap = raw === null ? null : (JSON.parse(raw) as unknown);
    const ok =
      cap !== null &&
      typeof cap === "object" &&
      typeof (cap as { connectionId?: unknown }).connectionId === "string" &&
      (cap as { connectionId: string }).connectionId !== "" &&
      Number.isSafeInteger((cap as { maxFrameBytes?: unknown }).maxFrameBytes) &&
      (cap as { maxFrameBytes: number }).maxFrameBytes >= 1024;
    if (!ok || (await this.locks.holderOf(deviceLeaseKey(deviceId))) !== lease)
      throw new Error(
        "The machine's connection is not ready yet; retry once capybara-device has reconnected",
      );
    const { connectionId, maxFrameBytes, programRunId } = cap as {
      connectionId: string;
      maxFrameBytes: number;
      programRunId?: unknown;
    };
    return {
      connectionId,
      maxFrameBytes,
      ...(typeof programRunId === "string" && programRunId !== "" && { programRunId }),
    };
  }

  async state(deviceId: string): Promise<DeviceTargetState> {
    const row = await this.db
      .selectFrom("devices as e")
      .innerJoin("orgs as o", "o.id", "e.org_id")
      .leftJoin("device_machines as m", (j) =>
        j.onRef("m.device_id", "=", "e.id").on("m.revoked_at", "is", null),
      )
      .select(["e.id", "m.id as machine_id"])
      .where("e.id", "=", deviceId)
      .where("e.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) return "deleted";
    return row.machine_id === null ? "revoked" : "active";
  }

  /** The org of a live device, or null (missing or deleted). */
  async orgOf(deviceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("devices")
      .select("org_id")
      .where("id", "=", deviceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row?.org_id ?? null;
  }

  /** The owner's home directory the active machine reported in its hello, or null. */
  /** The device's active machine (its id and reported home), or null when none is active. */
  async activeMachine(deviceId: string): Promise<{ id: string; home: string | null } | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select(["id", "home"])
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row === undefined ? null : { id: row.id, home: row.home ?? null };
  }

  async machineHome(deviceId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("device_machines")
      .select("home")
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row?.home ?? null;
  }
}
