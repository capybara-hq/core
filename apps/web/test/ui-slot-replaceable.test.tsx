// Client extensions spec §6.3, §6.4, §7.4, §9.6, §10: a replaceable slot renders its winner or the
// built-in. A winner that throws, fails to load or drops the composer falls back to the built-in
// (reported once); one still loading hides the built-in for at most 1 500 ms; safe mode renders the
// built-in; the overlay is never rendered on admin pages.
import { DesignProvider, type LinkComponent, ToastProvider } from "@capybara-hq/design";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import { ComposerBar } from "../src/components/conversation/ComposerBar";
import { ExtensionSlot } from "../src/components/extension-ui/ExtensionSlot";
import { AppFrame } from "../src/components/shell/AppFrame";
import { ThemeRoot } from "../src/components/theme-root";
import type { ClientExtensionItem, ClientExtensionsResponse } from "../src/lib/client-extensions";
import { contributionsQuery } from "../src/lib/query/conversation";
import { meQuery } from "../src/lib/query/shell";
import type { UiContributionItem, UiSlotId } from "../src/lib/ui";
import { bodyOf, type Call, noContent, stubApi } from "./support/api";
import { Link, resetNavigation } from "./support/navigation";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";
import { shellClient, shellOf } from "./support/shell";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BUILD = "b".repeat(64);
const REPORTS = "POST /api/v1/orgs/o1/ui/client/reports";

const winner = (id: string, slot: UiSlotId): UiContributionItem => ({
  plugin: "fake-client",
  id,
  title: { zh: id, en: id },
  slot,
  kind: "component",
  icon: "puzzle",
});

const setOf = (components: { id: string; slot: string }[]): ClientExtensionsResponse => {
  const item: ClientExtensionItem = {
    plugin: "fake-client",
    build: BUILD,
    entry: { url: `/api/v1/client/fake-client/${BUILD}/client.mjs`, integrity: "sha384-e" },
    styles: [],
    components,
  };
  return { enabled: true, apiVersion: 1, items: [item] };
};

const moduleOf = (renders: Record<string, { slot: string; render: ComponentType<never> }>) => ({
  default: { name: "fake-client", apiVersion: 1, components: renders },
});

let calls: Call[] = [];
const reports = () => calls.filter((c) => `${c.method} ${c.url}` === REPORTS).map(bodyOf);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

const BUILTIN = <span data-testid="builtin">CAPYBARA</span>;

const brandSlot = (collapsed = false) => (
  <ExtensionSlot slot="shell.brand" args={{ orgId: "o1" }} host={{ builtin: BUILTIN, collapsed }} />
);

const BRAND_SET = setOf([{ id: "brand", slot: "shell.brand" }]);

function renderSlot(
  items: UiContributionItem[],
  set: ClientExtensionsResponse | null,
  ui: ReactNode,
  safe = false,
) {
  const client = testQueryClient();
  client.setQueryData(contributionsQuery("o1").queryKey, items);
  client.setQueryData(meQuery().queryKey, ME);
  const tree = (node: ReactNode) => (
    <ClientHost set={set} safe={safe} scope="org" orgId="o1">
      {node}
    </ClientHost>
  );
  const view = renderPage(tree(ui), { client });
  return {
    ...view,
    again: (node: ReactNode) => view.rerender(pageElement(tree(node), { client })),
  };
}

/** The replaceable frame around the slot: `true` while the built-in is hidden. */
const pending = () =>
  document.querySelector('[data-part="replaceable-frame"]')?.getAttribute("data-pending") ===
  "true";

const realLoad = ClientHost.load;
beforeEach(() => {
  resetNavigation("/agents");
  window.history.replaceState(null, "", "/agents");
  sessionStorage.clear();
  calls = stubApi({ [REPORTS]: () => noContent() });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  ClientHost.load = realLoad;
});

describe("ReplaceableSlot", () => {
  it("no winner renders the built-in", async () => {
    ClientHost.load = vi.fn(async () => moduleOf({}));
    renderSlot([], setOf([]), brandSlot());
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
  });

  it("the winner renders and can wrap builtin", async () => {
    const Brand = ({ builtin, collapsed }: { builtin: ReactNode; collapsed: boolean }) => (
      <span data-testid="fake-client-brand" data-collapsed={String(collapsed)}>
        {builtin}
      </span>
    );
    ClientHost.load = vi.fn(async () =>
      moduleOf({ brand: { slot: "shell.brand", render: Brand as ComponentType<never> } }),
    );
    renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot(true));
    await flush();
    const wrap = screen.getByTestId("fake-client-brand");
    expect(wrap.getAttribute("data-collapsed")).toBe("true");
    expect(wrap.contains(screen.getByTestId("builtin"))).toBe(true);
    expect(pending()).toBe(false);
  });

  it("with the winners prefetched, the winner renders at the slot's first render", async () => {
    const Brand = () => <span data-testid="fake-client-brand">NEON</span>;
    ClientHost.load = vi.fn(async () =>
      moduleOf({ brand: { slot: "shell.brand", render: Brand } }),
    );
    // the layout's shell read put the contributions in the cache (getShell, spec §6.3)
    const view = renderSlot([winner("brand", "shell.brand")], BRAND_SET, null);
    await flush();
    // a page that renders the slot once the module is in (a client navigation to `/`)
    view.again(brandSlot());
    expect(screen.getByTestId("fake-client-brand")).toBeTruthy();
    expect(screen.queryByTestId("builtin")).toBeNull();
    expect(pending()).toBe(false);
    expect(calls.filter((c) => c.url.includes("/ui/contributions"))).toEqual([]);
  });

  it("a throwing winner falls back to the built-in and reports once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let renders = 0;
    const Boom = (): ReactNode => {
      renders++;
      throw new Error("brand broke");
    };
    ClientHost.load = vi.fn(async () => moduleOf({ brand: { slot: "shell.brand", render: Boom } }));
    const view = renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot());
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    const after = renders;
    // two re-renders keep the built-in: the winner is not tried again, nothing more is reported
    view.again(brandSlot(true));
    await flush();
    view.again(brandSlot(false));
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(renders).toBe(after);
    expect(reports()).toEqual([
      {
        plugin: "fake-client",
        build: BUILD,
        contribution: "brand",
        kind: "render",
        message: "brand broke",
      },
    ]);
  });

  it("a loading winner hides the built-in for at most 1500 ms", async () => {
    vi.useFakeTimers();
    let resolve: (m: unknown) => void = () => {};
    ClientHost.load = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const Brand = () => <span data-testid="fake-client-brand">NEON</span>;
    renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot());
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1499);
    });
    expect(pending()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(pending()).toBe(false);
    expect(screen.getByTestId("builtin")).toBeTruthy();
    resolve(moduleOf({ brand: { slot: "shell.brand", render: Brand } }));
    await flush();
    expect(screen.getByTestId("fake-client-brand")).toBeTruthy();
    expect(screen.queryByTestId("builtin")).toBeNull();
  });

  it("the read naming the winner hides the built-in for at most 1500 ms too", async () => {
    vi.useFakeTimers();
    calls = stubApi({
      [REPORTS]: () => noContent(),
      "GET /api/v1/orgs/o1/ui/contributions": () => new Promise<Response>(() => {}),
    });
    ClientHost.load = vi.fn(async () => moduleOf({}));
    const client = testQueryClient();
    client.setQueryData(meQuery().queryKey, ME);
    renderPage(
      <ClientHost set={BRAND_SET} safe={false} scope="org" orgId="o1">
        {brandSlot()}
      </ClientHost>,
      { client },
    );
    await flush();
    expect(pending()).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    expect(pending()).toBe(false);
    expect(screen.getByTestId("builtin")).toBeTruthy();
  });

  it("without client code for the slot nothing is read", async () => {
    calls = stubApi({ [REPORTS]: () => noContent() });
    ClientHost.load = vi.fn(async () => moduleOf({}));
    const client = testQueryClient();
    client.setQueryData(meQuery().queryKey, ME);
    renderPage(
      <ClientHost
        set={setOf([{ id: "hud", slot: "conversation.properties.section" }])}
        safe={false}
        scope="org"
        orgId="o1"
      >
        {brandSlot()}
      </ClientHost>,
      { client },
    );
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
    expect(calls.filter((c) => c.url.includes("/ui/contributions"))).toEqual([]);
  });

  it("a failed load renders the built-in", async () => {
    ClientHost.load = vi.fn(async () => {
      throw new Error("integrity mismatch");
    });
    renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot());
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
  });

  it("a winner whose module lacks the component renders the built-in", async () => {
    ClientHost.load = vi.fn(async () => moduleOf({}));
    renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot());
    await flush();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
  });

  it("a composer frame that drops children falls back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const composer = (
      <div data-cap-part="composer">
        <textarea aria-label="Message" />
      </div>
    );
    const frame = (
      <ExtensionSlot
        slot="conversation.composer.frame"
        args={{ orgId: "o1" }}
        host={{ builtin: composer, children: composer, conversationId: null, runState: "idle" }}
      />
    );
    const Drop = () => <div data-testid="frame">no composer here</div>;
    ClientHost.load = vi.fn(async () =>
      moduleOf({ frame: { slot: "conversation.composer.frame", render: Drop } }),
    );
    renderSlot(
      [winner("frame", "conversation.composer.frame")],
      setOf([{ id: "frame", slot: "conversation.composer.frame" }]),
      frame,
    );
    await flush();
    expect(screen.queryByTestId("frame")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
    expect(reports()).toEqual([
      expect.objectContaining({ plugin: "fake-client", contribution: "frame", kind: "render" }),
    ]);
  });

  it("a composer frame that renders its children stays", async () => {
    const composer = (
      <div data-cap-part="composer">
        <textarea aria-label="Message" />
      </div>
    );
    const Wrap = ({ children, runState }: { children: ReactNode; runState: string }) => (
      <div data-testid="frame" data-run={runState}>
        {children}
      </div>
    );
    ClientHost.load = vi.fn(async () =>
      moduleOf({
        frame: { slot: "conversation.composer.frame", render: Wrap as ComponentType<never> },
      }),
    );
    renderSlot(
      [winner("frame", "conversation.composer.frame")],
      setOf([{ id: "frame", slot: "conversation.composer.frame" }]),
      <ExtensionSlot
        slot="conversation.composer.frame"
        args={{ orgId: "o1" }}
        host={{ builtin: composer, children: composer, conversationId: "c1", runState: "running" }}
      />,
    );
    await flush();
    const frame = screen.getByTestId("frame");
    expect(frame.getAttribute("data-run")).toBe("running");
    expect(frame.querySelector("textarea")).not.toBeNull();
    expect(reports()).toEqual([]);
  });

  it("a winner wrapping the composer's children draws one frame, not two", async () => {
    const Wrap = ({ children }: { children: ReactNode }) => (
      <div data-testid="plugin-frame">{children}</div>
    );
    ClientHost.load = vi.fn(async () =>
      moduleOf({
        frame: { slot: "conversation.composer.frame", render: Wrap as ComponentType<never> },
      }),
    );
    const noop = () => {};
    renderSlot(
      [winner("frame", "conversation.composer.frame")],
      setOf([{ id: "frame", slot: "conversation.composer.frame" }]),
      <ComposerBar
        orgId="o1"
        running={false}
        onSend={async () => ({ ok: true }) as never}
        pickers={{ model: { label: "Model", value: "m", groups: [], onPick: noop } }}
        placeholder="Message"
      />,
    );
    await flush();
    const frame = screen.getByTestId("plugin-frame");
    // the design composer inside is bare: the plugin's frame is the only box
    const composers = document.querySelectorAll('[data-part="composer"]');
    expect(composers).toHaveLength(1);
    expect(frame.contains(composers[0] as Node)).toBe(true);
    expect(composers[0]?.getAttribute("data-frame")).toBe("bare");
    expect(frame.querySelector("textarea")).not.toBeNull();
    expect(reports()).toEqual([]);
  });

  it("without a winner the composer keeps its own frame", async () => {
    const noop = () => {};
    renderSlot(
      [],
      setOf([]),
      <ComposerBar
        orgId="o1"
        running={false}
        onSend={async () => ({ ok: true }) as never}
        pickers={{ model: { label: "Model", value: "m", groups: [], onPick: noop } }}
        placeholder="Message"
      />,
    );
    await flush();
    const composers = document.querySelectorAll('[data-part="composer"]');
    expect(composers).toHaveLength(1);
    expect(composers[0]?.getAttribute("data-frame")).toBeNull();
  });

  it("safe mode renders the built-in", async () => {
    ClientHost.load = vi.fn(async () =>
      moduleOf({ brand: { slot: "shell.brand", render: () => <span>NEON</span> } }),
    );
    renderSlot([winner("brand", "shell.brand")], BRAND_SET, brandSlot(), true);
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
  });

  it("the kill switch renders the built-in", async () => {
    ClientHost.load = vi.fn(async () => moduleOf({}));
    renderSlot(
      [winner("brand", "shell.brand")],
      { enabled: false, apiVersion: 1, items: [] },
      brandSlot(),
    );
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(screen.getByTestId("builtin")).toBeTruthy();
    expect(pending()).toBe(false);
  });
});

describe("shell slots in AppFrame", () => {
  const OVERLAY_SET = setOf([
    { id: "fx", slot: "shell.overlay" },
    { id: "brand", slot: "shell.brand" },
  ]);
  const Fx = () => <i data-testid="fx" />;
  const Brand = ({ builtin }: { builtin: ReactNode }) => (
    <span data-testid="fake-client-brand">{builtin}</span>
  );

  function renderFrameAt(path: string) {
    resetNavigation(path);
    window.history.replaceState(null, "", path);
    const client = shellClient(shellOf(ME));
    client.setQueryData(contributionsQuery("o1").queryKey, [
      winner("fx", "shell.overlay"),
      winner("brand", "shell.brand"),
    ]);
    ClientHost.load = vi.fn(async () =>
      moduleOf({
        fx: { slot: "shell.overlay", render: Fx },
        brand: { slot: "shell.brand", render: Brand as ComponentType<never> },
      }),
    );
    return render(
      <QueryClientProvider client={client}>
        <NextIntlClientProvider locale="en" messages={en}>
          <DesignProvider locale="en" link={Link as LinkComponent}>
            <ToastProvider>
              <ThemeRoot orgId="o1">
                <ClientHost set={OVERLAY_SET} safe={false} scope="org" orgId="o1">
                  <AppFrame version="v9.9.9">
                    <p>page body</p>
                  </AppFrame>
                </ClientHost>
              </ThemeRoot>
            </ToastProvider>
          </DesignProvider>
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
  }

  it("the overlay renders in the decoration layer and the brand replaces the logo", async () => {
    renderFrameAt("/agents");
    await flush();
    const layer = document.querySelector('[data-part="decoration-layer"]');
    expect(layer?.querySelector('[data-testid="fx"]')).not.toBeNull();
    const row = document.querySelector('[data-cap-part="sidebar.brand"]');
    expect(row?.querySelector('[data-testid="fake-client-brand"]')).not.toBeNull();
  });

  it("the overlay is not rendered on admin pages", async () => {
    renderFrameAt("/admin");
    await flush();
    expect(screen.getByText("page body")).toBeTruthy();
    expect(document.querySelector('[data-part="decoration-layer"]')).toBeNull();
    expect(screen.queryByTestId("fx")).toBeNull();
    // no replacements on the admin console either: the built-in logo
    expect(screen.queryByTestId("fake-client-brand")).toBeNull();
  });
});
