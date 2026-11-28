import { defineExtension, type JsonValue, UI_LIMITS } from "@capybara-hq/plugin-sdk";

const t = (zh: string, en: string) => ({ zh, en });

/** What the fake records for tests on `globalThis.__fakeClientPage` (in-process kernels only). */
export interface FakeClientPageProbe {
  /** How many `slow` queries saw their signal abort. */
  aborted: number;
}

/** The probe of {@link FakeClientPageProbe}. */
export function fakeClientPageProbe(): FakeClientPageProbe {
  const g = globalThis as { __fakeClientPage?: FakeClientPageProbe };
  g.__fakeClientPage ??= { aborted: 0 };
  return g.__fakeClientPage;
}

const items = () => [
  { id: "a", title: "Alpha", column: "todo" },
  { id: "b", title: "Beta", column: "doing" },
];

/**
 * Test fake of a full page (plugin full pages spec §3-§4): the `org.page` component `board`
 * (`frame: "page"`, `nav: "primary"`) with the named queries `items` (the items, the params and
 * the identity it was called with), `slow` (answers only by rejecting once its signal aborts),
 * `boom` (throws) and `huge` (a result over `UI_LIMITS.componentQueryBytes`); its action `move`
 * accepts a form-sized payload, calls `ctx.ui.invalidate` for `board` and names `items` to
 * refetch. The `org.page` view `summary` has an action `go` (view block payload limit).
 */
export default defineExtension({
  name: "fake-client-page",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [],
  ui: [
    {
      id: "board",
      title: t("看板", "Board"),
      slot: "org.page",
      kind: "component",
      frame: "page",
      nav: "primary",
    },
    { id: "summary", title: t("概要", "Summary"), slot: "org.page", kind: "view" },
  ],
  permissions: {
    client: true,
    ui: { components: ["board"], views: ["summary"] },
  },
  setup(ctx) {
    ctx.ui.query("board", async (a) => {
      switch (a.query) {
        case "items":
          return {
            items: items(),
            params: a.params,
            caller: {
              orgId: a.orgId,
              accountId: a.accountId,
              role: a.role,
              slot: a.slot,
              locale: a.locale,
            },
          } as JsonValue;
        case "slow":
          return new Promise<JsonValue>((_, reject) => {
            a.signal.addEventListener("abort", () => {
              fakeClientPageProbe().aborted += 1;
              reject(a.signal.reason);
            });
          });
        case "boom":
          throw new Error("fake-client-page: boom");
        case "huge":
          return { blob: "x".repeat(UI_LIMITS.componentQueryBytes) };
        default:
          throw new Error(`fake-client-page: unknown query ${a.query}`);
      }
    });
    ctx.ui.action("board", async (a) => {
      if (a.actionId !== "move") throw new Error(`fake-client-page: unknown action ${a.actionId}`);
      if (a.scope !== "platform") {
        await ctx.ui.invalidate({ orgId: a.orgId, contribution: "board" }).catch(() => {});
      }
      const bytes = Buffer.byteLength(JSON.stringify(a.payload ?? null), "utf8");
      return { toast: t(`已移动 ${bytes}`, `moved ${bytes}`), invalidate: ["items"] };
    });
    ctx.ui.view("summary", async () => ({ blocks: [{ type: "text", markdown: "summary" }] }));
    ctx.ui.action("summary", async () => ({ toast: t("好", "ok") }));
  },
});
