// The template lists' owner filter is (the marketplace sources: catalog-pages.test.tsx)
// `ListPage.scope`: chips on a compact window, a Segmented on a wide one (responsive spec §4, §6.1).
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { stubWindowWidth } from "./support/width";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

beforeEach(() => {
  vi.stubGlobal(
    "EventSource",
    class {
      close() {}
      addEventListener() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const component = (id: string, owner: unknown) => ({
  kind: "agent_template",
  id,
  name: `tpl-${id}`,
  description: "d",
  plugin: "p",
  itemId: "11111111-1111-4111-8111-111111111111",
  owner,
  shareable: false,
  promoted: false,
  builtin: false,
  scopeMode: "follow",
  scope: "optional",
  orgs: [],
  disabled: false,
  pluginStopped: false,
  shownToOthers: true,
  version: "1",
  onIn: [],
});
const templates = () => ({
  "GET /api/v1/admin/components?kind=agent_template": () =>
    json(200, {
      components: [
        component("a", { kind: "platform" }),
        component("b", { kind: "org", orgId: "o1", name: "Acme" }),
      ],
    }),
  "GET /api/v1/admin/orgs": () => json(200, { orgs: [] }),
});
const T_ = en.adminComponents.tabs;

describe("admin view choices are ListPage.scope", () => {
  it("the owner filter of the template lists: chips at 390, a Segmented at 1440", async () => {
    for (const [width, part] of [
      [390, "scope-chips"],
      [1440, "segmented"],
    ] as const) {
      stubWindowWidth(width);
      resetNavigation("/admin/agents/templates");
      stubApi(templates());
      await renderRouteWithCache("/admin/agents/templates", templates());
      const group = await screen.findByRole("radiogroup", { name: T_.label });
      expect(group.getAttribute("data-part")).toBe(part);
      expect(
        within(group)
          .getAllByRole("radio")
          .map((r) => (r.textContent ?? "").replace(/\D/g, "")),
      ).toEqual(["2", "1", "1"]);
      expect(within(group).getByRole("radio", { name: new RegExp(`^${T_.org}`) })).toBeTruthy();
      cleanup();
    }
  });
});
