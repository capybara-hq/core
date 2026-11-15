import { describe, expect, it } from "vitest";
import {
  BACKGROUND_LAUNCH_LINE,
  DEFAULT_SANDBOX_ROOTS,
  type DeviceHello,
  type DeviceLocalPolicySummary,
  type DevicePolicyStatus,
  DeviceProtocolError,
  isBackgroundLaunch,
  isDeviceProjectName,
  MAX_DEVICE_LIST_ENTRIES,
  MAX_DEVICE_PROJECT_NAME_LENGTH,
  MAX_DEVICE_SCAN_RESULTS,
  MAX_NETWORK_BLOCKED_HOSTS,
  MAX_POLICY_OP_ID_LENGTH,
  MAX_RECENT_POLICY_OPS,
  parseDeviceFrame,
  parseOpResult,
  rootsOf,
} from "../src/index.js";

const hello = {
  type: "hello",
  protocol: 2,
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
    mode: "auto",
    network: { kind: "allowlist", hosts: [] },
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
      ["exec", { ...exec, limits: { ...limits, mode: undefined } }],
      ["exec", { ...exec, limits: { ...limits, mode: "wide" } }],
      ["exec", { ...exec, limits: { ...limits, network: undefined } }],
      ["exec", { ...exec, limits: { ...limits, network: { ...limits.network, kind: "x" } } }],
      [
        "exec",
        { ...exec, limits: { ...limits, network: { ...limits.network, hosts: undefined } } },
      ],
      ["exec", { ...exec, limits: { ...limits, network: { ...limits.network, hosts: [1] } } }],
      [
        "exec",
        { ...exec, limits: { ...limits, network: { ...limits.network, hosts: ["10.0.0.1"] } } },
      ],
      ["exec", { ...exec, cwd: 1 }],
      ["exec", { ...exec, env: { A: 1 } }],
      ["readFile", { path: "/a", maxBytes: -1 }],
      ["readFile", { path: 1, maxBytes: 1 }],
      ["writeFile", { path: "/a" }],
      ["stat", {}],
      ["stat", { path: "/a" }],
      ["readFile", { path: "/a", maxBytes: 100 }],
      ["stat", { path: "/a", limits: { mode: "wide" } }],
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
      ["readFile", { path: "/a", maxBytes: 0, limits: { mode: "auto" } }],
      ["writeFile", { path: "/a", dataB64: "" }],
      ["stat", { path: "/a", limits: { mode: "sandbox" } }],
      ["killTagged", { tags: ["a"] }],
      ["create", { limits }],
      [
        "exec",
        {
          ...exec,
          limits: {
            ...limits,
            mode: "sandbox",
            network: { kind: "allowlist", hosts: ["registry.npmjs.org"] },
          },
        },
      ],
      ["exec", { ...exec, limits: { ...limits, network: { kind: "open-public", hosts: [] } } }],
      ["stop", { reason: "deleted" }],
    ];
    for (const [op, args] of goods) expect(parse(req(op, args), "kernel")().type).toBe("req");
  });

  it("names the nested path when network.hosts is malformed", () => {
    const bad = { ...exec, limits: { ...limits, network: { ...limits.network, hosts: [1] } } };
    expect(parse(req("exec", bad), "kernel")).toThrow(
      'field "network.hosts" must be an array of strings',
    );
    // a top-level array key keeps its own name
    expect(parse(req("killTagged", { tags: [1] }), "kernel")).toThrow(
      'field "tags" must be an array of strings',
    );
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
      mode: "sandbox",
      allowedDomains: ["files.slack.com", "*.github.com"],
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
        features: ["networkReport", "teleport", "policyOp", "mode", "projects", 3],
        policy: summary,
      });
      expect(h.features).toEqual(["networkReport", "policyOp", "mode", "projects"]);
      expect(h.policy).toEqual(summary);
      const auto = { ...summary, mode: "auto" };
      expect(parseHello({ ...hello, policy: auto }).policy).toEqual(auto);
    });

    it("drops the tiers feature and unreadable or legacy policy summaries (old devices)", () => {
      expect(parseHello({ ...hello, features: "networkReport" }).features).toBeUndefined();
      expect(parseHello({ ...hello, features: ["tiers"] }).features).toEqual([]);
      for (const policy of [
        "x",
        null,
        { ...summary, mode: "wide" },
        { ...summary, mode: undefined },
        { ...summary, allowedDomains: [1] },
        { ...summary, allowedDomains: "a.com" },
        { allowedDomains: ["a.example.com"] },
        // the old summary shape: no `mode`, so the kernel learns the policy later
        {
          effectiveTier: "strict",
          isolation: "sandbox",
          localhost: "off",
          unixSockets: "roots",
          allowedDomains: [],
          remoteGrants: "owner",
        },
      ]) {
        expect(parseHello({ ...hello, policy }).policy, JSON.stringify(policy)).toBeUndefined();
      }
    });

    it("a policy frame carries the summary now; only the device sends it", () => {
      const frame = (o: unknown) => parseDeviceFrame(JSON.stringify(o), "device");
      expect(frame({ type: "policy", policy: summary })).toEqual({
        type: "policy",
        policy: summary,
      });
      // an unreadable summary is dropped, never failing the connection
      expect(frame({ type: "policy", policy: { ...summary, mode: "wide" } })).toEqual({
        type: "policy",
      });
      expect(frame({ type: "policy" })).toEqual({ type: "policy" });
      expect(() =>
        parseDeviceFrame(JSON.stringify({ type: "policy", policy: summary }), "kernel"),
      ).toThrow(DeviceProtocolError);
    });
  });

  describe("no projects on the policy summary", () => {
    const summary = { mode: "sandbox", allowedDomains: ["files.slack.com"] };
    const parseHello = (o: unknown) => parseDeviceFrame(JSON.stringify(o), "device") as DeviceHello;

    it("drops a projects field a device still reports: the kernel keeps the projects", () => {
      const policy = { ...summary, projects: [{ name: "core", path: "/w/core" }] };
      expect(parseHello({ ...hello, policy }).policy).toEqual(summary);
      expect(parseDeviceFrame(JSON.stringify({ type: "policy", policy }), "device")).toEqual({
        type: "policy",
        policy: summary,
      });
      expect(parseOpResult("policy", { policy })).toEqual({ policy: summary });
      expect(parseOpResult("policyStatus", { outcome: "applied", policy }).policy).toEqual(summary);
    });

    it("refuses the removed project ops", () => {
      for (const op of ["projectList", "projectCandidates", "projectAdd", "projectRemove"]) {
        expect(parse(req(op, {}), "kernel"), op).toThrow(/unknown op/);
      }
    });
  });

  describe("the hello's home", () => {
    const parseHello = (o: unknown) => parseDeviceFrame(JSON.stringify(o), "device") as DeviceHello;

    it("keeps an absolute home and drops a malformed one", () => {
      expect(parseHello({ ...hello, home: "/Users/ann" }).home).toBe("/Users/ann");
      expect(parseHello(hello).home).toBeUndefined();
      for (const home of ["Users/ann", "", "/Users/../ann", "/Users/a\nn", 1, null]) {
        const h = parseHello({ ...hello, home });
        expect(h.home, JSON.stringify(home)).toBeUndefined();
        expect(h.type).toBe("hello");
      }
    });
  });

  describe("project names", () => {
    it("bounds a name: at most 64 code units, not . or .., no /, control characters or edge spaces", () => {
      expect(MAX_DEVICE_PROJECT_NAME_LENGTH).toBe(64);
      for (const v of ["core", "my project", ".dotfiles", "..x", "x".repeat(64), "核心"]) {
        expect(isDeviceProjectName(v), JSON.stringify(v)).toBe(true);
      }
      for (const v of [
        "",
        ".",
        "..",
        " core",
        "core ",
        " core",
        "a/b",
        "a\u007fb",
        "a\tb",
        "x".repeat(MAX_DEVICE_PROJECT_NAME_LENGTH + 1),
        1,
      ]) {
        expect(isDeviceProjectName(v), JSON.stringify(v)).toBe(false);
      }
    });
  });

  describe("the list op", () => {
    const limits = { mode: "sandbox" };

    it("parses the request, which carries the kernel's current ceiling", () => {
      const args = { path: "/w/core/.agents/skills", limit: 200, limits };
      expect(parse(req("list", args), "kernel")()).toMatchObject({ op: "list", args });
      expect(
        parse(
          req("list", { path: "/w", limit: MAX_DEVICE_LIST_ENTRIES, limits: { mode: "auto" } }),
          "kernel",
        )(),
      ).toMatchObject({ op: "list" });
    });

    it("rejects malformed args", () => {
      for (const args of [
        {},
        { path: "/w", limits },
        { limit: 10, limits },
        { path: "w", limit: 10, limits },
        { path: "/w/../etc", limit: 10, limits },
        { path: "/w//a", limit: 10, limits },
        { path: "/w", limit: 0, limits },
        { path: "/w", limit: 1.5, limits },
        { path: "/w", limit: MAX_DEVICE_LIST_ENTRIES + 1, limits },
        // the ceiling is required
        { path: "/w", limit: 10 },
        { path: "/w", limit: 10, limits: {} },
        { path: "/w", limit: 10, limits: { mode: "open" } },
        { path: "/w", limit: 10, limits: "sandbox" },
      ]) {
        expect(parse(req("list", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
    });

    it("parses the result: entries and truncated, or null for a missing path", () => {
      const r = {
        entries: [
          { name: "a", isDir: true },
          { name: "b.md", isDir: false, later: 1 },
        ],
        truncated: false,
      };
      expect(parseOpResult("list", r)).toEqual({
        entries: [
          { name: "a", isDir: true },
          { name: "b.md", isDir: false },
        ],
        truncated: false,
      });
      expect(parseOpResult("list", null)).toBeNull();
      for (const bad of [
        [],
        {},
        { entries: [] },
        { entries: [], truncated: "no" },
        { entries: [{ name: "", isDir: true }], truncated: false },
        { entries: [{ name: "a/b", isDir: true }], truncated: false },
        { entries: [{ name: ".", isDir: true }], truncated: false },
        { entries: [{ name: "..", isDir: true }], truncated: false },
        { entries: [{ name: "a" }], truncated: false },
        {
          entries: Array.from({ length: MAX_DEVICE_LIST_ENTRIES + 1 }, (_, i) => ({
            name: `e${i}`,
            isDir: false,
          })),
          truncated: true,
        },
      ]) {
        expect(() => parseOpResult("list", bad), JSON.stringify(bad).slice(0, 80)).toThrow(
          DeviceProtocolError,
        );
      }
      // a dotfile is an ordinary entry
      expect(
        parseOpResult("list", { entries: [{ name: ".git", isDir: true }], truncated: false }),
      ).toEqual({ entries: [{ name: ".git", isDir: true }], truncated: false });
    });
  });

  describe("the scan op", () => {
    const limits = { mode: "auto" };

    it("parses the request, which carries the kernel's current ceiling", () => {
      const args = { base: "/Users/ann", limits };
      expect(parse(req("scan", args), "kernel")()).toMatchObject({ op: "scan", args });
    });

    it("rejects malformed args", () => {
      for (const args of [
        {},
        { limits },
        { base: "", limits },
        { base: "Users/ann", limits },
        { base: "/Users/../ann", limits },
        { base: "/Users/a\nn", limits },
        { base: "/Users/ann" },
        { base: "/Users/ann", limits: { mode: "wide" } },
      ]) {
        expect(parse(req("scan", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
    });

    it("parses the result: at most 50 candidates with absolute paths and usable names", () => {
      expect(MAX_DEVICE_SCAN_RESULTS).toBe(50);
      const candidate = { path: "/Users/ann/code/core", suggestedName: "core" };
      expect(parseOpResult("scan", [])).toEqual([]);
      expect(parseOpResult("scan", [{ ...candidate, later: 1 }])).toEqual([candidate]);
      const full = Array.from({ length: MAX_DEVICE_SCAN_RESULTS }, (_, i) => ({
        path: `/w/p${i}`,
        suggestedName: `p${i}`,
      }));
      expect(parseOpResult("scan", full)).toEqual(full);
      for (const bad of [
        null,
        {},
        [1],
        [{ path: "/w/core" }],
        [{ suggestedName: "core" }],
        [{ path: "w/core", suggestedName: "core" }],
        [{ path: "/w/../core", suggestedName: "core" }],
        [{ path: "/w/co\nre", suggestedName: "core" }],
        [{ path: "/w/core", suggestedName: "" }],
        [{ path: "/w/core", suggestedName: "a/b" }],
        [{ path: "/w/core", suggestedName: "co\tre" }],
        // a name that breaks the rule is a provider bug: such a directory is skipped, never sent
        [{ path: "/w/..", suggestedName: ".." }],
        [{ path: "/w/core ", suggestedName: "core " }],
        [{ path: "/w/core", suggestedName: "x".repeat(MAX_DEVICE_PROJECT_NAME_LENGTH + 1) }],
        [...full, { path: "/w/one-more", suggestedName: "one-more" }],
      ]) {
        expect(() => parseOpResult("scan", bad), JSON.stringify(bad).slice(0, 80)).toThrow(
          DeviceProtocolError,
        );
      }
    });
  });

  describe("the policy op", () => {
    const source = { accountId: "acc_1", accountName: "Ann", via: "web" };
    const opId = "op_1";

    it("validates the args", () => {
      const goods: unknown[] = [
        { opId, source },
        { opId, add: ["a.example.com"], source: { ...source, approvalId: "ap_1", via: "im" } },
        { opId, remove: ["a.example.com"], source },
        { opId, mode: "sandbox", source },
        { opId, add: Array.from({ length: 100 }, (_, i) => `h${i}.example.com`), source },
      ];
      for (const args of goods) {
        expect(parse(req("policy", args), "kernel")().type, JSON.stringify(args)).toBe("req");
      }
      const bads: unknown[] = [
        {},
        { opId },
        { opId, add: ["a.example.com"] },
        { opId, add: "a.example.com", source },
        { opId, add: [1], source },
        { opId, remove: [null], source },
        { opId, add: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`), source },
        { opId, remove: Array.from({ length: 101 }, (_, i) => `h${i}.example.com`), source },
        // the kernel may narrow to sandbox only; auto mode is decided on the machine
        { opId, mode: "auto", source },
        { opId, mode: 1, source },
        { opId, mode: null, source },
        { opId, source: { ...source, via: "pat" } },
        { opId, source: { ...source, accountId: 1 } },
        { opId, source: { accountId: "acc_1", via: "web" } },
        { opId, source: { ...source, approvalId: 1 } },
        { opId, source: "x" },
      ];
      for (const args of bads) {
        expect(parse(req("policy", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
    });

    it("a policy op without opId is a protocol error", () => {
      for (const args of [
        { source },
        { opId: "", source },
        { opId: 1, source },
        { opId: "op:1", source },
        { opId: "x".repeat(MAX_POLICY_OP_ID_LENGTH + 1), source },
      ]) {
        expect(parse(req("policy", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
      const longest = { opId: "x".repeat(MAX_POLICY_OP_ID_LENGTH), source };
      expect(parse(req("policy", longest), "kernel")().type).toBe("req");
    });

    it("policyStatus args and result round-trip", () => {
      const f = parseDeviceFrame(JSON.stringify(req("policyStatus", { opId })), "kernel");
      expect(f).toEqual({ ...req("policyStatus", { opId }), type: "req" });
      for (const args of [{}, { opId: "" }, { opId: 1 }, { opId: "a:b" }]) {
        expect(parse(req("policyStatus", args), "kernel"), JSON.stringify(args)).toThrow(
          DeviceProtocolError,
        );
      }
      const policy: DeviceLocalPolicySummary = {
        mode: "sandbox",
        allowedDomains: ["a.example.com"],
      };
      const goods: DevicePolicyStatus[] = [
        { outcome: "applied", policy },
        { outcome: "refused", message: "This device does not accept network changes." },
        { outcome: "started" },
        { outcome: "unknown" },
        { outcome: "unknown", policy },
      ];
      for (const good of goods) {
        expect(parseOpResult("policyStatus", JSON.parse(JSON.stringify(good)))).toEqual(good);
      }
      for (const bad of [
        null,
        {},
        { outcome: "maybe" },
        { outcome: "applied", policy: { ...policy, mode: "x" } },
        { outcome: "applied", policy: { ...policy, allowedDomains: [1] } },
        { outcome: "refused", message: 1 },
      ]) {
        expect(() => parseOpResult("policyStatus", bad), JSON.stringify(bad)).toThrow(
          DeviceProtocolError,
        );
      }
    });

    it("hello recentOps keeps the last entry of a repeated op id", () => {
      const h = parseDeviceFrame(
        JSON.stringify({
          ...hello,
          recentOps: [
            { opId: "a", outcome: "started" },
            { opId: "b", outcome: "applied" },
            { opId: "a", outcome: "refused" },
          ],
        }),
        "device",
      ) as DeviceHello;
      expect(h.recentOps).toEqual([
        { opId: "b", outcome: "applied" },
        { opId: "a", outcome: "refused" },
      ]);
    });

    it("hello recentOps keeps valid entries and drops the rest, at most 100", () => {
      const parseHello = (o: unknown) =>
        parseDeviceFrame(JSON.stringify(o), "device") as DeviceHello;
      expect(parseHello(hello).recentOps).toBeUndefined();
      expect(parseHello({ ...hello, recentOps: "x" }).recentOps).toBeUndefined();
      const h = parseHello({
        ...hello,
        features: ["policyOp", "policyOpId"],
        recentOps: [
          { opId: "a", outcome: "applied" },
          { opId: "b", outcome: "refused" },
          { opId: "c", outcome: "started" },
          { opId: "d", outcome: "unknown" },
          { opId: "", outcome: "applied" },
          { opId: "e:f", outcome: "applied" },
          { opId: 1, outcome: "applied" },
          { outcome: "applied" },
          "g",
          null,
        ],
      });
      expect(h.features).toEqual(["policyOp", "policyOpId"]);
      expect(h.recentOps).toEqual([
        { opId: "a", outcome: "applied" },
        { opId: "b", outcome: "refused" },
        { opId: "c", outcome: "started" },
      ]);
      // oldest first: a longer list keeps its last (newest) 100 entries
      const many = Array.from({ length: 150 }, (_, i) => ({ opId: `op${i}`, outcome: "applied" }));
      const kept = parseHello({ ...hello, recentOps: many }).recentOps ?? [];
      expect(kept).toHaveLength(MAX_RECENT_POLICY_OPS);
      expect(MAX_RECENT_POLICY_OPS).toBe(100);
      expect(kept[0]?.opId).toBe("op50");
      expect(kept.at(-1)?.opId).toBe("op149");
    });

    it("validates the result", () => {
      const policy = {
        mode: "auto",
        allowedDomains: ["a.example.com"],
      };
      expect(parseOpResult("policy", { policy })).toEqual({ policy });
      for (const bad of [
        null,
        {},
        { policy: { ...policy, mode: "x" } },
        { policy: { ...policy, mode: undefined } },
        { policy: { ...policy, allowedDomains: [1] } },
        { policy: { ...policy, allowedDomains: undefined } },
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

describe("isBackgroundLaunch", () => {
  it("is true only for a command whose first line is the launch line", () => {
    expect(BACKGROUND_LAUNCH_LINE.startsWith("#")).toBe(true);
    expect(isBackgroundLaunch(`${BACKGROUND_LAUNCH_LINE}\nset -e`)).toBe(true);
    expect(isBackgroundLaunch(BACKGROUND_LAUNCH_LINE)).toBe(true);
    expect(isBackgroundLaunch(`${BACKGROUND_LAUNCH_LINE} x\nset -e`)).toBe(false);
    expect(isBackgroundLaunch(`echo hi\n${BACKGROUND_LAUNCH_LINE}`)).toBe(false);
    expect(isBackgroundLaunch(` ${BACKGROUND_LAUNCH_LINE}\n`)).toBe(false);
    expect(isBackgroundLaunch("sleep 300 &")).toBe(false);
  });
});
