import { createHmac, timingSafeEqual } from "node:crypto";
import {
  DeviceAccessError,
  type DeviceStream,
  isDeviceOfflineError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import WebSocket, { type RawData } from "ws";
import type { Keyring } from "../ctx/secrets.js";
import { DialInGateway } from "../dial-in/gateway.js";
import { DialInHandlers } from "../dial-in/handlers.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER, KEYRING } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { SandboxService, type StreamHold } from "../sandbox/sandbox.service.js";
import { DeviceAccessService, type DeviceStreamTicket } from "./device-access.service.js";

/**
 * The close codes of a viewer socket (browser use spec §6.2). The panel reconnects with a new
 * ticket after 1001 and 1012; 4401, 4404 and 4409 tell it why the view ended.
 */
export const VIEWER_CLOSE = {
  normal: 1000,
  /** The replica is shutting down: reconnect with a new ticket (another replica serves it). */
  shutdown: 1001,
  /** The kernel failed (the database, a hop that could not connect). */
  internal: 1011,
  /**
   * The device yielded the viewer to a lifecycle change that keeps its instance (a limits change,
   * a rebuild in place): reconnect with a new ticket.
   */
  restart: 1012,
  /** No ticket, an unknown or used one, or its record no longer stands (owner, device, extension). */
  badTicket: 4401,
  /** The device, its running instance or the service is gone, or the provider cannot stream. */
  gone: 4404,
  /** The device's machine is not connected (`device-offline`). */
  offline: 4409,
} as const;

/** The header carrying the hop's MAC (hex HMAC-SHA256). */
export const HOP_HEADER = "x-capybara-hop";
/** The header carrying the hop's issue time (ms since the epoch), covered by the MAC. */
export const HOP_AT_HEADER = "x-capybara-hop-at";
/** How old (or how far ahead, clock skew) a hop's issue time may be. */
export const HOP_MAX_AGE_MS = 60_000;
/** The keyring purpose the hop key is derived for (HKDF-SHA256, info `capybara:device-stream-hop`). */
const HOP_KEY_INFO = "device-stream-hop";
/** A hop accepted once per ticket: `capk:device-stream-hop:<ticketId>` (a captured hop replays nothing). */
const HOP_SEEN_PREFIX = "capk:device-stream-hop:";
/** How long the holder waits for the hop's first message (the ticket record). */
export const HOP_FIRST_MESSAGE_MS = 10_000;
/** How long a hop has to connect to the holder. */
const HOP_CONNECT_MS = 10_000;
/** A ticket id as minted (`randomBytes(24)` in base64url) or any similar opaque id. */
export const TICKET_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
/**
 * Outgoing backpressure: while a socket has more than this many bytes queued, the next message
 * waits until its write is flushed (the pipe stops pulling from its source).
 */
const SEND_HIGH_WATER_BYTES = 1024 * 1024;
/**
 * Incoming backpressure: a socket with this many received messages not yet forwarded is paused
 * (`ws.pause()`, no more reads) until the queue is half empty.
 */
const RECEIVE_HIGH_WATER = 64;

/** A WebSocket close reason is at most 123 UTF-8 bytes. */
const closeReason = (text: string): string => {
  let out = text;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
};

const toBytes = (data: RawData): Uint8Array =>
  Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : (data as Buffer);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One end of a pipe as a message stream: `send` resolves when the peer can take more
 * (backpressure), `messages` ends when the end closes.
 */
interface PipeEnd {
  send(m: Uint8Array): Promise<void>;
  readonly messages: AsyncIterable<Uint8Array>;
}

/**
 * A WebSocket (the browser's, a hop in either direction) as a {@link PipeEnd}. Received messages
 * are queued from the moment it is wrapped (nothing is lost while the other end opens); a full
 * queue pauses the socket's reads. A send waits for its flush while the socket's buffer is over
 * {@link SEND_HIGH_WATER_BYTES}, and is dropped once the socket is no longer open (the pipe is
 * ending).
 */
class WsEnd implements PipeEnd {
  private readonly queue: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private paused = false;
  private ended = false;
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly messages: AsyncIterable<Uint8Array>;

  constructor(readonly ws: WebSocket) {
    ws.on("message", (data: RawData) => {
      this.queue.push(toBytes(data));
      if (!this.paused && this.queue.length >= RECEIVE_HIGH_WATER) {
        this.paused = true;
        ws.pause();
      }
      this.notify();
    });
    // an error is followed by close; without a listener it would be thrown
    ws.on("error", () => {});
    this.closed = new Promise((resolve) => {
      ws.once("close", (code: number, reason: Buffer) => {
        this.ended = true;
        this.notify();
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
    this.messages = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.next(),
      }),
    };
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  /** The next received message; done once the socket closed and the queue is empty. */
  async next(): Promise<IteratorResult<Uint8Array>> {
    for (;;) {
      const m = this.queue.shift();
      if (m !== undefined) {
        if (this.paused && this.queue.length <= RECEIVE_HIGH_WATER / 2) {
          this.paused = false;
          this.ws.resume();
        }
        return { value: m, done: false };
      }
      if (this.ended) return { value: undefined, done: true };
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  send(m: Uint8Array): Promise<void> {
    if (!this.isOpen) return Promise.resolve();
    if (this.ws.bufferedAmount < SEND_HIGH_WATER_BYTES) {
      this.ws.send(m, { binary: true });
      return Promise.resolve();
    }
    return new Promise((resolve) => this.ws.send(m, { binary: true }, () => resolve()));
  }

  /** Closes the socket (a socket still connecting is dropped); a no-op once closing. */
  close(code: number, reason: string): void {
    const s = this.ws.readyState;
    if (s === WebSocket.CONNECTING) this.ws.terminate();
    else if (s === WebSocket.OPEN) this.ws.close(code, closeReason(reason));
  }
}

/** Forwards every message of `from` to `to`, in order, awaiting each send (backpressure). */
async function pump(from: AsyncIterable<Uint8Array>, to: PipeEnd): Promise<void> {
  try {
    for await (const m of from) await to.send(m);
  } catch {
    // a send on a closing stream: the pipe ends with the close that caused it
  }
}

/** Resolves once `s` aborts. */
const abortedOf = (s: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (s.aborted) resolve();
    else s.addEventListener("abort", () => resolve(), { once: true });
  });

/** A ticket record taken from Redis, checked field by field; null for anything else. */
export function parseTicketRecord(raw: unknown): DeviceStreamTicket | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const keys = [
    "orgId",
    "accountId",
    "conversationId",
    "deviceId",
    "providerName",
    "service",
    "extension",
  ] as const;
  for (const k of keys) if (typeof r[k] !== "string" || r[k] === "") return null;
  return {
    orgId: r.orgId as string,
    accountId: r.accountId as string,
    conversationId: r.conversationId as string,
    deviceId: r.deviceId as string,
    providerName: r.providerName as string,
    service: r.service as string,
    extension: r.extension as string,
  };
}

/** One open viewer on this replica: its socket, and the promise that settles once it is all done. */
interface OpenViewer {
  end: WsEnd;
  done: Promise<void>;
}

/**
 * The viewer endpoint (browser use spec §6.2, served on the gateway role by `viewer-routes.ts`):
 * `GET /device/stream?ticket=` takes the single-use viewer ticket
 * (`DeviceAccessService.takeTicket`) and pipes the device service's stream to the browser, bytes
 * unchanged both ways. Where the stream opens:
 *
 * - A device whose provider declares `permissions.dialIn` (a local device) streams only from the
 *   gateway replica holding its machine's socket. Any other replica hops once: a `ws` connection
 *   to `<holderAddress>/internal/device-stream/<ticketId>` carrying `X-Capybara-Hop` (hex
 *   HMAC-SHA256 under the key derived from the master key for `device-stream-hop`, over the
 *   ticket id and the issue time `X-Capybara-Hop-At`). The ticket is consumed here; the hop's
 *   first message is the record, MACed with the same key. The holder checks the MAC
 *   (constant time) and the issue time (at most {@link HOP_MAX_AGE_MS} away) before anything
 *   else, accepts each ticket's hop once (`capk:device-stream-hop:<ticketId>`), never takes a
 *   ticket, and opens locally.
 * - Every other device opens on the replica the viewer reached (the provider's `openStream`).
 *
 * A local open checks the record again ({@link DeviceAccessService.ticketStands}), holds the
 * device for the viewer's life ({@link SandboxService.holdForStream}: an open viewer counts as
 * device use) and audits `browser.view` / `browser.view_closed`; frames are never audited and
 * never pass through Redis or PG. Close codes: {@link VIEWER_CLOSE}. Everything settles when any
 * side closes: the browser socket, the hop, the provider stream, the hold (a lifecycle change)
 * or this replica's shutdown ({@link stop}: 1001). The sockets live in this process only (they
 * cannot live anywhere else); what other replicas need is in Redis.
 *
 * Backpressure pauses, never drops, in both directions: service to browser, the next message
 * waits while the browser socket has over 1 MiB queued (the provider stream's credit then holds
 * the service back); browser to service, each message waits for `DeviceStream.send` (the
 * service's credit), and a browser socket with 64 messages waiting is paused until half are sent.
 */
@Injectable()
export class DeviceStreamViewers {
  private readonly open = new Set<OpenViewer>();
  private stopping = false;
  /** How long the holder waits for a hop's first message (a test seam). */
  firstMessageMs = HOP_FIRST_MESSAGE_MS;

  constructor(
    @Inject(DeviceAccessService)
    private readonly access: Pick<DeviceAccessService, "takeTicket" | "ticketStands">,
    @Inject(SandboxService) private readonly sandbox: Pick<SandboxService, "holdForStream">,
    @Inject(DialInGateway)
    private readonly gateway: Pick<DialInGateway, "holdsLocally" | "holderAddress">,
    @Inject(DialInHandlers) private readonly handlers: Pick<DialInHandlers, "forDevice">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(LockService) private readonly locks: Pick<LockService, "lease">,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "debug" | "warn">,
  ) {}

  private hopKey(): Buffer {
    return this.keyring.deriveKey(HOP_KEY_INFO).current;
  }

  private mac(parts: string[]): Buffer {
    return createHmac("sha256", this.hopKey()).update(parts.join("\n")).digest();
  }

  /** The headers of a hop for `ticketId` issued at `at`. */
  hopHeaders(ticketId: string, at: number = Date.now()): Record<string, string> {
    return {
      [HOP_HEADER]: this.mac(["hop", ticketId, String(at)]).toString("hex"),
      [HOP_AT_HEADER]: String(at),
    };
  }

  /**
   * Whether a hop's headers are valid for `ticketId`: a 64-hex MAC equal (constant time) to the
   * one over the ticket id and the issue time, issued at most {@link HOP_MAX_AGE_MS} away from
   * now. Reads nothing else.
   */
  verifyHop(ticketId: string, mac: unknown, at: unknown, now: number = Date.now()): boolean {
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    if (typeof at !== "string" || !/^[0-9]{1,16}$/.test(at)) return false;
    if (Math.abs(now - Number(at)) > HOP_MAX_AGE_MS) return false;
    return timingSafeEqual(Buffer.from(mac, "hex"), this.mac(["hop", ticketId, at]));
  }

  /** Accepts the hop of `ticketId` once (a replay of a captured hop is refused). */
  async claimHop(ticketId: string): Promise<boolean> {
    // a marker that is never released: it outlives the hop's age limit, then expires
    return this.locks.lease(`${HOP_SEEN_PREFIX}${ticketId}`, "1", HOP_MAX_AGE_MS * 2);
  }

  /** Serves a browser's viewer socket for the ticket `ticketId` until everything settled. */
  serve(socket: WebSocket, ticketId: string): Promise<void> {
    return this.track(socket, (end) => this.serveViewer(end, ticketId));
  }

  /** Serves a hop from another gateway replica (its headers were verified and claimed). */
  serveHop(socket: WebSocket, ticketId: string, at: string): Promise<void> {
    return this.track(socket, (end) => this.serveHopped(end, ticketId, at));
  }

  /** Closes every open viewer (1001, the panel reconnects elsewhere) and waits for them to settle. */
  async stop(): Promise<void> {
    this.stopping = true;
    const all = [...this.open];
    for (const v of all) v.end.close(VIEWER_CLOSE.shutdown, "shutting down");
    await Promise.allSettled(all.map((v) => v.done));
  }

  /** How many viewers this replica serves (a test seam). */
  count(): number {
    return this.open.size;
  }

  private track(socket: WebSocket, fn: (end: WsEnd) => Promise<void>): Promise<void> {
    const end = new WsEnd(socket);
    if (this.stopping) {
      end.close(VIEWER_CLOSE.shutdown, "shutting down");
      return Promise.resolve();
    }
    const entry: OpenViewer = { end, done: Promise.resolve() };
    entry.done = (async () => {
      try {
        await fn(end);
      } catch (err) {
        this.log.warn("device stream viewer failed", { error: errMsg(err) });
        end.close(VIEWER_CLOSE.internal, "internal error");
      } finally {
        this.open.delete(entry);
      }
    })();
    this.open.add(entry);
    return entry.done;
  }

  private async serveViewer(end: WsEnd, ticketId: string): Promise<void> {
    if (!TICKET_ID_RE.test(ticketId)) {
      end.close(VIEWER_CLOSE.badTicket, "invalid ticket");
      return;
    }
    const record = parseTicketRecord(await this.access.takeTicket(ticketId).catch(() => null));
    if (record === null) {
      end.close(VIEWER_CLOSE.badTicket, "invalid ticket");
      return;
    }
    if (!end.isOpen) return;
    const serving = await this.handlers.forDevice(record.deviceId);
    if ("plugin" in serving && !this.gateway.holdsLocally(record.deviceId)) {
      await this.hop(end, ticketId, record);
      return;
    }
    await this.openLocal(end, record, ticketId);
  }

  private async serveHopped(end: WsEnd, ticketId: string, at: string): Promise<void> {
    // the first message is the record the first replica took with the ticket
    let timer: NodeJS.Timeout | undefined;
    const first = await Promise.race([
      end.next(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.firstMessageMs);
        timer.unref();
      }),
    ]).finally(() => clearTimeout(timer));
    const record =
      first === null || first.done ? null : this.openHopRecord(first.value, ticketId, at);
    if (record === null) {
      end.close(VIEWER_CLOSE.badTicket, "invalid hop");
      return;
    }
    await this.openLocal(end, record, null);
  }

  /** The hop's first message `{ record, mac }` as the record, when its MAC is valid. */
  private openHopRecord(m: Uint8Array, ticketId: string, at: string): DeviceStreamTicket | null {
    let msg: unknown;
    try {
      msg = JSON.parse(Buffer.from(m).toString("utf8"));
    } catch {
      return null;
    }
    const { record, mac } = (msg ?? {}) as { record?: unknown; mac?: unknown };
    if (typeof record !== "string" || typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac))
      return null;
    const want = this.mac(["record", ticketId, at, record]);
    if (!timingSafeEqual(Buffer.from(mac, "hex"), want)) return null;
    try {
      return parseTicketRecord(JSON.parse(record));
    } catch {
      return null;
    }
  }

  /**
   * Hops to the gateway replica holding the device's machine and pipes the browser to it. The
   * holder's close code reaches the browser (an unexpected one, or a hop that failed, is 1011);
   * no holder is 4409.
   */
  private async hop(end: WsEnd, ticketId: string, record: DeviceStreamTicket): Promise<void> {
    const address = await this.gateway.holderAddress(record.deviceId);
    if (address === null) {
      end.close(VIEWER_CLOSE.offline, "device-offline");
      return;
    }
    if (!end.isOpen) return;
    const at = Date.now();
    const url = `${address.replace(/^http/, "ws")}/internal/device-stream/${ticketId}`;
    const up = new WsEnd(
      new WebSocket(url, {
        headers: this.hopHeaders(ticketId, at),
        handshakeTimeout: HOP_CONNECT_MS,
      }),
    );
    const recordJson = JSON.stringify(record);
    const opened = new Promise<boolean>((resolve) => {
      up.ws.once("open", () => {
        up.ws.send(
          JSON.stringify({
            record: recordJson,
            mac: this.mac(["record", ticketId, String(at), recordJson]).toString("hex"),
          }),
        );
        resolve(true);
      });
      void up.closed.then(() => resolve(false));
    });
    const first = await Promise.race([
      opened.then((ok) => (ok ? ("open" as const) : ("up" as const))),
      end.closed.then(() => "viewer" as const),
    ]);
    if (first === "open") {
      // both directions only once the holder has the record
      void pump(end.messages, up);
      void pump(up.messages, end);
    }
    const settled = await Promise.race([
      up.closed.then((c) => ({ side: "up" as const, code: c.code, reason: c.reason })),
      end.closed.then(() => ({ side: "viewer" as const, code: 0, reason: "" })),
    ]);
    if (settled.side === "viewer") {
      up.close(VIEWER_CLOSE.normal, "viewer closed");
      await up.closed;
      return;
    }
    const forwarded: ReadonlySet<number> = new Set([
      VIEWER_CLOSE.normal,
      VIEWER_CLOSE.shutdown,
      VIEWER_CLOSE.restart,
      VIEWER_CLOSE.badTicket,
      VIEWER_CLOSE.gone,
      VIEWER_CLOSE.offline,
    ]);
    if (forwarded.has(settled.code)) end.close(settled.code, settled.reason);
    else {
      this.log.warn("device stream hop ended unexpectedly", {
        deviceId: record.deviceId,
        code: settled.code,
      });
      end.close(VIEWER_CLOSE.internal, "hop failed");
    }
  }

  /**
   * Opens the service's stream on this replica and pipes it to `end` until any side closes.
   * `ticketId` is set for a viewer that reached this replica directly (a machine that moved
   * meanwhile is hopped to); null for a hop, which never hops again.
   */
  private async openLocal(
    end: WsEnd,
    record: DeviceStreamTicket,
    ticketId: string | null,
  ): Promise<void> {
    if (!(await this.access.ticketStands(record))) {
      end.close(VIEWER_CLOSE.badTicket, "invalid ticket");
      return;
    }
    const life = new AbortController();
    void end.closed.then(() => life.abort());
    let hold: StreamHold;
    try {
      hold = await this.sandbox.holdForStream(record.deviceId, record.orgId, life.signal);
    } catch (err) {
      if (life.signal.aborted) return;
      if (err instanceof DeviceAccessError) {
        end.close(VIEWER_CLOSE.gone, closeReason(err.message));
        return;
      }
      throw err;
    }
    let stream: DeviceStream;
    try {
      stream = await hold.p.openStream(hold.h, { service: record.service }, hold.signal);
    } catch (err) {
      await hold.release();
      if (life.signal.aborted) return;
      if (isElsewhere(err) && ticketId !== null) {
        await this.hop(end, ticketId, record);
        return;
      }
      if (isDeviceOfflineError(err) || isElsewhere(err)) {
        end.close(VIEWER_CLOSE.offline, "device-offline");
        return;
      }
      this.log.debug("device stream did not open", {
        deviceId: record.deviceId,
        service: record.service,
        error: errMsg(err),
      });
      end.close(VIEWER_CLOSE.gone, "service unavailable");
      return;
    }
    const started = Date.now();
    let viewed = false;
    let closeCode: number = VIEWER_CLOSE.normal;
    try {
      if (!end.isOpen) {
        stream.close("viewer closed");
        return;
      }
      await audit(this.kdb.db, {
        actorAccountId: record.accountId,
        orgId: record.orgId,
        action: "browser.view",
        target: record.deviceId,
        detail: {
          deviceId: record.deviceId,
          service: record.service,
          extension: record.extension,
          conversationId: record.conversationId,
        },
      });
      viewed = true;
      void pump(stream.messages, end);
      void pump(end.messages, stream);
      const settled = await Promise.race([
        end.closed.then(() => ({ side: "viewer" as const })),
        stream.closed.then((c) => ({ side: "stream" as const, reason: c.reason })),
        abortedOf(hold.signal).then(() => ({ side: "hold" as const })),
      ]);
      if (settled.side === "viewer" || life.signal.aborted) {
        stream.close("viewer closed");
        closeCode = (await end.closed).code;
      } else if (settled.side === "stream") {
        closeCode = settled.reason === "device-offline" ? VIEWER_CLOSE.offline : VIEWER_CLOSE.gone;
        end.close(
          closeCode,
          settled.reason === "device-offline" ? "device-offline" : "stream closed",
        );
      } else {
        // the hold yielded to a lifecycle change: gone with the instance, else reconnect
        stream.close("device lifecycle change");
        closeCode = (await this.instanceRunning(record.deviceId))
          ? VIEWER_CLOSE.restart
          : VIEWER_CLOSE.gone;
        end.close(closeCode, "device lifecycle change");
      }
    } finally {
      stream.close("viewer closed");
      await hold.release();
      if (viewed) {
        await audit(this.kdb.db, {
          actorAccountId: record.accountId,
          orgId: record.orgId,
          action: "browser.view_closed",
          target: record.deviceId,
          detail: {
            deviceId: record.deviceId,
            service: record.service,
            durationMs: Date.now() - started,
            code: closeCode,
          },
        }).catch((err: unknown) =>
          this.log.warn("cannot audit a closed device stream viewer", {
            deviceId: record.deviceId,
            error: errMsg(err),
          }),
        );
      }
    }
  }

  private async instanceRunning(deviceId: string): Promise<boolean> {
    const row = await this.kdb.db
      .selectFrom("device_instances")
      .select("status")
      .where("device_id", "=", deviceId)
      .executeTakeFirst()
      .catch(() => undefined);
    return row?.status === "running";
  }
}

const isElsewhere = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  (e as { code?: unknown }).code === "device.stream_elsewhere";
