import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { EnvironmentNameBody, EnvironmentParams } from "../../environments/dto.js";
import {
  EnvironmentsService,
  type EnvironmentView,
} from "../../environments/environments.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { named, orElse } from "./summary.js";

const EnvironmentId = z.object({ environmentId: EnvironmentParams.shape.id }).strict();
const Name = z.object({ name: EnvironmentNameBody.shape.name }).strict();

/** The default environment has no name; the web shows it as 「个人环境」 / "Personal". */
const labelOf = (e: Pick<EnvironmentView, "name">): string => e.name ?? "Personal";

/** A row's state: why it cannot be used now, else whether its instance runs. */
function stateOf(e: EnvironmentView): { state: string; reason?: string; next?: string } {
  if (!e.available) {
    return {
      state: "unavailable",
      reason: "Its sandbox provider is no longer the deployment's current one.",
      next: "Ask an org admin; use another environment meanwhile.",
    };
  }
  if (e.filesLost) {
    return {
      state: "files_lost",
      reason: "Its file system is gone at the provider.",
      next: "Wipe its files with environments.reset-files to use it again.",
    };
  }
  return { state: e.instance?.status ?? "ready" };
}

const row = (e: EnvironmentView) => ({
  id: e.id,
  name: labelOf(e),
  ...stateOf(e),
  isDefault: e.isDefault,
  provider: e.provider,
  lastUsedAt: e.instance?.lastUsedAt ?? null,
});

/**
 * Environment operations of the `Platform` tool (environments design, phase 1): a person's own
 * cloud environments. Phase 1 has personal environments only, visible to their owner alone, so
 * these are `personal` writes. A cloud environment carries no credentials or device connection;
 * deleting one and wiping its files are `personal` writes that are never remembered.
 */
@Injectable()
export class EnvironmentsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(EnvironmentsService) private readonly environments: EnvironmentsService,
  ) {}

  /** The environment's name for a card; its id when it cannot be read. */
  private label(ctx: { orgId: string; actorAccountId: string }, id: string): Promise<string> {
    return orElse(
      async () => named(labelOf(await this.environments.get(ctx.orgId, ctx.actorAccountId, id))),
      id,
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "environments.list",
        description:
          "List your own cloud environments in this org: one compact row each (name, state, whether it is the default, provider, last use), plus the default and last used ids and whether new cloud environments can be made. The default environment is shown as Personal.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/environments"],
        confirm: "read",
        run: async (_input, ctx) => {
          const l = await this.environments.list(ctx.orgId, ctx.actorAccountId);
          return {
            items: l.items.map(row),
            defaultId: l.defaultId,
            lastUsedId: l.lastUsedId,
            cloudAvailable: l.cloudAvailable,
          };
        },
      }),
      defineOperation({
        id: "environments.get",
        description:
          "Read one of your environments with its provider, state, instance, limits and creation time. Takes the id from environments.list.",
        input: EnvironmentId,
        example: { environmentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/environments/:id"],
        renames: { environmentId: "id" },
        confirm: "read",
        errors: [
          {
            code: "environment.not_found",
            next: "Check the id with environments.list: you only see your own environments.",
          },
        ],
        run: async (input, ctx) => {
          const e = await this.environments.get(ctx.orgId, ctx.actorAccountId, input.environmentId);
          return { environment: { ...e, name: labelOf(e), ...stateOf(e) } };
        },
      }),
      defineOperation({
        id: "environments.create",
        description:
          "Create a personal cloud environment with a name (1-64 characters, unique among yours, case-insensitive). It is ready at once; its instance and files are made on first use. It needs a sandbox provider and is limited per person. ",
        input: Name,
        example: { name: "Data analysis" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/environments"],
        confirm: "personal",
        errors: [
          {
            code: "environment.name_taken",
            next: "You have an environment with this name: pick another name, or read yours with environments.list.",
          },
          {
            code: "environment.limit_reached",
            next: "You are at the limit: delete an environment you no longer need with environments.delete, or use an existing one.",
          },
          {
            code: "environment.unavailable",
            next: {
              superAdmin:
                "No sandbox provider is current: set one up in the admin console under extensions, then call again.",
              orgAdmin: "No sandbox provider is set up; ask the super admin.",
              member: "No sandbox provider is set up in this deployment; ask an org admin.",
            },
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.environments.checkCreate(ctx.orgId, ctx.actorAccountId, i.name)),
        summary: (i) => ({
          zh: `新建个人云环境「${named(i.name)}」`,
          en: `Create personal cloud environment "${named(i.name)}"`,
        }),
        run: async (input, ctx) => {
          const e = await this.environments.create(
            ctx.orgId,
            ctx.actorAccountId,
            { name: input.name },
            undefined,
            viaAgent("environments.create", ctx),
          );
          return { environment: row(e) };
        },
      }),
      defineOperation({
        id: "environments.delete",
        description:
          "Delete one of your environments, the default one included: its instance and ALL its files are destroyed after the response and cannot be recovered. Conversations bound to it keep pointing at it and their sandbox tools then fail. The person confirms every delete; it is never remembered. Takes the id from environments.list.",
        input: EnvironmentId,
        example: { environmentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/environments/:id"],
        renames: { environmentId: "id" },
        confirm: "personal",
        // destructive: asked every time and never remembered
        rememberable: false,
        errors: [
          {
            code: "environment.not_found",
            next: "Check the id with environments.list: you only see your own environments.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() => this.environments.get(ctx.orgId, ctx.actorAccountId, i.environmentId)),
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.environmentId);
          return {
            zh: `删除环境「${n}」：其中所有文件将被销毁且无法恢复`,
            en: `Delete environment "${n}": all its files are destroyed and cannot be recovered`,
          };
        },
        run: async (input, ctx) => {
          await this.environments.remove(
            ctx.orgId,
            ctx.actorAccountId,
            input.environmentId,
            undefined,
            viaAgent("environments.delete", ctx),
          );
          return { id: input.environmentId, deleted: true };
        },
      }),
      defineOperation({
        id: "environments.reset-files",
        description:
          "Wipe one of your environments' files so it starts empty: ALL its files are destroyed (after running commands finish) and cannot be recovered; the next use creates a fresh workspace. Use it when an environment reports its files are lost. The person confirms every reset; it is never remembered. Takes the id from environments.list.",
        input: EnvironmentId,
        example: { environmentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20" },
        authz: { orgAction: "agents.use" },
        mirrors: ["POST /api/v1/orgs/:orgId/environments/:id/files/reset"],
        renames: { environmentId: "id" },
        confirm: "personal",
        rememberable: false,
        errors: [
          {
            code: "environment.not_found",
            next: "Check the id with environments.list: you only see your own environments.",
          },
          {
            code: "environment.unavailable",
            next: {
              orgAdmin:
                "Its sandbox provider is no longer the current one: use another environment, or ask the super admin about the provider.",
              member:
                "Its sandbox provider is no longer the current one: use another environment, or ask an org admin.",
            },
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.environments.checkReset(ctx.orgId, ctx.actorAccountId, i.environmentId),
          ),
        summary: async (i, ctx) => {
          const n = await this.label(ctx, i.environmentId);
          return {
            zh: `清空环境「${n}」的文件：所有文件将被销毁且无法恢复`,
            en: `Wipe the files of environment "${n}": all files are destroyed and cannot be recovered`,
          };
        },
        run: async (input, ctx) => {
          await this.environments.resetFiles(
            ctx.orgId,
            ctx.actorAccountId,
            input.environmentId,
            undefined,
            viaAgent("environments.reset-files", ctx),
          );
          return { id: input.environmentId, reset: true };
        },
      }),
      defineOperation({
        id: "environments.rename",
        description:
          "Rename one of your environments, the default one included (it then has a name). The new name is 1-64 characters and unique among yours, case-insensitive. Takes the id from environments.list.",
        input: EnvironmentId.extend({ name: EnvironmentNameBody.shape.name }).strict(),
        example: { environmentId: "4e8a0c1d-6b2f-4a37-8d19-3c5e7f9a1b20", name: "Reports" },
        authz: { orgAction: "agents.use" },
        mirrors: ["PATCH /api/v1/orgs/:orgId/environments/:id"],
        renames: { environmentId: "id" },
        confirm: "personal",
        errors: [
          {
            code: "environment.not_found",
            next: "Check the id with environments.list: you only see your own environments.",
          },
          {
            code: "environment.name_taken",
            next: "You have an environment with this name: pick another name.",
          },
        ],
        precheck: (i, ctx) =>
          precheckBy(() =>
            this.environments.checkRename(ctx.orgId, ctx.actorAccountId, i.environmentId, i.name),
          ),
        summary: async (i, ctx) => {
          const from = await orElse(
            async () =>
              named(
                labelOf(
                  await this.environments.get(ctx.orgId, ctx.actorAccountId, i.environmentId),
                ),
              ),
            i.environmentId,
          );
          return {
            zh: `将环境「${from}」重命名为「${named(i.name)}」`,
            en: `Rename environment "${from}" to "${named(i.name)}"`,
          };
        },
        run: async (input, ctx) => ({
          environment: row(
            await this.environments.rename(
              ctx.orgId,
              ctx.actorAccountId,
              input.environmentId,
              input.name,
              undefined,
              viaAgent("environments.rename", ctx),
            ),
          ),
        }),
      }),
    ]);
  }
}
