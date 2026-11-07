import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import { type OrgPreviewerItem, PreviewerRegistry } from "../../files/previewers.js";
import { FilePreviewersOrderBody } from "../../files/previewers.schemas.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { viaAgent } from "./errors.js";
import { named } from "./summary.js";

const Item = FilePreviewersOrderBody.shape.items.element;

const row = (p: OrderedItem) => ({
  id: `${p.plugin}/${p.id}`,
  name: p.title.en,
  state: p.disabled ? "disabled" : "enabled",
  plugin: p.plugin,
  kind: p.kind,
  position: p.position,
});

type OrderedItem = OrgPreviewerItem;

/**
 * File previewer operations (the `extensions` domain): the org's order of the previewers its
 * extensions provide and which are off (org admins, `org.extensions.manage`). Rendering a preview
 * is the web's (`transport`).
 */
@Injectable()
export class PreviewersOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(PreviewerRegistry) private readonly previewers: PreviewerRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "extensions.previewers",
        description:
          "List the file previewers of the org's enabled extensions in the org's order (org admins): which extension provides each, its kind and whether the org switched it off. The first previewer that takes a file opens it.",
        input: z.object({}).strict(),
        example: {},
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["GET /api/v1/orgs/:orgId/file-previewers"],
        confirm: "read",
        run: async (_input, ctx) => {
          const items = await this.previewers.list(ctx.orgId);
          return { items: items.map(row), total: items.length };
        },
      }),
      defineOperation({
        id: "extensions.set-previewers",
        description:
          "Set the org's order of file previewers and which are off (org admins): items lists { plugin, id, disabled } first to last, and previewers not listed follow in their usual order. Read the current list with extensions.previewers first; an item that is not a previewer of an enabled extension, or is listed twice, is refused.",
        input: z
          .object({
            items: z.array(Item.strict()).max(500),
          })
          .strict(),
        example: { items: [{ plugin: "viewer-markdown", id: "markdown", disabled: false }] },
        authz: { orgAction: "org.extensions.manage" },
        mirrors: ["PUT /api/v1/orgs/:orgId/file-previewers"],
        confirm: "org",
        errors: [
          {
            code: "validation_failed",
            next: "An item is not a previewer of an extension enabled in this org, or is listed twice; take plugin and id from extensions.previewers.",
          },
        ],
        precheck: async (i, ctx) => {
          const known = new Set(
            (await this.previewers.list(ctx.orgId)).map((p) => `${p.plugin}/${p.id}`),
          );
          const seen = new Set<string>();
          for (const x of i.items) {
            const k = `${x.plugin}/${x.id}`;
            if (!known.has(k) || seen.has(k)) {
              return {
                ok: false,
                code: "validation_failed",
                message: `${k} is not a previewer of an extension enabled in this organization, or is listed twice`,
              };
            }
            seen.add(k);
          }
          return { ok: true };
        },
        summary: (i) => {
          const off = i.items.filter((x) => x.disabled).map((x) => `${x.plugin}/${x.id}`);
          const first = i.items.slice(0, 3).map((x) => named(`${x.plugin}/${x.id}`));
          return {
            zh: `设置文件预览器的顺序：${i.items.length} 项在前（${first.join("、") || "无"}${i.items.length > 3 ? "…" : ""}），其中 ${off.length} 项关闭`,
            en: `Set the order of file previewers: ${i.items.length} first (${first.join(", ") || "none"}${i.items.length > 3 ? ", …" : ""}), ${off.length} of them switched off`,
          };
        },
        run: async (input, ctx) => {
          const items = await this.previewers.put(
            ctx.orgId,
            input.items,
            { accountId: ctx.actorAccountId },
            viaAgent("extensions.set-previewers", ctx),
          );
          return { items: items.map(row), total: items.length };
        },
      }),
    ]);
  }
}
