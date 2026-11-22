import { parseDialInMachineFrame } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_NOT_SENT,
  readStoredResult,
  storedResult,
  wireFrameOf,
} from "../../src/dial-in/envelope.js";

const conn = { connectionId: "c-1", maxFrameBytes: 4096 };
const machine = { ...conn, machineId: "m-1" };

describe("the dial-in envelope between the relay and the gateway", () => {
  it("the gateway envelope strips kernel-internal fields before the provider sees a body", () => {
    // what the machine sent, validated strictly (a machine cannot add kernel fields)
    const res = parseDialInMachineFrame(
      JSON.stringify({ type: "res", id: "r-1", body: { op: "x", connectionId: "forged" } }),
      4096,
    );
    expect(res.type).toBe("res");
    const stored = storedResult(res as { id: string; body: unknown }, conn);
    expect(stored).toEqual({
      type: "res",
      id: "r-1",
      body: { op: "x", connectionId: "forged" },
      connectionId: "c-1",
      maxFrameBytes: 4096,
    });
    // as stored and as published on the bus
    for (const raw of [JSON.stringify(stored), stored]) {
      const read = readStoredResult(raw);
      expect(read).toEqual({
        id: "r-1",
        body: { op: "x", connectionId: "forged" },
        connection: conn,
      });
    }
    expect(() =>
      parseDialInMachineFrame(
        JSON.stringify({ type: "res", id: "r-1", body: {}, [GATEWAY_NOT_SENT]: "x" }),
        4096,
      ),
    ).toThrow();
  });

  it("a request goes out without its connection fence, only on that connection", () => {
    const queued = JSON.stringify({
      type: "req",
      id: "q-1",
      deadlineMs: 1000,
      body: { a: 1 },
      ...conn,
    });
    const sent = wireFrameOf(queued, machine);
    expect(sent).toEqual({
      send: { type: "req", id: "q-1", deadlineMs: 1000, body: { a: 1 } },
      text: JSON.stringify({ type: "req", id: "q-1", deadlineMs: 1000, body: { a: 1 } }),
    });
    expect(wireFrameOf(queued, { ...machine, connectionId: "c-2" })).toEqual({
      refuse: expect.stringContaining("connection changed"),
      id: "q-1",
    });
    expect(wireFrameOf(queued, { ...machine, maxFrameBytes: 8192 })).toMatchObject({ id: "q-1" });
  });

  it("a cancel always goes out; a stop only to the machine it names", () => {
    expect(wireFrameOf(JSON.stringify({ type: "cancel", id: "q-1" }), machine)).toMatchObject({
      send: { type: "cancel", id: "q-1" },
    });
    expect(
      wireFrameOf(JSON.stringify({ type: "stop", reason: "stop", machineId: "m-1" }), machine),
    ).toEqual({
      send: { type: "stop", reason: "stop" },
      text: JSON.stringify({ type: "stop", reason: "stop" }),
    });
    expect(
      wireFrameOf(JSON.stringify({ type: "stop", reason: "stop", machineId: "m-0" }), machine),
    ).toMatchObject({ drop: expect.stringContaining("another machine") });
    expect(wireFrameOf(JSON.stringify({ type: "stop", reason: "drain" }), machine)).toMatchObject({
      send: { type: "stop", reason: "drain" },
    });
    expect(wireFrameOf("not json", machine)).toMatchObject({ drop: expect.any(String) });
    expect(wireFrameOf(JSON.stringify({ type: "res", id: "x" }), machine)).toMatchObject({
      drop: expect.any(String),
    });
  });

  it("the gateway's own refusal carries no body and a stored result needs its connection", () => {
    const refused = storedResult({ id: "q-1" }, conn, "not sent");
    expect(refused).not.toHaveProperty("body");
    expect(readStoredResult(refused)).toEqual({
      id: "q-1",
      body: undefined,
      connection: conn,
      notSent: "not sent",
    });
    expect(() => readStoredResult({ type: "res", id: "q-1", body: 1 })).toThrow("connection");
    expect(() => readStoredResult({ type: "res", id: "q-1", ...conn })).toThrow("body");
  });
});
