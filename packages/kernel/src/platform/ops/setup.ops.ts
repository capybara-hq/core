import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { CatalogGuidePathParams, CatalogGuideQuery } from "../../catalog/org-catalog.schemas.js";
import { ApiError } from "../../errors.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import {
  SetupCheckPathParams,
  SetupCheckRunBody,
  SetupChecksQuery,
  SetupGuidePathParams,
} from "../../setup/setup-checks.schemas.js";
import { type CheckCaller, SetupChecksService } from "../../setup/setup-checks.service.js";
import { SetupGuidesQuery } from "../../setup/setup-guides.schemas.js";
import { SetupGuidesService } from "../../setup/setup-guides.service.js";
import { defineOperation, type OperationContext } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { roleOf } from "./role.js";

const ITEM = "00000000-0000-4000-8000-000000000000";
const CONNECTION = "00000000-0000-4000-8000-000000000001";

/**
 * Setup guide operations of the `Platform` tool (spec 2026-11-09-setup-guides-v2-design.md §12),
 * the `setup` domain: the guides a person may see, one guide rendered as Markdown, the cached check
 * states of a guide and running one check. All are reads (a check never writes anywhere; its cost
 * is bounded by the cache, the cooldown and the org's concurrency cap) and use the routes'
 * services, so a guide carries no secret (§6.3) and check results only the fixed, redacted fields.
 * Entering a secret, OAuth consent and the guide ack stay with the person on the web (`human-only`
 * and `secret` exclusions); no setup operation takes a value.
 */
@Injectable()
export class SetupOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(SetupChecksService) private readonly checks: SetupChecksService,
    @Inject(SetupGuidesService) private readonly guides: SetupGuidesService,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  /** The actor as the routes see a caller: the org, their role there now and their account. */
  private async caller(ctx: OperationContext): Promise<CheckCaller> {
    const role = await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId);
    if (role === null) throw new ApiError("forbidden", "Insufficient organization role");
    return { orgId: ctx.orgId, role, accountId: ctx.actorAccountId };
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "setup.guides",
        description:
          "List the plugin setup guides this person may help with in the org: per guide its targets (channel connections, connectors made from a template, templates switched on without a connector yet), whether the guide changed since a target was set up (drift), a count of the cached check states and the web page where the person does the setup. Org admins get the admin guides; members get the guides for connecting their own account. Read a guide with setup.read.",
        input: SetupGuidesQuery,
        example: {},
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/setup-guides"],
        confirm: "read",
        run: async (input, ctx) => ({
          guides: await this.guides.list(await this.caller(ctx), input),
        }),
      }),
      defineOperation({
        id: "setup.read",
        description:
          "Read one plugin setup guide rendered for a target as a Markdown document: the steps, the app manifest and URLs to paste at the third-party platform, and the checks as '- [check <id>] <label>' lines (run them with setup.check), with the modes, the variables that have no value yet and why, and the web page of the target. Explain the step the person is on. Secrets are never in the guide: ask the person to paste each token or secret into its field on the returned webPath, never into the conversation.",
        input: CatalogGuidePathParams.extend(CatalogGuideQuery.shape).strict(),
        example: { itemId: ITEM, guideId: "slack-app", connectionId: CONNECTION },
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId"],
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "The plugin is not in this org's catalog; list the guides with setup.guides.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The plugin has no setup guide with that id; list the guides with setup.guides.",
          },
          {
            code: "channel.not_found",
            next: "No channel connection with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "connector.not_found",
            next: "No connector made from this guide's template with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "validation_failed",
            next: "Pass a mode and audience the guide has (setup.guides lists the audience) and the target of its place: connectionId for a channel guide, connectorId for a connector template guide.",
          },
          {
            code: "forbidden",
            next: {
              member:
                "Only org admins read the admin guides; members read the member section of a connector template guide (audience member).",
            },
          },
        ],
        run: async (input, ctx) => {
          const { itemId, guideId, ...q } = input;
          return { guide: await this.guides.read(await this.caller(ctx), itemId, guideId, q) };
        },
      }),
      defineOperation({
        id: "setup.status",
        description:
          "Read the cached state of every check of a plugin's setup guide for one target (a channel connection or a connector made from a template), by check id: ok, failing, unknown, running or not_run, with the reason and fix to show the person. Runs nothing; run a check with setup.check.",
        input: SetupGuidePathParams.extend(SetupChecksQuery.shape).strict(),
        example: { itemId: ITEM, guideId: "slack-app", connectionId: CONNECTION },
        authz: { orgAction: "catalog.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks"],
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "The plugin is not in this org's catalog; check the item id on the plugin's page.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The plugin has no setup guide with that id; read the guide id from the connection or connector page.",
          },
          {
            code: "channel.not_found",
            next: "No channel connection with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "connector.not_found",
            next: "No connector made from this guide's template with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "validation_failed",
            next: "Checks need a saved target: pass connectionId for a channel guide or connectorId for a connector template guide, and a mode and audience the guide has.",
          },
          {
            code: "forbidden",
            next: {
              member:
                "Only org admins run the admin checks of a guide; members run the member checks (audience member).",
            },
          },
        ],
        run: async (input, ctx) => {
          const { itemId, guideId, ...q } = input;
          return { results: await this.checks.states(await this.caller(ctx), itemId, guideId, q) };
        },
      }),
      defineOperation({
        id: "setup.check",
        description:
          "Run one check of a plugin's setup guide for one target (a channel connection or a connector made from a template) and return its state: ok, failing (with a reason and a fix to explain), unknown, or running (try again in a moment). A fresh cached result is returned as is; force reruns it, at most once per 10 seconds per check and target. A check only reads; run it after the person says they finished a step.",
        input: SetupCheckPathParams.extend(SetupCheckRunBody.shape).strict(),
        example: {
          itemId: ITEM,
          guideId: "slack-app",
          checkId: "bot-token",
          connectionId: CONNECTION,
        },
        authz: { orgAction: "catalog.read" },
        mirrors: ["POST /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks/:checkId/run"],
        confirm: "read",
        errors: [
          {
            code: "catalog.item_not_found",
            next: "The plugin is not in this org's catalog; check the item id on the plugin's page.",
          },
          {
            code: "catalog.guide_not_found",
            next: "The plugin has no setup guide with that id; read the guide id from the connection or connector page.",
          },
          {
            code: "channel.not_found",
            next: "No channel connection with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "connector.not_found",
            next: "No connector made from this guide's template with that id in this org; list the targets with setup.guides.",
          },
          {
            code: "validation_failed",
            next: "Checks need a saved target: pass connectionId for a channel guide or connectorId for a connector template guide, and a mode and audience the guide has.",
          },
          {
            code: "forbidden",
            next: {
              member:
                "Only org admins run the admin checks of a guide; members run the member checks (audience member).",
            },
          },
          {
            code: "catalog.check_not_found",
            next: "That check is not in the guide for this mode and audience; read the check ids with setup.status.",
          },
          {
            code: "rate_limited",
            next: "This person ran 30 checks in the last minute; wait a minute before running another, and read the cached states with setup.status meanwhile.",
          },
        ],
        run: async (input, ctx) => {
          const { itemId, guideId, checkId, ...body } = input;
          return {
            result: await this.checks.run(await this.caller(ctx), itemId, guideId, checkId, body),
          };
        },
      }),
    ]);
  }
}
