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
 */

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
 * sealed under the service's current files (unsealed, or a plugin upgrade since), so a service
 * installs afresh while unsealed and never trusts what it finds there. The process that seals
 * keeps its write access until it exits, so a service runs no untrusted input (no web page) while
 * unsealed, seals only a complete install and then exits; the next start, reviewed again, runs it
 * read only.
 */
export const DEVICE_SERVICE_INSTALL_ENV = "CAPYBARA_SERVICE_INSTALL";
/** The file that seals a service's install directory ({@link DEVICE_SERVICE_INSTALL_ENV}). */
export const DEVICE_SERVICE_INSTALL_SEAL = ".sealed";
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
