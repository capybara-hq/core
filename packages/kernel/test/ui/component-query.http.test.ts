import { UI_LIMITS } from "@capybara-hq/plugin-sdk";
import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { UI_QUERY_TIMEOUT_MS } from "../../src/ui/views.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  enableExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";
import { openSse, uiFrames } from "../helpers/sse.js";

/**
 * Component queries (plugin full pages spec §4): `POST /api/v1/orgs/:orgId/ui/query/:plugin/:id`
 * runs a component's `ctx.ui.query` handler for a person the contribution is offered to, with the
 * params / result limits and the 10 s timeout; a component action takes a form-sized payload while
 * a view's button keeps 2 000 bytes; `ctx.ui.invalidate` tells the web to refetch queries too.
 * Fixture `fake-client-page` of `@capybara-hq/testing`.
 */

const PAGE = fakeExtensionEntry("fake-client-page");

/** The fixture's probe (`fakeClientPageProbe`): the kernel runs in this process. */
const probe = (): { aborted: number } => {
  const g = globalThis as { __fakeClientPage?: { aborted: number } };
  g.__fakeClientPage ??= { aborted: 0 };
  return g.__fakeClientPage;
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let orgId: string;
let offOrg: string;
let ownerId: string;
let owner: Req;
let ownerCookie: () => string;
let guest: Req;
let ui: string;

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] });
  k = await startKernel({ ...base, extensions: [...base.extensions, PAGE] }, { env: {} });
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  const guestId = (await accounts.createLocal({ login: "guest", password: PW, displayName: "G" }))
    .id;
  const jar = cookieJar();
  owner = asUser(k.http, jar);
  const login = await owner({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  ownerCookie = () => jar.header() as string;
  guest = await session(k, "guest");
  orgId = await createOrg(owner);
  offOrg = await createOrg(owner, "Off");
  await testMembers(db).add(orgId, guestId, "guest", ownerId);
  await enableExtensions(raw, orgId, "fake-client-page");
  ui = `/api/v1/orgs/${orgId}/ui`;
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const query = (req: Req, body: Record<string, unknown>, base = ui, id = "board") =>
  req({ method: "POST", url: `${base}/query/fake-client-page/${id}`, payload: body });

describe("component queries", () => {
  it("returns the handler's data for an offered component", async () => {
    const r = await query(owner, { query: "items", params: { column: "todo" }, locale: "zh" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      data: {
        items: [
          { id: "a", title: "Alpha", column: "todo" },
          { id: "b", title: "Beta", column: "doing" },
        ],
        params: { column: "todo" },
        caller: { orgId, accountId: ownerId, role: "owner", slot: "org.page", locale: "zh" },
      },
    });
    // no params: the handler gets null
    const bare = await query(owner, { query: "items" });
    expect(bare.statusCode, bare.body).toBe(200);
    expect((bare.json() as { data: { params: unknown } }).data.params).toBeNull();
  });

  it("404 when the contribution is not offered to the person", async () => {
    // org.page needs a member: a guest is not offered it
    const g = await query(guest, { query: "items" });
    expect(g.statusCode, g.body).toBe(404);
    expect(errCode(g)).toBe("ui.query_not_found");
    // an org where the extension is off
    const off = await query(owner, { query: "items" }, `/api/v1/orgs/${offOrg}/ui`);
    expect(off.statusCode, off.body).toBe(404);
    expect(errCode(off)).toBe("ui.query_not_found");
    // a view (no query handler) and an unknown contribution
    for (const id of ["summary", "nope"]) {
      const r = await query(owner, { query: "items" }, ui, id);
      expect(r.statusCode, id).toBe(404);
      expect(errCode(r)).toBe("ui.query_not_found");
    }
    // an org page takes no conversation
    const conv = await query(owner, {
      query: "items",
      conversationId: "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
    });
    expect(conv.statusCode, conv.body).toBe(400);
    expect(errCode(conv)).toBe("validation_failed");
  });

  it("service token refused", async () => {
    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const r = await k.http.inject({
      method: "POST",
      url: `${ui}/query/fake-client-page/board`,
      headers: { authorization: `Bearer ${token}` },
      payload: { query: "items" },
    });
    expect(r.statusCode, r.body).toBe(403);
  });

  it("413 on params over 16 KB", async () => {
    const over = await query(owner, {
      query: "items",
      params: { s: "x".repeat(UI_LIMITS.componentQueryParamsBytes) },
    });
    expect(over.statusCode, over.body).toBe(413);
    expect(errCode(over)).toBe("ui.query_params_too_large");
    const fits = await query(owner, {
      query: "items",
      params: { s: "x".repeat(UI_LIMITS.componentQueryParamsBytes - 20) },
    });
    expect(fits.statusCode, fits.body).toBe(200);
  });

  it("query error and timeout surface as status error", async () => {
    const boom = await query(owner, { query: "boom" });
    expect(boom.statusCode, boom.body).toBe(502);
    expect(errCode(boom)).toBe("ui.query_failed");
    expect(boom.body).not.toContain("fake-client-page: boom");

    const aborted = probe().aborted;
    const t0 = Date.now();
    const slow = await query(owner, { query: "slow" });
    expect(slow.statusCode, slow.body).toBe(504);
    expect(errCode(slow)).toBe("ui.query_timeout");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(UI_QUERY_TIMEOUT_MS - 100);
    // the handler's signal aborted
    expect(probe().aborted).toBe(aborted + 1);
  });

  it("huge result → 502", async () => {
    const r = await query(owner, { query: "huge" });
    expect(r.statusCode, r.body).toBe(502);
    expect(errCode(r)).toBe("ui.query_result_too_large");
  });

  it("component action accepts a 60 KB payload, a view block action still caps at 2 000", async () => {
    const big = { text: "x".repeat(60 * 1024) };
    const move = await owner({
      method: "POST",
      url: `${ui}/actions/fake-client-page/board`,
      payload: { actionId: "move", payload: big },
    });
    expect(move.statusCode, move.body).toBe(200);
    const bytes = Buffer.byteLength(JSON.stringify(big), "utf8");
    // a component action's result names the queries to refetch
    expect(move.json()).toEqual({
      toast: { zh: `已移动 ${bytes}`, en: `moved ${bytes}` },
      invalidate: ["items"],
    });
    const overComponent = await owner({
      method: "POST",
      url: `${ui}/actions/fake-client-page/board`,
      payload: {
        actionId: "move",
        payload: { s: "x".repeat(UI_LIMITS.componentActionPayloadBytes) },
      },
    });
    expect(overComponent.statusCode, overComponent.body).toBe(400);

    const view = (payload: unknown) =>
      owner({
        method: "POST",
        url: `${ui}/actions/fake-client-page/summary`,
        payload: { actionId: "go", payload },
      });
    const overView = await view({ s: "x".repeat(UI_LIMITS.payloadBytes) });
    expect(overView.statusCode, overView.body).toBe(400);
    expect(errCode(overView)).toBe("validation_failed");
    const fitsView = await view({ s: "x".repeat(UI_LIMITS.payloadBytes - 20) });
    expect(fitsView.statusCode, fitsView.body).toBe(200);
    expect(fitsView.json()).toEqual({ toast: { zh: "好", en: "ok" } });
  });

  it("ctx.ui.invalidate publishes queries: true", async () => {
    const stream = await openSse(`http://127.0.0.1:${k.port}${ui}/stream`, {
      cookie: ownerCookie(),
    });
    try {
      expect(stream.status).toBe(200);
      // the fixture's move action calls ctx.ui.invalidate({ orgId, contribution: "board" })
      const move = await owner({
        method: "POST",
        url: `${ui}/actions/fake-client-page/board`,
        payload: { actionId: "move", payload: { id: "a" } },
      });
      expect(move.statusCode, move.body).toBe(200);
      await stream.until((m) => uiFrames(m).length > 0, 10_000, "org ui frame");
      expect(uiFrames(stream.messages)).toEqual([
        { plugin: "fake-client-page", contribution: "board", queries: true },
      ]);
    } finally {
      stream.close();
    }
  });
});
