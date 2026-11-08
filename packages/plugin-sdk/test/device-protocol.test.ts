import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_ROOTS,
  DeviceProtocolError,
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

  const parse = (o: unknown, from: "device" | "kernel") => () =>
    parseDeviceFrame(JSON.stringify(o), from);
  const limits = { cpu: 1, memoryMb: 512, diskMb: 1024, egress: "none", allowHosts: [] };
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
});
