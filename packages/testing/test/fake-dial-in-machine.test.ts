import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { parseDialInMachineFrame } from "@capybara-hq/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { FAKE_DIAL_IN_PROTOCOL, FakeDialInMachine } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A stand-in kernel: answers the hello with `ready`, hands each socket to the test. */
async function kernel() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  cleanups.push(
    () =>
      new Promise((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  );
  const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return { wss, url };
}

describe("FakeDialInMachine", () => {
  it("fake machine answers a req with res carrying the same id", async () => {
    const { wss, url } = await kernel();
    const seen: { headers: Record<string, unknown>; hello: unknown } = {
      headers: {},
      hello: undefined,
    };
    wss.on("connection", (sock, req) => {
      seen.headers = req.headers;
      sock.once("message", (data) => {
        seen.hello = parseDialInMachineFrame(data.toString(), 1024 * 1024);
        sock.send(JSON.stringify({ type: "ready", connectionId: "c1" }));
      });
    });
    const m = await FakeDialInMachine.connect({
      url,
      credential: "secret",
      hello: { revision: "1" },
    });
    expect(m.connectionId).toBe("c1");
    m.onRequest((body) => ({ echoed: body }));
    const [sockOf] = [...wss.clients];
    const answered = new Promise<string>((resolve) => {
      sockOf?.once("message", (d) => resolve(d.toString()));
    });
    sockOf?.send(JSON.stringify({ type: "req", id: "r1", deadlineMs: 5000, body: { op: "x" } }));
    const res = await answered;
    expect(parseDialInMachineFrame(res, 4096)).toEqual({
      type: "res",
      id: "r1",
      body: { echoed: { op: "x" } },
    });
    expect(seen.headers.authorization).toBe("Bearer secret");
    expect(seen.headers["x-capybara-device-protocol"]).toBe(FAKE_DIAL_IN_PROTOCOL);
    expect(seen.hello).toMatchObject({
      type: "hello",
      protocol: FAKE_DIAL_IN_PROTOCOL,
      body: { revision: "1" },
    });
    const event = new Promise<string>((resolve) => {
      sockOf?.once("message", (d) => resolve(d.toString()));
    });
    await m.send({ revision: "2" });
    expect(parseDialInMachineFrame(await event, 4096)).toEqual({
      type: "event",
      body: { revision: "2" },
    });
    await m.close();
  });

  it("fake machine closes with the server's code", async () => {
    const { wss, url } = await kernel();
    wss.on("connection", (sock) => {
      sock.once("message", () => {
        sock.send(JSON.stringify({ type: "ready", connectionId: "c2" }));
        sock.close(4002, "replaced");
      });
    });
    const m = await FakeDialInMachine.connect({ url, credential: "s", hello: {} });
    expect(await m.closed).toEqual({ code: 4002, reason: "replaced" });
  });

  it("fake machine rejects when the server closes before ready", async () => {
    const { wss, url } = await kernel();
    wss.on("connection", (sock) => {
      sock.once("message", () => sock.close(4400, "bad hello"));
    });
    await expect(FakeDialInMachine.connect({ url, credential: "s", hello: {} })).rejects.toThrow(
      /4400 bad hello/,
    );
  });
});
