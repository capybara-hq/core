// Component pages and agent sections (client extensions spec §10.3, final review B-I2): the host
// draws the page or section with designed states, like a component panel. Loading: the loading
// state; a failed load: the failure line with a reload; off (safe mode, the kill switch, a spent
// crash budget, a withdrawn plugin): the designed "not available" state. The nav lists (the
// sidebar's extension pages, the agent page's sections, the admin console's platform pages) do not
// offer a component that is off.
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { useAdminExtensionPages } from "../src/components/admin-nav";
import { useSectionNav } from "../src/components/agent/frame";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import { DISABLED_KEY } from "../src/components/client-ext/crash-budget";
import { ExtensionSlot } from "../src/components/extension-ui/ExtensionSlot";
import { useExtensions } from "../src/components/shell/nav";
import type { ClientExtensionsResponse } from "../src/lib/client-extensions";
import { deploymentSettingsQuery } from "../src/lib/query/admin";
import { contributionsQuery } from "../src/lib/query/conversation";
import { extensionPagesQuery, meQuery } from "../src/lib/query/shell";
import { adminUiContributionsQuery } from "../src/lib/query/ui";
import type { UiContributionItem, UiSlotId } from "../src/lib/ui";
import { noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
const { reloadDocument } = vi.hoisted(() => ({ reloadDocument: vi.fn() }));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn(), reloadDocument }));

const BUILD = "b".repeat(64);
const C = en.clientExtensions;

const item = (plugin: string, id: string, slot: UiSlotId, kind: "component" | "view") =>
  ({
    plugin,
    id,
    title: { zh: id, en: id.toUpperCase() },
    slot,
    kind,
    icon: "puzzle",
  }) as UiContributionItem;

const setOf = (
  plugin: string,
  components: { id: string; slot: string }[],
  enabled = true,
): ClientExtensionsResponse => ({
  enabled,
  apiVersion: 1,
  items: enabled
    ? [
        {
          plugin,
          build: BUILD,
          entry: { url: `/api/v1/client/${plugin}/${BUILD}/client.mjs`, integrity: "sha384-e" },
          styles: [],
          components,
          signInId: "s1",
        },
      ]
    : [],
});

const moduleOf = (
  plugin: string,
  renders: Record<string, { slot: string; render: ComponentType<never> }>,
) => ({ default: { name: plugin, apiVersion: 1, components: renders } });

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

const BOARD = item("fake-client", "board", "org.page", "component");
const NOTES = item("fake-client", "notes", "agent.detail.section", "component");
const CONSOLE = item("fake-client", "console", "platform.page", "component");
const VIEW_PAGE = item("view-plugin", "report", "org.page", "view");

function renderHost(
  ui: ReactNode,
  o: {
    set: ClientExtensionsResponse | null;
    safe?: boolean;
    scope?: "org" | "admin";
    seed?: (client: ReturnType<typeof testQueryClient>) => void;
  },
) {
  const client = testQueryClient();
  client.setQueryData(meQuery().queryKey, ME);
  client.setQueryData(contributionsQuery("o1").queryKey, [BOARD, NOTES, VIEW_PAGE]);
  client.setQueryData(extensionPagesQuery("o1").queryKey, [BOARD, VIEW_PAGE]);
  client.setQueryData(adminUiContributionsQuery().queryKey, [CONSOLE]);
  o.seed?.(client);
  const scope = o.scope ?? "org";
  return renderPage(
    <ClientHost
      set={o.set}
      safe={o.safe ?? false}
      scope={scope}
      orgId={scope === "admin" ? null : "o1"}
    >
      {ui}
    </ClientHost>,
    { client },
  );
}

const realLoad = ClientHost.load;
beforeEach(() => {
  resetNavigation("/p/fake-client/board");
  sessionStorage.clear();
  reloadDocument.mockClear();
  stubApi({
    "POST /api/v1/orgs/o1/ui/client/reports": () => noContent(),
    "POST /api/v1/admin/ui/client/reports": () => noContent(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  ClientHost.load = realLoad;
});

const orgPage = (
  <ExtensionSlot
    slot="org.page"
    args={{ orgId: "o1" }}
    select={{ plugin: "fake-client", id: "board" }}
  />
);
const agentSection = (
  <ExtensionSlot
    slot="agent.detail.section"
    args={{ orgId: "o1", agentId: "a1" }}
    select={{ plugin: "fake-client", id: "notes" }}
  />
);
const platformPage = (
  <ExtensionSlot slot="platform.page" args={{}} select={{ plugin: "fake-client", id: "console" }} />
);

const loadingShown = () => document.querySelector('[data-part="skeleton-bar"]') !== null;

describe("component org pages", () => {
  it("show the loading state while the module loads, then the component", async () => {
    let resolve: (m: unknown) => void = () => {};
    ClientHost.load = vi.fn(
      () =>
        new Promise<unknown>((r) => {
          resolve = r;
        }),
    );
    renderHost(orgPage, { set: setOf("fake-client", [{ id: "board", slot: "org.page" }]) });
    await flush();
    expect(loadingShown()).toBe(true);
    const Board = () => <p>board body</p>;
    await act(async () => {
      resolve(moduleOf("fake-client", { board: { slot: "org.page", render: Board } }));
    });
    await flush();
    expect(screen.getByText("board body")).toBeTruthy();
    expect(loadingShown()).toBe(false);
  });

  it("a failed load shows the failure line; its retry reloads the page", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    ClientHost.load = vi.fn(async () => {
      throw new Error("network");
    });
    renderHost(orgPage, { set: setOf("fake-client", [{ id: "board", slot: "org.page" }]) });
    await flush();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("BOARD");
    expect(within(alert).getByText(C.componentFailed)).toBeTruthy();
    act(() => within(alert).getByRole("button").click());
    expect(reloadDocument).toHaveBeenCalledTimes(1);
  });

  it("in safe mode, under the kill switch and after the crash budget: not available", async () => {
    const set = setOf("fake-client", [{ id: "board", slot: "org.page" }]);
    renderHost(orgPage, { set, safe: true });
    await flush();
    expect(screen.getByText(C.componentOff)).toBeTruthy();
    expect(loadingShown()).toBe(false);
    cleanup();
    renderHost(orgPage, { set: setOf("fake-client", [], false) });
    await flush();
    expect(screen.getByText(C.componentOff)).toBeTruthy();
    cleanup();
    sessionStorage.setItem(DISABLED_KEY, JSON.stringify([`fake-client/${BUILD}`]));
    ClientHost.load = vi.fn(async () => ({}));
    renderHost(orgPage, { set });
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(screen.getByText(C.componentOff)).toBeTruthy();
  });
});

describe("component agent sections", () => {
  it("draw the section frame with the loading, failed and not-available states", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const set = setOf("fake-client", [{ id: "notes", slot: "agent.detail.section" }]);
    ClientHost.load = vi.fn(() => new Promise<unknown>(() => {}));
    renderHost(agentSection, { set });
    await flush();
    // the section keeps its title while loading
    expect(screen.getByText("NOTES")).toBeTruthy();
    expect(loadingShown()).toBe(true);
    cleanup();
    ClientHost.load = vi.fn(async () => {
      throw new Error("network");
    });
    renderHost(agentSection, { set });
    await flush();
    expect(screen.getByText("NOTES")).toBeTruthy();
    expect(within(screen.getByRole("alert")).getByText(C.componentFailed)).toBeTruthy();
    cleanup();
    renderHost(agentSection, { set, safe: true });
    await flush();
    expect(screen.getByText("NOTES")).toBeTruthy();
    expect(screen.getByText(C.componentOff)).toBeTruthy();
    // one box: the section card holds the state unboxed
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });
});

describe("component platform pages", () => {
  it("show the loading state, and not available in safe mode", async () => {
    const set = setOf("fake-client", [{ id: "console", slot: "platform.page" }]);
    ClientHost.load = vi.fn(() => new Promise<unknown>(() => {}));
    renderHost(platformPage, { set, scope: "admin" });
    await flush();
    expect(loadingShown()).toBe(true);
    cleanup();
    renderHost(platformPage, { set, scope: "admin", safe: true });
    await flush();
    expect(screen.getByText(C.componentOff)).toBeTruthy();
  });
});

/** The nav lists, as their hooks give them. */
function NavProbe() {
  const pages = useExtensions("o1", "en").map((p) => p.id);
  const sections = useSectionNav("o1", "a1", true)[0]?.items.map((i) => i.id) ?? [];
  const platform = useAdminExtensionPages().map((p) => p.id);
  return (
    <>
      <output data-testid="pages">{pages.join(",")}</output>
      <output data-testid="sections">
        {sections.filter((s) => s.startsWith("ext.")).join(",")}
      </output>
      <output data-testid="platform">{platform.join(",")}</output>
    </>
  );
}
const text = (id: string) => screen.getByTestId(id).textContent;

describe("nav entries of component pages and sections", () => {
  const set = setOf("fake-client", [
    { id: "board", slot: "org.page" },
    { id: "notes", slot: "agent.detail.section" },
  ]);

  it("are offered while the component may render", async () => {
    ClientHost.load = vi.fn(() => new Promise<unknown>(() => {}));
    renderHost(<NavProbe />, { set });
    await flush();
    expect(text("pages")).toBe("fake-client,view-plugin");
    expect(text("sections")).toBe("ext.fake-client.notes");
    expect(text("platform")).toBe("fake-client/console");
  });

  it("are not offered in safe mode (views stay)", async () => {
    renderHost(<NavProbe />, { set, safe: true });
    await flush();
    expect(text("pages")).toBe("view-plugin");
    expect(text("sections")).toBe("");
    expect(text("platform")).toBe("");
  });

  it("are not offered under the kill switch or after the crash budget", async () => {
    renderHost(<NavProbe />, {
      set: setOf("fake-client", [], false),
      seed: (c) =>
        c.setQueryData(deploymentSettingsQuery().queryKey, {
          clientExtensions: { enabled: false, disabled: [] },
        } as never),
    });
    await flush();
    expect(text("pages")).toBe("view-plugin");
    expect(text("sections")).toBe("");
    expect(text("platform")).toBe("");
    cleanup();
    sessionStorage.setItem(DISABLED_KEY, JSON.stringify([`fake-client/${BUILD}`]));
    renderHost(<NavProbe />, { set });
    await flush();
    expect(text("pages")).toBe("view-plugin");
    expect(text("sections")).toBe("");
  });

  it("a platform page of a plugin on the kill switch's list is not offered in the console", async () => {
    // the admin console loads no client set: the settings say which plugins are off
    renderHost(<NavProbe />, {
      set: null,
      scope: "admin",
      seed: (c) =>
        c.setQueryData(deploymentSettingsQuery().queryKey, {
          clientExtensions: { enabled: true, disabled: ["fake-client"] },
        } as never),
    });
    await flush();
    expect(text("platform")).toBe("");
    cleanup();
    renderHost(<NavProbe />, {
      set: null,
      scope: "admin",
      seed: (c) =>
        c.setQueryData(deploymentSettingsQuery().queryKey, {
          clientExtensions: { enabled: true, disabled: [] },
        } as never),
    });
    await flush();
    expect(text("platform")).toBe("fake-client/console");
  });
});
