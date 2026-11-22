import {
  DEFAULT_SANDBOX_ROOTS,
  isDeviceProjectName,
  MAX_DEVICE_PROJECT_NAME_LENGTH,
  MAX_DEVICE_SCAN_RESULTS,
  rootsOf,
} from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DeviceProtocolError,
  isDeviceBootId,
  MAX_DEVICE_LIST_ENTRIES,
  MAX_NETWORK_BLOCKED_HOSTS,
  parseDeviceFrame,
  parseOpResult,
} from "../src/device-protocol.js";

/*
 * The value guards of the device protocol (per-operation arguments and results, the hello's
 * optional fields), exercised through the protocol 5 bodies (`parseDeviceFrame`) that use them.
 */

const roots = { workspace: "/w", skills: "/s", tmp: "/t" };
/** A protocol 5 hello body of a bound instance. */
const hello = {
  mode: "os",
  roots,
  sessionIsolation: true,
  permissionSupport: {
    version: 2,
    boundary: "operation",
    restricted: null,
    network: { openPublic: false, allowlist: false, perOperationHosts: false },
    outsideSandbox: false,
    background: false,
  },
  ownerCeiling: {
    version: 3,
    sequence: 0,
    revision: "r",
    outsideSandbox: false,
    network: "allowlist",
    allowedDomains: [],
    restrictedProjectReach: "workspace",
  },
  instanceGeneration: "g",
};
const parseHello = (o: unknown) => parseDeviceFrame(o, "hello");

const scope = {
  operationId: "op",
  admitBeforeMs: 1000,
  deviceId: "d",
  rootConversationId: "r",
  profileRevision: 1,
  ceilingRevision: "c",
  profile: "approve-for-me",
  actor: { accountId: "a", conversationId: "r" },
  tag: "op",
  filesystem: { kind: "scoped", projectRoot: "/w", writeRoots: ["/w"] },
  network: { kind: "none" },
};
/** A request body: a native operation carries its admitted scope, a lifecycle one does not. */
const req = (op: string, args: unknown) => ({
  op,
  args:
    op === "create" || op === "stop" || typeof args !== "object" || args === null
      ? args
      : { ...args, scope },
});
const parse = (op: string, args: unknown) => () => parseDeviceFrame(req(op, args), "req");

const limits = {
  cpu: 1,
  memoryMb: 512,
  diskMb: 1024,
  network: { kind: "allowlist", hosts: [] },
};
const exec = { command: "ls", timeoutMs: 1000, maxOutputBytes: 100, limits };

describe("device protocol value guards", () => {
  it("rootsOf falls back to DEFAULT_SANDBOX_ROOTS", () => {
    expect(rootsOf({ id: "a" })).toEqual(DEFAULT_SANDBOX_ROOTS);
    expect(rootsOf({ id: "a", roots })).toBe(roots);
  });

  it("rejects roots that are relative, end in a slash, have empty or .. segments or control characters", () => {
    for (const workspace of ["workspace", "/w/", "/", "/a//w", "/a/../w", "/a/..", "/a/\u0001w"]) {
      const bad = { ...roots, workspace };
      expect(() => parseHello({ ...hello, roots: bad }), workspace).toThrow(DeviceProtocolError);
      expect(() => parseOpResult("create", { roots: bad }), workspace).toThrow(DeviceProtocolError);
    }
    for (const tmp of ["C:\\w", "C:/w"]) {
      expect(() => parseHello({ ...hello, roots: { ...roots, tmp } }), tmp).toThrow(
        DeviceProtocolError,
      );
    }
    const ok = { workspace: "/Users/u/capybara-device/e1/workspace", skills: "/s", tmp: "/t" };
    expect(parseOpResult("create", { roots: ok }).roots).toEqual(ok);
  });

  it("rejects bad hello fields", () => {
    for (const bad of [{ mode: "vm" }, { sessionIsolation: "yes" }]) {
      expect(() => parseHello({ ...hello, ...bad }), JSON.stringify(bad)).toThrow(
        DeviceProtocolError,
      );
    }
  });

  it("rejects bad args per op", () => {
    const bads: [string, unknown][] = [
      ["exec", "x"],
      ["exec", { ...exec, command: 1 }],
      ["exec", { ...exec, timeoutMs: 0 }],
      ["exec", { ...exec, maxOutputBytes: 1.5 }],
      ["exec", { ...exec, limits: { ...limits, cpu: undefined } }],
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
      // the mode tier is gone: unknown limits keys are refused, not ignored
      ["exec", { ...exec, limits: { ...limits, mode: "auto" } }],
      ["exec", { ...exec, limits: { ...limits, network: { ...limits.network, extra: true } } }],
      ["create", { limits: { ...limits, mode: "auto" } }],
      ["exec", { ...exec, cwd: 1 }],
      ["exec", { ...exec, env: { A: 1 } }],
      ["readFile", { path: "/a", maxBytes: -1 }],
      ["readFile", { path: 1, maxBytes: 1 }],
      ["writeFile", { path: "/a" }],
      ["stat", {}],
      ["create", {}],
      ["stop", { reason: "x" }],
      ["killTagged", { tags: ["a"] }],
      ["killAll", {}],
    ];
    for (const [op, args] of bads) {
      expect(parse(op, args), `${op} ${JSON.stringify(args)}`).toThrow(DeviceProtocolError);
    }
    const goods: [string, unknown][] = [
      ["exec", { ...exec, cwd: "/w", env: { A: "b" } }],
      ["readFile", { path: "/a", maxBytes: 0 }],
      ["writeFile", { path: "/a", dataB64: "" }],
      ["stat", { path: "/a" }],
      ["create", { limits }],
      [
        "exec",
        {
          ...exec,
          limits: { ...limits, network: { kind: "allowlist", hosts: ["registry.npmjs.org"] } },
        },
      ],
      ["exec", { ...exec, limits: { ...limits, network: { kind: "open-public", hosts: [] } } }],
      ["stop", { reason: "deleted" }],
    ];
    for (const [op, args] of goods) expect(parse(op, args)().op, op).toBe(op);
  });

  it("names the nested path when network.hosts is malformed", () => {
    const bad = { ...exec, limits: { ...limits, network: { ...limits.network, hosts: [1] } } };
    expect(parse("exec", bad)).toThrow('field "network.hosts" must be an array of strings');
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
    expect(parseOpResult("create", { roots }).roots).toEqual(roots);
    expect(() => parseOpResult("create", { roots: { ...roots, tmp: "t" } })).toThrow(
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
    const summary = { allowedDomains: ["files.slack.com", "*.github.com"] };

    it("still parses a hello without them", () => {
      const h = parseHello(hello);
      expect(h.features).toBeUndefined();
      expect(h.policy).toBeUndefined();
    });

    it("keeps known features and a valid policy summary", () => {
      const h = parseHello({
        ...hello,
        // the removed policy-op and mode features are dropped like any unknown one
        features: ["networkReport", "teleport", "policyOp", "policyOpId", "mode", "projects", 3],
        policy: summary,
      });
      expect(h.features).toEqual(["networkReport", "projects"]);
      expect(h.policy).toEqual(summary);
      // a mode in the summary is not part of it: dropped
      expect(parseHello({ ...hello, policy: { ...summary, mode: "auto" } }).policy).toEqual(
        summary,
      );
    });

    it("drops unreadable features and policy summaries", () => {
      expect(parseHello({ ...hello, features: "networkReport" }).features).toBeUndefined();
      expect(parseHello({ ...hello, features: ["tiers"] }).features).toEqual([]);
      for (const policy of [
        "x",
        null,
        { ...summary, allowedDomains: [1] },
        { ...summary, allowedDomains: "a.com" },
        { mode: "sandbox" },
      ]) {
        expect(parseHello({ ...hello, policy }).policy, JSON.stringify(policy)).toBeUndefined();
      }
    });

    it("a policy event carries the summary; an unreadable one is dropped", () => {
      const event = (policy?: unknown) =>
        parseDeviceFrame(
          {
            type: "policy",
            ...(policy !== undefined && { policy }),
            ownerCeiling: hello.ownerCeiling,
          },
          "event",
        );
      expect(event(summary).policy).toEqual(summary);
      expect(event({ ...summary, allowedDomains: [1] }).policy).toBeUndefined();
      expect(event().policy).toBeUndefined();
      // the projects a device may still list are no part of the summary
      expect(event({ ...summary, projects: [{ name: "core", path: "/w/core" }] }).policy).toEqual(
        summary,
      );
    });
  });

  describe("the hello's home", () => {
    it("keeps an absolute home and drops a malformed one", () => {
      expect(parseHello({ ...hello, home: "/Users/ann" }).home).toBe("/Users/ann");
      expect(parseHello(hello).home).toBeUndefined();
      for (const home of ["Users/ann", "", "/Users/../ann", "/Users/a\nn", 1, null]) {
        expect(parseHello({ ...hello, home }).home, JSON.stringify(home)).toBeUndefined();
      }
    });
  });

  it("isDeviceBootId accepts a well-formed boot or run identity only", () => {
    for (const id of ["0f2a9c1e-7b1d-4b8e-9d5e-1c2b3a4d5e6f", "boottime-1763370000.123456"])
      expect(isDeviceBootId(id)).toBe(true);
    for (const id of ["", "-x", "a b", "a\nb", "x".repeat(129), 1, null])
      expect(isDeviceBootId(id), JSON.stringify(id)).toBe(false);
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
    it("parses the request", () => {
      const args = { path: "/w/core/.agents/skills", limit: 200 };
      expect(parse("list", args)()).toMatchObject({ op: "list", args });
      expect(parse("list", { path: "/w", limit: MAX_DEVICE_LIST_ENTRIES })()).toMatchObject({
        op: "list",
      });
    });

    it("rejects malformed args", () => {
      for (const args of [
        {},
        { path: "/w" },
        { limit: 10 },
        { path: "w", limit: 10 },
        { path: "/w/../etc", limit: 10 },
        { path: "/w//a", limit: 10 },
        { path: "/w", limit: 0 },
        { path: "/w", limit: 1.5 },
        { path: "/w", limit: MAX_DEVICE_LIST_ENTRIES + 1 },
      ]) {
        expect(parse("list", args), JSON.stringify(args)).toThrow(DeviceProtocolError);
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
    it("parses the request", () => {
      const args = { base: "/Users/ann" };
      expect(parse("scan", args)()).toMatchObject({ op: "scan", args });
    });

    it("rejects malformed args", () => {
      for (const args of [
        {},
        { base: "" },
        { base: "Users/ann" },
        { base: "/Users/../ann" },
        { base: "/Users/a\nn" },
      ]) {
        expect(parse("scan", args), JSON.stringify(args)).toThrow(DeviceProtocolError);
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

  describe("exec grants", () => {
    const grants = {
      hosts: ["a.example.com"],
      source: { kind: "run", id: "run_1", accountId: "a" },
    };

    it("accepts exec args with and without grants", () => {
      const goods: unknown[] = [
        exec,
        { ...exec, grants },
        { ...exec, grants: { ...grants, source: { ...grants.source, kind: "task" } } },
        { ...exec, grants: { ...grants, hosts: [] } },
      ];
      for (const args of goods) expect(parse("exec", args)().op, JSON.stringify(args)).toBe("exec");
    });

    it("rejects malformed grants", () => {
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
      ];
      for (const args of bads) {
        expect(parse("exec", args), JSON.stringify(args)).toThrow(DeviceProtocolError);
      }
    });
  });
});
