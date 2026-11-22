import {
  DEVICE_PROVIDER_EXTENSION_POINT,
  DeviceOfflineError,
  type DeviceProvider,
  type DeviceReport,
  defineExtension,
  type ExecResult,
  FileSystemGoneError,
  type FileSystemHandle,
  isDeviceOfflineError,
  ProjectPathRefusedError,
  type SandboxBackground,
  type SandboxExecutionRef,
  SandboxGoneError,
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
 * A machine refuses an operation by answering `{ error: { kind, message } }`: kind `gone` throws
 * `SandboxGoneError` (the instance is gone), `fileSystemGone` `FileSystemGoneError`, `refused`
 * `ProjectPathRefusedError` (the message is its reason's `en`, an optional `zh` its `zh`),
 * `offline` `DeviceOfflineError`; any other kind is an ordinary error with the message. An unconnected machine is the relay's own
 * `DeviceOfflineError`.
 *
 * The machine's hello body is `{ revision: string; outsideSandbox: boolean; perOperationHosts?:
 * boolean; openPublic?: boolean; background?: boolean; home?: string; refuse?: string }`: a
 * `refuse` makes `onHello` refuse with code `fake.refused`; `perOperationHosts` (default true),
 * `openPublic` and `background` (default false) are what its permission support reports, `home`
 * the report's home (default none). The accepted hello is kept in `ctx.kv`
 * (`hello:<deviceId>`, one hour) and `report()` is built from it; an `event` frame
 * `{ revision, outsideSandbox? }` replaces the revision (and the outside-sandbox answer, when
 * given). Both tell the kernel through `ctx.devices.reportChanged`. `permissionSupport` is an
 * operation boundary whose `outsideSandbox` is the stored answer. The permission-scoped surface
 * is relayed method by method, each with its scope in `args.scope`: `operation` (`stat`,
 * `readFile`, `writeFile`, `exec`, `list`, `scan` as the raw ops), `prepare` (`prepareStat`,
 * `prepareReadFile`, `prepareWriteFile`), `browse` (`browseStat`, `browseList`
 * `{ path, limit }`, `browseScan` `{ base }`), `background` (`backgroundStart` with the start's
 * input, `backgroundStatus`, `backgroundTail` `{ ref, maxBytes }`, `backgroundReadOutput`
 * `{ ref, offset, maxBytes }`, `backgroundStop` `{ ref, graceMs }`; output bytes as `data` in
 * base64) and `revokeOperation` `{ ref }`; raw `list` / `scan` likewise. Every event body is
 * kept as `frame:<deviceId>` and the reason of the last close as `closed:<deviceId>` (one hour),
 * for the tests to read; the connection info (`{ machineId, connectionId }`) of the last
 * `onHello`, `onFrame` and `onClose` as `hello-connection:`, `frame-connection:` and
 * `closed-connection:<deviceId>`; an event `{ hang: true }` is never finished.
 *
 * The public route `POST /plugins/fake-dial-in/request` (body `{ deviceId, body, timeoutMs? }`)
 * is a test seam: it calls `ctx.dialIn.request` on the replica that serves it, with the HTTP
 * request's signal (a client that disconnects gives the request up), and answers 200 with
 * `{ ok: true, body }` or `{ ok: false, error: { name, message, code?, offline } }`; the error is
 * also kept as `request-error:<deviceId>` (one hour). `GET /plugins/fake-dial-in/online?deviceId=`
 * answers `{ online }` from `ctx.dialIn.online`, and `GET /plugins/fake-dial-in/capacity?deviceId=`
 * answers `{ ok: true, capacity }` from `ctx.dialIn.capacity` or `{ ok: false, error: { name,
 * message } }`. The dual-replica tests drive the relay with them.
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
  openPublic?: boolean;
  background?: boolean;
  home?: string;
}

/** The support facts of a hello body that an `event` frame keeps. */
function supportFacts(body: Record<string, unknown> | StoredHello | null): Partial<StoredHello> {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    ...(b.perOperationHosts === false && { perOperationHosts: false }),
    ...(b.openPublic === true && { openPublic: true }),
    ...(b.background === true && { background: true }),
    ...(typeof b.home === "string" && { home: b.home }),
  };
}

/** The machine's refusal `{ error: { kind, message } }` as the provider error it stands for. */
function refusal(deviceId: string, answer: unknown): Error | null {
  if (!isRecord(answer) || !isRecord(answer.error) || typeof answer.error.kind !== "string")
    return null;
  const message = typeof answer.error.message === "string" ? answer.error.message : "refused";
  switch (answer.error.kind) {
    case "gone":
      return new SandboxGoneError(message);
    case "fileSystemGone":
      return new FileSystemGoneError(message);
    case "refused":
      return new ProjectPathRefusedError({
        en: message,
        ...(typeof answer.error.zh === "string" && { zh: answer.error.zh }),
      });
    case "offline":
      return new DeviceOfflineError(deviceId);
    default:
      return new Error(message);
  }
}

const bytes = (b64: string): Uint8Array => Buffer.from(b64, "base64");

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
      { method: "GET", path: "/capacity", access: "public" },
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
    /** Keeps the connection info of the last `kind` callback as `<kind>-connection:<deviceId>`. */
    const keepConnection = (kind: string, deviceId: string, connection: unknown) =>
      ctx.kv.set(`${kind}-connection:${deviceId}`, JSON.stringify(connection), {
        ttlSeconds: HELLO_TTL_SECONDS,
      });

    const relay = async (
      deviceId: string,
      op: string,
      args: unknown,
      signal: AbortSignal,
      timeoutMs = DEFAULT_TIMEOUT_MS,
    ): Promise<unknown> => {
      const answer = await ctx.dialIn.request(
        deviceId,
        { op, args },
        { timeoutMs: timeoutMs + SLACK_MS, signal },
      );
      const refused = refusal(deviceId, answer);
      if (refused !== null) throw refused;
      return answer;
    };
    const relayHandle = (h: SandboxHandle, op: string, args: unknown, signal: AbortSignal) =>
      relay(h.id, op, args, signal);

    type Output = { data: string } & Record<string, unknown>;
    const output = (r: unknown) => {
      const o = r as Output | { unavailable: "lost" | "expired" };
      return "unavailable" in o ? o : { ...o, data: bytes(o.data) };
    };
    const background: SandboxBackground = {
      async start(h, scope, { signal, ...args }) {
        return (await relayHandle(
          h,
          "backgroundStart",
          { ...args, scope },
          signal,
        )) as SandboxExecutionRef;
      },
      async status(h, ref, signal) {
        return (await relayHandle(h, "backgroundStatus", { ref }, signal)) as never;
      },
      async tail(h, ref, { maxBytes, signal }) {
        return output(await relayHandle(h, "backgroundTail", { ref, maxBytes }, signal)) as never;
      },
      async readOutput(h, ref, { offset, maxBytes, signal }) {
        return output(
          await relayHandle(h, "backgroundReadOutput", { ref, offset, maxBytes }, signal),
        ) as never;
      },
      async stop(h, ref, { graceMs, signal }) {
        return (await relayHandle(h, "backgroundStop", { ref, graceMs }, signal)) as never;
      },
    };

    const provider: DeviceProvider = {
      concurrentExec: true,
      networkAllowlist: true,
      async report(device, signal): Promise<DeviceReport> {
        void signal;
        const hello = await readHello(device.deviceId);
        return {
          revision: hello?.revision ?? "0",
          description: { en: "Fake dial-in device" },
          home: hello?.home ?? null,
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
            openPublic: hello?.openPublic ?? false,
            allowlist: true,
            perOperationHosts: hello?.perOperationHosts ?? true,
          },
          outsideSandbox: hello?.outsideSandbox ?? false,
          background: hello?.background ?? false,
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
          async list(path: string, opts: { limit: number; signal: AbortSignal }) {
            return await op("list", { path, limit: opts.limit }, opts.signal);
          },
          async scan(base: string, opts: { signal: AbortSignal }) {
            return await op("scan", { base }, opts.signal);
          },
        } as never;
      },
      async prepare(h, scope, _signal) {
        return {
          async stat(path: string, sig: AbortSignal) {
            return (await relayHandle(h, "prepareStat", { path, scope }, sig)) as {
              size: number;
              isDir: boolean;
            } | null;
          },
          async readFile(path: string, opts: { maxBytes: number; signal: AbortSignal }) {
            const r = (await relayHandle(
              h,
              "prepareReadFile",
              { path, maxBytes: opts.maxBytes, scope },
              opts.signal,
            )) as { data: string; truncated: boolean } | null;
            return r === null ? null : { data: bytes(r.data), truncated: r.truncated };
          },
          async writeFile(path: string, data: Uint8Array, sig: AbortSignal) {
            await relayHandle(
              h,
              "prepareWriteFile",
              { path, data: Buffer.from(data).toString("base64"), scope },
              sig,
            );
          },
        };
      },
      async browse(h, scope, _signal) {
        return {
          async stat(path: string, sig: AbortSignal) {
            return (await relayHandle(h, "browseStat", { path, scope }, sig)) as {
              size: number;
              isDir: boolean;
            } | null;
          },
          async list(path: string, opts: { limit: number; signal: AbortSignal }) {
            return (await relayHandle(
              h,
              "browseList",
              { path, limit: opts.limit, scope },
              opts.signal,
            )) as { entries: { name: string; isDir: boolean }[]; truncated: boolean } | null;
          },
          async scan(base: string, opts: { signal: AbortSignal }) {
            return (await relayHandle(h, "browseScan", { base, scope }, opts.signal)) as {
              path: string;
              suggestedName: string;
            }[];
          },
        };
      },
      async revokeOperation(h, ref, signal) {
        await relayHandle(h, "revokeOperation", { ref }, signal);
      },
      background,
      dialIn: {
        async onHello(deviceId, hello, _signal, connection) {
          await keepConnection("hello", deviceId, connection);
          const body = isRecord(hello) ? hello : {};
          if (typeof body.refuse === "string")
            return { ok: false, code: "fake.refused", message: body.refuse };
          await writeHello(deviceId, {
            revision: typeof body.revision === "string" ? body.revision : "0",
            outsideSandbox: body.outsideSandbox === true,
            ...supportFacts(body),
          });
          await reportChanged(deviceId);
          return { ok: true };
        },
        async onFrame(deviceId, frame, connection) {
          await keepConnection("frame", deviceId, connection);
          await ctx.kv.set(`frame:${deviceId}`, JSON.stringify(frame), {
            ttlSeconds: HELLO_TTL_SECONDS,
          });
          // a provider that never finishes handling (the gateway bounds the backlog)
          if (isRecord(frame) && frame.hang === true) await new Promise(() => {});
          if (!isRecord(frame) || typeof frame.revision !== "string") return;
          const hello = await readHello(deviceId);
          await writeHello(deviceId, {
            ...supportFacts(hello),
            outsideSandbox:
              typeof frame.outsideSandbox === "boolean"
                ? frame.outsideSandbox
                : (hello?.outsideSandbox ?? false),
            revision: frame.revision,
          });
          await reportChanged(deviceId);
        },
        onClose(deviceId, reason, connection) {
          // the connection first: a test that sees `closed:` finds its connection kept too
          void keepConnection("closed", deviceId, connection).then(() =>
            ctx.kv.set(`closed:${deviceId}`, reason, { ttlSeconds: HELLO_TTL_SECONDS }),
          );
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
      async list(h, path, { limit, signal }) {
        return (await relayHandle(h, "list", { path, limit }, signal)) as {
          entries: { name: string; isDir: boolean }[];
          truncated: boolean;
        } | null;
      },
      async scan(h, base, { signal }) {
        return (await relayHandle(h, "scan", { base }, signal)) as {
          path: string;
          suggestedName: string;
        }[];
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
    ctx.http.route("GET", "/capacity", async (req) => {
      const deviceId = new URL(req.url).searchParams.get("deviceId") ?? "";
      try {
        return Response.json({ ok: true, capacity: await ctx.dialIn.capacity(deviceId) });
      } catch (e) {
        return Response.json({
          ok: false,
          error: {
            name: e instanceof Error ? e.name : "Error",
            message: e instanceof Error ? e.message : String(e),
          },
        });
      }
    });
  },
});
