import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import { z } from "zod";
import {
  PlatformIconBody,
  PlatformIconParams,
  type PlatformIconPurpose,
} from "../../themes/platform-icon.schemas.js";
import { PlatformIconService } from "../../themes/platform-icon.service.js";
import { defineOperation } from "../operation.js";
import { PlatformOperations } from "../registry.js";
import { precheckBy, viaAgent } from "./errors.js";

const SetIconInput = PlatformIconParams.merge(PlatformIconBody).strict();
const ClearIconInput = PlatformIconParams.strict();

/** The card's name of an icon purpose. */
const NAMES: Record<PlatformIconPurpose, { zh: string; en: string }> = {
  app: { zh: "应用图标", en: "app icon" },
  maskable: { zh: "可遮罩应用图标", en: "maskable app icon" },
  favicon: { zh: "网站图标（SVG）", en: "SVG favicon" },
};

/**
 * The platform icon setting through the `Platform` tool (mobile layout spec §10.2.1): the list,
 * upload and restore of `/api/v1/admin/platform/icons*`, run through the same service. The public
 * read of the bytes is a transport exclusion.
 */
@Injectable()
export class PlatformIconsOperations implements OnModuleInit {
  constructor(
    @Inject(PlatformOperations) private readonly registry: PlatformOperations,
    @Inject(PlatformIconService) private readonly icons: PlatformIconService,
  ) {}

  onModuleInit(): void {
    this.registry.register([
      defineOperation({
        id: "admin.icons",
        description:
          "List the platform icons the super admin uploaded: the app icon (app), its maskable variant (maskable) and the SVG favicon (favicon), each with its public URL, SHA-256 and when it was set. The installed web app, the browser tab and the native clients use them; a purpose not listed uses the built-in Capybara icon.",
        input: z.object({}).strict(),
        example: {},
        authz: { superAdmin: true },
        mirrors: ["GET /api/v1/admin/platform/icons"],
        confirm: "read",
        run: () => this.icons.list(),
      }),
      defineOperation<z.infer<typeof SetIconInput>>({
        id: "admin.set-icon",
        description:
          "Upload a platform icon (super admin), given as standard base64 of the file, at most 1 MiB: app and maskable take a PNG (image/png) of exactly 512 × 512 pixels (maskable keeps its subject inside the central 80 % safe zone); favicon takes an SVG (image/svg+xml) of at most 128 KiB with a viewBox and no script, style element or external reference. It replaces the purpose's previous upload for every org and every installed app. The platform audit log records it.",
        input: SetIconInput,
        example: { purpose: "app", contentType: "image/png", dataBase64: "iVBORw0KGgo..." },
        authz: { superAdmin: true },
        mirrors: ["PUT /api/v1/admin/platform/icons/:purpose"],
        confirm: "platform",
        errors: [
          {
            code: "platform_icon.invalid_type",
            next: "Send app and maskable as a PNG (image/png) and favicon as an SVG (image/svg+xml) with a viewBox and no script; the message says what was wrong.",
          },
          {
            code: "platform_icon.invalid_size",
            next: "Resize the PNG to exactly 512 × 512 pixels and upload it again.",
          },
          {
            code: "platform_icon.too_large",
            next: "Make the file at most 1 MiB (1048576 bytes), an SVG favicon at most 128 KiB (131072 bytes), and upload it again.",
          },
          {
            code: "platform_icon.storage_unavailable",
            next: {
              superAdmin:
                "This deployment has no object storage: install and configure an object-store plugin in the admin console, then upload again.",
              member: "This deployment has no object storage; ask the super admin to set one up.",
            },
          },
        ],
        precheck: (i) => precheckBy(() => this.icons.check(i.purpose, i.contentType, i.dataBase64)),
        summary: async (i) => {
          const n = NAMES[i.purpose];
          const bytes = Math.floor((i.dataBase64.length * 3) / 4);
          return {
            zh: `把平台的${n.zh}换成上传的文件（约 ${bytes} 字节），所有组织和已安装的应用都会使用它`,
            en: `Replace the platform ${n.en} with the uploaded file (about ${bytes} bytes); every org and installed app uses it`,
          };
        },
        run: (i, ctx) =>
          this.icons.set(
            i.purpose,
            i.contentType,
            i.dataBase64,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.set-icon", ctx),
          ),
      }),
      defineOperation<z.infer<typeof ClearIconInput>>({
        id: "admin.clear-icon",
        description:
          "Restore the built-in Capybara icon for one platform icon purpose (super admin): app, maskable or favicon. The uploaded file is deleted. The platform audit log records it.",
        input: ClearIconInput,
        example: { purpose: "maskable" },
        authz: { superAdmin: true },
        mirrors: ["DELETE /api/v1/admin/platform/icons/:purpose"],
        confirm: "platform",
        summary: async (i) => {
          const n = NAMES[i.purpose];
          return {
            zh: `把平台的${n.zh}恢复为内置的 Capybara 图标`,
            en: `Restore the built-in Capybara ${n.en} for the platform`,
          };
        },
        run: async (i, ctx) => {
          const cleared = await this.icons.clear(
            i.purpose,
            { accountId: ctx.actorAccountId },
            viaAgent("admin.clear-icon", ctx),
          );
          return { purpose: i.purpose, cleared };
        },
      }),
    ]);
  }
}
