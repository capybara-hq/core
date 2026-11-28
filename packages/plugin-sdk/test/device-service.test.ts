import { describe, expect, it } from "vitest";
import {
  DEVICE_SERVICE_FILES_DIGEST_VECTOR,
  DEVICE_SERVICE_MAX_MESSAGE,
  DEVICE_SERVICE_RESTORE_MAX_AGE_MS,
  DEVICE_SERVICE_ROLL_CHECK,
  DEVICE_SERVICE_SOCKET_ENV,
  DEVICE_SERVICE_STATE_ENV,
  deviceServiceFilesDigest,
  encodeConversationDeleted,
  encodeServiceMessage,
  encodeViewerContext,
  isRollCheck,
  parseConversationDeleted,
  parseLoopbackPorts,
  parseRollCheck,
  parseViewerContext,
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

  it("decodes one message of exactly DEVICE_SERVICE_MAX_MESSAGE fed in 64 KiB chunks", () => {
    const body = new Uint8Array(DEVICE_SERVICE_MAX_MESSAGE);
    for (let i = 0; i < body.byteLength; i += 4093) body[i] = i % 251;
    const wire = encodeServiceMessage(body);
    const dec = new ServiceMessageDecoder();
    const got: Uint8Array[] = [];
    for (let at = 0; at < wire.byteLength; at += 64 * 1024)
      got.push(...dec.push(wire.subarray(at, at + 64 * 1024)));
    expect(got.length).toBe(1);
    expect(got[0]?.byteLength).toBe(DEVICE_SERVICE_MAX_MESSAGE);
    expect(Buffer.compare(got[0] as Uint8Array, body)).toBe(0);
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

describe("viewer context", () => {
  const ctx = { kind: "viewer", conversationId: "c-child", rootConversationId: "c-root" } as const;

  it("round trips through one stream message body", () => {
    const body = encodeViewerContext(ctx);
    expect(JSON.parse(text(body))).toEqual(ctx);
    expect(parseViewerContext(body)).toEqual(ctx);
    expect(parseViewerContext(text(body))).toEqual(ctx);
  });

  it("keeps only the three known fields", () => {
    const extra = JSON.stringify({ ...ctx, tabId: "t1", owner: "me" });
    expect(parseViewerContext(extra)).toEqual(ctx);
  });

  it("refuses anything that is not a viewer context", () => {
    const bad: unknown[] = [
      "",
      "not json",
      "null",
      "[]",
      '"viewer"',
      JSON.stringify({ ...ctx, kind: "stream" }),
      JSON.stringify({ kind: "viewer", conversationId: "c" }),
      JSON.stringify({ kind: "viewer", rootConversationId: "r" }),
      JSON.stringify({ ...ctx, conversationId: "" }),
      JSON.stringify({ ...ctx, rootConversationId: "" }),
      JSON.stringify({ ...ctx, conversationId: 7 }),
      JSON.stringify({ ...ctx, rootConversationId: null }),
    ];
    for (const b of bad) expect(parseViewerContext(b as string), String(b)).toBeNull();
    // bytes that are not UTF-8
    expect(parseViewerContext(new Uint8Array([0xff, 0xfe, 0x7b]))).toBeNull();
    expect(parseViewerContext(new Uint8Array())).toBeNull();
  });
});

describe("service files digest", () => {
  const enc = (files: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)]));

  it("matches the pinned vector", () => {
    expect(deviceServiceFilesDigest(enc(DEVICE_SERVICE_FILES_DIGEST_VECTOR.files))).toBe(
      DEVICE_SERVICE_FILES_DIGEST_VECTOR.digest,
    );
  });

  it("is the same for the same files object without hashing again, and follows the content", () => {
    const files = enc({ "a.js": "a" });
    const first = deviceServiceFilesDigest(files);
    expect(deviceServiceFilesDigest(files)).toBe(first);
    expect(deviceServiceFilesDigest(enc({ "a.js": "a" }))).toBe(first);
    expect(deviceServiceFilesDigest(enc({ "a.js": "b" }))).not.toBe(first);
  });
});

describe("roll check", () => {
  it("recognises the kernel's request and reads only an explicit busy answer as busy", () => {
    expect(isRollCheck(DEVICE_SERVICE_ROLL_CHECK)).toBe(true);
    expect(isRollCheck(new TextEncoder().encode(DEVICE_SERVICE_ROLL_CHECK))).toBe(true);
    expect(isRollCheck('{"op":"snapshot"}')).toBe(false);
    expect(isRollCheck("not json")).toBe(false);
    expect(parseRollCheck('{"busy":true,"reason":"takeover"}')).toEqual({
      busy: true,
      reason: "takeover",
    });
    for (const other of ['{"busy":false}', '{"busy":"yes"}', '{"ok":false}', "Unknown", "null"])
      expect(parseRollCheck(other)).toEqual({ busy: false });
  });
});

describe("conversation-deleted notice", () => {
  it("round-trips the kernel's body", () => {
    const body = encodeConversationDeleted("c-1");
    expect(text(body)).toBe('{"capybara":"conversation-deleted","conversationId":"c-1"}');
    expect(parseConversationDeleted(body)).toEqual({
      capybara: "conversation-deleted",
      conversationId: "c-1",
    });
    expect(parseConversationDeleted(text(body))).toEqual(parseConversationDeleted(body));
  });

  it("reads anything else as null and never throws", () => {
    for (const other of [
      DEVICE_SERVICE_ROLL_CHECK,
      "not json",
      "[]",
      "null",
      '{"capybara":"conversation-deleted"}',
      '{"capybara":"conversation-deleted","conversationId":""}',
      '{"capybara":"conversation-deleted","conversationId":7}',
      '{"kind":"conversation-deleted","conversationId":"c"}',
    ])
      expect(parseConversationDeleted(other)).toBeNull();
    expect(parseConversationDeleted(new Uint8Array([0xff, 0xfe]))).toBeNull();
    expect(isRollCheck(encodeConversationDeleted("c"))).toBe(false);
  });

  it("refuses an empty id when encoding", () => {
    expect(() => encodeConversationDeleted("")).toThrow(TypeError);
  });

  it("names a ten-minute restore window", () => {
    expect(DEVICE_SERVICE_RESTORE_MAX_AGE_MS).toBe(600_000);
  });
});

describe("parseLoopbackPorts", () => {
  it("parses loopback ports strictly", () => {
    expect(parseLoopbackPorts([3999, 3000], "p")).toEqual([3000, 3999]);
    expect(parseLoopbackPorts([], "p")).toEqual([]);
    expect(parseLoopbackPorts([1, 65535], "p")).toEqual([1, 65535]);
    for (const bad of [
      [0],
      [65536],
      [3.5],
      ["3000"],
      [3000, 3000],
      Array.from({ length: 33 }, (_, i) => i + 1),
      "x",
      null,
    ])
      expect(() => parseLoopbackPorts(bad, "p")).toThrow(TypeError);
    expect(
      parseLoopbackPorts(
        Array.from({ length: 32 }, (_, i) => 32 - i),
        "p",
      ),
    ).toHaveLength(32);
  });
});
