import type { Socket } from "node:net";
import {
  DIAL_IN_STREAM_INITIAL_CREDIT,
  type DialInKernelFrame,
  type DialInMachineFrame,
  encodeServiceMessage,
  ServiceMessageDecoder,
} from "@capybara-hq/plugin-sdk";

/** The stream frames the kernel sends ({@link DialInStreamBridge.onFrame}). */
export type KernelStreamFrame = Extract<
  DialInKernelFrame,
  { type: "stream-open" | "stream-data" | "stream-credit" | "stream-close" }
>;

/** Whether a kernel frame belongs to a stream. */
export function isKernelStreamFrame(frame: DialInKernelFrame): frame is KernelStreamFrame {
  return (
    frame.type === "stream-open" ||
    frame.type === "stream-data" ||
    frame.type === "stream-credit" ||
    frame.type === "stream-close"
  );
}

/** What the bridge needs from its dial-in socket. */
export interface StreamBridgeTransport {
  /** Sends one frame's text; false when the socket is no longer open. */
  send(text: string): boolean;
  /** The connection's negotiated frame capacity in UTF-8 bytes. */
  maxFrameBytes(): number;
}

/** Opens the service connection a `stream-open` body names (`ServiceSupervisor.openStream`). */
export type StreamOpener = (body: unknown, signal: AbortSignal) => Promise<Socket>;

/** Reasons travel at most this many characters (the envelope's limit). */
const MAX_REASON = 500;
const clip = (text: string) => (text.length > MAX_REASON ? text.slice(0, MAX_REASON) : text);

interface Stream {
  conn: Socket | undefined;
  /** Messages this side may still send the kernel (granted by the kernel). */
  sendCredit: number;
  /** Messages the kernel may still send (granted by this side as it consumes them). */
  recvCredit: number;
  /** Frame texts from the service waiting for credit, oldest first. */
  queue: string[];
  ended: boolean;
  /** The opening's abort, while the service connection is being opened. */
  opening: AbortController | undefined;
}

const frame = (f: DialInMachineFrame) => JSON.stringify(f);

/**
 * The machine's end of the dial-in streams of one socket (browser use spec §6.1): a `stream-open`
 * whose body is `{ service }` opens a `stream` connection to that running service and is answered
 * `stream-opened`; then each `stream-data` is one whole service message both ways (base64 in the
 * frame, length-prefixed on the socket). Credit follows the kernel's rules: both sides start with
 * {@link DIAL_IN_STREAM_INITIAL_CREDIT}, implicit; this side grants one per message it wrote to
 * the service and sends only while it holds credit (the service's socket is paused meanwhile), and
 * a kernel exceeding its credit gets the stream closed ("credit exceeded"). A service message that
 * does not fit one frame closes the stream (never split). The service's exit or its connection's
 * end closes the stream; the socket's close ends every service connection.
 */
export class DialInStreamBridge {
  private readonly streams = new Map<string, Stream>();
  private closed = false;

  constructor(
    private readonly transport: StreamBridgeTransport,
    private readonly opener: StreamOpener,
  ) {}

  onFrame(f: KernelStreamFrame): void {
    if (this.closed) return;
    if (f.type === "stream-open") {
      this.open(f.streamId, f.body);
      return;
    }
    // a frame racing the stream's close, or of a stream never opened here, reaches nothing
    const s = this.streams.get(f.streamId);
    if (!s || s.ended) return;
    if (f.type === "stream-close") {
      this.end(f.streamId, s, undefined);
    } else if (f.type === "stream-credit") {
      s.sendCredit += f.messages;
      this.flush(s);
    } else if (!s.conn) {
      // the kernel sends data only after `stream-opened`: anything else breaks the protocol
      this.end(f.streamId, s, "data before open");
    } else {
      if (s.recvCredit <= 0) {
        this.end(f.streamId, s, "credit exceeded");
        return;
      }
      s.recvCredit--;
      let message: Uint8Array;
      try {
        message = encodeServiceMessage(new Uint8Array(Buffer.from(f.data, "base64")));
      } catch (error) {
        this.end(f.streamId, s, (error as Error).message);
        return;
      }
      s.conn.write(message, (error) => {
        // written to the service: the kernel may send one more
        if (error || s.ended) return;
        s.recvCredit++;
        this.transport.send(frame({ type: "stream-credit", streamId: f.streamId, messages: 1 }));
      });
    }
  }

  /** The dial-in socket closed: every service connection ends, nothing more is sent. */
  closeAll(_reason: string): void {
    this.closed = true;
    for (const s of this.streams.values()) {
      s.ended = true;
      s.opening?.abort(new Error("The dial-in connection closed"));
      s.conn?.destroy();
    }
    this.streams.clear();
  }

  private open(streamId: string, body: unknown): void {
    if (this.streams.has(streamId)) {
      this.transport.send(
        frame({ type: "stream-opened", streamId, ok: false, error: "Duplicate stream id" }),
      );
      return;
    }
    const s: Stream = {
      conn: undefined,
      sendCredit: DIAL_IN_STREAM_INITIAL_CREDIT,
      recvCredit: DIAL_IN_STREAM_INITIAL_CREDIT,
      queue: [],
      ended: false,
      opening: new AbortController(),
    };
    this.streams.set(streamId, s);
    this.opener(body, (s.opening as AbortController).signal).then(
      (conn) => {
        s.opening = undefined;
        // the kernel gave up on the open (its close, or the socket's) meanwhile
        if (s.ended) {
          conn.destroy();
          return;
        }
        s.conn = conn;
        this.attach(streamId, s, conn);
        this.transport.send(frame({ type: "stream-opened", streamId, ok: true }));
      },
      (error: unknown) => {
        s.opening = undefined;
        if (s.ended) return;
        s.ended = true;
        this.streams.delete(streamId);
        this.transport.send(
          frame({
            type: "stream-opened",
            streamId,
            ok: false,
            error: clip(error instanceof Error ? error.message : String(error)),
          }),
        );
      },
    );
  }

  private attach(streamId: string, s: Stream, conn: Socket): void {
    const decoder = new ServiceMessageDecoder();
    conn.on("data", (chunk: Buffer) => {
      if (s.ended) return;
      let messages: Uint8Array[];
      try {
        messages = decoder.push(chunk);
      } catch (error) {
        this.end(streamId, s, `The service sent an oversized message: ${(error as Error).message}`);
        return;
      }
      const cap = this.transport.maxFrameBytes();
      for (const m of messages) {
        const text = frame({
          type: "stream-data",
          streamId,
          data: Buffer.from(m.buffer, m.byteOffset, m.byteLength).toString("base64"),
        });
        if (Buffer.byteLength(text) > cap) {
          this.end(
            streamId,
            s,
            `A service message of ${m.byteLength} bytes does not fit the connection's frame capacity of ${cap} bytes once base64-encoded; the service must send smaller messages`,
          );
          return;
        }
        s.queue.push(text);
      }
      this.flush(s);
    });
    conn.on("error", () => {});
    conn.on("close", () => this.end(streamId, s, "service closed"));
  }

  private flush(s: Stream): void {
    while (s.sendCredit > 0 && s.queue.length > 0 && !s.ended) {
      const text = s.queue.shift() as string;
      if (!this.transport.send(text)) return;
      s.sendCredit--;
    }
    // backpressure: stop reading the service while the kernel has granted nothing more
    if (s.queue.length > 0) s.conn?.pause();
    else s.conn?.resume();
  }

  /**
   * Ends a stream: with a `reason` the kernel is told (`stream-close`), without one the kernel
   * closed it itself. The service connection ends either way.
   */
  private end(streamId: string, s: Stream, reason: string | undefined): void {
    if (s.ended) return;
    s.ended = true;
    this.streams.delete(streamId);
    s.queue = [];
    s.opening?.abort(new Error("The stream was closed while it opened"));
    s.conn?.destroy();
    if (reason !== undefined)
      this.transport.send(frame({ type: "stream-close", streamId, reason: clip(reason) }));
  }
}
