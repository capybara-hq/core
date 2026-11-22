import { describe, expect, it } from "vitest";
import {
  DeviceOfflineError,
  DeviceRequestNotSentError,
  DIAL_IN_PROTOCOL_RE,
  DialInProtocolError,
  isDeviceOfflineError,
  isDeviceRequestNotSent,
  isSandboxScopeDeniedError,
  parseDialInKernelFrame,
  parseDialInMachineFrame,
  SandboxScopeDeniedError,
} from "../src/index.js";

const hello = (over: Record<string, unknown> = {}) => ({
  type: "hello",
  protocol: "capybara-device/6",
  programRunId: "run-1",
  program: { version: "1.2.3", os: "darwin", arch: "arm64", bootId: "boot-1" },
  transport: { maxFrameBytes: 4096 },
  body: { any: [1] },
  ...over,
});

const parse = (frame: unknown, maxBytes = 1 << 20) =>
  parseDialInMachineFrame(JSON.stringify(frame), maxBytes);

describe("parseDialInMachineFrame", () => {
  it("parses a hello envelope and keeps the body opaque", () => {
    const f = parse(hello());
    expect(f).toEqual(hello());
    if (f.type !== "hello") throw new Error("expected hello");
    expect(f.body).toEqual({ any: [1] });
    const noBoot = hello({ program: { version: "1.2.3", os: "linux", arch: "x64" } });
    expect(parse(noBoot)).toEqual(noBoot);
  });

  it("parses res and event envelopes with any JSON body", () => {
    expect(parse({ type: "res", id: "r-1", body: null })).toEqual({
      type: "res",
      id: "r-1",
      body: null,
    });
    expect(parse({ type: "event", body: [1, "x", { y: true }] })).toEqual({
      type: "event",
      body: [1, "x", { y: true }],
    });
  });

  it("rejects a frame over maxBytes before JSON.parse", () => {
    const text = `"${"x".repeat(2046)}"`; // 2 KiB, valid JSON but not an envelope
    expect(() => parseDialInMachineFrame(text, 1024)).toThrow(/frame exceeds/);
    // counted in UTF-8 bytes, not UTF-16 code units
    const wide = JSON.stringify({ type: "event", body: "é".repeat(600) });
    expect(wide.length).toBeLessThan(1024);
    expect(() => parseDialInMachineFrame(wide, 1024)).toThrow(/frame exceeds/);
  });

  it("rejects unknown envelope types and extra top-level keys", () => {
    expect(() => parse({ type: "policy" })).toThrow(DialInProtocolError);
    expect(() => parse({ type: "req", id: "1", deadlineMs: 1, body: {} })).toThrow(
      DialInProtocolError,
    );
    expect(() => parse(hello({ owner: "a" }))).toThrow(DialInProtocolError);
    expect(() => parse({ type: "res", id: "1", body: {}, ok: true })).toThrow(DialInProtocolError);
    expect(() => parse({ type: "event", body: {}, id: "1" })).toThrow(DialInProtocolError);
    expect(() =>
      parse(hello({ program: { version: "1", os: "linux", arch: "x64", mode: "os" } })),
    ).toThrow(DialInProtocolError);
    expect(() => parse(hello({ transport: { maxFrameBytes: 4096, extra: 1 } }))).toThrow(
      DialInProtocolError,
    );
  });

  it("rejects missing bodies, malformed ids and non-object frames", () => {
    expect(() => parse({ type: "event" })).toThrow(DialInProtocolError);
    expect(() => parse({ type: "res", id: "1" })).toThrow(DialInProtocolError);
    const { body: _body, ...noBody } = hello();
    expect(() => parse(noBody)).toThrow(DialInProtocolError);
    expect(() => parse({ type: "res", id: "", body: {} })).toThrow(DialInProtocolError);
    expect(() => parse({ type: "res", id: "a b", body: {} })).toThrow(DialInProtocolError);
    expect(() => parse(hello({ programRunId: "x".repeat(129) }))).toThrow(DialInProtocolError);
    expect(() => parse(hello({ transport: { maxFrameBytes: 10 } }))).toThrow(DialInProtocolError);
    expect(() => parse(hello({ transport: { maxFrameBytes: 4096.5 } }))).toThrow(
      DialInProtocolError,
    );
    for (const raw of ["not json", "[]", "null", "1", '"hello"'])
      expect(() => parseDialInMachineFrame(raw, 1024), raw).toThrow(DialInProtocolError);
  });

  it("rejects a hello whose protocol does not match DIAL_IN_PROTOCOL_RE", () => {
    for (const protocol of ["5", "Capybara/5", "capybara-device/0", "capybara-device/", 5])
      expect(() => parse(hello({ protocol })), String(protocol)).toThrow(DialInProtocolError);
    expect(parse(hello({ protocol: "capybara-device/6" })).type).toBe("hello");
    expect(DIAL_IN_PROTOCOL_RE.test("capybara-device/6")).toBe(true);
    expect(DIAL_IN_PROTOCOL_RE.test("a/9999")).toBe(true);
    expect(DIAL_IN_PROTOCOL_RE.test("a/10000")).toBe(false);
    expect(DIAL_IN_PROTOCOL_RE.test(`a${"b".repeat(41)}/1`)).toBe(false);
  });

  it("rejects a malformed maxBytes argument", () => {
    expect(() => parseDialInMachineFrame("{}", 0)).toThrow(RangeError);
    expect(() => parseDialInMachineFrame("{}", Number.NaN)).toThrow(RangeError);
  });
});

describe("parseDialInKernelFrame", () => {
  const parse = (frame: unknown, max = 4096) => parseDialInKernelFrame(JSON.stringify(frame), max);
  it("parses ready, req, cancel and stop and keeps a request body opaque", () => {
    expect(parse({ type: "ready", connectionId: "c-1", maxFrameBytes: 4096 })).toEqual({
      type: "ready",
      connectionId: "c-1",
      maxFrameBytes: 4096,
    });
    const req = { type: "req", id: "r-1", deadlineMs: 5000, body: { op: "x", args: [1] } };
    expect(parse(req)).toEqual(req);
    expect(parse({ type: "cancel", id: "r-1" })).toEqual({ type: "cancel", id: "r-1" });
    for (const reason of ["drain", "stop"])
      expect(parse({ type: "stop", reason })).toEqual({ type: "stop", reason });
  });
  it("rejects machine frames, extra keys, bad ids, deadlines and stop reasons", () => {
    for (const bad of [
      { type: "hello", protocol: "capybara-device/6" },
      { type: "res", id: "r", body: null },
      { type: "ready", connectionId: "c" },
      { type: "ready", connectionId: "c", maxFrameBytes: 1023 },
      { type: "ready", connectionId: "c", maxFrameBytes: 4096.5 },
      { type: "ready", connectionId: "c", maxFrameBytes: 4096, extra: 1 },
      { type: "req", id: "r", deadlineMs: 0, body: {} },
      { type: "req", id: "r", deadlineMs: 1.5, body: {} },
      { type: "req", id: "r", deadlineMs: 10 },
      { type: "req", id: "bad id", deadlineMs: 10, body: {} },
      { type: "cancel", id: "" },
      { type: "stop", reason: "revoked" },
      [],
      null,
    ])
      expect(() => parse(bad), JSON.stringify(bad)).toThrow(DialInProtocolError);
  });
  it("rejects a frame over maxBytes before JSON.parse", () => {
    const text = JSON.stringify({ type: "cancel", id: "r" });
    expect(() => parseDialInKernelFrame(`${text}${" ".repeat(2000)}`, 1024)).toThrow(
      "exceeds 1024 bytes",
    );
    expect(() => parseDialInKernelFrame("{", 1024)).toThrow("not valid JSON");
    expect(() => parseDialInKernelFrame(text, 0)).toThrow(RangeError);
  });
});

describe("dial-in errors", () => {
  it("DeviceOfflineError and DeviceRequestNotSentError are recognizable across realms", () => {
    const offline = new DeviceOfflineError("dev-1");
    expect(offline.code).toBe("device.offline");
    expect(offline.name).toBe("DeviceOfflineError");
    expect(offline.message).toMatch(/dev-1/);
    expect(isDeviceOfflineError(offline)).toBe(true);
    // another SDK copy: same name and code, other class identity
    expect(
      isDeviceOfflineError(
        Object.assign(new Error("offline"), { name: "DeviceOfflineError", code: "device.offline" }),
      ),
    ).toBe(true);
    expect(isDeviceOfflineError(Object.assign(new Error("x"), { code: "device.offline" }))).toBe(
      false,
    );
    expect(isDeviceOfflineError({ name: "DeviceOfflineError", code: "device.offline" })).toBe(
      false,
    );

    // a pre-effect scope refusal: every scope check still treats it as one
    const notSent = new DeviceRequestNotSentError("connection changed");
    expect(notSent).toBeInstanceOf(SandboxScopeDeniedError);
    expect(isSandboxScopeDeniedError(notSent)).toBe(true);
    expect(isDeviceRequestNotSent(notSent)).toBe(true);
    expect(
      isDeviceRequestNotSent(
        Object.assign(new Error("x"), {
          name: "SandboxScopeDeniedError",
          sandboxScopeDenied: true,
          notSent: true,
        }),
      ),
    ).toBe(true);
    // a plain scope refusal, or a non-scope error tagged notSent, is not one
    expect(isDeviceRequestNotSent(new SandboxScopeDeniedError("x"))).toBe(false);
    expect(isDeviceRequestNotSent(Object.assign(new Error("x"), { notSent: true }))).toBe(false);
    expect(isDeviceRequestNotSent(null)).toBe(false);
  });
});
