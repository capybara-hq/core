// `/agents` declares its All / Mine / Shared choice as ListPage's `scope`: three chips on a
// compact window (a radiogroup), a Segmented on a wide one (responsive spec §4, §6.1).
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import zh from "../messages/zh.json";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import type { Routes } from "./support/server";

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

/** A `matchMedia` for a window `width` px wide: min-/max-width features, `not all and` negation. */
const mediaFor = (width: number) => (q: string) => {
  const plain = (s: string) => {
    const features = [...s.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    return (
      features.length > 0 &&
      features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n)))
    );
  };
  const matches = q
    .split(",")
    .map((s) => s.trim())
    .some((part) => {
      const neg = /^not\s+all\s+and\s+/.exec(part);
      return neg ? !plain(part.slice(neg[0].length)) : plain(part);
    });
  return { matches, media: q, addEventListener: () => {}, removeEventListener: () => {} };
};

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

const O = "/api/v1/orgs/o1";
const json = (body: unknown) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const AGENT = {
  id: "ag1",
  orgId: "o1",
  visibility: "org",
  ownerAccountId: "someone",
  currentVersion: 1,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: "2026-11-04T10:00:00Z" },
  definition: { name: "Agent ag1", instructions: "", model: { provider: "p", model: "m" } },
  updatedAt: "2026-10-01T00:00:00Z",
};
const served = (): Routes => ({
  [`GET ${O}/agents`]: json({ agents: [AGENT] }),
  [`GET ${O}/members`]: json({ members: [] }),
  [`GET ${O}/agent-templates`]: json({ templates: [] }),
  [`GET ${O}/components`]: json({ components: [] }),
});

const labels = [zh.agents.tabs.all, zh.agents.tabs.mine, zh.agents.tabs.shared];

describe("/agents scope", () => {
  it("at 390 the 全部 / 我的 / 组织共享 choice is three chips with aria-checked", async () => {
    vi.stubGlobal("matchMedia", mediaFor(390));
    resetNavigation("/agents");
    await renderRouteWithCache("/agents", served(), { locale: "zh", me: ME });
    await screen.findByText("Agent ag1");
    const group = screen.getAllByRole("radiogroup", { name: zh.agents.filter })[0] as HTMLElement;
    const chips = within(group).getAllByRole("radio");
    expect(chips.map((c) => c.textContent)).toEqual(labels);
    expect(chips.map((c) => c.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  });

  it("at 1440 it is a Segmented", async () => {
    vi.stubGlobal("matchMedia", mediaFor(1440));
    resetNavigation("/agents");
    await renderRouteWithCache("/agents", served(), { locale: "zh", me: ME });
    await screen.findByText("Agent ag1");
    expect(document.querySelector('[data-part="scope-chips"]')).toBeNull();
    const seg = document.querySelector('[data-part="segmented"]');
    expect(seg).not.toBeNull();
    expect(
      within(seg as HTMLElement)
        .getAllByRole("radio")
        .map((c) => c.textContent),
    ).toEqual(labels);
  });
});
