import { describe, expect, it } from "vitest";
import {
  DEVICE_SERVICE_MAX_MESSAGE,
  DEVICE_SERVICE_SOCKET_ENV,
  DEVICE_SERVICE_STATE_ENV,
  encodeServiceMessage,
  SERVICE_CONNECTION_KINDS,
  ServiceMessageDecoder,
} from "../src/index.js";

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

describe("device service framing", () => {
  it("exposes the protocol constants", () => {
    expect(DEVICE_SERVICE_SOCKET_ENV).toBe("CAPYBARA_SERVICE_SOCKET");
    expect(DEVICE_SERVICE_STATE_ENV).toBe("CAPYBARA_SERVICE_STATE");
    expect(DEVICE_SERVICE_MAX_MESSAGE).toBe(8 * 1024 * 1024);
    expect(SERVICE_CONNECTION_KINDS).toEqual(["request", "stream"]);
  });

  it("encodes a 4-byte big-endian length before the body", () => {
    const m = encodeServiceMessage(bytes("hi"));
    expect([...m]).toEqual([0, 0, 0, 2, 104, 105]);
  });

  it("encode then decode round-trips three messages split across arbitrary chunk boundaries", () => {
    const messages = ['{"kind":"request"}', "", "x".repeat(1000)];
    const wire = concat(messages.map((m) => encodeServiceMessage(bytes(m))));
    for (const sizes of [[1], [3], [5, 2, 7], [wire.byteLength], [4, 1000, 1]]) {
      const dec = new ServiceMessageDecoder();
      const got: string[] = [];
      let at = 0;
      let i = 0;
      while (at < wire.byteLength) {
        const n = sizes[i++ % sizes.length] ?? 1;
        for (const m of dec.push(wire.subarray(at, at + n))) got.push(text(m));
        at += n;
      }
      expect(got).toEqual(messages);
    }
  });

  it("decoder throws on a declared length above DEVICE_SERVICE_MAX_MESSAGE", () => {
    const header = new Uint8Array(4);
    new DataView(header.buffer).setUint32(0, DEVICE_SERVICE_MAX_MESSAGE + 1);
    expect(() => new ServiceMessageDecoder().push(header)).toThrow(/exceeds/);
  });

  it("encoder refuses a body above DEVICE_SERVICE_MAX_MESSAGE", () => {
    expect(() => encodeServiceMessage(new Uint8Array(DEVICE_SERVICE_MAX_MESSAGE + 1))).toThrow(
      RangeError,
    );
  });
});
