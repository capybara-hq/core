import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

beforeEach(() => {
  resetNavigation("/files");
  window.history.replaceState(null, "", "/files");
});
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

  it("Back closes the open file (the hash goes) and keeps its row current", async () => {
    stubApi({ ...routes, ...detailRoutes });
    const { container } = await renderRouteWithCache("/files", lastStubRoutes());
    const region = () => container.querySelector('[data-part="list-detail"]');
    const user = userEvent.setup();
    await user.click(screen.getByText("report.pdf"));
    expect(window.location.hash).toBe("#item=f1");
    await waitFor(() => expect(region()?.getAttribute("data-open")).toBe("true"));
    await user.click(screen.getAllByRole("button", { name: "Back" })[0] as HTMLElement);
    await waitFor(() => expect(region()?.getAttribute("data-open")).toBe("false"));
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/files");
    const row = document.querySelector('[data-part="list-row"][aria-current="true"]');
    expect(row?.textContent).toContain("report.pdf");
  });

  it("a deep link to a file that is gone says so in the detail", async () => {
    window.history.replaceState(null, "", "/files#item=fx");
    stubApi({
      ...routes,
      [`GET ${FILES}/fx`]: () => json(404, { error: { code: "file.not_found", message: "no" } }),
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    expect(await screen.findByText(E.detail.gone)).toBeTruthy();
  });

  it("Load more reads the next page by the kernel's cursor and appends it", async () => {
    const calls = stubApi({
      ...routes,
      [`GET ${FILES}`]: (c: { url: string }) =>
        c.url.includes("cursor=n1")
          ? json(200, { files: [file({ id: "f3", name: "older.pdf" })], next: null })
          : json(200, { files: [file(), UPLOAD], next: "n1" }),
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("older.pdf")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(calls.some((c) => c.url === `${FILES}?cursor=n1`)).toBe(true);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("the search writes q to the address after typing stops, then reads it", async () => {
    const lists = routesOf((url) => (url.includes("q=notes") ? [UPLOAD] : [file(), UPLOAD]));
    const calls = stubApi(lists);
    await renderRouteWithCache("/files", lists);
    const box = screen.getAllByRole("searchbox", { name: E.search })[0] as HTMLElement;
    await userEvent.setup().type(box, "notes");
    // nothing per keystroke: one read for the finished text
    await waitFor(() => expect(window.location.search).toBe("?q=notes"));
    await waitFor(() => expect(screen.queryByText("report.pdf")).toBeNull());
    expect(calls.filter((c) => c.url.startsWith(`${FILES}?q=`)).map((c) => c.url)).toEqual([
      `${FILES}?q=notes`,
    ]);
  });

  it("the agent and type selects write the address and read the list", async () => {
    const AG = { id: "ag1", definition: { name: "Helper" } };
    const lists = {
      ...routesOf((url) => (url.includes("type=image") ? [] : [file(), UPLOAD])),
      [`GET ${ORG}/agents`]: ok({ agents: [AG] }),
    };
    const calls = stubApi(lists);
    await renderRouteWithCache("/files", lists);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole("combobox", { name: E.filters.agent })[0] as HTMLElement);
    await user.click(await screen.findByRole("option", { name: "Helper" }));
    await waitFor(() => expect(window.location.search).toBe("?agent=ag1"));
    await waitFor(() => expect(calls.some((c) => c.url === `${FILES}?agentId=ag1`)).toBe(true));
    await user.click(screen.getAllByRole("combobox", { name: E.filters.type })[0] as HTMLElement);
    await user.click(await screen.findByRole("option", { name: E.types.image }));
    await waitFor(() => expect(window.location.search).toBe("?agent=ag1&type=image"));
    expect(await screen.findByText(E.empty.filtered)).toBeTruthy();
    expect(calls.some((c) => c.url === `${FILES}?agentId=ag1&type=image`)).toBe(true);
  });

  it("an upload posts the file to the library, then reads the list and usage again", async () => {
    let uploaded = false;
    const calls = stubApi({
      ...routesOf(() => (uploaded ? [file({ id: "f9", name: "a.txt" }), UPLOAD] : [UPLOAD])),
      [`POST ${FILES}`]: () => {
        uploaded = true;
        return json(201, {
          file: { id: "f9", name: "a.txt", contentType: "text/plain", size: 3, status: "ready" },
          upload: null,
          expiresAt: null,
        });
      },
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    const input = document.querySelector<HTMLInputElement>(
      'input[type="file"]',
    ) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["abc"], "a.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("a.txt")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.url === FILES);
    expect(JSON.parse(String(post?.body))).toMatchObject({ name: "a.txt", purpose: "library" });
    expect(calls.some((c) => c.method === "GET" && c.url === `${FILES}/usage`)).toBe(true);
  });

  it("deleting a row with earlier versions says only the newest goes", async () => {
    stubApi({
      ...routesOf(() => [file({ versions: 3 })]),
      ...detailRoutes,
    });
    await renderRouteWithCache("/files", lastStubRoutes());
    const user = userEvent.setup();
    await user.click(screen.getByText("report.pdf"));
    const head = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-part="library-detail-head"]');
      if (el === null) throw new Error("no detail head");
      return el;
    });
    const more = within(head).getAllByRole("button", { name: en.common.moreActions });
    await user.click(more[more.length - 1] as HTMLElement);
    await user.click(await screen.findByRole("menuitem", { name: E.actions.delete }));
    const dialog = await screen.findByRole("dialog", { name: "Delete report.pdf?" });
    expect(
      within(dialog).getByText(/Only the newest version is deleted.*The 2 earlier versions stay\./),
    ).toBeTruthy();
  });

  it("a guest sees the no-access state and nothing is read", async () => {
    const calls = stubApi({});
    await renderRouteWithCache("/files", {}, { me: asRole("guest") });
    expect(screen.getByText(en.roles.noAccess.title)).toBeTruthy();
    await settle();
    expect(calls).toEqual([]);
  });
});
