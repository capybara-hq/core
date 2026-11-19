import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { DeviceProjectsService } from "../../devices/device-projects.service.js";
import { DevicesService, type DeviceView } from "../../devices/devices.service.js";
import {
  DeviceNameBody,
  DeviceNetworkBody,
  DeviceParams,
  DeviceProjectAddBody,
  DeviceProjectParams,
} from "../../devices/dto.js";
import { deviceLabel } from "../../devices/label.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { rootConversationOf } from "../../runtime/subagents/child.js";
import { defineOperation, type OperationContext, type PrecheckResult } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const DeviceId = z.object({ deviceId: DeviceParams.shape.id }).strict();
const Name = z.object({ name: DeviceNameBody.shape.name }).strict();

/**
 * Model-facing names are English: the default is "Personal", a default demoted by a provider
 * switch "Personal (Docker sandbox)" (the web shows 「个人设备」 / 「个人设备（Docker 沙箱）」).
 */
const labelOf = (e: Pick<DeviceView, "name" | "demotedFrom">): string => deviceLabel(e, "en");

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
  if (e.reconcileRequired) {
    return {
      state: "reconcile_required",
      reason:
        "Its sandbox limits must be established again after the permission migration; nothing runs on it until then.",
      next: "Rebuild its files with devices.reset-files (the workspace is wiped), or ask the person to do it on its device page.",
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
    @Inject(DeviceProjectsService) private readonly projects: DeviceProjectsService,
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
          "List your own devices in this org: one compact row each (name, state, whether it is the default, source: cloud or local, provider, whether a local one is online and its machine, last use), plus the default and last used ids and whether new cloud devices can be made. The default device is shown as Personal; a former default left behind by a sandbox provider switch is shown as Personal (<provider>) and becomes the default again when that provider is back.",
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
          "Read one of your devices with its source (cloud or local), provider, state, instance, the machine of a local one and whether it is online, limits, its sandbox (the network in effect and its ceiling: open, allowlist or none, with the allowlist hosts; the device's own network setting and host list; whether a call may run outside the sandbox; which layer set each ceiling; a pending change that applies on its next use; its recent setting changes), a local machine's owner ceiling, and creation time. Takes the id from devices.list. A local device's sandbox is widened only on its machine; a cloud device's network can be narrowed with devices.set-network.",
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
          "Delete one of your devices, the default one included: its instance and ALL its files are destroyed after the response and cannot be recovered. Conversations bound to it keep pointing at it and their sandbox tools then fail. The device this conversation works in cannot be deleted. Takes the id from devices.list.",
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
          "Wipe one of your devices' files so it starts empty: ALL its files are destroyed (after running commands finish) and cannot be recovered; the next use creates a fresh workspace. Use it when a device reports its files are lost (not for a connected machine's device: its files are on the machine). The device this conversation works in cannot be wiped. Takes the id from devices.list.",
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
        // the network is devices.set-network's (narrow only)
        omits: ["network"],
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
      defineOperation({
        id: "devices.set-network",
        description:
          "Narrow the sandbox network of one of your cloud devices: mode allowlist (its organization's allowed hosts, optionally narrowed to hosts: a device's list never adds a host) or none (no network). Only narrowing is allowed here, in its stored setting and in effect: opening the network, adding a host, dropping its own host list or following the organization again (mode null) is refused and needs the person on the device's page. A local device's network is kept on its machine. Takes the id from devices.list; devices.get shows the network in effect.",
        input: DeviceId.extend({ network: DeviceNetworkBody }).strict(),
        example: {
          deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20",
          network: { mode: "allowlist", hosts: ["registry.npmjs.org"] },
        },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/devices/:id"],
        renames: { deviceId: "id" },
        omits: ["name"],
        confirm: "personal",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.network_not_allowed",
            next: "Through this tool a device's network may only narrow, within its organization's hosts: pick allowlist or none, or hosts its organization allows (devices.get shows them). To open it, ask the person to change it on the device's page; a host outside the organization's list needs an org admin.",
          },
          {
            code: "device.ceiling_on_machine",
            next: "This is a local device: its network is kept on its machine. Ask the person to narrow it on the device's page or on the machine.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.devices.checkNetwork(ctx.orgId, ctx.actorAccountId, i.deviceId, i.network, true),
          ),
        summary: async (i, ctx) => {
          const name = await orElse(
            async () =>
              named(labelOf(await this.devices.get(ctx.orgId, ctx.actorAccountId, i.deviceId))),
            i.deviceId,
          );
          const hosts = i.network.hosts?.length ? i.network.hosts.join(", ") : null;
          const zh =
            i.network.mode === "none"
              ? "关闭网络"
              : i.network.mode === "allowlist"
                ? `仅白名单${hosts ? `（${hosts}）` : ""}`
                : i.network.mode === "open"
                  ? "开放互联网"
                  : "跟随组织";
          const en =
            i.network.mode === "none"
              ? "no network"
              : i.network.mode === "allowlist"
                ? `the allowlist only${hosts ? ` (${hosts})` : ""}`
                : i.network.mode === "open"
                  ? "the open internet"
                  : "follow the organization";
          // neutral wording: the precheck and the run refuse anything but a narrowing
          return {
            zh: `将设备「${name}」的沙箱网络设为：${zh}`,
            en: `Set the sandbox network of device "${name}" to ${en}`,
          };
        },
        run: async (input, ctx) => {
          const e = await this.devices.update(
            ctx.orgId,
            ctx.actorAccountId,
            input.deviceId,
            {
              network: {
                mode: input.network.mode,
                ...(input.network.hosts !== undefined && { hosts: input.network.hosts }),
              },
            },
            undefined,
            { narrowOnly: true, auditDetail: viaAgent("devices.set-network", ctx) },
          );
          return {
            device: {
              ...row(e),
              sandbox: { network: e.sandbox.network, hosts: e.sandbox.hosts },
            },
          };
        },
      }),
      defineOperation({
        id: "devices.list-projects",
        description:
          "List the projects of one of your devices that its current mode can read (name and absolute path), plus the mode, the base a new project's path is relative to (the workspace in sandbox mode and on a cloud device, your home directory in auto mode), how many stored projects the mode hides, and whether the device offers projects at all. Takes the id from devices.list.",
        input: DeviceId,
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/devices/:id/projects"],
        renames: { deviceId: "id" },
        confirm: "read",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
        ],
        run: (input, ctx) => this.projects.list(ctx.orgId, ctx.actorAccountId, input.deviceId),
      }),
      defineOperation({
        id: "devices.project-candidates",
        description:
          "Ask one of your devices for project suggestions: the directories under its base (and the base itself) that hold .git or AGENTS.md, at most two levels down, each with its path relative to the base and a suggested name. Directory names only, never file contents. Takes the id from devices.list; add one with devices.add-project.",
        input: DeviceId,
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/devices/:id/projects/candidates"],
        renames: { deviceId: "id" },
        confirm: "read",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.offline",
            next: "Its machine is offline: ask the person to start capybara-device on it, then call again.",
          },
          {
            code: "device.project_home_unknown",
            next: "Ask the person to update capybara-device on that machine and reconnect it.",
          },
        ],
        run: (input, ctx) =>
          this.projects.candidates(ctx.orgId, ctx.actorAccountId, input.deviceId),
      }),
      defineOperation({
        id: "devices.add-project",
        description:
          "Add a project to one of your devices: path is relative to the device's base (see devices.list-projects; empty for the base itself), never absolute, and must stay inside what the device reads in its current mode; name defaults to the directory's name (1-64 characters, no /, unique on the device). The device is asked first, so a missing directory, a file or an unreadable path is refused. At most 100 projects per device. Takes the id from devices.list.",
        input: DeviceId.extend(DeviceProjectAddBody.shape).strict(),
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20", path: "src/capybara" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/devices/:id/projects"],
        renames: { deviceId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
          {
            code: "device.project_name_taken",
            next: "The device has a project with this name: pass another name, or read them with devices.list-projects.",
          },
          {
            code: "device.project_limit_reached",
            next: "The device is at the limit: remove a project with devices.remove-project first.",
          },
          {
            code: "device.project_outside_mode",
            next: "Pick a directory inside the device's workspace, or ask the person to switch the device to auto mode on its machine.",
          },
          {
            code: "device.project_path_missing",
            next: "Check the path with devices.project-candidates or ask the person for it.",
          },
          {
            code: "device.project_path_too_broad",
            next: "Pass the project's own directory: the owner's home or a directory below it, never / or an ancestor of the home.",
          },
          {
            code: "device.project_path_unreadable",
            next: "Pass a directory the device can read (not a file).",
          },
          {
            code: "device.projects_unsupported",
            next: "This device offers no projects: work without one, or ask the person to update capybara-device.",
          },
          {
            code: "device.offline",
            next: "Its machine is offline: ask the person to start capybara-device on it, then call again.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.projects.checkAdd(ctx.orgId, ctx.actorAccountId, i.deviceId, i.name),
          ),
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.deviceId);
          const where = i.path === "" ? "." : i.path;
          return {
            zh: `在设备「${n}」上添加项目 ${named(where)}${i.name === undefined ? "" : `（名称「${named(i.name)}」）`}`,
            en: `Add project ${named(where)} to device "${n}"${i.name === undefined ? "" : ` (named "${named(i.name)}")`}`,
          };
        },
        run: async (input, ctx) => ({
          project: await this.projects.add(
            ctx.orgId,
            ctx.actorAccountId,
            input.deviceId,
            { path: input.path, ...(input.name !== undefined && { name: input.name }) },
            undefined,
            viaAgent("devices.add-project", ctx),
          ),
        }),
      }),
      defineOperation({
        id: "devices.remove-project",
        description:
          "Remove a project from one of your devices by name: only the entry goes, never the directory or its files; conversations already bound to it keep their path. Removing a project that is not there succeeds. Takes the id from devices.list and the name from devices.list-projects.",
        input: DeviceId.extend({ name: DeviceProjectParams.shape.name }).strict(),
        example: { deviceId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20", name: "capybara" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/devices/:id/projects/:name"],
        renames: { deviceId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "device.not_found",
            next: "Check the id with devices.list: you only see your own devices.",
          },
        ],
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.deviceId);
          return {
            zh: `从设备「${n}」移除项目「${named(i.name)}」（目录和文件保留）`,
            en: `Remove project "${named(i.name)}" from device "${n}" (the directory and files stay)`,
          };
        },
        run: async (input, ctx) => {
          await this.projects.remove(
            ctx.orgId,
            ctx.actorAccountId,
            input.deviceId,
            input.name,
            undefined,
            viaAgent("devices.remove-project", ctx),
          );
          return { deviceId: input.deviceId, name: input.name, removed: true };
        },
      }),
    ]);
  }
}
