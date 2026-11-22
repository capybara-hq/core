import { randomUUID } from "node:crypto";
import {
  DEVICE_DIAL_IN_PROTOCOL,
  DEVICE_PROTOCOL_VERSION,
  type DeviceOperation,
  type KernelRequest,
  LEGACY_DEVICE_PROTOCOL_VERSION,
} from "@capybara-hq/plugin-sdk/device-protocol";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { DevicesService } from "../../src/devices/devices.service.js";
import { DEVICE_CLOSE } from "../../src/dial-in/gateway.js";
import { DialInMachines } from "../../src/dial-in/machines.js";
import { DialInRelay } from "../../src/dial-in/relay.js";
import { DeviceTargets } from "../../src/dial-in/targets.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { localCall } from "../../src/local-devices/local-codec.js";
import { DeviceProviders, LOCAL_PROVIDER } from "../../src/sandbox/providers.js";
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
} from "../helpers/runs.js";
import { HELLO as LEGACY_HELLO, refusal } from "./fake-machine.js";
import { FakeMachineV3, HELLO_V3, helloEnvelope } from "./fake-machine-v3.js";
import type { Answer } from "./test-holder.js";

/**
 * The paired activation (permission activation W4-O): the production route `GET /device/connect`
 * speaks device protocol 5 only. A protocol 2 header is refused before the upgrade (426), a
 * protocol 2 hello, a hello that does not match the protocol 5 header and a malformed frame close
 * the socket (4400), and every protocol 5 operation makes the round trip kernel -> gateway ->
 * device -> kernel over the real route, including a managed output read of more than 65 KiB.
 */

// big enough for a full 64 KiB output range (base64) in one frame
const MAX_FRAME_BYTES = 128 * 1024;

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let ownerId: string;
let orgId: string;
let url: string;
const open: { close(): void }[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        devices: {
          local: { reconnectGraceSeconds: 5, leaseTtlMs: 6000, maxFrameBytes: MAX_FRAME_BYTES },
        },
      },
    ),
  );
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
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** A member's local device with a machine credential. */
async function connected() {
  const login = `m-${randomUUID().slice(0, 8)}`;
  const accountId = (await accountsFor(db).createLocal({ login, password: PW, displayName: login }))
    .id;
  await testMembers(db).add(orgId, accountId, "member", ownerId);
  return k.app.get(TransactionHost).run(async () => {
    const { id: deviceId } = await k.app
      .get(DevicesService)
      .createDialIn(orgId, accountId, "@local", "Box");
    const issued = await k.app.get(DialInMachines).issue({
      orgId,
      deviceId,
      accountId,
      name: "box",
      os: "darwin",
      arch: "arm64",
      programVersion: "0.1.0",
    });
    return { deviceId, ...issued };
  });
}

/** A raw socket on the production route with a protocol 5 header; resolves its close. */
async function rawSocket(credential: string) {
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${credential}`,
      "X-Capybara-Device-Protocol": DEVICE_DIAL_IN_PROTOCOL,
    },
  });
  open.push({ close: () => ws.terminate() });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  return { ws, closed };
}

const codeOf = (body: string) => (JSON.parse(body) as { error: { code: string } }).error.code;

describe("the production route speaks protocol 5 only", () => {
  it("the protocol constant is 5", () => {
    expect(DEVICE_PROTOCOL_VERSION).toBe(5);
    expect(LEGACY_DEVICE_PROTOCOL_VERSION).toBe(4);
  });

  it("a protocol 4 program gets 426 Update the program", async () => {
    const m = await connected();
    const r = await refusal(url, {
      Authorization: `Bearer ${m.credential}`,
      "X-Capybara-Device-Protocol": "capybara-device/4",
    });
    expect(r?.status).toBe(426);
    expect(codeOf(r?.body ?? "")).toBe("device.program_outdated");
    expect(r?.body).toContain("speaks capybara-device/5");
    expect(r?.body).toContain("this program speaks capybara-device/4");
    expect(r?.body).toContain("Update the program");
  });

  it("an older protocol header is refused before the upgrade: 426 device.program_outdated", async () => {
    const m = await connected();
    for (const protocol of ["4", "3", "2", "1", ""]) {
      const r = await refusal(url, {
        Authorization: `Bearer ${m.credential}`,
        ...(protocol !== "" && { "X-Capybara-Device-Protocol": protocol }),
      });
      expect(r?.status).toBe(426);
      expect(codeOf(r?.body ?? "")).toBe("device.program_outdated");
      // a newer capybara-device reads the provider's protocol from this text (`outdatedMessage`)
      expect(r?.body).toContain("capybara-device/5");
    }
  });

  it("a newer program is told this deployment is older and must be upgraded", async () => {
    const m = await connected();
    const r = await refusal(url, {
      Authorization: `Bearer ${m.credential}`,
      "X-Capybara-Device-Protocol": "capybara-device/6",
    });
    expect(r?.status).toBe(426);
    expect(codeOf(r?.body ?? "")).toBe("device.program_outdated");
    expect(r?.body).toContain("capybara-device/5");
    expect(r?.body).toContain("older");
    expect(r?.body).not.toContain("Update the program");
  });

  it("a protocol 2 hello on a protocol 5 connection closes 4400 and claims nothing", async () => {
    const m = await connected();
    const { ws, closed } = await rawSocket(m.credential);
    ws.send(JSON.stringify(LEGACY_HELLO));
    expect(LEGACY_HELLO.protocol).toBe(2);
    expect((await closed).code).toBe(DEVICE_CLOSE.protocol);
    expect(await k.app.get(DialInRelay).online(m.deviceId)).toBe(false);
  });

  it("a hello whose protocol does not match the protocol 5 header closes 4400", async () => {
    const m = await connected();
    for (const hello of [
      helloEnvelope({ protocol: "capybara-device/4" }),
      helloEnvelope({ protocol: "capybara-device/6" }),
      helloEnvelope({ protocol: "fake-dial-in/1" }),
      // a protocol 4 hello frame (no envelope)
      { ...HELLO_V3, type: "hello", protocol: 4 },
      // protocol 5 in name, protocol 2 in shape (no envelope)
      { ...LEGACY_HELLO, protocol: 5 },
    ]) {
      const { ws, closed } = await rawSocket(m.credential);
      ws.send(JSON.stringify(hello));
      expect((await closed).code).toBe(DEVICE_CLOSE.protocol);
    }
    expect(await k.app.get(DialInRelay).online(m.deviceId)).toBe(false);
  });

  it("a malformed frame closes 4400: not JSON, binary, incomplete, before and after ready", async () => {
    const m = await connected();
    const early = await rawSocket(m.credential);
    early.ws.send("{not json");
    expect((await early.closed).code).toBe(DEVICE_CLOSE.protocol);

    const binary = await rawSocket(m.credential);
    binary.ws.send(Buffer.from(JSON.stringify(HELLO_V3)), { binary: true });
    expect((await binary.closed).code).toBe(DEVICE_CLOSE.protocol);

    // a hello whose body lacks the owner report: the local provider refuses it
    const partial = await rawSocket(m.credential);
    partial.ws.send(JSON.stringify(helloEnvelope({ ownerCeiling: undefined })));
    const refused = await partial.closed;
    expect(refused.code).toBe(DEVICE_CLOSE.protocol);
    expect(refused.reason).toContain("device.hello_invalid");

    // after a valid hello and ready: a result with a field outside the envelope is malformed too
    const machine = new FakeMachineV3(url, m.credential);
    open.push(machine);
    await machine.ready;
    machine.send({ type: "res", id: randomUUID(), body: {}, ok: false });
    expect((await machine.closed).code).toBe(DEVICE_CLOSE.protocol);
  });
});

const operationScope = (deviceId: string) => ({
  operationId: "op-1",
  admitBeforeMs: Date.now() + 60_000,
  deviceId,
  rootConversationId: "root",
  profileRevision: 1,
  ceilingRevision: "c",
  profile: "approve-for-me",
  actor: { accountId: "a", conversationId: "root" },
  tag: "op-1",
  filesystem: { kind: "scoped", projectRoot: "/work", writeRoots: ["/work"] },
  network: { kind: "none" },
});
const LIMITS = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist", hosts: [] },
};
const executionRef = (deviceId: string) => ({
  executionId: "e-1",
  operationId: "op-1",
  instanceId: deviceId,
  instanceGeneration: "1700000000000",
});
const EXEC_RESULT = { exitCode: 0, stdout: "ok\n", stderr: "", truncated: false, timedOut: false };

/** Every protocol 5 operation: valid request arguments and the device's answer. */
function operations(deviceId: string): [DeviceOperation, Record<string, unknown>, unknown][] {
  const scope = operationScope(deviceId);
  const prep = {
    operationId: "p-1",
    deviceId,
    purpose: "skills",
    writeRoots: ["/skills"],
    tag: "p-1",
  };
  const browse = {
    operationId: "b-1",
    deviceId,
    accountId: "a",
    admitBeforeMs: Date.now() + 60_000,
    ceilingRevision: "c",
    readRoots: ["/work"],
    tag: "b-1",
  };
  const ref = executionRef(deviceId);
  return [
    ["create", { limits: LIMITS }, { roots: { workspace: "/w", skills: "/s", tmp: "/t" } }],
    [
      "exec",
      { scope, command: "true", timeoutMs: 1000, maxOutputBytes: 1000, limits: LIMITS },
      EXEC_RESULT,
    ],
    ["readFile", { scope, path: "/work/a", maxBytes: 10 }, { dataB64: "YQ==", truncated: false }],
    ["writeFile", { scope, path: "/work/a", dataB64: "YQ==" }, null],
    ["stat", { scope, path: "/work/a" }, { size: 1, isDir: false }],
    [
      "list",
      { scope, path: "/work", limit: 10 },
      { entries: [{ name: "a", isDir: false }], truncated: false },
    ],
    ["scan", { scope, base: "/work" }, [{ path: "/work", suggestedName: "work" }]],
    ["prepareReadFile", { scope: prep, path: "/skills/a", maxBytes: 10 }, null],
    ["prepareWriteFile", { scope: prep, path: "/skills/a", dataB64: "YQ==" }, null],
    ["prepareStat", { scope: prep, path: "/skills/a" }, null],
    ["browseStat", { scope: browse, path: "/work" }, { size: 0, isDir: true }],
    ["browseList", { scope: browse, path: "/work", limit: 10 }, { entries: [], truncated: false }],
    ["browseScan", { scope: browse, base: "/work" }, []],
    [
      "backgroundStart",
      {
        scope,
        command: "sleep 1",
        timeoutMs: 1000,
        maxOutputBytes: 1000,
        limits: LIMITS,
        taskId: "task-1",
        outputPath: "/work/.out",
        retainUntilMs: scope.admitBeforeMs + 1000,
      },
      ref,
    ],
    ["backgroundStatus", { ref }, { state: "running" }],
    ["backgroundTail", { ref, maxBytes: 10 }, { dataB64: "YQ==", truncated: false }],
    [
      "backgroundReadOutput",
      { ref, offset: 0, maxBytes: 1 },
      { dataB64: "YQ==", offset: 0, nextOffset: 1, totalBytes: 1 },
    ],
    ["backgroundStop", { ref, graceMs: 100 }, { outcome: "stopped" }],
    ["revokeOperation", { ref: { operationId: "op-1", admitBeforeMs: scope.admitBeforeMs } }, null],
    ["stop", { reason: "revoked" }, null],
  ];
}

describe("every protocol 5 operation makes the round trip over the production route", () => {
  it("kernel -> gateway -> device -> kernel for each operation, frames as sent", async () => {
    const m = await connected();
    const ops = operations(m.deviceId);
    const answers = new Map<string, unknown>(ops.map(([op, , result]) => [op, result]));
    const machine = new FakeMachineV3(url, m.credential, (req) => {
      const op = String(req.op);
      return op === "bindInstance" || !answers.has(op)
        ? undefined
        : ({ ok: true, result: answers.get(op) } as Answer);
    });
    open.push(machine);
    await machine.ready;
    const relay = k.app.get(DialInRelay);
    const targets = k.app.get(DeviceTargets);
    await expect.poll(() => targets.transport(m.deviceId).catch(() => null)).not.toBeNull();
    for (const [op, args, result] of ops) {
      const got = await localCall(relay)(m.deviceId, op, args, {
        deadlineMs: 6000,
        signal: AbortSignal.timeout(15_000),
      });
      expect(got, op).toEqual(result);
      const sent = machine.frames.findLast((f) => f.type === "req") as unknown as KernelRequest;
      expect(sent.op, op).toBe(op);
      expect(sent.args, op).toEqual(args);
    }
    // the instance binding is a protocol 5 operation as well (answered with installed evidence)
    const bind = {
      instanceId: m.deviceId,
      instanceGeneration: "1700000000000",
      bindingId: randomUUID(),
      expectedPreviousGeneration: null,
    };
    expect(
      await localCall(relay)(m.deviceId, "bindInstance", bind, {
        deadlineMs: 6000,
        signal: AbortSignal.timeout(15_000),
      }),
    ).toMatchObject({ bindingId: bind.bindingId, instanceGeneration: bind.instanceGeneration });
    const seen = new Set(machine.frames.map((f) => String((f as { op?: unknown }).op)));
    for (const [op] of ops) expect(seen.has(op), op).toBe(true);
    expect(seen.has("bindInstance")).toBe(true);
    // a protocol 5 device never gets a broad kill
    expect(seen.has("killAll") || seen.has("killTagged")).toBe(false);
  });

  it("a managed output of more than 65 KiB is read in full through the registered @local provider", async () => {
    const m = await connected();
    const output = Buffer.alloc(180_000);
    for (let i = 0; i < output.length; i++) output[i] = i % 251;
    const ref = executionRef(m.deviceId);
    const machine = new FakeMachineV3(url, m.credential, (req) => {
      if (String(req.op) !== "backgroundReadOutput") return undefined;
      const a = req.args as { offset: number; maxBytes: number };
      const data = output.subarray(a.offset, a.offset + a.maxBytes);
      return {
        ok: true,
        result: {
          dataB64: data.toString("base64"),
          offset: a.offset,
          nextOffset: a.offset + data.length,
          totalBytes: output.length,
        },
      } as Answer;
    });
    open.push(machine);
    await machine.ready;
    await expect
      .poll(() =>
        k.app
          .get(DeviceTargets)
          .transport(m.deviceId)
          .catch(() => null),
      )
      .not.toBeNull();
    const provider = k.app.get(DeviceProviders).forDevice(LOCAL_PROVIDER)?.impl;
    if (!provider?.background?.readOutput) throw new Error("no managed output on @local");
    const parts: Buffer[] = [];
    let offset = 0;
    let reads = 0;
    while (offset < output.length) {
      const r = await provider.background.readOutput({ id: m.deviceId }, ref, {
        offset,
        maxBytes: 65536,
        signal: AbortSignal.timeout(15_000),
      });
      if ("unavailable" in r) throw new Error(r.unavailable);
      expect(r.offset).toBe(offset);
      expect(r.totalBytes).toBe(output.length);
      parts.push(Buffer.from(r.data));
      offset = r.nextOffset;
      reads++;
    }
    expect(Buffer.concat(parts).equals(output)).toBe(true);
    expect(reads).toBeGreaterThan(1);
    // each read went out as one protocol 5 frame sized for the connection's capacity
    for (const f of machine.frames) {
      expect(String((f as { op?: unknown }).op)).toBe("backgroundReadOutput");
      expect((f as unknown as KernelRequest).args.maxBytes as number).toBeLessThanOrEqual(65536);
    }
  });
});
