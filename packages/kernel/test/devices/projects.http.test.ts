import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeviceHello, KernelReq } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  DeviceProjectsService,
  MAX_DEVICE_PROJECTS,
} from "../../src/devices/device-projects.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
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
import { FakeMachine, HELLO } from "../local-devices/fake-machine.js";
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
const AUTO: Partial<DeviceHello> = {
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
        extensionConfig: { "sandbox-fake": { root: sandboxRoot } },
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

const base = (deviceId: string) => `/api/v1/orgs/${orgId}/devices/${deviceId}/projects`;
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
function answering(scan: { path: string; suggestedName: string }[] = []) {
  return (req: KernelReq): Answer => {
    const a = req.args as { path?: string };
    switch (req.op) {
      case "create":
        return { ok: true, result: { roots: ROOTS } };
      case "list": {
        const p = a.path as string;
        if (p.endsWith(".txt"))
          return { ok: false, error: { kind: "error", message: "not a directory" } };
        if (!DIRS.has(p)) return { ok: true, result: null };
        return { ok: true, result: { entries: [], truncated: false } };
      }
      case "scan":
        return { ok: true, result: scan };
      default:
        return { ok: true, result: null };
    }
  };
}

/** Connects the machine with `hello` and waits until its lease and hello are recorded. */
async function connect(
  d: { deviceId: string; machineId: string; credential: string },
  hello: Partial<DeviceHello> = AUTO,
  answer: (req: KernelReq) => Answer = answering(),
) {
  const machine = new FakeMachine(url, d.credential, answer, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, ...hello });
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
const reqsOf = (m: FakeMachine, op: string) =>
  m.frames.filter((f): f is KernelReq => f.type === "req" && f.op === op);
const storedOf = (deviceId: string) =>
  db
    .selectFrom("device_projects")
    .select(["name", "path", "created_by"])
    .where("device_id", "=", deviceId)
    .orderBy("name")
    .execute();

/** Sets the machine's reported mode in PG (what a hello or a `policy` op records). */
const setLocalMode = (machineId: string, mode: "auto" | "sandbox") =>
  db
    .updateTable("device_machines")
    .set({ local_policy: JSON.stringify({ mode, allowedDomains: [] }) })
    .where("id", "=", machineId)
    .execute();

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
      { path: `${HOME}/src/capybara`, limit: 1, limits: { mode: "auto" } },
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
      limits: { mode: "sandbox" },
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
      { base: HOME, limits: { mode: "auto" } },
    ]);

    await setLocalMode(d.machineId, "sandbox");
    const sandboxed = await d.req({ method: "GET", url: `${base(d.deviceId)}/candidates` });
    expect(sandboxed.statusCode, sandboxed.body).toBe(200);
    expect(reqsOf(machine, "scan").at(-1)?.args).toEqual({
      base: ROOTS.workspace,
      limits: { mode: "sandbox" },
    });
    // in sandbox mode the kernel drops what lies outside the workspace, whatever the device says
    expect((sandboxed.json() as { candidates: unknown[] }).candidates).toEqual([]);
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
});
