import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import type { UiContributionItem } from "../src/lib/ui";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const ORG = "/api/v1/orgs/o1";
const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const section: UiContributionItem = {
  plugin: "fake-tools-ui",
  id: "org-admin",
  title: { zh: "组织设置扩展", en: "Org admin" },
  slot: "org.settings.section",
  kind: "view",
  icon: "puzzle",
};

function api(items: UiContributionItem[]) {
  return stubApi({
    [`GET ${ORG}/settings`]: () => json(200, { settings: { toolSearch: "on" } }),
    [`GET ${ORG}/ui/contributions`]: () => json(200, { items }),
    [`GET ${ORG}/ui/views/fake-tools-ui/org-admin`]: () =>
      json(200, { view: { blocks: [{ type: "heading", text: "Org settings" }] } }),
  });
}

beforeEach(() => {
  resetNavigation("/settings/organization");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("org.settings.section", () => {
  it("an admin sees extension sections after the built-in ones", async () => {
    api([section]);
    await renderRouteWithCache("/settings/organization", lastStubRoutes());
    expect(await screen.findByRole("heading", { name: "Org settings" })).toBeTruthy();
    const titles = [
      ...document.querySelectorAll(
        '[data-part="form-section"] h2, [data-part="form-section-title"]',
      ),
    ].map((el) => el.textContent);
    const own = en.orgSettings.platformTool.title;
    expect(titles.indexOf("Org admin")).toBeGreaterThan(titles.indexOf(own));
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a member sees none", async () => {
    const calls = api([section]);
    await renderRouteWithCache("/settings/organization", lastStubRoutes(), { me: MEMBER });
    await screen.findByText(en.orgSettings.readonly);
    expect(screen.queryByText("Org admin")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Org settings" })).toBeNull();
    expect(calls.some((c) => c.url.includes("/ui/"))).toBe(false);
  });
});
