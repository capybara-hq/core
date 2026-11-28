// Full plugin pages (plugin full pages spec §2, §4, §5): an `org.page` component with
// `frame: "page"` draws its whole page on `/p/<plugin>/<id>` (no host DetailPage; the host's
// crumbs reach its forwarded template, exactly one of which it must render); its params come from
// the address and `useNavigate` changes them, opens another page of the plugin or a conversation;
// `usePluginQuery` reads through the query cache, refetched by the org UI stream's `queries`
// frames and an action's `invalidate`. The components below stand in for the `fake-client-page`
// fixture's client bundle (`packages/testing/fixtures/extensions/fake-client-page`), written
// against the host's implementation of `@capybara-hq/plugin-client` (`PLUGIN_CLIENT`), as the
// bundle's import resolves in the browser.

import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type ComponentType, type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import PluginPageView from "../src/app/(app)/p/[plugin]/[id]/view";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import { PLUGIN_CLIENT } from "../src/components/client-ext/host-api";
import type { ClientExtensionsResponse } from "../src/lib/client-extensions";
import { pageParamsOf } from "../src/lib/page-params";
import { contributionsQuery } from "../src/lib/query/conversation";
import { keys } from "../src/lib/query/keys";
import { meQuery, readinessQuery } from "../src/lib/query/shell";
import type { Me } from "../src/lib/session";
import type { UiContributionItem } from "../src/lib/ui";
import { bodyOf, type Call, json, noContent, stubApi } from "./support/api";
import { FakeEventSource } from "./support/conversation";
import { resetNavigation, router } from "./support/navigation";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";
import { READY } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const PLUGIN = "fake-client-page";
const BUILD = "b".repeat(64);
const ORG = "/api/v1/orgs/o1";
const QUERY = `POST ${ORG}/ui/query/${PLUGIN}/board`;
const ACTION = `POST ${ORG}/ui/actions/${PLUGIN}/board`;
const REPORTS = `POST ${ORG}/ui/client/reports`;

const BOARD: UiContributionItem = {
  plugin: PLUGIN,
  id: "board",
  title: { zh: "看板", en: "Board" },
  slot: "org.page",
  kind: "component",
  icon: "puzzle",
  compact: "kept",
  frame: "page",
};

const SET: ClientExtensionsResponse = {
  enabled: true,
  apiVersion: 1,
  items: [
    {
      plugin: PLUGIN,
      build: BUILD,
      entry: { url: `/api/v1/client/${PLUGIN}/${BUILD}/client.mjs`, integrity: "sha384-e" },
      styles: [],
      components: [{ id: "board", slot: "org.page" }],
      signInId: "s1",
    },
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: the host's module, typed loosely as a bundle sees it
const pc = PLUGIN_CLIENT as Record<string, any>;
const ListPage = pc.ListPage as ComponentType<{
  header: { title: string; path?: { label: string; href?: string }[] };
  children?: ReactNode;
}>;
const DetailPage = pc.DetailPage as ComponentType<{
  header: { title: string };
  children?: ReactNode;
}>;

type Items = { items: { id: string; title: string }[] };

/** A query's state as text (`items:ready:Alpha`, `boom:error:<message>`) with its retry. */
function QueryLine({ name, params }: { name: string; params?: unknown }) {
  const q = pc.usePluginQuery(name, params) as {
    data: Items | undefined;
    status: string;
    error?: string;
    refetch(): void;
  };
  return (
    <p data-testid={`q-${name}`}>
      {`${name}:${q.status}:${q.data?.items.map((i) => i.title).join(",") ?? q.error ?? ""}`}
      <button type="button" onClick={q.refetch}>
        {`retry ${name}`}
      </button>
    </p>
  );
}

/** The fixture's board: one ListPage, its items query, params and navigation. */
let mounts = 0;
function Board() {
  const params = pc.usePageParams() as Record<string, string>;
  const navigate = pc.useNavigate() as (to: unknown) => void;
  const act = pc.useAction() as (id: string, i?: unknown) => Promise<unknown>;
  const [id] = useState(() => ++mounts);
  return (
    <ListPage header={{ title: "Board", path: [{ label: "Open" }] }}>
      <output data-testid="params">{JSON.stringify(params)}</output>
      <output data-testid="mount">{id}</output>
      <QueryLine name="items" params={{ col: params.col ?? null }} />
      <button type="button" onClick={() => navigate({ params: { col: "done", q: null } })}>
        to done
      </button>
      <button type="button" onClick={() => navigate({ params: { col: "x" }, replace: true })}>
        replace
      </button>
      <button
        type="button"
        onClick={() => {
          navigate({ params: { a: "1" } });
          navigate({ params: { b: "2" } });
        }}
      >
        twice
      </button>
      <button type="button" onClick={() => navigate({ conversation: "c1" })}>
        to chat
      </button>
      <button
        type="button"
        onClick={() => navigate({ page: { id: "summary", params: { a: "1" } } })}
      >
        to summary
      </button>
      <button type="button" onClick={() => void act("move", { payload: { id: "a" } })}>
        move
      </button>
    </ListPage>
  );
}

const moduleOf = (render: ComponentType<never>) => ({
  default: { name: PLUGIN, apiVersion: 1, components: { board: { slot: "org.page", render } } },
});

let calls: Call[] = [];
const queries = (name?: string) =>
  calls.filter(
    (c) =>
      `${c.method} ${c.url}` === QUERY &&
      (name === undefined || (bodyOf(c) as { query: string }).query === name),
  );
const reports = () => calls.filter((c) => `${c.method} ${c.url}` === REPORTS).map(bodyOf);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

const view = (params: Record<string, string>) => (
  <ClientHost set={SET} safe={false} scope="org" orgId="o1">
    <PluginPageView plugin={PLUGIN} id="board" params={params} />
  </ClientHost>
);

function renderBoard(
  render: ComponentType<never>,
  o: {
    params?: Record<string, string>;
    me?: Me;
    items?: UiContributionItem[];
    seed?: (client: QueryClient) => void;
  } = {},
) {
  ClientHost.load = vi.fn(async () => moduleOf(render));
  const client = testQueryClient();
  o.seed?.(client);
  const me = o.me ?? ME;
  client.setQueryData(meQuery().queryKey, me);
  client.setQueryData(readinessQuery("o1").queryKey, READY);
  client.setQueryData(contributionsQuery("o1").queryKey, o.items ?? [BOARD]);
  const r = renderPage(view(o.params ?? {}), { client, me });
  return {
    ...r,
    client,
    /** The address changed (a navigation, Back): Next renders the page with its new params. */
    address: (params: Record<string, string>) =>
      r.rerender(pageElement(view(params), { client, me })),
  };
}

const realLoad = ClientHost.load;
let itemsAnswer: () => Response;
beforeEach(() => {
  resetNavigation(`/p/${PLUGIN}/board`);
  sessionStorage.clear();
  mounts = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  itemsAnswer = () => json(200, { data: { items: [{ id: "a", title: "Alpha" }] } });
  calls = stubApi({
    [QUERY]: (c) => {
      const { query } = bodyOf(c) as { query: string };
      if (query === "items") return itemsAnswer();
      if (query === "boom") return json(502, { error: { code: "ui.query_failed", message: "x" } });
      if (query === "slow") return json(504, { error: { code: "ui.query_timeout", message: "x" } });
      return json(404, { error: { code: "ui.query_not_found", message: "x" } });
    },
    [ACTION]: () => json(200, { invalidate: ["items"] }),
    [REPORTS]: () => noContent(),
    [`GET ${ORG}/ui/arrangement`]: () => json(404, { error: { code: "not_found", message: "no" } }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeEventSource.instances = [];
  ClientHost.load = realLoad;
});

describe("frame page", () => {
  it("frame page renders without DetailPage and with scope crumbs", async () => {
    renderBoard(Board as ComponentType<never>);
    await flush();
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("ready"));
    expect(document.querySelectorAll('[data-template="DetailPage"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-template="ListPage"]')).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
    // the host's crumbs (the org, the extension pages' label), then the plugin's own path
    const text = document.body.textContent ?? "";
    const org = text.indexOf("acme");
    const label = text.indexOf(en.pluginPage.pathLabel);
    expect(org).toBeGreaterThanOrEqual(0);
    expect(org).toBeLessThan(label);
    expect(label).toBeLessThan(text.indexOf("Open"));
  });

  it("while the module loads, the host draws its own page around the loading state", async () => {
    ClientHost.load = vi.fn(() => new Promise<unknown>(() => {}));
    const client = testQueryClient();
    client.setQueryData(meQuery().queryKey, ME);
    client.setQueryData(readinessQuery("o1").queryKey, READY);
    client.setQueryData(contributionsQuery("o1").queryKey, [BOARD]);
    renderPage(view({}), { client });
    await flush();
    expect(document.querySelectorAll('[data-template="DetailPage"]')).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "Board" })).toBeTruthy();
  });

  it("two templates throw in tests (and none does): the failure line, counted as a crash", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const Two = () => (
      <>
        <ListPage header={{ title: "One" }} />
        <DetailPage header={{ title: "Two" }} />
      </>
    );
    renderBoard(Two as ComponentType<never>);
    await flush();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Board");
    // the failure line sits in the host's page
    expect(document.querySelectorAll('[data-template="DetailPage"]')).toHaveLength(1);
    await waitFor(() =>
      expect(reports()).toEqual([
        expect.objectContaining({
          plugin: PLUGIN,
          contribution: "board",
          kind: "render",
          message: expect.stringMatching(/exactly one page template.*rendered 2/),
        }),
      ]),
    );
    cleanup();
    calls.length = 0;
    const None = () => <p>no template</p>;
    renderBoard(None as ComponentType<never>);
    await flush();
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(reports()).toEqual([
        expect.objectContaining({ message: expect.stringMatching(/rendered 0/) }),
      ]),
    );
  });
});

describe("frame host", () => {
  it("a host-framed component that renders a page template throws in tests: no nested page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { frame: _frame, ...hosted } = BOARD;
    const Nested = () => <ListPage header={{ title: "Nested" }} />;
    renderBoard(Nested as ComponentType<never>, { items: [hosted] });
    await flush();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Board");
    // the host's page stays; the plugin's template is gone with the failure line in its place
    expect(document.querySelectorAll('[data-template="DetailPage"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-template="ListPage"]')).toHaveLength(0);
    await waitFor(() =>
      expect(reports()).toEqual([
        expect.objectContaining({
          contribution: "board",
          kind: "render",
          message: expect.stringMatching(/frame: "host".*no page template.*rendered 1/),
        }),
      ]),
    );
  });
});

describe("page params and navigation", () => {
  it("params round-trip: navigate({params}) updates the URL and usePageParams", async () => {
    const page = renderBoard(Board as ComponentType<never>, { params: { col: "todo", q: "x" } });
    await flush();
    expect(screen.getByTestId("params").textContent).toBe('{"col":"todo","q":"x"}');
    act(() => screen.getByRole("button", { name: "to done" }).click());
    expect(router.push).toHaveBeenCalledWith(`/p/${PLUGIN}/board?col=done`, { scroll: false });
    // the second call starts from the first one's params (col=done, no q)
    act(() => screen.getByRole("button", { name: "replace" }).click());
    expect(router.replace).toHaveBeenCalledWith(`/p/${PLUGIN}/board?col=x`, {
      scroll: false,
    });
    page.address({ col: "done" });
    await flush();
    expect(screen.getByTestId("params").textContent).toBe('{"col":"done"}');
    // the same component, not a new mount; its query reads with the new params
    expect(screen.getByTestId("mount").textContent).toBe("1");
    await waitFor(() =>
      expect(queries("items").map((c) => (bodyOf(c) as { params: unknown }).params)).toEqual([
        { col: "todo" },
        { col: "done" },
      ]),
    );
  });

  it("two quick navigations keep both changes (the second starts from the first)", async () => {
    const page = renderBoard(Board as ComponentType<never>, { params: { col: "todo" } });
    await flush();
    act(() => screen.getByRole("button", { name: "twice" }).click());
    expect(router.push.mock.calls.map((c) => c[0])).toEqual([
      `/p/${PLUGIN}/board?col=todo&a=1`,
      `/p/${PLUGIN}/board?col=todo&a=1&b=2`,
    ]);
    // the page's next params win again once they arrive
    page.address({ col: "done" });
    await flush();
    act(() => screen.getByRole("button", { name: "to done" }).click());
    expect(router.push).toHaveBeenLastCalledWith(`/p/${PLUGIN}/board?col=done`, { scroll: false });
  });

  it("browser back restores params", async () => {
    const page = renderBoard(Board as ComponentType<never>, { params: { col: "todo" } });
    await flush();
    page.address({ col: "done" });
    await flush();
    expect(screen.getByTestId("params").textContent).toBe('{"col":"done"}');
    // Back: the address is the earlier entry again
    page.address({ col: "todo" });
    await flush();
    expect(screen.getByTestId("params").textContent).toBe('{"col":"todo"}');
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("ready"));
  });

  it("navigate to a conversation opens /chat/<id>; to a page of the plugin, /p/<plugin>/<id>", async () => {
    renderBoard(Board as ComponentType<never>);
    await flush();
    act(() => screen.getByRole("button", { name: "to chat" }).click());
    expect(router.push).toHaveBeenLastCalledWith("/chat/c1");
    act(() => screen.getByRole("button", { name: "to summary" }).click());
    expect(router.push).toHaveBeenLastCalledWith(`/p/${PLUGIN}/summary?a=1`);
  });

  it("the host refuses any other target and values that are not strings", async () => {
    const seen: string[] = [];
    function Bad() {
      const navigate = pc.useNavigate() as (to: unknown) => void;
      const tryNav = (to: unknown) => {
        try {
          navigate(to);
          seen.push("ok");
        } catch (e) {
          seen.push((e as Error).message.slice(0, 15));
        }
      };
      return (
        <ListPage header={{ title: "Bad" }}>
          <button
            type="button"
            onClick={() => {
              tryNav({ url: "https://evil.example" });
              tryNav({ params: { a: ["1", "2"] } });
              tryNav({ params: { a: 1 } });
              tryNav({ page: { id: "x", params: { a: null } } });
              tryNav({ page: { id: "x" }, replace: true });
              tryNav({ conversation: "" });
              tryNav({ params: { a: "1" }, conversation: "c1" });
            }}
          >
            go
          </button>
        </ListPage>
      );
    }
    renderBoard(Bad as ComponentType<never>);
    await flush();
    act(() => screen.getByRole("button", { name: "go" }).click());
    expect(seen).toEqual(Array(7).fill("navigate target"));
    expect(router.push).not.toHaveBeenCalled();
  });

  it("params over 2 048 bytes are dropped with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const big = "x".repeat(2100);
    expect(pageParamsOf(new URLSearchParams({ a: "1", big, c: "3" }))).toEqual({ a: "1", c: "3" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped "big"'));
    expect(pageParamsOf({ a: ["1", "2"], b: undefined })).toEqual({ a: "1" });
  });

  it("the host's own query names never reach the plugin's params", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(pageParamsOf(new URLSearchParams("safe-ui=0&col=todo&org=o2"))).toEqual({ col: "todo" });
    expect(pageParamsOf({ "safe-ui": "1", org: "o2", q: "x" })).toEqual({ q: "x" });
    // the page's own address carries them for the host: silently
    expect(warn).not.toHaveBeenCalled();
    // nor can a plugin navigate to them
    function Sneaky() {
      const navigate = pc.useNavigate() as (to: unknown) => void;
      return (
        <ListPage header={{ title: "Sneaky" }}>
          <button
            type="button"
            onClick={() => navigate({ params: { "safe-ui": "0", org: "o2", col: "x" } })}
          >
            sneak
          </button>
        </ListPage>
      );
    }
    renderBoard(Sneaky as ComponentType<never>);
    await flush();
    act(() => screen.getByRole("button", { name: "sneak" }).click());
    expect(router.push).toHaveBeenLastCalledWith(`/p/${PLUGIN}/board?col=x`, { scroll: false });
    // a plugin that asks for them hears it once, by name
    const named = warn.mock.calls.filter((c) => String(c[0]).includes("reserved query names"));
    expect(named).toHaveLength(1);
    expect(String(named[0]?.[0])).toContain('"safe-ui", "org"');
  });
});

describe("component queries", () => {
  it("query error and timeout show the error state with retry, other components unaffected", async () => {
    let boomFails = true;
    const routes = {
      [QUERY]: (c: Call) => {
        const { query } = bodyOf(c) as { query: string };
        if (query === "items") return itemsAnswer();
        if (query === "boom" && boomFails) {
          return json(502, { error: { code: "ui.query_failed", message: "x" } });
        }
        if (query === "boom") return json(200, { data: { items: [{ id: "b", title: "Beta" }] } });
        return json(504, { error: { code: "ui.query_timeout", message: "x" } });
      },
      [REPORTS]: () => noContent(),
    };
    calls = stubApi(routes);
    const Page = () => (
      <ListPage header={{ title: "Queries" }}>
        <QueryLine name="items" />
        <QueryLine name="boom" />
        <QueryLine name="slow" />
      </ListPage>
    );
    renderBoard(Page as ComponentType<never>);
    await flush();
    await waitFor(() => {
      expect(screen.getByTestId("q-boom").textContent).toContain(
        `boom:error:${en.errors.ui.query_failed}`,
      );
      expect(screen.getByTestId("q-slow").textContent).toContain(
        `slow:error:${en.errors.ui.query_timeout}`,
      );
    });
    expect(screen.getByTestId("q-items").textContent).toContain("items:ready:Alpha");
    // not retried by the cache: the component's retry reads again
    expect(queries("boom")).toHaveLength(1);
    boomFails = false;
    act(() =>
      within(screen.getByTestId("q-boom")).getByRole("button", { name: "retry boom" }).click(),
    );
    await waitFor(() => expect(screen.getByTestId("q-boom").textContent).toContain("ready:Beta"));
    expect(queries("items")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the org UI stream's queries frame and an action's invalidate read the queries again", async () => {
    renderBoard(Board as ComponentType<never>);
    await flush();
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("Alpha"));
    expect(queries("items")).toHaveLength(1);
    const es = FakeEventSource.instances.find((e) => e.url === `${ORG}/ui/stream`);
    expect(es).toBeDefined();
    // the stream's first open: the query was answered after the subscription started, so the
    // page load does not read it twice
    await act(async () => {
      es?.emit("open");
    });
    await flush();
    expect(queries("items")).toHaveLength(1);
    calls.length = 0;
    itemsAnswer = () => json(200, { data: { items: [{ id: "a", title: "Alpha2" }] } });
    // another contribution's frame, or one without `queries`, reads nothing
    await act(async () => {
      es?.emit("ui", { plugin: PLUGIN, contribution: "summary", queries: true });
      es?.emit("ui", { plugin: PLUGIN, contribution: "board" });
    });
    await flush();
    expect(queries("items")).toHaveLength(0);
    await act(async () => {
      es?.emit("ui", { plugin: PLUGIN, contribution: "board", queries: true });
    });
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("Alpha2"));
    expect(queries("items")).toHaveLength(1);
    itemsAnswer = () => json(200, { data: { items: [{ id: "a", title: "Alpha3" }] } });
    fireEvent.click(screen.getByRole("button", { name: "move" }));
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("Alpha3"));
    expect(queries("items")).toHaveLength(2);
    // the stream ended: the content stays, with the line saying live refresh stopped
    expect(screen.queryByText(en.pluginPage.liveLost)).toBeNull();
    await act(async () => {
      es?.giveUp();
    });
    expect(screen.getByText(en.pluginPage.liveLost)).toBeTruthy();
    expect(screen.getByTestId("q-items").textContent).toContain("Alpha3");
  });

  it("the first open reads again a query answered before the subscription started", async () => {
    // a query that stays fresh for a minute: the cached answer is not read again on mount
    const Cached = () => {
      const q = pc.usePluginQuery("items", undefined, { staleMs: 60_000 }) as {
        data: Items | undefined;
      };
      return (
        <ListPage header={{ title: "Cached" }}>
          <p data-testid="cached">{q.data?.items.map((i) => i.title).join(",") ?? ""}</p>
        </ListPage>
      );
    };
    // learn the query's key from a first render
    const first = renderBoard(Cached as ComponentType<never>);
    await flush();
    await waitFor(() => expect(screen.getByTestId("cached").textContent).toBe("Alpha"));
    const [entry] = first.client
      .getQueryCache()
      .findAll({ queryKey: keys.org("o1").pluginQueries(PLUGIN, "board") });
    expect(entry).toBeDefined();
    cleanup();
    FakeEventSource.instances = [];
    calls.length = 0;
    // an answer cached before this page subscribed
    renderBoard(Cached as ComponentType<never>, {
      seed: (client) =>
        client.setQueryData(
          entry?.queryKey ?? [],
          { items: [{ id: "a", title: "Old" }] },
          { updatedAt: Date.now() - 10_000 },
        ),
    });
    await flush();
    expect(screen.getByTestId("cached").textContent).toBe("Old");
    expect(queries("items")).toHaveLength(0);
    const es = FakeEventSource.instances.find((e) => e.url === `${ORG}/ui/stream`);
    expect(es).toBeDefined();
    await act(async () => {
      es?.emit("open");
    });
    await waitFor(() => expect(screen.getByTestId("cached").textContent).toBe("Alpha"));
    expect(queries("items")).toHaveLength(1);
  });

  it("a page-frame component's live-refresh line sits in its template's head", async () => {
    renderBoard(Board as ComponentType<never>);
    await flush();
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("Alpha"));
    const es = FakeEventSource.instances.find((e) => e.url === `${ORG}/ui/stream`);
    await act(async () => {
      es?.giveUp();
    });
    const line = screen.getByText(en.pluginPage.liveLost);
    const template = document.querySelector('[data-template="ListPage"]');
    expect(template?.contains(line)).toBe(true);
    // nothing stray beside the template
    expect(document.querySelectorAll('[data-template="ListPage"]')).toHaveLength(1);
  });

  it("a host-framed component keeps its live-refresh line inside the host's page", async () => {
    const { frame: _frame, ...hosted } = BOARD;
    const Plain = () => <QueryLine name="items" />;
    renderBoard(Plain as ComponentType<never>, { items: [hosted] });
    await flush();
    await waitFor(() => expect(screen.getByTestId("q-items").textContent).toContain("Alpha"));
    const es = FakeEventSource.instances.find((e) => e.url === `${ORG}/ui/stream`);
    await act(async () => {
      es?.giveUp();
    });
    const line = screen.getByText(en.pluginPage.liveLost);
    expect(document.querySelector('[data-template="DetailPage"]')?.contains(line)).toBe(true);
    expect(screen.getByTestId("q-items").textContent).toContain("Alpha");
  });

  it("deep link without access shows the no-access state and calls no query", async () => {
    const outsider: Me = {
      ...ME,
      memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "visitor" }],
    };
    renderBoard(Board as ComponentType<never>, { me: outsider });
    await flush();
    expect(document.querySelector('[data-template="StatusPage"]')).not.toBeNull();
    expect(screen.queryByTestId("q-items")).toBeNull();
    cleanup();
    // a page the contributions list does not offer (and no arrangement names): not found
    renderBoard(Board as ComponentType<never>, { items: [] });
    await flush();
    await waitFor(() =>
      expect(
        document.querySelector('[data-template="StatusPage"]')?.getAttribute("data-kind"),
      ).toBe("404"),
    );
    expect(queries()).toHaveLength(0);
    expect(ClientHost.load).toHaveBeenCalled();
  });
});
