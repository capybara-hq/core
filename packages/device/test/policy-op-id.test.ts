import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KernelReq } from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Connection, connect } from "../src/client.js";
import { MAX_LOGGED_POLICY_OPS, PolicyOpLog } from "../src/policy-ops.js";
import { PolicyStore } from "../src/policy-store.js";
import { REMOTE_GRANTS_OFF_MESSAGE, serveOp } from "../src/server-ops.js";
import { DEFAULT_POLICY, policyOpsPath, policyPath, writePolicy } from "../src/state.js";
import { FakeExecutor, FakeKernel } from "./fake-kernel.js";

const never = new AbortController().signal;
const source = { accountId: "acc_1", accountName: "Ada", via: "web" as const };
const r = (op: KernelReq["op"], args: unknown, id = "x"): KernelReq => ({
  type: "req",
  id,
  op,
  args,
  deadlineMs: 1000,
});

let dir: string;
let store: PolicyStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-policy-op-id-"));
  store = new PolicyStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const serve = (req: KernelReq) =>
  serveOp(new FakeExecutor(), req, never, { policy: store, platform: "darwin" });
const logged = (): unknown[] => JSON.parse(readFileSync(policyOpsPath(dir), "utf8"));

describe("policy ops by op id", () => {
  it("a policy op records started, then applied, in policy-ops.json", async () => {
    // the file as the change is about to be written already says the op started
    let duringUpdate: unknown;
    const update = store.update.bind(store);
    store.update = (change, opts) =>
      update((p) => {
        duringUpdate = logged();
        return change(p);
      }, opts);
    const { res } = await serve(r("policy", { opId: "op_1", add: ["a.com"], source }));
    expect(res).toMatchObject({ ok: true, result: { policy: { allowedDomains: ["a.com"] } } });
    expect(duringUpdate).toEqual([{ opId: "op_1", outcome: "started", time: expect.any(String) }]);
    expect(logged()).toEqual([{ opId: "op_1", outcome: "applied", time: expect.any(String) }]);
    expect((statSync(policyOpsPath(dir)).mode & 0o777).toString(8)).toBe("600");
  });

  it("a refused op is recorded refused with its message", async () => {
    writePolicy(dir, { ...DEFAULT_POLICY, remoteGrants: "off" });
    const { res } = await serve(r("policy", { opId: "op_2", add: ["a.com"], source }));
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: REMOTE_GRANTS_OFF_MESSAGE },
    });
    expect(logged()).toEqual([
      {
        opId: "op_2",
        outcome: "refused",
        message: REMOTE_GRANTS_OFF_MESSAGE,
        kind: "policy",
        time: expect.any(String),
      },
    ]);
    // refused before the file is touched (an invalid host) is recorded the same way
    const bad = await serve(r("policy", { opId: "op_3", add: ["not a host"], source }));
    expect(bad.res).toMatchObject({ ok: false, error: { kind: "policy" } });
    expect(new PolicyOpLog(dir).get("op_3")).toMatchObject({ outcome: "refused" });
  });

  it("a repeated opId is answered from the log and policy.json is not rewritten", async () => {
    const first = await serve(r("policy", { opId: "op_1", add: ["a.com"], source }, "r1"));
    const before = statSync(policyPath(dir));
    // the same op id again (another request id), with different content: nothing is applied
    const again = await serve(r("policy", { opId: "op_1", add: ["b.com"], source }, "r2"));
    expect(again.res).toEqual({ ...first.res, id: "r2" });
    const after = statSync(policyPath(dir));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(store.current().allowedDomains).toEqual(["a.com"]);
    // a refusal is answered with its stored message
    writePolicy(dir, { ...DEFAULT_POLICY, remoteGrants: "off" });
    const refused = await serve(r("policy", { opId: "op_2", add: ["c.com"], source }, "r3"));
    writePolicy(dir, { ...DEFAULT_POLICY, remoteGrants: "owner" });
    const repeat = await serve(r("policy", { opId: "op_2", add: ["c.com"], source }, "r4"));
    expect(repeat.res).toEqual({ ...refused.res, id: "r4" });
    expect(store.current().allowedDomains).toEqual([]);
  });

  it("a policy op without a valid opId is refused and applies nothing", async () => {
    for (const opId of [undefined, "", "a:b", 1]) {
      const { res } = await serve(r("policy", { opId, add: ["a.com"], source }));
      expect(res, String(opId)).toMatchObject({ ok: false, error: { kind: "error" } });
    }
    expect(store.current().allowedDomains).toEqual([]);
    expect(new PolicyOpLog(dir).entries()).toEqual([]);
  });

  it("policyStatus answers unknown for an id never seen", async () => {
    const unknown = await serve(r("policyStatus", { opId: "nope" }));
    expect(unknown.res).toEqual({
      type: "res",
      id: "x",
      ok: true,
      result: { outcome: "unknown", policy: expect.objectContaining({ allowedDomains: [] }) },
    });
    await serve(r("policy", { opId: "op_1", add: ["a.com"], source }));
    const applied = await serve(r("policyStatus", { opId: "op_1" }));
    expect(applied.res).toMatchObject({
      ok: true,
      result: { outcome: "applied", policy: { allowedDomains: ["a.com"] } },
    });
    writePolicy(dir, { ...DEFAULT_POLICY, remoteGrants: "off" });
    await serve(r("policy", { opId: "op_2", add: ["b.com"], source }));
    const refused = await serve(r("policyStatus", { opId: "op_2" }));
    expect(refused.res).toMatchObject({
      ok: true,
      result: { outcome: "refused", message: REMOTE_GRANTS_OFF_MESSAGE },
    });
    // an op the device was stopped in the middle of stays started
    new PolicyOpLog(dir).record({ opId: "op_3", outcome: "started" });
    const started = await serve(r("policyStatus", { opId: "op_3" }));
    expect(started.res).toMatchObject({ ok: true, result: { outcome: "started" } });
    // without a policy store the op is unsupported
    const none = await serveOp(new FakeExecutor(), r("policyStatus", { opId: "op_1" }), never);
    expect(none.res).toMatchObject({ ok: false, error: { kind: "error" } });
  });

  it("the log keeps the last outcomes, oldest dropped", () => {
    const log = new PolicyOpLog(dir);
    for (let i = 0; i < MAX_LOGGED_POLICY_OPS + 5; i++) {
      log.record({ opId: `op${i}`, outcome: "applied" });
    }
    const entries = log.entries();
    expect(MAX_LOGGED_POLICY_OPS).toBe(100);
    expect(entries).toHaveLength(MAX_LOGGED_POLICY_OPS);
    expect(entries[0]?.opId).toBe("op5");
    expect(log.get("op4")).toBeUndefined();
    // a later outcome of the same op replaces its entry and moves it last
    log.record({ opId: "op5", outcome: "refused", message: "no" });
    expect(log.entries().at(-1)).toMatchObject({ opId: "op5", outcome: "refused" });
    expect(log.entries()).toHaveLength(MAX_LOGGED_POLICY_OPS);
  });

  it("an unreadable log reads as empty and is replaced at the next op", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(policyOpsPath(dir), "{not json");
    expect(new PolicyOpLog(dir).entries()).toEqual([]);
    await serve(r("policy", { opId: "op_1", add: ["a.com"], source }));
    expect(new PolicyOpLog(dir).get("op_1")).toMatchObject({ outcome: "applied" });
  });
});

describe("the hello and op outcomes", () => {
  let kernel: FakeKernel;
  let conn: Connection | undefined;
  beforeEach(async () => {
    kernel = new FakeKernel();
    await kernel.start();
    conn = undefined;
  });
  afterEach(async () => {
    conn?.stop();
    await conn?.done;
    await kernel.stop();
  });
  const start = (withStore: boolean) => {
    conn = connect(
      {
        url: "http://x.test",
        connectUrl: kernel.url,
        credential: "cap_dev_secret",
        orgId: "o",
        deviceId: "e1",
        dir: "/work/e1",
        mode: "os",
        reconnectGraceSeconds: 120,
        maxFrameBytes: 16 * 1024 * 1024,
      },
      new FakeExecutor(),
      {
        err: () => {},
        sleep: () => Promise.resolve(),
        ...(withStore && { policy: store }),
      },
    );
  };

  it("hello carries the last 100 outcomes, oldest dropped", async () => {
    const log = new PolicyOpLog(dir);
    for (let i = 0; i < 105; i++) {
      log.record({ opId: `op${i}`, outcome: i % 2 === 0 ? "applied" : "refused", message: "m" });
    }
    log.record({ opId: "op_started", outcome: "started" });
    start(true);
    const hello = await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    expect(hello.recentOps).toHaveLength(100);
    expect(hello.recentOps[0]).toEqual({ opId: "op6", outcome: "applied" });
    expect(hello.recentOps.at(-1)).toEqual({ opId: "op_started", outcome: "started" });
    // an op answered on this connection shows on the next hello
    kernel.send(0, r("policy", { opId: "op_new", add: ["a.com"], source }, "p1"));
    await kernel.waitFor("res", () => kernel.of("res")[0]);
    kernel.sockets[0]?.close(1001);
    const again = await kernel.waitFor("reconnect", () => kernel.of("hello", 1)[0]);
    expect(again.recentOps.at(-1)).toEqual({ opId: "op_new", outcome: "applied" });
    expect(again.recentOps).toHaveLength(100);
  });

  it("the hello announces policyOpId only with a policy store", async () => {
    start(true);
    const hello = await kernel.waitFor("hello", () => kernel.of("hello")[0]);
    expect(hello.features).toEqual(["networkReport", "policyOp", "policyOpId", "tiers"]);
    expect(hello.recentOps).toEqual([]);
    conn?.stop();
    await conn?.done;
    start(false);
    const bare = await kernel.waitFor("hello", () => kernel.of("hello", 1)[0]);
    expect(bare.features).toEqual(["networkReport", "tiers"]);
    expect(bare.recentOps).toBeUndefined();
  });
});
