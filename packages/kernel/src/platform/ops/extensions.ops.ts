import { EXTENSION_POINTS, parseExtensionPoint } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  OrgExtensionParams,
  OrgExtensionPut,
  OrgExtensionToolParams,
  OrgOverridesPut,
  OrgOverridesTake,
  OrgToolSwitchPut,
} from "../../catalog/org-extension.schemas.js";
import { OrgExtensionSwitch } from "../../catalog/org-extension-switch.js";
import { ApiError } from "../../errors.js";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import {
  OrgExtensionConfigs,
  type OrgExtensionView,
  providesOf,
} from "../../extensions/org-config.js";
import { OrgOverrides, type OrgOverrideView } from "../../extensions/org-overrides.js";
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
import { type PersonFieldTarget, personFieldParams, secretFieldsOf } from "../person-fields.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";
import { Cursor, pageOf, startOf } from "./paging.js";
import { configChanges, flatValues, nestedConfig, withPersonInputs } from "./person-inputs.js";
import { roleOf } from "./role.js";
import { localized, named, orElse } from "./summary.js";
import { roleFor, unavailableFields } from "./unavailable.js";

const NoInput = z.object({}).strict();

const Extension = OrgExtensionParams.shape.extension;
const Tool = OrgExtensionToolParams.shape.tool;
const SwitchConfirm = OrgToolSwitchPut.shape.confirm.unwrap();

/** The next step of an extension that needs its org config. */
const NEEDS_ORG_CONFIG = {
  orgAdmin:
    "Read what is missing with extensions.org-config, then fill it in with extensions.set-org-config (or the org's own copy of overridable platform fields with extensions.save-org-config); the person enters secrets on the confirmation card.",
  member: "Ask an org admin to fill in its org config on the Extensions page.",
};

/** The org config a write replaces (the whole non-secret config; secrets left out keep). */
const OrgConfigValues = OrgExtensionPut.shape.config.unwrap();

/**
 * Secret fields of a target the schema walk cannot address (no form schema, a record): web only,
 * so a value for one in `values` is refused as well.
 */
function withUnaddressed(
  found: { fields: PersonFieldTarget["fields"]; recordOnly: string[] },
  secretPaths: readonly string[],
): Pick<PersonFieldTarget, "fields" | "recordOnly"> {
  const asked = new Set(found.fields.map((f) => f.path));
  return {
    fields: found.fields,
    recordOnly: [...new Set([...found.recordOnly, ...secretPaths.filter((p) => !asked.has(p))])],
  };
}

/** The person fields of the org's copy (overridable fields): the copy's own secrets, set or not. */
function copyPersonFields(v: OrgOverrideView): Pick<PersonFieldTarget, "fields" | "recordOnly"> {
  const secrets = v.fields.filter((f) => f.secret);
  const stored = new Set(secrets.filter((f) => f.org?.set === true).map((f) => f.path));
  return withUnaddressed(
    secretFieldsOf(v.schema, stored),
    secrets.map((f) => f.path),
  );
}

/** An extension's state in the org, as the Extensions page shows it. */
function stateOf(v: OrgExtensionView): "on" | "off" | "needs_config" | "unavailable" {
  if (!v.available) return "unavailable";
  if (v.needsConfig) return "needs_config";
  return v.enabled ? "on" : "off";
}

/**
 * Extension operations of the `Platform` tool (spec §7): the org's extensions (the member projection
 * of `GET /orgs/:orgId/extensions`, whatever the actor's role), their tool switches and point
 * defaults, and for org admins the org config and the org's copy of overridable platform fields
 * (read, write, take, save, drop; platform web parity spec §7.2). Secrets are never returned (only
 * whether each is set) and never taken as params: the person enters them on the confirmation card.
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
    @Inject(OrgOverrides) private readonly overrides: OrgOverrides,
    @Inject(OrgExtensionSwitch) private readonly extSwitch: OrgExtensionSwitch,
  ) {}

  /** The org view of one extension, or `extension.not_found` (not installed or not offered). */
  private async viewOf(orgId: string, name: string): Promise<OrgExtensionView> {
    const v = (await this.configs.list(orgId)).find((x) => x.plugin === name);
    if (v === undefined) {
      throw new ApiError("extension.not_found", `Extension ${name} is not installed`);
    }
    return v;
  }

  /** An extension's display name for a card (its plugin's), else the name, clipped. */
  private async nameOf(name: string): Promise<{ zh: string; en: string }> {
    return orElse(
      async () => localized((await this.displayNames.many([name])).get(name), name),
      localized(null, name),
    );
  }

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "extensions.list",
        description:
          "List the extensions installed on the platform as this org sees them, one compact row each: the state here (on, off, needs_config: the org config is missing, unavailable: it cannot run on the platform), why an unavailable one cannot be used (reason) and your next step (next), whether it is available on the platform, the extension points it provides and the plugin that brings it. State only: an org admin reads and sets the config with extensions.org-config and extensions.set-org-config. Pages by 50: pass the returned next as params.cursor.",
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
          "Preview turning one extension tool off in this org (org admins): the org's agents that have it (every agent that does not turn it off), and the confirm value extensions.set-tool-enabled needs. Show the preview to the person before turning it off.",
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
          const x = await this.nameOf(i.extension);
          if (i.enabled) {
            return {
              zh: `在本组织开启扩展「${x.zh}」的工具 ${named(i.tool)}`,
              en: `Turn on tool ${named(i.tool)} of extension "${x.en}" in the org`,
            };
          }
          const p = await this.switches.previewOff(ctx.orgId, i.extension, i.tool);
          const n = p?.affectedAgents.length ?? 0;
          return {
            zh: `在本组织关闭扩展「${x.zh}」的工具 ${named(i.tool)}：${n} 个智能体选用了它`,
            en: `Turn off tool ${named(i.tool)} of extension "${x.en}" in the org: ${n} agents selected it`,
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
        id: "extensions.org-config",
        description:
          "Read an extension's config in this org (org admins): orgConfig is the org's own config (the non-secret values, whether each secret is set, never its value, the form's JSON Schema with x-secret on secret fields, and needsConfig); deploymentCopy is the org's side of the platform's deployment config: following the platform or a copy, the read-only and overridable fields (platform values, the copy's values, secrets as set or not) and whether the effective config is valid. Null when the extension does not run on the platform.",
        input: z.object({ extension: Extension }).strict(),
        example: { extension: "model-anthropic" },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/extensions/:extension/overrides"],
        confirm: "read",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
        ],
        run: async (input, ctx) => {
          const v = await this.viewOf(ctx.orgId, input.extension);
          return {
            extension: v.plugin,
            state: stateOf(v),
            orgConfig: {
              configurable: v.configurable,
              config: v.config,
              secrets: v.secrets,
              schema: v.orgConfigSchema,
              needsConfig: v.needsConfig,
            },
            deploymentCopy: v.available
              ? await this.overrides.view(ctx.orgId, input.extension)
              : null,
          };
        },
      }),
      defineOperation({
        id: "extensions.set-org-config",
        description:
          "Save an extension's org config (org admins): values is the whole non-secret config and replaces the stored one (read it first with extensions.org-config and keep the fields you do not change). Secret fields are never in values: list them in askPerson and the person types them on the confirmation card (on the web); a secret not listed keeps its stored value; list stored secrets to empty in clearSecrets. Required secrets without a stored value are asked even when not listed. For overridable fields of the platform's deployment config (an org's own API key for a model provider, say) use extensions.save-org-config. Switching the extension on is plugins.set-enabled.",
        input: z
          .object({
            extension: Extension,
            values: OrgConfigValues,
            askPerson: personFieldParams.askPerson,
            clearSecrets: personFieldParams.clearSecrets,
          })
          .strict(),
        example: {
          extension: "lark",
          values: { appId: "cli_a1b2c3" },
          askPerson: ["appSecret"],
          clearSecrets: [],
        },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/extensions/:extension"],
        renames: { values: "config" },
        // switching on and off is plugins.set-enabled (its preview and confirm)
        omits: ["enabled", "force", "confirm"],
        extras: ["askPerson", "clearSecrets"],
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          {
            code: "extension.no_org_config",
            next: "This extension has no org config. Its overridable platform fields, if any, are set with extensions.save-org-config.",
          },
          {
            code: "extension.config_invalid",
            next: "Read the form schema with extensions.org-config, correct the values (the error's details name the fields), then call again.",
          },
        ],
        personFields: async (i, ctx) => {
          const v = await this.viewOf(ctx.orgId, i.extension);
          const n = await this.nameOf(i.extension);
          const stored = new Set(v.secrets.filter((x) => x.set).map((x) => x.path));
          return {
            target: { zh: `扩展「${n.zh}」的组织配置`, en: `${n.en}: org config` },
            ...withUnaddressed(
              secretFieldsOf(v.orgConfigSchema, stored),
              v.secrets.map((x) => x.path),
            ),
          };
        },
        summary: async (i) => {
          const n = await this.nameOf(i.extension);
          const c = configChanges(i.values, i.askPerson, i.clearSecrets);
          return {
            zh: `保存扩展「${n.zh}」的组织配置：${c.zh}`,
            en: `Save the org config of extension "${n.en}": ${c.en}`,
          };
        },
        run: async (input, ctx) => {
          const r = await withPersonInputs("extensions.set-org-config", ctx, (entered, detail) =>
            this.extSwitch.put(
              ctx.orgId,
              ctx.actorAccountId,
              input.extension,
              { config: nestedConfig(input.values, entered, input.clearSecrets) },
              undefined,
              detail,
            ),
          );
          // a config-only write never previews (only switching off does)
          if (r.kind !== "done") return { applied: false };
          const v = r.view;
          return {
            extension: v.plugin,
            state: stateOf(v),
            config: v.config,
            secrets: v.secrets,
          };
        },
      }),
      defineOperation({
        id: "extensions.save-org-config",
        description:
          "Save fields of the org's own copy of an extension's platform deployment config (org admins): only overridable fields (extensions.org-config lists them under deploymentCopy). values maps field dot paths to values (null clears; a field left out keeps). Secret fields are never in values: list them in askPerson and the person types them on the confirmation card (on the web); list stored secrets to empty in clearSecrets. The first save makes the copy from the platform's non-secret values and must be valid on its own (its required secrets are asked).",
        input: z
          .object({
            extension: Extension,
            values: OrgOverridesPut.shape.values.default({}),
            askPerson: personFieldParams.askPerson,
            clearSecrets: personFieldParams.clearSecrets,
          })
          .strict(),
        example: {
          extension: "model-anthropic",
          values: {},
          askPerson: ["apiKey"],
          clearSecrets: [],
        },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/extensions/:extension/overrides"],
        // secret record entries are entered on the web page (ruling R1)
        omits: ["secretEntries"],
        extras: ["askPerson", "clearSecrets"],
        loosens: {
          values: "defaults to {} so a call that only asks the person for secrets needs no values",
        },
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          {
            code: "extension.field_not_overridable",
            next: "Only overridable fields go into the org's copy; extensions.org-config lists them under deploymentCopy.",
          },
          {
            code: "extension.config_invalid",
            next: "Read the fields with extensions.org-config, correct the values (the error's details name the fields), then call again.",
          },
        ],
        personFields: async (i, ctx) => {
          const n = await this.nameOf(i.extension);
          return {
            target: { zh: `扩展「${n.zh}」的组织配置副本`, en: `${n.en}: the org's config copy` },
            ...copyPersonFields(await this.overrides.view(ctx.orgId, i.extension)),
          };
        },
        summary: async (i) => {
          const n = await this.nameOf(i.extension);
          const c = configChanges(i.values, i.askPerson, i.clearSecrets);
          return {
            zh: `保存本组织对扩展「${n.zh}」平台配置的副本：${c.zh}`,
            en: `Save the org's copy of the platform config of extension "${n.en}": ${c.en}`,
          };
        },
        run: async (input, ctx) =>
          withPersonInputs("extensions.save-org-config", ctx, (entered, detail) =>
            this.overrides.save(
              ctx.orgId,
              input.extension,
              flatValues(input.values, entered, input.clearSecrets),
              [],
              { accountId: ctx.actorAccountId, auditDetail: detail },
            ),
          ),
      }),
      defineOperation({
        id: "extensions.take-org-config",
        description:
          "Take the platform's current values of non-secret overridable fields into the org's copy of an extension's deployment config (org admins); the org keeps its copy. paths are field dot paths from extensions.org-config.",
        input: z.object({ extension: Extension, paths: OrgOverridesTake.shape.paths }).strict(),
        example: { extension: "model-anthropic", paths: ["baseUrl"] },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["POST /api/v1/orgs/:orgId/extensions/:extension/overrides/take"],
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          {
            code: "extension.no_org_override",
            next: "The org follows the platform (no copy), so it has the platform's values already.",
          },
          {
            code: "extension.field_not_overridable",
            next: "Only non-secret overridable fields can be taken; extensions.org-config lists them under deploymentCopy.",
          },
        ],
        summary: async (i) => {
          const n = await this.nameOf(i.extension);
          const paths = i.paths.map(named);
          return {
            zh: `把平台的 ${paths.join("、")} 取到本组织对扩展「${n.zh}」的配置副本`,
            en: `Take the platform's ${paths.join(", ")} into the org's config copy of extension "${n.en}"`,
          };
        },
        run: async (input, ctx) =>
          this.overrides.take(ctx.orgId, input.extension, input.paths, {
            accountId: ctx.actorAccountId,
            auditDetail: viaAgent("extensions.take-org-config", ctx),
          }),
      }),
      defineOperation({
        id: "extensions.drop-org-config",
        description:
          "Drop the org's copy of an extension's deployment config, its secrets too (org admins): the org follows the platform's config again.",
        input: z.object({ extension: Extension }).strict(),
        example: { extension: "model-anthropic" },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["DELETE /api/v1/orgs/:orgId/extensions/:extension/overrides"],
        confirm: "org",
        rememberable: false,
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          {
            code: "extension.no_org_override",
            next: "The org follows the platform already; there is no copy to drop.",
          },
        ],
        summary: async (i) => {
          const n = await this.nameOf(i.extension);
          return {
            zh: `删除本组织对扩展「${n.zh}」的配置副本（含其密钥），改为跟随平台`,
            en: `Drop the org's config copy of extension "${n.en}" (its secrets too) and follow the platform`,
          };
        },
        run: async (input, ctx) =>
          this.overrides.reset(ctx.orgId, input.extension, {
            accountId: ctx.actorAccountId,
            auditDetail: viaAgent("extensions.drop-org-config", ctx),
          }),
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
        summary: async (i) => {
          const x = await this.nameOf(i.extension);
          return {
            zh: `把本组织 ${named(i.point)} 的默认提供者设为扩展「${x.zh}」`,
            en: `Set the org's default provider of ${named(i.point)} to extension "${x.en}"`,
          };
        },
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
