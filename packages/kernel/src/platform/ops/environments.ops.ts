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
      next: "Reset its files on the web (environments page) to use it again.",
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
 * deleting one and resetting its files stay `human-only`.
 */
@Injectable()
export class EnvironmentsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(EnvironmentsService) private readonly environments: EnvironmentsService,
  ) {}

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
          "Create a personal cloud environment with a name (1-64 characters, unique among yours, case-insensitive). It is ready at once; its instance and files are made on first use. It needs a sandbox provider and is limited per person. Deleting one is done on the web.",
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
            next: "You are at the limit: delete an environment you no longer need on the web (environments page), or use an existing one.",
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
