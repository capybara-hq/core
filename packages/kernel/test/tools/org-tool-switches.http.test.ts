import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff } from "../helpers/disabled-tools.js";

const PROBER_OFF = [
  ...builtinsOff(),
  { kind: "plugin" as const, plugin: "tools-probe", tools: ["second"] },
];

import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * Per-org tool switches (layering spec A §7): an org admin turns off one tool of an extension;
 * switching off is previewed with the org's agents that selected the tool (PCM §5 rule 8).
 */

const TOOLS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/tools-probe/index.ts", import.meta.url),
);
const KEY = "plugin__tools-probe__echo";
const OFF_REASON = `Tool ${KEY} is turned off in this organization`;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let member: Req;
let orgId: string;
let otherOrg: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const base = runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] });
  k = await startKernel({ ...base, extensions: [...base.extensions, TOOLS_PROBE] });
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  otherOrg = await createOrg(owner, "Other");
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  member = await session(k, "mem");
  for (const org of [orgId, otherOrg]) {
    const r = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${org}/extensions/tools-probe`,
      payload: { enabled: true },
    });
    expect(r.statusCode, r.body).toBe(200);
  }
});

const toolsUrl = (org = orgId) => `/api/v1/orgs/${org}/extensions/tools-probe/tools`;

async function createProber(org = orgId): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${org}/agents`,
    payload: {
      definition: {
        name: "Prober",
        instructions: "Probe.",
        model: { provider: "model-fake", model: "fake-1" },
        // only echo: every builtin and the extension's other tool off
        disabledTools: PROBER_OFF,
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

const put = (req: Req, tool: string, body: Record<string, unknown>, org = orgId) =>
  req({ method: "PUT", url: `${toolsUrl(org)}/${tool}`, payload: body });

const resolve = (org: string) =>
  k.app.get(ToolRegistry).forAgent(org, { disabledTools: PROBER_OFF });

describe("org tool switches over HTTP", () => {
  it("lists the extension's tools, on by default, for members too", async () => {
    const r = await member({ method: "GET", url: toolsUrl() });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      tools: [
        { tool: "echo", enabled: true },
        { tool: "second", enabled: true },
      ],
    });
  });

  it("switching off previews the agents that selected the tool, then applies with the hash", async () => {
    const agentId = await createProber();

    const preview = await put(owner, "echo", { enabled: false });
    expect(preview.statusCode, preview.body).toBe(200);
    const p = preview.json() as {
      applied: false;
      affectedAgents: { id: string; name: string }[];
      confirm: string;
    };
    expect(p.applied).toBe(false);
    expect(p.affectedAgents).toEqual([{ id: agentId, name: "Prober" }]);
    expect(p.confirm).toMatch(/^[0-9a-f]{64}$/);
    // nothing written by the preview
    expect((await resolve(orgId)).tools.map((t) => t.key)).toEqual([KEY]);

    const stale = await put(owner, "echo", { enabled: false, confirm: "0".repeat(64) });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((stale.json() as { error: { code: string } }).error.code).toBe("plugin.switch_stale");

    const applied = await put(owner, "echo", { enabled: false, confirm: p.confirm });
    expect(applied.statusCode, applied.body).toBe(200);
    expect(applied.json()).toEqual({ applied: true });

    const list = await member({ method: "GET", url: toolsUrl() });
    expect(list.json()).toEqual({
      tools: [
        { tool: "echo", enabled: false },
        { tool: "second", enabled: true },
      ],
    });

    // the agent editor's list keeps the tool and marks it
    const offer = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/tools/extensions` });
    expect(offer.statusCode, offer.body).toBe(200);
    const tools = (
      offer.json() as {
        extensions: { plugin: string; tools: { name: string; switchedOff: boolean }[] }[];
      }
    ).extensions.find((e) => e.plugin === "tools-probe")?.tools;
    expect(tools?.map((t) => [t.name, t.switchedOff])).toEqual([
      ["echo", true],
      ["second", false],
    ]);

    // at run time: unavailable in this org, still there in another
    const here = await resolve(orgId);
    expect(here.tools).toEqual([]);
    expect(here.unavailable).toEqual([]);
    expect(here.hidden).toEqual([{ ref: KEY, reason: OFF_REASON }]);
    expect((await resolve(otherOrg)).tools.map((t) => t.key)).toEqual([KEY]);

    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "target", "detail", "org_id"])
      .where("action", "=", "extension.tool_switched")
      .execute();
    expect(audits).toEqual([
      {
        action: "extension.tool_switched",
        target: KEY,
        org_id: orgId,
        detail: { plugin: "tools-probe", tool: "echo", from: true, to: false },
      },
    ]);

    // switching on applies at once
    const on = await put(owner, "echo", { enabled: true });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json()).toEqual({ applied: true });
    const back = await resolve(orgId);
    expect(back.tools.map((t) => t.key)).toEqual([KEY]);
    expect(back.unavailable).toEqual([]);
  });

  it("a switch-off with no agent selecting the tool still previews, with an empty list", async () => {
    await createProber(otherOrg);
    const preview = await put(owner, "second", { enabled: false });
    expect(preview.json()).toMatchObject({ applied: false, affectedAgents: [] });
  });

  it("members cannot switch; an unknown tool or extension is 404", async () => {
    const r = await put(member, "echo", { enabled: false });
    expect(r.statusCode, r.body).toBe(403);
    const getAsMember = await member({ method: "GET", url: toolsUrl() });
    expect(getAsMember.statusCode).toBe(200);

    const unknown = await put(owner, "nope", { enabled: false });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      "extension.tool_not_found",
    );
    const noExt = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/extensions/not-loaded/tools`,
    });
    expect(noExt.statusCode, noExt.body).toBe(404);
    const bad = await put(owner, "echo", { enabled: "no" });
    expect(bad.statusCode).toBe(400);
  });
});
