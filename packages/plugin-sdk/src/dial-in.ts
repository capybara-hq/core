/**
 * The dial-in channel: the kernel's generic way for a machine to connect to a deployment and
 * serve one device of a `device-provider@1` extension that declares `permissions.dialIn`. The
 * kernel signs the machine in, holds its socket on the gateway role, bounds every frame by the
 * negotiated size and relays the frames' opaque `body` between the machine and the device's
 * provider. It never reads a body: what a body means is the provider's protocol, named by
 * `permissions.dialIn.protocol` and by the machine's hello.
 */

import { z } from "zod";
import type { DeviceStream } from "./device-provider.js";

/**
 * A dial-in protocol: `<name>/<major>`, a lower-case name of 1 to 41 characters and a major
 * version from 1 to 9999 (for example `capybara-device/6`). A machine's hello must name exactly
 * the protocol of the provider serving its device.
 */
export const DIAL_IN_PROTOCOL_RE = /^[a-z][a-z0-9-]{0,40}\/[1-9][0-9]{0,3}$/;

/**
 * The credit, in messages, each side of a dial-in stream starts with for the other: a side sends a
 * `stream-data` only while it holds credit, and grants more with `stream-credit` as it consumes
 * messages, so one stream cannot fill the connection and starve the machine's other frames.
 */
export const DIAL_IN_STREAM_INITIAL_CREDIT = 8;

/**
 * The stream frames both sides send ({@link DialInChannel.openStream}). `data` is one whole message
 * in standard base64; the frame, like every frame, fits the connection's `maxFrameBytes`.
 */
export type DialInStreamFrame =
  | { type: "stream-data"; streamId: string; data: string }
  /** Grants the peer `messages` more `stream-data` frames on the stream. */
  | { type: "stream-credit"; streamId: string; messages: number }
  /** Either side ends the stream; no frame of it follows. */
  | { type: "stream-close"; streamId: string; reason: string };

/** A frame from the machine. The kernel checks the envelope; `body` is the provider's. */
export type DialInMachineFrame =
  | {
      /** The first frame after the socket opens. */
      type: "hello";
      /** Must equal the serving provider's `permissions.dialIn.protocol`. */
      protocol: string;
      /** Random per run of the machine's program, the same on each of its connections. */
      programRunId: string;
      program: { version: string; os: string; arch: string; bootId?: string };
      /** The largest frame, in UTF-8 bytes, the machine accepts. */
      transport: { maxFrameBytes: number };
      body: unknown;
    }
  /** The answer to the kernel's `req` with the same `id`. */
  | { type: "res"; id: string; body: unknown }
  /** An unsolicited frame, handed to {@link DialInHandler.onFrame}. */
  | { type: "event"; body: unknown }
  /** The answer to the kernel's `stream-open`: the machine opened the stream, or why not. */
  | { type: "stream-opened"; streamId: string; ok: boolean; error?: string }
  | DialInStreamFrame;

/** A frame from the kernel to the machine. */
export type DialInKernelFrame =
  /**
   * The kernel accepted the hello (the provider's `onHello` answered ok). `maxFrameBytes` is the
   * connection's effective frame capacity: the smaller of the machine's `transport.maxFrameBytes`
   * and the kernel's limit. Neither side sends a larger frame on this connection.
   */
  | { type: "ready"; connectionId: string; maxFrameBytes: number }
  /** A provider's request ({@link DialInChannel.request}); answered by a `res` with its `id`. */
  | { type: "req"; id: string; deadlineMs: number; body: unknown }
  /** The kernel no longer waits for request `id` (aborted or timed out). */
  | { type: "cancel"; id: string }
  /** The machine should finish its work and disconnect (`drain`) or stop at once (`stop`). */
  | { type: "stop"; reason: "drain" | "stop" }
  /** Opens a stream on the machine; `body` names the target in the provider's protocol. */
  | { type: "stream-open"; streamId: string; body: unknown }
  | DialInStreamFrame;

/** A machine frame that is not a valid dial-in envelope. The kernel closes the socket on it. */
export class DialInProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DialInProtocolError";
  }
}

/** Ids, `programRunId` and `bootId`: 1 to 128 letters, digits, `.`, `_`, `:` and `-`. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const id = z.string().regex(ID_RE);
const label = z.string().min(1).max(64);
// a frame without a body is malformed (JSON has no undefined, so this is a missing key)
const body = z.unknown().refine((v) => v !== undefined, "body is required");
// standard base64, padded; empty is an empty message
const base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, "data must be base64");
const reason = z.string().max(500);
const streamFrames = [
  z.strictObject({ type: z.literal("stream-data"), streamId: id, data: base64 }),
  z.strictObject({
    type: z.literal("stream-credit"),
    streamId: id,
    messages: z.number().int().min(1).max(1_000_000),
  }),
  z.strictObject({ type: z.literal("stream-close"), streamId: id, reason }),
] as const;

const machineFrame = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    protocol: z.string().regex(DIAL_IN_PROTOCOL_RE),
    programRunId: id,
    program: z.strictObject({
      version: label,
      os: label,
      arch: label,
      bootId: id.optional(),
    }),
    transport: z.strictObject({
      maxFrameBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER),
    }),
    body,
  }),
  z.strictObject({ type: z.literal("res"), id, body }),
  z.strictObject({ type: z.literal("event"), body }),
  z.strictObject({
    type: z.literal("stream-opened"),
    streamId: id,
    ok: z.boolean(),
    error: reason.optional(),
  }),
  ...streamFrames,
]);

/**
 * Strictly parses one machine frame: the text must be at most `maxBytes` UTF-8 bytes (checked
 * before `JSON.parse`), an object of a known `type` with exactly that type's keys. `body` is kept
 * as parsed, never inspected. Throws {@link DialInProtocolError}; a `maxBytes` that is not a
 * positive integer throws a `RangeError`.
 */
export function parseDialInMachineFrame(text: string, maxBytes: number): DialInMachineFrame {
  return parseFrame(machineFrame, text, maxBytes) as DialInMachineFrame;
}

function parseFrame(schema: z.ZodType, text: string, maxBytes: number): unknown {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError(`maxBytes must be a positive integer, got ${maxBytes}`);
  // a UTF-16 code unit is at least one UTF-8 byte: the length alone may already decide it
  if (text.length > maxBytes || new TextEncoder().encode(text).byteLength > maxBytes)
    throw new DialInProtocolError(`frame exceeds ${maxBytes} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DialInProtocolError("frame is not valid JSON");
  }
  const r = schema.safeParse(parsed);
  if (!r.success) {
    const issue = r.error.issues[0];
    const at = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new DialInProtocolError(`invalid dial-in frame${at}: ${issue?.message ?? "malformed"}`);
  }
  return r.data;
}

const kernelFrame = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    connectionId: id,
    maxFrameBytes: z.number().int().min(1024).max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    type: z.literal("req"),
    id,
    deadlineMs: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    body,
  }),
  z.strictObject({ type: z.literal("cancel"), id }),
  z.strictObject({ type: z.literal("stop"), reason: z.enum(["drain", "stop"]) }),
  z.strictObject({ type: z.literal("stream-open"), streamId: id, body }),
  ...streamFrames,
]);

/**
 * The machine's side of {@link parseDialInMachineFrame}: strictly parses one kernel frame, at most
 * `maxBytes` UTF-8 bytes (checked before `JSON.parse`), an object of a known `type` with exactly
 * that type's keys; `body` is kept as parsed. Throws {@link DialInProtocolError}; a `maxBytes`
 * that is not a positive integer throws a `RangeError`.
 */
export function parseDialInKernelFrame(text: string, maxBytes: number): DialInKernelFrame {
  return parseFrame(kernelFrame, text, maxBytes) as DialInKernelFrame;
}

/**
 * The provider's side of the dial-in channel: `DeviceProvider.dialIn`, required when the extension
 * declares `permissions.dialIn = { protocol: "<name>/<major>" }`.
 */
export interface DialInHandler {
  /**
   * Called on the gateway replica holding the socket, after the kernel authenticated it.
   * `connection` names the machine and the connection the hello arrived on.
   */
  onHello(
    deviceId: string,
    hello: unknown,
    signal: AbortSignal,
    connection: DialInConnectionInfo,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Unsolicited frames from the machine (not responses to requests), with their connection. */
  onFrame?(deviceId: string, frame: unknown, connection: DialInConnectionInfo): Promise<void>;
  /**
   * The connection whose hello this provider accepted closed. `connection` is that connection's,
   * so a `replaced` close names the old machine, never the one that replaced it.
   */
  onClose?(
    deviceId: string,
    reason: "offline" | "replaced" | "revoked" | "deleted",
    connection: DialInConnectionInfo,
  ): void;
}

/** Which machine and which of its connections a {@link DialInHandler} call is about. */
export interface DialInConnectionInfo {
  /**
   * The kernel's id of the signed-in machine (its credential): a machine signing in again to the
   * same device, or another machine replacing it, gets another id.
   */
  machineId: string;
  /** The connection id, the same the kernel sends to the machine in `ready`. */
  connectionId: string;
}

/**
 * `ctx.dialIn` (requires `permissions.dialIn`): talks to the machines serving this extension's
 * devices. Each call checks that the device is served by the calling extension.
 */
export interface DialInChannel {
  /**
   * Sends `frame` as the body of a `req` and resolves the body of the machine's `res`. Throws
   * {@link DeviceOfflineError} when no machine holds the device within the reconnect grace.
   */
  request(
    deviceId: string,
    frame: unknown,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<unknown>;
  online(deviceId: string): Promise<boolean>;
  /**
   * The negotiated frame capacity of the machine's current connection: the `maxFrameBytes` the
   * kernel sent in that connection's `ready` (the smaller of the machine's announced
   * `transport.maxFrameBytes` and the deployment's limit). A provider sizes its request bodies
   * and the answers it asks for by it: a `req` frame larger than this is refused. Null when no
   * machine holds the device now. Read from shared state at every call, so a reconnect with
   * another capacity shows at once; it can change between this call and a later request.
   */
  capacity(deviceId: string): Promise<{ maxFrameBytes: number } | null>;
  stop(deviceId: string, reason: "drain" | "stop"): Promise<void>;
  /**
   * Opens a stream to the machine serving the device: sends `stream-open` with `body` (the
   * target, in the provider's protocol) and resolves once the machine answers `stream-opened` ok.
   * Stream frames go straight over the machine's socket, never through shared state, so this
   * works only on the gateway replica holding that socket: elsewhere it throws
   * {@link DialInStreamElsewhereError}. Throws {@link DeviceOfflineError} when no machine holds the
   * device. Each message must fit the connection's frame capacity once base64-encoded in a
   * `stream-data` frame. `signal` bounds the opening only.
   */
  openStream(deviceId: string, body: unknown, opts: { signal: AbortSignal }): Promise<DeviceStream>;
}

/**
 * {@link DialInChannel.openStream} was called on a replica that does not hold the machine's
 * socket: the caller must reach the holding gateway replica instead.
 */
export class DialInStreamElsewhereError extends Error {
  readonly code = "device.stream_elsewhere";

  constructor(deviceId: string, opts?: { cause?: unknown }) {
    super(
      `Device ${deviceId}'s machine is connected to another gateway replica; open the stream there.`,
      opts && "cause" in opts ? { cause: opts.cause } : undefined,
    );
    this.name = "DialInStreamElsewhereError";
  }
}

/**
 * `ctx.devices` (requires `provides: ["device-provider@1"]`): what a device provider tells the
 * kernel about its devices.
 */
export interface DevicesCtx {
  /**
   * The device's report (`DeviceProvider.report`) or its permission support may have changed: the
   * kernel reads the report (and the permission support of the device's instance, if any) again
   * and stores them. When the revision changed, it invalidates what was approved against the old
   * one; when only display text changed under the same revision, the new text is stored and no
   * approval is invalidated.
   */
  reportChanged(deviceId: string): Promise<void>;
}

/** No machine serves the device (it is not connected, and did not reconnect within the grace). */
export class DeviceOfflineError extends Error {
  readonly code = "device.offline";

  constructor(deviceId: string, opts?: { cause?: unknown }) {
    super(
      `Device ${deviceId} is offline: no machine is connected for it. Reconnect the machine and retry.`,
      opts && "cause" in opts ? { cause: opts.cause } : undefined,
    );
    this.name = "DeviceOfflineError";
  }
}

/** Recognizes {@link DeviceOfflineError} by name and code, so another SDK copy's error matches. */
export function isDeviceOfflineError(e: unknown): e is DeviceOfflineError {
  return (
    e instanceof Error &&
    e.name === "DeviceOfflineError" &&
    (e as { code?: unknown }).code === "device.offline"
  );
}
