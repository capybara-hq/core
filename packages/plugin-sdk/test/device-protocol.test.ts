import { describe, expect, it } from "vitest";
import {
  DEFAULT_SANDBOX_ROOTS,
  DeviceProtocolError,
  parseDeviceFrame,
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
});
