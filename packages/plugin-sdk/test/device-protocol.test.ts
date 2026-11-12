import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_ROOTS,
  type DeviceHello,
  DeviceProtocolError,
  MAX_NETWORK_BLOCKED_HOSTS,
  parseDeviceFrame,
  parseOpResult,
  rootsOf,
} from "../src/index.js";

const hello = {
  type: "hello",
  protocol: 1,
  programVersion: "0.1.0",
  os: "darwin",
  arch: "arm64",
  mode: "os",
  roots: { workspace: "/w", skills: "/s", tmp: "/t" },
  sessionIsolation: true,
};

describe("device protocol", () => {
  it("parses a hello from the device", () => {
    const f = parseDeviceFrame(JSON.stringify(hello), "device");
    expect(f.type).toBe("hello");
  });

  it("rejects a req sent by the device", () => {
    const req = { type: "req", id: "1", op: "stop", args: { reason: "revoked" }, deadlineMs: 5 };
    expect(() => parseDeviceFrame(JSON.stringify(req), "device")).toThrow(DeviceProtocolError);
    expect(parseDeviceFrame(JSON.stringify(req), "kernel").type).toBe("req");
  });

  it("rejects a res without id", () => {
    const res = { type: "res", ok: true, result: null };
    expect(() => parseDeviceFrame(JSON.stringify(res), "device")).toThrow(DeviceProtocolError);
  });

  it("rejects bad JSON and unknown types", () => {
    expect(() => parseDeviceFrame("{", "device")).toThrow(DeviceProtocolError);
    expect(() => parseDeviceFrame('{"type":"x"}', "device")).toThrow(DeviceProtocolError);
  });

  it("rootsOf falls back to DEFAULT_SANDBOX_ROOTS", () => {
    expect(rootsOf({ id: "a" })).toEqual(DEFAULT_SANDBOX_ROOTS);
    const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
    expect(rootsOf({ id: "a", roots })).toBe(roots);
  });

  it("rejects a hello with a relative root", () => {
    const bad = { ...hello, roots: { ...hello.roots, workspace: "workspace" } };
    expect(() => parseDeviceFrame(JSON.stringify(bad), "device")).toThrow(DeviceProtocolError);
  });

  it("rejects roots with a trailing slash, empty or .. segments, or control characters", () => {
    for (const workspace of ["/w/", "/", "/a//w", "/a/../w", "/a/..", "/a/\u0001w"]) {
      const bad = { ...hello, roots: { ...hello.roots, workspace } };
      expect(() => parseDeviceFrame(JSON.stringify(bad), "device"), workspace).toThrow(
        DeviceProtocolError,
      );
      expect(() => parseOpResult("create", { roots: bad.roots }), workspace).toThrow(
        DeviceProtocolError,
      );
    }
    const ok = { workspace: "/Users/u/capybara-device/e1/workspace", skills: "/s", tmp: "/t" };
    expect(parseOpResult("create", { roots: ok }).roots).toEqual(ok);
  });

  const parse = (o: unknown, from: "device" | "kernel") => () =>
    parseDeviceFrame(JSON.stringify(o), from);
  const limits = {
    cpu: 1,
    memoryMb: 512,
    diskMb: 1024,
    egress: "none",
    allowHosts: [],
    tier: "strict",
    devHosts: [],
  };
  const exec = {
    command: "ls",
    timeoutMs: 1000,
    maxOutputBytes: 100,
    tag: "t",
    actor: { accountId: "a", conversationId: "c" },
    limits,
  };
  const req = (op: string, args: unknown) => ({ type: "req", id: "1", op, args, deadlineMs: 5 });
  const resOk = { type: "res", id: "1", ok: true, result: null };
  const resErr = { type: "res", id: "1", ok: false, error: { kind: "gone", message: "m" } };
  const cancel = { type: "cancel", id: "1" };

  it("rejects each frame type in the wrong direction", () => {
    expect(parse(hello, "kernel")).toThrow(DeviceProtocolError);
    expect(parse(resOk, "kernel")).toThrow(DeviceProtocolError);
    expect(parse(req("killAll", {}), "device")).toThrow(DeviceProtocolError);
    expect(parse(cancel, "device")).toThrow(DeviceProtocolError);
  });

  it("parses every frame type", () => {
    expect(parse(hello, "device")().type).toBe("hello");
    expect(parse(resOk, "device")()).toEqual(resOk);
    expect(parse(resErr, "device")()).toEqual(resErr);
    expect(parse(req("exec", exec), "kernel")().type).toBe("req");
    expect(parse(cancel, "kernel")()).toEqual(cancel);
  });

  it("rejects bad hello fields", () => {
    for (const bad of [
      { os: "win32" },
      { mode: "vm" },
      { sessionIsolation: "yes" },
      { protocol: 1.5 },
      { protocol: 0 },
      { roots: { ...hello.roots, tmp: "C:\\w" } },
      { roots: { ...hello.roots, tmp: "C:/w" } },
    ]) {
      expect(parse({ ...hello, ...bad }, "device")).toThrow(DeviceProtocolError);
    }
  });

  it("rejects bad res and cancel frames", () => {
    for (const bad of [
      { ...resErr, error: { kind: "weird", message: "m" } },
      { ...resErr, error: { kind: "gone" } },
      { type: "res", id: "1", result: null },
      { ...resOk, ok: "true" },
    ]) {
      expect(parse(bad, "device")).toThrow(DeviceProtocolError);
    }
    expect(parse({ type: "cancel" }, "kernel")).toThrow(DeviceProtocolError);
  });

  it("rejects non-object frames", () => {
    expect(() => parseDeviceFrame("[]", "device")).toThrow(DeviceProtocolError);
    expect(() => parseDeviceFrame("null", "device")).toThrow(DeviceProtocolError);
  });

  it("rejects a bad deadline, unknown op and bad args per op", () => {
    expect(parse({ ...req("killAll", {}), deadlineMs: 1.5 }, "kernel")).toThrow(
      DeviceProtocolError,
    );
    expect(parse({ ...req("killAll", {}), deadlineMs: 0 }, "kernel")).toThrow(DeviceProtocolError);
    expect(parse(req("nope", {}), "kernel")).toThrow(DeviceProtocolError);
    const bads: [string, unknown][] = [
      ["exec", "x"],
      ["exec", { ...exec, command: 1 }],
      ["exec", { ...exec, timeoutMs: 0 }],
      ["exec", { ...exec, maxOutputBytes: 1.5 }],
      ["exec", { ...exec, tag: 1 }],
      ["exec", { ...exec, actor: { accountId: "a" } }],
      ["exec", { ...exec, limits: { ...limits, egress: "x" } }],
      ["exec", { ...exec, limits: { ...limits, allowHosts: [1] } }],
      ["exec", { ...exec, limits: { ...limits, tier: undefined } }],
      ["exec", { ...exec, limits: { ...limits, tier: "wide" } }],
      ["exec", { ...exec, limits: { ...limits, devHosts: undefined } }],
      ["exec", { ...exec, limits: { ...limits, devHosts: ["10.0.0.1"] } }],
      ["exec", { ...exec, limits: { ...limits, devHosts: [1] } }],
      ["exec", { ...exec, limits: { ...limits, defaultTier: "x" } }],
      ["exec", { ...exec, limits: { ...limits, allowUnsandboxed: "yes" } }],
      ["exec", { ...exec, cwd: 1 }],
      ["exec", { ...exec, env: { A: 1 } }],
      ["readFile", { path: "/a", maxBytes: -1 }],
      ["readFile", { path: 1, maxBytes: 1 }],
      ["writeFile", { path: "/a" }],
      ["stat", {}],
      ["killTagged", { tags: [1] }],
      ["killAll", []],
      ["create", {}],
      ["stop", { reason: "x" }],
    ];
    for (const [op, args] of bads) {
      expect(parse(req(op, args), "kernel"), op).toThrow(DeviceProtocolError);
    }
    const goods: [string, unknown][] = [
      ["exec", { ...exec, cwd: "/w", env: { A: "b" } }],
      ["readFile", { path: "/a", maxBytes: 0 }],
      ["writeFile", { path: "/a", dataB64: "" }],
      ["stat", { path: "/a" }],
      ["killTagged", { tags: ["a"] }],
      ["create", { limits }],
      [
        "exec",
        {
          ...exec,
          limits: { ...limits, tier: "open", defaultTier: "dev", devHosts: ["registry.npmjs.org"] },
        },
      ],
      ["exec", { ...exec, limits: { ...limits, tier: "open", allowUnsandboxed: true } }],
      ["stop", { reason: "deleted" }],
    ];
    for (const [op, args] of goods) expect(parse(req(op, args), "kernel")().type).toBe("req");
  });

  it("parseOpResult validates results per op", () => {
    const execRes = { exitCode: null, stdout: "", stderr: "", truncated: false, timedOut: true };
    expect(parseOpResult("exec", execRes)).toEqual(execRes);
    expect(parseOpResult("exec", { ...execRes, exitCode: 0 }).exitCode).toBe(0);
    expect(() => parseOpResult("exec", { ...execRes, stdout: 1 })).toThrow(DeviceProtocolError);
    expect(() => parseOpResult("exec", { ...execRes, exitCode: "0" })).toThrow(DeviceProtocolError);
    expect(parseOpResult("readFile", null)).toBeNull();
    expect(parseOpResult("readFile", { dataB64: "", truncated: false })).toEqual({
      dataB64: "",
      truncated: false,
    });
    expect(() => parseOpResult("readFile", { dataB64: "" })).toThrow(DeviceProtocolError);
    expect(parseOpResult("stat", null)).toBeNull();
    expect(parseOpResult("stat", { size: 1, isDir: false })).toEqual({ size: 1, isDir: false });
    expect(() => parseOpResult("stat", { size: 1 })).toThrow(DeviceProtocolError);
    for (const op of ["writeFile", "killTagged", "killAll", "stop"] as const) {
      expect(parseOpResult(op, null)).toBeNull();
      expect(() => parseOpResult(op, {})).toThrow(DeviceProtocolError);
    }
    expect(parseOpResult("create", { roots: hello.roots }).roots).toEqual(hello.roots);
    expect(() => parseOpResult("create", { roots: { ...hello.roots, tmp: "t" } })).toThrow(
      DeviceProtocolError,
    );
    expect(() => parseOpResult("create", null)).toThrow(DeviceProtocolError);
  });

  describe("network reports (exec result)", () => {
    const base = { exitCode: 1, stdout: "", stderr: "", truncated: false, timedOut: false };

    it("works without network and keeps a valid report", () => {
      expect(parseOpResult("exec", base)).toEqual(base);
      const blocked = [
        { host: "files.slack.com", port: 443, layer: "device" },
        { host: "api.foo.com", port: 80, layer: "org" },
        { host: "10.0.0.5", port: 22, layer: "address" },
        { host: "[::1]", port: 443, layer: "address" },
        { host: "weird.example.org", port: 8080, layer: "unknown" },
      ];
      expect(parseOpResult("exec", { ...base, network: { blocked } })).toEqual({
        ...base,
        network: { blocked },
      });
    });

    it("drops entries with an unknown layer, a bad host or a bad port", () => {
      const r = parseOpResult("exec", {
        ...base,
        network: {
          blocked: [
            { host: "ok.example.com", port: 443, layer: "device" },
            { host: "ok.example.com", port: 443, layer: "planet" },
            { host: "10.0.0.5", port: 443, layer: "device" },
            { host: "localhost", port: 443, layer: "org" },
            { host: "", port: 443, layer: "address" },
            { host: "a.example.com", port: 0, layer: "device" },
            { host: "a.example.com", port: 65536, layer: "device" },
            { host: "a.example.com", port: 1.5, layer: "device" },
            { host: "a.example.com", port: "443", layer: "device" },
            "x",
            null,
          ],
        },
      });
      expect(r.network).toEqual({
        blocked: [{ host: "ok.example.com", port: 443, layer: "device" }],
      });
    });

    it("drops a malformed report without failing the result", () => {
      for (const network of ["x", null, [], { blocked: "x" }, { blocked: {} }]) {
        const r = parseOpResult("exec", { ...base, network });
        expect(r, JSON.stringify(network)).toEqual(base);
        expect("network" in r).toBe(false);
      }
    });

    it(`cuts the report to ${MAX_NETWORK_BLOCKED_HOSTS} hosts`, () => {
      const blocked = Array.from({ length: 30 }, (_, i) => ({
        host: `h${i}.example.com`,
        port: 443,
        layer: "device",
      }));
      const r = parseOpResult("exec", { ...base, network: { blocked } });
      expect(r.network?.blocked).toHaveLength(MAX_NETWORK_BLOCKED_HOSTS);
      expect(r.network?.blocked[0]?.host).toBe("h0.example.com");
    });
  });

  describe("hello features and policy summary", () => {
    const summary = {
      effectiveTier: "strict",
      isolation: "sandbox",
      localhost: "off",
      unixSockets: "roots",
      allowedDomains: ["files.slack.com", "*.github.com"],
      remoteGrants: "owner",
    };
    const parseHello = (o: unknown) => parseDeviceFrame(JSON.stringify(o), "device") as DeviceHello;

    it("still parses a hello without them", () => {
      const h = parseHello(hello);
      expect(h.features).toBeUndefined();
      expect(h.policy).toBeUndefined();
    });

    it("keeps known features and a valid policy summary", () => {
      const h = parseHello({
        ...hello,
        features: ["networkReport", "teleport", "policyOp", "tiers", 3],
        policy: summary,
      });
      expect(h.features).toEqual(["networkReport", "policyOp", "tiers"]);
      expect(h.policy).toEqual(summary);
      expect(h.policy?.tier).toBeUndefined();
      const chosen = { ...summary, tier: "open", effectiveTier: "open", isolation: "none" };
      expect(parseHello({ ...hello, policy: chosen }).policy).toEqual(chosen);
    });

    it("ignores malformed features and policy summaries", () => {
      expect(parseHello({ ...hello, features: "networkReport" }).features).toBeUndefined();
      for (const policy of [
        "x",
        null,
        { ...summary, tier: "wide" },
        { ...summary, effectiveTier: undefined },
        { ...summary, isolation: "off" },
        { ...summary, localhost: "yes" },
        { ...summary, unixSockets: "some" },
        { ...summary, remoteGrants: "anyone" },
        { ...summary, allowedDomains: [1] },
        { ...summary, allowedDomains: "a.com" },
        { effectiveTier: "strict", remoteGrants: "off" },
      ]) {
        expect(parseHello({ ...hello, policy }).policy, JSON.stringify(policy)).toBeUndefined();
      }
    });
  });

  describe("the policy op", () => {
    const source = { accountId: "acc_1", accountName: "Ann", via: "web" };

    it("validates the args", () => {
      const goods: unknown[] = [
        { source },
        { add: ["a.example.com"], source: { ...source, approvalId: "ap_1", via: "im" } },
        { remove: ["a.example.com"], tier: "strict", source },
        { tier: "open", source },
        { tier: null, source },
        { isolation: "sandbox", source },
        { add: Array.from({ length: 100 }, (_, i) => `h${i}.example.com`), source },
      ];
      for (const args of goods) {
        expect(parse(req("policy", args), "kernel")().type, JSON.stringify(args)).toBe("req");
      }
      const bads: unknown[] = [
        {},
        { add: ["a.example.com"] },
        { add: "a.example.com", source },
        { add: [1], source },
        { remove: [null], source },
        { add: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`), source },
        { remove: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`), source },
        { tier: "wide", source },
        { tier: 1, source },
        { isolation: "none", source },
        { isolation: null, source },
        { source: { ...source, via: "pat" } },
        { source: { ...source, accountId: 1 } },
        { source: { accountId: "acc_1", via: "web" } },
        { source: { ...source, approvalId: 1 } },
        { source: "x" },
      ];
      for (const args of bads) {
        expect(parse(req("policy", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
    });

    it("validates the result", () => {
      const policy = {
        tier: "dev",
        effectiveTier: "dev",
        isolation: "sandbox",
        localhost: "off-proxy-detected",
        unixSockets: "all-masked",
        allowedDomains: ["a.example.com"],
        remoteGrants: "off",
      };
      expect(parseOpResult("policy", { policy })).toEqual({ policy });
      for (const bad of [
        null,
        {},
        { policy: { ...policy, tier: "x" } },
        { policy: { ...policy, effectiveTier: undefined } },
        { policy: { ...policy, isolation: "x" } },
        { policy: { ...policy, allowedDomains: [1] } },
        { policy: { ...policy, remoteGrants: "x" } },
      ]) {
        expect(() => parseOpResult("policy", bad), JSON.stringify(bad)).toThrow(
          DeviceProtocolError,
        );
      }
    });
  });

  describe("exec grants and run id", () => {
    const grants = {
      hosts: ["a.example.com"],
      source: { kind: "run", id: "run_1", accountId: "a" },
    };

    it("accepts exec args with and without grants and runId", () => {
      const goods: unknown[] = [
        { ...exec, grants },
        { ...exec, grants: { ...grants, source: { ...grants.source, kind: "task" } } },
        { ...exec, grants: { ...grants, hosts: [] } },
        { ...exec, actor: { ...exec.actor, runId: "run_1" } },
      ];
      for (const args of goods) {
        expect(parse(req("exec", args), "kernel")().type, JSON.stringify(args)).toBe("req");
      }
    });

    it("rejects malformed grants and runId", () => {
      const bads: unknown[] = [
        { ...exec, grants: "x" },
        { ...exec, grants: { hosts: "a.example.com", source: grants.source } },
        { ...exec, grants: { hosts: [1], source: grants.source } },
        {
          ...exec,
          grants: {
            hosts: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`),
            source: grants.source,
          },
        },
        { ...exec, grants: { hosts: [] } },
        { ...exec, grants: { ...grants, source: { ...grants.source, kind: "forever" } } },
        { ...exec, grants: { ...grants, source: { kind: "run", accountId: "a" } } },
        { ...exec, grants: { ...grants, source: { kind: "run", id: "r" } } },
        { ...exec, actor: { ...exec.actor, runId: 1 } },
      ];
      for (const args of bads) {
        expect(parse(req("exec", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
    });
  });
});
