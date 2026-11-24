import assert from "node:assert/strict";
import type {
  DeviceProvider,
  DeviceServiceSpec,
  DeviceServiceStatus,
  SandboxHandle,
} from "@capybara-hq/plugin-sdk";

/**
 * A framed echo device service (the device service socket protocol of the SDK's
 * `device-service.ts`, written out so it runs alone from the service's state directory): it
 * listens on `$CAPYBARA_SERVICE_SOCKET`, answers a `request` connection with its body unchanged
 * and echoes every message of a `stream` connection.
 */
export const DEVICE_SERVICE_ECHO_SCRIPT = `import { createServer } from "node:net";
const socket = process.env.CAPYBARA_SERVICE_SOCKET;
if (!socket) process.exit(2);
const frame = (body) => {
  const out = Buffer.alloc(4 + body.byteLength);
  out.writeUInt32BE(body.byteLength, 0);
  Buffer.from(body).copy(out, 4);
  return out;
};
createServer((conn) => {
  let buf = Buffer.alloc(0);
  let kind = null;
  conn.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.byteLength < 4) return;
      const len = buf.readUInt32BE(0);
      if (buf.byteLength < 4 + len) return;
      const msg = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      if (kind === null) {
        kind = JSON.parse(msg.toString("utf8")).kind;
        continue;
      }
      if (kind === "request") {
        conn.end(frame(msg));
        return;
      }
      conn.write(frame(msg));
    }
  });
  conn.on("error", () => {});
}).listen(socket);
`;

/** What {@link runDeviceServiceConformance} runs against: one running instance of a fresh device. */
export interface DeviceServiceFixture {
  provider: Pick<DeviceProvider, "ensureService" | "stopService" | "serviceRequest">;
  /** A running instance with no service started yet. */
  handle: SandboxHandle;
  /** Removes fixture-owned resources (the instance, its files), also after a failure. */
  dispose(): Promise<void>;
}

const SERVICE = "conformance-echo";

/**
 * The device service contract every `device-provider@1` with services must pass (browser use spec
 * §5). The kernel's launch review relies on it: a launch is reviewed only after an `ifRunning`
 * ensure answered `stopped`, so a provider that started a service there would run it unreviewed.
 * Checks: an `ifRunning` ensure of a stopped service starts nothing and answers `stopped` with an
 * absolute `stateDir`; `stateDir` stays the same for the device and name across calls; a normal
 * ensure starts the service once (a second one finds it running, same `startedAt`); an `ifRunning`
 * ensure keeps a running one; `serviceRequest` round-trips the echo service; `stopService` stops
 * it (requests then fail, `ifRunning` answers `stopped`) and succeeds when it is not running. The
 * fixture's `dispose` always runs.
 */
export async function runDeviceServiceConformance(fixture: DeviceServiceFixture): Promise<void> {
  const { provider, handle } = fixture;
  const ensure = provider.ensureService?.bind(provider);
  const stop = provider.stopService?.bind(provider);
  const request = provider.serviceRequest?.bind(provider);
  assert(
    ensure && stop && request,
    "device services need ensureService, stopService and serviceRequest",
  );
  const signal = () => AbortSignal.timeout(30_000);
  const spec: DeviceServiceSpec = {
    name: SERVICE,
    runtime: "node",
    entry: "echo.mjs",
    args: [],
    files: { "echo.mjs": new TextEncoder().encode(DEVICE_SERVICE_ECHO_SCRIPT) },
  };
  const ask = (text: string) =>
    request(handle, SERVICE, new TextEncoder().encode(text), {
      timeoutMs: 5_000,
      signal: signal(),
    });
  const assertStopped = async (s: DeviceServiceStatus, stateDir: string | null, when: string) => {
    assert.equal(s.name, SERVICE, `${when}: status names the service`);
    assert.equal(s.state, "stopped", `${when}: an ifRunning ensure must not start the service`);
    assert.equal(s.startedAt, null, `${when}: a stopped service has no startedAt`);
    assert(s.stateDir.startsWith("/"), `${when}: stateDir must be absolute, got ${s.stateDir}`);
    if (stateDir !== null) assert.equal(s.stateDir, stateDir, `${when}: stateDir must be stable`);
    await assert.rejects(ask("nobody"), `${when}: no service may answer requests`);
  };
  try {
    const before = await ensure(handle, spec, signal(), { ifRunning: true });
    await assertStopped(before, null, "before any start");
    const again = await ensure(handle, spec, signal(), { ifRunning: true });
    await assertStopped(again, before.stateDir, "a second ifRunning ensure");

    const started = await ensure(handle, spec, signal());
    assert.equal(started.state, "running", "a normal ensure starts the service");
    assert.equal(typeof started.startedAt, "string", "a running service has startedAt");
    assert.equal(started.stateDir, before.stateDir, "stateDir must be stable once started");
    const found = await ensure(handle, spec, signal());
    assert.deepEqual(found, started, "a second normal ensure keeps the running service");
    const kept = await ensure(handle, spec, signal(), { ifRunning: true });
    assert.deepEqual(kept, started, "an ifRunning ensure keeps the running service");

    const answer = await ask("hello conformance");
    assert.equal(new TextDecoder().decode(answer), "hello conformance", "requests round-trip");

    await stop(handle, SERVICE, signal());
    const after = await ensure(handle, spec, signal(), { ifRunning: true });
    await assertStopped(after, before.stateDir, "after stopService");
    await stop(handle, SERVICE, signal());
  } finally {
    try {
      await stop(handle, SERVICE, signal());
    } catch {
      // the fixture's dispose removes the instance anyway
    }
    await fixture.dispose();
  }
}
