/**
 * The device service socket protocol: how a device provider (or the machine program serving a
 * dial-in device) talks to a service it started with `DeviceProvider.ensureService`. Every
 * provider and every service speaks it, so a service runs the same on every provider.
 *
 * The provider starts the service with {@link DEVICE_SERVICE_SOCKET_ENV} naming the unix socket
 * the service listens on and {@link DEVICE_SERVICE_STATE_ENV} naming its state directory (the
 * only place it may write besides the workspace downloads). The spec's files are written before
 * start into the service's code directory: a directory the service can only read where the
 * provider can separate code from state, else the state directory. On a connection,
 * both sides exchange length-prefixed messages ({@link encodeServiceMessage}). The first message
 * from the provider is JSON whose `kind` is one of {@link SERVICE_CONNECTION_KINDS}:
 *
 * - `{"kind":"request"}`: the next provider message is the request body; the service answers
 *   with exactly one message and closes the connection.
 * - `{"kind":"stream"}`: both sides keep exchanging messages until either side closes.
 *
 * **Viewer streams.** On a stream the kernel opens for a viewer (a person's panel, through a
 * viewer ticket), the first stream message after `{"kind":"stream"}` is written by the kernel, not
 * the panel: the viewer context {@link DeviceServiceViewerContext},
 * `{"kind":"viewer","conversationId":"<id>","rootConversationId":"<id>"}`, naming the ticket's
 * conversation (checked at mint to be owned by the viewing person) and the root of its
 * conversation tree (the conversation itself outside sub-agents). The panel's own messages
 * follow, unchanged and in order. A service reads only that first message as context
 * ({@link parseViewerContext}); a later message of the same shape comes from the panel and is
 * never context. Providers and the device program pass the viewer context through like any
 * stream message.
 *
 * **Kernel requests.** Besides the extension's own requests (`ctx.deviceAccess.request`), the
 * kernel sends two request bodies of its own: the roll check ({@link DEVICE_SERVICE_ROLL_CHECK})
 * and the conversation-deleted notice ({@link encodeConversationDeleted}).
 */

import { LOOPBACK_MAX_PORTS_PER_SERVICE } from "./device-provider.js";

/**
 * The network a device service runs under (`service.ensure`): the device's network setting plus
 * the service's live loopback port grants, which let it reach the loopback grant hosts
 * (`LOOPBACK_GRANT_HOSTS`) on exactly those ports. The set is always sent whole, so an absent or
 * empty one closes every loopback port again.
 */
export interface DeviceServiceNetwork {
  kind: "open-public" | "allowlist";
  hosts: string[];
  /**
   * Live granted loopback ports, sorted ascending, unique, 1–65535, at most
   * {@link LOOPBACK_MAX_PORTS_PER_SERVICE}.
   */
  loopbackPorts?: number[];
}

/**
 * Strictly parses a set of loopback ports ({@link DeviceServiceNetwork.loopbackPorts}): an array
 * of unique integers 1–65535, at most {@link LOOPBACK_MAX_PORTS_PER_SERVICE}; returns a sorted
 * copy. Throws a `TypeError` naming `what` otherwise.
 */
export function parseLoopbackPorts(value: unknown, what: string): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array of ports`);
  if (value.length > LOOPBACK_MAX_PORTS_PER_SERVICE)
    throw new TypeError(`${what} lists at most ${LOOPBACK_MAX_PORTS_PER_SERVICE} ports`);
  const seen = new Set<number>();
  for (const p of value) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65535)
      throw new TypeError(`${what} must list integer ports from 1 to 65535`);
    if (seen.has(p)) throw new TypeError(`${what} lists port ${p} twice`);
    seen.add(p);
  }
  return [...seen].sort((a, b) => a - b);
}

/**
 * The request body the kernel sends a running service before restarting it on new files (an
 * upgraded extension, {@link DeviceServiceRollCheck}). A service that answers
 * `{"busy":true,"reason":"…"}` is kept running (a person is using it); the kernel asks again at a
 * later ensure. Any other answer, an error or no answer within a few seconds lets the restart go
 * ahead, so a service that does not know the check is restarted as before. Every service gets
 * this body on its request connection, so a service must ignore a request body it does not know
 * (answer an error, act on nothing), never treat an arbitrary body as a command.
 */
export const DEVICE_SERVICE_ROLL_CHECK = '{"capybara":"roll-check"}';

/** A service's answer to {@link DEVICE_SERVICE_ROLL_CHECK}. */
export interface DeviceServiceRollCheck {
  /** True while restarting now would lose something a person is doing (a takeover, a handoff). */
  busy: boolean;
  /** What keeps it busy, for the kernel's log. */
  reason?: string;
}

/** Whether `body` is the kernel's {@link DEVICE_SERVICE_ROLL_CHECK} request. */
export function isRollCheck(body: Uint8Array | string): boolean {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    const v = JSON.parse(text) as unknown;
    return (
      typeof v === "object" && v !== null && (v as { capybara?: unknown }).capybara === "roll-check"
    );
  } catch {
    return false;
  }
}

/** Reads a service's answer to the roll check: busy only for `{"busy":true}` (never throws). */
export function parseRollCheck(body: Uint8Array | string): DeviceServiceRollCheck {
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  try {
    const v = JSON.parse(text) as { busy?: unknown; reason?: unknown } | null;
    if (typeof v === "object" && v !== null && v.busy === true)
      return {
        busy: true,
        ...(typeof v.reason === "string" && { reason: v.reason.slice(0, 200) }),
      };
  } catch {
    // not JSON: not busy
  }
  return { busy: false };
}

/**
 * How long a service may restore state it saved (after a restart, or when its device resumes):
 * state saved longer ago than this is not restored. The kernel keeps a
 * {@link encodeConversationDeleted} notice owed for at least this long after the deletion while
 * the service is not running, so a service that restores within it still learns of the deletion.
 */
export const DEVICE_SERVICE_RESTORE_MAX_AGE_MS = 10 * 60_000;

/**
 * The kernel's notice that a conversation was deleted: a request body the kernel sends every
 * running service of an extension on the deleted conversation's device, at least once, soon after
 * the deletion (a device that is offline gets it when it is back; a service that is stopped gets
 * it when it runs again within {@link DEVICE_SERVICE_RESTORE_MAX_AGE_MS}). The kernel builds it
 * from the deleted conversation's id. It arrives on a **request** connection only: a stream
 * message of this shape is a viewer's (panel) input and never the notice, so a service parses it
 * only on request connections. As with the roll check, the extension's own requests
 * (`ctx.deviceAccess.request`) reach the same connection kind: a body of this shape sent by the
 * extension is the extension's to answer for. The service forgets what it keeps for that
 * conversation and for the conversations whose tree root it is (closes their pages, drops their
 * state; never shared data such as a browser profile) and answers with any message: the kernel
 * reads no more than that it answered. Handling it twice must be harmless. A service that does
 * not know it ignores it, as any unknown body.
 */
export interface DeviceServiceConversationDeleted {
  capybara: "conversation-deleted";
  conversationId: string;
}

/** The body of the kernel's conversation-deleted notice (UTF-8 JSON; the provider frames it). */
export function encodeConversationDeleted(conversationId: string): Uint8Array {
  if (typeof conversationId !== "string" || conversationId === "")
    throw new TypeError("encodeConversationDeleted needs a conversation id");
  return new TextEncoder().encode(
    JSON.stringify({ capybara: "conversation-deleted", conversationId }),
  );
}

/**
 * Reads a request body as the kernel's conversation-deleted notice: `capybara` is
 * `"conversation-deleted"` and `conversationId` a non-empty string. Null for anything else (not
 * UTF-8, not JSON, another shape, the roll check); never throws.
 */
export function parseConversationDeleted(
  body: Uint8Array | string,
): DeviceServiceConversationDeleted | null {
  let msg: unknown;
  try {
    const text =
      typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const { capybara, conversationId } = msg as Record<string, unknown>;
  if (capybara !== "conversation-deleted") return null;
  if (typeof conversationId !== "string" || conversationId === "") return null;
  return { capybara: "conversation-deleted", conversationId };
}

/** Names the unix socket path the service listens on. */
export const DEVICE_SERVICE_SOCKET_ENV = "CAPYBARA_SERVICE_SOCKET";
/** Names the service's state directory (its own data, its write root; not where its code is). */
export const DEVICE_SERVICE_STATE_ENV = "CAPYBARA_SERVICE_STATE";
/**
 * Names the device's workspace root. Every provider sets it for every service (a spec cannot set
 * it); a service confines the files it takes in (uploads) and lets out (downloads) to it.
 */
export const DEVICE_SERVICE_WORKSPACE_ENV = "CAPYBARA_SERVICE_WORKSPACE";
/**
 * Names the service's install directory, where the provider gives it one (device-local does;
 * absent elsewhere): a place for what the service fetches once and then only runs, such as a
 * browser, apart from its state. The service may write it until it creates the regular file
 * {@link DEVICE_SERVICE_INSTALL_SEAL} in it; from its next start on the directory is read only
 * for the service, so nothing the service later runs (a compromised browser included) can
 * replace what was installed. The provider empties it at every start that does not find it
 * sealed under the service's current files (unsealed, or a plugin upgrade since; under its
 * {@link DEVICE_SERVICE_INSTALL_KEY_FILE} where the service ships one), so a service
 * installs afresh while unsealed and never trusts what it finds there. The process that seals
 * keeps its write access until it exits, so a service runs no untrusted input (no web page) while
 * unsealed, seals only a complete install and then exits; the next start, reviewed again, runs it
 * read only.
 */
export const DEVICE_SERVICE_INSTALL_ENV = "CAPYBARA_SERVICE_INSTALL";
/** The file that seals a service's install directory ({@link DEVICE_SERVICE_INSTALL_ENV}). */
export const DEVICE_SERVICE_INSTALL_SEAL = ".sealed";
/**
 * A service file naming what its install directory holds ({@link DEVICE_SERVICE_INSTALL_ENV}): one
 * line matching {@link DEVICE_SERVICE_INSTALL_KEY_RE}, such as the browser revision. capybara-device
 * (the device-local provider's machine program, capybara-hq/plugins#311) keeps such installs in a
 * machine-wide cache of the OS user and keys them by it instead of by the service's files, so a
 * plugin upgrade that keeps the key reuses the sealed install, and so do the other devices of the
 * same deployment (its URL's origin and path) on that machine. Services of other deployments,
 * platforms or launch environments never see it. The provider still hands an unsealed install out
 * empty and private to one start, publishes it only once the service exits sealed (every link
 * inside it, no hard link, no special file) and verifies it before every reuse. It assumes the
 * unsealed install is the service's own code running no untrusted input, as the seal does: a
 * child that left its process group could still write through an open file after the digest
 * (the next reuse's verification catches it). Absent (or malformed): the install is keyed by the
 * files.
 */
export const DEVICE_SERVICE_INSTALL_KEY_FILE = "capybara-install-key";
/** What {@link DEVICE_SERVICE_INSTALL_KEY_FILE} holds: lower case, so it is one name on every file system. */
export const DEVICE_SERVICE_INSTALL_KEY_RE = /^[a-z0-9][a-z0-9._+-]{0,127}$/;
/**
 * Names the Mach service allowances the provider's sandbox gives the service (macOS: device-local
 * sets it, a spec cannot). Its value {@link DEVICE_SERVICE_MACH_CHROMIUM} means the full Chromium
 * build can start there (its `MachPortRendezvousServer` check-in is allowed); absent, a service
 * must not count on it (an older capybara-device refuses it).
 */
export const DEVICE_SERVICE_MACH_ENV = "CAPYBARA_SERVICE_MACH";
/** {@link DEVICE_SERVICE_MACH_ENV}'s value for the full Chromium build's Mach services. */
export const DEVICE_SERVICE_MACH_CHROMIUM = "chromium";
/** The largest message body, in bytes, either side may send on a service connection. */
export const DEVICE_SERVICE_MAX_MESSAGE = 8 * 1024 * 1024;
/** The kinds a connection's first message may name. */
export const SERVICE_CONNECTION_KINDS = ["request", "stream"] as const;

/** A service connection kind ({@link SERVICE_CONNECTION_KINDS}). */
export type ServiceConnectionKind = (typeof SERVICE_CONNECTION_KINDS)[number];

const HEADER = 4;

/**
 * Frames one message: a 4-byte big-endian length followed by `body`. Throws a `RangeError` for a
 * body above {@link DEVICE_SERVICE_MAX_MESSAGE}.
 */
export function encodeServiceMessage(body: Uint8Array): Uint8Array {
  if (body.byteLength > DEVICE_SERVICE_MAX_MESSAGE)
    throw new RangeError(
      `service message of ${body.byteLength} bytes exceeds ${DEVICE_SERVICE_MAX_MESSAGE} bytes`,
    );
  const out = new Uint8Array(HEADER + body.byteLength);
  new DataView(out.buffer).setUint32(0, body.byteLength);
  out.set(body, HEADER);
  return out;
}

/**
 * Splits a byte stream into the messages {@link encodeServiceMessage} framed, whatever the chunk
 * boundaries. `push` returns the messages completed by `chunk` (copies, safe to keep). A declared
 * length above {@link DEVICE_SERVICE_MAX_MESSAGE} throws a `RangeError` as soon as the header is
 * read; the connection should then be closed (the decoder is not usable afterwards).
 */
export class ServiceMessageDecoder {
  // unread bytes, oldest first from index `first`; `pending` is their total length
  private chunks: Uint8Array[] = [];
  private first = 0;
  private pending = 0;
  // the declared length of the message being read, once its header is complete
  private need: number | null = null;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.chunks.push(chunk.slice());
      this.pending += chunk.byteLength;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.need === null) {
        if (this.pending < HEADER) break;
        const header = this.take(HEADER);
        const len = new DataView(header.buffer, header.byteOffset, HEADER).getUint32(0);
        if (len > DEVICE_SERVICE_MAX_MESSAGE)
          throw new RangeError(
            `service message of ${len} bytes exceeds ${DEVICE_SERVICE_MAX_MESSAGE} bytes`,
          );
        this.need = len;
      }
      if (this.pending < this.need) break;
      out.push(this.take(this.need));
      this.need = null;
    }
    return out;
  }

  /** Removes the first `n` (at most `pending`) bytes into one new array, copying each byte once. */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      // never undefined: callers take at most `pending` bytes
      const head = this.chunks[this.first];
      if (head === undefined) break;
      const k = Math.min(head.byteLength, n - at);
      out.set(head.subarray(0, k), at);
      at += k;
      if (k === head.byteLength) this.first++;
      else this.chunks[this.first] = head.subarray(k);
    }
    // drop consumed chunks in one go (no per-chunk shift)
    if (this.first > 64 || this.first === this.chunks.length) {
      this.chunks = this.chunks.slice(this.first);
      this.first = 0;
    }
    this.pending -= n;
    return out;
  }
}

/**
 * The first stream message of a viewer stream, written by the kernel (see the protocol above):
 * the ticket's conversation and the root of its conversation tree.
 */
export interface DeviceServiceViewerContext {
  kind: "viewer";
  conversationId: string;
  rootConversationId: string;
}

/** The body of the viewer context stream message (UTF-8 JSON; the provider frames it). */
export function encodeViewerContext(ctx: DeviceServiceViewerContext): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      kind: "viewer",
      conversationId: ctx.conversationId,
      rootConversationId: ctx.rootConversationId,
    }),
  );
}

/**
 * Reads a stream message body as the viewer context: `kind` is `"viewer"` and both ids are
 * non-empty strings; only those three fields are returned. Null for anything else (not UTF-8,
 * not JSON, another shape).
 */
export function parseViewerContext(body: Uint8Array | string): DeviceServiceViewerContext | null {
  let msg: unknown;
  try {
    const text =
      typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body);
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const { kind, conversationId, rootConversationId } = msg as Record<string, unknown>;
  if (kind !== "viewer") return null;
  if (typeof conversationId !== "string" || conversationId === "") return null;
  if (typeof rootConversationId !== "string" || rootConversationId === "") return null;
  return { kind: "viewer", conversationId, rootConversationId };
}
