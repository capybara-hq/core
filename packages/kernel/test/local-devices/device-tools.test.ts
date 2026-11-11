import { randomUUID } from "node:crypto";
import { type KernelReq, type SandboxRoots, ToolError } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AppendEvent } from "../../src/conversations/event-log.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { ApiError } from "../../src/errors.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { deviceLeaseKey } from "../../src/local-devices/keys.js";
import { MachinesService } from "../../src/local-devices/machines.js";
import { HOLDER_POLL_MS } from "../../src/local-devices/relay.js";
import { SandboxService } from "../../src/sandbox/sandbox.service.js";
import {
  SANDBOX_RESTARTED_NOTICE,
  sandboxFilesResetNotice,
} from "../../src/tools/builtins/sandbox/common.js";
import { type SandboxToolDeps, sandboxTools } from "../../src/tools/builtins/sandbox/index.js";
import type { BuiltinTool } from "../../src/tools/registry.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";
import { FakeMachine, HELLO, refusal } from "./fake-machine.js";
import type { Answer } from "./test-holder.js";

/**
 * Local devices end to end through the kernel's own sandbox tools (environments spec
 * §13; final review C1, I1, I2, I5, I6): the real `SandboxService.withSandbox`, the `@local`
 * provider, the relay and the gateway, and a fake machine on a real WebSocket. Only the
 * conversation side (its device, its event log, attachments) is stubbed.
 */

const ROOTS_A: SandboxRoots = {
  workspace: "/home/me/capybara/a/workspace",
  skills: "/home/me/capybara/a/skills",
  tmp: "/home/me/capybara/a/tmp",
};
const ROOTS_B: SandboxRoots = {
  workspace: "/srv/other/workspace",
  skills: "/srv/other/skills",
  tmp: "/srv/other/tmp",
};

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let k: TestKernel;
let machines: MachinesService;
let devices: DevicesService;
let txHost: TransactionHost;
let ownerId: string;
let orgId: string;
let url: string;
const open: FakeMachine[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        sandbox: { limits: { egress: "allowlist", allowHosts: ["example.com"] } },
        devices: { local: { reconnectGraceSeconds: 60, leaseTtlMs: 6000 } },
      },
    ),
  );
  machines = k.app.get(MachinesService);
  devices = k.app.get(DevicesService);
  txHost = k.app.get(TransactionHost);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  orgId = await createOrg(await session(k, "owner"));
  url = `ws://127.0.0.1:${k.port}/device/connect`;
}, 180_000);

afterEach(() => {
  for (const m of open.splice(0)) m.close();
});

afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A machine's directory: its files, and whether the directory is gone (`fs_gone` for every op). */
interface MachineDir {
  files: Map<string, string>;
  gone: boolean;
  /** Ops left unanswered (the test answers them, or never). */
  hold: Set<string>;
}

/** Answers like `capybara-device` over `dir`, with `roots` for `create`. */
function answerer(dir: MachineDir, roots: SandboxRoots): (req: KernelReq) => Answer {
  return (req) => {
    if (dir.hold.has(req.op)) return undefined;
    if (dir.gone && req.op !== "stop") {
      return {
        ok: false,
        error: { kind: "fs_gone", message: "the device directory is gone" },
      };
    }
    const a = req.args as Record<string, unknown>;
    switch (req.op) {
      case "create":
        return { ok: true, result: { roots } };
      case "exec":
        return {
          ok: true,
          result: { exitCode: 0, stdout: "ok\n", stderr: "", truncated: false, timedOut: false },
        };
      case "writeFile":
        dir.files.set(a.path as string, a.dataB64 as string);
        return { ok: true, result: null };
      case "readFile": {
        const d = dir.files.get(a.path as string);
        return { ok: true, result: d === undefined ? null : { dataB64: d, truncated: false } };
      }
      case "stat": {
        const d = dir.files.get(a.path as string);
        return {
          ok: true,
          result: d === undefined ? null : { size: Buffer.from(d, "base64").length, isDir: false },
        };
      }
      default:
        return { ok: true, result: null };
    }
  };
}

/** Signs a machine in (a new credential for the device) and connects it with `roots`. */
async function signIn(
  deviceId: string,
  accountId: string,
  roots: SandboxRoots,
  dir: MachineDir = { files: new Map(), gone: false, hold: new Set() },
  name = "box",
) {
  const issued = await txHost.run(() =>
    machines.issue({
      orgId,
      deviceId,
      accountId,
      name,
      os: "linux",
      arch: "x64",
      programVersion: "0.1.0",
    }),
  );
  const machine = new FakeMachine(url, issued.credential, answerer(dir, roots), { hello: false });
  open.push(machine);
  await machine.opened;
  machine.send({ ...HELLO, roots });
  await waitFor(
    async () => (await redis.get(deviceLeaseKey(deviceId))) !== null,
    10_000,
    "lease held",
  );
  // the hello is recorded after the lease is claimed (it may move the files-reset count on)
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("device_machines")
          .select("roots")
          .where("id", "=", issued.machineId)
          .executeTakeFirst()
      )?.roots != null,
    10_000,
    "hello recorded",
  );
  return { machine, dir, ...issued };
}

/** A member with a local device, and the sandbox tools of one of their conversations. */
async function member() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  const { id: deviceId } = await txHost.run(() => devices.createLocal(orgId, accountId, "Box"));
  const appended: AppendEvent[] = [];
  const deps: SandboxToolDeps = {
    sandbox: k.app.get(SandboxService),
    devices: { forTool: async () => deviceId },
    attachments: { listForConversation: async () => [], openForConversation: async () => null },
    // biome-ignore lint/suspicious/noExplicitAny: never called (no attachments)
    storage: {} as any,
    eventLog: {
      append: async (_c: string, events: AppendEvent[]) => {
        appended.push(...events);
        return [];
      },
      latestOfType: async (_c: string, type: string) =>
        appended.findLast((e) => e.type === type) as never,
      latestFileState: async () => null,
      // biome-ignore lint/suspicious/noExplicitAny: append / latestOfType / latestFileState only
    } as any,
    config: k.app.get(KernelConfigService),
  };
  const tools = sandboxTools(deps);
  const tool = (name: string) => tools.find((t) => t.spec.name === name) as BuiltinTool;
  const conversationId = randomUUID();
  const ctx = (signal: AbortSignal = AbortSignal.timeout(60_000)) =>
    ({
      orgId,
      conversationId,
      runId: randomUUID(),
      callId: randomUUID(),
      accountId,
      signal,
      // biome-ignore lint/suspicious/noExplicitAny: only these fields are read
    }) as any;
  const paths = () =>
    appended
      .filter((e) => e.type === "device_paths")
      .map((e) => (e.payload as { roots: SandboxRoots }).roots);
  const instance = () =>
    db
      .selectFrom("device_instances")
      .select(["status", "fs_status", "handle"])
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
  return { accountId, deviceId, tool, ctx, paths, instance };
}

const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

/** The model-facing text of a failed tool call (a `ToolError`, as the pipeline shows it). */
async function toolError(p: Promise<unknown>): Promise<string> {
  const e = await rejection(p);
  expect(e).toBeInstanceOf(ToolError);
  return (e as ToolError).message;
}

describe("local devices through the sandbox tools", () => {
  it("a new login with other roots: the next call runs on a new instance in the new roots (R23)", async () => {
    const m = await member();
    const first = await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/a.txt`, content: "a" }, m.ctx());
    expect(first.dir.files.has(`${ROOTS_A.workspace}/a.txt`)).toBe(true);
    expect(m.paths()).toEqual([ROOTS_A]);

    // the owner signs in again from another directory: the old machine is replaced
    const second = await signIn(m.deviceId, m.accountId, ROOTS_B);
    expect((await first.machine.closed).code).toBeGreaterThanOrEqual(4000);
    expect(await m.instance()).toMatchObject({ status: "none", handle: null, fs_status: "ready" });

    const written = await m
      .tool("Write")
      .run({ file_path: `${ROOTS_B.workspace}/b.txt`, content: "b" }, m.ctx());
    expect(second.dir.files.has(`${ROOTS_B.workspace}/b.txt`)).toBe(true);
    // another directory holds other files: the conversation is told its files were reset
    expect(JSON.stringify(written)).toContain(
      JSON.stringify(sandboxFilesResetNotice(ROOTS_B)).slice(1, -1),
    );
    expect(second.machine.frames.find((f) => f.type === "req")).toMatchObject({ op: "create" });
    expect(m.paths()).toEqual([ROOTS_A, ROOTS_B]);
    // a path of the old roots is now outside the device
    expect(
      await toolError(
        m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/c.txt`, content: "c" }, m.ctx()),
      ),
    ).toMatch(/workspace/i);
  }, 60_000);

  it("a new login on the same machine and directory keeps the files; another machine resets them", async () => {
    const m = await member();
    await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/a.txt`, content: "a" }, m.ctx());
    const resets = async () =>
      (
        await db
          .selectFrom("device_instances")
          .select("fs_resets")
          .where("device_id", "=", m.deviceId)
          .executeTakeFirstOrThrow()
      ).fs_resets;
    const before = await resets();

    // the same machine, the same directory: a restart on kept files
    await signIn(m.deviceId, m.accountId, ROOTS_A);
    expect(await resets()).toBe(before);
    const kept = await m
      .tool("Write")
      .run({ file_path: `${ROOTS_A.workspace}/b.txt`, content: "b" }, m.ctx());
    expect(JSON.stringify(kept)).toContain(SANDBOX_RESTARTED_NOTICE);
    expect(JSON.stringify(kept)).not.toContain("files were reset");

    // another machine with the same roots: other files
    await signIn(m.deviceId, m.accountId, ROOTS_A, undefined, "laptop");
    expect(await resets()).toBe(before + 1);
    const reset = await m
      .tool("Write")
      .run({ file_path: `${ROOTS_A.workspace}/c.txt`, content: "c" }, m.ctx());
    expect(JSON.stringify(reset)).toContain(
      JSON.stringify(sandboxFilesResetNotice(ROOTS_A)).slice(1, -1),
    );
  }, 60_000);

  it("every exec carries the org's egress of the moment (R27)", async () => {
    const m = await member();
    const { machine } = await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Bash").run({ command: "true" }, m.ctx());
    const execs = () => machine.frames.filter((f) => f.type === "req" && f.op === "exec");
    expect((execs()[0] as KernelReq).args).toMatchObject({ limits: { egress: "allowlist" } });
    await sql`UPDATE capybara.orgs SET settings = ${JSON.stringify({
      sandboxEgress: { mode: "none" },
    })}::jsonb WHERE id = ${orgId}`.execute(raw);
    try {
      await m.tool("Bash").run({ command: "true" }, m.ctx());
      expect((execs()[1] as KernelReq).args).toMatchObject({
        limits: { egress: "none", allowHosts: [] },
      });
    } finally {
      await sql`UPDATE capybara.orgs SET settings = '{}'::jsonb WHERE id = ${orgId}`.execute(raw);
    }
  }, 60_000);

  it("every exec names the call's run in its actor; no grants without approved asks (P-D3)", async () => {
    const m = await member();
    const { machine } = await signIn(m.deviceId, m.accountId, ROOTS_A);
    const ctx = m.ctx();
    await m.tool("Bash").run({ command: "true" }, ctx);
    const exec = machine.frames.find((f) => f.type === "req" && f.op === "exec") as KernelReq;
    expect(exec.args).toMatchObject({
      actor: { accountId: m.accountId, conversationId: ctx.conversationId, runId: ctx.runId },
    });
    expect(exec.args).not.toHaveProperty("grants");
  }, 60_000);

  it("a revoked machine: its socket closes, the waiting call fails at once, the credential is refused", async () => {
    const m = await member();
    const { machine, dir, credential } = await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/a.txt`, content: "a" }, m.ctx());
    dir.hold.add("exec");
    const t0 = Date.now();
    const waiting = toolError(m.tool("Bash").run({ command: "sleep 100" }, m.ctx()));
    await machine.next((f) => f.type === "req" && f.op === "exec");
    await machines.revoke(orgId, m.accountId, m.deviceId);
    expect((await machine.closed).code).toBe(4003);
    expect(await waiting).toMatch(/was disconnected.*capybara-device login/);
    // far sooner than the command's deadline plus the 60 s grace
    expect(Date.now() - t0).toBeLessThan(HOLDER_POLL_MS + 5000);
    // the next call is refused the same way, not as offline
    expect(
      await toolError(m.tool("Read").run({ file_path: `${ROOTS_A.workspace}/a.txt` }, m.ctx())),
    ).toMatch(/was disconnected/);
    const again = await refusal(url, {
      Authorization: `Bearer ${credential}`,
      "X-Capybara-Device-Protocol": "1",
    });
    expect(again?.status).toBe(401);
  }, 60_000);

  it("a deleted device: stop and close, the waiting call fails as not found, the credential is refused", async () => {
    const m = await member();
    const { machine, dir, credential } = await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/a.txt`, content: "a" }, m.ctx());
    dir.hold.add("exec");
    const t0 = Date.now();
    const waiting = toolError(m.tool("Bash").run({ command: "sleep 100" }, m.ctx()));
    await machine.next((f) => f.type === "req" && f.op === "exec");
    await devices.remove(orgId, m.accountId, m.deviceId);
    expect(await machine.next((f) => f.type === "req" && f.op === "stop")).toMatchObject({
      args: { reason: "deleted" },
    });
    expect((await machine.closed).code).toBe(4003);
    expect(await waiting).toMatch(/device was deleted/);
    expect(Date.now() - t0).toBeLessThan(HOLDER_POLL_MS + 5000);
    const again = await refusal(url, {
      Authorization: `Bearer ${credential}`,
      "X-Capybara-Device-Protocol": "1",
    });
    expect(again?.status).toBe(401);
  }, 60_000);

  it("a vanished directory: files_lost through the tools, no reset from the platform, a new login recovers (R24)", async () => {
    const m = await member();
    const { machine, dir } = await signIn(m.deviceId, m.accountId, ROOTS_A);
    await m.tool("Write").run({ file_path: `${ROOTS_A.workspace}/a.txt`, content: "a" }, m.ctx());

    dir.gone = true;
    const lost =
      /directory is gone from the device's machine.*capybara-device logout, then capybara-device login/;
    expect(
      await toolError(m.tool("Read").run({ file_path: `${ROOTS_A.workspace}/a.txt` }, m.ctx())),
    ).toMatch(lost);
    expect((await m.instance())?.fs_status).toBe("lost");
    // later calls fail the same way without reaching the machine
    const sent = machine.frames.length;
    expect(await toolError(m.tool("Bash").run({ command: "ls" }, m.ctx()))).toMatch(lost);
    expect(machine.frames.length).toBe(sent);

    // the platform cannot reset a machine's files, and never tells it to stop
    const reset = await rejection(devices.resetFiles(orgId, m.accountId, m.deviceId));
    expect(reset instanceof ApiError && reset.code === "device.files_on_device").toBe(true);
    expect(machine.frames.some((f) => f.type === "req" && f.op === "stop")).toBe(false);

    // the owner signs in again (the program recreates the directory): the next call works
    const next = await signIn(m.deviceId, m.accountId, ROOTS_A);
    const written = await m
      .tool("Write")
      .run({ file_path: `${ROOTS_A.workspace}/b.txt`, content: "b" }, m.ctx());
    expect(next.dir.files.has(`${ROOTS_A.workspace}/b.txt`)).toBe(true);
    // the recreated directory is empty: the conversation is told its files were reset
    expect(JSON.stringify(written)).toContain(
      JSON.stringify(sandboxFilesResetNotice(ROOTS_A)).slice(1, -1),
    );
    expect((await m.instance())?.fs_status).toBe("ready");
  }, 60_000);
});
