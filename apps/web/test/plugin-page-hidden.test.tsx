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
    await waitFor(() => expect(reads.length).toBeLessThanOrEqual(1));
  });
});
