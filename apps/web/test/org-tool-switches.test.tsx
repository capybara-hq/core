import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { bodyOf, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const BASE = "/api/v1/orgs/o1";
const TOOLS = `${BASE}/extensions/todo/tools`;
const msgs = { zh, en } as const;
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const TODO = {
  plugin: "todo",
  displayName: { zh: "待办", en: "Todo" },
  version: "1.0.0",
  enabled: true,
  configurable: false,
  config: null,
  secrets: [],
  permissions: [
    {
      category: "provides",
      sensitive: false,
      items: ["tool@1"],
      entries: [{ value: "tool@1", sensitive: false }],
    },
  ],
  orgConfigSchema: null,
};

function routes(extra: Parameters<typeof stubApi>[0] = {}) {
  return stubApi({
    [`GET ${BASE}/file-previewers`]: () => json(200, { items: [] }),
    [`GET ${BASE}/extension-points`]: () => json(200, { points: [] }),
    "GET /api/v1/auth/sources": () => json(200, { sources: [] }),
    [`GET ${BASE}/extensions`]: () => json(200, { extensions: [TODO] }),
    [`GET ${TOOLS}`]: () =>
      json(200, {
        tools: [
          { tool: "write", enabled: true },
          { tool: "read", enabled: false },
        ],
      }),
    ...extra,
  });
}

beforeEach(() => {
  resetNavigation("/extensions");
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openSheet(locale: "zh" | "en" = "en", opts: { me?: Me } = {}) {
  const name = locale === "zh" ? "待办" : "Todo";
  await renderRouteWithCache("/extensions", lastStubRoutes(), { locale, ...opts });
  const user = userEvent.setup();
  await user.click(await screen.findByText(name, { selector: ".cb-cell-title-name" }));
  const sheet = await screen.findByRole("dialog", { name });
  return { user, sheet };
}

describe("org switches for single extension tools (Sheet)", () => {
  it.each(["zh", "en"] as const)(
    "turning a tool off previews the agents; confirming sends the hash (%s)",
    async (locale) => {
      const m = msgs[locale].extensions.toolSwitches;
      const calls = routes({
        [`PUT ${TOOLS}/write`]: (c) =>
          (bodyOf(c) as { confirm?: string }).confirm === undefined
            ? json(200, {
                applied: false,
                affectedAgents: [{ id: "a1", name: "Helper" }],
                confirm: "h1",
              })
            : json(200, { applied: true }),
      });
      const { user, sheet } = await openSheet(locale);
      const sw = await within(sheet).findByRole("switch", { name: "write" });
      expect(sw.getAttribute("aria-checked")).toBe("true");
      await user.click(sw);
      const dialog = await screen.findByRole("dialog", {
        name: m.offTitle.replace("{tool}", "write"),
      });
      expect(within(dialog).getByText(m.offAgents)).toBeTruthy();
      expect(within(dialog).getByText("· Helper")).toBeTruthy();
      await user.click(within(dialog).getByRole("button", { name: m.offConfirm }));
      await waitFor(() => expect(calls.filter((c) => c.method === "PUT").length).toBe(2));
      const puts = calls.filter((c) => c.method === "PUT").map((c) => bodyOf(c));
      expect(puts).toEqual([{ enabled: false }, { enabled: false, confirm: "h1" }]);
      await waitFor(() => expect(screen.queryByText(m.offAgents)).toBeNull());
    },
  );

  it("turning a tool on applies at once", async () => {
    const calls = routes({ [`PUT ${TOOLS}/read`]: () => json(200, { applied: true }) });
    const { user, sheet } = await openSheet();
    await user.click(await within(sheet).findByRole("switch", { name: "read" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.filter((c) => c.method === "PUT").map((c) => bodyOf(c))).toEqual([
      { enabled: true },
    ]);
    expect(screen.queryByText(en.extensions.toolSwitches.offAgents)).toBeNull();
  });

  it("a stale confirm shows the new preview before confirming again", async () => {
    let n = 0;
    routes({
      [`PUT ${TOOLS}/write`]: (c) => {
        const confirm = (bodyOf(c) as { confirm?: string }).confirm;
        if (confirm === undefined) {
          n += 1;
          return json(200, {
            applied: false,
            affectedAgents:
              n === 1 ? [{ id: "a1", name: "Helper" }] : [{ id: "a2", name: "Newcomer" }],
            confirm: `h${n}`,
          });
        }
        return json(409, { error: { code: "plugin.switch_stale", message: "stale" } });
      },
    });
    const { user, sheet } = await openSheet();
    await user.click(await within(sheet).findByRole("switch", { name: "write" }));
    const dialog = await screen.findByRole("dialog", { name: /Turn off write/ });
    await user.click(
      within(dialog).getByRole("button", { name: en.extensions.toolSwitches.offConfirm }),
    );
    expect(await screen.findByText("· Newcomer")).toBeTruthy();
    expect(screen.getByText(en.extensions.toolSwitches.stale)).toBeTruthy();
  });

  it("members read the states without switches", async () => {
    routes();
    const { sheet } = await openSheet("en", { me: MEMBER });
    expect(await within(sheet).findByText("write")).toBeTruthy();
    expect(within(sheet).queryByRole("switch", { name: "write" })).toBeNull();
    expect(within(sheet).getByText(en.extensions.toolSwitches.off)).toBeTruthy();
  });

  it("zh copy is exactly the accepted wording", () => {
    expect(zh.extensions.toolSwitches.off).toBe("已在本组织关闭");
    expect(zh.extensions.toolSwitches.offAgents).toBe(
      "以下智能体正在使用这个工具，关闭后它们将无法使用：",
    );
    expect(en.extensions.toolSwitches.offAgents).toBe(
      "These agents use this tool and will lose it:",
    );
    expect(zh.errors.extension.tool_not_found).toBe("这个扩展没有这个工具");
    expect(en.errors.extension.needs_config).toBe(
      "This extension needs to be configured in this organization first",
    );
  });
});
