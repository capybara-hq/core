import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createConv,
  createOrg,
  enableExtensions,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Component contributions on the org UI routes (client extensions spec §5.1-§5.2, §6.3): listed
 * with `kind: "component"`, a component's server view may carry `data` (a plain view may not), the
 * slot's role and scope rule decide access, a single slot lists nothing until a winner is chosen,
 * and a tool's card may name a component card.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let orgId: string;
let ui: string;
let owner: Req;
let guest: Req;
let ownerConv: string;
let agentId: string;
let guestConv: string;
const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    { ...base, extensions: [...base.extensions, fixture("ui-components")] },
    { env: {} },
  );
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "guest"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  owner = await session(k, "owner");
  guest = await session(k, "guest");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, ids.guest as string, "guest", ids.owner as string);
  await enableExtensions(raw, orgId, "ui-components");
  const agent = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([]),
      },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = (agent.json() as { agent: { id: string } }).agent.id;
  ownerConv = await createConv(owner, orgId, agentId);
  guestConv = await createConv(guest, orgId, agentId);
  ui = `/api/v1/orgs/${orgId}/ui`;
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Item = { plugin: string; id: string; slot: string; kind: string; path?: string };
const list = async (req: Req, query = ""): Promise<Item[]> => {
  const r = await req({ method: "GET", url: `${ui}/contributions${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items;
};

describe("component contributions", () => {
  it("components are listed with kind component", async () => {
    const items = await list(owner);
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    for (const id of ["hud", "fx", "card"]) {
      expect(byId[id]?.kind, id).toBe("component");
      expect(byId[id], id).not.toHaveProperty("path");
    }
    expect(byId.hud?.slot).toBe("conversation.properties.section");
    expect(byId.fx?.slot).toBe("shell.overlay");
    expect(byId.plain?.kind).toBe("view");
    // a guest uses the shell and conversation slots too (minRole guest)
    expect((await list(guest, "?slot=shell.overlay")).map((i) => i.id)).toEqual(["fx"]);
  });

  it("a component view returns data", async () => {
    const r = await owner({
      method: "GET",
      url: `${ui}/views/ui-components/hud?conversationId=${ownerConv}`,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 1 });
    const a = await owner({
      method: "POST",
      url: `${ui}/actions/ui-components/hud`,
      payload: { actionId: "go", conversationId: ownerConv },
    });
    expect(a.statusCode, a.body).toBe(200);
    expect((a.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 2 });
    // a conversation component takes the conversation's scope args: no conversationId is 400
    const bare = await owner({ method: "GET", url: `${ui}/views/ui-components/hud` });
    expect(bare.statusCode, bare.body).toBe(400);
    expect(errCode(bare)).toBe("validation_failed");
  });

  it("a view returning data is invalid", async () => {
    const r = await owner({
      method: "GET",
      url: `${ui}/views/ui-components/plain?conversationId=${ownerConv}`,
    });
    expect(r.statusCode, r.body).toBe(502);
    expect(errCode(r)).toBe("ui.invalid_view");
    const a = await owner({
      method: "POST",
      url: `${ui}/actions/ui-components/plain`,
      payload: { actionId: "go", conversationId: ownerConv },
    });
    expect(a.statusCode, a.body).toBe(502);
    expect(errCode(a)).toBe("ui.invalid_view");
  });

  it("a guest gets a conversation component view; a reader of another conversation gets 404", async () => {
    const own = await guest({
      method: "GET",
      url: `${ui}/views/ui-components/hud?conversationId=${guestConv}`,
    });
    expect(own.statusCode, own.body).toBe(200);
    expect((own.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 1 });
    const foreign = await guest({
      method: "GET",
      url: `${ui}/views/ui-components/hud?conversationId=${ownerConv}`,
    });
    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(errCode(foreign)).toBe("ui.not_found");
    // a component without a server view has nothing to render: 404, as for a missing view
    const noView = await owner({ method: "GET", url: `${ui}/views/ui-components/fx` });
    expect(noView.statusCode, noView.body).toBe(404);
  });

  it("an agent-scoped component view needs a readable agent", async () => {
    const view = (req: Req, q: string) =>
      req({ method: "GET", url: `${ui}/views/ui-components/agentx${q}` });
    for (const req of [owner, guest]) {
      const r = await view(req, `?agentId=${agentId}`);
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 4 });
    }
    const bare = await view(owner, "");
    expect(bare.statusCode, bare.body).toBe(400);
    expect(errCode(bare)).toBe("validation_failed");
    const other = await view(owner, `?agentId=${crypto.randomUUID()}`);
    expect(other.statusCode, other.body).toBe(404);
    const conv = await view(owner, `?agentId=${agentId}&conversationId=${ownerConv}`);
    expect(conv.statusCode, conv.body).toBe(400);
  });

  it("an org list slot component view follows the slot's role", async () => {
    const view = (req: Req, q = "") =>
      req({ method: "GET", url: `${ui}/views/ui-components/pagex${q}` });
    const r = await view(owner);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { view: { data?: unknown } }).view.data).toEqual({ n: 5 });
    // org.page is for members and up: a guest gets the same 404 as an unknown contribution
    const g = await view(guest);
    expect(g.statusCode, g.body).toBe(404);
    expect((await list(guest, "?slot=org.page")).map((i) => i.id)).toEqual([]);
    expect((await list(owner, "?slot=org.page")).map((i) => [i.id, i.kind])).toEqual([
      ["pagex", "component"],
    ]);
    const conv = await view(owner, `?conversationId=${ownerConv}`);
    expect(conv.statusCode, conv.body).toBe(400);
  });

  it("single slots list nothing until a winner is chosen", async () => {
    for (const slot of ["shell.brand", "conversation.empty", "conversation.composer.frame"]) {
      expect(await list(owner, `?slot=${slot}`), slot).toEqual([]);
    }
    const all = (await list(owner)).map((i) => i.id);
    expect(all).not.toContain("brand");
    expect(all).not.toContain("empty");
    expect(all).not.toContain("frame");
    const r = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { uiArrangement: { "shell.brand": { use: "ui-components/brand" } } },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect((await list(guest, "?slot=shell.brand")).map((i) => `${i.plugin}/${i.id}`)).toEqual([
      "ui-components/brand",
    ]);
    expect((await list(owner)).map((i) => i.id)).toContain("brand");
    expect(await list(owner, "?slot=conversation.empty")).toEqual([]);
  });

  it("the pipeline keeps a card naming a component", async () => {
    const r = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${ownerConv}/messages`,
      payload: { text: "tool:plugin__ui-components__ping:{}" },
    });
    expect(r.statusCode, r.body).toBe(202);
    await waitForTerminal(db, ownerConv, 1, 20_000);
    const result = (await eventsOf(db, ownerConv)).find(
      (e): e is Extract<ConversationEvent, { type: "tool_result" }> => e.type === "tool_result",
    );
    expect(result?.payload.card).toEqual({ plugin: "ui-components", view: "card" });
  });
});
