// Shell external authorization (spec 2026-11-28 §4): in a shell with openExternal@1, Connect and
// Link ask the kernel for a browser handoff, open it in the system browser and wait in a dialog
// that refreshes on focus and closes on its own once the connector is connected (or the login
// method linked). Without the capability the page navigates as before.
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import IdentitiesView from "../src/app/(app)/account/identities/view";
import { ConnectCard } from "../src/components/ConnectCard";
import { ApiClientError } from "../src/lib/api";
import { navigateBrowser } from "../src/lib/browser";
import { keys } from "../src/lib/query/keys";
import { useErrorMessage } from "../src/lib/use-error-message";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { ME, pageElement, renderPage, testQueryClient } from "./support/render";

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
  Reflect.deleteProperty(document, "visibilityState");
});

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
};

/** Renders the card, clicks Connect and waits for the dialog and its first refresh. */
async function openConnectDialog(status: () => "connected" | "missing" = () => "missing") {
  inShell();
  const calls = stubApi({
    [CONNECTOR]: () => json(200, { connector: oauthApp(status()) }),
    [CONNECT]: () => json(200, { handoffUrl: HANDOFF_URL }),
  });
  const user = userEvent.setup();
  renderPage(<ConnectCard orgId="o1" item={item} />);
  await user.click(screen.getByRole("button", { name: en.connect.action }));
  const d = await dialog();
  await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThanOrEqual(2));
  return { calls, user, d };
}

/** Lets pending fetches settle (no fixed sleep: a few macrotask turns). */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
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

  it("becoming visible refreshes; becoming hidden does not", async () => {
    const { calls } = await openConnectDialog();
    await settle();
    const before = connectorGets(calls);
    setVisibility("hidden");
    await settle();
    expect(connectorGets(calls)).toBe(before);
    setVisibility("visible");
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThan(before));
  });

  it("done refreshes and closes; focus afterwards fetches nothing more", async () => {
    const { calls, user, d } = await openConnectDialog();
    await settle();
    const before = connectorGets(calls);
    await user.click(within(d).getByRole("button", { name: en.externalAuth.done }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.externalAuth.title })).toBeNull(),
    );
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThan(before));
    await settle();
    const after = connectorGets(calls);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(connectorGets(calls)).toBe(after);
  });

  it("cancel closes; focus afterwards fetches nothing more", async () => {
    const { calls, user, d } = await openConnectDialog();
    await user.click(within(d).getByRole("button", { name: en.externalAuth.cancel }));
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog", { name: en.externalAuth.title })).toBeNull(),
    );
    await settle();
    const after = connectorGets(calls);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(connectorGets(calls)).toBe(after);
  });

  it("a failed copy says so", async () => {
    const { user, d } = await openConnectDialog();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(within(d).getByRole("button", { name: en.externalAuth.copy }));
    expect(await screen.findByText(en.externalAuth.copyFailed)).toBeTruthy();
  });

  it("a connector connected at open (a reconnect) stays open until Done", async () => {
    const { calls } = await openConnectDialog(() => "connected");
    const before = connectorGets(calls);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() => expect(connectorGets(calls)).toBeGreaterThan(before));
    await settle();
    expect(screen.getByRole("dialog", { name: en.externalAuth.title })).toBeTruthy();
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

  it("a second tenant of a plugin already linked closes the dialog", async () => {
    inShell();
    const row = (tenant: string) => ({
      source: `slack:${tenant}`,
      externalId: "U1",
      email: null,
      emailVerified: false,
      displayName: "Grant",
      avatarUrl: null,
      createdAt: T,
      label: SLACK.label,
      channel: true,
      login: "on",
    });
    let rows = [row("T1")];
    const calls = stubApi({
      "GET /api/v1/me/identities": () => json(200, { identities: rows, linkable: [SLACK] }),
      [START]: () => json(200, { handoffUrl: HANDOFF_URL }),
    });
    renderIdentities();
    await userEvent.setup().click(await linkButton());
    await dialog();
    await settle();
    // the snapshot already holds T1: a changed list without a new sign-in keeps the dialog open
    rows = [{ ...row("T1"), displayName: "Grant W" }];
    const gets = calls.filter((c) => c.url.endsWith("/me/identities")).length;
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() =>
      expect(calls.filter((c) => c.url.endsWith("/me/identities")).length).toBeGreaterThan(gets),
    );
    expect(await screen.findByText("Grant W")).toBeTruthy();
    await settle();
    expect(screen.getByRole("dialog", { name: en.externalAuth.title })).toBeTruthy();
    rows = [row("T1"), row("T2")];
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
});

function ErrorProbe({ error }: { error: unknown }) {
  return <p>{useErrorMessage()(error)}</p>;
}

describe("handoff error copy", () => {
  const MSGS = { en, zh } as const;
  it.each(["en", "zh"] as const)("the three handoff errors read their own copy (%s)", (locale) => {
    const h = MSGS[locale].errors.handoff;
    const cases: [ApiClientError, string][] = [
      [new ApiClientError(400, "handoff.scheme_not_allowed", "x"), h.scheme_not_allowed],
      [new ApiClientError(410, "handoff.invalid", "x"), h.invalid],
      [
        new ApiClientError(
          403,
          "handoff.account_mismatch",
          "x",
          [],
          [{ displayName: "Alice Wong", email: "alice@corp.example" }],
        ),
        h.account_mismatch.replace("{login}", "alice@corp.example"),
      ],
    ];
    for (const [error, text] of cases) {
      render(pageElement(<ErrorProbe error={error} />, { locale }));
      expect(screen.getByText(text)).toBeTruthy();
      cleanup();
    }
  });
});
