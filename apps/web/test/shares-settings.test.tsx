import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import type { Me } from "../src/lib/session";
import { json, lastStubRoutes, noContent, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const MEMBER: Me = {
  ...ME,
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
const share = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  code: `code-${id}`,
  audience: "external",
  conversationId: "c1",
  fileId: "f1",
  sourcePath: "/w/report.html",
  name: `report-${id}.html`,
  contentType: "text/html",
  size: 10,
  generation: 1,
  createdBy: { id: "a1", displayName: "Grant" },
  createdAt: "2026-11-01T00:00:00Z",
  expiresAt: "2026-12-01T00:00:00Z",
  lastOpenedAt: null,
  state: "live",
  revokedAt: null,
  revokeReason: null,
  newerVersion: false,
  ...over,
});

beforeEach(() => resetNavigation("/settings/shares"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Shares pages", () => {
  it("an admin sees every share and Revoke calls DELETE; the row comes back revoked", async () => {
    let revoked = false;
    const calls = stubApi({
      "GET /api/v1/orgs/o1/shares?scope=all": () =>
        json(200, {
          shares: [
            share("s1", revoked ? { state: "revoked", revokedAt: "2026-11-02T00:00:00Z" } : {}),
            share("s2", { createdBy: { id: "a2", displayName: "Ada" }, audience: "internal" }),
          ],
        }),
      "DELETE /api/v1/orgs/o1/shares/s1": () => {
        revoked = true;
        return noContent();
      },
    });
    await renderRouteWithCache("/settings/shares", lastStubRoutes());
    const row = (await screen.findByText("report-s1.html")).closest("tr") as HTMLElement;
    expect(screen.getByText("Ada")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(row).getByRole("button", { name: /Revoke report-s1/ }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: en.shares.list.revokeConfirm }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => {
      const r = screen.getByText("report-s1.html").closest("tr") as HTMLElement;
      expect(within(r).getByText(en.shares.dialog.revoked)).toBeTruthy();
      expect(within(r).queryByRole("button", { name: /Revoke/ })).toBeNull();
    });
  });

  it("a member sees only their own shares under Personal, and the nav has myShares only", async () => {
    resetNavigation("/account/shares");
    stubApi({
      "GET /api/v1/orgs/o1/shares?scope=mine": () => json(200, { shares: [share("m1")] }),
    });
    const { container } = await renderRouteWithCache("/account/shares", lastStubRoutes(), {
      me: MEMBER,
    });
    expect(await screen.findByText("report-m1.html")).toBeTruthy();
    expect(screen.queryByText(en.shares.list.owner)).toBeNull();
    const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
    expect(current?.textContent).toBe(en.connections.nav.myShares);
  });

  it("a member does not get the org Shares nav item or the page", async () => {
    stubApi({
      "GET /api/v1/orgs/o1/settings": () => json(200, { settings: { toolSearch: "on" } }),
      "GET /api/v1/orgs/o1/ui/contributions": () => json(200, { items: [] }),
      "GET /api/v1/orgs/o1/network-allowances": () => json(200, { allowances: [] }),
    });
    const { container } = await renderRouteWithCache("/settings/organization", lastStubRoutes(), {
      me: MEMBER,
    });
    await screen.findByRole("heading", { name: en.orgSettings.title });
    const links = [...container.querySelectorAll(".cb-settings-nav a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(links).not.toContain("/settings/shares");
  });

  it("an admin has the Shares nav item in both languages", async () => {
    for (const locale of ["en", "zh"] as const) {
      stubApi({ "GET /api/v1/orgs/o1/shares?scope=all": () => json(200, { shares: [] }) });
      const { container, unmount } = await renderRouteWithCache(
        "/settings/shares",
        lastStubRoutes(),
        {
          locale,
        },
      );
      const label = (locale === "zh" ? zh : en).connections.nav.shares;
      const current = container.querySelector('.cb-settings-nav [aria-current="page"]');
      await waitFor(() => expect(current?.textContent).toBe(label));
      unmount();
      cleanup();
    }
  });
});
