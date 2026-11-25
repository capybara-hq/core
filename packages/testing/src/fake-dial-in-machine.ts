import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type { KernelResponse, TestKernel } from "./kernel-helpers.js";

/** The protocol of the `fake-dial-in` fixture provider (`permissions.dialIn.protocol`). */
export const FAKE_DIAL_IN_PROTOCOL = "fake-dial-in/1";

export interface FakeDialInMachineOptions {
  /** The kernel's `connectUrl` (a `ws://` URL). */
  url: string;
  /** The machine credential `POST /api/v1/device/token` handed over. */
  credential: string;
  /** The protocol of the upgrade header and the hello (default {@link FAKE_DIAL_IN_PROTOCOL}). */
  protocol?: string;
  /** The hello's `body`: the provider's own. */
  hello: unknown;
  /** The largest frame this machine accepts, announced in the hello (default 1 MiB). */
  maxFrameBytes?: number;
  /** Random per program run (default: a fresh one). */
  programRunId?: string;
  /**
   * Offer binary `stream-data` in the hello (`transport.binaryStreamData`); once the kernel's
   * ready agrees, stream data goes both ways as binary messages (default false: JSON only).
   */
  binaryStreamData?: boolean;
}

/** The tag of a binary `stream-data` message (the SDK's `DIAL_IN_STREAM_DATA_TAG`). */
const STREAM_DATA_TAG = 1;

/** A binary `stream-data` message: tag, id length, id (ASCII), the bytes (the SDK's encoding). */
function encodeStreamData(streamId: string, data: Uint8Array): Buffer {
  const id = Buffer.from(streamId, "ascii");
  return Buffer.concat([Buffer.from([STREAM_DATA_TAG, id.length]), id, data]);
}

type RequestHandler = (body: unknown) => unknown | Promise<unknown>;

/**
 * The credit each side of a dial-in stream starts with for the other (the SDK's
 * `DIAL_IN_STREAM_INITIAL_CREDIT`, repeated so this module stays a plain test helper).
 */
const INITIAL_CREDIT = 8;

/**
 * The machine's end of one dial-in stream the kernel opened ({@link FakeDialInMachine.onStream}).
 * It honours the kernel's credit: {@link send} waits while the kernel granted no more messages.
 * By default it grants the kernel one message back for each message it receives; set
 * {@link autoCredit} to false to withhold credit and grant it with {@link grant}.
 */
export class FakeMachineStream {
  /** The messages received from the kernel, in order. */
  readonly received: Uint8Array[] = [];
  /** Grant the kernel one message back for each message received (default true). */
  autoCredit = true;
  /** Resolves when the stream closes (by either side), with the reason. */
  readonly closed: Promise<{ reason: string }>;
  private resolveClosed!: (v: { reason: string }) => void;
  private isClosed = false;
  /** Set once the machine answered `stream-opened`: no data goes out before it. */
  private opened = false;
  /** Messages this side may still send (granted by the kernel). */
  private credit = INITIAL_CREDIT;
  private readonly waiting: {
    data: Uint8Array;
    resolve: () => void;
    reject: (e: Error) => void;
  }[] = [];
  private readonly countWaiters: { n: number; resolve: () => void }[] = [];
  private messageHandler: ((m: Uint8Array) => void) | undefined;

  /** @internal */
  constructor(
    readonly streamId: string,
    private readonly sendFrame: (frame: unknown) => Promise<void>,
    /** Sends one message of this stream (JSON or binary, as the connection agreed). */
    private readonly sendData: (data: Uint8Array) => Promise<void>,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** Called for each message received (after it is recorded in {@link received}). */
  onMessage(fn: (m: Uint8Array) => void): void {
    this.messageHandler = fn;
  }

  /** Resolves once at least `n` messages were received. */
  receivedCount(n: number): Promise<void> {
    if (this.received.length >= n) return Promise.resolve();
    return new Promise((resolve) => this.countWaiters.push({ n, resolve }));
  }

  /** Sends one message once the kernel has credit for it. */
  send(message: Uint8Array): Promise<void> {
    if (this.isClosed) return Promise.reject(new Error("stream closed"));
    return new Promise((resolve, reject) => {
      this.waiting.push({ data: new Uint8Array(message), resolve, reject });
      this.flush();
    });
  }

  /** Grants the kernel `messages` more messages. */
  async grant(messages: number): Promise<void> {
    if (this.isClosed) return;
    await this.sendFrame({ type: "stream-credit", streamId: this.streamId, messages });
  }

  /** Closes the stream from the machine's side. */
  async close(reason = "closed"): Promise<void> {
    if (this.isClosed) return;
    await this.sendFrame({ type: "stream-close", streamId: this.streamId, reason });
    this.end(reason);
  }

  /** @internal */
  onFrame(frame: { type: string; data?: string; messages?: number; reason?: string }): void {
    if (this.isClosed) return;
    if (frame.type === "stream-data" && typeof frame.data === "string") {
      this.onData(new Uint8Array(Buffer.from(frame.data, "base64")));
    } else if (frame.type === "stream-credit" && typeof frame.messages === "number") {
      this.credit += frame.messages;
      this.flush();
    } else if (frame.type === "stream-close") {
      this.end(frame.reason ?? "closed");
    }
  }

  /** @internal one message from the kernel (a JSON or a binary `stream-data`). */
  onData(m: Uint8Array): void {
    if (this.isClosed) return;
    this.received.push(m);
    for (const w of this.countWaiters.splice(0)) {
      if (this.received.length >= w.n) w.resolve();
      else this.countWaiters.push(w);
    }
    if (this.autoCredit) void this.grant(1).catch(() => {});
    this.messageHandler?.(m);
  }

  /** @internal the machine answered `stream-opened` ok: queued messages may go out. */
  activate(): void {
    this.opened = true;
    this.flush();
  }

  /** @internal the stream ended (closed, or the socket went away). */
  end(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const w of this.waiting.splice(0)) w.reject(new Error(`stream closed: ${reason}`));
    this.resolveClosed({ reason });
  }

  private flush(): void {
    while (this.opened && this.credit > 0 && this.waiting.length > 0 && !this.isClosed) {
      const w = this.waiting.shift() as (typeof this.waiting)[number];
      this.credit--;
      this.sendData(w.data).then(w.resolve, w.reject);
    }
  }
}

/**
 * Called for each `stream-open` the kernel sends, with its body and the machine's end of the
 * stream. A throw refuses the stream (`stream-opened` with `ok: false` and the thrown message).
 */
type StreamHandler = (open: unknown, stream: FakeMachineStream) => void;

/**
 * A machine on the dial-in channel for kernel tests: connects to a deployment, sends the hello
 * envelope, waits for the kernel's `ready` and then answers each `req` through the handler set
 * with {@link onRequest} (a `res` with the same `id`). Bodies are opaque to it, like they are to
 * the kernel.
 */
export class FakeDialInMachine {
  /** Resolves when the socket closes, with the close code and reason the kernel sent. */
  readonly closed: Promise<{ code: number; reason: string }>;
  /** The kernel's id of this connection (from `ready`). */
  readonly connectionId: string;
  /** The connection's effective frame capacity (from `ready`): at most the announced one. */
  readonly maxFrameBytes: number;
  /** Whether hello and ready agreed on binary `stream-data`. */
  readonly binaryStreamData: boolean;
  /** Binary `stream-data` messages received from the kernel. */
  binaryReceived = 0;
  /** The bodies of the `req` frames received, in order. */
  readonly requests: unknown[] = [];
  /** The ids of the `cancel` frames received, in order. */
  readonly cancels: string[] = [];
  /** The reasons of the `stop` frames received, in order. */
  readonly stops: ("drain" | "stop")[] = [];
  /** Socket errors after `ready` (kept, so an error never goes unhandled), in order. */
  readonly errors: Error[] = [];
  /**
   * Kernel messages it could not take, in order: text that was not JSON, and binary messages
   * (hex) that were not an agreed `stream-data` (the kernel never sends either).
   */
  readonly invalid: string[] = [];
  private handler: RequestHandler = () => ({});
  private streamHandler: StreamHandler | undefined;
  /** Leave every `stream-open` unanswered (a machine that never opens streams). */
  ignoreStreamOpens = false;
  /**
   * While set, each `stream-open` is answered only once this promise resolves (a machine slow to
   * open its service): a test holds the kernel's stream open here.
   */
  streamOpenGate: Promise<void> | undefined;
  /** The ids of the `stream-open` frames received, in order. */
  readonly streamOpens: string[] = [];
  /** The ids of the `stream-close` frames received, in order (also of streams never opened). */
  readonly streamCloses: string[] = [];
  /** The streams the kernel opened and that are still open, by id. */
  private readonly streams = new Map<string, FakeMachineStream>();

  private constructor(
    private readonly ws: WebSocket,
    ready: { connectionId: string; maxFrameBytes: number; binaryStreamData: boolean },
    closed: Promise<{ code: number; reason: string }>,
  ) {
    this.connectionId = ready.connectionId;
    this.maxFrameBytes = ready.maxFrameBytes;
    this.binaryStreamData = ready.binaryStreamData;
    this.closed = closed;
    // the connect promise's listener is gone once settled: an error later must not go unhandled
    ws.on("error", (e) => this.errors.push(e));
    ws.on("message", (data, isBinary) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (isBinary) this.onBinary(buf);
      else this.onMessage(buf.toString());
    });
    void closed.then(() => {
      for (const st of this.streams.values()) st.end("socket closed");
      this.streams.clear();
    });
  }

  /**
   * Connects and resolves once the kernel answered `ready`. Rejects when the upgrade is refused
   * (the message carries the HTTP status and body) or the socket closes first (the close code).
   */
  static connect(opts: FakeDialInMachineOptions): Promise<FakeDialInMachine> {
    const protocol = opts.protocol ?? FAKE_DIAL_IN_PROTOCOL;
    const maxFrameBytes = opts.maxFrameBytes ?? 1024 * 1024;
    const ws = new WebSocket(opts.url, {
      headers: {
        authorization: `Bearer ${opts.credential}`,
        "x-capybara-device-protocol": protocol,
      },
      maxPayload: maxFrameBytes,
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    return new Promise<FakeDialInMachine>((resolve, reject) => {
      ws.once("unexpected-response", (_req, res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          reject(
            new Error(
              `upgrade refused: HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
            ),
          ),
        );
      });
      ws.once("error", reject);
      void closed.then((c) =>
        reject(new Error(`closed before ready: ${c.code} ${c.reason}`.trim())),
      );
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            type: "hello",
            protocol,
            programRunId: opts.programRunId ?? randomUUID(),
            program: { version: "0.0.0-fake", os: "linux", arch: "x64" },
            transport: { maxFrameBytes, ...(opts.binaryStreamData && { binaryStreamData: true }) },
            body: opts.hello,
          }),
        );
        ws.once("message", (data) => {
          let frame: {
            type?: unknown;
            connectionId?: unknown;
            maxFrameBytes?: unknown;
            binaryStreamData?: unknown;
          };
          try {
            frame = JSON.parse(data.toString());
          } catch {
            ws.terminate();
            reject(new Error("the kernel's first frame is not JSON"));
            return;
          }
          if (
            frame.type !== "ready" ||
            typeof frame.connectionId !== "string" ||
            typeof frame.maxFrameBytes !== "number"
          ) {
            ws.terminate();
            reject(new Error(`expected a ready frame, got ${data.toString()}`));
            return;
          }
          resolve(
            new FakeDialInMachine(
              ws,
              {
                connectionId: frame.connectionId,
                maxFrameBytes: frame.maxFrameBytes,
                binaryStreamData: opts.binaryStreamData === true && frame.binaryStreamData === true,
              },
              closed,
            ),
          );
        });
      });
    });
  }

  /** Sets the handler of `req` bodies; its result (or its thrown message) is the `res` body. */
  onRequest(fn: RequestHandler): void {
    this.handler = fn;
  }

  /**
   * Sets the handler of the streams the kernel opens (`stream-open`); without one every stream is
   * refused.
   */
  onStream(fn: StreamHandler): void {
    this.streamHandler = fn;
  }

  /** Sends an unsolicited `event` frame with `event` as its body. */
  async send(event: unknown): Promise<void> {
    await this.sendFrame({ type: "event", body: event });
  }

  /** Closes the socket (a normal close) and resolves when it is closed. */
  async close(): Promise<void> {
    if (this.ws.readyState !== WebSocket.CLOSED) this.ws.close(1000);
    await this.closed;
  }

  private sendFrame(frame: unknown): Promise<void> {
    return new Promise((resolve, reject) =>
      this.ws.send(JSON.stringify(frame), (e) => (e ? reject(e) : resolve())),
    );
  }

  /**
   * A binary message: a `stream-data` of a connection that agreed on binary (anything else is
   * kept in {@link invalid} as hex).
   */
  private onBinary(buf: Buffer): void {
    const len = buf[1] ?? 0;
    // binary the connection did not agree on is the kernel's mistake: kept, never delivered
    if (
      !this.binaryStreamData ||
      buf.length < 2 ||
      buf[0] !== STREAM_DATA_TAG ||
      buf.length < 2 + len
    ) {
      this.invalid.push(buf.toString("hex"));
      return;
    }
    this.binaryReceived++;
    const streamId = buf.subarray(2, 2 + len).toString("ascii");
    this.streams.get(streamId)?.onData(new Uint8Array(buf.subarray(2 + len)));
  }

  private onMessage(text: string): void {
    let frame: {
      type: string;
      id?: string;
      body?: unknown;
      reason?: string;
      streamId?: string;
      data?: string;
      messages?: number;
    };
    try {
      frame = JSON.parse(text);
    } catch {
      this.invalid.push(text);
      return;
    }
    if (frame.type === "req" && frame.id !== undefined) {
      const id = frame.id;
      this.requests.push(frame.body);
      void (async () => {
        let body: unknown;
        try {
          body = await this.handler(frame.body);
        } catch (e) {
          body = { error: e instanceof Error ? e.message : String(e) };
        }
        // a socket closed meanwhile has nobody to answer
        if (this.ws.readyState === WebSocket.OPEN)
          await this.sendFrame({ type: "res", id, body: body ?? null });
      })();
    } else if (frame.type === "cancel" && frame.id !== undefined) {
      this.cancels.push(frame.id);
    } else if (frame.type === "stop" && (frame.reason === "drain" || frame.reason === "stop")) {
      this.stops.push(frame.reason);
    } else if (frame.type === "stream-open" && frame.streamId !== undefined) {
      this.streamOpens.push(frame.streamId);
      if (!this.ignoreStreamOpens) {
        const streamId = frame.streamId;
        const body = frame.body;
        const gate = this.streamOpenGate;
        if (gate === undefined) this.openStream(streamId, body);
        else void gate.then(() => this.openStream(streamId, body));
      }
    } else if (frame.type.startsWith("stream-") && frame.streamId !== undefined) {
      if (frame.type === "stream-close") this.streamCloses.push(frame.streamId);
      const st = this.streams.get(frame.streamId);
      st?.onFrame(frame);
      if (frame.type === "stream-close") this.streams.delete(frame.streamId);
    }
  }

  private openStream(streamId: string, body: unknown): void {
    const st = new FakeMachineStream(
      streamId,
      (f) => this.sendFrame(f),
      (data) =>
        this.binaryStreamData
          ? new Promise<void>((resolve, reject) =>
              this.ws.send(encodeStreamData(streamId, data), (e) => (e ? reject(e) : resolve())),
            )
          : this.sendFrame({
              type: "stream-data",
              streamId,
              data: Buffer.from(data).toString("base64"),
            }),
    );
    void st.closed.then(() => this.streams.delete(streamId));
    let error: string | undefined;
    if (this.streamHandler === undefined) error = "this machine opens no streams";
    else {
      try {
        this.streamHandler(body, st);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
    }
    if (error !== undefined) {
      void this.sendFrame({ type: "stream-opened", streamId, ok: false, error }).catch(() => {});
      return;
    }
    this.streams.set(streamId, st);
    // queued on the socket before any data the handler already asked to send
    void this.sendFrame({ type: "stream-opened", streamId, ok: true }).catch(() => {});
    st.activate();
  }
}

function expectOk(res: KernelResponse, what: string): Record<string, unknown> {
  if (res.statusCode !== 200) {
    throw new Error(`${what}: expected HTTP 200, got ${res.statusCode}: ${res.body}`);
  }
  return JSON.parse(res.body) as Record<string, unknown>;
}

/**
 * Signs a fake machine in over HTTP like `capybara-device login` does: `authorize` (public),
 * `confirm` (the person's session, `session` is its `Cookie` header value) into a new device of
 * `provider` (the plugin name) in `orgId`, then `token`. Returns the machine credential and the
 * new device's id; connect with {@link FakeDialInMachine.connect} at `kernel`'s `connectUrl`.
 */
export async function signInFakeMachine(
  kernel: TestKernel,
  opts: {
    orgId: string;
    session: string;
    provider: string;
    protocol: string;
    name?: string;
  },
): Promise<{ credential: string; deviceId: string; connectUrl: string }> {
  const csrf = { "x-capybara-csrf": "1", "content-type": "application/json" };
  const name = opts.name ?? "fake-machine";
  const authorized = expectOk(
    await kernel.http.inject({
      method: "POST",
      url: "/api/v1/device/authorize",
      headers: csrf,
      payload: {
        name,
        os: "linux",
        arch: "x64",
        programVersion: "0.0.0-fake",
        protocol: opts.protocol,
      },
    }),
    "device authorize",
  );
  expectOk(
    await kernel.http.inject({
      method: "POST",
      url: "/api/v1/device/confirm",
      headers: { ...csrf, cookie: opts.session },
      payload: {
        userCode: authorized.userCode,
        orgId: opts.orgId,
        provider: opts.provider,
        name,
      },
    }),
    "device confirm",
  );
  const grant = expectOk(
    await kernel.http.inject({
      method: "POST",
      url: "/api/v1/device/token",
      headers: csrf,
      payload: { deviceCode: authorized.deviceCode },
    }),
    "device token",
  );
  return {
    credential: String(grant.credential),
    deviceId: String(grant.deviceId),
    connectUrl: String(grant.connectUrl),
  };
}
