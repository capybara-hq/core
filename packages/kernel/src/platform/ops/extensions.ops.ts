import { EXTENSION_POINTS, parseExtensionPoint, ToolError } from "@capybara-hq/plugin-sdk";
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
import { configChanges, flatValues, withPersonInputs } from "./person-inputs.js";
import { roleOf } from "./role.js";
import { localized, named, orElse } from "./summary.js";
import { roleFor, unavailableFields } from "./unavailable.js";

const NoInput = z.object({}).strict();

const Extension = OrgExtensionParams.shape.extension;
const Tool = OrgExtensionToolParams.shape.tool;
const SwitchConfirm = OrgToolSwitchPut.shape.confirm.unwrap();
const Force = OrgExtensionPut.shape.force;

/**
 * Why `extensions.set-enabled` does not switch an extension that ships in one catalog plugin: that
 * switch is the plugin's (with its uninstall preview), `plugins.set-enabled`.
 */
const viaPlugin = (extension: string, itemId: string): string =>
  `Extension ${extension} ships in a catalog plugin, whose switch it is: switch the plugin with plugins.set-enabled (itemId ${itemId}; switching off takes the confirm value of plugins.disable-preview).`;

/** The next step of an extension that needs its org config. */
const NEEDS_ORG_CONFIG = {
  orgAdmin:
    "Read what is missing with extensions.org-config, then fill in the org's own copy of the overridable fields with extensions.save-org-config; the person enters secrets in a secure input request.",
  member: "Ask an org admin to fill in its org config on the Extensions page.",
};

/** What `extensions.set-enabled` adds when the extension is on but its org config is not valid. */
const CONFIG_NEEDED = `The extension is on, but has no valid config for this org yet and gets no calls until it does: ${NEEDS_ORG_CONFIG.orgAdmin} If only platform-only fields are missing, the super admin must set them.`;

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

/**
 * The person fields of the org's copy: the copy's own secrets (under the listed overridable
 * top-level fields), set or not. A secret under any other field is not the org's to set: never
 * asked, and a value for it in `values` is refused as well.
 */
export function copyPersonFields(
  v: OrgOverrideView,
): Pick<PersonFieldTarget, "fields" | "recordOnly"> {
  const secrets = v.fields.filter((f) => f.secret);
  const stored = new Set(secrets.filter((f) => f.org?.set === true).map((f) => f.path));
  // levels are per top-level property (org-levels.ts)
  const top = (path: string) => path.split(/[.[]/)[0] as string;
  // the view lists overridable fields only
  const overridable = new Set(v.fields.map((f) => top(f.path)));
  const found = secretFieldsOf(v.schema, stored);
  const fields = found.fields.filter((f) => overridable.has(top(f.path)));
  const notOurs = found.fields.filter((f) => !overridable.has(top(f.path))).map((f) => f.path);
  return withUnaddressed(
    { fields, recordOnly: [...found.recordOnly, ...notOurs] },
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
 * defaults, and for org admins the org's copy of overridable platform fields (read, take, save,
 * drop; platform web parity spec §7.2). Secrets are never returned (only
 * whether each is set) and never taken as params: the person enters them in a secure input request.
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

  /**
   * Why `extensions.set-enabled` refuses the switch before writing, or null: an extension of one
   * catalog plugin is switched through its plugin; a required or builtin one cannot go off. The
   * write itself repeats every rule ({@link OrgExtensionSwitch.put}).
   */
  private async switchRefusal(
    orgId: string,
    extension: string,
    enabled: boolean,
  ): Promise<{ code: string; message: string } | null> {
    const v = await this.viewOf(orgId, extension);
    const plan = await this.configs.switchPlan(extension, enabled);
    if (plan.kind === "item") {
      return { code: "extension.switch_via_plugin", message: viaPlugin(extension, plan.itemId) };
    }
    if (!enabled && v.required) {
      return {
        code: "extension.required",
        message: `Extension ${extension} is required: it is on in every organization`,
      };
    }
    if (!enabled && plan.kind === "locked") {
      return {
        code: "plugin.scope_locked",
        message: `Extension ${extension} is built in: it is on in every organization`,
      };
    }
    return null;
  }

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
          "List the extensions installed on the platform as this org sees them, one compact row each: the state here (on, off, needs_config: its config for this org is not valid, unavailable: it cannot run on the platform), why an unavailable one cannot be used (reason) and your next step (next), whether it is available on the platform, the extension points it provides and the plugin that brings it. State only: an org admin reads the config with extensions.org-config and sets the org's copy with extensions.save-org-config. Pages by 50: pass the returned next as params.cursor.",
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
        id: "extensions.set-enabled",
        description:
          "Switch an extension that is not a catalog plugin's on or off in this org (org admins): one declared in the deployment config, or one several catalog plugins bring. An extension shipped in one catalog plugin is switched with plugins.set-enabled; extensions.list shows its catalogItemId. Switching on never waits for config: an extension with no valid config for the org is switched on anyway and the result's configNeeded says how to fill in the org's copy (extensions.save-org-config). Switching off is refused while other enabled extensions depend on it, unless force is true (they lose what they depend on).",
        input: z.object({ extension: Extension, enabled: z.boolean(), force: Force }).strict(),
        example: { extension: "web-search-tavily", enabled: true },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/extensions/:extension"],
        // the confirm of a catalog plugin's switch-off: that switch is plugins.set-enabled's
        omits: ["confirm"],
        confirm: "org",
        errors: [
          {
            code: "extension.not_found",
            next: "The extension is not running or not visible to this org; check the name with extensions.list.",
          },
          {
            code: "extension.switch_via_plugin",
            next: "Switch its plugin with plugins.set-enabled (the itemId is extensions.list's catalogItemId).",
          },
          {
            code: "extension.required",
            next: "The extension is required on the platform and stays on in every org.",
          },
          {
            code: "plugin.scope_locked",
            next: "The extension's plugin is built in: it is on in every org and cannot be switched off in one org.",
          },
          {
            code: "extension.dependency_missing",
            next: "The extension needs an extension point no enabled extension provides in this org (the details name it); switch on a provider first (extensions.points, extensions.list).",
          },
          {
            code: "extension.has_dependents",
            next: "Other enabled extensions depend on it (the details name them): switch those off first, or call again with force: true after the person agreed that they lose it.",
          },
          {
            code: "plugin.disabled",
            next: {
              superAdmin:
                "The plugin is stopped on the platform: turn it back on in the admin console under Plugins, then call again.",
              orgAdmin: "The super admin stopped this plugin on the platform; ask them.",
              member:
                "The super admin stopped this plugin on the platform; tell your org admin, who can ask the super admin.",
            },
          },
          {
            code: "catalog.approval_required",
            next: "A plugin that brings the extension is not offered to this org: create an access request with requests.create.",
          },
        ],
        precheck: async (i, ctx) => {
          const found: { refusal: { code: string; message: string } | null } = { refusal: null };
          const r = await precheckBy(async () => {
            found.refusal = await this.switchRefusal(ctx.orgId, i.extension, i.enabled);
          });
          if (!r.ok) return r;
          return found.refusal === null ? { ok: true } : { ok: false, ...found.refusal };
        },
        summary: async (i) => {
          const x = await this.nameOf(i.extension);
          if (i.enabled) {
            return {
              zh: `在本组织启用扩展「${x.zh}」`,
              en: `Enable extension "${x.en}" in the org`,
            };
          }
          return i.force === true
            ? {
                zh: `在本组织强制停用扩展「${x.zh}」：依赖它的扩展将失去依赖`,
                en: `Force-disable extension "${x.en}" in the org: extensions that depend on it lose it`,
              }
            : { zh: `在本组织停用扩展「${x.zh}」`, en: `Disable extension "${x.en}" in the org` };
        },
        run: async (input, ctx) => {
          const refusal = await this.switchRefusal(ctx.orgId, input.extension, input.enabled);
          if (refusal?.code === "extension.switch_via_plugin") throw new ToolError(refusal.message);
          const r = await this.extSwitch.put(
            ctx.orgId,
            ctx.actorAccountId,
            input.extension,
            { enabled: input.enabled, ...(input.force === true && { force: true }) },
            undefined,
            viaAgent("extensions.set-enabled", ctx),
          );
          // unreachable: only a catalog plugin's switch-off answers a preview, refused above
          if (r.kind === "preview") throw new Error("extensions.set-enabled: unexpected preview");
          const v = r.view;
          return {
            extension: v.plugin,
            state: stateOf(v),
            enabled: v.enabled,
            needsConfig: v.needsConfig,
            ...(v.enabled && v.needsConfig && { configNeeded: CONFIG_NEEDED }),
          };
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
          "Read an extension's config in this org (org admins): configurable (it has fields the org can override) and needsConfig (its config for this org is not valid); deploymentCopy is the org's side of the platform's deployment config: following the platform or a copy, the overridable fields (platform values, the copy's values, secrets as set or not, never a value) and whether the effective config is valid. deploymentCopy is null when the extension does not run on the platform.",
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
          // the state comes with the org extension list, the copy of the platform's overridable
          // fields from the overrides route
          const v = await this.viewOf(ctx.orgId, input.extension);
          return {
            extension: v.plugin,
            state: stateOf(v),
            configurable: v.configurable,
            needsConfig: v.needsConfig,
            deploymentCopy: v.available
              ? await this.overrides.view(ctx.orgId, input.extension)
              : null,
          };
        },
      }),
      defineOperation({
        id: "extensions.save-org-config",
        description:
          "Save fields of the org's own copy of an extension's platform deployment config (org admins): only overridable fields (extensions.org-config lists them under deploymentCopy). values maps field dot paths to values (null clears; a field left out keeps). Secret fields are never in values: list them in askPerson and the person types them in a secure input request (on the web); list stored secrets to empty in clearSecrets. The first save makes the copy from the platform's non-secret values and must be valid on its own (its required secrets are asked).",
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
        summary: async (i, ctx) => {
          const n = await this.nameOf(i.extension);
          const c = configChanges(i, ctx);
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
