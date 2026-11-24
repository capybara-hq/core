import { describe, expect, it } from "vitest";
import {
  DIAL_IN_STREAM_INITIAL_CREDIT,
  DialInProtocolError,
  DialInStreamElsewhereError,
  parseDialInKernelFrame,
  parseDialInMachineFrame,
} from "../src/index.js";

const machine = (frame: unknown, maxBytes = 1 << 20) =>
  parseDialInMachineFrame(JSON.stringify(frame), maxBytes);
const kernel = (frame: unknown, maxBytes = 1 << 20) =>
  parseDialInKernelFrame(JSON.stringify(frame), maxBytes);

describe("dial-in stream frames", () => {
  it("parses stream-opened / stream-data / stream-credit / stream-close", () => {
    const frames = [
      { type: "stream-opened", streamId: "s-1", ok: true },
      { type: "stream-opened", streamId: "s-1", ok: false, error: "no such service" },
      { type: "stream-data", streamId: "s-1", data: "aGVsbG8=" },
      { type: "stream-credit", streamId: "s-1", messages: 4 },
      { type: "stream-close", streamId: "s-1", reason: "done" },
    ];
    for (const f of frames) expect(machine(f)).toEqual(f);
  });

  it("parses the kernel's stream frames on the machine side", () => {
    const frames = [
      { type: "stream-open", streamId: "s-1", body: { service: "browser" } },
      { type: "stream-data", streamId: "s-1", data: "" },
      { type: "stream-credit", streamId: "s-1", messages: DIAL_IN_STREAM_INITIAL_CREDIT },
      { type: "stream-close", streamId: "s-1", reason: "viewer left" },
    ];
    for (const f of frames) expect(kernel(f)).toEqual(f);
    // stream-open goes only from the kernel to the machine, stream-opened only back
    expect(() => machine(frames[0])).toThrow(DialInProtocolError);
    expect(() => kernel({ type: "stream-opened", streamId: "s-1", ok: true })).toThrow(
      DialInProtocolError,
    );
  });

  it("rejects stream-data without streamId", () => {
    expect(() => machine({ type: "stream-data", data: "aGk=" })).toThrow(DialInProtocolError);
    expect(() => kernel({ type: "stream-data", data: "aGk=" })).toThrow(DialInProtocolError);
  });

  it("rejects malformed stream fields", () => {
    expect(() => machine({ type: "stream-data", streamId: "s-1", data: "not base64!" })).toThrow(
      DialInProtocolError,
    );
    expect(() => machine({ type: "stream-credit", streamId: "s-1", messages: 0 })).toThrow(
      DialInProtocolError,
    );
    expect(() => machine({ type: "stream-close", streamId: "s-1" })).toThrow(DialInProtocolError);
    expect(() => kernel({ type: "stream-open", streamId: "s-1" })).toThrow(DialInProtocolError);
    expect(() => machine({ type: "stream-opened", streamId: "s-1", ok: true, extra: 1 })).toThrow(
      DialInProtocolError,
    );
  });

  it("rejects a frame above maxBytes", () => {
    const f = { type: "stream-data", streamId: "s-1", data: "A".repeat(2000) };
    expect(() => machine(f, 1024)).toThrow(/exceeds 1024 bytes/);
    expect(() => kernel(f, 1024)).toThrow(/exceeds 1024 bytes/);
  });

  it("names the stream-elsewhere error by code", () => {
    const e = new DialInStreamElsewhereError("dev-1");
    expect(e.code).toBe("device.stream_elsewhere");
    expect(e.name).toBe("DialInStreamElsewhereError");
    expect(e.message).toMatch(/dev-1/);
  });
});
