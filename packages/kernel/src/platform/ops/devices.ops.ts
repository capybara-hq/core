import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DevicesService, type DeviceView } from "../../devices/devices.service.js";
import { DeviceNameBody, DeviceParams } from "../../devices/dto.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const DeviceId = z.object({ deviceId: DeviceParams.shape.id }).strict();
const Name = z.object({ name: DeviceNameBody.shape.name }).strict();

/** The default device has no name; the web shows it as 「个人设备」 / "Personal". */
const labelOf = (e: Pick<DeviceView, "name">): string => e.name ?? "Personal";

/** A row's state: why it cannot be used now, else whether its instance runs. */
function stateOf(e: DeviceView): { state: string; reason?: string; next?: string } {
  if (!e.available) {
    return {
      state: "unavailable",
      reason: "Its sandbox provider is no longer the deployment's current one.",
      next: "Ask an org admin; use another device meanwhile.",
    };
  }
  if (e.filesLost && e.source === "local") {
    return {
      state: "files_lost",
      reason: "Its directory is gone from the connected machine.",
      next: "Ask the person to run capybara-device logout, then capybara-device login into this device, on that machine.",
    };
  }
  if (e.filesLost) {
    return {
      state: "files_lost",
      reason: "Its file system is gone at the provider.",
      next: "Wipe its files with devices.reset-files to use it again.",
    };
  }
  return { state: e.instance?.status ?? "ready" };
}

const row = (e: DeviceView) => ({
  id: e.id,
  name: labelOf(e),
  ...stateOf(e),
  isDefault: e.isDefault,
  source: e.source,
  provider: e.provider,
  online: e.online,
  machine: e.machine && {
    name: e.machine.name,
    os: e.machine.os,
    lastSeenAt: e.machine.lastSeenAt,
  },
  lastUsedAt: e.instance?.lastUsedAt ?? null,
});

/**
 * Device operations of the `Platform` tool (environments design, phase 1): a person's own
 * cloud devices. Phase 1 has personal devices only, visible to their owner alone, so
 * these are `personal` writes. A cloud device carries no credentials or device connection;
 * deleting one and wiping its files are `personal` writes that are never remembered.
 */
@Injectable()
export class DevicesOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /**
   * Whether `id` is the device the run works in: the one its root conversation is bound to
   * (sub-agents use the root's). Deleting or wiping it would pull the sandbox from under the run.
   */
  private async isRunsDevice(id: string, ctx: OperationContext): Promise<boolean> {
    const root = await rootConversationOf(this.kdb.db, ctx.conversationId);
    const row = await this.kdb.db
      .selectFrom("conversations")
      .select("device_id")
      .where("id", "=", root)
      .where("org_id", "=", ctx.orgId)
      .executeTakeFirst();
    return row?.device_id === id;
  }

  /** The precheck of a destructive write: never the run's own device, then the service's. */
  private async precheckDestructive(
    id: string,
    ctx: OperationContext,
    verb: "deleted" | "wiped",
    read: () => Promise<unknown>,
  ): Promise<PrecheckResult> {
    if (await this.isRunsDevice(id, ctx)) {
      return {
        ok: false,
        code: "device.current",
        message: `The device you are running in cannot be ${verb} from here.`,
      };
    }
    return precheckBy(read);
  }

  /** The device's name for a card; its id when it cannot be read. */
  private label(ctx: { orgId: string; actorAccountId: string }, id: string): Promise<string> {
    return orElse(
      async () => named(labelOf(await this.devices.get(ctx.orgId, ctx.actorAccountId, id))),
      id,
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "devices.list",
        description:
          "List your own devices in this org: one compact row each (name, state, whether it is the default, source: cloud or device for a connected machine, provider, whether a device one is online and its machine, last use), plus the default and last used ids and whether new cloud devices can be made. The default device is shown as Personal.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/devices"],
        confirm: "read",
        run: async (_input, ctx) => {
          const l = await this.devices.list(ctx.orgId, ctx.actorAccountId);
          return {
            items: l.items.map(row),
            defaultId: l.defaultId,
            lastUsedId: l.lastUsedId,
            cloudAvailable: l.cloudAvailable,
          };
        },
      }),
      defineOperation({
        id: "devices.get",
        description:
          "Read one of your devices with its source (cloud or device), provider, state, instance, connected machine and whether it is online, limits and creation time. Takes the id from devices.list.",
        input: DeviceId,
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/devices/:id"],
        renames: { deviceId: "id" },
        confirm: "read",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
        ],
        run: async (input, ctx) => {
          const e = await this.devices.get(ctx.orgId, ctx.actorAccountId, input.deviceId);
          return { device: { ...e, name: labelOf(e), ...stateOf(e) } };
        },
      }),
      defineOperation({
        id: "devices.create",
        description:
          "Create a personal cloud device with a name (1-64 characters, unique among yours, case-insensitive). It is ready at once; its instance and files are made on first use. It needs a sandbox provider and is limited per person.",
        input: Name,
        example: { name: "Data analysis" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/devices"],
        confirm: "personal",
        errors: [
          {
            code: "device.name_taken",
            next: "You have a device with this name: pick another name, or read yours with devices.list.",
          },
          {
            code: "device.limit_reached",
            next: "You are at the limit: delete a device you no longer need with devices.delete, or use an existing one.",
          },
          {
            code: "device.current",
            next: "This conversation works in it: ask the person to wipe it on the web, or wipe a different one.",
          },
          {
            code: "device.unavailable",
            next: {
              superAdmin:
                "No sandbox provider is current: set one up in the admin console under extensions, then call again.",
              orgAdmin: "No sandbox provider is set up; ask the super admin.",
              member: "No sandbox provider is set up in this deployment; ask an org admin.",
            },
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.devices.checkCreate(ctx.orgId, ctx.actorAccountId, i.name)),
        summary: (i) => ({
          zh: `新建个人云端设备「${named(i.name)}」`,
          en: `Create personal cloud device "${named(i.name)}"`,
        }),
        run: async (input, ctx) => {
          const e = await this.devices.create(
            ctx.orgId,
            ctx.actorAccountId,
            { name: input.name },
            undefined,
            viaAgent("devices.create", ctx),
          );
          return { device: row(e) };
        },
      }),
      defineOperation({
        id: "devices.delete",
        description:
          "Delete one of your devices, the default one included: its instance and ALL its files are destroyed after the response and cannot be recovered. Conversations bound to it keep pointing at it and their sandbox tools then fail. The person confirms every delete; it is never remembered. The device this conversation works in cannot be deleted. Takes the id from devices.list.",
        input: DeviceId,
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/devices/:id"],
        renames: { deviceId: "id" },
        confirm: "personal",
        // destructive: asked every time and never remembered
        rememberable: false,
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.current",
            next: "This conversation works in it: ask the person to delete it on the web, or delete a different one.",
          },
        ],
        precheck: (i, ctx) =>
          this.precheckDestructive(i.deviceId, ctx, "deleted", () =>
            this.devices.get(ctx.orgId, ctx.actorAccountId, i.deviceId),
          ),
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.deviceId);
          const c = await orElse(
            () => this.devices.boundConversations(ctx.orgId, ctx.actorAccountId, i.deviceId),
            0,
          );
          return {
            zh: `删除设备「${n}」：其中所有文件将被销毁且无法恢复；使用它的 ${c} 个对话将失去沙箱（沙箱工具会失败）`,
            en: `Delete device "${n}": all its files are destroyed and cannot be recovered; the ${c} conversations using it lose their sandbox (their sandbox tools fail)`,
          };
        },
        run: async (input, ctx) => {
          await this.devices.remove(
            ctx.orgId,
            ctx.actorAccountId,
            input.deviceId,
            undefined,
            viaAgent("devices.delete", ctx),
          );
          return { id: input.deviceId, deleted: true };
        },
      }),
      defineOperation({
        id: "devices.reset-files",
        description:
          "Wipe one of your devices' files so it starts empty: ALL its files are destroyed (after running commands finish) and cannot be recovered; the next use creates a fresh workspace. Use it when a device reports its files are lost (not for a connected machine's device: its files are on the machine). The person confirms every reset; it is never remembered. The device this conversation works in cannot be wiped. Takes the id from devices.list.",
        input: DeviceId,
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/devices/:id/files/reset"],
        renames: { deviceId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.current",
            next: "This conversation works in it: ask the person to wipe it on the web, or wipe a different one.",
          },
          {
            code: "device.files_on_device",
            next: "Its files are on its connected machine: ask the person to run capybara-device logout, then capybara-device login into this device, on that machine.",
          },
          {
            code: "device.unavailable",
            next: {
              orgAdmin:
                "Its sandbox provider is no longer the current one: use another device, or ask the super admin about the provider.",
              member:
                "Its sandbox provider is no longer the current one: use another device, or ask an org admin.",
            },
          },
        ],
        precheck: (i, ctx) =>
          this.precheckDestructive(i.deviceId, ctx, "wiped", () =>
            this.devices.checkReset(ctx.orgId, ctx.actorAccountId, i.deviceId),
          ),
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.deviceId);
          return {
            zh: `清空设备「${n}」的文件：所有文件将被销毁且无法恢复`,
            en: `Wipe the files of device "${n}": all files are destroyed and cannot be recovered`,
          };
        },
        run: async (input, ctx) => {
          await this.devices.resetFiles(
            ctx.orgId,
            ctx.actorAccountId,
            input.deviceId,
            undefined,
            viaAgent("devices.reset-files", ctx),
          );
          return { id: input.deviceId, reset: true };
        },
      }),
      defineOperation({
        id: "devices.rename",
        description:
          "Rename one of your devices, the default one included (it then has a name). The new name is 1-64 characters and unique among yours, case-insensitive. Takes the id from devices.list.",
        input: DeviceId.extend({ name: DeviceNameBody.shape.name }).strict(),
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20", name: "Reports" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/devices/:id"],
        renames: { deviceId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.name_taken",
            next: "You have a device with this name: pick another name.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.devices.checkRename(ctx.orgId, ctx.actorAccountId, i.deviceId, i.name),
          ),
        summary: async (i, ctx) => {
          const from = await orElse(
            async () =>
              named(labelOf(await this.devices.get(ctx.orgId, ctx.actorAccountId, i.deviceId))),
            i.deviceId,
          );
          return {
            zh: `将设备「${from}」重命名为「${named(i.name)}」`,
            en: `Rename device "${from}" to "${named(i.name)}"`,
          };
        },
        run: async (input, ctx) => ({
          device: row(
            await this.devices.rename(
              ctx.orgId,
              ctx.actorAccountId,
              input.deviceId,
              input.name,
              undefined,
              viaAgent("devices.rename", ctx),
            ),
          ),
        }),
      }),
    ]);
  }
}
