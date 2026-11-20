import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import { HandoffCard } from "../src/components/HandoffCard";
import { navigateBrowser } from "../src/lib/browser";
import { bodyOf, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("../src/lib/browser", () => ({ navigateBrowser: vi.fn() }));

/**
 * The handoff link card (platform web parity spec §4.4, §6): the title and one button. `link`
 * opens the page; `connect` posts the connector's connect route from this session and goes to
 * the authorization URL. The timeline entry it renders from is covered in `timeline.test.ts`.
 */

const msgs = { zh, en } as const;
const AUTH_URL = "https://auth.example.com/authorize?state=s1";
const STAGING = "/admin/plugins/import?staging=s-1";

beforeEach(() => {
  resetNavigation();
  vi.mocked(navigateBrowser).mockClear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HandoffCard", () => {
  it.each(["zh", "en"] as const)(
    "a link card: the title and a button opening the page (%s)",
    (locale) => {
      renderPage(
        <HandoffCard
          orgId="o1"
          title="Review plugin probe"
          target={{ type: "link", url: STAGING }}
        />,
        { locale },
      );
      expect(screen.getByText("Review plugin probe")).toBeTruthy();
      const link = screen.getByRole("link", { name: msgs[locale].chat.handoff.open });
      expect(link.getAttribute("href")).toContain(STAGING);
    },
  );

  it("a connect card posts the connect route and goes to the authorization URL", async () => {
    window.history.replaceState(null, "", "/en/chat/c1");
    const calls = stubApi({
      "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
        json(200, { authorizationUrl: AUTH_URL }),
    });
    renderPage(
      <HandoffCard
        orgId="o1"
        title="Connect Docs"
        target={{ type: "connect", connectorId: "app1" }}
      />,
    );
    expect(screen.getByText("Connect Docs")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: en.chat.handoff.connect }));
    await vi.waitFor(() => expect(navigateBrowser).toHaveBeenCalledWith(AUTH_URL));
    // the flow comes back to this conversation
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({ returnTo: "/en/chat/c1" });
  });

  it("a failed connect stays on the page with an error", async () => {
    stubApi({
      "POST /api/v1/orgs/o1/connectors/app1/connect": () =>
        json(404, { error: { code: "connector.not_found", message: "x" } }),
    });
    renderPage(
      <HandoffCard
        orgId="o1"
        title="Connect Docs"
        target={{ type: "connect", connectorId: "app1" }}
      />,
    );
    await userEvent.setup().click(screen.getByRole("button", { name: en.chat.handoff.connect }));
    await vi.waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    expect(navigateBrowser).not.toHaveBeenCalled();
  });
});
