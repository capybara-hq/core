import { EXTENSION_POINTS, parseExtensionPoint } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  OrgExtensionParams,
  OrgExtensionToolParams,
  OrgToolSwitchPut,
} from "../../catalog/org-extension.schemas.js";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../../extensions/org-config.js";
import { ExtensionPointDefaults } from "../../extensions/point-defaults.js";
import {
  ExtensionPointDefaultBody,
  ExtensionPointParams,
} from "../../extensions/point-defaults.schemas.js";
import { KernelDb } from "../../infra/database/kernel-db.js";
import { can } from "../../orgs/roles.js";
import { OrgToolSwitches } from "../../tools/org-tool-switches.js";
import { resolveNext } from "../errors.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { roleOf } from "./role.js";
import { localized } from "./summary.js";
import { roleFor, unavailableFields } from "./unavailable.js";

const NoInput = z.object({}).strict();

const Extension = OrgExtensionParams.shape.extension;
const Tool = OrgExtensionToolParams.shape.tool;
const SwitchConfirm = OrgToolSwitchPut.shape.confirm.unwrap();

/** The next step of an extension that needs its org config (an org admin enters it on the web). */
const NEEDS_ORG_CONFIG = {
  orgAdmin: "An org admin fills in its org config on the 扩展 page, where secrets are entered.",
  member: "Ask an org admin to fill in its org config on the 扩展 page.",
};

/** An extension's state in the org, as the 扩展 page shows it. */
function stateOf(v: OrgExtensionView): "on" | "off" | "needs_config" | "unavailable" {
  if (!v.available) return "unavailable";
  if (v.needsConfig) return "needs_config";
  return v.enabled ? "on" : "off";
}

/**
 * Extension operations of the `Platform` tool (spec §7): read only, and state only. The org config,
 * the secrets' state, the config schema and the permission list are never returned (the member
 * projection of `GET /orgs/:orgId/extensions`, whatever the actor's role); configuring an
 * extension is done on the web.
 */
@Injectable()
export class ExtensionsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(OrgExtensionConfigs) private readonly configs: OrgExtensionConfigs,
    @Inject(ExtensionDisplayNames) private readonly displayNames: ExtensionDisplayNames,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(OrgToolSwitches) private readonly switches: OrgToolSwitches,
    @Inject(ExtensionPointDefaults) private readonly pointDefaults: ExtensionPointDefaults,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "extensions.list",
        description:
          "List the extensions installed on the platform as this org sees them, one compact row each: the state here (on, off, needs_config: the org config is missing, unavailable: it cannot run on the platform), why an unavailable one cannot be used (reason) and your next step (next), whether it is available on the platform, the extension points it provides and the plugin that brings it. State only: configuring one is done on the web. Pages by 50: pass the returned next as params.cursor.",
        input: z.object({ cursor: Cursor.optional() }).strict(),
        example: {},
        authz: { orgAction: "org.extensions.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/extensions"],
        extras: ["cursor"],
        confirm: "read",
        run: async (input, ctx) => {
          const [views, role] = await Promise.all([
            this.configs.list(ctx.orgId),
            roleFor(this.kdb.db, ctx),
          ]);
          const names = await this.displayNames.many(views.map((v) => v.plugin));
          return pageOf(
            views.map((v) => {
              const name = localized(names.get(v.plugin), v.plugin).en;
              return {
                id: v.plugin,
                name,
                state: stateOf(v),
                ...(v.available
                  ? v.needsConfig
                    ? { next: resolveNext(NEEDS_ORG_CONFIG, role) }
                    : {}
                  : unavailableFields(v.reason ?? "loading", name, role)),
                available: v.available,
                provides: providesOf(v),
                catalogItemId: v.catalogItem?.itemId ?? null,
              };
            }),
            startOf(input.cursor),
            50,
          );
        },
      }),
      defineOperation({
        id: "extensions.tools",
        description:
          "List the tools an extension registers, each with this org's switch (on unless an org admin turned it off).",
        input: z.object({ extension: Extension }).strict(),
        example: { extension: "todo" },
        authz: { orgAction: "org.extensions.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/extensions/:extension/tools"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
        ],
        run: async (input, ctx) => ({
          tools: await this.switches.list(ctx.orgId, input.extension),
        }),
      }),
      defineOperation({
        id: "extensions.tool-disable-preview",
        description:
          "Preview turning one extension tool off in this org (org admins): the org's agents that selected it, and the confirm value extensions.set-tool-enabled needs. Show the preview to the person before turning it off.",
        input: z.object({ extension: Extension, tool: Tool }).strict(),
        example: { extension: "todo", tool: "add_item" },
        // the web previews through the switch route itself (no confirm); writes nothing here
        authz: { orgAction: "org.extensions.manage" },
        mirrors: [],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          { code: "extension.tool_not_found", next: "Check the tool names with extensions.tools." },
        ],
        run: async (input, ctx) => {
          const p = await this.switches.previewOff(ctx.orgId, input.extension, input.tool);
          return p === null
            ? { preview: null, next: "The tool is off in this org already." }
            : { affectedAgents: p.affectedAgents, confirm: p.confirm };
        },
      }),
      defineOperation({
        id: "extensions.set-tool-enabled",
        description:
          "Turn one extension tool on or off in this org (org admins). Turning on applies at once; turning off needs confirm: the value extensions.tool-disable-preview returned with the preview the person saw.",
        input: z.discriminatedUnion("enabled", [
          z.object({ extension: Extension, tool: Tool, enabled: z.literal(true) }).strict(),
          z
            .object({
              extension: Extension,
              tool: Tool,
              enabled: z.literal(false),
              confirm: SwitchConfirm,
            })
            .strict(),
        ]),
        example: { extension: "todo", tool: "add_item", enabled: true },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/extensions/:extension/tools/:tool"],
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          { code: "extension.tool_not_found", next: "Check the tool names with extensions.tools." },
          {
            code: "plugin.switch_stale",
            next: "What turning it off affects changed: call extensions.tool-disable-preview again, show it, and call again with the new confirm value.",
          },
        ],
        precheck: async (i, ctx) => {
          if (i.enabled) {
            let tools: { tool: string }[] = [];
            const r = await precheckBy(async () => {
              tools = await this.switches.list(ctx.orgId, i.extension);
            });
            if (!r.ok) return r;
            return tools.some((t) => t.tool === i.tool)
              ? { ok: true }
              : {
                  ok: false,
                  code: "extension.tool_not_found",
                  message: `Extension ${i.extension} does not register a tool named ${i.tool}`,
                };
          }
          let confirm: string | null = null;
          const r = await precheckBy(async () => {
            confirm =
              (await this.switches.previewOff(ctx.orgId, i.extension, i.tool))?.confirm ?? null;
          });
          if (!r.ok) return r;
          return confirm === null || confirm === i.confirm
            ? { ok: true }
            : {
                ok: false,
                code: "plugin.switch_stale",
                message: "What turning this tool off affects has changed since the preview",
              };
        },
        summary: async (i, ctx) => {
          if (i.enabled) {
            return {
              zh: `在本组织开启扩展「${i.extension}」的工具 ${i.tool}`,
              en: `Turn on tool ${i.tool} of extension "${i.extension}" in the org`,
            };
          }
          const p = await this.switches.previewOff(ctx.orgId, i.extension, i.tool);
          const n = p?.affectedAgents.length ?? 0;
          return {
            zh: `在本组织关闭扩展「${i.extension}」的工具 ${i.tool}：${n} 个智能体选用了它`,
            en: `Turn off tool ${i.tool} of extension "${i.extension}" in the org: ${n} agents selected it`,
          };
        },
        run: async (input, ctx) =>
          this.switches.set(
            ctx.orgId,
            input.extension,
            input.tool,
            input.enabled,
            {
              accountId: ctx.actorAccountId,
              auditDetail: viaAgent("extensions.set-tool-enabled", ctx),
            },
            input.enabled ? undefined : input.confirm,
          ),
      }),
      defineOperation({
        id: "extensions.point-defaults",
        description:
          "List the extension points where this org picks a default provider (org admins), such as web search: each point's candidate extensions, the stored default and the provider a call uses now.",
        input: NoInput,
        example: {},
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/extension-points"],
        confirm: "read",
        run: async (_input, ctx) => ({ points: await this.pointDefaults.list(ctx.orgId) }),
      }),
      defineOperation({
        id: "extensions.point-availability",
        description:
          "Whether each org-default extension point (such as web search) has a provider in this org now, without naming extensions.",
        input: NoInput,
        example: {},
        authz: { orgAction: "agents.use" },
        mirrors: ["GET /api/v1/orgs/:orgId/extension-points/available"],
        confirm: "read",
        run: async (_input, ctx) => ({ points: await this.pointDefaults.available(ctx.orgId) }),
      }),
      defineOperation({
        id: "extensions.set-point-default",
        description:
          "Choose the org's default provider of an org-default extension point (org admins): extension must be one of the point's candidates from extensions.point-defaults.",
        input: z
          .object({
            point: ExtensionPointParams.shape.point,
            extension: ExtensionPointDefaultBody.shape.extension.max(64),
          })
          .strict(),
        example: { point: "web-search", extension: "web-search-tavily" },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/extension-points/:point/default"],
        confirm: "org",
        errors: [
          {
            code: "validation_failed",
            next: "Pick a point and one of its candidates from extensions.point-defaults; an extension must be on in the org to be a candidate.",
          },
        ],
        precheck: async (i, ctx) => {
          const p = (await this.pointDefaults.list(ctx.orgId)).find((x) => x.point === i.point);
          if (p === undefined) {
            return {
              ok: false,
              code: "validation_failed",
              message: `${i.point} is not an extension point with an organization default`,
            };
          }
          return p.candidates.includes(i.extension)
            ? { ok: true }
            : {
                ok: false,
                code: "validation_failed",
                message: `Extension ${i.extension} does not provide ${i.point} or is not enabled in this organization`,
              };
        },
        summary: (i) => ({
          zh: `把本组织 ${i.point} 的默认提供者设为扩展「${i.extension}」`,
          en: `Set the org's default provider of ${i.point} to extension "${i.extension}"`,
        }),
        run: async (input, ctx) => {
          await this.pointDefaults.setDefault(
            ctx.orgId,
            input.point,
            input.extension,
            ctx.actorAccountId,
            viaAgent("extensions.set-point-default", ctx),
          );
          return { point: input.point, default: input.extension };
        },
      }),
      defineOperation({
        id: "extensions.points",
        description:
          "List the extension points of the platform (the contracts extensions implement, such as channel@1 or model-provider@2): what each is for, whether it takes one provider or several, and whether an extension enabled in this org provides it (org admins also get the providers' plugin names).",
        input: NoInput,
        example: {},
        authz: { orgAction: "org.extensions.read" },
        mirrors: [],
        confirm: "read",
        run: async (_input, ctx) => {
          const providers = new Map<string, string[]>();
          for (const v of await this.configs.list(ctx.orgId)) {
            if (!v.enabled || !v.available) continue;
            for (const ref of providesOf(v)) {
              let name: string;
              try {
                name = parseExtensionPoint(ref).name;
              } catch {
                continue;
              }
              providers.set(name, [...(providers.get(name) ?? []), v.plugin]);
            }
          }
          // provider names only for those who manage extensions, as `GET extension-points` (the
          // members' `available` route gives no names)
          const role = await roleOf(this.kdb.db, ctx.orgId, ctx.actorAccountId);
          const names = role !== null && can(role, "org.extensions.manage");
          return {
            points: Object.entries(EXTENSION_POINTS).map(([name, p]) => ({
              name,
              description: p.description,
              cardinality: p.cardinality,
              ...(names
                ? { providers: providers.get(name) ?? [] }
                : { hasProvider: providers.has(name) }),
            })),
          };
        },
      }),
    ]);
  }
}
