import type { DialInKernelFrame } from "@capybara-hq/plugin-sdk";

/**
 * The dial-in envelope as it crosses Redis between the relay (any replica) and the gateway replica
 * holding the machine's socket. The relay queues kernel frames with kernel-internal fields next to
 * them (the connection a request is fenced to, the machine a `stop` is for); the holder strips
 * them before a frame goes out ({@link wireFrameOf}). The holder stores each machine `res` with
 * the connection it arrived on (and, only for its own refusal, {@link GATEWAY_NOT_SENT}); the relay
 * strips those again before the provider sees the body ({@link readStoredResult}). The kernel never
 * reads a `body`.
 */

/** The connection a request is fenced to: the id the gateway sent in `ready` and its capacity. */
export interface DialInConnectionFence {
  connectionId: string;
  maxFrameBytes: number;
}

/** A request on the device's list: the wire frame plus the connection it may go out on. */
export interface QueuedRequest extends DialInConnectionFence {
  type: "req";
  id: string;
  deadlineMs: number;
  body: unknown;
}

/** A cancel on the list; unfenced (it must reach the machine after a reconnect too). */
export interface QueuedCancel {
  type: "cancel";
  id: string;
}

/** A stop on the list; with `machineId`, only that machine's connection gets it. */
export interface QueuedStop {
  type: "stop";
  reason: "drain" | "stop";
  machineId?: string;
}

export type QueuedFrame = QueuedRequest | QueuedCancel | QueuedStop;

/**
 * The marker of a result the gateway stored itself for a request it never sent (the request was
 * fenced to another connection, or did not fit): never a machine's field, since the strict
 * envelope parse refuses unknown keys.
 */
export const GATEWAY_NOT_SENT = "notSent" as const;

/** A result as the holder stores and publishes it. */
export interface StoredResult extends DialInConnectionFence {
  type: "res";
  id: string;
  /** The machine's body; absent only on the gateway's own refusal. */
  body?: unknown;
  /** The gateway's refusal of a request it never sent: why, for the caller's error. */
  [GATEWAY_NOT_SENT]?: string;
}

/** Why the holder did not send a queued frame. */
export type WireDecision =
  | { send: DialInKernelFrame; text: string }
  /** A request fenced to another connection: refused as not sent. */
  | { refuse: string; id: string }
  /** Nothing to send (a stop for another machine, or a malformed item): with the reason to log. */
  | { drop: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * What the holder sends for one queued item (`raw`, as popped from the list) on its connection:
 * the kernel frame without the kernel-internal fields, or why it does not send it. A request goes
 * out only on the connection it is fenced to; a cancel always; a stop only to the machine it names
 * (when it names one).
 */
export function wireFrameOf(
  raw: string,
  conn: DialInConnectionFence & { machineId: string },
): WireDecision {
  let item: unknown;
  try {
    item = JSON.parse(raw);
  } catch {
    return { drop: "a queued item is not JSON" };
  }
  if (!isRecord(item)) return { drop: "a queued item is not an object" };
  if (item.type === "req") {
    const { id, deadlineMs, body } = item;
    if (typeof id !== "string" || typeof deadlineMs !== "number" || !(deadlineMs > 0))
      return { drop: "a queued request is malformed" };
    if (item.connectionId !== conn.connectionId || item.maxFrameBytes !== conn.maxFrameBytes)
      return {
        refuse: "The machine's connection changed before the request was sent; retry it",
        id,
      };
    const send: DialInKernelFrame = { type: "req", id, deadlineMs, body };
    return { send, text: JSON.stringify(send) };
  }
  if (item.type === "cancel") {
    if (typeof item.id !== "string") return { drop: "a queued cancel is malformed" };
    const send: DialInKernelFrame = { type: "cancel", id: item.id };
    return { send, text: JSON.stringify(send) };
  }
  if (item.type === "stop") {
    if (item.reason !== "drain" && item.reason !== "stop")
      return { drop: "a queued stop is malformed" };
    // fenced to the machine it was queued for: a newer machine of the device never gets it
    if (item.machineId !== undefined && item.machineId !== conn.machineId)
      return { drop: "a stop queued for another machine of the device" };
    const send: DialInKernelFrame = { type: "stop", reason: item.reason };
    return { send, text: JSON.stringify(send) };
  }
  return { drop: "a queued item has an unknown type" };
}

/**
 * The result the holder stores for a machine's `res` (`body` given) or for its own refusal of a
 * request it never sent (`notSent` given, no body), tagged with the connection it belongs to.
 */
export function storedResult(
  res: { id: string; body?: unknown },
  conn: DialInConnectionFence,
  notSent?: string,
): StoredResult {
  return {
    type: "res",
    id: res.id,
    ...(notSent === undefined ? { body: res.body } : { [GATEWAY_NOT_SENT]: notSent }),
    connectionId: conn.connectionId,
    maxFrameBytes: conn.maxFrameBytes,
  };
}

/** A stored result as the relay reads it: the body for the provider and the kernel's tags apart. */
export interface ReadResult {
  id: string;
  body: unknown;
  /** The connection the result arrived on. */
  connection: DialInConnectionFence;
  /** The gateway's refusal (the request never reached the machine), with its reason. */
  notSent?: string;
}

/**
 * Reads a stored result (as stored, or as published on the bus): the machine's body with every
 * kernel-internal field stripped, the connection it arrived on, and the gateway's not-sent refusal.
 * Throws on anything else (no connection tag, a body missing without a refusal).
 */
export function readStoredResult(stored: unknown): ReadResult {
  const r = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
  if (!isRecord(r) || r.type !== "res" || typeof r.id !== "string")
    throw new Error("the gateway stored a malformed result");
  const { connectionId, maxFrameBytes } = r;
  if (
    typeof connectionId !== "string" ||
    connectionId === "" ||
    typeof maxFrameBytes !== "number" ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1024
  )
    throw new Error("the gateway stored a result without its connection");
  const connection = { connectionId, maxFrameBytes };
  const notSent = r[GATEWAY_NOT_SENT];
  if (typeof notSent === "string") return { id: r.id, body: undefined, connection, notSent };
  if (!("body" in r) || r.body === undefined)
    throw new Error("the gateway stored a result without a body");
  return { id: r.id, body: r.body, connection };
}
