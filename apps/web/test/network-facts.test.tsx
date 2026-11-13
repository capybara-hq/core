import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import { NetworkFacts } from "../src/components/conversation/NetworkFacts";
import { bodyOf, json, stubApi } from "./support/api";
import { ME, renderPage } from "./support/render";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));

const ORG = "/api/v1/orgs/o1";
const N = en.networkAsk;
const MEMBER = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};
// The deployment's default cloud network is the allowlist only under the platform's kill switch
// (`sandbox.limits.egress: none`); otherwise the org's own list is what blocks the command.
const settings = (platformOff: boolean) => ({
  settings: { toolSearch: "on" },
  deployment: {
    autoMode: { mode: "allowed", source: "default" },
    cloudNetwork: platformOff
      ? { mode: "allowlist", allowHosts: [] }
      : { mode: "open", allowHosts: [] },
  },
});
const facts = [
  { host: "files.slack.com", layer: "org" as const },
  { host: "10.0.0.2", layer: "address" as const },
];
const renderFacts = (me = MEMBER) =>
  renderPage(<NetworkFacts orgId="o1" conversationId="c1" hosts={facts} />, { me });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("org-layer network facts (network ask spec §5.3)", () => {
  it("a member asks the admins with a note: the request carries the conversation and agent", async () => {
    const calls = stubApi({
      [`GET ${ORG}/settings`]: () => json(200, settings(false)),
      [`GET ${ORG}/conversations/c1`]: () =>
        json(200, { conversation: { id: "c1", agentId: "ag1" } }),
      [`POST ${ORG}/catalog-requests/network`]: () =>
        json(201, { request: { id: "r1", kind: "network_allowlist" } }),
    });
    renderFacts();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: N.ask }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("files.slack.com");
    await user.type(
      within(dialog).getByRole("textbox", { name: new RegExp(`^${N.note}`) }),
      "for the export",
    );
    await vi.waitFor(() =>
      expect(calls.some((c) => c.url.endsWith("/conversations/c1"))).toBe(true),
    );
    await user.click(within(dialog).getByRole("button", { name: N.send }));
    await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(bodyOf(calls.find((c) => c.method === "POST"))).toEqual({
      hosts: ["files.slack.com"],
      conversationId: "c1",
      agentId: "ag1",
      note: "for the export",
    });
    expect(await screen.findByText(N.sent)).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a refused request shows the kernel's reason and keeps the dialog open", async () => {
    stubApi({
      [`GET ${ORG}/settings`]: () => json(200, settings(false)),
      [`GET ${ORG}/conversations/c1`]: () =>
        json(200, { conversation: { id: "c1", agentId: "ag1" } }),
      [`POST ${ORG}/catalog-requests/network`]: () =>
        json(409, {
          error: {
            code: "catalog.request_invalid",
            message: "This organization's sandbox network already allows these hosts",
          },
        }),
    });
    renderFacts();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: N.ask }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: N.send }));
    expect(await within(dialog).findByText(N.refused)).toBeTruthy();
    expect(within(dialog).getByText(/already allows these hosts/)).toBeTruthy();
  });

  it("an org admin gets a link to the org settings with the host prefilled", async () => {
    stubApi({ [`GET ${ORG}/settings`]: () => json(200, settings(false)) });
    renderFacts(ME);
    const link = await screen.findByRole("link", { name: N.openSettings });
    expect(link.getAttribute("href")).toBe("/settings/sandbox?allowHost=files.slack.com");
    expect(screen.queryByRole("button", { name: N.ask })).toBeNull();
  });

  it("with the platform's sandbox network off, only a super admin can turn it on: no request", async () => {
    stubApi({ [`GET ${ORG}/settings`]: () => json(200, settings(true)) });
    renderFacts();
    expect(await screen.findByText(N.platformOff)).toBeTruthy();
    expect(screen.queryByRole("button", { name: N.ask })).toBeNull();
  });
});
