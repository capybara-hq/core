import {
  defineExtension,
  FILE_PREVIEW_EXTENSION_POINT,
  type FilePreviewArgs,
  type FilePreviewProvider,
  type UiView,
} from "@capybara-hq/plugin-sdk";

/** Test observation point (single-replica tests in the same process). */
export interface PreviewProbeState {
  /** The last render's arguments without `read` / `signal`. */
  last?: Omit<FilePreviewArgs, "read" | "signal">;
  /** The grant of the last render, kept to call after the render returned. */
  read?: () => Promise<Uint8Array>;
  aborted: number;
}

const state = (): PreviewProbeState => {
  const g = globalThis as { __previewProbe?: PreviewProbeState };
  g.__previewProbe ??= { aborted: 0 };
  return g.__previewProbe;
};

const t = (zh: string, en: string) => ({ zh, en });

/**
 * A fake `file-preview@1` provider (no official plugin provides a previewer in UI refresh B):
 * - `docx`: a view previewer for `.docx` (1 MiB) that reads the bytes through the grant and echoes
 *   the count and the first bytes;
 * - `docx-page`: an embed previewer for `.docx` (ui contribution `docx-embed`, slot file.preview);
 * - `hang`: a view previewer for `.hang` that waits until the kernel aborts it;
 * - `decline`: a view previewer for `.decl` that needs the conversation, so it declines a share
 *   (throws on `source: "share"`);
 * - `html` (view) and `html-page` (embed, `docx-embed`) for `.html`: a share of an HTML snapshot
 *   never reaches them (the built-in wins);
 * - routes for the share embed tests: `GET /ui/claims` (`embed`: echoes the resolved caller) and
 *   `GET /ui/verify` (`public`: `ctx.ui.verifyEmbedToken` of the `x-token` header), and a
 *   `conversation.panel` embed (`panel-embed`) a share token must never verify for.
 */
export default defineExtension({
  name: "preview-fake",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [FILE_PREVIEW_EXTENSION_POINT],
  ui: [
    {
      id: "docx-embed",
      title: t("文档", "Document"),
      slot: "file.preview",
      kind: "embed",
      path: "/ui/docx",
    },
    {
      id: "panel-embed",
      title: t("面板", "Panel"),
      slot: "conversation.panel",
      kind: "embed",
      path: "/ui/panel",
    },
  ],
  permissions: {
    http: [
      { method: "GET", path: "/ui/docx", access: "public" },
      { method: "GET", path: "/ui/panel", access: "public" },
      { method: "GET", path: "/ui/claims", access: "embed" },
      { method: "GET", path: "/ui/verify", access: "public" },
    ],
    ui: { embeds: ["docx-embed", "panel-embed"] },
  },
  setup(ctx) {
    const provider: FilePreviewProvider = {
      previewers: [
        {
          id: "docx",
          title: t("文档（视图）", "Document (view)"),
          accepts: { extensions: [".docx"] },
          maxBytes: 1024 * 1024,
          async render(args): Promise<UiView> {
            const { read, signal: _signal, ...rest } = args;
            state().last = rest;
            state().read = read;
            const bytes = await read();
            const head = new TextDecoder().decode(bytes.subarray(0, 16));
            return { blocks: [{ type: "text", markdown: `${bytes.byteLength} ${head}` }] };
          },
        },
        {
          id: "docx-page",
          title: t("文档（页面）", "Document (page)"),
          accepts: {
            mimeTypes: ["application/vnd.openxmlformats-officedocument.*"],
            extensions: ["docx"],
          },
          maxBytes: 1024 * 1024,
          embed: "docx-embed",
        },
        {
          id: "hang",
          title: t("很慢", "Slow"),
          accepts: { extensions: [".hang"] },
          maxBytes: 1024,
          render(args) {
            args.signal.addEventListener("abort", () => {
              state().aborted++;
            });
            return new Promise<UiView>(() => {});
          },
        },
        {
          id: "decline",
          title: t("需要对话", "Needs the conversation"),
          accepts: { extensions: [".decl"] },
          maxBytes: 1024,
          async render(args): Promise<UiView> {
            if (args.source === "share") throw new Error("this previewer needs the conversation");
            return { blocks: [{ type: "text", markdown: args.conversationId }] };
          },
        },
        {
          id: "html",
          title: t("网页（视图）", "Web page (view)"),
          accepts: { extensions: [".html"] },
          maxBytes: 1024,
          async render(): Promise<UiView> {
            return { blocks: [{ type: "text", markdown: "html view" }] };
          },
        },
        {
          id: "html-page",
          title: t("网页（页面）", "Web page (page)"),
          accepts: { extensions: [".html"] },
          maxBytes: 1024,
          embed: "docx-embed",
        },
      ],
    };
    ctx.provide(FILE_PREVIEW_EXTENSION_POINT, provider);
    ctx.http.route("GET", "/ui/docx", async () => new Response("docx page"));
    ctx.http.route("GET", "/ui/panel", async () => new Response("panel page"));
    ctx.http.route("GET", "/ui/claims", async (_req, caller) => Response.json(caller));
    ctx.http.route("GET", "/ui/verify", async (req) =>
      Response.json({ claims: await ctx.ui.verifyEmbedToken(req.headers.get("x-token") ?? "") }),
    );
  },
});
