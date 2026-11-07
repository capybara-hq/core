import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { act, cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../messages/en.json";
import type { Me } from "../src/lib/session";
import { renderEditAgent } from "./support/agents";
import { bodyOf, type Call, json, stubApi } from "./support/api";
import { resetNavigation } from "./support/navigation";
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
 * Phase 4 Task 8 on the agent page: the provenance line in Basics (ruling P4-8), the 待配置 notice
 * in Tools per role (P4-7), the `not_synced` bind refusal, one more connector from the template,
 * and saves that keep the pending connectors.
 */

const ORG = "/api/v1/orgs/o1";
const T = "2026-11-07T08:00:00.000Z";
const P = en.agents.pending;
const CT = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

const as = (role: "member" | "admin", id = "a1"): Me => ({
  ...ME,
  account: { ...ME.account, id, isSuperAdmin: false },
  memberships: [{ orgId: "o1", slug: "acme", name: "Acme", role }],
});

const PENDING = [
  { key: "connector-1", label: "GitHub", source: { template: CT }, tools: ["search"] },
  {
    key: "connector-2",
    label: "Docs",
    source: {
      needs: { protocol: "mcp", endpoint: "https://docs.example/mcp", tools: [], label: "Docs" },
    },
  },
];

const agent = (over: Record<string, unknown> = {}, definition: Record<string, unknown> = {}) => ({
  id: "ag1",
  orgId: "o1",
  ownerAccountId: "a1",
  visibility: "org",
  currentVersion: 2,
  memberIds: null,
  needsReassignment: false,
  createdAt: T,
  updatedAt: T,
  profile: { avatar: null, description: "", quickActions: [], updatedAt: T },
  definition: {
    name: "Helper",
    instructions: "Be helpful.",
    model: { provider: "model-fake", model: "fake-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [{ kind: "builtin", name: "AskUserQuestion" }],
    toolPolicies: {},
    pendingConnectors: PENDING,
    ...definition,
  },
  createdFrom: { templateId: "t9", version: 3, name: "reviewer", available: true },
  ...over,
});

const MODELS = {
  providers: [
    {
      provider: "model-fake",
      models: [
        {
          id: "fake-1",
          displayName: "Fake 1",
          capabilities: { tools: true, vision: false, reasoning: false, caching: false },
          parameters: [],
        },
      ],
    },
  ],
};

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
function routes(a = agent(), over: Record<string, Handler> = {}) {
  return {
    [`GET ${ORG}/agents/ag1`]: ok({ agent: a }),
    [`GET ${ORG}/models`]: ok(MODELS),
    [`GET ${ORG}/connectors`]: ok({
      connectors: [
        connector("gh_old", { name: "GitHub old", platformTemplateId: CT }),
        connector("custom_one", { name: "Custom" }),
        connector("other_tpl", { platformTemplateId: "x" }),
      ],
    }),
    [`PATCH ${ORG}/agents/ag1`]: ok({ agent: a, warnings: [] }),
    [`GET ${ORG}/agents/ag1/pending-connectors/request`]: ok({ request: null }),
    ...over,
  };
}
const settle = () => act(() => new Promise((r) => setTimeout(r, 20)));
const request = (status: string, reason: string | null = null) => ({
  id: "r1",
  orgId: "o1",
  orgName: "Acme",
  kind: "connector_setup",
  item: null,
  entry: null,
  status,
  note: "",
  reason,
  requestedBy: "a1",
  requestedByName: "Me",
  decidedBy: null,
  decidedAt: null,
  stagingId: null,
  agent: { id: "ag1", name: "Helper", deleted: false },
  connectors: [],
  createdAt: T,
});

beforeEach(() => resetNavigation("/agents/ag1"));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("provenance (P4-8)", () => {
  it("links the template while it is usable, plain text otherwise", async () => {
    stubApi(routes());
    await renderEditAgent({ me: as("admin") });
    const line = document.querySelector("[data-provenance]") as HTMLElement;
    expect(line.textContent).toBe("Created from template reviewer v3");
    expect(within(line).getByRole("link", { name: "reviewer" }).getAttribute("href")).toBe(
      "/agents/templates/t9",
    );
    cleanup();
    const gone = agent({
      createdFrom: { templateId: "t9", version: 3, name: "reviewer", available: false },
    });
    stubApi(routes(gone));
    await renderEditAgent({ me: as("admin") });
    const plain = document.querySelector("[data-provenance]") as HTMLElement;
    expect(plain.textContent).toBe("Created from template reviewer v3");
    expect(within(plain).queryByRole("link")).toBeNull();
    cleanup();
    stubApi(routes(agent({ createdFrom: null })));
    await renderEditAgent({ me: as("admin") });
    expect(document.querySelector("[data-provenance]")).toBeNull();
  });

  it("a read-only viewer sees the provenance and a plain pending notice", async () => {
    stubApi(routes(agent({ ownerAccountId: "someone" })));
    await renderEditAgent({ me: as("member") });
    expect(document.querySelector("[data-provenance]")).not.toBeNull();
    expect(
      screen.getByText(
        "This agent has 2 connectors to configure; their tools are unavailable until then.",
      ),
    ).toBeTruthy();
    // no Tools section for them, so no configure action anywhere
    expect(screen.queryByRole("button", { name: P.configure })).toBeNull();
  });
});

describe("the 待配置 notice (P4-7)", () => {
  it("org admins configure: the existing connectors of that template, then bind", async () => {
    const calls = stubApi(
      routes(agent(), {
        [`POST ${ORG}/agents/ag1/pending-connectors/connector-1/bind`]: ok({
          agent: agent({}, { pendingConnectors: [PENDING[1]] }),
          dropped: [],
        }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    expect(within(notice).getByText("GitHub")).toBeTruthy();
    expect(
      within(notice).getByText("Needs an MCP connector: https://docs.example/mcp"),
    ).toBeTruthy();
    expect(within(notice).getByText("Takes the tools: search")).toBeTruthy();
    // a template entry names its template (the entry's label is the template's display name)
    expect(within(notice).getByText("Made from the connector template GitHub")).toBeTruthy();
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure GitHub" });
    // only the connector made from the template is offered
    const select = within(dialog).getByRole("combobox", { name: P.connectorLabel });
    expect(select.textContent).toContain("GitHub old");
    await userEvent.setup().click(within(dialog).getByRole("button", { name: P.bind }));
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/pending-connectors/connector-1/bind")).map(bodyOf),
      ).toEqual([{ connectorId: "gh_old" }]),
    );
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // the owner's request state is not for admins
    expect(calls.some((c) => c.url.endsWith("/pending-connectors/request"))).toBe(false);
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("an unauthorized OAuth connector (not_synced) says to authorize it first, with a link", async () => {
    stubApi(
      routes(agent(), {
        [`POST ${ORG}/agents/ag1/pending-connectors/connector-2/bind`]: () =>
          json(400, {
            error: {
              code: "agent.pending_connector_mismatch",
              message: "mismatch",
              details: [{ reason: "not_synced" }],
            },
          }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[1] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure Docs" });
    // a needs entry offers the org's connectors of that protocol
    await pickOption(
      within(dialog).getByRole("combobox", { name: P.connectorLabel }),
      "custom_one",
    );
    await userEvent.setup().click(within(dialog).getByRole("button", { name: P.bind }));
    expect(await within(dialog).findByText(P.bindError.not_synced)).toBeTruthy();
    expect(
      within(dialog).getByRole("link", { name: P.bindError.openConnector }).getAttribute("href"),
    ).toBe("/connectors/custom_one");
  });

  it("an entry bound elsewhere meanwhile: the agent is read again and the dialog closes", async () => {
    let reads = 0;
    stubApi(
      routes(agent(), {
        [`GET ${ORG}/agents/ag1`]: () => {
          reads += 1;
          return json(200, { agent: agent() });
        },
        [`POST ${ORG}/agents/ag1/pending-connectors/connector-1/bind`]: () =>
          json(404, {
            error: { code: "agent.pending_connector_not_found", message: "gone" },
          }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    const before = reads;
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure GitHub" });
    await userEvent.setup().click(within(dialog).getByRole("button", { name: P.bind }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await vi.waitFor(() => expect(reads).toBeGreaterThan(before));
    // no error was shown for it
    expect(screen.queryByText(en.errors.agent.pending_connector_not_found)).toBeNull();
  });

  it("a template switched off in the org offers no create, and says so", async () => {
    stubApi(
      routes(agent(), {
        [`GET ${ORG}/connectors`]: ok({ connectors: [] }),
        [`GET ${ORG}/components?kind=connector_template`]: ok({
          components: [
            {
              kind: "connector_template",
              id: CT,
              name: "gh",
              description: null,
              plugin: "crm",
              itemId: ITEM,
              version: "1",
              scopeMode: "follow",
              switch: false,
              on: false,
              locked: false,
              pluginOn: true,
              switchable: true,
            },
          ],
        }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure GitHub" });
    expect(await within(dialog).findByText(P.modeCreateOff)).toBeTruthy();
    expect(within(dialog).queryByRole("radio", { name: new RegExp(P.modeCreate) })).toBeNull();
    expect(within(dialog).getByText(P.noCandidatesOff)).toBeTruthy();
  });

  it("a template entry shows the template's display name in the person's language", async () => {
    stubApi(
      routes(agent(), {
        [`GET ${ORG}/components?kind=connector_template`]: ok({
          components: [
            {
              kind: "connector_template",
              id: CT,
              name: "gh",
              description: null,
              plugin: "crm",
              itemId: ITEM,
              version: "1",
              scopeMode: "follow",
              switch: null,
              on: true,
              locked: false,
              pluginOn: true,
              switchable: true,
            },
          ],
        }),
        [`GET ${ORG}/catalog/${ITEM}`]: ok({
          item: { id: ITEM, name: "crm", displayName: null },
          hasIcon: false,
          extension: null,
          templates: [
            {
              id: "gh",
              // the entry's label is the kernel's snapshot ("GitHub"); the page reads the template
              displayName: { zh: "代码仓库", en: "GitHub Enterprise" },
              description: "",
              plugin: "crm",
              connector: "mcp",
              endpoint: { url: "https://gh.example/mcp" },
              editableEndpoint: [],
              auth: { type: "none" },
              ownership: null,
            },
          ],
          dependencies: [],
          skills: [],
        }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    expect(await within(notice).findByText("GitHub Enterprise")).toBeTruthy();
    expect(
      within(notice).getByText("Made from the connector template GitHub Enterprise"),
    ).toBeTruthy();
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    expect(await screen.findByRole("dialog", { name: "Configure GitHub Enterprise" })).toBeTruthy();
  });

  it("a needs entry opens the custom connector form prefilled", async () => {
    stubApi(routes(agent(), { [`GET ${ORG}/connectors`]: ok({ connectors: [] }) }));
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[1] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure Docs" });
    // nothing to pick: creating is the way
    expect(within(dialog).getByText(P.customHint)).toBeTruthy();
    const href = within(dialog).getByRole("link", { name: P.openCustom }).getAttribute("href");
    expect(href).toBe(
      "/connectors/install?kind=mcp&endpoint=https%3A%2F%2Fdocs.example%2Fmcp&name=Docs&pending=1",
    );
  });

  it("a template entry: one more connector from the template, then bind it", async () => {
    const calls = stubApi(
      routes(agent(), {
        [`GET ${ORG}/connectors`]: ok({ connectors: [] }),
        [`GET ${ORG}/components?kind=connector_template`]: ok({
          components: [
            {
              kind: "connector_template",
              id: CT,
              name: "gh",
              description: null,
              plugin: "crm",
              itemId: ITEM,
              version: "1",
              scopeMode: "follow",
              switch: null,
              on: true,
              locked: false,
              pluginOn: true,
              switchable: true,
            },
          ],
        }),
        [`GET ${ORG}/catalog/${ITEM}`]: ok({
          item: { id: ITEM, name: "crm", displayName: null },
          hasIcon: false,
          extension: null,
          templates: [
            {
              id: "gh",
              displayName: { zh: "GitHub", en: "GitHub" },
              description: "",
              plugin: "crm",
              connector: "mcp",
              endpoint: { url: "https://gh.example/mcp" },
              editableEndpoint: [],
              auth: { type: "none" },
              ownership: null,
            },
          ],
          dependencies: [],
          skills: [],
        }),
        [`POST ${ORG}/connector-templates/${CT}/connectors`]: () =>
          json(201, { connector: { ...connector("gh_2"), tools: [] }, issues: [] }),
        [`POST ${ORG}/agents/ag1/pending-connectors/connector-1/bind`]: ok({
          agent: agent({}, { pendingConnectors: [PENDING[1]] }),
          dropped: ["tools.search"],
        }),
      }),
    );
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    const notice = await screen.findByRole("list", { name: P.listLabel });
    const rows = within(notice).getAllByRole("listitem");
    await userEvent
      .setup()
      .click(within(rows[0] as HTMLElement).getByRole("button", { name: P.configure }));
    const dialog = await screen.findByRole("dialog", { name: "Configure GitHub" });
    expect(await within(dialog).findByText(P.autoNameHint)).toBeTruthy();
    await userEvent.setup().click(within(dialog).getByRole("button", { name: P.createAndBind }));
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.url.endsWith("/pending-connectors/connector-1/bind")).map(bodyOf),
      ).toEqual([{ connectorId: "gh_2" }]),
    );
    // the name and slug left empty: the kernel picks free ones
    expect(
      calls.filter((c) => c.url.endsWith(`/connector-templates/${CT}/connectors`)).map(bodyOf),
    ).toEqual([{ config: {} }]);
  });

  it("the owner (member): 申请 when none exists, 已申请 while pending, the rejection and 重新申请", async () => {
    const calls = stubApi(
      routes(agent(), {
        [`POST ${ORG}/agents/ag1/pending-connectors/request`]: () =>
          json(201, { request: request("pending") }),
      }),
    );
    await renderEditAgent({ me: as("member"), section: "tools" });
    expect(await screen.findByText(P.request.none)).toBeTruthy();
    // no configure action for them
    expect(screen.queryByRole("button", { name: P.configure })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: P.request.ask }));
    await vi.waitFor(() =>
      expect(
        calls.filter((c) => c.method === "POST" && c.url.endsWith("/pending-connectors/request")),
      ).toHaveLength(1),
    );
    cleanup();

    stubApi(
      routes(agent(), {
        [`GET ${ORG}/agents/ag1/pending-connectors/request`]: ok({ request: request("pending") }),
      }),
    );
    await renderEditAgent({ me: as("member"), section: "tools" });
    expect(await screen.findByText(P.request.pending)).toBeTruthy();
    cleanup();

    const again = stubApi(
      routes(agent(), {
        [`GET ${ORG}/agents/ag1/pending-connectors/request`]: ok({
          request: request("rejected", "Use the shared one"),
        }),
        [`POST ${ORG}/agents/ag1/pending-connectors/request`]: () =>
          json(201, { request: request("pending") }),
      }),
    );
    await renderEditAgent({ me: as("member"), section: "tools" });
    expect(
      await screen.findByText("An organization admin rejected the request: Use the shared one"),
    ).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: P.request.again }));
    await vi.waitFor(() =>
      expect(
        again.filter((c) => c.method === "POST" && c.url.endsWith("/pending-connectors/request")),
      ).toHaveLength(1),
    );
  });

  it("a section save keeps the pending connectors (the field is left out)", async () => {
    const calls = stubApi(routes());
    await renderEditAgent({ me: as("admin", "boss"), section: "tools" });
    await screen.findByRole("list", { name: P.listLabel });
    await userEvent
      .setup()
      .click(screen.getByRole("checkbox", { name: en.agents.form.builtin.ReadToolOutput }));
    await userEvent.setup().click(screen.getByRole("button", { name: en.agents.form.submit }));
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1));
    const body = bodyOf(calls.find((c) => c.method === "PATCH")) as {
      definition: Record<string, unknown>;
    };
    expect(body.definition.pendingConnectors).toBeUndefined();
    expect(body.definition.tools).toEqual([
      { kind: "builtin", name: "AskUserQuestion" },
      { kind: "builtin", name: "ReadToolOutput" },
    ]);
    await settle();
  });
});
