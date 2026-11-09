import {
  defineExtension,
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewProvider,
} from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/**
 * A `file-preview@1` provider with two previewers: `txt` (a view previewer) and `old` (an embed
 * previewer whose contribution `old-embed` names `file.preview@2`, a slot version the catalog does
 * not have). The contribution is dropped at load, so `old` is left out and the extension still
 * loads with `txt` (UI slots spec §3.2).
 */
export default defineExtension({
  name: "ui-preview-dropped",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [FILE_PREVIEW_EXTENSION_POINT],
  ui: [
    {
      id: "old-embed",
      title: t("旧预览", "Old preview"),
      slot: "file.preview@2",
      kind: "embed",
      path: "/ui/old",
    },
  ],
  permissions: {
    http: [{ method: "GET", path: "/ui/old" }],
    ui: { embeds: ["old-embed"] },
  },
  setup(ctx) {
    const provider: FilePreviewProvider = {
      previewers: [
        {
          id: "txt",
          title: t("文本", "Text"),
          accepts: { extensions: [".txt"] },
          maxBytes: 1024,
          async render() {
            return { blocks: [{ type: "text", markdown: "txt" }] };
          },
        },
        {
          id: "old",
          title: t("旧", "Old"),
          accepts: { extensions: [".txt"] },
          maxBytes: 1024,
          embed: "old-embed",
        },
      ],
    };
    ctx.provide(FILE_PREVIEW_EXTENSION_POINT, provider);
    ctx.http.route("GET", "/ui/old", async () => new Response("old"));
  },
});
