import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { json, lastStubRoutes, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";

const params = vi.hoisted(() => ({ current: { plugin: "board", id: "two" } }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const UI = "/api/v1/orgs/o1/ui";

beforeEach(() => {
  resetNavigation("/p/board/two");
  window.history.replaceState(null, "", "/p/board/two");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("a page the contributions list leaves out", () => {
  it("a 404 on the arrangement read is final: the designed not-found, read once", async () => {
    const calls = stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [] }),
      [`GET ${UI}/arrangement`]: () => json(404, { error: { code: "not_found", message: "no" } }),
    });
    const { calls: server } = await renderRouteWithCache("/p/board/two", lastStubRoutes(), {
      locale: "en",
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind"),
      ).toBe("404"),
    );
    expect(screen.queryByText(en.errors.ui.not_found)).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    const reads = [...server, ...calls].filter((c) => c.url.endsWith("/ui/arrangement"));
    expect(reads).toHaveLength(1);
  });
});

describe("/p/<plugin>: a plugin's page without the contribution id", () => {
  const page = {
    plugin: "board",
    id: "memory-page",
    title: { zh: "记忆", en: "Memory" },
    slot: "org.page" as const,
    kind: "view" as const,
    icon: "puzzle" as const,
  };

  it("opens the plugin's page and draws no tab bar (one page is one view)", async () => {
    params.current = { plugin: "board", id: "memory-page" };
    resetNavigation("/p/board");
    window.history.replaceState(null, "", "/p/board");
    stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [page] }),
      [`GET ${UI}/views/board/memory-page`]: () => json(200, { view: { blocks: [] } }),
    });
    await renderRouteWithCache("/p/board", lastStubRoutes(), { locale: "en" });
    expect(await screen.findByRole("heading", { name: "Memory" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("a plugin with no page at all is the designed not-found", async () => {
    params.current = { plugin: "nothing", id: "memory-page" };
    resetNavigation("/p/nothing");
    window.history.replaceState(null, "", "/p/nothing");
    stubApi({
      [`GET ${UI}/contributions`]: () => json(200, { items: [page] }),
    });
    await renderRouteWithCache("/p/nothing", lastStubRoutes(), { locale: "en" });
    await waitFor(() =>
      expect(
        document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind"),
      ).toBe("404"),
    );
  });
});
