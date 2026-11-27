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
} from "../../src/devices/device-project-files.service.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { deviceLeaseKey } from "../../src/dial-in/keys.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
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

/** The fake machine's directories: absolute path → entries (a name ending in `/` is a directory). */
const TREE: Record<string, string[]> = {
  [ROOT]: ["src/", "README.md", "Area/", "zeta.ts", "alpha.ts", "docs/", "big/"],
  [`${ROOT}/src`]: ["main.ts", "lib/", "readme.txt"],
  [`${ROOT}/src/lib`]: ["util.ts"],
  [`${ROOT}/docs`]: [],
  [`${ROOT}/big`]: BIG,
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
    const res = await d.req({ method: "GET", url: filesUrl(d.deviceId, "app") });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      entries: [
        { name: "Area", path: "Area", kind: "dir" },
        { name: "big", path: "big", kind: "dir" },
        { name: "docs", path: "docs", kind: "dir" },
        { name: "src", path: "src", kind: "dir" },
        { name: "README.md", path: "README.md", kind: "file" },
        { name: "alpha.ts", path: "alpha.ts", kind: "file" },
        { name: "zeta.ts", path: "zeta.ts", kind: "file" },
      ],
      truncated: false,
    });
    // started for its owner, then browsed as its owner, at the project root itself
    const who = { orgId, deviceId: d.deviceId, accountId: d.accountId };
    expect(starts).toHaveBeenCalledWith(who, expect.anything());
    expect(browses).toHaveBeenCalledWith(who, expect.any(Function), expect.anything());
    expect(reqsOf(machine, "list").map((r) => r.args)).toEqual([
      {
        path: ROOT,
        limit: MAX_PROJECT_FILE_ENTRIES,
        scope: expect.objectContaining({ deviceId: d.deviceId, accountId: d.accountId }),
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
    expect(reqsOf(machine, "stat")).toHaveLength(before);
    expect(await files.statAll(who, ROOT, [])).toEqual({ missing: [] });
    // another person never stats someone else's device
    const other = await owned();
    await expect(
      files.statAll({ ...who, accountId: other.accountId }, ROOT, ["src/main.ts"]),
    ).rejects.toMatchObject({ code: "device.not_found" });
  });
});
