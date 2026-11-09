// Client extensions spec §9.4, §9.6, §10, §11: the client host imports the entries of the
// document's set (through the loader seam `ClientHost.load`), checks them, keeps the registry,
// applies the crash budget, reports once, feeds the plugins' `events`, withdraws plugins no longer
// listed and turns client navigations across the boundary into document loads.
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { type ReactNode, useContext } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import { DISABLED_KEY } from "../src/components/client-ext/crash-budget";
import { type CapybaraEvent, emitClientEvent } from "../src/components/client-ext/events";
import {
  HostContext,
  type HostContextValue,
  PLUGIN_CLIENT,
  useHostServices,
} from "../src/components/client-ext/host-api";
import {
  type ClientHostControls,
  useClientHostControls,
  useClientRegistry,
} from "../src/components/client-ext/registry";
import { RunStateProvider, usePublishRunState } from "../src/components/client-ext/run-state";
import type { ClientExtensionItem, ClientExtensionsResponse } from "../src/lib/client-extensions";
import { DESIGN_SUBSET, PLUGIN_CLIENT_EXPORTS } from "../src/lib/client-host/api.generated";
import { meQuery } from "../src/lib/query/shell";
import { bodyOf, type Call, noContent, stubApi } from "./support/api";
import { pathname, resetNavigation } from "./support/navigation";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BUILD = "b".repeat(64);
const item = (over: Partial<ClientExtensionItem> = {}): ClientExtensionItem => ({
  plugin: "fake-client",
  build: BUILD,
  entry: { url: `/api/v1/client/fake-client/${BUILD}/client.mjs`, integrity: "sha384-e" },
  styles: [],
  components: [{ id: "hud", slot: "conversation.properties.section" }],
  ...over,
});
const setOf = (...items: ClientExtensionItem[]): ClientExtensionsResponse => ({
  enabled: true,
  apiVersion: 1,
  items,
});
const Hud = () => null;
const ext = (over: Record<string, unknown> = {}) => ({
  default: {
    name: "fake-client",
    apiVersion: 1,
    components: { hud: { slot: "conversation.properties.section", render: Hud } },
    ...over,
  },
});

/** The registry as text: `plugin:status[components]`. */
function RegistryProbe() {
  const r = useClientRegistry();
  return (
    <output data-testid="registry">
      {Object.entries(r)
        .map(
          ([p, e]) => `${p}:${e.status}[${Object.keys(e.definition?.components ?? {}).join(",")}]`,
        )
        .join(" ")}
    </output>
  );
}
const registryText = () => screen.getByTestId("registry").textContent;

let controls: ClientHostControls | null = null;
function ControlsProbe() {
  controls = useClientHostControls();
  return null;
}

const REPORTS = "POST /api/v1/orgs/o1/ui/client/reports";
let calls: Call[] = [];
const reports = () => calls.filter((c) => `${c.method} ${c.url}` === REPORTS).map(bodyOf);

const host = (
  set: ClientExtensionsResponse | null,
  o: { safe?: boolean; children?: ReactNode } = {},
) => (
  <ClientHost set={set} safe={o.safe ?? false} scope="org" orgId="o1">
    <RegistryProbe />
    <ControlsProbe />
    {o.children}
  </ClientHost>
);

/** Lets the loads and the state updates they trigger settle. */
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

const realLoad = ClientHost.load;
const realNavigate = ClientHost.navigate;
const realReload = ClientHost.reload;
let navigate: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetNavigation("/agents");
  window.history.replaceState(null, "", "/agents");
  sessionStorage.clear();
  calls = stubApi({ [REPORTS]: () => noContent() });
  navigate = vi.fn();
  ClientHost.navigate = navigate as unknown as typeof ClientHost.navigate;
  reload = vi.fn();
  ClientHost.reload = reload as unknown as typeof ClientHost.reload;
  controls = null;
  delete (globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__;
});
afterEach(() => {
  cleanup();
  // biome-ignore lint/suspicious/noDocumentCookie: reset the safe-mode session cookie
  document.cookie = "cap_safe_ui=; path=/; max-age=0";
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ClientHost.load = realLoad;
  ClientHost.navigate = realNavigate;
  ClientHost.reload = realReload;
  for (const l of document.querySelectorAll('link[data-precedence="extensions"]')) l.remove();
});

describe("ClientHost", () => {
  it("the host global is set before the first import", async () => {
    let seen: Record<string, unknown> | undefined;
    ClientHost.load = vi.fn(async (url: string) => {
      seen = (globalThis as unknown as Record<string, Record<string, unknown> | undefined>)
        .__CAPYBARA_CLIENT_HOST__;
      expect(url).toBe(`/api/v1/client/fake-client/${BUILD}/client.mjs`);
      return ext();
    });
    renderPage(host(setOf(item())));
    await flush();
    expect(ClientHost.load).toHaveBeenCalledTimes(1);
    expect(seen).toBeDefined();
    expect(Object.keys(seen ?? {}).sort()).toEqual(
      ["apiVersion", "design", "jsxRuntime", "pluginClient", "react", "reactDom"].sort(),
    );
    expect(seen?.apiVersion).toBe(1);
    expect(typeof (seen as { react: { createElement?: unknown } }).react.createElement).toBe(
      "function",
    );
    expect(typeof (seen as { jsxRuntime: { jsx?: unknown } }).jsxRuntime.jsx).toBe("function");
    expect(typeof (seen as { reactDom: { createPortal?: unknown } }).reactDom.createPortal).toBe(
      "function",
    );
    // the plugin-client implementation provides exactly the package's runtime exports
    expect(Object.keys(seen?.pluginClient as object).sort()).toEqual([...PLUGIN_CLIENT_EXPORTS]);
    expect(Object.keys(seen?.design as object).sort()).toEqual([...DESIGN_SUBSET]);
    expect(registryText()).toBe("fake-client:ready[hud]");
    expect(reports()).toEqual([]);
  });

  it("entries load in plugin-name order, in parallel", async () => {
    const order: string[] = [];
    ClientHost.load = vi.fn((url: string) => {
      order.push(url.split("/")[4] ?? "");
      return new Promise<unknown>(() => {});
    });
    const z = item({
      plugin: "zeta",
      entry: { url: `/api/v1/client/zeta/${BUILD}/client.mjs`, integrity: "x" },
    });
    const a = item({
      plugin: "alpha",
      entry: { url: `/api/v1/client/alpha/${BUILD}/client.mjs`, integrity: "x" },
    });
    renderPage(host(setOf(z, a)));
    await flush();
    expect(order).toEqual(["alpha", "zeta"]);
    expect(registryText()).toBe("alpha:loading[] zeta:loading[]");
  });

  it("reports go to the admin route with the message cut to 500 characters", async () => {
    const adminCalls = stubApi({ "POST /api/v1/admin/ui/client/reports": () => noContent() });
    ClientHost.load = vi.fn(async () => {
      throw new Error("x".repeat(600));
    });
    renderPage(
      <ClientHost set={setOf(item())} safe={false} scope="admin" orgId={null}>
        <RegistryProbe />
      </ClientHost>,
    );
    await flush();
    expect(adminCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/v1/admin/ui/client/reports",
    ]);
    expect(bodyOf(adminCalls[0])).toEqual({
      plugin: "fake-client",
      build: BUILD,
      contribution: null,
      kind: "load",
      message: "x".repeat(500),
    });
  });

  it("a module whose name differs is not activated and reported once", async () => {
    ClientHost.load = vi.fn(async () => ext({ name: "other-plugin" }));
    const view = renderPage(host(setOf(item())));
    await flush();
    expect(registryText()).toBe("fake-client:failed[]");
    view.rerender(pageElement(host(setOf(item()))));
    await flush();
    expect(reports()).toEqual([
      {
        plugin: "fake-client",
        build: BUILD,
        contribution: null,
        kind: "load",
        message: expect.stringContaining("other-plugin"),
      },
    ]);
  });

  it("an unsupported apiVersion is reported with kind api", async () => {
    ClientHost.load = vi.fn(async () => ext({ apiVersion: 2 }));
    renderPage(host(setOf(item())));
    await flush();
    expect(registryText()).toBe("fake-client:failed[]");
    expect(reports()).toEqual([
      expect.objectContaining({ plugin: "fake-client", kind: "api", contribution: null }),
    ]);
  });

  it("a component bound to another slot is dropped", async () => {
    ClientHost.load = vi.fn(async () =>
      ext({
        components: {
          hud: { slot: "shell.brand", render: Hud },
          brand: { slot: "shell.brand", render: Hud },
          ok: { slot: "conversation.panel", render: Hud },
        },
      }),
    );
    renderPage(
      host(
        setOf(
          item({
            components: [
              { id: "hud", slot: "conversation.properties.section" },
              { id: "ok", slot: "conversation.panel" },
            ],
          }),
        ),
      ),
    );
    await flush();
    // `brand` is not listed for the viewer: left out silently; `hud` binds another slot
    expect(registryText()).toBe("fake-client:ready[ok]");
    expect(reports()).toEqual([expect.objectContaining({ contribution: "hud", kind: "api" })]);
  });

  it("a load that never resolves fails after 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ClientHost.load = vi.fn(() => new Promise<unknown>(() => {}));
    renderPage(host(setOf(item())));
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(9_999);
    });
    await flush();
    expect(registryText()).toBe("fake-client:loading[]");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(registryText()).toBe("fake-client:failed[]");
    expect(reports()).toEqual([
      expect.objectContaining({ kind: "load", message: expect.stringContaining("10 s") }),
    ]);
  });

  it("three errors disable the plugin for the session", async () => {
    ClientHost.load = vi.fn(async () => ext());
    renderPage(host(setOf(item())));
    await flush();
    expect(registryText()).toBe("fake-client:ready[hud]");
    await act(async () => {
      controls?.reportError("fake-client", "hud", "render", new Error("boom"));
      controls?.reportError("fake-client", "hud", "render", new Error("boom"));
    });
    expect(registryText()).toBe("fake-client:ready[hud]");
    expect(sessionStorage.getItem(DISABLED_KEY)).toBeNull();
    await act(async () => {
      controls?.reportError("fake-client", null, "event", new Error("bang"));
    });
    expect(registryText()).toBe("fake-client:disabled[]");
    expect(JSON.parse(sessionStorage.getItem(DISABLED_KEY) ?? "[]")).toEqual([
      `fake-client/${BUILD}`,
    ]);
    // one report per (contribution, kind), plus the budget's; the notice offers safe mode
    expect(reports().map((r) => (r as { kind: string }).kind)).toEqual([
      "render",
      "event",
      "budget",
    ]);
    await screen.findByText(
      "The interface code of “fake-client” failed and is off for this session.",
    );
    fireEvent.click(screen.getByRole("button", { name: /Reload in safe mode/ }));
    expect(navigate).toHaveBeenCalledWith("/agents?safe-ui=1");
  });

  it("an uncaught error whose file is the plugin's build counts against it", async () => {
    ClientHost.load = vi.fn(async () => ext());
    renderPage(host(setOf(item())));
    await flush();
    await act(async () => {
      window.dispatchEvent(
        new ErrorEvent("error", {
          message: "kaput",
          error: new Error("kaput"),
          filename: `http://localhost:3000/api/v1/client/fake-client/${BUILD}/client.mjs`,
        }),
      );
      // someone else's error is not the plugin's
      window.dispatchEvent(
        new ErrorEvent("error", { message: "other", filename: "http://localhost:3000/_next/x.js" }),
      );
    });
    expect(reports()).toEqual([
      expect.objectContaining({ kind: "render", contribution: null, message: "kaput" }),
    ]);
  });

  it("a build switched off for the session is not imported; a new build is", async () => {
    sessionStorage.setItem(DISABLED_KEY, JSON.stringify([`fake-client/${BUILD}`]));
    ClientHost.load = vi.fn(async () => ext());
    renderPage(host(setOf(item())));
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(registryText()).toBe("fake-client:disabled[]");
    cleanup();
    const next = "c".repeat(64);
    renderPage(
      host(
        setOf(
          item({
            build: next,
            entry: { url: `/api/v1/client/fake-client/${next}/client.mjs`, integrity: "x" },
          }),
        ),
      ),
    );
    await flush();
    expect(ClientHost.load).toHaveBeenCalledTimes(1);
    expect(registryText()).toBe("fake-client:ready[hud]");
  });

  it("safe mode imports nothing", async () => {
    window.history.replaceState(null, "", "/agents?safe-ui=1&tab=x");
    ClientHost.load = vi.fn(async () => ext());
    const { container } = renderPage(host(setOf(item()), { safe: true }));
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect((globalThis as Record<string, unknown>).__CAPYBARA_CLIENT_HOST__).toBeUndefined();
    expect(registryText()).toBe("");
    expect(container.querySelector('[data-part="safe-mode-banner"]')).not.toBeNull();
  });

  it("safe mode holds through a client navigation and a refresh; the exit ends it", async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the proxy's session cookie, as the browser holds it
    document.cookie = "cap_safe_ui=1; path=/";
    window.history.replaceState(null, "", "/agents?safe-ui=1&tab=x");
    ClientHost.load = vi.fn(async () => ext());
    const css = `/api/v1/client/fake-client/${BUILD}/styles/a.css`;
    const withStyle = setOf(item({ styles: [{ url: css, integrity: "x" }] }));
    const { container, rerender } = renderPage(host(withStyle, { safe: true }));
    await flush();
    // a client navigation (the URL loses the parameter), then a refresh whose layout render says
    // safe=false and hoists the plugin's stylesheet
    pathname.current = "/skills";
    window.history.pushState(null, "", "/skills");
    rerender(pageElement(host(withStyle, { safe: false })));
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = css;
    sheet.setAttribute("data-precedence", "extensions");
    document.head.append(sheet);
    await flush();
    expect(sheet.disabled).toBe(true);
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(container.querySelector('[data-part="safe-mode-banner"]')).not.toBeNull();
    // and no document load across the boundary (it would end safe mode)
    pathname.current = "/admin";
    window.history.pushState(null, "", "/admin");
    rerender(pageElement(host(withStyle, { safe: false })));
    expect(navigate).not.toHaveBeenCalled();
    // the exit clears the session cookie and loads the page without the parameter
    window.history.replaceState(null, "", "/skills?safe-ui=1&tab=x");
    fireEvent.click(screen.getByRole("button", { name: "Exit safe mode" }));
    expect(document.cookie).not.toContain("cap_safe_ui=1");
    expect(navigate).toHaveBeenCalledWith("/skills?tab=x");
    sheet.remove();
  });

  it("a stylesheet of a build outside the document's set never applies", async () => {
    ClientHost.load = vi.fn(async () => ext());
    const oldCss = `/api/v1/client/fake-client/${BUILD}/styles/a.css`;
    const next = "e".repeat(64);
    const newCss = `/api/v1/client/fake-client/${next}/styles/a.css`;
    const sheet = (href: string) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.setAttribute("data-precedence", "extensions");
      document.head.append(l);
      return l;
    };
    const old = sheet(oldCss);
    const view = renderPage(host(setOf(item({ styles: [{ url: oldCss, integrity: "x" }] }))));
    await flush();
    expect(old.disabled).toBe(false);
    // the plugin upgraded: a refresh lists and hoists the new build's sheet
    const upgraded = item({
      build: next,
      entry: { url: `/api/v1/client/fake-client/${next}/client.mjs`, integrity: "y" },
      styles: [{ url: newCss, integrity: "y" }],
    });
    view.rerender(pageElement(host(setOf(upgraded))));
    const fresh = sheet(newCss);
    await flush();
    expect([old.disabled, fresh.disabled]).toEqual([false, true]);
    expect(ClientHost.load).toHaveBeenCalledTimes(1);
  });

  it("client code added to the live set offers one reload notice", async () => {
    ClientHost.load = vi.fn(async () => ext());
    const view = renderPage(host(setOf()));
    await flush();
    expect(screen.queryByText(en.clientExtensions.changed)).toBeNull();
    // the org admin turned a client plugin on: the next shell read lists it
    view.rerender(pageElement(host(setOf(item()))));
    await flush();
    expect(await screen.findByText(en.clientExtensions.changed)).toBeTruthy();
    // nothing is imported into this document: the new code waits for a document load
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(registryText()).toBe("");
    // the same set read again: still one notice
    view.rerender(pageElement(host(setOf(item()))));
    await flush();
    expect(screen.getAllByText(en.clientExtensions.changed)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: en.clientExtensions.reload }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a new build of a loaded plugin offers the notice; a withdrawal or a set without code does not", async () => {
    ClientHost.load = vi.fn(async () => ext());
    const view = renderPage(host(setOf(item())));
    await flush();
    // withdrawn, then listed again with the same build: nothing new to load
    view.rerender(pageElement(host(setOf())));
    await flush();
    view.rerender(pageElement(host(setOf(item()))));
    await flush();
    // a plugin without code (components only, no entry or stylesheet) carries nothing to load
    view.rerender(pageElement(host(setOf(item(), item({ plugin: "bare", entry: null })))));
    await flush();
    expect(screen.queryByText(en.clientExtensions.changed)).toBeNull();
    const next = "e".repeat(64);
    view.rerender(
      pageElement(
        host(
          setOf(
            item({
              build: next,
              entry: { url: `/api/v1/client/fake-client/${next}/client.mjs`, integrity: "y" },
            }),
          ),
        ),
      ),
    );
    expect(await screen.findByText(en.clientExtensions.changed)).toBeTruthy();
  });

  it("safe mode offers no reload notice", async () => {
    const view = renderPage(host(setOf(), { safe: true }));
    await flush();
    view.rerender(pageElement(host(setOf(item()), { safe: true })));
    await flush();
    expect(screen.queryByText(en.clientExtensions.changed)).toBeNull();
  });

  it("safe mode shows no banner when the viewer has no client code", async () => {
    const { container } = renderPage(host(setOf(), { safe: true }));
    await flush();
    expect(container.querySelector('[data-part="safe-mode-banner"]')).toBeNull();
  });

  it("a router push to /admin with a loaded set becomes location.assign", async () => {
    ClientHost.load = vi.fn(async () => ext());
    const view = renderPage(host(setOf(item())));
    await flush();
    // a link click across the boundary never reaches the router
    const a = document.createElement("a");
    a.href = "/admin/accounts?q=1";
    document.body.append(a);
    const routed = vi.fn();
    document.body.addEventListener("click", routed);
    fireEvent.click(a);
    expect(navigate).toHaveBeenCalledWith("/admin/accounts?q=1");
    expect(routed).not.toHaveBeenCalled();
    a.remove();
    // a programmatic push (or Back) is caught when the path changes
    navigate.mockClear();
    window.history.pushState(null, "", "/admin");
    pathname.current = "/admin";
    view.rerender(pageElement(host(setOf(item()))));
    expect(navigate).toHaveBeenCalledWith("/admin");
    document.body.removeEventListener("click", routed);
  });

  it("within the workspace, or without loaded code into the console, the router keeps the navigation", async () => {
    const view = renderPage(host(setOf()));
    await flush();
    pathname.current = "/skills";
    view.rerender(pageElement(host(setOf())));
    pathname.current = "/admin";
    view.rerender(pageElement(host(setOf())));
    expect(navigate).not.toHaveBeenCalled();
    // into a platform page that may carry client code, a document load
    pathname.current = "/admin/p/fake-client/console";
    view.rerender(pageElement(host(setOf())));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("a plugin dropped from the set has its stylesheet disabled", async () => {
    const sheet = (href: string) => {
      const l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.setAttribute("data-precedence", "extensions");
      document.head.append(l);
      return l;
    };
    const aUrl = `/api/v1/client/alpha/${BUILD}/styles/a.css`;
    const bUrl = `/api/v1/client/beta/${BUILD}/styles/b.css`;
    const la = sheet(aUrl);
    const lb = sheet(bUrl);
    const a = item({ plugin: "alpha", entry: null, styles: [{ url: aUrl, integrity: "x" }] });
    const b = item({ plugin: "beta", entry: null, styles: [{ url: bUrl, integrity: "y" }] });
    const view = renderPage(host(setOf(a, b)));
    await flush();
    expect([la.disabled, lb.disabled]).toEqual([false, false]);
    expect(registryText()).toBe("alpha:ready[] beta:ready[]");
    view.rerender(pageElement(host(setOf(a))));
    await flush();
    expect([la.disabled, lb.disabled]).toEqual([false, true]);
    expect(registryText()).toBe("alpha:ready[] beta:disabled[]");
  });

  it("a plugin's events listeners get client events; a throw counts as an error", async () => {
    const seen: unknown[] = [];
    ClientHost.load = vi.fn(async () =>
      ext({
        events: {
          "run.started": (e: CapybaraEvent, api: { assetUrl(p: string): string; locale: string }) =>
            seen.push([e.type, api.locale, api.assetUrl("sfx/boot.ogg")]),
          "run.failed": () => {
            throw new Error("listener broke");
          },
        },
      }),
    );
    const view = renderPage(host(setOf(item())));
    await flush();
    const base = { conversationId: "c1", seq: 1, at: "2026-11-09T00:00:00Z" };
    await act(async () => {
      emitClientEvent({ type: "run.started", ...base });
      emitClientEvent({ type: "run.failed", code: "x", ...base });
    });
    await flush();
    expect(seen).toEqual([
      ["run.started", "en", `/api/v1/client/fake-client/${BUILD}/assets/sfx/boot.ogg`],
    ]);
    expect(reports()).toEqual([
      expect.objectContaining({ kind: "event", message: "listener broke" }),
    ]);
    // a plugin no longer listed stops receiving events
    view.rerender(pageElement(host(setOf())));
    await flush();
    await act(async () => {
      emitClientEvent({ type: "run.started", ...base });
    });
    await flush();
    expect(seen).toHaveLength(1);
  });

  it("a component's host api follows the run state and client events; the hooks read it", async () => {
    ClientHost.load = vi.fn(async () => ext());
    const events: string[] = [];
    let api: ReturnType<typeof useHostServices> | null = null;
    function Component() {
      const services = useHostServices("fake-client", "hud");
      api = services;
      const value: HostContextValue = {
        plugin: "fake-client",
        contribution: "hud",
        slot: "conversation.properties.section",
        args: {},
        api: {
          ...services,
          view: { view: null, status: "loading", retry: () => {} },
          action: async () => ({}),
        },
      };
      return (
        <HostContext.Provider value={value}>
          <Inner />
        </HostContext.Provider>
      );
    }
    function Inner() {
      const h = PLUGIN_CLIENT as Record<string, (...a: unknown[]) => unknown>;
      const run = h.useRunState?.() as { state: string; conversationId: string | null };
      const access = h.useAccess?.() as { role: string; atLeast(r: string): boolean };
      h.useCapybaraEvents?.((e: CapybaraEvent) => events.push(e.type), ["tool.started"]);
      useContext(HostContext);
      return (
        <output data-testid="hooks">{`${run.state}:${run.conversationId} ${access.role} ${access.atLeast("admin")}`}</output>
      );
    }
    function Publisher({ state }: { state: "running" | "idle" }) {
      usePublishRunState("c9", state);
      return null;
    }
    const tree = (state: "running" | "idle") =>
      host(setOf(item()), {
        children: (
          <RunStateProvider>
            <Publisher state={state} />
            <Component />
          </RunStateProvider>
        ),
      });
    const client = testQueryClient();
    client.setQueryData(meQuery().queryKey, ME);
    const view = renderPage(tree("idle"), { client });
    await flush();
    expect(screen.getByTestId("hooks").textContent).toBe("idle:c9 owner true");
    view.rerender(pageElement(tree("running")));
    expect(screen.getByTestId("hooks").textContent).toBe("running:c9 owner true");
    expect(api).not.toBeNull();
    const base = { conversationId: "c9", seq: 2, at: "2026-11-09T00:00:00Z" };
    await act(async () => {
      emitClientEvent({ type: "tool.started", callId: "k", tool: "Bash", ...base });
      emitClientEvent({ type: "run.started", ...base });
    });
    await flush();
    expect(events).toEqual(["tool.started"]);
  });

  it("the hooks throw outside a host-rendered component", () => {
    const h = PLUGIN_CLIENT as Record<string, () => unknown>;
    function Outside() {
      h.useRunState?.();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderPage(<Outside />)).toThrow(/useRunState\(\) can only be used/);
    spy.mockRestore();
  });
});

describe("the error boundaries", () => {
  it("the route-level error page offers a reload in safe mode", async () => {
    const { ErrorFrame } = await import("../src/components/ErrorFrame");
    renderPage(<ErrorFrame reset={() => {}} safeReload />);
    expect(screen.getByRole("button", { name: "Reload in safe mode" })).toBeTruthy();
    cleanup();
    renderPage(<ErrorFrame reset={() => {}} />);
    expect(screen.queryByRole("button", { name: "Reload in safe mode" })).toBeNull();
  });
});
