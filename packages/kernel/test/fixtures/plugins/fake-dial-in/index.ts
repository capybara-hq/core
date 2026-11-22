import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  type DeviceProvider,
  type DeviceReport,
  defineExtension,
  type ExecResult,
  type FileSystemHandle,
  type SandboxHandle,
} from "@capybara-hq/plugin-sdk";

/**
 * Test `device-provider@1` served over the generic dial-in channel (for tests only): a machine
 * that connects with the protocol {@link PROTOCOL} serves the device, and every provider
 * operation is relayed to it as the request body `{ op, args }` through `ctx.dialIn.request`; the
 * machine answers with the operation's result (bytes as base64). The kernel tests drive it with
 * `FakeDialInMachine` from `@capybara-hq/testing`, never with the real device-local plugin.
 *
 * The machine's hello body is `{ revision: string; outsideSandbox: boolean; refuse?: string }`: a
 * `refuse` makes `onHello` refuse with code `fake.refused`. The accepted hello is kept in `ctx.kv`
 * (`hello:<deviceId>`, one hour) and `report()` is built from it; an `event` frame
 * `{ revision }` replaces the revision. Both tell the kernel through `ctx.devices.reportChanged`.
 *
 * Handles are the device id: the device's file system and its instance are both named
 * `cap-device-<deviceId>`, so every operation can address its machine.
 */
const PROTOCOL = "fake-dial-in/1";
const NAME_PREFIX = "cap-device-";
const HELLO_TTL_SECONDS = 3600;
/** The time a machine has to answer a relayed operation beyond the operation's own limit. */
const SLACK_MS = 5000;
const DEFAULT_TIMEOUT_MS = 30000;

interface StoredHello {
  revision: string;
  outsideSandbox: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function deviceIdOfName(name: string): string {
  return name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : name;
}

export default defineExtension({
  name: "fake-dial-in",
  version: "0.1.0",
  sdk: "^0.1.0-rc.0",
  provides: [DEVICE_PROVIDER_EXTENSION_POINT],
  permissions: { dialIn: { protocol: PROTOCOL } },
  setup(ctx) {
    const helloKey = (deviceId: string) => `hello:${deviceId}`;
    const readHello = async (deviceId: string): Promise<StoredHello | null> => {
      const raw = await ctx.kv.get(helloKey(deviceId));
      return raw === null ? null : (JSON.parse(raw) as StoredHello);
    };
    const writeHello = (deviceId: string, hello: StoredHello) =>
      ctx.kv.set(helloKey(deviceId), JSON.stringify(hello), { ttlSeconds: HELLO_TTL_SECONDS });

    const relay = (
      deviceId: string,
      op: string,
      args: unknown,
      signal: AbortSignal,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<unknown> =>
      ctx.dialIn.request(deviceId, { op, args }, { timeoutMs: timeoutMs + SLACK_MS, signal });
    const relayHandle = (h: SandboxHandle, op: string, args: unknown, signal: AbortSignal) =>
      relay(h.id, op, args, signal);

    const provider: DeviceProvider = {
      concurrentExec: true,
      networkAllowlist: true,
      async report(device, signal): Promise<DeviceReport> {
        void signal;
        const hello = await readHello(device.deviceId);
        return {
          revision: hello?.revision ?? "0",
          description: { en: "Fake dial-in device" },
          home: null,
          limits: [],
          reset: false,
        };
      },
      dialIn: {
        async onHello(deviceId, hello) {
          const body = isRecord(hello) ? hello : {};
          if (typeof body.refuse === "string")
            return { ok: false, code: "fake.refused", message: body.refuse };
          await writeHello(deviceId, {
            revision: typeof body.revision === "string" ? body.revision : "0",
            outsideSandbox: body.outsideSandbox === true,
          });
          await ctx.devices.reportChanged(deviceId);
          return { ok: true };
        },
        async onFrame(deviceId, frame) {
          if (!isRecord(frame) || typeof frame.revision !== "string") return;
          const hello = await readHello(deviceId);
          await writeHello(deviceId, {
            outsideSandbox: hello?.outsideSandbox ?? false,
            revision: frame.revision,
          });
          await ctx.devices.reportChanged(deviceId);
        },
      },
      async createFileSystem({ name, limits, signal }): Promise<FileSystemHandle> {
        const id = deviceIdOfName(name);
        await relay(id, "createFileSystem", { name, limits }, signal);
        return { id };
      },
      async destroyFileSystem(fs, signal) {
        await relay(fs.id, "destroyFileSystem", {}, signal);
      },
      async destroyFileSystemByName(name, signal) {
        await relay(deviceIdOfName(name), "destroyFileSystemByName", { name }, signal);
      },
      async create({ name, image, limits, fileSystem, signal }): Promise<SandboxHandle> {
        const id = deviceIdOfName(name);
        await relay(id, "create", { name, image, limits, fileSystem }, signal);
        return { id };
      },
      async resume(h, signal) {
        return (await relayHandle(h, "resume", {}, signal)) === "gone" ? "gone" : "resumed";
      },
      async suspend(h, signal) {
        await relayHandle(h, "suspend", {}, signal);
      },
      async destroy(h, signal) {
        await relayHandle(h, "destroy", {}, signal);
      },
      async destroyByName(name, signal) {
        await relay(deviceIdOfName(name), "destroyByName", { name }, signal);
      },
      async killAll(h, signal) {
        await relayHandle(h, "killAll", {}, signal);
      },
      async killTagged(h, tags, signal) {
        await relayHandle(h, "killTagged", { tags }, signal);
      },
      async exec(h, { signal, ...args }) {
        return (await relay(h.id, "exec", args, signal, args.timeoutMs)) as ExecResult;
      },
      async readFile(h, path, { maxBytes, signal }) {
        const r = (await relayHandle(h, "readFile", { path, maxBytes }, signal)) as {
          data: string;
          truncated: boolean;
        } | null;
        return r === null ? null : { data: Buffer.from(r.data, "base64"), truncated: r.truncated };
      },
      async writeFile(h, path, data, signal) {
        await relayHandle(
          h,
          "writeFile",
          { path, data: Buffer.from(data).toString("base64") },
          signal,
        );
      },
      async stat(h, path, signal) {
        return (await relayHandle(h, "stat", { path }, signal)) as {
          size: number;
          isDir: boolean;
        } | null;
      },
    };
    ctx.provide(DEVICE_PROVIDER_EXTENSION_POINT, provider);
  },
});
