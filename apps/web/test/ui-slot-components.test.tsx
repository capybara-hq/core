// Client extensions spec §5.3, §10.3, §11: `kind: "component"` contributions render in list slots
// through `ClientComponentBlock`: in the same places as views (anchors unchanged), inside the
// block's error boundary, with the host context the plugin-client hooks read.
import { act, cleanup, screen, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientHost } from "../src/components/client-ext/ClientHost";
import { PLUGIN_CLIENT, type ViewState } from "../src/components/client-ext/host-api";
import { ExtensionSlot } from "../src/components/extension-ui/ExtensionSlot";
import type { ClientExtensionItem, ClientExtensionsResponse } from "../src/lib/client-extensions";
import { contributionsQuery } from "../src/lib/query/conversation";
import { meQuery } from "../src/lib/query/shell";
import type { UiContributionItem, UiSlotId } from "../src/lib/ui";
import { bodyOf, type Call, json, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const BUILD = "b".repeat(64);
const ORG = "/api/v1/orgs/o1";
const REPORTS = `POST ${ORG}/ui/client/reports`;

const component = (id: string, slot: UiSlotId, after?: string): UiContributionItem => ({
  plugin: "fake-client",
  id,
  title: { zh: id, en: id.toUpperCase() },
  slot,
  ...(after !== undefined ? { after } : {}),
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

/** An entry module whose components render the given React components. */
const moduleOf = (renders: Record<string, { slot: string; render: ComponentType<never> }>) => ({
  default: { name: "fake-client", apiVersion: 1, components: renders },
});

let calls: Call[] = [];
const reports = () => calls.filter((c) => `${c.method} ${c.url}` === REPORTS).map(bodyOf);

const flush = () =>
  act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });

function renderWithHost(
  items: UiContributionItem[],
  set: ClientExtensionsResponse,
  ui: ReactNode,
  safe = false,
) {
  const client = testQueryClient();
  client.setQueryData(contributionsQuery("o1").queryKey, items);
  client.setQueryData(meQuery().queryKey, ME);
  return renderPage(
    <ClientHost set={set} safe={safe} scope="org" orgId="o1">
      {ui}
    </ClientHost>,
    { client },
  );
}

const realLoad = ClientHost.load;
beforeEach(() => {
  resetNavigation("/chat/c1");
  window.history.replaceState(null, "", "/chat/c1");
  sessionStorage.clear();
  calls = stubApi({ [REPORTS]: () => noContent() });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  ClientHost.load = realLoad;
});

const sectionSlot = (anchor: string) => (
  <div data-testid={`after-${anchor}`}>
    <ExtensionSlot
      slot="conversation.properties.section"
      args={{ orgId: "o1", conversationId: "c1" }}
      anchor={anchor}
      host={{ onOpenTarget: () => {} }}
    />
  </div>
);

describe("ClientComponentBlock", () => {
  it("a component renders in the properties section after its anchor", async () => {
    const Hud = () => <p>hud body</p>;
    ClientHost.load = vi.fn(async () =>
      moduleOf({ hud: { slot: "conversation.properties.section", render: Hud } }),
    );
    renderWithHost(
      [component("hud", "conversation.properties.section", "files")],
      setOf([{ id: "hud", slot: "conversation.properties.section" }]),
      <>
        {sectionSlot("context")}
        {sectionSlot("files")}
      </>,
    );
    await flush();
    const files = screen.getByTestId("after-files");
    expect(within(files).getByText("hud body")).toBeTruthy();
    // in the section frame the views get, titled by the contribution
    expect(within(files).getByText("HUD")).toBeTruthy();
    expect(files.querySelector('[data-extension-section="fake-client/hud"]')).not.toBeNull();
    expect(screen.getByTestId("after-context").textContent).toBe("");
  });

  it("a component draws nothing while its module loads, then appears", async () => {
    let resolve: (m: unknown) => void = () => {};
    ClientHost.load = vi.fn(() => new Promise<unknown>((r) => (resolve = r)));
    const Hud = () => <p>hud body</p>;
    renderWithHost(
      [component("hud", "conversation.properties.section", "context")],
      setOf([{ id: "hud", slot: "conversation.properties.section" }]),
      sectionSlot("context"),
    );
    await flush();
    expect(screen.getByTestId("after-context").textContent).toBe("");
    resolve(moduleOf({ hud: { slot: "conversation.properties.section", render: Hud } }));
    await flush();
    expect(screen.getByText("hud body")).toBeTruthy();
  });

  it("a throwing component shows the block's failure line and the rest renders", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = (): ReactNode => {
      throw new Error("boom");
    };
    const Fine = () => <p>fine body</p>;
    ClientHost.load = vi.fn(async () =>
      moduleOf({
        boom: { slot: "conversation.properties.section", render: Boom },
        fine: { slot: "conversation.properties.section", render: Fine },
      }),
    );
    renderWithHost(
      [
        component("boom", "conversation.properties.section", "context"),
        component("fine", "conversation.properties.section", "context"),
      ],
      setOf([
        { id: "boom", slot: "conversation.properties.section" },
        { id: "fine", slot: "conversation.properties.section" },
      ]),
      sectionSlot("context"),
    );
    await flush();
    const boom = document.querySelector(
      '[data-extension-section="fake-client/boom"]',
    ) as HTMLElement;
    expect(within(boom).getByRole("button", { name: /retry/i })).toBeTruthy();
    expect(screen.getByText("fine body")).toBeTruthy();
    expect(reports()).toEqual([
      {
        plugin: "fake-client",
        build: BUILD,
        contribution: "boom",
        kind: "render",
        message: "boom",
      },
    ]);
    spy.mockRestore();
  });

  it("useView inside a component gets the slot's args", async () => {
    const seen: string[] = [];
    calls = stubApi({
      [REPORTS]: () => noContent(),
      [`GET ${ORG}/ui/views/fake-client/hud`]: (c) => {
        seen.push(c.url);
        return json(200, { view: { blocks: [], data: { n: 7 } } });
      },
    });
    const Hud = () => {
      const v = (PLUGIN_CLIENT.useView as () => ViewState)();
      const data = v.view?.data as { n?: number } | undefined;
      return <p>{v.status === "ready" ? `n=${data?.n}` : v.status}</p>;
    };
    ClientHost.load = vi.fn(async () =>
      moduleOf({ hud: { slot: "conversation.properties.section", render: Hud } }),
    );
    renderWithHost(
      [component("hud", "conversation.properties.section", "context")],
      setOf([{ id: "hud", slot: "conversation.properties.section" }]),
      sectionSlot("context"),
    );
    expect(await screen.findByText("n=7")).toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0] ?? "", "http://x").searchParams.get("conversationId")).toBe("c1");
  });

  it("a component in conversation.panel gets close", async () => {
    const onClose = vi.fn();
    const Panel = ({ close, conversationId }: { close(): void; conversationId: string }) => (
      <button type="button" onClick={close}>
        close {conversationId}
      </button>
    );
    ClientHost.load = vi.fn(async () =>
      moduleOf({
        board: { slot: "conversation.panel", render: Panel as ComponentType<never> },
      }),
    );
    renderWithHost(
      [component("board", "conversation.panel")],
      setOf([{ id: "board", slot: "conversation.panel" }]),
      <ExtensionSlot
        slot="conversation.panel"
        args={{ orgId: "o1", conversationId: "c1" }}
        select={{ plugin: "fake-client", id: "board" }}
        host={{ onClose, onFullscreen: () => {}, onOpenTarget: () => {} }}
      />,
    );
    await flush();
    act(() => screen.getByRole("button", { name: "close c1" }).click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("safe mode skips components in list slots", async () => {
    ClientHost.load = vi.fn(async () =>
      moduleOf({ hud: { slot: "conversation.properties.section", render: () => <p>hud</p> } }),
    );
    renderWithHost(
      [component("hud", "conversation.properties.section", "context")],
      setOf([{ id: "hud", slot: "conversation.properties.section" }]),
      sectionSlot("context"),
      true,
    );
    await flush();
    expect(ClientHost.load).not.toHaveBeenCalled();
    expect(screen.getByTestId("after-context").textContent).toBe("");
  });
});
