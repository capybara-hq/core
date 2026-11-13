import { fileURLToPath } from "node:url";
import { UI_SLOTS } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createConv,
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The org UI routes gate by slot (UI slots spec §7, kernel org scope): the listing names each
 * contribution's slot and anchor and filters by `?slot=`; views, actions, embed tokens and the org
 * refresh stream check the slot's `minRole` and then its scope rule (conversation: readable;
 * agent: readable and in this org; org: the role alone); `platform.page` is never reached through
 * an org route. Every refusal is 404 `ui.not_found`.
 */

const fixture = (n: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${n}/index.ts`, import.meta.url));

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

let orgId: string;
let otherOrgId: string;
let ui: string;
let owner: Req;
let admin: Req;
let member: Req;
let guest: Req;
let root: Req;
let loner: Req;
let convId: string;
/** visibility org, in `orgId` */
let sharedAgent: string;
/** the member's private agent */
let privateAgent: string;
/** visibility org, in `otherOrgId` (the admin is a member there too) */
let foreignAgent: string;

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

async function createAgent(req: Req, org: string, visibility: "org" | "private"): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel(
    {
      ...base,
      extensions: [...base.extensions, fixture("ui-slots"), fixture("ui-legacy-place")],
    },
    { env: {} },
  );
  const accounts = accountsFor(db);
  const ids: Record<string, string> = {};
  for (const login of ["owner", "admin", "member", "guest"]) {
    ids[login] = (await accounts.createLocal({ login, password: PW, displayName: login })).id;
  }
  ids.root = (
    await accounts.createLocal({ login: "root", password: PW, displayName: "R", superAdmin: true })
  ).id;
  owner = await session(k, "owner");
  admin = await session(k, "admin");
  member = await session(k, "member");
  guest = await session(k, "guest");
  root = await session(k, "root");
  await accounts.createLocal({ login: "loner", password: PW, displayName: "loner" });
  loner = await session(k, "loner");
  orgId = await createOrg(owner);
  otherOrgId = await createOrg(owner, "Other");
  const members = testMembers(db);
  await members.add(orgId, ids.admin as string, "admin", ids.owner as string);
  await members.add(orgId, ids.member as string, "member", ids.owner as string);
  await members.add(orgId, ids.guest as string, "guest", ids.owner as string);
  await members.add(orgId, ids.root as string, "member", ids.owner as string);
  await members.add(otherOrgId, ids.admin as string, "member", ids.owner as string);
  await enableExtensions(raw, orgId, "ui-slots", "ui-legacy-place");
  await enableExtensions(raw, otherOrgId, "ui-slots", "ui-legacy-place");
  sharedAgent = await createAgent(owner, orgId, "org");
  privateAgent = await createAgent(member, orgId, "private");
  foreignAgent = await createAgent(owner, otherOrgId, "org");
  convId = await createConv(owner, orgId, sharedAgent);
  ui = `/api/v1/orgs/${orgId}/ui`;
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Item = { plugin: string; id: string; slot: string; after?: string; [k: string]: unknown };
const list = async (req: Req, query = ""): Promise<Item[]> => {
  const r = await req({ method: "GET", url: `${ui}/contributions${query}` });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json() as { items: Item[] }).items;
};
const view = (req: Req, id: string, query = "") =>
  req({ method: "GET", url: `${ui}/views/${id}${query}` });
const act = (req: Req, id: string, extra: Record<string, unknown> = {}) =>
  req({ method: "POST", url: `${ui}/actions/${id}`, payload: { actionId: "go", ...extra } });
const token = (req: Req, id: string, payload: Record<string, unknown> = {}) =>
  req({ method: "POST", url: `${ui}/embeds/${id}/token`, payload });
const expectNotFound = (r: { statusCode: number; body: string; json(): unknown }) => {
  expect(r.statusCode, r.body).toBe(404);
  expect(errCode(r)).toBe("ui.not_found");
};
/** The render args the ui-slots fixture echoes in its heading (`<id> <args JSON>`). */
const renderArgs = (r: { json(): unknown }, id: string): Record<string, unknown> => {
  const text = (r.json() as { view: { blocks: { text: string }[] } }).view.blocks[0]?.text ?? "";
  expect(text.startsWith(`${id} `)).toBe(true);
  return JSON.parse(text.slice(id.length + 1)) as Record<string, unknown>;
};

describe("org UI routes by slot", () => {
  it("contributions carry slot and the resolved anchor", async () => {
    const items = await list(owner);
    expect(items.find((i) => i.plugin === "ui-legacy-place" && i.id === "tasks-section")).toEqual(
      expect.objectContaining({ slot: "conversation.properties.section", after: "context" }),
    );
    for (const i of items) expect(i).not.toHaveProperty("place");
    // base order: extension name, then manifest order; aliases and dropped entries are not listed
    expect(items.map((i) => `${i.plugin}/${i.id}`)).toEqual([
      "ui-legacy-place/tasks-panel",
      "ui-legacy-place/tasks-section",
      "ui-legacy-place/tasks-card",
      "ui-slots/notes",
      "ui-slots/org-admin",
      "ui-slots/page",
      "ui-slots/page-embed",
      "ui-slots/notes-embed",
    ]);
  });

  it("?slot= filters to one slot", async () => {
    expect((await list(owner, "?slot=agent.detail.section")).map((i) => i.id)).toEqual([
      "notes",
      "notes-embed",
    ]);
    const bad = await owner({ method: "GET", url: `${ui}/contributions?slot=nowhere` });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");
  });

  it("platform.page is never listed or served through an org route", async () => {
    for (const req of [owner, root]) {
      expect((await list(req)).some((i) => i.slot === "platform.page")).toBe(false);
      expect(await list(req, "?slot=platform.page")).toEqual([]);
      expectNotFound(await view(req, "ui-slots/platform-home"));
      expectNotFound(await act(req, "ui-slots/platform-home"));
      expectNotFound(await token(req, "ui-slots/platform-embed"));
    }
  });

  it("a guest gets 404 for org.page on every route", async () => {
    expectNotFound(await view(guest, "ui-slots/page"));
    expectNotFound(await act(guest, "ui-slots/page"));
    expectNotFound(await token(guest, "ui-slots/page-embed"));
    expectNotFound(await guest({ method: "GET", url: `${ui}/stream` }));
    expect((await list(guest)).some((i) => i.slot === "org.page")).toBe(false);
    expect((await view(member, "ui-slots/page")).statusCode).toBe(200);
    expect((await act(member, "ui-slots/page")).statusCode).toBe(200);
    expect((await token(member, "ui-slots/page-embed")).statusCode).toBe(200);
  });

  it("org.settings.section is admin and above", async () => {
    expectNotFound(await view(member, "ui-slots/org-admin"));
    expectNotFound(await act(member, "ui-slots/org-admin"));
    expectNotFound(await view(guest, "ui-slots/org-admin"));
    for (const req of [admin, owner]) {
      expect((await view(req, "ui-slots/org-admin")).statusCode).toBe(200);
      expect((await act(req, "ui-slots/org-admin")).statusCode).toBe(200);
    }
    expect((await list(member)).some((i) => i.id === "org-admin")).toBe(false);
    expect((await list(admin)).some((i) => i.id === "org-admin")).toBe(true);
    // an org view takes no agentId
    const r = await view(admin, "ui-slots/org-admin", `?agentId=${sharedAgent}`);
    expect(r.statusCode, r.body).toBe(400);
  });

  it("an agent section needs agentId and a readable agent", async () => {
    const missing = await view(admin, "ui-slots/notes");
    expect(missing.statusCode, missing.body).toBe(400);
    expect(errCode(missing)).toBe("validation_failed");
    expect(missing.body).toContain("agentId is required for an agent view");
    // a private agent of another member: not readable, even for an admin
    expectNotFound(await view(admin, "ui-slots/notes", `?agentId=${privateAgent}`));
    expectNotFound(await act(admin, "ui-slots/notes", { agentId: privateAgent }));
    expectNotFound(await token(admin, "ui-slots/notes-embed", { agentId: privateAgent }));
    // readable by the admin in the other org, but not in this org
    expectNotFound(await view(admin, "ui-slots/notes", `?agentId=${foreignAgent}`));
    expectNotFound(await token(admin, "ui-slots/notes-embed", { agentId: foreignAgent }));
    // not a UUID
    expect((await view(admin, "ui-slots/notes", "?agentId=nope")).statusCode).toBe(400);
    // a conversation id is not an agent's
    const conv = await view(
      admin,
      "ui-slots/notes",
      `?agentId=${sharedAgent}&conversationId=${convId}`,
    );
    expect(conv.statusCode, conv.body).toBe(400);

    const ok = await view(admin, "ui-slots/notes", `?agentId=${sharedAgent}`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(renderArgs(ok, "notes")).toMatchObject({
      orgId,
      role: "admin",
      slot: "agent.detail.section",
      scope: "agent",
      agentId: sharedAgent,
    });
    expect((await act(admin, "ui-slots/notes", { agentId: sharedAgent })).statusCode).toBe(200);
    // the member owns the private agent
    expect((await view(member, "ui-slots/notes", `?agentId=${privateAgent}`)).statusCode).toBe(200);

    // the embed token carries agentId into the claims the extension verifies
    const t = await token(admin, "ui-slots/notes-embed", { agentId: sharedAgent });
    expect(t.statusCode, t.body).toBe(200);
    const { token: tok } = t.json() as { token: string };
    const claims = await k.http.inject({
      method: "GET",
      url: `/plugins/ui-slots/ui/platform-data?token=${encodeURIComponent(tok)}`,
    });
    expect(claims.statusCode, claims.body).toBe(200);
    expect(claims.json()).toMatchObject({ agentId: sharedAgent, contribution: "notes-embed" });
  });

  it("a guest sees an agent section of a shared agent", async () => {
    const r = await view(guest, "ui-slots/notes", `?agentId=${sharedAgent}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(renderArgs(r, "notes")).toMatchObject({ role: "guest", agentId: sharedAgent });
    expect((await list(guest, "?slot=agent.detail.section")).map((i) => i.id)).toEqual([
      "notes",
      "notes-embed",
    ]);
  });

  it("conversation views receive slot and scope and refuse agentId", async () => {
    const r = await view(owner, "ui-legacy-place/tasks-panel", `?conversationId=${convId}`);
    expect(r.statusCode, r.body).toBe(200);
    const bad = await view(
      owner,
      "ui-legacy-place/tasks-panel",
      `?conversationId=${convId}&agentId=${sharedAgent}`,
    );
    expect(bad.statusCode, bad.body).toBe(400);
  });

  it("the rc.2 alias still answers", async () => {
    const r = await view(owner, "ui-legacy-place/tasks", `?conversationId=${convId}`);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as { view: { blocks: { text: string }[] } }).view.blocks[0]?.text).toBe(
      "tasks-panel",
    );
  });
});

describe("GET /api/v1/ui/slots", () => {
  it("GET /api/v1/ui/slots answers any signed-in person", async () => {
    for (const who of [guest, loner]) {
      const r = await who({ method: "GET", url: "/api/v1/ui/slots" });
      expect(r.statusCode, r.body).toBe(200);
      const { slots } = r.json() as { slots: { id: string }[] };
      expect(slots).toEqual(JSON.parse(JSON.stringify(UI_SLOTS)));
      expect(slots.map((s) => s.id).sort()).toEqual(
        [
          "agent.detail.section",
          "conversation.panel",
          "conversation.properties.section",
          "conversation.tool-result.card",
          "file.preview",
          "org.page",
          "org.settings.section",
          "platform.page",
          "shell.brand",
          "shell.overlay",
          "conversation.empty",
          "conversation.composer.frame",
        ].sort(),
      );
    }
  });

  it("anonymous gets auth.required", async () => {
    const r = await k.http.inject({ method: "GET", url: "/api/v1/ui/slots" });
    expect(r.statusCode).toBe(401);
    expect((r.json() as { error: { code: string } }).error.code).toBe("auth.required");
  });
});
