/**
 * The device service socket protocol: how a device provider (or the machine program serving a
 * dial-in device) talks to a service it started with `DeviceProvider.ensureService`. Every
 * provider and every service speaks it, so a service runs the same on every provider.
 *
 * The provider starts the service with {@link DEVICE_SERVICE_SOCKET_ENV} naming the unix socket
 * the service listens on and {@link DEVICE_SERVICE_STATE_ENV} naming its state directory (the
 * only place it may write, where the spec's files were written before start). On a connection,
 * both sides exchange length-prefixed messages ({@link encodeServiceMessage}). The first message
 * from the provider is JSON whose `kind` is one of {@link SERVICE_CONNECTION_KINDS}:
 *
 * - `{"kind":"request"}`: the next provider message is the request body; the service answers
 *   with exactly one message and closes the connection.
 * - `{"kind":"stream"}`: both sides keep exchanging messages until either side closes.
 */

/** Names the unix socket path the service listens on. */
export const DEVICE_SERVICE_SOCKET_ENV = "CAPYBARA_SERVICE_SOCKET";
/** Names the service's state directory (its files, its only write root). */
export const DEVICE_SERVICE_STATE_ENV = "CAPYBARA_SERVICE_STATE";
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
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
      next.set(this.buf, 0);
      next.set(chunk, this.buf.byteLength);
      this.buf = next;
    }
    const out: Uint8Array[] = [];
    let at = 0;
    while (this.buf.byteLength - at >= HEADER) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + at, HEADER).getUint32(0);
      if (len > DEVICE_SERVICE_MAX_MESSAGE)
        throw new RangeError(
          `service message of ${len} bytes exceeds ${DEVICE_SERVICE_MAX_MESSAGE} bytes`,
        );
      if (this.buf.byteLength - at - HEADER < len) break;
      out.push(this.buf.slice(at + HEADER, at + HEADER + len));
      at += HEADER + len;
    }
    if (at > 0) this.buf = this.buf.slice(at);
    return out;
  }
}
