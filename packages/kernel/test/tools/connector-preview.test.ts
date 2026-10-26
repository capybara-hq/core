import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { createOrg, PW, type Req, runConfig, session } from "../helpers/runs.js";

/**
 * The connector preview (`POST /connectors/preview`, Ruling A20) on the kernel side, with the test
 * connector `mem` (no `inspect`): listing tools with a credential opens and closes one session and
 * writes nothing; no credential or an OAuth code flow lists nothing; a wrong credential is a 502
 * without the credential; validation and permissions. The preview of a connector with `inspect`
 * (auth hints, operations) is tested on the real OpenAPI connector in that plugin's
 * `test/kernel/openapi-e2e.test.ts`, and in core on `fake-connector` (`m3-segment2.dual.test.ts`: auth hints -> install).
 */
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

const MEM_TOKEN = "mem_secret_value_0123456789";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let req: Req;
let orgId: string;
let ownerId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        extensions: [MODEL_FAKE, MEM_CONNECTOR],
        extensionPermissions: { autoApprove: true },
        roles: ["api", "worker"],
        tools: { timeoutMs: 5_000 },
      },
    ),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  req = await session(k, "owner");
  orgId = await createOrg(req);
  const st = memState();
  st.servers = {
    docs: {
      tools: [
        {
          name: "search",
          description: "Search documents.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "bad name!", description: "Bad.", inputSchema: { type: "object" } },
      ],
      requireAuth: `Bearer ${MEM_TOKEN}`,
    },
  };
  st.opened = 0;
  st.closed = 0;
  st.auths = [];
});

const countRows = async (table: "connectors" | "connector_tools" | "secrets" | "audit_events") =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM ${sql.table(`capybara.${table}`)}`.execute(raw)
    ).rows[0]?.n,
  );

const preview = (payload: Record<string, unknown>, r: Req = req) =>
  r({ method: "POST", url: `/api/v1/orgs/${orgId}/connectors/preview`, payload });

interface PreviewJson {
  tools:
    | {
        name: string;
        key: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: Record<string, unknown> | null;
        defaultPolicy: string;
        issue: string | null;
        source: string;
      }[]
    | null;
  authHints: Record<string, unknown>[];
  operations?: { id: string; method: string; path: string; summary?: string }[];
}

const errOf = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string; message: string } }).error;

describe("连接器预览", () => {
  it("凭据错误的列工具失败 → 502，凭据不出现在响应里", async () => {
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: `wrong-${MEM_TOKEN}` },
    });
    expect(res.statusCode).toBe(502);
    expect(errOf(res).code).toBe("connector.connect_failed");
    expect(res.body).not.toContain(MEM_TOKEN);
  });

  it("没有 inspect 的连接器：authHints 为空、没有 operations；有凭据时列工具并关闭会话；什么都不写", async () => {
    const before = {
      connectors: await countRows("connectors"),
      secrets: await countRows("secrets"),
      audit: await countRows("audit_events"),
    };
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: MEM_TOKEN },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson;
    expect(body.authHints).toEqual([]);
    expect(body.operations).toBeUndefined();
    // 没给 slug / name：key 用占位 slug `app`
    expect(body.tools?.map((t) => [t.key, t.issue === null])).toEqual([
      ["app__search", true],
      ["app__bad name!", false],
    ]);
    expect(memState().opened).toBe(1);
    expect(memState().closed).toBe(1);
    expect(res.body).not.toContain(MEM_TOKEN);
    expect(await countRows("connectors")).toBe(before.connectors);
    expect(await countRows("secrets")).toBe(before.secrets);
    expect(await countRows("connector_tools")).toBe(0);
    expect(await countRows("audit_events")).toBe(before.audit);
  });

  it("需要凭据但没给 / OAuth 授权码 → 不列工具", async () => {
    for (const auth of [
      { type: "bearer", ownership: "org" },
      {
        type: "oauth_code",
        ownership: "personal",
        discovery: "manual",
        authorizationUrl: "https://auth.example.com/a",
        tokenUrl: "https://auth.example.com/t",
        client: "manual",
      },
    ]) {
      const res = await preview({ connector: "mem", endpoint: { server: "docs" }, auth });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as PreviewJson).tools).toBeNull();
    }
    expect(memState().opened).toBe(0);
  });

  it("校验：未知连接器 / 凭据形状 → 400", async () => {
    const unknown = await preview({ connector: "nope", endpoint: {} });
    expect(unknown.statusCode).toBe(400);
    const shape = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "basic", ownership: "org" },
      credential: { token: "x" },
    });
    expect(shape.statusCode).toBe(400);
  });

  it("权限：member → 403", async () => {
    const acc = await new AccountsService(db).createLocal({
      login: "mem",
      password: PW,
      displayName: "m",
    });
    await testMembers(db).add(orgId, acc.id, "member", ownerId);
    const memberReq = await session(k, "mem");
    const res = await preview({ connector: "mem", endpoint: { server: "docs" } }, memberReq);
    expect(res.statusCode).toBe(403);
  });
});
