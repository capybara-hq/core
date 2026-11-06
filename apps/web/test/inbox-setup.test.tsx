import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
import { renderRouteWithCache } from "./support/query";
import { ME } from "./support/render";
import { pickOption } from "./support/select";

vi.mock("../src/i18n/navigation", () => import("./support/navigation"));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

/**
 * Phase 4 Task 8 in the inbox (ruling P4-7): an org admin configures a member's `connector_setup`
 * request from the inbox (the agent is usually private to them) or rejects it with a reason; the
 * owner reads the decision.
 */

const ORG = "/api/v1/orgs/o1";
const T = "2026-11-07T08:00:00.000Z";
const S = en.inbox.setup;
const P = en.agents.pending;
const CT = "11111111-1111-4111-8111-111111111111";

const MEMBER: Me = {
  ...ME,
  account: { ...ME.account, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role: "member" }],
};

const request = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  orgId: "o1",
  orgName: "Acme",
  kind: "connector_setup",
  item: null,
  entry: null,
  status: "pending",
  note: "",
  reason: null,
  requestedBy: "m1",
  requestedByName: "Mia",
  decidedBy: null,
  decidedAt: null,
  stagingId: null,
  agent: { id: "ag7", name: "Sales helper", deleted: false },
  connectors: [
    {
      key: "connector-1",
      label: "GitHub",
      kind: "template",
      source: { template: { id: CT, displayName: { zh: "GitHub", en: "GitHub" } } },
      tools: null,
      policies: [],
    },
    {
      key: "connector-2",
      label: "Docs",
      kind: "needs",
      source: { needs: { protocol: "mcp", endpoint: "https://docs.example/mcp", tools: [] } },
      tools: ["search"],
      policies: [],
    },
  ],
  createdAt: T,
  ...over,
});

const connector = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  slug: id,
  name: id,
  connector: "mcp",
  endpoint: { url: "https://x" },
  auth: { type: "none" },
  status: "active",
  platformTemplateId: null,
  createdAt: T,
  updatedAt: T,
  ...over,
});

type Handler = (c: Call) => Response | Promise<Response>;
const ok = (body: unknown) => () => json(200, body);
const binds = (calls: Call[]) =>
  calls
    .filter((c) => c.method === "POST" && c.url.includes("/pending-connectors/"))
    .map((c) => ({ url: c.url, body: bodyOf(c) }));

beforeEach(() => resetNavigation("/inbox"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("connector setup requests in the inbox (P4-7)", () => {
  it("admins: the agent and its connectors; 配置 binds each, the request closes on the last bind", async () => {
    let bound = 0;
    const routes: Record<string, Handler> = {
      [`GET ${ORG}/inbox`]: () =>
        json(200, {
          items:
            bound < 2
              ? [{ type: "catalog_request", id: "r1", createdAt: T, request: request() }]
              : [],
          truncated: false,
        }),
      [`GET ${ORG}/connectors`]: ok({
        connectors: [
          connector("gh_main", { name: "GitHub main", platformTemplateId: CT }),
          connector("docs_mcp", { name: "Docs MCP" }),
        ],
      }),
      [`POST ${ORG}/agents/ag7/pending-connectors/connector-1/bind`]: () => {
        bound += 1;
        return json(200, { agent: {}, dropped: [] });
      },
      [`POST ${ORG}/agents/ag7/pending-connectors/connector-2/bind`]: () => {
        bound += 1;
        return json(200, { agent: {}, dropped: [] });
      },
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes);
    // the row names the agent and the kind
    expect((await screen.findAllByText("Sales helper")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(S.label).length).toBeGreaterThan(0);
    expect(screen.getByText("Configure connectors for Sales helper")).toBeTruthy();
    expect(screen.getByText("Needs an MCP connector: https://docs.example/mcp")).toBeTruthy();
    expect(screen.getByText("Made from the connector template GitHub")).toBeTruthy();
    // one box: the detail card holds the list and the reason without a second box
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: S.configure }));
    let dialog = await screen.findByRole("dialog", {
      name: "Configure connectors for Sales helper",
    });
    const rows = within(within(dialog).getByRole("list", { name: P.listLabel })).getAllByRole(
      "listitem",
    );
    expect(rows).toHaveLength(2);
    await user.click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    dialog = await screen.findByRole("dialog", { name: "Configure GitHub" });
    await user.click(within(dialog).getByRole("button", { name: P.bind }));
    // back to the list with one left
    dialog = await screen.findByRole("dialog", { name: "Configure connectors for Sales helper" });
    const left = within(within(dialog).getByRole("list", { name: P.listLabel })).getAllByRole(
      "listitem",
    );
    expect(left).toHaveLength(1);
    await user.click(within(left[0] as HTMLElement).getByRole("button", { name: P.configure }));
    dialog = await screen.findByRole("dialog", { name: "Configure Docs" });
    // a needs entry offers every connector of its protocol
    await pickOption(within(dialog).getByRole("combobox", { name: P.connectorLabel }), "docs_mcp");
    await user.click(within(dialog).getByRole("button", { name: P.bind }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(binds(calls)).toEqual([
      {
        url: `${ORG}/agents/ag7/pending-connectors/connector-1/bind`,
        body: { connectorId: "gh_main" },
      },
      {
        url: `${ORG}/agents/ag7/pending-connectors/connector-2/bind`,
        body: { connectorId: "docs_mcp" },
      },
    ]);
    // the item leaves the inbox
    await vi.waitFor(() =>
      expect(screen.queryByText("Configure connectors for Sales helper")).toBeNull(),
    );
  });

  it("admins: 驳回 sends the typed reason", async () => {
    const routes: Record<string, Handler> = {
      [`GET ${ORG}/inbox`]: ok({
        items: [{ type: "catalog_request", id: "r1", createdAt: T, request: request() }],
        truncated: false,
      }),
      [`POST ${ORG}/catalog-requests/r1/decide`]: ok({ request: request({ status: "rejected" }) }),
    };
    const calls = stubApi(routes);
    await renderRouteWithCache("/inbox", routes);
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox", { name: new RegExp(S.reasonLabel) }),
      "Use the shared one",
    );
    await user.click(screen.getByRole("button", { name: S.reject }));
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/catalog-requests/r1/decide")).map(bodyOf),
      ).toEqual([{ approve: false, reason: "Use the shared one" }]),
    );
  });

  it("the owner: a decided request reads as its outcome, with the reason and the agent's Tools", async () => {
    const routes: Record<string, Handler> = {
      [`GET ${ORG}/inbox`]: ok({
        items: [
          {
            type: "catalog_request_decided",
            id: "r1",
            createdAt: T,
            request: request({
              status: "rejected",
              reason: "Use the shared one",
              decidedAt: T,
              connectors: [],
            }),
          },
        ],
        truncated: false,
      }),
    };
    stubApi(routes);
    await renderRouteWithCache("/inbox", routes, { me: MEMBER });
    expect(await screen.findByText("Connector setup for Sales helper was rejected")).toBeTruthy();
    expect(screen.getByText(S.hintRejected)).toBeTruthy();
    expect(screen.getByText("Use the shared one")).toBeTruthy();
    expect(screen.getByRole("link", { name: S.openAgent }).getAttribute("href")).toBe(
      "/agents/ag7?s=tools",
    );
    cleanup();
    const approved: Record<string, Handler> = {
      [`GET ${ORG}/inbox`]: ok({
        items: [
          {
            type: "catalog_request_decided",
            id: "r1",
            createdAt: T,
            request: request({ status: "approved", decidedAt: T, connectors: [] }),
          },
        ],
        truncated: false,
      }),
    };
    stubApi(approved);
    await renderRouteWithCache("/inbox", approved, { me: MEMBER });
    expect(await screen.findByText("Sales helper's connectors are configured")).toBeTruthy();
    expect(screen.getByText(S.hintApproved)).toBeTruthy();
  });
});
