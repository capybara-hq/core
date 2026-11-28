import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { KernelDb } from "../infra/database/kernel-db.js";

/**
 * The live ports of one (device, service): what every ensure of the service sends its provider.
 * A provider of its own so `DeviceServices` reads it without depending on `LoopbackGrants`
 * (`sandbox/loopback-grants.ts`, whose refresh calls `DeviceServices`).
 */
@Injectable()
export class LoopbackLivePorts {
  constructor(@Inject(KernelDb) private readonly db: KernelDb) {}

  /** Sorted, unique, not revoked and not expired. */
  async livePorts(orgId: string, deviceId: string, serviceId: string): Promise<number[]> {
    const rows = await this.db
      .selectFrom("device_loopback_grants")
      .select("port")
      .distinct()
      .where("org_id", "=", orgId)
      .where("device_id", "=", deviceId)
      .where("service_id", "=", serviceId)
      .where("revoked_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .orderBy("port")
      .execute();
    return rows.map((r) => r.port);
  }
}
