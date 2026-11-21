// Every compact route shows a skeleton, never a blank area, while its data is on the way (mobile
// spec §7.3): the page holds a template skeleton (`aria-busy`) with something to read.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meQuery, readinessQuery } from "../src/lib/query/shell";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache } from "./support/query";
import { ME, testQueryClient } from "./support/render";
import { frameElement, shellOf } from "./support/shell";

// `/schedules` reads the remembered view's cookie on the server: none here.
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const compact = (q: string) => {
  const features = [...q.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
  return {
    matches:
      features.length > 0 &&
      features.every(([, k, n]) => (k === "min" ? 390 >= Number(n) : 390 <= Number(n))),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", compact);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A read that never answers: the page stays on its loading state. */
const held = () => new Promise<Response>(() => {});

/**
 * The browser's reads of `path` with nothing answering: a first render finds out which (each is
 * recorded, then fails), the second holds every one of them.
 */
async function holdAll(path: string) {
  const client = () => {
    const c = testQueryClient();
    c.setQueryData(meQuery().queryKey, ME);
    c.setQueryData(readinessQuery("o1").queryKey, {
      modelProvider: "ready",
      orgFixableProviders: [],
      agents: 1,
    });
    return c;
  };
  const probe = await renderRouteEmptyCache(path, {}, { client: client() });
  const urls = new Set(probe.calls.filter((c) => c.method === "GET").map((c) => c.url));
  probe.unmount();
  cleanup();
  const routes = Object.fromEntries([...urls].map((u) => [`GET ${u}`, held]));
  return renderRouteEmptyCache(path, routes, { client: client() });
}

describe("compact routes before their data", () => {
  it.each([
    "/conversations",
    "/agents",
    "/inbox",
    "/chat/c1",
    "/skills",
    "/connectors",
    "/schedules",
  ])("%s shows a skeleton and some text, not a blank area", async (path) => {
    resetNavigation(path);
    await holdAll(path);
    await vi.waitFor(() => {
      if (document.body.textContent?.trim() === "") throw new Error("blank");
    });
    const skeleton = document.querySelector(
      '[data-loading="true"], [aria-busy="true"], [data-part^="loading"]',
    );
    expect(skeleton, `${path} has no skeleton`).not.toBeNull();
    expect(document.body.textContent?.trim()).not.toBe("");
  });
});

describe("the Me tab", () => {
  it("is never blank: the frame builds its panel from the cached shell", async () => {
    resetNavigation("/me");
    const { default: MeView } = await import("../src/app/(app)/me/view");
    render(frameElement(shellOf(ME), <MeView />, { locale: "en" }));
    const panel = document.querySelector('[data-part="me-panel"], [data-template="OverviewPage"]');
    expect(panel, "/me draws no page").not.toBeNull();
    expect(panel?.textContent?.trim()).not.toBe("");
  });
});
