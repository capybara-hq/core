import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { NetworkBlockedHost, SandboxLimits } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { grantsWithin, NetworkGrants, relayer } from "../../src/local-devices/network-grants.js";
import { createLogger } from "../../src/log.js";
import { databaseHandles } from "../helpers/database.js";

/**
 * Run grants (network ask-to-allow spec §6.3, §6.8, P-D3): the hosts of a run tree's once-approved
 * network asks reach every exec of the tree, never another tree or org; and the kernel's own
 * layer for a device's report (§4.1 item 3).
 */

let pg: TestContainer;
let raw: ReturnType<typeof createDb>;
let grants: NetworkGrants;

beforeAll(async () => {
  pg = await startTestPostgres();
  await migrate(pg.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pg.url, 3);
  grants = new NetworkGrants(databaseHandles(raw, createLogger("error")).db);
  await sql`insert into capybara.accounts (id, display_name)
    values ('owner', 'Owner'), ('other', 'Other')`.execute(raw);
  await sql`insert into capybara.orgs (id, slug, name)
    values ('o1', 'o1', 'O1'), ('o2', 'o2', 'O2')`.execute(raw);
  await sql`insert into capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    values ('ag1', 'o1', 'owner', 'org', 1), ('ag2', 'o2', 'owner', 'org', 1)`.execute(raw);
});

afterAll(async () => {
  await raw?.destroy();
  await pg?.stop();
});

/** A conversation in `org` and a run in it (`budgetRunId`: the tree's root run). */
async function run(org = "o1", budgetRunId: string | null = null): Promise<string> {
  const conv = randomUUID();
  const id = randomUUID();
  await sql`insert into capybara.conversations (id, org_id, agent_id, account_id)
    values (${conv}, ${org}, ${org === "o1" ? "ag1" : "ag2"}, 'owner')`.execute(raw);
  await sql`insert into capybara.runs (id, conversation_id, status, agent_version,
      trigger_account_id, trigger_seq, budget_run_id)
    values (${id}, ${conv}, 'running', 1, 'owner', 1, ${budgetRunId})`.execute(raw);
  return id;
}

let attempt = 0;
/** A network ask of `runId` about `hosts`, in `status`, with what its decision granted. */
async function ask(
  runId: string,
  hosts: string[],
  opts: {
    status?: string;
    scope?: "once" | "always" | null;
    granted?: string[];
    org?: string;
    decidedBy?: string | null;
    decidedAt?: string;
    deviceId?: string;
  } = {},
): Promise<void> {
  const status = opts.status ?? "approved";
  const decided = status !== "pending";
  const detail = {
    deviceId: opts.deviceId ?? "d1",
    hosts: hosts.map((host) => ({ host, port: 443 })),
    command: "curl",
    description: null,
    result: { content: "", isError: false },
    ...(opts.granted !== undefined && { grantedHosts: opts.granted }),
  };
  const conv = await sql<{ conversation_id: string }>`select conversation_id from capybara.runs
    where id = ${runId}`.execute(raw);
  await sql`insert into capybara.approvals (id, org_id, conversation_id, run_id, call_id, tool_key,
      requested_for, status, scope, decided_by, decided_at, expires_at, spec_hash, attempt, kind,
      detail)
    values (${randomUUID()}, ${opts.org ?? "o1"}, ${conv.rows[0]?.conversation_id}, ${runId},
      'call', 'Bash', 'owner', ${status},
      ${status === "approved" ? (opts.scope === undefined ? "once" : opts.scope) : null},
      ${decided ? (opts.decidedBy === undefined ? "owner" : opts.decidedBy) : null},
      ${decided ? (opts.decidedAt ?? new Date().toISOString()) : null},
      now() + interval '1 day', 'network', ${++attempt}, 'network', ${JSON.stringify(detail)})`.execute(
    raw,
  );
}

describe("NetworkGrants.forExec", () => {
  it("returns the run tree's once-approved hosts; a sub-agent's run sees the root's grant", async () => {
    const root = await run();
    const child = await run("o1", root);
    await ask(root, ["files.slack.com"], {
      granted: ["files.slack.com"],
      decidedAt: "2026-11-12T01:00:00Z",
    });
    await ask(child, ["api.github.com", "evil.example.net"], {
      granted: ["api.github.com"],
      decidedBy: "other",
      decidedAt: "2026-11-12T02:00:00Z",
    });
    const forRoot = await grants.forExec({ orgId: "o1", runId: root, deviceId: "d1" });
    const forChild = await grants.forExec({ orgId: "o1", runId: child, deviceId: "d1" });
    for (const g of [forRoot, forChild]) {
      expect(g?.source).toEqual({ kind: "run", id: root, accountId: "other" });
      expect([...(g?.hosts ?? [])].sort()).toEqual(["api.github.com", "files.slack.com"]);
    }
  });

  it("another run tree, another org, pending, denied and always asks grant nothing", async () => {
    const root = await run();
    await ask(root, ["files.slack.com"], { granted: ["files.slack.com"] });
    // another tree of the same org
    const other = await run();
    expect(await grants.forExec({ orgId: "o1", runId: other, deviceId: "d1" })).toBeUndefined();
    // the same run read for another org
    expect(await grants.forExec({ orgId: "o2", runId: root, deviceId: "d1" })).toBeUndefined();

    const r = await run();
    await ask(r, ["a.example.com"], { status: "pending" });
    await ask(r, ["b.example.com"], { status: "denied" });
    await ask(r, ["c.example.com"], { status: "expired" });
    // 「一直允许」 is on the device's own policy, not a run grant
    await ask(r, ["d.example.com"], { scope: "always", granted: ["d.example.com"] });
    // a decision that recorded no granted hosts grants nothing
    await ask(r, ["e.example.com"]);
    // a grant of another org written against this run is ignored
    await ask(r, ["f.example.com"], { org: "o2", granted: ["f.example.com"] });
    expect(await grants.forExec({ orgId: "o1", runId: r, deviceId: "d1" })).toBeUndefined();
  });

  it("drops wildcards and invalid hosts from a stored grant", async () => {
    const r = await run();
    await ask(r, ["ok.example.com"], {
      granted: ["*.example.com", "10.0.0.1", "localhost", "ok.example.com"],
    });
    expect((await grants.forExec({ orgId: "o1", runId: r, deviceId: "d1" }))?.hosts).toEqual([
      "ok.example.com",
    ]);
  });
});

describe("NetworkGrants.forExec scope", () => {
  it("grants only the device the ask was about", async () => {
    const r = await run();
    await ask(r, ["files.slack.com"], { granted: ["files.slack.com"], deviceId: "d2" });
    expect(await grants.forExec({ orgId: "o1", runId: r, deviceId: "d1" })).toBeUndefined();
    expect((await grants.forExec({ orgId: "o1", runId: r, deviceId: "d2" }))?.hosts).toEqual([
      "files.slack.com",
    ]);
  });

  it("a grant ends with its root run; a later run of the budget window does not inherit it", async () => {
    const root = await run();
    const child = await run("o1", root);
    await ask(root, ["files.slack.com"], { granted: ["files.slack.com"] });
    for (const status of ["queued", "waiting", "running"]) {
      await sql`update capybara.runs set status = ${status} where id = ${root}`.execute(raw);
      expect(await grants.forExec({ orgId: "o1", runId: child, deviceId: "d1" })).toBeDefined();
    }
    for (const status of ["completed", "failed", "aborted"]) {
      await sql`update capybara.runs set status = ${status} where id = ${root}`.execute(raw);
      // a wake run of the same window (child still running) gets nothing either
      expect(await grants.forExec({ orgId: "o1", runId: child, deviceId: "d1" })).toBeUndefined();
      expect(await grants.forExec({ orgId: "o1", runId: root, deviceId: "d1" })).toBeUndefined();
    }
  });
});

describe("NetworkGrants.runState", () => {
  it("with a device, counts only that device's grants and refusals; asks and pending count all", async () => {
    const r = await run();
    await ask(r, ["a.example.com"], { granted: ["a.example.com"], deviceId: "d1" });
    await ask(r, ["b.example.com"], { granted: ["b.example.com"], deviceId: "d2" });
    await ask(r, ["c.example.com"], { status: "denied", deviceId: "d2" });
    await ask(r, ["d.example.com"], { status: "pending", deviceId: "d2" });
    const s = await grants.runState(r, "d1");
    expect([...s.granted]).toEqual(["a.example.com"]);
    expect([...s.refused]).toEqual([]);
    expect(s.asks).toBe(4);
    expect(s.pending).toBe(true);
    // without a device: all of them
    const all = await grants.runState(r);
    expect([...all.granted].sort()).toEqual(["a.example.com", "b.example.com"]);
    expect([...all.refused]).toEqual(["c.example.com"]);
  });

  it("adds up the tree's grants, refusals and pending ask, and counts this run's asks", async () => {
    const root = await run();
    const child = await run("o1", root);
    // a partial decision: the unchecked host counts as denied
    await ask(root, ["a.example.com", "b.example.com"], { granted: ["a.example.com"] });
    await ask(root, ["c.example.com"], { status: "denied" });
    await ask(child, ["d.example.com"], { status: "expired" });
    await ask(child, ["e.example.com"], { status: "skipped" });
    await ask(child, ["f.example.com"], { status: "cancelled" });
    await ask(child, ["g.example.com"], { scope: "always", granted: ["g.example.com"] });

    const s = await grants.runState(child);
    expect([...s.granted]).toEqual(["a.example.com"]);
    expect([...s.refused].sort()).toEqual([
      "b.example.com",
      "c.example.com",
      "d.example.com",
      "e.example.com",
      "f.example.com",
    ]);
    expect(s.asks).toBe(4);
    expect(s.pending).toBe(false);
    expect((await grants.runState(root)).asks).toBe(2);

    await ask(root, ["h.example.com"], { status: "pending" });
    expect((await grants.runState(child)).pending).toBe(true);
    // another tree sees none of it
    expect(await grants.runState(await run())).toEqual({
      granted: new Set(),
      refused: new Set(),
      asks: 0,
      pending: false,
    });
  });
});

describe("relayer", () => {
  const blocked = (host: string, layer: NetworkBlockedHost["layer"]): NetworkBlockedHost => ({
    host,
    port: 443,
    layer,
  });
  const allowlist: Pick<SandboxLimits, "egress" | "allowHosts"> = {
    egress: "allowlist",
    allowHosts: ["example.com", "*.github.com"],
  };

  it.each([
    ["device, the org allows it", "example.com", "device", allowlist, "device"],
    ["device, a wildcard of the org covers it", "api.github.com", "device", allowlist, "device"],
    ["device, uppercase and a trailing dot", "API.GitHub.com.", "device", allowlist, "device"],
    ["device, the apex of a wildcard", "github.com", "device", allowlist, "org"],
    ["device, not in the org's list", "evil.example.net", "device", allowlist, "org"],
    ["device, egress none", "example.com", "device", { egress: "none", allowHosts: [] }, "org"],
    [
      "device, egress open",
      "evil.example.net",
      "device",
      { egress: "open", allowHosts: [] },
      "device",
    ],
    ["device, not a host name", "localhost", "device", allowlist, "address"],
    ["org stays org", "example.com", "org", allowlist, "org"],
    ["address stays address", "10.0.0.1", "address", allowlist, "address"],
    ["unknown stays unknown", "evil.example.net", "unknown", allowlist, "unknown"],
  ] as const)("%s", (_name, host, layer, limits, want) => {
    expect(relayer([blocked(host, layer)], limits as typeof allowlist)).toEqual([
      { ...blocked(host, layer), layer: want },
    ]);
  });
});

describe("grantsWithin", () => {
  const g = (hosts: string[]) => ({
    hosts,
    source: { kind: "run" as const, id: "r", accountId: "a" },
  });
  it("keeps only the hosts the org's limits admit", () => {
    const hosts = ["example.com", "api.github.com", "github.com", "evil.example.net"];
    expect(
      grantsWithin(g(hosts), { egress: "allowlist", allowHosts: ["example.com", "*.github.com"] }),
    ).toEqual(g(["example.com", "api.github.com"]));
    expect(grantsWithin(g(hosts), { egress: "open", allowHosts: [] })).toEqual(g(hosts));
    expect(grantsWithin(g(hosts), { egress: "none", allowHosts: [] })).toBeUndefined();
    expect(
      grantsWithin(g(["evil.example.net"]), { egress: "allowlist", allowHosts: ["example.com"] }),
    ).toBeUndefined();
    expect(grantsWithin(undefined, { egress: "open", allowHosts: [] })).toBeUndefined();
  });
});
