import assert from "node:assert/strict";
import type {
  DeviceProvider,
  DeviceServiceSpec,
  DeviceServiceStatus,
  SandboxHandle,
} from "@capybara-hq/plugin-sdk";

/**
 * The request body {@link DEVICE_SERVICE_ECHO_SCRIPT} answers with its own `process.argv[1]`
 * (the entry path it was started from) instead of the body.
 */
export const DEVICE_SERVICE_ARGV_PROBE = "capybara-conformance:argv1";

/**
 * A framed echo device service (the device service socket protocol of the SDK's
 * `device-service.ts`, written out so it runs alone from the service's code directory): it
 * listens on `$CAPYBARA_SERVICE_SOCKET`, answers a `request` connection with its body unchanged
 * (with its `process.argv[1]` for {@link DEVICE_SERVICE_ARGV_PROBE}) and echoes every message of a
 * `stream` connection.
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
        const probe = msg.toString("utf8") === ${JSON.stringify(DEVICE_SERVICE_ARGV_PROBE)};
        conn.end(frame(probe ? Buffer.from(process.argv[1] ?? "", "utf8") : msg));
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

/** The service id the conformance starts (a provider receives ids: `<extension>.<name>`). */
const SERVICE = "conformance.echo";

/** What the kernel sends with every `ifRunning` ensure: the name, nothing to run. */
const nameOnly = (name: string): DeviceServiceSpec => ({
  name,
  runtime: "node",
  entry: "",
  args: [],
  files: {},
});

/**
 * The device service contract every `device-provider@1` with services must pass (browser use spec
 * §5). The kernel's launch review relies on it: a launch is reviewed only after an `ifRunning`
 * ensure answered `stopped`, so a provider that started a service there would run it unreviewed.
 * Every `ifRunning` ensure here uses the name-only spec the kernel sends
 * (`{ name, runtime: "node", entry: "", args: [], files: {} }`). Checks: an `ifRunning` ensure of a
 * stopped service starts nothing and answers `stopped` with an absolute `stateDir` (and an
 * absolute `codeDir` when the provider reports one); both stay the same for the device and name
 * across calls; a normal ensure starts the service once (a second one finds it running, same
 * `startedAt`); an `ifRunning` ensure keeps a running one running; the service runs its entry
 * from `codeDir ?? stateDir` (its `process.argv[1]` is exactly `<codeDir ?? stateDir>/<entry>`,
 * the path the kernel reviewed); `serviceRequest` round-trips the echo service; `stopService`
 * stops it (requests then fail, `ifRunning` answers `stopped`) and succeeds when it is not
 * running. The fixture's `dispose` always runs.
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
  const ifRunning = () => ensure(handle, nameOnly(SERVICE), signal(), { ifRunning: true });
  const assertDirs = (s: DeviceServiceStatus, first: DeviceServiceStatus | null, when: string) => {
    assert(s.stateDir.startsWith("/"), `${when}: stateDir must be absolute, got ${s.stateDir}`);
    if (s.codeDir !== undefined)
      assert(s.codeDir.startsWith("/"), `${when}: codeDir must be absolute, got ${s.codeDir}`);
    if (first !== null) {
      assert.equal(s.stateDir, first.stateDir, `${when}: stateDir must be stable`);
      assert.equal(s.codeDir, first.codeDir, `${when}: codeDir must be stable`);
    }
  };
  const assertStopped = async (
    s: DeviceServiceStatus,
    first: DeviceServiceStatus | null,
    when: string,
  ) => {
    assert.equal(s.name, SERVICE, `${when}: status names the service`);
    assert.equal(s.state, "stopped", `${when}: an ifRunning ensure must not start the service`);
    assert.equal(s.startedAt, null, `${when}: a stopped service has no startedAt`);
    assertDirs(s, first, when);
    await assert.rejects(ask("nobody"), `${when}: no service may answer requests`);
  };
  try {
    const before = await ifRunning();
    await assertStopped(before, null, "before any start");
    const again = await ifRunning();
    await assertStopped(again, before, "a second ifRunning ensure");

    const started = await ensure(handle, spec, signal());
    assert.equal(started.state, "running", "a normal ensure starts the service");
    assert.equal(typeof started.startedAt, "string", "a running service has startedAt");
    assertDirs(started, before, "once started");
    const found = await ensure(handle, spec, signal());
    assert.deepEqual(found, started, "a second normal ensure keeps the running service");
    const kept = await ifRunning();
    assert.deepEqual(kept, started, "an ifRunning ensure keeps the running service");

    const answer = await ask("hello conformance");
    assert.equal(new TextDecoder().decode(answer), "hello conformance", "requests round-trip");
    // the running service is still the one started, and it runs the reviewed entry path
    const argv1 = new TextDecoder().decode(await ask(DEVICE_SERVICE_ARGV_PROBE));
    const dir = (started.codeDir ?? started.stateDir).replace(/\/+$/, "");
    assert.equal(
      argv1,
      `${dir}/${spec.entry}`,
      "the service's process.argv[1] must be <codeDir ?? stateDir>/<entry>, the reviewed path",
    );

    await stop(handle, SERVICE, signal());
    const after = await ifRunning();
    await assertStopped(after, before, "after stopService");
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
