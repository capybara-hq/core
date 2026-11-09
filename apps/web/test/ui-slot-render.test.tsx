import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { ExtensionSlot } from "../src/components/extension-ui/ExtensionSlot";
import { contributionsQuery } from "../src/lib/query/conversation";
import type { UiContributionItem, UiView } from "../src/lib/ui";
import { type Call, json, lastStubRoutes, stubApi } from "./support/api";
import { CONV, FakeEventSource, renderChatRoute, userMsg } from "./support/conversation";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { renderPage, testQueryClient } from "./support/render";

const params = vi.hoisted(() => ({ current: { conversationId: "c1" } as Record<string, string> }));
vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({ useParams: () => params.current }));

const ORG = "/api/v1/orgs/o1";
const UI = `${ORG}/ui`;
const BASE = `${ORG}/conversations/c1`;

const section = (id: string, en: string, after: string): UiContributionItem => ({
  plugin: "todo",
  id,
  title: { zh: en, en },
  slot: "conversation.properties.section",
  after,
  kind: "view",
  icon: "list-checks",
});
const page = (id: string, en: string): UiContributionItem => ({
  plugin: "board",
  id,
  title: { zh: en, en },
  slot: "org.page",
  kind: "view",
  icon: "puzzle",
});
const viewOf = (text: string): UiView => ({ blocks: [{ type: "heading", text }] });

const FILE = {
  id: "f1",
  name: "out.txt",
  contentType: "text/plain",
  size: 5,
  sourcePath: "/w/out.txt",
  version: 1,
  versions: [{ id: "f1", size: 5, createdAt: "2026-10-26T06:00:00.000Z" }],
  callId: "c",
  createdAt: "2026-10-26T06:00:00.000Z",
  status: "available",
  previewable: "text",
};

function conversationApi(
  items: UiContributionItem[],
  extra: Record<string, (c: Call) => Response>,
) {
  return stubApi({
    [`GET ${BASE}`]: () => json(200, CONV("c1")),
    [`GET ${BASE}/events`]: () => json(200, { events: [userMsg(1, "in c1")] }),
    [`GET ${BASE}/queue`]: () => json(200, { items: [], paused: false }),
    [`GET ${BASE}/files`]: () => json(200, { files: [FILE], next: null }),
    [`GET ${BASE}/device`]: () => json(200, { device: null }),
    [`GET ${UI}/contributions`]: () => json(200, { items }),
    ...extra,
  });
}

/** The properties panel's section titles, top to bottom. */
const sectionTitles = () =>
  [
    ...screen
      .getByRole("complementary", { name: "Properties" })
      .querySelectorAll('[data-part="property-title"]'),
  ].map((el) => el.textContent);

beforeEach(() => {
  params.current = { conversationId: "c1" };
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1#properties");
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.instances = [];
});

describe("ExtensionSlot", () => {
  it("a properties section renders after its anchor", async () => {
    conversationApi([section("late", "Late", "files"), section("early", "Early", "context")], {
      [`GET ${UI}/views/todo/late`]: () => json(200, { view: viewOf("late body") }),
      [`GET ${UI}/views/todo/early`]: () => json(200, { view: viewOf("early body") }),
    });
    await renderChatRoute();
    await screen.findByRole("heading", { name: "late body" });
    await screen.findByRole("heading", { name: "early body" });
    const titles = sectionTitles();
    const files = titles.indexOf(en.chat.files);
    expect(files).toBeGreaterThan(-1);
    expect(titles.indexOf("Early")).toBeGreaterThan(0);
    expect(titles.indexOf("Early")).toBeLessThan(files);
    expect(titles.indexOf("Late")).toBe(files + 1);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("a failing section shows the load-failure line in that block only", async () => {
    conversationApi([section("bad", "Bad", "context"), section("good", "Good", "context")], {
      [`GET ${UI}/views/todo/bad`]: () => json(500, { code: "ui.render_failed", message: "x" }),
      [`GET ${UI}/views/todo/good`]: () => json(200, { view: viewOf("good body") }),
    });
    await renderChatRoute();
    expect(await screen.findByRole("heading", { name: "good body" })).toBeTruthy();
    const block = (key: string) =>
      document.querySelector(`[data-extension-section="${key}"]`) as HTMLElement;
    await waitFor(() =>
      expect(
        block("todo/bad")
          .querySelector('[data-part="property-section"]')
          ?.getAttribute("data-state"),
      ).toBe("failed"),
    );
    expect(within(block("todo/bad")).getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(
      block("todo/good")
        .querySelector('[data-part="property-section"]')
        ?.getAttribute("data-state"),
    ).not.toBe("failed");
    // the thread keeps working
    expect(screen.getByText("in c1")).toBeTruthy();
  });

  it("an empty slot draws nothing", () => {
    const client = testQueryClient();
    client.setQueryData(contributionsQuery("o1").queryKey, [page("other", "Other")]);
    renderPage(
      <>
        <span data-testid="before" />
        <ExtensionSlot
          slot="conversation.properties.section"
          args={{ orgId: "o1", conversationId: "c1" }}
          anchor="context"
          host={{ onOpenTarget: () => {} }}
        />
        <span data-testid="after" />
      </>,
      { client },
    );
    // nothing between the slot's neighbours: not a wrapper, not an empty state
    expect(screen.getByTestId("before").nextSibling).toBe(screen.getByTestId("after"));
  });

  it("select renders one contribution", async () => {
    params.current = { plugin: "board", id: "two" };
    window.history.replaceState(null, "", "/p/board/two");
    const calls = stubApi({
      [`GET ${UI}/contributions`]: () =>
        json(200, { items: [page("one", "One"), page("two", "Two")] }),
      [`GET ${UI}/views/board/one`]: () => json(200, { view: viewOf("one body") }),
      [`GET ${UI}/views/board/two`]: () => json(200, { view: viewOf("two body") }),
    });
    const { calls: server } = await renderRouteWithCache("/p/board/two", lastStubRoutes(), {
      locale: "en",
    });
    expect(await screen.findByRole("heading", { name: "two body" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "one body" })).toBeNull();
    expect([...server, ...calls].some((c) => c.url.includes("/views/board/one"))).toBe(false);
  });

  it("a panel contribution opens from its title-bar icon, by slot", async () => {
    window.history.replaceState(null, "", "/chat/c1");
    conversationApi(
      [
        {
          plugin: "todo",
          id: "tasks-panel",
          title: { zh: "待办", en: "Tasks" },
          slot: "conversation.panel",
          kind: "view",
          icon: "list-checks",
        },
      ],
      { [`GET ${UI}/views/todo/tasks-panel`]: () => json(200, { view: viewOf("panel body") }) },
    );
    await renderChatRoute();
    await screen.findByText("in c1");
    const bar = document.querySelector('[data-part="title-bar"]') as HTMLElement;
    await userEvent.setup().click(within(bar).getByRole("button", { name: "Tasks" }));
    const panel = await screen.findByRole("complementary", { name: "Tasks" });
    expect(await within(panel).findByRole("heading", { name: "panel body" })).toBeTruthy();
    expect(window.location.hash).toBe("#panel=todo/tasks-panel");
  });
});
