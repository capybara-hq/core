import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceOwnerCeiling,
  type KernelRequest,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MacOperationBackend } from "../src/exec/mac-operation-backend.js";
import {
  MAX_LOGGED_MESSAGE_LENGTH,
  MAX_LOGGED_POLICY_OPS,
  PolicyOpLog,
} from "../src/policy-ops.js";
import { PolicyStore } from "../src/policy-store.js";
import { type StagedOwnerPolicy, serveOperationV3 } from "../src/server-ops.js";
import { DEFAULT_POLICY, policyOpsPath, policyPath, writePolicy } from "../src/state.js";

const never = new AbortController().signal;
const source = { accountId: "acc_1", accountName: "Ada", via: "web" as const };
const r = (op: string, args: unknown, id = "x") =>
  ({ type: "req", id, op, args, deadlineMs: 1000 }) as KernelRequest;
/** A valid owner report; its content is not what these tests are about. */
const REPORT: DeviceOwnerCeiling = {
  version: 3,
  sequence: 0,
  revision: "rev",
  outsideSandbox: false,
  network: "allowlist",
  restrictedProjectReach: "workspace",
  allowedDomains: [],
};
/** A policy op the device itself refuses (the frame is valid): a host to remove that is none. */
const refusedArgs = (opId: string) => ({ opId, remove: ["not a host"], source });
const REFUSED_MESSAGE = `"not a host": ${validateAllowHost("not a host").join("; ")}`;
/** Seeds the policy file with these sandbox hosts. */
const seed = (allowedDomains: string[]) => writePolicy(dir, { ...DEFAULT_POLICY, allowedDomains });

let dir: string;
let store: PolicyStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "device-policy-op-id-"));
  store = new PolicyStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const owner = (): StagedOwnerPolicy => ({ store, report: () => REPORT, reconcile: async () => {} });
const backend = {} as MacOperationBackend;
/** Served by the device's one dispatch, with the owner policy controls. */
const serve = async (req: KernelRequest) => ({
  res: await serveOperationV3(backend, { id: "dev" }, req, never, undefined, owner()),
});
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
    seed(["a.com", "b.com"]);
    const { res } = await serve(r("policy", { opId: "op_1", remove: ["a.com"], source }));
    expect(res).toMatchObject({ ok: true, result: { policy: { allowedDomains: ["b.com"] } } });
    expect(duringUpdate).toEqual([{ opId: "op_1", outcome: "started", time: expect.any(String) }]);
    expect(logged()).toEqual([{ opId: "op_1", outcome: "applied", time: expect.any(String) }]);
    expect((statSync(policyOpsPath(dir)).mode & 0o777).toString(8)).toBe("600");
  });

  it("a refused op is recorded refused with its message", async () => {
    const { res } = await serve(r("policy", refusedArgs("op_2")));
    expect(res).toMatchObject({
      ok: false,
      error: { kind: "policy", message: REFUSED_MESSAGE },
    });
    expect(logged()).toEqual([
      {
        opId: "op_2",
        outcome: "refused",
        message: REFUSED_MESSAGE,
        kind: "policy",
        time: expect.any(String),
      },
    ]);
    // refused before the file is touched (an invalid host) is recorded the same way
    const bad = await serve(r("policy", { opId: "op_3", remove: ["10.0.0.1"], source }));
    expect(bad.res).toMatchObject({ ok: false, error: { kind: "policy" } });
    expect(new PolicyOpLog(dir).get("op_3")).toMatchObject({ outcome: "refused" });
  });

  it("a repeated opId is answered from the log and policy.json is not rewritten", async () => {
    seed(["a.com", "b.com"]);
    const first = await serve(r("policy", { opId: "op_1", remove: ["a.com"], source }, "r1"));
    const before = statSync(policyPath(dir));
    // the same op id again (another request id), with different content: nothing is applied
    const again = await serve(r("policy", { opId: "op_1", remove: ["b.com"], source }, "r2"));
    expect(again.res).toEqual({ ...first.res, id: "r2" });
    const after = statSync(policyPath(dir));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(store.current().allowedDomains).toEqual(["b.com"]);
    // a refusal is answered with its stored message
    const refused = await serve(r("policy", refusedArgs("op_2"), "r3"));
    const repeat = await serve(r("policy", refusedArgs("op_2"), "r4"));
    expect(repeat.res).toEqual({ ...refused.res, id: "r4" });
    expect(store.current().allowedDomains).toEqual(["b.com"]);
  });

  it("a policy op without a valid opId is refused and applies nothing", async () => {
    for (const opId of [undefined, "", "a:b", 1]) {
      const { res } = await serve(r("policy", { opId, remove: ["a.com"], source }));
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
      result: { outcome: "unknown", policy: { allowedDomains: [] } },
    });
    seed(["a.com", "b.com"]);
    await serve(r("policy", { opId: "op_1", remove: ["a.com"], source }));
    const applied = await serve(r("policyStatus", { opId: "op_1" }));
    expect(applied.res).toMatchObject({
      ok: true,
      result: { outcome: "applied", policy: { allowedDomains: ["b.com"] } },
    });
    await serve(r("policy", refusedArgs("op_2")));
    const refused = await serve(r("policyStatus", { opId: "op_2" }));
    expect(refused.res).toMatchObject({
      ok: true,
      result: { outcome: "refused", message: REFUSED_MESSAGE },
    });
    // an op the device was stopped in the middle of stays started
    new PolicyOpLog(dir).record({ opId: "op_3", outcome: "started" });
    const started = await serve(r("policyStatus", { opId: "op_3" }));
    expect(started.res).toMatchObject({ ok: true, result: { outcome: "started" } });
    // without the owner policy controls the op is unsupported
    const none = await serveOperationV3(
      backend,
      { id: "dev" },
      r("policyStatus", { opId: "op_1" }),
      never,
    );
    expect(none).toMatchObject({ ok: false, error: { kind: "unsupported" } });
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

  it("a refusal's message is logged cut to 500 characters", () => {
    const log = new PolicyOpLog(dir);
    log.record({ opId: "op1", outcome: "refused", message: "x".repeat(2_000) });
    expect(MAX_LOGGED_MESSAGE_LENGTH).toBe(500);
    expect(log.get("op1")?.message).toBe("x".repeat(500));
  });

  it("an unreadable log reads as empty and is replaced at the next op", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(policyOpsPath(dir), "{not json");
    expect(new PolicyOpLog(dir).entries()).toEqual([]);
    await serve(r("policy", { opId: "op_1", remove: ["a.com"], source }));
    expect(new PolicyOpLog(dir).get("op_1")).toMatchObject({ outcome: "applied" });
  });
});

describe("the op outcomes the hello carries", () => {
  it("the last 100 outcomes, oldest dropped, an interrupted op included", async () => {
    const log = new PolicyOpLog(dir);
    for (let i = 0; i < 105; i++) {
      log.record({ opId: `op${i}`, outcome: i % 2 === 0 ? "applied" : "refused", message: "m" });
    }
    log.record({ opId: "op_started", outcome: "started" });
    const recent = store.ops.recent();
    expect(recent).toHaveLength(100);
    expect(recent[0]).toEqual({ opId: "op6", outcome: "applied" });
    expect(recent.at(-1)).toEqual({ opId: "op_started", outcome: "started" });
    // an op answered now shows in the next report
    await serve(r("policy", { opId: "op_new", remove: ["a.com"], source }, "p1"));
    expect(store.ops.recent().at(-1)).toEqual({ opId: "op_new", outcome: "applied" });
    expect(store.ops.recent()).toHaveLength(100);
  });
});
