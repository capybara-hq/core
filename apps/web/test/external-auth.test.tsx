// Shell external authorization (spec 2026-11-28 §4): in a shell with openExternal@1, 「连接」 and
// 「绑定」 ask the kernel for a browser handoff, open it in the system browser and wait in a
// dialog that refreshes on focus and closes on its own once the connector is connected (or the
// login method linked). Without the capability the page navigates as before.
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import IdentitiesView from "../src/app/(app)/account/identities/view";
import { ConnectCard } from "../src/components/ConnectCard";
import { navigateBrowser } from "../src/lib/browser";
import { keys } from "../src/lib/query/keys";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, renderPage, testQueryClient } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

const T = "2026-11-28T12:00:00.000Z";
const HANDOFF_URL = "https://capybara.example.com/handoff/cap_ho_abc";
const AUTH_URL = "https://auth.example.com/authorize?state=s1";
const CONNECTOR = "GET /api/v1/orgs/o1/connectors/app1";
const CONNECT = "POST /api/v1/orgs/o1/connectors/app1/connect";

const oauthApp = (status: "connected" | "missing") => ({
  id: "app1",
  slug: "docs",
  name: "Docs",
  connector: "mcp",
  endpoint: {},
  auth: { type: "oauth_code", ownership: "personal" },
  status: "active",
  createdAt: T,
  updatedAt: T,
  tools: [],
  credential: { ownership: "personal", status },
});

const item = {
  kind: "connect" as const,
  key: "e1",
  callId: "c",
  connectorId: "app1",
  connectorName: "Docs",
  closed: false,
};

const install = (capabilities: Record<string, object>) => {
  (window as unknown as { capybaraShell?: unknown }).capybaraShell = {
    version: 1,
    kind: "desktop",
    platform: "macos",
    capabilities,
    on: () => () => {},
  };
};

let open: ReturnType<typeof vi.fn>;
const inShell = () => {
  open = vi.fn(async (_url: string) => {});
  install({ "openExternal@1": { open, returnScheme: "capybara" } });
};

const dialog = () => screen.findByRole("dialog", { name: en.externalAuth.title });
const connectorGets = (calls: Call[]) =>
  calls.filter((c) => c.method === "GET" && c.url.endsWith("/connectors/app1")).length;

beforeEach(() => {
  resetNavigation();
  vi.mocked(navigateBrowser).mockClear();
  window.history.replaceState(null, "", "/en/chat/c1");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "capybaraShell");
});

describe("connector authorization in a shell", () => {
  it("connect in a shell asks for a handoff and opens the browser", async () => {
    inShell();
    const calls = stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp("missing") }),
      [CONNECT]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    expect(await dialog()).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      returnTo: "/en/chat/c1",
      handoff: { returnScheme: "capybara" },
    });
    expect(open).toHaveBeenCalledWith(HANDOFF_URL);
    expect(navigateBrowser).not.toHaveBeenCalled();
  });

  it("copy link copies the handoff URL", async () => {
    inShell();
    stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp("missing") }),
      [CONNECT]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await user.click(screen.getByRole("button", { name: en.connect.action }));
    const d = await dialog();
    await user.click(within(d).getByRole("button", { name: en.externalAuth.copy }));
    expect(writeText).toHaveBeenCalledWith(HANDOFF_URL);
    expect(await screen.findByText(en.externalAuth.copied)).toBeTruthy();
  });

  it("focus invalidates the connector queries", async () => {
    inShell();
    const calls = stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp("missing") }),
      [CONNECT]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    await dialog();
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThanOrEqual(2));
    const before = connectorGets(calls);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThan(before));
  });

  it("closes with success when the connector turns connected", async () => {
    inShell();
    let status: "connected" | "missing" = "missing";
    const calls = stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp(status) }),
      [CONNECT]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    await dialog();
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThanOrEqual(2));
    status = "connected";
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText(en.connect.result.connected)).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.externalAuth.title })).toBeNull(),
    );
  });

  it("without the capability the page navigates as today", async () => {
    const calls = stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp("missing") }),
      [CONNECT]: () => json(200, { authorizationUrl: AUTH_URL }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTH_URL));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ returnTo: "/en/chat/c1" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a non-http handoff URL shows the unknown error and opens nothing", async () => {
    inShell();
    stubApi({
      [CONNECTOR]: () => json(200, { connector: oauthApp("missing") }),
      [CONNECT]: () => json(200, { handoffUrl: "javascript:alert(1)" }),
    });
    renderPage(<ConnectCard orgId="o1" item={item} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.connect.action }));
    expect(await screen.findByText(en.connect.result.unknown)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(navigateBrowser).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("login method linking in a shell", () => {
  const SLACK = { plugin: "slack", label: { zh: "Slack", en: "Slack" } };
  const START = "POST /api/v1/auth/sso/slack/start";
  const linkButton = () =>
    screen.findByRole("button", { name: en.identities.link.replace("{platform}", "Slack") });

  function renderIdentities() {
    const client = testQueryClient();
    client.setQueryData(keys.account("self").me(), ME);
    window.history.replaceState(null, "", "/en/account/identities");
    resetNavigation("/account/identities");
    renderPage(<IdentitiesView error={null} />, { client });
  }

  it("link in a shell opens the browser", async () => {
    inShell();
    let linked = false;
    const calls = stubApi({
      "GET /api/v1/me/identities": () =>
        json(
          200,
          linked
            ? {
                identities: [
                  {
                    source: "slack:T1",
                    externalId: "U1",
                    email: null,
                    emailVerified: false,
                    displayName: "Grant",
                    avatarUrl: null,
                    createdAt: T,
                    label: SLACK.label,
                    channel: true,
                    login: "on",
                  },
                ],
                linkable: [],
              }
            : { identities: [], linkable: [SLACK] },
        ),
      [START]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    renderIdentities();
    await userEvent.setup().click(await linkButton());
    expect(await dialog()).toBeTruthy();
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      intent: "link",
      returnTo: "/account/identities",
      handoff: { returnScheme: "capybara" },
    });
    expect(open).toHaveBeenCalledWith(HANDOFF_URL);
    linked = true;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      await screen.findByText(en.identities.linked.replace("{platform}", "Slack")),
    ).toBeTruthy();
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.externalAuth.title })).toBeNull(),
    );
  });

  it("a location answer navigates in place", async () => {
    inShell();
    stubApi({
      "GET /api/v1/me/identities": () => json(200, { identities: [], linkable: [SLACK] }),
      [START]: () => json(200, { location: "/account/identities?error=sso.unavailable" }),
    });
    renderIdentities();
    await userEvent.setup().click(await linkButton());
    await vi.waitFor(() =>
      expect(navigateBrowser).toHaveBeenCalledWith("/account/identities?error=sso.unavailable"),
    );
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
