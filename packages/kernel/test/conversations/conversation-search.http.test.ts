import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
} from "../helpers/runs.js";

/** Web order Task 2: title search, run activity and the archived count of the conversation lists. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }));
});
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
});

const base = () => `/api/v1/orgs/${orgId}/conversations`;
const rename = (id: string, title: string) =>
  owner({ method: "PATCH", url: `${base()}/${id}`, payload: { title } });
type Row = { id: string; activity?: string | null };
const list = async (qs: string) =>
  (await owner({ method: "GET", url: `${base()}${qs}` })).json() as { conversations: Row[] };
const groups = async (qs: string) =>
  (await owner({ method: "GET", url: `${base()}/groups${qs}` })).json() as {
    groups: { conversations: Row[] }[];
    archivedCount: number;
  };
const setRunStatus = async (convId: string, status: string) => {
  await sql`UPDATE capybara.runs SET status = ${status} WHERE conversation_id = ${convId}`.execute(
    raw,
  );
};

describe("conversation search, activity, archived count", () => {
  it("q matches titles case-insensitively", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    expect((await rename(a, "Q3 报告")).statusCode).toBe(200);
    expect((await rename(b, "weekly")).statusCode).toBe(200);
    expect((await list("?q=q3")).conversations.map((c) => c.id)).toEqual([a]);
    const g = await groups("?q=q3");
    expect(g.groups.flatMap((x) => x.conversations.map((c) => c.id))).toEqual([a]);
    const none = await groups("?q=nomatch");
    expect(none.groups).toEqual([]);
  });

  it("q escapes LIKE wildcards", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    await rename(a, "50% off");
    await rename(b, "500 items");
    expect((await list("?q=50%25")).conversations.map((c) => c.id)).toEqual([a]);
    expect((await list("?q=_")).conversations).toEqual([]);
    expect((await groups("?q=_")).groups).toEqual([]);
  });

  it("state=waiting filters by the latest run", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, a, "echo:hi");
    await postMessage(owner, orgId, b, "echo:hi");
    await waitFor(async () => (await runsOf(db, a)).every((r) => r.status === "completed"));
    await waitFor(async () => (await runsOf(db, b)).every((r) => r.status === "completed"));
    await setRunStatus(a, "waiting");
    expect((await list("?state=waiting")).conversations.map((c) => c.id)).toEqual([a]);
    expect(
      (await groups("?state=waiting")).groups.flatMap((x) => x.conversations.map((c) => c.id)),
    ).toEqual([a]);
    expect((await list("?state=running")).conversations).toEqual([]);
  });

  it("activity is reported on list rows", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    const c = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, a, "echo:hi");
    await postMessage(owner, orgId, b, "echo:hi");
    await waitFor(async () => (await runsOf(db, a)).every((r) => r.status === "completed"));
    await waitFor(async () => (await runsOf(db, b)).every((r) => r.status === "completed"));
    await setRunStatus(a, "waiting");
    await setRunStatus(b, "running");
    const by = new Map((await list("")).conversations.map((x) => [x.id, x.activity]));
    expect(by.get(a)).toBe("waiting");
    expect(by.get(b)).toBe("running");
    expect(by.get(c)).toBeNull();
    const gr = (await groups("")).groups.flatMap((x) => x.conversations);
    expect(gr.find((x) => x.id === a)?.activity).toBe("waiting");
    expect(gr.find((x) => x.id === c)?.activity).toBeNull();
  });

  it("a run waiting on its sub-agents reports running, not waiting", async () => {
    const a = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, a, "echo:hi");
    await waitFor(async () => (await runsOf(db, a)).every((r) => r.status === "completed"));
    // the shape Waits.suspend writes for a `subagents` wait: status waiting + wait_expires_at
    await sql`UPDATE capybara.runs SET status = 'waiting', wait_expires_at = now() + interval '1 hour'
      WHERE conversation_id = ${a}`.execute(raw);
    const by = new Map((await list("")).conversations.map((x) => [x.id, x.activity]));
    expect(by.get(a)).toBe("running");
    expect((await list("?state=waiting")).conversations).toEqual([]);
    expect((await list("?state=running")).conversations.map((c) => c.id)).toEqual([a]);
    expect((await groups("?state=waiting")).groups).toEqual([]);
  });

  it("archivedCount counts archived conversations", async () => {
    const a = await createConv(owner, orgId, agentId);
    const b = await createConv(owner, orgId, agentId);
    const c = await createConv(owner, orgId, agentId);
    await rename(a, "alpha");
    await owner({ method: "PATCH", url: `${base()}/${a}`, payload: { archived: true } });
    await owner({ method: "PATCH", url: `${base()}/${b}`, payload: { archived: true } });
    await owner({ method: "PATCH", url: `${base()}/${c}`, payload: { archived: true } });
    await owner({ method: "DELETE", url: `${base()}/${c}` });
    // ignores q and state
    expect((await groups("?q=zzz&state=waiting")).archivedCount).toBe(2);
    expect((await groups("")).archivedCount).toBe(2);
    const arch = await list("?archived=1");
    expect(arch.conversations.map((x) => x.id).sort()).toEqual([a, b].sort());
    expect(
      (await groups("?archived=1")).groups.flatMap((x) => x.conversations.map((y) => y.id)).sort(),
    ).toEqual([a, b].sort());
    expect((await list("?archived=1&q=alpha")).conversations.map((x) => x.id)).toEqual([a]);
  });

  it("q longer than 100 is 400", async () => {
    const r = await owner({ method: "GET", url: `${base()}?q=${"a".repeat(101)}` });
    expect(r.statusCode).toBe(400);
    const g = await owner({ method: "GET", url: `${base()}/groups?q=${"a".repeat(101)}` });
    expect(g.statusCode).toBe(400);
  });
});
