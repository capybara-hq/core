import { defineExtension, type UiView } from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/**
 * Component contributions (client extensions spec §5): `hud` in `conversation.properties.section`
 * with a server view and action answering `data`; the single slots `shell.brand` (`brand`),
 * `conversation.empty` (`empty`) and `conversation.composer.frame` (`frame`), `brand` with a server
 * view answering `data: { n: 3 }`; `fx` in the list slot
 * `shell.overlay`; a component card `card` that the tool `ping` returns; `agentx` in the agent-scoped
 * `agent.detail.section` and `pagex` in the org-scoped list slot `org.page`, both with a server view
 * answering `data` (`{ n: 4 }`, `{ n: 5 }`). `plain` is an ordinary view
 * whose render and action answer `data` too (refused: only a component's view may carry it). The
 * client entry is `src/client.tsx`; loaded as a directory fixture it carries no package section.
 */
export default defineExtension({
  name: "ui-components",
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
    {
      id: "card",
      title: t("卡片", "Card"),
      slot: "conversation.tool-result.card",
      kind: "component",
    },
    {
      id: "agentx",
      title: t("智能体", "Agent extra"),
      slot: "agent.detail.section",
      kind: "component",
    },
    { id: "pagex", title: t("页面", "Page extra"), slot: "org.page", kind: "component" },
    {
      id: "plain",
      title: t("普通", "Plain"),
      slot: "conversation.properties.section",
      kind: "view",
    },
  ],
  permissions: {
    client: true,
    ui: {
      views: ["plain"],
      components: ["hud", "brand", "empty", "frame", "fx", "card", "agentx", "pagex"],
    },
    tools: ["ping"],
  },
  setup(ctx) {
    ctx.tools.register(
      {
        name: "ping",
        description: "Answers pong with a component card.",
        inputSchema: { type: "object", properties: {} },
        defaultPolicy: "allow",
      },
      async () => ({ content: [{ type: "text", text: "pong" }], card: { view: "card" } }),
    );
    const withData = (n: number): UiView => ({ blocks: [], data: { n } });
    ctx.ui.view("hud", async () => withData(1));
    // a single slot's component may have a server view too; it is served whoever wins the slot
    ctx.ui.view("brand", async () => withData(3));
    ctx.ui.action("hud", async () => ({ view: withData(2) }));
    ctx.ui.view("agentx", async () => withData(4));
    ctx.ui.view("pagex", async () => withData(5));
    ctx.ui.view("plain", async () => withData(1));
    ctx.ui.action("plain", async () => ({ view: withData(2) }));
  },
});
