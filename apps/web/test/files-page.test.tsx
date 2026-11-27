import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { LibraryFileView } from "../src/lib/library-files";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteEmptyCache, renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { expectNoFirstPaintFetch } from "./support/server";

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

const ORG = "/api/v1/orgs/o1";
const FILES = `${ORG}/files`;
const E = en.files;
const T = "2020-01-02T08:00:00.000Z";

const asRole = (role: "owner" | "member" | "guest"): Me => ({
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

const file = (over: Partial<LibraryFileView> = {}): LibraryFileView => ({
  id: "f1",
  name: "report.pdf",
  contentType: "application/pdf",
  size: 2048,
  origin: "delivered",
  agentId: "ag1",
  agentName: "Helper",
  sourceConversation: { id: "c1", title: "Quarterly review", deleted: false },
  versions: 1,
  createdAt: T,
  previewable: null,
  ...over,
});

const UPLOAD = file({
  id: "f2",
  name: "notes.pdf",
  origin: "upload",
  agentId: null,
  sourceConversation: null,
});
delete (UPLOAD as { agentName?: string }).agentName;

const ok = (body: unknown) => () => json(200, body);

/** The page's reads: the list (any filter), the usage and the agents. */
function routesOf(list: (url: string) => LibraryFileView[]) {
  return {
    [`GET ${FILES}`]: (c: { url: string }) => json(200, { files: list(c.url), next: null }),
    [`GET ${FILES}/usage`]: ok({ bytes: 4096, files: 2 }),
    [`GET ${ORG}/agents`]: ok({ agents: [] }),
  };
}
const routes = routesOf(() => [file(), UPLOAD]);

/** The open file's reads: its details and its previewers (none: the file card). */
const detailRoutes = {
  [`GET ${FILES}/f1`]: ok({
    file: file(),
    conversations: [{ id: "c2", title: "Follow-up", deleted: false }],
    versions: [{ id: "f1", size: 2048, createdAt: T }],
  }),
  [`GET ${FILES}/f1/previewers`]: ok({ previewers: [] }),
};

const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const template = () => document.querySelector('[data-template="LibraryPage"]');

beforeEach(() => resetNavigation("/files"));
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("/files", () => {
  it("a first render from the hydrated cache makes no browser read", async () => {
    const browser = expectNoFirstPaintFetch();
    await renderRouteWithCache("/files", routes);
    expect(template()).not.toBeNull();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("notes.pdf")).toBeTruthy();
    // the agent names a delivery, the origin an upload
    expect(screen.getByText(/Helper · 2 KB/)).toBeTruthy();
    expect(screen.getByText(/Uploaded by you · 2 KB/)).toBeTruthy();
    expect(screen.getByText("4 KB used · 2 files")).toBeTruthy();
    expect(screen.getByText(E.groups.older)).toBeTruthy();
    expect(screen.getByText(E.detail.pick)).toBeTruthy();
    await settle();
    expect(browser).toEqual([]);
  });

  it("zh: the 文件 title and the origin tabs", async () => {
    stubApi(routes);
    await renderRouteWithCache("/files", routes, { locale: "zh" });
    expect(screen.getByRole("heading", { level: 1, name: zh.files.title })).toBeTruthy();
    expect(screen.getAllByText(zh.files.tabs.delivered).length).toBeGreaterThan(0);
  });

  it("an empty cache shows the template's loading state, then the data", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    await renderRouteEmptyCache("/files", {
      ...routes,
      [`GET ${FILES}`]: async (c: { url: string }) => {
        await held;
        return routes[`GET ${FILES}`](c);
      },
    });
    await vi.waitFor(() => expect(template()).not.toBeNull());
    expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(screen.queryByText("report.pdf")).toBeNull();
    await act(async () => release());
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    await vi.waitFor(() => expect(document.querySelector("[aria-busy='true']")).toBeNull());
  });

  it("the address's filters are the list's read; a tab reads its origin", async () => {
    const lists = routesOf((url) =>
      url.includes("origin=upload") ? [UPLOAD] : url.includes("origin=delivered") ? [file()] : [],
    );
    resetNavigation("/files?origin=upload");
    const calls = stubApi(lists);
    await renderRouteWithCache("/files?origin=upload", lists);
    expect(screen.getByText("notes.pdf")).toBeTruthy();
    expect(screen.queryByText("report.pdf")).toBeNull();
    await userEvent.setup().click(screen.getByRole("tab", { name: E.tabs.delivered }));
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(calls.some((c) => c.url === `${FILES}?origin=delivered`)).toBe(true);
    expect(window.location.search).toBe("?origin=delivered");
  });

  it("no files: the empty state offers an upload", async () => {
    const empty = routesOf(() => []);
    stubApi(empty);
    await renderRouteWithCache("/files", empty);
    expect(screen.getByText(E.empty.text)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: E.upload }).length).toBeGreaterThan(0);
  });

  it("no match for the filters: the filtered-empty state clears them", async () => {
    const lists = routesOf((url) => (url.includes("type=image") ? [] : [file()]));
    resetNavigation("/files?type=image");
    const calls = stubApi(lists);
    await renderRouteWithCache("/files?type=image", lists);
    expect(screen.getByText(E.empty.filtered)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: E.empty.clear }));
    expect(await screen.findByText("report.pdf")).toBeTruthy();
    expect(calls.some((c) => c.method === "GET" && c.url === FILES)).toBe(true);
  });

  it("opening a file shows its details: origin, agent, conversations and versions", async () => {
    stubApi({ ...routes, ...detailRoutes });
    await renderRouteWithCache("/files", lastStubRoutes());
    await userEvent.setup().click(screen.getByText("report.pdf"));
    expect(window.location.hash).toBe("#item=f1");
    expect(await screen.findByRole("link", { name: "Follow-up" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Quarterly review" }).getAttribute("href")).toBe(
      "/chat/c1",
    );
    expect(screen.getByText(E.origin.delivered)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "report.pdf" })).toBeTruthy();
    // the preview and its facts stand in the detail's one box
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("Share opens the share dialog for the library file", async () => {
    const calls = stubApi({
      ...routes,
      ...detailRoutes,
      [`GET ${FILES}/f1/shares`]: ok({
        shares: [],
        policy: { external: "allowed", maxExpiryDays: 30 },
      }),
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("report.pdf"));
    await user.click(await screen.findByRole("button", { name: E.actions.share }));
    expect(await screen.findByRole("dialog", { name: "Share report.pdf" })).toBeTruthy();
    await vi.waitFor(() => expect(calls.some((c) => c.url === `${FILES}/f1/shares`)).toBe(true));
  });

  it("delete confirms, then invalidates the list and the usage (read again)", async () => {
    let deleted = false;
    const calls = stubApi({
      ...routesOf(() => (deleted ? [UPLOAD] : [file(), UPLOAD])),
      ...detailRoutes,
      [`DELETE ${FILES}/f1`]: () => {
        deleted = true;
        return noContent();
      },
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("report.pdf"));
    // the open file's head holds its actions (the share and download buttons, the menu)
    const head = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-part="library-detail-head"]');
      if (el === null) throw new Error("no detail head");
      return el;
    });
    // the wide form's menu (jsdom draws both class forms)
    const more = within(head).getAllByRole("button", { name: en.common.moreActions });
    await user.click(more[more.length - 1] as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: E.actions.delete }));
    const dialog = await screen.findByRole("dialog", { name: "Delete report.pdf?" });
    await user.click(within(dialog).getByRole("button", { name: E.delete.confirm }));
    await vi.waitFor(() => expect(screen.queryByText("report.pdf")).toBeNull());
    expect(calls.some((c) => c.method === "DELETE" && c.url === `${FILES}/f1`)).toBe(true);
    expect(calls.filter((c) => c.method === "GET" && c.url === FILES).length).toBeGreaterThan(0);
    expect(calls.some((c) => c.method === "GET" && c.url === `${FILES}/usage`)).toBe(true);
    expect(window.location.hash).toBe("");
  });

  it("a guest sees the no-access state and nothing is read", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/files", {}, { me: asRole("guest") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});
