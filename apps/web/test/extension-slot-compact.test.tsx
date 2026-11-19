// Compact forms of extension slots (mobile layout spec §5.6): a `hidden` contribution is drawn
// (the server does not know the width) inside a region CSS hides on the compact class and, once the
// window is known to be compact, not rendered at all; `kept` and `drawer` contributions render.
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionSlot } from "../src/components/extension-ui/ExtensionSlot";
import { contributionsQuery } from "../src/lib/query/conversation";
import { meQuery } from "../src/lib/query/shell";
import type { UiCompactForm, UiContributionItem } from "../src/lib/ui";
import { json, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const item = (id: string, compact: UiCompactForm): UiContributionItem => ({
  plugin: "p",
  id,
  title: { zh: id, en: id },
  slot: "org.settings.section",
  kind: "view",
  icon: "puzzle",
  compact,
});

const real = window.matchMedia;
const widthStub = (width: number) =>
  ((q: string) => {
    const features = [...q.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)];
    return {
      matches:
        features.length > 0 &&
        features.every(([, k, n]) => (k === "min" ? width >= Number(n) : width <= Number(n))),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }) as unknown as typeof window.matchMedia;

function draw(items: UiContributionItem[]) {
  stubApi(
    Object.fromEntries(
      items.map((i) => [
        `GET /api/v1/orgs/o1/ui/views/p/${i.id}`,
        () => json(200, { view: { blocks: [{ type: "heading", text: `body ${i.id}` }] } }),
      ]),
    ),
  );
  const client = testQueryClient();
  client.setQueryData(meQuery().queryKey, ME);
  client.setQueryData(contributionsQuery("o1").queryKey, items);
  return renderPage(<ExtensionSlot slot="org.settings.section" args={{ orgId: "o1" }} />, {
    client,
  });
}

beforeEach(() => {
  resetNavigation("/settings/organization");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  window.matchMedia = real;
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("slot compact forms", () => {
  it("compact: a hidden contribution renders nothing, kept and drawer ones render", async () => {
    window.matchMedia = widthStub(390);
    draw([item("gone", "hidden"), item("stays", "kept"), item("moved", "drawer")]);
    expect(await screen.findByRole("heading", { name: "body stays" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "body moved" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "body gone" })).toBeNull();
  });

  it("expanded: a hidden contribution renders, inside a region CSS hides on compact", async () => {
    window.matchMedia = widthStub(1000);
    draw([item("gone", "hidden")]);
    const heading = await screen.findByRole("heading", { name: "body gone" });
    expect(heading.closest('[data-part="class-swap-regular"]')).not.toBeNull();
  });

  it("before the width is known (server render): hidden is drawn in the CSS-hidden region", async () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    draw([item("gone", "hidden")]);
    const heading = await screen.findByRole("heading", { name: "body gone" });
    expect(heading.closest('[data-part="class-swap-regular"]')).not.toBeNull();
  });
});
