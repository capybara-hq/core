import { DeviceProtocolError } from "@capybara-hq/plugin-sdk/device-protocol";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelDialInHandler } from "../dial-in/handlers.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DeviceReports } from "../sandbox/device-reports.js";
import { LOCAL_PROVIDER } from "../sandbox/providers.js";
import { LocalMachineReports } from "./local-machine-reports.js";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The dial-in handler of the kernel's own `@local` provider (interim: it leaves the kernel with
 * the `device-local` plugin): the hello body of a `capybara-device` machine (protocol 5) is
 * validated and recorded on the machine's row with the connection it opened
 * ({@link LocalMachineReports.recordHelloV3}); a `policy` event (the owner changed the machine's
 * policy or owner ceiling) likewise ({@link LocalMachineReports.recordPolicyV3}). A recorded hello
 * stores the device's report as a dial-in provider does (`DeviceReports.changed`: the machine's
 * home and the attested support), so the device reads like every provider's. As a
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
    @Inject(DeviceReports) private readonly devices: Pick<DeviceReports, "changed">,
  ) {}

  async onHello(
    deviceId: string,
    hello: unknown,
    signal: AbortSignal,
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
    // the device's report, as a dial-in provider tells it at hello; a failure keeps the stored one
    await this.devices.changed(LOCAL_PROVIDER, deviceId, signal).catch((e: unknown) => {
      if (!signal.aborted)
        this.log.warn("could not store the device report", { deviceId, error: errMsg(e) });
    });
    return { ok: true };
  }

  /**
   * A machine revoked, replaced or deleted is a new report (its revision names the active
   * machine): stored as a dial-in provider tells it, so the evidence of the old machine's instance
   * no longer stands. A failure keeps the stored one.
   */
  onClose(deviceId: string, reason: "offline" | "replaced" | "revoked" | "deleted"): Promise<void> {
    if (reason === "offline") return Promise.resolve();
    return this.devices
      .changed(LOCAL_PROVIDER, deviceId)
      .then(() => undefined)
      .catch((e: unknown) => {
        this.log.warn("could not store the device report", { deviceId, error: errMsg(e) });
      });
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
