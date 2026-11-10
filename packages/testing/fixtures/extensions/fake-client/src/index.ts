import { defineExtension, type UiView } from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/**
 * Test fake of a client extension (client extensions spec §5): one component in each of
 * `conversation.properties.section` (`hud`, server view answering `data: { n: 1 }`), `shell.brand`
 * (`brand`), `conversation.empty` (`empty`), `conversation.composer.frame` (`frame`) and
 * `shell.overlay` (`fx`). The browser side is `src/client.tsx` (components and an `events`
 * listener), `client/styles/fake.css` decorates by part and state, and the theme `fake` is the
 * plugin's `suggestedAppearance` together with `shell.brand` -> `brand`.
 */
export default defineExtension({
  name: "fake-client",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "hud",
      title: t("状态", "Status"),
      slot: "conversation.properties.section",
      kind: "component",
    },
    { id: "brand", title: t("品牌", "Brand"), slot: "shell.brand", kind: "component" },
    { id: "empty", title: t("问候", "Greeting"), slot: "conversation.empty", kind: "component" },
    {
      id: "frame",
      title: t("边框", "Frame"),
      slot: "conversation.composer.frame",
      kind: "component",
    },
    { id: "fx", title: t("特效", "Effects"), slot: "shell.overlay", kind: "component" },
  ],
  permissions: {
    client: true,
    ui: { components: ["hud", "brand", "empty", "frame", "fx"] },
  },
  setup(ctx) {
    const withData = (n: number): UiView => ({ blocks: [], data: { n } });
    ctx.ui.view("hud", async () => withData(1));
  },
});
