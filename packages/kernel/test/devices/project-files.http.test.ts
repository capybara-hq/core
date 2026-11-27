import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_DEVICE_LIST_ENTRIES } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  DeviceProjectFilesService,
  MAX_PROJECT_FILE_ENTRIES,
  MAX_PROJECT_FILES,
} from "../../src/devices/device-project-files.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { SandboxOperationAuthority } from "../../src/sandbox/operation-authority.js";
import { DeviceProviders } from "../../src/sandbox/providers.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import { legacyDbFor } from "../helpers/conversations.js";
import {
  type Answer,
  EnvelopeMachine as FakeMachine,
  type KernelReq,
} from "../helpers/dial-in-machine.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { bootstrapFixture, fakeDialInPkg } from "../helpers/plugin-packages.js";
import {
  createOrg,
  enableDeviceProviders,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * A device project's files (composer menus §5): `GET /devices/:id/projects/:name/files` lists one
 * directory of the project through the owner browse scope (`list`), every path relative to the
 * project root and refused before the device is asked when it leaves it; `statAll` checks
 * referenced files with `stat`. A dial-in device on `fake-dial-in` answers each relayed browse
 * from {@link TREE}; a cloud device on `device-fake` (no `list`) cannot list.
 */

const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/device-fake/index.ts", import.meta.url),
);

const HOME = "/home/me";
const ROOT = `${HOME}/app`;

/** 250 files in `big`, more than one listing answers. */
const BIG = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);

/** A project outside the owner's home (the browse ceiling): no scope rooted there exists. */
const OUTSIDE = "/srv/elsewhere";

/** The fake machine's directories: absolute path → entries (a name ending in `/` is a directory). */
const TREE: Record<string, string[]> = {
  [ROOT]: ["src/", "README.md", "Area/", "zeta.ts", "alpha.ts", "docs/", "big/"],
  [`${ROOT}/src`]: ["main.ts", "lib/", "readme.txt"],
  [`${ROOT}/src/lib`]: ["util.ts"],
  [`${ROOT}/docs`]: [],
  [`${ROOT}/big`]: BIG,
  // unsorted: folders listed after more than 200 files
  [`${ROOT}/late`]: [...BIG, "zdir/", "Adir/"],
  // a device answering names the kernel must not pass on
  // (the protocol already refuses "", ".", ".." and "/" in a name)
  [`${ROOT}/odd`]: ["ok.ts", "c\\d", "nul\u0000", "line\nbreak"],
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let sandboxRoot: string;
let bootstrap: Awaited<ReturnType<typeof bootstrapFixture>>;
let machines: DialInMachines;
let devices: DevicesService;
let files: DeviceProjectFilesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  sandboxRoot = await mkdtemp(join(tmpdir(), "cap-project-files-"));
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  bootstrap = await bootstrapFixture([{ bytes: await fakeDialInPkg(), required: false }]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [SANDBOX_FAKE],
        extensionConfig: { "device-fake": { root: sandboxRoot } },
        devices: { dialIn: { reconnectGraceSeconds: 2, leaseTtlMs: 6000 } },
      },
    ),
    { bootstrap: { dir: bootstrap.dir }, bootstrapManifest: bootstrap.manifest },
  );
  await waitFor(async () => k.app.get(DeviceProviders).forDevice("fake-dial-in") ?? null);
  machines = k.app.get(DialInMachines);
  devices = k.app.get(DevicesService);
  files = k.app.get(DeviceProjectFilesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  await enableDeviceProviders(k, orgId);
  url = `ws://127.0.0.1:${k.port}/device/connect`;
});

afterEach(() => {
  for (const m of open.splice(0)) m.close();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await bootstrap?.cleanup();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (sandboxRoot) await rm(sandboxRoot, { recursive: true, force: true });
});

const filesUrl = (deviceId: string, project: string, query = "") =>
  `/api/v1/orgs/${orgId}/devices/${deviceId}/projects/${encodeURIComponent(project)}/files${query}`;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

/** A new member with a session, a dial-in device holding the project `app` at {@link ROOT}. */
async function owned() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (
    await accountsFor(db).createLocal({ login, password: PW, displayName: `Name ${login}` })
  ).id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const d = await txHost.run(async () => {
    const { id: deviceId } = await devices.createDialIn(orgId, accountId, "fake-dial-in", "Box");
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
  await db
    .insertInto("device_projects")
    .values({ device_id: d.deviceId, name: "app", path: ROOT, created_by: accountId })
    .execute();
  return { accountId, login, req: await session(k, login), ...d };
}

/** The fake machine's answers: `list` from {@link TREE} (honouring `limit`), `stat` likewise. */
function answering(req: KernelReq): Answer {
  const args = req.args as { path?: string; limit?: number };
  const p = args.path as string;
  switch (req.op) {
    case "resume":
      return "resumed";
    case "browseList": {
      if (p.endsWith("/denied"))
        return { error: { kind: "scopeDenied", message: "machine says no" } };
      if (p.endsWith("/flaky")) return { error: { kind: "error", message: "EIO on the machine" } };
      if (p.endsWith("/malformed"))
        return { entries: [{ name: 7, isDir: "yes" }], truncated: false };
      if (p.endsWith(".ts") || p.endsWith(".md")) {
        return { error: { kind: "error", message: "not a directory" } };
      }
      const names = TREE[p];
      if (names === undefined) return null;
      const limit = args.limit ?? MAX_DEVICE_LIST_ENTRIES;
      const entries = names.map((n) =>
        n.endsWith("/") ? { name: n.slice(0, -1), isDir: true } : { name: n, isDir: false },
      );
      return { entries: entries.slice(0, limit), truncated: entries.length > limit };
    }
    case "browseStat": {
      if (p.endsWith("/denied.ts")) return { error: { kind: "scopeDenied", message: "no" } };
      if (p.endsWith("/flaky")) return { error: { kind: "error", message: "EIO on the machine" } };
      if (TREE[p] !== undefined) return { size: 0, isDir: true };
      const slash = p.lastIndexOf("/");
      const parent = TREE[p.slice(0, slash)];
      if (parent?.includes(p.slice(slash + 1))) return { size: 7, isDir: false };
      return null;
    }
    default:
      return null;
  }
}

/** Connects the machine (its hello reports `home`) and waits until its lease and report are stored. */
async function connect(d: { deviceId: string; credential: string }) {
  const machine = new FakeMachine(url, d.credential, answering, { hello: false });
  open.push(machine);
  await machine.opened;
  machine.hello({ home: HOME });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(d.deviceId))) !== null,
    10_000,
    "lease held",
  );
  await waitFor(
    async () =>
      (
        (
          await db
            .selectFrom("devices")
            .select("report")
            .where("id", "=", d.deviceId)
            .executeTakeFirst()
        )?.report as { home?: string } | null
      )?.home === HOME,
    10_000,
    "device report stored",
  );
  return machine;
}

const reqsOf = (m: FakeMachine, method: "list" | "stat") =>
  m.frames.filter(
    (f): f is KernelReq =>
      f.type === "req" && f.op === `browse${method.charAt(0).toUpperCase()}${method.slice(1)}`,
  );
type Listing = {
  entries: { name: string; path: string; kind: string; size?: number }[];
  truncated: boolean;
};

describe("device project files", () => {
  it("lists the root through the owner browse: folders first, then files, by name", async () => {
    const d = await owned();
    const machine = await connect(d);
    const sandbox = k.app.get(SandboxService);
    const starts = vi.spyOn(sandbox, "ensureRunningForOwner");
    const browses = vi.spyOn(sandbox, "withBrowse");
    const resolves = vi.spyOn(k.app.get(SandboxOperationAuthority), "resolveBrowse");
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app") });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      entries: [
        { name: "Area", path: "Area", kind: "dir" },
        { name: "big", path: "big", kind: "dir" },
        { name: "docs", path: "docs", kind: "dir" },
        { name: "src", path: "src", kind: "dir" },
        { name: "alpha.ts", path: "alpha.ts", kind: "file" },
        { name: "README.md", path: "README.md", kind: "file" },
        { name: "zeta.ts", path: "zeta.ts", kind: "file" },
      ],
      truncated: false,
    });
    // started for its owner, then browsed as its owner, in a scope rooted at the project root
    const who = { orgId, deviceId: d.deviceId, accountId: d.accountId };
    expect(starts).toHaveBeenCalledWith(who, expect.anything(), { readRoots: [ROOT] });
    // every check narrows to the project: the start, the browse, its admission and its claim
    expect(resolves.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of resolves.mock.calls) expect(call[2]).toEqual({ readRoots: [ROOT] });
    expect(browses).toHaveBeenCalledWith(who, expect.any(Function), expect.anything(), {
      readRoots: [ROOT],
    });
    expect(reqsOf(machine, "list").map((r) => r.args)).toEqual([
      {
        path: ROOT,
        limit: MAX_DEVICE_LIST_ENTRIES,
        scope: expect.objectContaining({
          deviceId: d.deviceId,
          accountId: d.accountId,
          readRoots: [ROOT],
        }),
      },
    ]);
  });

  it("lists one directory by its relative path, normalized, and filters names case-insensitively", async () => {
    const d = await owned();
    const machine = await connect(d);
    for (const path of ["src", "src/", "./src", "docs/../src", "src/lib/.."]) {
      const res = await d.req({
        method: "GET",
        url: filesUrl(d.deviceId, "app", `?path=${encodeURIComponent(path)}`),
      });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      expect((res.json() as Listing).entries).toEqual([
        { name: "lib", path: "src/lib", kind: "dir" },
        { name: "main.ts", path: "src/main.ts", kind: "file" },
        { name: "readme.txt", path: "src/readme.txt", kind: "file" },
      ]);
    }
    expect(new Set(reqsOf(machine, "list").map((r) => (r.args as { path: string }).path))).toEqual(
      new Set([`${ROOT}/src`]),
    );
    const nested = await d.req({
      method: "GET",
      url: filesUrl(d.deviceId, "app", "?path=src/lib"),
    });
    expect((nested.json() as Listing).entries).toEqual([
      { name: "util.ts", path: "src/lib/util.ts", kind: "file" },
    ]);

    const q = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?q=REA") });
    expect(q.statusCode, q.body).toBe(200);
    expect((q.json() as Listing).entries.map((e) => e.path)).toEqual(["Area", "README.md"]);
    // a filter reads as much of the directory as the device answers
    expect(reqsOf(machine, "list").at(-1)?.args).toMatchObject({
      limit: MAX_DEVICE_LIST_ENTRIES,
    });
    const empty = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=docs") });
    expect(empty.json()).toEqual({ entries: [], truncated: false });
    // an empty path, "." and "./" are the project root
    for (const path of ["", ".", "./"]) {
      const res = await d.req({
        method: "GET",
        url: filesUrl(d.deviceId, "app", `?path=${encodeURIComponent(path)}`),
      });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      expect(reqsOf(machine, "list").at(-1)?.args).toMatchObject({ path: ROOT });
    }
  });

  it("answers at most 200 entries and says when more exist", async () => {
    const d = await owned();
    await connect(d);
    for (const query of ["?path=big", "?path=big&q=f"]) {
      const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", query) });
      expect(res.statusCode, res.body).toBe(200);
      const l = res.json() as Listing;
      expect(l.truncated).toBe(true);
      expect(l.entries).toHaveLength(MAX_PROJECT_FILE_ENTRIES);
      expect(l.entries[0]).toEqual({ name: "f000.txt", path: "big/f000.txt", kind: "file" });
    }
    // folders the device lists after the first 200 files still come first
    const late = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=late") });
    const lateList = late.json() as Listing;
    expect(lateList.truncated).toBe(true);
    expect(lateList.entries.slice(0, 3)).toEqual([
      { name: "Adir", path: "late/Adir", kind: "dir" },
      { name: "zdir", path: "late/zdir", kind: "dir" },
      { name: "f000.txt", path: "late/f000.txt", kind: "file" },
    ]);
    const narrow = await d.req({
      method: "GET",
      url: filesUrl(d.deviceId, "app", "?path=big&q=f24"),
    });
    expect(narrow.json()).toEqual({
      entries: BIG.filter((n) => n.startsWith("f24")).map((n) => ({
        name: n,
        path: `big/${n}`,
        kind: "file",
      })),
      truncated: false,
    });
  });

  it("refuses a path that leaves the project before the device is asked", async () => {
    const d = await owned();
    const machine = await connect(d);
    const sandbox = k.app.get(SandboxService);
    const browses = vi.spyOn(sandbox, "withBrowse");
    for (const path of [
      "..",
      "../x",
      "a/../../x",
      "/etc",
      "//x",
      "a\\b",
      "%2e%2e/x",
      "a\u0000",
      `${ROOT}/src`,
    ]) {
      const res = await d.req({
        method: "GET",
        // %2e%2e is decoded by the server first, the others are sent encoded
        url: filesUrl(
          d.deviceId,
          "app",
          `?path=${path.startsWith("%") ? path : encodeURIComponent(path)}`,
        ),
      });
      expect(res.statusCode, `${path}: ${res.body}`).toBe(422);
      expect(errCode(res)).toBe("device.path_outside_project");
      expect((res.json() as { error: { details: unknown[] } }).error.details).toEqual([
        { path: path === "%2e%2e/x" ? "../x" : path },
      ]);
    }
    expect(browses).not.toHaveBeenCalled();
    expect(reqsOf(machine, "list")).toEqual([]);
  });

  it("drops names a device answers that are not one plain path segment", async () => {
    const d = await owned();
    await connect(d);
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=odd") });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Listing).entries).toEqual([
      { name: "ok.ts", path: "odd/ok.ts", kind: "file" },
    ]);
  });

  it("a missing directory, a file and an unknown project are readable refusals", async () => {
    const d = await owned();
    await connect(d);
    const missing = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=nope") });
    expect(missing.statusCode, missing.body).toBe(422);
    expect(errCode(missing)).toBe("device.project_path_missing");
    const file = await d.req({
      method: "GET",
      url: filesUrl(d.deviceId, "app", "?path=alpha.ts"),
    });
    expect(file.statusCode, file.body).toBe(422);
    expect(errCode(file)).toBe("device.project_path_unreadable");
    const unknown = await d.req({ method: "GET", url: filesUrl(d.deviceId, "other") });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(errCode(unknown)).toBe("device.project_not_found");
  });

  it("only the owner lists them: another member, an org admin or a service token cannot", async () => {
    const d = await owned();
    const machine = await connect(d);
    const other = await owned();
    const adminLogin = `a-${randomUUID().slice(0, 8)}`;
    const adminId = (
      await accountsFor(db).createLocal({ login: adminLogin, password: PW, displayName: "A" })
    ).id;
    await testMembers(db).add(orgId, adminId, "admin", ownerId);
    for (const req of [other.req, await session(k, "owner"), await session(k, adminLogin)]) {
      const res = await req({ method: "GET", url: filesUrl(d.deviceId, "app") });
      expect(res.statusCode, res.body).toBe(404);
      expect(errCode(res)).toBe("device.not_found");
    }
    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: ownerId,
    });
    const bot = await k.http.inject({
      method: "GET",
      url: filesUrl(d.deviceId, "app"),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bot.statusCode, bot.body).toBe(403);
    expect(errCode(bot)).toBe("forbidden");
    const anon = await k.http.inject({ method: "GET", url: filesUrl(d.deviceId, "app") });
    expect(anon.statusCode).toBe(401);
    expect(reqsOf(machine, "list")).toEqual([]);
  });

  it("an offline machine is device.offline, never a 500", async () => {
    const d = await owned();
    const machine = await connect(d);
    machine.close();
    await waitFor(
      async () => (await redis.get(deviceLeaseKey(d.deviceId))) === null,
      15_000,
      "lease released",
    );
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app") });
    expect(res.statusCode, res.body).toBe(503);
    expect(errCode(res)).toBe("device.offline");
  });

  it("a cloud device whose provider has no list answers device.list_unsupported", async () => {
    const d = await owned();
    const created = await d.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/devices`,
      payload: { name: "Cloud", provider: "device-fake" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { device: { id: string } }).device.id;
    await db
      .insertInto("device_projects")
      .values({ device_id: id, name: "app", path: "/workspace/app", created_by: d.accountId })
      .execute();
    const res = await d.req({ method: "GET", url: filesUrl(id, "app") });
    expect(res.statusCode, res.body).toBe(409);
    expect(errCode(res)).toBe("device.list_unsupported");
  });

  it("a scope refusal, a failing device and a malformed answer are readable refusals", async () => {
    const d = await owned();
    const machine = await connect(d);
    const denied = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=denied") });
    expect(denied.statusCode, denied.body).toBe(422);
    expect(errCode(denied)).toBe("device.project_outside_mode");
    // the message names the relative path, never the absolute one or the machine's text
    expect(denied.body).toContain("denied");
    expect(denied.body).not.toContain(ROOT);
    expect(denied.body).not.toContain("machine says no");
    const flaky = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=flaky") });
    expect(flaky.statusCode, flaky.body).toBe(503);
    expect(errCode(flaky)).toBe("device.projects_unavailable");
    expect(flaky.body).not.toContain("EIO");
    const bad = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=malformed") });
    expect(bad.statusCode, bad.body).toBe(503);
    expect(errCode(bad)).toBe("device.projects_unavailable");
    const missing = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app", "?path=nope") });
    expect((missing.json() as { error: { message: string } }).error.message).not.toContain(ROOT);
    expect(reqsOf(machine, "list").length).toBeGreaterThan(0);
  });

  it("a project outside the owner's browse ceiling is refused, the device never started or asked", async () => {
    const d = await owned();
    const machine = await connect(d);
    await db
      .insertInto("device_projects")
      .values({ device_id: d.deviceId, name: "far", path: OUTSIDE, created_by: d.accountId })
      .execute();
    // the lifecycle entry that starts (or resumes) the device's instance
    const enters = vi.spyOn(
      k.app.get(SandboxService) as unknown as { enter: (...a: unknown[]) => unknown },
      "enter",
    );
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "far") });
    expect(res.statusCode, res.body).toBe(422);
    expect(errCode(res)).toBe("device.project_outside_mode");
    expect(res.body).not.toContain(OUTSIDE);
    const who = { orgId, accountId: d.accountId, deviceId: d.deviceId };
    await expect(files.statAll(who, OUTSIDE, ["a.ts"])).rejects.toMatchObject({
      code: "device.project_outside_mode",
    });
    expect(enters).not.toHaveBeenCalled();
    expect(reqsOf(machine, "list")).toEqual([]);
    expect(reqsOf(machine, "stat")).toEqual([]);
    expect(machine.frames.some((f) => f.type === "req" && f.op === "resume")).toBe(false);
  });

  it("a stored project path that is not normalized is a generic 500 without the path", async () => {
    const d = await owned();
    const machine = await connect(d);
    const odd = `${HOME}/x/../hidden-project`;
    await db
      .insertInto("device_projects")
      .values({ device_id: d.deviceId, name: "odd", path: odd, created_by: d.accountId })
      .execute();
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "odd") });
    expect(res.statusCode, res.body).toBe(500);
    expect(res.body).not.toContain("hidden-project");
    expect(reqsOf(machine, "list")).toEqual([]);
  });

  it("a personal API token of the owner lists them; the owner's other org does not", async () => {
    const d = await owned();
    await connect(d);
    const { token } = await apiTokensFor(db).createPersonal(d.accountId, { name: "cli" });
    const pat = await k.http.inject({
      method: "GET",
      url: filesUrl(d.deviceId, "app", "?path=src"),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(pat.statusCode, pat.body).toBe(200);
    expect((pat.json() as Listing).entries.map((e) => e.path)).toContain("src/main.ts");
    const otherOrg = await createOrg(d.req, `Other ${randomUUID().slice(0, 6)}`);
    const res = await d.req({
      method: "GET",
      url: `/api/v1/orgs/${otherOrg}/devices/${d.deviceId}/projects/app/files`,
    });
    expect(res.statusCode, res.body).toBe(404);
    expect(errCode(res)).toBe("device.not_found");
  });

  it("statAll: files that exist pass; a missing path or a directory is missing; an escape is refused", async () => {
    const d = await owned();
    const machine = await connect(d);
    const who = { orgId, accountId: d.accountId, deviceId: d.deviceId };
    expect(
      await files.statAll(who, ROOT, ["src/main.ts", "./README.md", "src", "gone.ts", "src/lib/"]),
    ).toEqual({ missing: ["src", "gone.ts", "src/lib"] });
    expect(reqsOf(machine, "stat").map((r) => (r.args as { path: string }).path)).toEqual([
      `${ROOT}/src/main.ts`,
      `${ROOT}/README.md`,
      `${ROOT}/src`,
      `${ROOT}/gone.ts`,
      `${ROOT}/src/lib`,
    ]);
    const before = reqsOf(machine, "stat").length;
    await expect(files.statAll(who, ROOT, ["ok.ts", "../etc/passwd"])).rejects.toMatchObject({
      code: "device.path_outside_project",
    });
    // a path naming the project root is not a file: refused before the device is asked
    await expect(files.statAll(who, ROOT, ["ok.ts", "a/.."])).rejects.toMatchObject({
      code: "device.path_outside_project",
      details: [{ path: "a/.." }],
    });
    expect(reqsOf(machine, "stat")).toHaveLength(before);
    expect(await files.statAll(who, ROOT, [])).toEqual({ missing: [] });
    // a path the browse scope refuses is missing; a failing device is a 503 without its text
    expect(await files.statAll(who, ROOT, ["denied.ts", "alpha.ts"])).toEqual({
      missing: ["denied.ts"],
    });
    const failed = await files.statAll(who, ROOT, ["flaky"]).catch((e: unknown) => e);
    expect(failed).toMatchObject({ code: "device.projects_unavailable" });
    expect((failed as Error).message).not.toContain("EIO");
    // every stat ran in a scope rooted at the project
    expect(
      new Set(
        reqsOf(machine, "stat").map((r) =>
          JSON.stringify((r.args as { scope: { readRoots: string[] } }).scope.readRoots),
        ),
      ),
    ).toEqual(new Set([JSON.stringify([ROOT])]));
    // the project path is the kernel's own: one not normalized is an internal error
    await expect(files.statAll(who, `${ROOT}/`, ["alpha.ts"])).rejects.not.toHaveProperty("code");
    // more paths than one message references is an internal error, the device never asked
    const statsBefore = reqsOf(machine, "stat").length;
    const many = Array.from({ length: MAX_PROJECT_FILES + 1 }, (_, i) => `f${i}.ts`);
    await expect(files.statAll(who, ROOT, many)).rejects.not.toHaveProperty("code");
    expect(reqsOf(machine, "stat")).toHaveLength(statsBefore);
    expect(
      await files.statAll(
        who,
        ROOT,
        many.slice(0, MAX_PROJECT_FILES).map(() => "alpha.ts"),
      ),
    ).toEqual({ missing: [] });
    // another person never stats someone else's device
    const other = await owned();
    await expect(
      files.statAll({ ...who, accountId: other.accountId }, ROOT, ["src/main.ts"]),
    ).rejects.toMatchObject({ code: "device.not_found" });
  });
});
