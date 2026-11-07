import { EXTENSION_POINTS, parseExtensionPoint } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { ExtensionDisplayNames } from "../../extensions/display-name.js";
import { OrgExtensionConfigs, providesOf } from "../../extensions/org-config.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";

const NoInput = z.object({}).strict();

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
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "extensions.list",
        description:
          "List the extensions installed on the platform as this org sees them: whether each is enabled here, available on the platform, required, which plugin brings it and which extension points it provides. State only: configuring one is done on the web.",
        input: NoInput,
        example: {},
        authz: { orgAction: "org.extensions.read" },
        mirrors: ["GET /api/v1/orgs/:orgId/extensions"],
        confirm: "read",
        run: async (_input, ctx) => {
          const views = await this.configs.list(ctx.orgId);
          const names = await this.displayNames.many(views.map((v) => v.plugin));
          return {
            extensions: views.map((v) => ({
              plugin: v.plugin,
              displayName: names.get(v.plugin) ?? null,
              version: v.version,
              enabled: v.enabled,
              available: v.available,
              required: v.required,
              configurable: v.configurable,
              switchable: v.switchable,
              catalogItem: v.catalogItem,
              provides: providesOf(v),
            })),
          };
        },
      }),
      defineOperation({
        id: "extensions.points",
        description:
          "List the extension points of the platform (the contracts extensions implement, such as channel@1 or model-provider@2): what each is for, whether it takes one provider or several, and the extensions enabled in this org that provide it.",
        input: NoInput,
        example: {},
        authz: { orgAction: "org.read" },
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
          return {
            points: Object.entries(EXTENSION_POINTS).map(([name, p]) => ({
              name,
              description: p.description,
              cardinality: p.cardinality,
              providers: providers.get(name) ?? [],
            })),
          };
        },
      }),
    ]);
  }
}
