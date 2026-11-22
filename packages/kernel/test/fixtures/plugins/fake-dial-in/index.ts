import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  type DeviceProvider,
  type DeviceReport,
  defineExtension,
  type ExecResult,
  type FileSystemHandle,
  isDeviceOfflineError,
  type SandboxHandle,
  type SandboxPermissionSupport,
} from "@capybara-hq/plugin-sdk";

/**
 * Test `device-provider@1` served over the generic dial-in channel (for tests only): a machine
 * that connects with the protocol {@link PROTOCOL} serves the device, and every provider
 * operation is relayed to it as the request body `{ op, args }` through `ctx.dialIn.request`; the
 * machine answers with the operation's result (bytes as base64). The kernel tests drive it with
 * `FakeDialInMachine` from `@capybara-hq/testing`, never with the real device-local plugin.
 *
 * The machine's hello body is `{ revision: string; outsideSandbox: boolean; perOperationHosts?:
 * boolean; refuse?: string }`: a `refuse` makes `onHello` refuse with code `fake.refused`;
 * `perOperationHosts` (default true) is what its permission support reports. The accepted hello is kept in `ctx.kv`
 * (`hello:<deviceId>`, one hour) and `report()` is built from it; an `event` frame
 * `{ revision, outsideSandbox? }` replaces the revision (and the outside-sandbox answer, when
 * given). Both tell the kernel through `ctx.devices.reportChanged`. `permissionSupport` is an
 * operation boundary whose `outsideSandbox` is the stored answer; the permission-scoped surface
 * (`operation`, `revokeOperation`) relays each method with its admitted scope. Every event body is kept as
 * `frame:<deviceId>` and the reason of the last close as `closed:<deviceId>` (one hour), for the
 * tests to read; an event `{ hang: true }` is never finished.
 *
 * The public route `POST /plugins/fake-dial-in/request` (body `{ deviceId, body, timeoutMs? }`)
 * is a test seam: it calls `ctx.dialIn.request` on the replica that serves it, with the HTTP
 * request's signal (a client that disconnects gives the request up), and answers 200 with
 * `{ ok: true, body }` or `{ ok: false, error: { name, message, code?, offline } }`; the error is
 * also kept as `request-error:<deviceId>` (one hour). `GET /plugins/fake-dial-in/online?deviceId=`
 * answers `{ online }` from `ctx.dialIn.online`. The dual-replica tests drive the relay with them.
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
  perOperationHosts?: boolean;
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
  permissions: {
    dialIn: { protocol: PROTOCOL },
    http: [
      { method: "POST", path: "/request", access: "public" },
      { method: "GET", path: "/online", access: "public" },
    ],
  },
  setup(ctx) {
    const helloKey = (deviceId: string) => `hello:${deviceId}`;
    const readHello = async (deviceId: string): Promise<StoredHello | null> => {
      const raw = await ctx.kv.get(helloKey(deviceId));
      return raw === null ? null : (JSON.parse(raw) as StoredHello);
    };
    const writeHello = (deviceId: string, hello: StoredHello) =>
      ctx.kv.set(helloKey(deviceId), JSON.stringify(hello), { ttlSeconds: HELLO_TTL_SECONDS });
    const reportChanged = (deviceId: string): Promise<void> => ctx.devices.reportChanged(deviceId);

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
      async permissionSupport(h): Promise<SandboxPermissionSupport> {
        const hello = await readHello(h.id);
        return {
          version: 2,
          boundary: "operation",
          restricted: { filesystem: true, network: true, native: true, concurrentScopes: true },
          network: {
            openPublic: false,
            allowlist: true,
            perOperationHosts: hello?.perOperationHosts ?? true,
          },
          outsideSandbox: hello?.outsideSandbox ?? false,
          background: false,
        };
      },
      // the permission-scoped surface, relayed with the admitted scope: the machine answers each
      // operation's method as it answers the raw one
      async operation(h, scope, _signal) {
        const op = (method: string, args: Record<string, unknown>, sig: AbortSignal) =>
          relayHandle(h, method, { ...args, scope }, sig);
        return {
          async stat(path: string, sig: AbortSignal) {
            return (await op("stat", { path }, sig)) as { size: number; isDir: boolean } | null;
          },
          async readFile(path: string, opts: { maxBytes: number; signal: AbortSignal }) {
            const r = (await op("readFile", { path, maxBytes: opts.maxBytes }, opts.signal)) as {
              data: string;
              truncated: boolean;
            } | null;
            return r === null
              ? null
              : { data: Buffer.from(r.data, "base64"), truncated: r.truncated };
          },
          async writeFile(path: string, data: Uint8Array, sig: AbortSignal) {
            await op("writeFile", { path, data: Buffer.from(data).toString("base64") }, sig);
          },
          async exec({ signal: sig, ...args }: { signal: AbortSignal } & Record<string, unknown>) {
            return (await op("exec", args, sig)) as ExecResult;
          },
        } as never;
      },
      async revokeOperation(h, ref, signal) {
        await relayHandle(h, "revokeOperation", { ref }, signal);
      },
      dialIn: {
        async onHello(deviceId, hello) {
          const body = isRecord(hello) ? hello : {};
          if (typeof body.refuse === "string")
            return { ok: false, code: "fake.refused", message: body.refuse };
          await writeHello(deviceId, {
            revision: typeof body.revision === "string" ? body.revision : "0",
            outsideSandbox: body.outsideSandbox === true,
            ...(body.perOperationHosts === false && { perOperationHosts: false }),
          });
          await reportChanged(deviceId);
          return { ok: true };
        },
        async onFrame(deviceId, frame) {
          await ctx.kv.set(`frame:${deviceId}`, JSON.stringify(frame), {
            ttlSeconds: HELLO_TTL_SECONDS,
          });
          // a provider that never finishes handling (the gateway bounds the backlog)
          if (isRecord(frame) && frame.hang === true) await new Promise(() => {});
          if (!isRecord(frame) || typeof frame.revision !== "string") return;
          const hello = await readHello(deviceId);
          await writeHello(deviceId, {
            ...(hello?.perOperationHosts === false && { perOperationHosts: false }),
            outsideSandbox:
              typeof frame.outsideSandbox === "boolean"
                ? frame.outsideSandbox
                : (hello?.outsideSandbox ?? false),
            revision: frame.revision,
          });
          await reportChanged(deviceId);
        },
        onClose(deviceId, reason) {
          void ctx.kv.set(`closed:${deviceId}`, reason, { ttlSeconds: HELLO_TTL_SECONDS });
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

    // test seams: ctx.dialIn called on whichever replica serves the route
    ctx.http.route("POST", "/request", async (req) => {
      const input = (await req.json()) as { deviceId: string; body: unknown; timeoutMs?: number };
      try {
        const body = await ctx.dialIn.request(input.deviceId, input.body, {
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          signal: req.signal,
        });
        return Response.json({ ok: true, body });
      } catch (e) {
        const error = {
          name: e instanceof Error ? e.name : "Error",
          message: e instanceof Error ? e.message : String(e),
          ...(isRecord(e) && typeof e.code === "string" && { code: e.code }),
          offline: isDeviceOfflineError(e),
        };
        await ctx.kv.set(`request-error:${input.deviceId}`, JSON.stringify(error), {
          ttlSeconds: HELLO_TTL_SECONDS,
        });
        return Response.json({ ok: false, error });
      }
    });
    ctx.http.route("GET", "/online", async (req) => {
      const deviceId = new URL(req.url).searchParams.get("deviceId") ?? "";
      return Response.json({ online: await ctx.dialIn.online(deviceId) });
    });
  },
});
