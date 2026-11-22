import { DeviceProtocolError } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelDialInHandler } from "../dial-in/handlers.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { LocalMachineReports } from "./local-machine-reports.js";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The dial-in handler of the kernel's own `@local` provider (interim: it leaves the kernel with
 * the `device-local` plugin): the hello body of a `capybara-device` machine (protocol 5) is
 * validated and recorded on the machine's row with the connection it opened
 * ({@link LocalMachineReports.recordHelloV3}); a `policy` event (the owner changed the machine's
 * policy or owner ceiling) likewise ({@link LocalMachineReports.recordPolicyV3}). As a
 * kernel-internal handler it gets the authenticated connection (machine and connection ids);
 * an extension's handler never does.
 */
@Injectable()
export class LocalDialIn implements KernelDialInHandler {
  readonly kernelInternal = true as const;

  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(LocalMachineReports)
    private readonly reports: Pick<LocalMachineReports, "recordHelloV3" | "recordPolicyV3">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  async onHello(
    deviceId: string,
    hello: unknown,
    _signal: AbortSignal,
    connection?: { machineId: string; connectionId: string },
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const machineId = connection?.machineId ?? (await this.activeMachine(deviceId));
    if (machineId === null)
      return {
        ok: false,
        code: "device.machine_revoked",
        message: "The machine was disconnected; sign in again",
      };
    try {
      await this.reports.recordHelloV3(machineId, hello, connection?.connectionId ?? null);
    } catch (e) {
      if (e instanceof DeviceProtocolError)
        return { ok: false, code: "device.hello_invalid", message: e.message };
      throw e;
    }
    return { ok: true };
  }

  async onFrame(
    deviceId: string,
    frame: unknown,
    connection?: { machineId: string; connectionId: string },
  ): Promise<void> {
    const machineId = connection?.machineId ?? (await this.activeMachine(deviceId));
    if (machineId === null) return;
    try {
      await this.reports.recordPolicyV3(machineId, frame, connection?.connectionId ?? null);
    } catch (e) {
      this.log.warn("could not record a device policy change", { deviceId, error: errMsg(e) });
    }
  }

  private async activeMachine(deviceId: string): Promise<string | null> {
    const row = await this.kdb.db
      .selectFrom("device_machines")
      .select("id")
      .where("device_id", "=", deviceId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row?.id ?? null;
  }
}
