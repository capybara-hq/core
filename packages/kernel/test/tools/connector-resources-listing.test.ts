import {
  type FakeMcpResource,
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrgWithProviders,
  enableConnectorExtensions,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The per-connector resources listing (`GET /connectors/resources?connectorId=`): one session on
 * that connector, UI templates and empty resources hidden, at most 200 items, the admin's
 * `read_resource` switch and the org boundary honored. The connector is the core fake
 * `fake-connector` (an MCP client for startFakeMcpServer).
 */

const CONNECTOR = fakeExtensionEntry("fake-connector");
const TOKEN = "resources-listing-token-4f81c2";
const MANY = 250;

const resources: FakeMcpResource[] = [
  { uri: "docs://handbook", name: "Handbook", mimeType: "text/markdown", size: 12, text: "hi" },
  { uri: "docs://unsized", name: "Unsized", text: "hi" },
  { uri: "docs://empty", name: "Empty", size: 0, text: "" },
  { uri: "ui://widget", name: "Widget", mimeType: "text/html;profile=mcp-app", text: "<p/>" },
  { uri: "https://x.test/app", name: "App", mimeType: "TEXT/HTML; Profile=MCP-App", text: "<p/>" },
];

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let first: FakeMcpServer;
let second: FakeMcpServer;
let many: FakeMcpServer;
let req: Req;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const server = (res: FakeMcpResource[]) =>
    startFakeMcpServer({ tools: [], resources: res, requireBearer: TOKEN });
  [first, second, many] = await Promise.all([
    server(resources),
    server([{ uri: "docs://other", name: "Other", text: "x" }]),
    server(
      Array.from({ length: MANY }, (_, i) => ({
        uri: `docs://n${i}`,
        name: `Doc ${i}`,
        text: "x",
      })),
    ),
  ]);
  const logger = createLogger("info", { write: () => {} });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, CONNECTOR],
        extensionPermissions: { autoApprove: true },
        extensionConfig: { "fake-connector": {} },
        roles: ["api", "worker"],
      },
    ),
    { env: {}, logger },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
});

afterAll(async () => {
  await k?.close();
  await Promise.all([first?.stop(), second?.stop(), many?.stop()]);
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  orgId = await createOrgWithProviders(k, req);
  await enableConnectorExtensions(k, orgId);
  for (const s of [first, second, many]) s.requests.length = 0;
});

async function install(slug: string, server: FakeMcpServer): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: slug,
      slug,
      connector: "fake",
      endpoint: { url: server.url },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: TOKEN },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

const list = (connectorId: string, extra = "") =>
  req({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/connectors/resources?connectorId=${connectorId}${extra}`,
  });

const listed = (server: FakeMcpServer) =>
  server.requests.filter((c) => c.method === "resources/list").length;

describe("resources listing with connectorId", () => {
  it("resources route with connectorId opens one session", async () => {
    const a = await install("one", first);
    await install("two", second);
    first.requests.length = 0;
    second.requests.length = 0;
    const res = await list(a);
    expect(res.statusCode, res.body).toBe(200);
    expect(listed(first)).toBe(1);
    expect(listed(second)).toBe(0);
    expect(second.requests).toEqual([]);
  });

  it("filters UI templates and empty resources", async () => {
    const a = await install("one", first);
    const res = await list(a);
    const body = res.json() as { resources: { uri: string; size?: number }[] };
    expect(body.resources.map((r) => r.uri)).toEqual(["docs://handbook", "docs://unsized"]);
    expect(body.resources[0]).toMatchObject({ uri: "docs://handbook", size: 12 });
    // one connector asked about: no `unavailable` list (a failure is the answer itself)
    expect(body).not.toHaveProperty("unavailable");
  });

  it("refuses a listing without connectorId", async () => {
    await install("one", first);
    const res = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/resources` });
    expect(res.statusCode, res.body).toBe(400);
    expect(listed(first)).toBe(0);
  });

  it("caps at 200", async () => {
    const a = await install("many", many);
    const res = await list(a);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { resources: unknown[] }).resources).toHaveLength(200);
  });

  it("refuses a connector whose read_resource is off", async () => {
    const a = await install("one", first);
    const off = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${a}`,
      payload: { tools: { read_resource: { status: "disabled" } } },
    });
    expect(off.statusCode, off.body).toBe(200);
    const res = await list(a);
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "connector.resources_disabled",
    );
  });

  it("refuses a disabled connector and a deleted one", async () => {
    const off = await install("off", first);
    const gone = await install("gone", second);
    const patched = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${off}`,
      payload: { status: "disabled" },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const deleted = await req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/connectors/${gone}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    for (const id of [off, gone]) {
      const res = await list(id);
      expect(res.statusCode, res.body).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("connector.not_found");
    }
  });

  it("refuses a connector of another org", async () => {
    const a = await install("one", first);
    const otherOrg = await createOrgWithProviders(k, req, "Other");
    await enableConnectorExtensions(k, otherOrg);
    const res = await req({
      method: "GET",
      url: `/api/v1/orgs/${otherOrg}/connectors/resources?connectorId=${a}`,
    });
    expect(res.statusCode, res.body).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("connector.not_found");
  });
});
