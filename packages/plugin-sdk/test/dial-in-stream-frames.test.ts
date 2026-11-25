import { describe, expect, it } from "vitest";
import {
  DIAL_IN_STREAM_DATA_TAG,
  DIAL_IN_STREAM_INITIAL_CREDIT,
  DialInProtocolError,
  DialInStreamElsewhereError,
  decodeDialInStreamData,
  encodeDialInStreamData,
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

  it("binary stream-data round-trips the raw bytes with the stream id", () => {
    const id = "6f1c2a1e-1b2c-4d3e-8f90-123456789abc";
    const data = new Uint8Array([0, 1, 2, 255, 123]);
    const m = encodeDialInStreamData(id, data);
    expect(m[0]).toBe(DIAL_IN_STREAM_DATA_TAG);
    // two header bytes and the id: no base64, no JSON
    expect(m.byteLength).toBe(2 + id.length + data.byteLength);
    const back = decodeDialInStreamData(m);
    expect(back.streamId).toBe(id);
    expect([...back.data]).toEqual([...data]);
    expect(
      decodeDialInStreamData(encodeDialInStreamData("s-1", new Uint8Array())).data,
    ).toHaveLength(0);
  });

  it("refuses binary messages that are not well-formed stream-data", () => {
    const ok = encodeDialInStreamData("s-1", new Uint8Array([7]));
    expect(() => decodeDialInStreamData(new Uint8Array())).toThrow(DialInProtocolError);
    expect(() => decodeDialInStreamData(Uint8Array.of(2, ...ok.subarray(1)))).toThrow(
      DialInProtocolError,
    );
    // the id is longer than the message
    expect(() => decodeDialInStreamData(Uint8Array.of(1, 40, 115))).toThrow(DialInProtocolError);
    expect(() => decodeDialInStreamData(Uint8Array.of(1, 2, 32, 32, 9))).toThrow(
      DialInProtocolError,
    );
    expect(() => encodeDialInStreamData("not an id!", new Uint8Array())).toThrow(RangeError);
  });

  it("hello and ready may offer binary stream-data, nothing else", () => {
    const hello = {
      type: "hello",
      protocol: "capybara-device/6",
      programRunId: "r1",
      program: { version: "1", os: "darwin", arch: "arm64" },
      transport: { maxFrameBytes: 4096, binaryStreamData: true },
      body: {},
    };
    expect(machine(hello)).toEqual(hello);
    expect(() =>
      machine({ ...hello, transport: { maxFrameBytes: 4096, binaryStreamData: false } }),
    ).toThrow(DialInProtocolError);
    const ready = {
      type: "ready",
      connectionId: "c1",
      maxFrameBytes: 4096,
      binaryStreamData: true,
    };
    expect(kernel(ready)).toEqual(ready);
    expect(kernel({ type: "ready", connectionId: "c1", maxFrameBytes: 4096 })).not.toHaveProperty(
      "binaryStreamData",
    );
  });
});
