import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * 提交与 PR 署名 on the admin settings page (spec 2026-11-14-agent-attribution): the platform's
 * default commit trailer, pull-request line and conversation-link switch, the preview, and the
 * read-only state of a field the startup config sets.
 */

const T = en.admin.settings.attribution;
const READONLY_ENV = "From an environment variable (read-only)";

const DEFAULT_COMMIT = "Co-Authored-By: Capybara <noreply@capybarahq.com>";
const DEFAULT_PR = "🤖 Generated with [Capybara](https://github.com/capybara-hq/core)";

const ATTRIBUTION = {
  commit: DEFAULT_COMMIT,
  pr: DEFAULT_PR,
  sessionUrl: false,
  sources: { commit: "default", pr: "default", sessionUrl: "default" },
};

const SETTINGS = {
  orgCreation: "anyone",
  runConcurrencyOverrides: {},
  priceCurrency: "USD",
  sandboxLimitOverrides: {},
  customConnectors: "allow",
  customSkills: "allow",
  clientExtensions: { enabled: true, disabled: [] as string[] },
  attribution: ATTRIBUTION,
};

const routes = (attribution: Record<string, unknown> = ATTRIBUTION) =>
  stubApi({
    "GET /api/v1/admin/settings": () => json(200, { ...SETTINGS, attribution }),
    "GET /api/v1/admin/components?kind=theme": () => json(200, { components: [] }),
    "GET /api/v1/admin/ui/arrangement": () => json(200, { slots: [] }),
    "GET /api/v1/admin/extensions": () => json(200, { extensions: [], drainSeconds: 30 }),
    "PUT /api/v1/admin/settings": (c: Call) =>
      json(200, {
        ...SETTINGS,
        attribution: { ...ATTRIBUTION, ...(bodyOf(c) as { attribution: object }).attribution },
      }),
  });

const sectionOf = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section") as HTMLElement;

beforeEach(() => resetNavigation("/admin/settings"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("提交与 PR 署名 on /admin/settings", () => {
  it("shows the defaults and their preview, edits them and saves the changed fields", async () => {
    const calls = routes();
    const { client } = await renderRouteWithCache("/admin/settings", lastStubRoutes());
    client.setQueryData(keys.org("o1").orgSettings(), { settings: {} });
    const section = await sectionOf(T.title);
    const user = userEvent.setup();
    const commit = within(section).getByRole("textbox", { name: T.commitLabel });
    const pr = within(section).getByRole("textbox", { name: T.prLabel });
    expect((commit as HTMLInputElement).value).toBe(DEFAULT_COMMIT);
    expect((pr as HTMLInputElement).value).toBe(DEFAULT_PR);
    // the preview shows what a commit and a pull request end with
    expect(within(section).getByText(T.previewCommit)).toBeTruthy();
    expect(within(section).getAllByText(DEFAULT_COMMIT).length).toBeGreaterThan(0);
    await user.clear(commit);
    await user.type(commit, "Signed-off-by: Acme <dev@acme.example>");
    await user.click(within(section).getByRole("switch", { name: T.sessionUrlLabel }));
    await user.click(screen.getByRole("button", { name: en.admin.settings.save }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "PUT"))).toEqual({
      attribution: { commit: "Signed-off-by: Acme <dev@acme.example>", sessionUrl: true },
    });
    // the org settings (the agent page's help text) are stale after a change
    await waitFor(() =>
      expect(client.getQueryState(keys.org("o1").orgSettings())?.isInvalidated).toBe(true),
    );
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a field the startup config sets is read-only with its source", async () => {
    routes({
      ...ATTRIBUTION,
      commit: "From env trailer",
      sources: { ...ATTRIBUTION.sources, commit: "env" },
    });
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(T.title);
    const commit = within(section).getByRole("textbox", { name: T.commitLabel });
    expect((commit as HTMLInputElement).value).toBe("From env trailer");
    expect((commit as HTMLInputElement).disabled).toBe(true);
    expect(within(section).getByText(`${READONLY_ENV} · attribution.commit`)).toBeTruthy();
  });

  it("恢复默认 puts the built-in values back", async () => {
    routes({ ...ATTRIBUTION, commit: "Custom" });
    await renderRouteWithCache("/admin/settings", lastStubRoutes());
    const section = await sectionOf(T.title);
    const user = userEvent.setup();
    await user.click(within(section).getByRole("button", { name: T.restore }));
    expect(
      (within(section).getByRole("textbox", { name: T.commitLabel }) as HTMLInputElement).value,
    ).toBe(DEFAULT_COMMIT);
    // following the defaults needs no change against the saved values? it does: they were custom
    expect(screen.getByRole("button", { name: en.admin.settings.save })).toBeTruthy();
  });

  it("renders in Chinese with the zh copy", async () => {
    routes();
    await renderRouteWithCache("/admin/settings", lastStubRoutes(), { locale: "zh" });
    expect(
      await screen.findByRole("heading", { name: zh.admin.settings.attribution.title }),
    ).toBeTruthy();
    expect(zh.admin.settings.attribution.title).toBe("提交与 PR 署名");
  });
});
