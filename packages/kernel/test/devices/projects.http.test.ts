import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SANDBOX_ROOTS,
  type KernelReq,
  type LegacyDeviceHello,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DeviceAccess } from "../../src/devices/access.js";
import {
  DeviceProjectsService,
  MAX_DEVICE_PROJECTS,
} from "../../src/devices/device-projects.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { PermissionCeilingWrites } from "../../src/sandbox/permission-ceiling-writes.js";
import { PermissionFacts } from "../../src/sandbox/permission-facts.js";
import { SandboxProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
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
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, ownerReportFor } from "../local-devices/fake-machine-v3.js";
import type { Answer } from "../local-devices/test-holder.js";

/**
 * A device's projects (project root design §4.1, §4.2): `device_projects` written only by the
 * kernel, owner-only routes, every project scoped by the device's current mode, the device asked
 * with `list` / `scan` (a fake machine on a real WebSocket; a cloud device on the fake sandbox,
 * which has neither, offers none).
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);

const HOME = "/home/me";
const ROOTS = {
  workspace: "/home/me/.capybara/dev/workspace",
  skills: "/home/me/.capybara/dev/skills",
  tmp: "/home/me/.capybara/dev/tmp",
};
const FEATURES = ["networkReport", "policyOp", "policyOpId", "mode", "projects"] as const;
const AUTO: Partial<LegacyDeviceHello> = {
  roots: ROOTS,
  home: HOME,
  features: [...FEATURES],
  policy: { mode: "auto", allowedDomains: [] },
};

/** Directories the fake machine has; a path ending in `.txt` is a file. */
const DIRS = new Set([
  HOME,
  `${HOME}/src`,
  `${HOME}/src/capybara`,
  ROOTS.workspace,
  `${ROOTS.workspace}/app`,
]);

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let sandboxRoot: string;
let machines: MachinesService;
let devices: DevicesService;
let projects: DeviceProjectsService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-projects-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [SANDBOX_FAKE],
        // limits fixed at the file system: a narrowed cloud device can await a files reset
        extensionConfig: { "sandbox-fake": { root: sandboxRoot, limitsApplyAt: "fileSystem" } },
        devices: { local: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
  );
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  projects = k.app.get(DeviceProjectsService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const base = (deviceId: string, org: string = orgId) =>
  `/api/v1/orgs/${org}/devices/${deviceId}/projects`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A new member with a session, a local device and a signed-in machine (not connected). */
async function owned() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Name ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const d = await txHost.run(async () => {
    const { id: deviceId } = await devices.createLocal(orgId, accountId, "Box");
    const issued = await machines.issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
  return { accountId, login, req: await session(k, login), ...d };
}

/** A machine with the directories of {@link DIRS} answering `create`, `list` and `scan`. */
function answering(
  scan: { path: string; suggestedName: string }[] = [],
  opts: { holdList?: boolean } = {},
) {
  return (req: KernelReq): Answer => {
    const a = req.args as { path?: string };
    const p = a.path as string;
    // protocol 3: the owner's project browsing comes as `browseStat` / `browseList` / `browseScan`
    const op = String(req.op).replace(/^browse(\w)/, (_, c: string) => c.toLowerCase());
    switch (op) {
      case "create":
        return { ok: true, result: { roots: ROOTS } };
      case "list":
        // the test answers itself (two adds held at the device at once)
        if (opts.holdList === true) return undefined;
        return listAnswer(p);
      case "stat":
        if (p.endsWith("/flaky")) return { ok: false, error: { kind: "error", message: "EIO" } };
        if (p.endsWith(".txt")) return { ok: true, result: { size: 3, isDir: false } };
        if (p.endsWith("/secret") || DIRS.has(p))
          return { ok: true, result: { size: 0, isDir: true } };
        return { ok: true, result: null };
      case "scan":
        return { ok: true, result: scan };
      default:
        return { ok: true, result: null };
    }
  };
}

/** What the fake machine's `list` answers for `p`. */
function listAnswer(p: string): NonNullable<Answer> {
  // a file, an unreadable directory, a failing disk: one error kind on the wire
  if (p.endsWith(".txt") || p.endsWith("/secret") || p.endsWith("/flaky")) {
    return { ok: false, error: { kind: "error", message: "cannot list" } };
  }
  if (p.endsWith("/locked")) {
    return { ok: false, error: { kind: "policy", message: "outside the sandbox" } };
  }
  if (!DIRS.has(p)) return { ok: true, result: null };
  return { ok: true, result: { entries: [], truncated: false } };
}

/** Connects the machine with `hello` and waits until its lease and hello are recorded. */
async function connect(
  d: { deviceId: string; machineId: string; credential: string },
  hello: Partial<LegacyDeviceHello> = AUTO,
  answer: (req: KernelReq) => Answer = answering(),
) {
  const machine = new FakeMachine(url, d.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  // an auto-mode machine reports the owner's OS user as its project reach and a Full ceiling
  const auto = hello.policy?.mode === "auto";
  machine.hello({
    ownerCeiling: ownerReportFor(
      { allowedDomains: hello.policy?.allowedDomains ?? [] },
      { fullAccess: auto, restrictedProjectReach: auto ? "os-user" : "workspace" },
    ),
    ...hello,
  });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", d.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return machine;
}

const add = (req: Req, deviceId: string, payload: Record<string, unknown>) =>
  req({ method: "POST", url: base(deviceId), payload });
const listOf = async (req: Req, deviceId: string) => {
  const res = await req({ method: "GET", url: base(deviceId) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as {
    projects: { name: string; path: string }[];
    hidden: number;
    mode: string;
    base: string | null;
    supported: boolean;
  };
};
/** The machine's requests of one native op, its protocol 3 browse form included. */
const reqsOf = (m: FakeMachine, op: string) =>
  m.frames.filter(
    (f): f is KernelReq =>
      f.type === "req" &&
      (f.op === op || String(f.op) === `browse${op.charAt(0).toUpperCase()}${op.slice(1)}`),
  );
const storedOf = (deviceId: string) =>
  db
    .selectFrom("device_projects")
    .select(["name", "path", "created_by"])
    .where("device_id", "=", deviceId)
    .orderBy("name")
    .execute();

/**
 * Sets the machine's reported mode in PG (what a hello or a `policy` op records): its summary and
 * the owner report's project reach and Full ceiling (auto: the owner's OS user, sandbox: the
 * workspace).
 */
const setLocalMode = (machineId: string, mode: "auto" | "sandbox") =>
  sql`UPDATE capybara.device_machines
    SET local_policy = ${JSON.stringify({ mode, allowedDomains: [] })}::jsonb,
      owner_report = jsonb_set(jsonb_set(owner_report, '{report,restrictedProjectReach}',
        ${JSON.stringify(mode === "auto" ? "os-user" : "workspace")}::jsonb),
        '{report,fullAccess}', ${JSON.stringify(mode === "auto")}::jsonb)
    WHERE id = ${machineId}`.execute(raw);

/**
 * The owner browse scope a protocol 3 machine is asked under: the owner's OS user in auto mode,
 * the workspace in sandbox mode (the machine intersects it with its own owner ceiling again).
 */
const browsed = (deviceId: string, mode: "auto" | "sandbox") =>
  expect.objectContaining({
    deviceId,
    readRoots: mode === "auto" ? ["/"] : [ROOTS.workspace],
  });

describe("device projects", () => {
  it("adds a readable directory in auto mode: relative to the home, stored absolute, named by its basename", async () => {
    const d = await owned();
    const machine = await connect(d);
    const res = await add(d.req, d.deviceId, { path: "src/capybara/" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({
      project: { name: "capybara", path: `${HOME}/src/capybara`, createdAt: expect.any(String) },
    });
    // the device was asked in the current mode, for one entry
    expect(reqsOf(machine, "list").map((r) => r.args)).toEqual([
      { path: `${HOME}/src/capybara`, limit: 1, scope: browsed(d.deviceId, "auto") },
    ]);
    expect(await storedOf(d.deviceId)).toEqual([
      { name: "capybara", path: `${HOME}/src/capybara`, created_by: d.accountId },
    ]);
    // an explicit name, and the home itself
    const named = await add(d.req, d.deviceId, { path: "", name: "home dir" });
    expect(named.statusCode, named.body).toBe(201);
    expect((named.json() as { project: { path: string } }).project.path).toBe(HOME);
    const l = await listOf(d.req, d.deviceId);
    expect(l).toMatchObject({ mode: "auto", base: HOME, supported: true, hidden: 0 });
    expect(l.projects.map((p) => [p.name, p.path])).toEqual([
      ["capybara", `${HOME}/src/capybara`],
      ["home dir", HOME],
    ]);
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "actor_account_id", "detail"])
      .where("target", "=", d.deviceId)
      .where("action", "=", "device.project_added")
      .execute();
    expect(audits).toHaveLength(2);
    expect(audits[0]?.actor_account_id).toBe(d.accountId);
  });

  it("refuses a duplicate, a missing path, a file and an invalid name; nothing is stored", async () => {
    const d = await owned();
    const machine = await connect(d);
    expect((await add(d.req, d.deviceId, { path: "src" })).statusCode).toBe(201);

    const dup = await add(d.req, d.deviceId, { path: "src/capybara", name: "src" });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(errCode(dup)).toBe("device.project_name_taken");

    const missing = await add(d.req, d.deviceId, { path: "nope" });
    expect(missing.statusCode, missing.body).toBe(422);
    expect(errCode(missing)).toBe("device.project_path_missing");

    const file = await add(d.req, d.deviceId, { path: "notes.txt" });
    expect(file.statusCode, file.body).toBe(422);
    expect(errCode(file)).toBe("device.project_path_unreadable");

    for (const name of ["a/b", "x".repeat(65), " lead", ".."]) {
      const bad = await add(d.req, d.deviceId, { path: "src/capybara", name });
      expect(bad.statusCode, `${name}: ${bad.body}`).toBe(400);
    }
    const absolute = await add(d.req, d.deviceId, { path: "/etc" });
    expect(absolute.statusCode, absolute.body).toBe(400);

    expect((await storedOf(d.deviceId)).map((r) => r.name)).toEqual(["src"]);
    // the name checks run before the device is asked: only the three real attempts reached it
    expect(reqsOf(machine, "list")).toHaveLength(3);
  });

  it("refuses the 101st project", async () => {
    const d = await owned();
    await connect(d);
    await db
      .insertInto("device_projects")
      .values(
        Array.from({ length: MAX_DEVICE_PROJECTS }, (_, i) => ({
          device_id: d.deviceId,
          name: `p${i}`,
          path: `${HOME}/p${i}`,
          created_by: d.accountId,
        })),
      )
      .execute();
    const res = await add(d.req, d.deviceId, { path: "src" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.project_limit_reached");
  });

  it("sandbox mode offers the workspace only: outside it is refused, an auto-mode project is hidden, not deleted", async () => {
    const d = await owned();
    const machine = await connect(d);
    expect((await add(d.req, d.deviceId, { path: "src/capybara" })).statusCode).toBe(201);

    await setLocalMode(d.machineId, "sandbox");
    const l = await listOf(d.req, d.deviceId);
    expect(l).toMatchObject({ mode: "sandbox", base: ROOTS.workspace, projects: [], hidden: 1 });
    expect(await storedOf(d.deviceId)).toHaveLength(1);

    const outside = await add(d.req, d.deviceId, { path: "../../../src" });
    expect(outside.statusCode, outside.body).toBe(422);
    expect(errCode(outside)).toBe("device.project_outside_mode");

    const inside = await add(d.req, d.deviceId, { path: "app" });
    expect(inside.statusCode, inside.body).toBe(201);
    expect((inside.json() as { project: { path: string } }).project.path).toBe(
      `${ROOTS.workspace}/app`,
    );
    expect(reqsOf(machine, "list").at(-1)?.args).toEqual({
      path: `${ROOTS.workspace}/app`,
      limit: 1,
      scope: browsed(d.deviceId, "sandbox"),
    });

    // binding follows the same scope
    await expect(
      projects.resolveForBinding(orgId, d.deviceId, d.accountId, "capybara"),
    ).rejects.toMatchObject({ code: "device.project_outside_mode" });
    expect(await projects.resolveForBinding(orgId, d.deviceId, d.accountId, "app")).toEqual({
      name: "app",
      path: `${ROOTS.workspace}/app`,
    });

    // back in auto mode, the hidden project is offered again
    await setLocalMode(d.machineId, "auto");
    expect((await listOf(d.req, d.deviceId)).projects.map((p) => p.name)).toEqual([
      "app",
      "capybara",
    ]);
  });

  it("candidates: one scan of the base in the current mode, checked again by the kernel", async () => {
    const d = await owned();
    const machine = await connect(
      d,
      AUTO,
      answering([
        { path: HOME, suggestedName: "me" },
        { path: `${HOME}/src/capybara`, suggestedName: "capybara" },
        { path: "/etc/other", suggestedName: "other" },
      ]),
    );
    const res = await d.req({ method: "GET", url: `${base(d.deviceId)}/candidates` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      mode: "auto",
      base: HOME,
      supported: true,
      candidates: [
        { path: HOME, relativePath: "", suggestedName: "me" },
        { path: `${HOME}/src/capybara`, relativePath: "src/capybara", suggestedName: "capybara" },
      ],
    });
    expect(reqsOf(machine, "scan").map((r) => r.args)).toEqual([
      { base: HOME, scope: browsed(d.deviceId, "auto") },
    ]);

    await setLocalMode(d.machineId, "sandbox");
    const sandboxed = await d.req({ method: "GET", url: `${base(d.deviceId)}/candidates` });
    expect(sandboxed.statusCode, sandboxed.body).toBe(200);
    expect(reqsOf(machine, "scan").at(-1)?.args).toEqual({
      base: ROOTS.workspace,
      scope: browsed(d.deviceId, "sandbox"),
    });
    // in sandbox mode the kernel drops what lies outside the workspace, whatever the device says
    expect((sandboxed.json() as { candidates: unknown[] }).candidates).toEqual([]);
  });

  it("refuses a root above the owner's home, without using the device; the home itself is fine", async () => {
    const d = await owned();
    const machine = await connect(d);
    const uses = vi.spyOn(k.app.get(SandboxService), "withSandbox");
    // `/home` (and `/Users`) whatever the home and in any case (a case-insensitive volume), `/`,
    // and every ancestor of the reported home
    try {
      for (const path of ["..", "../..", "../../Users", "../../users", "../../HOME"]) {
        const res = await add(d.req, d.deviceId, { path, name: "wide" });
        expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
        expect(errCode(res)).toBe("device.project_path_too_broad");
      }
      // refused before the device is leased (a cloud device is never started for it)
      expect(uses).not.toHaveBeenCalled();
    } finally {
      uses.mockRestore();
    }
    expect(reqsOf(machine, "list")).toEqual([]);
    expect(await storedOf(d.deviceId)).toEqual([]);
    expect((await add(d.req, d.deviceId, { path: "", name: "me" })).statusCode).toBe(201);
  });

  it("refuses every ancestor of a home outside /home and /Users", async () => {
    const d = await owned();
    const machine = await connect(d, { ...AUTO, home: "/var/lib/svc" });
    const res = await add(d.req, d.deviceId, { path: "..", name: "lib" });
    expect(res.statusCode, res.body).toBe(422);
    expect(errCode(res)).toBe("device.project_path_too_broad");
    expect((res.json() as { error: { message: string } }).error.message).toContain("/var/lib");
    expect(reqsOf(machine, "list")).toEqual([]);
  });

  it("auto mode without a reported home refuses a relative path", async () => {
    const d = await owned();
    const { home: _home, ...noHome } = AUTO;
    const machine = await connect(d, noHome);
    const l = await listOf(d.req, d.deviceId);
    expect(l).toMatchObject({ mode: "auto", base: null });
    const res = await add(d.req, d.deviceId, { path: "src" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.project_home_unknown");
    expect(reqsOf(machine, "list")).toEqual([]);
  });

  it("only the owner reads or changes them; remove is idempotent", async () => {
    const d = await owned();
    await connect(d);
    expect((await add(d.req, d.deviceId, { path: "src" })).statusCode).toBe(201);
    const other = await owned();
    for (const res of [
      await other.req({ method: "GET", url: base(d.deviceId) }),
      await other.req({ method: "GET", url: `${base(d.deviceId)}/candidates` }),
      await add(other.req, d.deviceId, { path: "src/capybara" }),
      await other.req({ method: "DELETE", url: `${base(d.deviceId)}/src` }),
    ]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    await expect(
      projects.resolveForBinding(orgId, d.deviceId, other.accountId, "src"),
    ).rejects.toMatchObject({ code: "device.not_found" });
    expect(await storedOf(d.deviceId)).toHaveLength(1);
    expect((await k.http.inject({ method: "GET", url: base(d.deviceId) })).statusCode).toBe(401);

    const removed = await d.req({ method: "DELETE", url: `${base(d.deviceId)}/src` });
    expect(removed.statusCode, removed.body).toBe(204);
    const again = await d.req({ method: "DELETE", url: `${base(d.deviceId)}/src` });
    expect(again.statusCode, again.body).toBe(204);
    expect(await storedOf(d.deviceId)).toEqual([]);
    const audits = await db
      .selectFrom("audit_events")
      .select("action")
      .where("target", "=", d.deviceId)
      .where("action", "=", "device.project_removed")
      .execute();
    expect(audits).toHaveLength(1);
    const unknown = projects.resolveForBinding(orgId, d.deviceId, d.accountId, "src");
    await expect(unknown).rejects.toBeInstanceOf(ApiError);
    await expect(unknown).rejects.toMatchObject({ code: "device.project_not_found" });
  });

  it("a machine without the projects feature offers none and refuses add, never asking it", async () => {
    const d = await owned();
    const machine = await connect(d, { ...AUTO, features: ["networkReport", "policyOp", "mode"] });
    await db
      .insertInto("device_projects")
      .values({ device_id: d.deviceId, name: "old", path: `${HOME}/old`, created_by: d.accountId })
      .execute();
    const l = await listOf(d.req, d.deviceId);
    expect(l).toMatchObject({ supported: false, projects: [] });
    const res = await add(d.req, d.deviceId, { path: "src" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.projects_unsupported");
    const cand = await d.req({ method: "GET", url: `${base(d.deviceId)}/candidates` });
    expect(cand.statusCode, cand.body).toBe(200);
    expect(cand.json()).toMatchObject({ supported: false, candidates: [] });
    expect(reqsOf(machine, "list")).toEqual([]);
    expect(reqsOf(machine, "scan")).toEqual([]);
  });

  it("an offline machine is a readable refusal, never a 500", async () => {
    const d = await owned();
    const machine = await connect(d);
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    const res = await add(d.req, d.deviceId, { path: "src" });
    expect(res.statusCode, res.body).toBe(503);
    expect(errCode(res)).toBe("device.offline");
    const cand = await d.req({ method: "GET", url: `${base(d.deviceId)}/candidates` });
    expect(cand.statusCode, cand.body).toBe(503);
    expect(errCode(cand)).toBe("device.offline");
    expect(await storedOf(d.deviceId)).toEqual([]);
  });

  it("a cloud device whose provider has no list / scan offers none", async () => {
    const d = await owned();
    const created = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices`,
      payload: { name: "Cloud" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { device: { id: string } }).device.id;
    const l = await listOf(d.req, id);
    expect(l).toMatchObject({ supported: false, projects: [], base: "/workspace" });
    const res = await add(d.req, id, { path: "app" });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.projects_unsupported");
  });

  it("tells a path the device refuses from a device that cannot be asked", async () => {
    const d = await owned();
    const machine = await connect(d);
    // a directory the device cannot list: its error, then stat says it is a directory
    const secret = await add(d.req, d.deviceId, { path: "secret" });
    expect(secret.statusCode, secret.body).toBe(422);
    expect(errCode(secret)).toBe("device.project_path_unreadable");
    // the machine's policy refusal is the device refusing the path in its mode
    const locked = await add(d.req, d.deviceId, { path: "locked" });
    expect(locked.statusCode, locked.body).toBe(422);
    expect(errCode(locked)).toBe("device.project_outside_mode");
    // an error on the machine that stat cannot explain either: the device could not be asked
    const flaky = await add(d.req, d.deviceId, { path: "flaky" });
    expect(flaky.statusCode, flaky.body).toBe(503);
    expect(errCode(flaky)).toBe("device.projects_unavailable");
    expect(reqsOf(machine, "stat").map((r) => (r.args as { path: string }).path)).toEqual([
      `${HOME}/secret`,
      `${HOME}/flaky`,
    ]);
    expect(await storedOf(d.deviceId)).toEqual([]);
  });

  it("two concurrent adds of one name: exactly one is stored, the other is name_taken", async () => {
    const d = await owned();
    const machine = await connect(d, AUTO, answering([], { holdList: true }));
    const both = Promise.allSettled([
      projects.add(orgId, d.accountId, d.deviceId, { path: "src", name: "same" }),
      projects.add(orgId, d.accountId, d.deviceId, { path: "src/capybara", name: "same" }),
    ]);
    // both passed the precheck and wait at the device: only the insert can decide now
    await waitFor(async () => reqsOf(machine, "list").length === 2, 10_000, "two lists held");
    for (const r of reqsOf(machine, "list")) {
      machine.respond(r.id, listAnswer((r.args as { path: string }).path));
    }
    const out = await both;
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = out.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed.map((r) => (r.reason as ApiError).code)).toEqual(["device.project_name_taken"]);
    expect((await storedOf(d.deviceId)).map((r) => r.name)).toEqual(["same"]);
  });

  it("two concurrent adds at 99 projects: exactly one is stored, the other is limit_reached", async () => {
    const d = await owned();
    const machine = await connect(d, AUTO, answering([], { holdList: true }));
    await db
      .insertInto("device_projects")
      .values(
        Array.from({ length: MAX_DEVICE_PROJECTS - 1 }, (_, i) => ({
          device_id: d.deviceId,
          name: `p${i}`,
          path: `${HOME}/p${i}`,
          created_by: d.accountId,
        })),
      )
      .execute();
    const both = Promise.allSettled([
      projects.add(orgId, d.accountId, d.deviceId, { path: "src", name: "one" }),
      projects.add(orgId, d.accountId, d.deviceId, { path: "src/capybara", name: "two" }),
    ]);
    await waitFor(async () => reqsOf(machine, "list").length === 2, 10_000, "two lists held");
    for (const r of reqsOf(machine, "list")) {
      machine.respond(r.id, listAnswer((r.args as { path: string }).path));
    }
    const out = await both;
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = out.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(failed.map((r) => (r.reason as ApiError).code)).toEqual([
      "device.project_limit_reached",
    ]);
    expect(await storedOf(d.deviceId)).toHaveLength(MAX_DEVICE_PROJECTS);
  });

  it("an org owner or admin gets device.not_found on someone else's device, on all four routes", async () => {
    const d = await owned();
    await connect(d);
    expect((await add(d.req, d.deviceId, { path: "src" })).statusCode).toBe(201);
    const adminLogin = `a-${randomUUID().slice(0, 8)}`;
    const adminId = (
      await accountsFor(db).createLocal({ login: adminLogin, password: PW, displayName: "A" })
    ).id;
    await testMembers(db).add(orgId, adminId, "admin", ownerId);
    for (const req of [await session(k, "owner"), await session(k, adminLogin)]) {
      for (const res of [
        await req({ method: "GET", url: base(d.deviceId) }),
        await req({ method: "GET", url: `${base(d.deviceId)}/candidates` }),
        await add(req, d.deviceId, { path: "src/capybara" }),
        await req({ method: "DELETE", url: `${base(d.deviceId)}/src` }),
      ]) {
        expect(res.statusCode, res.body).toBe(404);
        expect(errCode(res)).toBe("device.not_found");
      }
    }
    await expect(
      projects.resolveForBinding(orgId, d.deviceId, ownerId, "src"),
    ).rejects.toMatchObject({ code: "device.not_found" });
    expect((await storedOf(d.deviceId)).map((r) => r.name)).toEqual(["src"]);
  });

  it("the device's own owner cannot reach it from another org", async () => {
    const d = await owned();
    await connect(d);
    expect((await add(d.req, d.deviceId, { path: "src" })).statusCode).toBe(201);
    const otherOrg = await createOrg(d.req, `Other ${randomUUID().slice(0, 6)}`);
    for (const res of [
      await d.req({ method: "GET", url: base(d.deviceId, otherOrg) }),
      await d.req({ method: "GET", url: `${base(d.deviceId, otherOrg)}/candidates` }),
      await d.req({
        method: "POST",
        url: base(d.deviceId, otherOrg),
        payload: { path: "src/capybara" },
      }),
      await d.req({ method: "DELETE", url: `${base(d.deviceId, otherOrg)}/src` }),
    ]) {
      expect(res.statusCode, res.body).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    await expect(
      projects.resolveForBinding(otherOrg, d.deviceId, d.accountId, "src"),
    ).rejects.toMatchObject({ code: "device.not_found" });
    expect((await storedOf(d.deviceId)).map((r) => r.name)).toEqual(["src"]);
  });

  it("a cloud device is scoped to its workspace at its effective mode, not a wider one", async () => {
    const d = await owned();
    const created = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices`,
      payload: { name: `Cloud ${randomUUID().slice(0, 6)}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { device: { id: string } }).device.id;
    const workspace = DEFAULT_SANDBOX_ROOTS.workspace;
    const seen: { op: string; path: string }[] = [];
    // the owner browse the activated route opens (its scope is SandboxService.withBrowse's: the
    // effective policy's, never the instance's wider applied mode), on a stand-in provider
    const browse = {
      stat: async () => ({ size: 0, isDir: true }),
      list: async (path: string) => {
        seen.push({ op: "list", path });
        return { entries: [], truncated: false };
      },
      scan: async (path: string) => {
        seen.push({ op: "scan", path });
        return [{ path: `${workspace}/app`, suggestedName: "app" }];
      },
    };
    // a provider that can list and scan offers projects (the calls go through `browse` above)
    const impl = { list: browse.list, scan: browse.scan } as unknown as SandboxProvider;
    const real = k.app.get(SandboxProviders);
    const service = new DeviceProjectsService(
      k.app.get(KernelDb),
      txHost,
      {
        withBrowse: (_ctx, fn, signal) => fn(browse as never, signal),
        ensureRunningForOwner: async () => {},
        withSandbox: () => Promise.reject(new Error("no raw route once activated")),
      },
      k.app.get(DeviceAccess),
      new PermissionFacts(
        k.app.get(KernelDb),
        k.app.get(KernelConfigService),
        {
          cloud: () => ({ plugin: real.cloud()?.plugin as string, impl }),
          forName: () => ({ plugin: real.cloud()?.plugin as string, impl }),
        },
        k.app.get(DeviceAccess),
      ),
      k.app.get(PermissionCeilingWrites),
    );
    // its files were made in auto mode with the open network, then the device was narrowed to
    // sandbox mode: the provider fixes limits at its file system, so a files reset is pending and
    // the instance's applied mode (what modeLevel reports for the model) is still auto
    await db
      .insertInto("device_instances")
      .values({
        device_id: id,
        org_id: orgId,
        provider: real.cloud()?.plugin as string,
        fs_handle: JSON.stringify({ id: `fs-${id}` }),
        fs_status: "ready",
        instance_limits: JSON.stringify({
          mode: "auto",
          network: { kind: "open-public", hosts: [] },
        }),
      })
      .execute();
    await db.updateTable("devices").set({ mode: "sandbox" }).where("id", "=", id).execute();
    expect((await devices.modeLevel(orgId, id))?.mode).toBe("auto");
    // the ceiling and the scope follow the effective policy: sandbox
    expect(await service.add(orgId, d.accountId, id, { path: "app" })).toMatchObject({
      path: `${workspace}/app`,
    });
    expect((await service.candidates(orgId, d.accountId, id)).candidates).toHaveLength(1);
    expect(seen).toEqual([
      { op: "list", path: `${workspace}/app` },
      { op: "scan", path: workspace },
    ]);
    // auto mode (the platform allows it) widens the ceiling, never the scope: still the workspace
    await db.updateTable("devices").set({ mode: null }).where("id", "=", id).execute();
    const outside = service.add(orgId, d.accountId, id, { path: "../etc" });
    await expect(outside).rejects.toMatchObject({ code: "device.project_outside_mode" });
    expect(await service.add(orgId, d.accountId, id, { path: "", name: "ws" })).toMatchObject({
      path: workspace,
    });
    expect(seen.at(-1)).toEqual({ op: "list", path: workspace });
    expect((await service.list(orgId, d.accountId, id)).projects.map((p) => p.name)).toEqual([
      "app",
      "ws",
    ]);
  });
});
