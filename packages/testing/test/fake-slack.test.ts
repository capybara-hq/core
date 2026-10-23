import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type FakeSlackServer, startFakeSlack } from "../src/fake-slack.js";

/**
 * Socket Mode routing in the fake Slack: envelopes go to the target app's socket, are queued while
 * the app has no open socket, and (with `redeliverUnacked`) are retried on the app's next socket
 * when the socket they went to closed before acking them.
 */

const APP2 = { appToken: "xapp-second-app", botToken: "xoxb-second-bot", botUserId: "UBOT2" };

let slack: FakeSlackServer | undefined;
const open: WebSocket[] = [];

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await slack?.stop();
  slack = undefined;
});

const waitFor = async <T>(fn: () => T | undefined | false, what: string, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function api(s: FakeSlackServer, method: string, token: string) {
  const res = await fetch(`${s.apiUrl}${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

type Frame = Record<string, unknown>;

/** Opens a Socket Mode connection for `appToken`; resolves after `hello` with the frames it gets. */
async function connect(s: FakeSlackServer, appToken: string) {
  const r = await api(s, "apps.connections.open", appToken);
  expect(r.ok).toBe(true);
  const frames: Frame[] = [];
  const ws = new WebSocket(String(r.url));
  open.push(ws);
  ws.on("message", (d) => frames.push(JSON.parse(String(d)) as Frame));
  await waitFor(() => frames.some((f) => f.type === "hello"), "hello");
  const envelopes = () => frames.filter((f) => f.type !== "hello");
  const ack = (envelopeId: string) => ws.send(JSON.stringify({ envelope_id: envelopeId }));
  const close = async () => {
    const closed = new Promise((r) => ws.once("close", r));
    ws.close();
    await closed;
    await waitFor(() => s.openSockets(appToken) === 0 || undefined, "socket closed");
  };
  return { ws, frames, envelopes, ack, close };
}

describe("fake Slack Socket Mode routing", () => {
  it("routes each push to its app's socket and answers auth.test per bot token", async () => {
    const s = await startFakeSlack({ teamId: "T1", apps: [APP2] });
    slack = s;
    expect(await api(s, "auth.test", s.botToken)).toMatchObject({ user_id: "UBOT", team_id: "T1" });
    expect(await api(s, "auth.test", APP2.botToken)).toMatchObject({
      user_id: "UBOT2",
      team_id: "T1",
    });
    expect(await api(s, "auth.test", "xoxb-unknown")).toMatchObject({ error: "invalid_auth" });

    const one = await connect(s, s.appToken);
    const two = await connect(s, APP2.appToken);
    expect(s.openSockets()).toBe(2);
    expect(s.openSockets(s.appToken)).toBe(1);
    expect(s.openSockets(APP2.appToken)).toBe(1);
    expect(s.connectionsOpened(APP2.appToken)).toBe(1);
    expect(s.socketPeerPorts(APP2.appToken)).toHaveLength(1);

    const e2 = s.pushEvent({ type: "message", text: "for two" }, { appToken: APP2.appToken });
    const e1 = s.pushEvent({ type: "message", text: "for one" });
    await waitFor(() => two.envelopes().length === 1 && one.envelopes().length === 1, "routed");
    expect(two.envelopes()[0]).toMatchObject({ envelope_id: e2, type: "events_api" });
    expect(one.envelopes()[0]).toMatchObject({ envelope_id: e1 });
    expect(s.pendingEnvelopes()).toBe(2);
    two.ack(e2);
    await s.waitForAck(e2);
    expect(s.pendingEnvelopes(APP2.appToken)).toBe(0);
    expect(s.pendingEnvelopes(s.appToken)).toBe(1);
    expect(() => s.push({ type: "x", payload: {} }, { appToken: "xapp-nope" })).toThrow(
      /unknown app token/,
    );
  });

  it("queues envelopes pushed while the app has no socket and delivers them in order on connect", async () => {
    const s = await startFakeSlack();
    slack = s;
    const a = s.pushEvent({ type: "message", text: "a" });
    const b = s.pushEvent({ type: "message", text: "b" });
    expect(s.pendingEnvelopes()).toBe(2);
    const c = await connect(s, s.appToken);
    await waitFor(() => c.envelopes().length === 2, "queued envelopes");
    expect(c.envelopes().map((f) => f.envelope_id)).toEqual([a, b]);
    expect(c.envelopes()[0]).not.toHaveProperty("retry_attempt");
    c.ack(a);
    c.ack(b);
    await s.waitForAck(b);
    expect(s.pendingEnvelopes()).toBe(0);
  });

  it("redeliverUnacked: an envelope unacked when its socket closed goes to the next socket", async () => {
    const s = await startFakeSlack({ redeliverUnacked: true });
    slack = s;
    const first = await connect(s, s.appToken);
    const lost = s.pushEvent({ type: "message", text: "lost" });
    const done = s.pushEvent({ type: "message", text: "done" });
    await waitFor(() => first.envelopes().length === 2, "delivered");
    first.ack(done);
    await s.waitForAck(done);
    await first.close();
    const queued = s.pushEvent({ type: "message", text: "while closed" });
    expect(s.pendingEnvelopes()).toBe(2);

    const second = await connect(s, s.appToken);
    await waitFor(() => second.envelopes().length === 2, "redelivered");
    expect(second.envelopes()[0]).toMatchObject({
      envelope_id: lost,
      retry_attempt: 1,
      retry_reason: "timeout",
    });
    expect(second.envelopes()[1]).toMatchObject({ envelope_id: queued });
    expect(second.envelopes()[1]).not.toHaveProperty("retry_attempt");
    second.ack(lost);
    second.ack(queued);
    await s.waitForAck(queued);
    expect(s.pendingEnvelopes()).toBe(0);
    expect(s.acks.filter((x) => x.envelopeId === done)).toHaveLength(1);
  });

  it("without redeliverUnacked an envelope unacked when its socket closed is dropped", async () => {
    const s = await startFakeSlack();
    slack = s;
    const first = await connect(s, s.appToken);
    s.pushEvent({ type: "message", text: "dropped" });
    await waitFor(() => first.envelopes().length === 1, "delivered");
    await first.close();
    expect(s.pendingEnvelopes()).toBe(0);
    const second = await connect(s, s.appToken);
    const next = s.pushEvent({ type: "message", text: "next" });
    await waitFor(() => second.envelopes().length === 1, "next delivered");
    expect(second.envelopes()[0]).toMatchObject({ envelope_id: next });
  });
});
