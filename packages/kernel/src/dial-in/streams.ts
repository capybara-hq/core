import { randomUUID } from "node:crypto";
import {
  DeviceOfflineError,
  type DeviceStream,
  DIAL_IN_STREAM_INITIAL_CREDIT,
  type DialInKernelFrame,
  type DialInMachineFrame,
} from "@capybara-hq/plugin-sdk";

/** The stream frames a machine sends ({@link DialInStreams.onFrame}). */
export type DialInMachineStreamFrame = Extract<
  DialInMachineFrame,
  { type: "stream-opened" | "stream-data" | "stream-credit" | "stream-close" }
>;

/** Whether a machine frame belongs to a stream (routed to {@link DialInStreams.onFrame}). */
export function isStreamFrame(frame: DialInMachineFrame): frame is DialInMachineStreamFrame {
  return (
    frame.type === "stream-opened" ||
    frame.type === "stream-data" ||
    frame.type === "stream-credit" ||
    frame.type === "stream-close"
  );
}

/** What a connection's stream table needs from its socket. */
export interface DialInStreamTransport {
  /** Sends one frame's text on the socket; false when the socket is no longer open. */
  send(text: string): boolean;
  /** The connection's negotiated frame capacity in UTF-8 bytes. */
  maxFrameBytes(): number;
}

/** The reason every stream of a connection ends with when its socket closes. */
export const STREAM_OFFLINE_REASON = "device-offline";
/** Reasons and errors travel at most this many characters (the envelope's limit). */
const MAX_REASON = 500;

const clip = (text: string): string =>
  text.length > MAX_REASON ? text.slice(0, MAX_REASON) : text;

/** One stream of the table: its credit both ways, its queues and how it ends. */
class Stream implements DeviceStream {
  /** Messages the kernel may still send (granted by the machine). */
  private sendCredit = DIAL_IN_STREAM_INITIAL_CREDIT;
  /** Messages the machine may still send (granted by the kernel). */
  private recvCredit = DIAL_IN_STREAM_INITIAL_CREDIT;
  /** Sends waiting for credit, in call order (each frame text already checked to fit). */
  private readonly waiting: { text: string; resolve: () => void; reject: (e: Error) => void }[] =
    [];
  /** Messages received and not consumed yet (at most the credit the kernel granted). */
  private readonly inbox: Uint8Array[] = [];
  /** A consumer waiting for the next message. */
  private reader: ((r: IteratorResult<Uint8Array>) => void) | undefined;
  private endedWith: string | undefined;
  private resolveClosed!: (v: { reason: string }) => void;
  readonly closed: Promise<{ reason: string }>;
  readonly messages: AsyncIterable<Uint8Array>;

  constructor(
    readonly id: string,
    private readonly transport: DialInStreamTransport,
    private readonly forget: (id: string) => void,
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    const next = (): Promise<IteratorResult<Uint8Array>> => {
      const m = this.inbox.shift();
      if (m !== undefined) {
        this.consumed();
        return Promise.resolve({ value: m, done: false });
      }
      if (this.endedWith !== undefined) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => {
        this.reader = resolve;
      });
    };
    const iterator: AsyncIterator<Uint8Array> = {
      next,
      return: async () => ({ value: undefined, done: true }),
    };
    this.messages = { [Symbol.asyncIterator]: () => iterator };
  }

  send(message: Uint8Array): Promise<void> {
    if (!(message instanceof Uint8Array))
      return Promise.reject(new TypeError("A stream message must be a Uint8Array"));
    if (this.endedWith !== undefined)
      return Promise.reject(new Error(`The stream is closed: ${this.endedWith}`));
    const frame: DialInKernelFrame = {
      type: "stream-data",
      streamId: this.id,
      data: Buffer.from(message.buffer, message.byteOffset, message.byteLength).toString("base64"),
    };
    const text = JSON.stringify(frame);
    const cap = this.transport.maxFrameBytes();
    // a message is never split: one that does not fit one frame is refused
    if (Buffer.byteLength(text) > cap)
      return Promise.reject(
        new Error(
          `A stream message of ${message.byteLength} bytes does not fit the connection's frame capacity of ${cap} bytes once base64-encoded; send smaller messages`,
        ),
      );
    return new Promise((resolve, reject) => {
      this.waiting.push({ text, resolve, reject });
      this.flush();
    });
  }

  close(reason = "closed"): void {
    if (this.endedWith !== undefined) return;
    const why = clip(String(reason));
    this.transport.send(JSON.stringify({ type: "stream-close", streamId: this.id, reason: why }));
    this.end(why);
  }

  /** A frame of this stream from the machine. */
  onFrame(frame: DialInMachineStreamFrame): void {
    if (this.endedWith !== undefined) return;
    if (frame.type === "stream-credit") {
      this.sendCredit += frame.messages;
      this.flush();
    } else if (frame.type === "stream-data") {
      if (this.recvCredit <= 0) {
        // the machine sent beyond the credit the kernel granted: the stream ends, the connection
        // and its other streams go on
        this.close("credit exceeded");
        return;
      }
      this.recvCredit--;
      const m = new Uint8Array(Buffer.from(frame.data, "base64"));
      const reader = this.reader;
      if (reader) {
        this.reader = undefined;
        this.consumed();
        reader({ value: m, done: false });
      } else this.inbox.push(m);
    } else if (frame.type === "stream-close") {
      this.end(frame.reason);
    }
  }

  /** The stream ended (either side, or the socket): waiting sends fail, the reader ends. */
  end(reason: string): void {
    if (this.endedWith !== undefined) return;
    this.endedWith = reason;
    this.forget(this.id);
    for (const w of this.waiting.splice(0)) w.reject(new Error(`The stream is closed: ${reason}`));
    const reader = this.reader;
    this.reader = undefined;
    reader?.({ value: undefined, done: true });
    this.resolveClosed({ reason });
  }

  /** One message was handed to the consumer: the machine may send one more. */
  private consumed(): void {
    if (this.endedWith !== undefined) return;
    this.recvCredit++;
    this.transport.send(JSON.stringify({ type: "stream-credit", streamId: this.id, messages: 1 }));
  }

  private flush(): void {
    while (this.sendCredit > 0 && this.waiting.length > 0 && this.endedWith === undefined) {
      const w = this.waiting.shift() as (typeof this.waiting)[number];
      if (!this.transport.send(w.text)) {
        w.reject(new Error(`The stream is closed: ${STREAM_OFFLINE_REASON}`));
        continue;
      }
      this.sendCredit--;
      w.resolve();
    }
  }
}

/**
 * The streams of one machine connection on the gateway replica holding its socket (browser use
 * spec §6.1): opened with `stream-open`, carried as `stream-data` frames straight over the socket
 * (never through Redis or PG), each side sending only while it holds credit
 * ({@link DIAL_IN_STREAM_INITIAL_CREDIT} at the open, one more per message the other side
 * consumed). A data frame carries one whole message in base64; a message that does not fit the
 * connection's frame capacity is refused, never split. The table is the connection's own state and
 * lives exactly as long as the socket: its close ends every stream with
 * {@link STREAM_OFFLINE_REASON}.
 */
export class DialInStreams {
  private readonly open = new Map<string, Stream>();
  /** Streams sent `stream-open` and not answered yet. */
  private readonly opening = new Map<
    string,
    { resolve: (s: Stream) => void; reject: (e: Error) => void; stream: Stream }
  >();
  private ended = false;

  constructor(
    private readonly deviceId: string,
    private readonly transport: DialInStreamTransport,
  ) {}

  /**
   * Opens a stream: sends `stream-open` with `body` and resolves once the machine answered
   * `stream-opened` ok. A refusal rejects with the machine's error; `signal` bounds the opening
   * only (an abort sends `stream-close` and rejects with the signal's reason); the socket's close
   * rejects with `DeviceOfflineError`.
   */
  openStream(body: unknown, signal: AbortSignal): Promise<DeviceStream> {
    if (this.ended) return Promise.reject(new DeviceOfflineError(this.deviceId));
    signal.throwIfAborted();
    const streamId = randomUUID();
    const text = JSON.stringify({
      type: "stream-open",
      streamId,
      body,
    } satisfies DialInKernelFrame);
    const cap = this.transport.maxFrameBytes();
    if (Buffer.byteLength(text) > cap)
      return Promise.reject(
        new Error(
          `The stream-open frame does not fit the connection's frame capacity of ${cap} bytes; send a smaller target`,
        ),
      );
    const stream = new Stream(streamId, this.transport, (id) => this.open.delete(id));
    return new Promise<DeviceStream>((resolve, reject) => {
      const onAbort = () => {
        if (!this.opening.delete(streamId)) return;
        this.transport.send(JSON.stringify({ type: "stream-close", streamId, reason: "aborted" }));
        stream.end("aborted");
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      };
      this.opening.set(streamId, {
        stream,
        resolve: (s) => {
          signal.removeEventListener("abort", onAbort);
          resolve(s);
        },
        reject: (e) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (!this.transport.send(text)) {
        this.opening.delete(streamId);
        signal.removeEventListener("abort", onAbort);
        reject(new DeviceOfflineError(this.deviceId));
      }
    });
  }

  /** A stream frame from the machine; a frame of a stream that is not open is dropped. */
  onFrame(frame: DialInMachineStreamFrame): void {
    if (frame.type === "stream-opened") {
      const pending = this.opening.get(frame.streamId);
      if (pending === undefined) return;
      this.opening.delete(frame.streamId);
      if (frame.ok) {
        this.open.set(frame.streamId, pending.stream);
        pending.resolve(pending.stream);
      } else {
        pending.stream.end("refused");
        pending.reject(
          new Error(`The machine refused the stream: ${frame.error ?? "no reason given"}`),
        );
      }
      return;
    }
    // a frame racing the stream's close (or of a stream never opened here) has nothing to reach
    this.open.get(frame.streamId)?.onFrame(frame);
  }

  /** The socket closed: every stream ends, every opening fails. */
  closeAll(): void {
    if (this.ended) return;
    this.ended = true;
    for (const [id, p] of this.opening) {
      this.opening.delete(id);
      p.stream.end(STREAM_OFFLINE_REASON);
      p.reject(new DeviceOfflineError(this.deviceId));
    }
    for (const s of [...this.open.values()]) s.end(STREAM_OFFLINE_REASON);
    this.open.clear();
  }
}
