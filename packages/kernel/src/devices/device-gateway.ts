import { randomUUID } from "node:crypto";
import {
  DEVICE_PROTOCOL_VERSION,
  type DeviceRes,
  type ExtensionContext,
  type KernelCancel,
  type KernelReq,
  parseDeviceFrame,
} from "@capybara-hq/plugin-sdk";
import type { WebSocket } from "@fastify/websocket";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { type LeaseHandle, LockService } from "../infra/lock/lock.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
  deviceRevokedTopic,
  deviceTakeoverTopic,
} from "./keys.js";
import { type MachineIdentity, MachinesService } from "./machines.js";
import { LIST_TTL_MARGIN_MS } from "./relay.js";

/** WebSocket close codes the gateway uses (the program reads 4002 and 4003). */
export const DEVICE_CLOSE = {
  /** The kernel is shutting down: reconnect (another gateway replica takes over). */
  shutdown: 1001,
  /** A frame larger than `environments.device.maxFrameBytes` (sent by `ws` itself). */
  tooBig: 1009,
  /** The kernel failed (e.g. the database): reconnect. */
  internal: 1011,
  /** The lease was lost (renewal kept failing or the key was taken): reconnect. */
  leaseLost: 4001,
  /** A newer connection of the environment took over: the program exits. */
  replaced: 4002,
  /** The machine's credential was revoked: the program exits. */
  revoked: 4003,
  /** No valid `hello` first, or a frame that is not protocol v1 from a device. */
  protocol: 4400,
  /** The lease could not be claimed in time: reconnect. */
  claimTimeout: 4409,
} as const;

/** How long the program has to send `hello` after the upgrade. */
export const HELLO_TIMEOUT_MS = 10_000;
/** How often a connection is pinged; two pings without a pong close it. */
export const PING_INTERVAL_MS = 20_000;
/** How long a new connection retries the lease after asking the holder to let go. */
export const CLAIM_TIMEOUT_MS = 5_000;
/** The pause between two tries at the lease while claiming. */
export const CLAIM_RETRY_MS = 250;
/** Traffic marks the machine seen at most this often per connection (the row has its own gate). */
const TOUCH_EVERY_MS = 30_000;
/** How often a held connection re-checks its credential (membership, org, environment). */
const REAUTH_EVERY_MS = 60_000;

/**
 * Puts a frame the holder popped but could not send back at the head of the list, keeping the
 * list's TTL at least `ARGV[2]` ms (the list never exists without one).
 */
const PUT_BACK = `
redis.call('LPUSH', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 1
`;

/** The payload of `device.takeover.<environmentId>`: who asks, and when it connected. */
interface Takeover {
  token: string;
  at: number;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isTakeover = (p: unknown): p is Takeover =>
  typeof p === "object" &&
  p !== null &&
  typeof (p as Takeover).token === "string" &&
  typeof (p as Takeover).at === "number";
/** Whether takeover `a` is newer than `b` (connect time, then token as the tie-break). */
const newer = (a: Takeover, b: Takeover) => a.at > b.at || (a.at === b.at && a.token > b.token);

type State = "hello" | "claiming" | "holding" | "closed";

/**
 * One machine connection on this replica. Its state (the socket, the lease handle, the requests
 * it forwarded) is the socket's own and lives exactly as long as the socket.
 */
class DeviceConnection {
  readonly token = randomUUID();
  readonly at = Date.now();
  state: State = "hello";
  /** Requests forwarded to the machine and not answered yet: id → `deadlineMs` (the result TTL). */
  private readonly taken = new Map<string, number>();
  private lease: LeaseHandle | undefined;
  private readonly unsubscribes: (() => Promise<void>)[] = [];
  private helloTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private missedPongs = 0;
  private lastTouch = 0;
  private lastAuth = Date.now();
  /** The drains (and the close after a revocation) run one after another. */
  private chain: Promise<void> = Promise.resolve();
  /** Resolves once the lease is handed back (or was never held). */
  private released: Promise<void> | undefined;

  constructor(
    private readonly gw: DeviceGateway,
    private readonly socket: WebSocket,
    readonly identity: MachineIdentity,
    private readonly credential: string,
  ) {}

  get environmentId(): string {
    return this.identity.environmentId;
  }

  start(): void {
    const { socket } = this;
    this.helloTimer = setTimeout(
      () => this.close(DEVICE_CLOSE.protocol, "hello expected"),
      HELLO_TIMEOUT_MS,
    );
    this.schedulePing();
    socket.on("pong", () => {
      this.missedPongs = 0;
      this.traffic();
    });
    socket.on("message", (data, isBinary) => {
      if (this.state === "closed") return;
      this.traffic();
      if (isBinary) {
        this.close(DEVICE_CLOSE.protocol, "frames are JSON text");
        return;
      }
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Buffer.from(data).toString("utf8");
      void this.onFrame(text);
    });
    socket.on("close", () => {
      void this.shutdown();
    });
  }

  private async onFrame(text: string): Promise<void> {
    let frame: ReturnType<typeof parseDeviceFrame>;
    try {
      frame = parseDeviceFrame(text, "device");
    } catch (e) {
      this.gw.log.warn("device sent an invalid frame", {
        environmentId: this.environmentId,
        error: errMsg(e),
      });
      this.close(DEVICE_CLOSE.protocol, "invalid frame");
      return;
    }
    if (frame.type === "hello") {
      if (this.state !== "hello") {
        this.close(DEVICE_CLOSE.protocol, "hello sent twice");
        return;
      }
      if (frame.protocol !== DEVICE_PROTOCOL_VERSION) {
        this.close(DEVICE_CLOSE.protocol, "unsupported protocol");
        return;
      }
      clearTimeout(this.helloTimer);
      this.state = "claiming";
      try {
        await this.gw.machines.recordHello(this.identity.machineId, frame);
      } catch (e) {
        this.gw.log.warn("could not record a device hello", {
          environmentId: this.environmentId,
          error: errMsg(e),
        });
        this.close(DEVICE_CLOSE.internal, "internal error");
        return;
      }
      await this.claim();
      return;
    }
    if (frame.type !== "res" || this.state === "hello") {
      this.close(DEVICE_CLOSE.protocol, "hello expected");
      return;
    }
    // results are stored in any state after hello: the program sends those it kept while
    // disconnected right after its hello, before the lease is claimed
    await this.store(frame);
  }

  /** Stores one result and announces it (the relay's wire, relay.ts). */
  private async store(res: DeviceRes): Promise<void> {
    const deadlineMs = this.taken.get(res.id) ?? 0;
    this.taken.delete(res.id);
    const ttlMs = this.gw.graceMs() + deadlineMs + LIST_TTL_MARGIN_MS;
    try {
      await this.gw.redis.set(deviceResKey(res.id), JSON.stringify(res), "PX", ttlMs);
      await this.gw.bus.publish(deviceResTopic(res.id), res);
    } catch (e) {
      this.gw.log.warn("could not store a device result", {
        environmentId: this.environmentId,
        error: errMsg(e),
      });
    }
  }

  /**
   * Claims the environment's lease: newest connection wins. When another connection holds it,
   * a takeover is published and the lease retried every {@link CLAIM_RETRY_MS} for
   * {@link CLAIM_TIMEOUT_MS}. A newer takeover seen meanwhile ends this connection (4002).
   */
  private async claim(): Promise<void> {
    const env = this.environmentId;
    const me: Takeover = { token: this.token, at: this.at };
    try {
      // subscribed before asking, so a newer connection's takeover is never missed
      await this.subscribe(deviceTakeoverTopic(env), (p) => {
        if (isTakeover(p) && p.token !== this.token && newer(p, me)) {
          this.close(DEVICE_CLOSE.replaced, "replaced by a newer connection");
        }
      });
      if (this.state !== "claiming") return;
      const ttl = this.gw.leaseTtlMs();
      let lease = await this.gw.locks.hold(deviceLeaseKey(env), this.token, ttl);
      if (!lease) {
        await this.gw.bus.publish(deviceTakeoverTopic(env), me);
        const until = Date.now() + CLAIM_TIMEOUT_MS;
        while (!lease && this.state === "claiming" && Date.now() < until) {
          await new Promise((r) => setTimeout(r, CLAIM_RETRY_MS));
          if (this.state !== "claiming") break;
          lease = await this.gw.locks.hold(deviceLeaseKey(env), this.token, ttl);
        }
      }
      if (this.state !== "claiming") {
        // closed while claiming (replaced, revoked, shutdown, the machine left)
        await lease?.release();
        return;
      }
      if (!lease) {
        this.close(DEVICE_CLOSE.claimTimeout, "the environment is held by another connection");
        return;
      }
      this.lease = lease;
      this.state = "holding";
      const onLost = () => this.close(DEVICE_CLOSE.leaseLost, "lease lost");
      if (lease.lost.aborted) {
        onLost();
        return;
      }
      lease.lost.addEventListener("abort", onLost, { once: true });
      await this.subscribe(deviceReqTopic(env), () => this.drain());
      await this.subscribe(deviceRevokedTopic(env), (p) => {
        const id = (p as { machineId?: unknown } | null)?.machineId;
        if (id !== this.identity.machineId) return;
        // after the drains already queued: a stop frame nudged before the revocation goes out
        this.chain = this.chain.then(() =>
          this.close(DEVICE_CLOSE.revoked, "the machine was disconnected"),
        );
      });
      if (this.state !== "holding") return;
      this.gw.log.info("device connected", {
        environmentId: env,
        machineId: this.identity.machineId,
      });
      // what was queued while nobody held the machine
      this.drain();
    } catch (e) {
      this.gw.log.warn("could not claim a device connection", {
        environmentId: env,
        error: errMsg(e),
      });
      this.close(DEVICE_CLOSE.internal, "internal error");
    }
  }

  /** Subscribes for this connection; a subscription that completes after the close is ended. */
  private async subscribe(topic: string, handler: (payload: unknown) => void): Promise<void> {
    const unsubscribe = await this.gw.bus.subscribe(topic, handler);
    if (this.state === "closed") await unsubscribe().catch(() => {});
    else this.unsubscribes.push(unsubscribe);
  }

  /** Queues one drain of the request list after the ones already queued. */
  private drain(): void {
    this.chain = this.chain
      .then(() => this.drainOnce())
      .catch((e: unknown) => {
        this.gw.log.warn("device request drain failed", {
          environmentId: this.environmentId,
          error: errMsg(e),
        });
      });
  }

  private async drainOnce(): Promise<void> {
    const key = deviceReqKey(this.environmentId);
    while (this.state === "holding") {
      const raw = await this.gw.redis.lpop(key);
      if (raw === null) return;
      let frame: KernelReq | KernelCancel;
      try {
        frame = parseDeviceFrame(raw, "kernel") as KernelReq | KernelCancel;
      } catch (e) {
        this.gw.log.warn("dropping an invalid device request", {
          environmentId: this.environmentId,
          error: errMsg(e),
        });
        continue;
      }
      const ttlMs =
        this.gw.graceMs() + (frame.type === "req" ? frame.deadlineMs : 0) + LIST_TTL_MARGIN_MS;
      if (this.state !== "holding" || this.socket.readyState !== this.socket.OPEN) {
        // closed while popping: back to the head of the list for the next connection
        await this.gw.redis.eval(PUT_BACK, 1, key, raw, String(ttlMs));
        return;
      }
      if (frame.type === "req" && Buffer.byteLength(raw) > this.gw.maxFrameBytes()) {
        await this.store({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            kind: "error",
            message: "The request is larger than environments.device.maxFrameBytes",
          },
        });
        continue;
      }
      if (frame.type === "req") this.taken.set(frame.id, frame.deadlineMs);
      else this.taken.delete(frame.id);
      this.socket.send(raw);
    }
  }

  /** The next ping (a chain of timeouts; the lease renewal is LockService's, not this timer's). */
  private schedulePing(): void {
    this.pingTimer = setTimeout(() => {
      this.ping();
      if (this.state !== "closed") this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  private ping(): void {
    if (this.state === "closed") return;
    if (this.missedPongs >= 2) {
      this.gw.log.info("device connection missed two pongs", { environmentId: this.environmentId });
      this.socket.terminate();
      void this.shutdown();
      return;
    }
    this.missedPongs++;
    this.socket.ping();
    // a backstop for a lost nudge (the bus delivers at most once)
    if (this.state === "holding") this.drain();
    if (this.state === "holding" && Date.now() - this.lastAuth >= REAUTH_EVERY_MS) {
      this.lastAuth = Date.now();
      void this.reauthenticate();
    }
  }

  /** The credential still stands (membership, org and environment are read live). */
  private async reauthenticate(): Promise<void> {
    try {
      const id = await this.gw.machines.authenticate(this.credential);
      if (id === null || id.machineId !== this.identity.machineId) {
        this.close(DEVICE_CLOSE.revoked, "the machine was disconnected");
      }
    } catch (e) {
      this.gw.log.warn("could not re-check a device credential", {
        environmentId: this.environmentId,
        error: errMsg(e),
      });
    }
  }

  private traffic(): void {
    const now = Date.now();
    if (now - this.lastTouch < TOUCH_EVERY_MS) return;
    this.lastTouch = now;
    this.gw.machines.touch(this.identity.machineId).catch((e: unknown) => {
      this.gw.log.warn("could not mark a machine seen", {
        environmentId: this.environmentId,
        error: errMsg(e),
      });
    });
  }

  /** Closes the socket with `code` and hands the lease back; idempotent. */
  close(code: number, reason: string): Promise<void> {
    if (this.state !== "closed") {
      try {
        this.socket.close(code, reason);
      } catch {
        this.socket.terminate();
      }
    }
    return this.shutdown();
  }

  /** Stops timers and subscriptions and releases the lease (a lost one is abandoned). */
  shutdown(): Promise<void> {
    if (this.released) return this.released;
    this.state = "closed";
    clearTimeout(this.helloTimer);
    clearTimeout(this.pingTimer);
    const lease = this.lease;
    this.released = (async () => {
      try {
        if (lease) {
          if (lease.lost.aborted) lease.abandon();
          else await lease.release();
        }
      } catch (e) {
        this.gw.log.warn("could not release a device lease", {
          environmentId: this.environmentId,
          error: errMsg(e),
        });
      }
      await Promise.all(this.unsubscribes.splice(0).map((u) => u().catch(() => {})));
      this.gw.forget(this);
      if (lease) {
        this.gw.log.info("device disconnected", {
          environmentId: this.environmentId,
          machineId: this.identity.machineId,
        });
      }
    })();
    return this.released;
  }
}

/**
 * The gateway role's half of the device relay (environments spec §13.4): holds the WebSocket
 * connections of connected machines (`GET /device/connect`, device-routes.ts). One connection per
 * environment across replicas, under the lease `capk:device-lease:<environmentId>` (the newest
 * connection wins: it publishes `device.takeover.<environmentId>` and the holder lets go). The
 * holder drains `capk:device-req:<environmentId>` on every `device.req.<environmentId>` nudge and
 * once after claiming, forwards the frames, and stores each `res` under `capk:device-res:<id>`
 * (TTL: the reconnect grace plus the request's deadline plus a margin) before publishing it on
 * `device.res.<id>`. `device.revoked.<environmentId>` closes the connection of that machine only
 * (ruling R16). The sockets are this process's own; everything other replicas need is in Redis.
 */
@Injectable()
export class DeviceGateway {
  /** This replica's open connections (the sockets cannot live anywhere else). */
  private readonly connections = new Set<DeviceConnection>();
  private stopping = false;

  constructor(
    @Inject(MachinesService)
    readonly machines: Pick<MachinesService, "authenticate" | "recordHello" | "touch">,
    @Inject(LockService) readonly locks: Pick<LockService, "hold">,
    @Inject(KERNEL_BUS) readonly bus: ExtensionContext["bus"],
    @Inject(REDIS) readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_LOGGER) readonly log: Pick<KernelLogger, "info" | "warn">,
  ) {}

  graceMs(): number {
    return this.config.get().environments.device.reconnectGraceSeconds * 1000;
  }

  leaseTtlMs(): number {
    return this.config.get().environments.device.leaseTtlMs;
  }

  maxFrameBytes(): number {
    return this.config.get().environments.device.maxFrameBytes;
  }

  /** Who a `Bearer` machine credential stands for, or null (checked before the upgrade). */
  authenticate(credential: string): Promise<MachineIdentity | null> {
    return this.machines.authenticate(credential);
  }

  /** Serves one upgraded socket of an authenticated machine until it closes. */
  accept(socket: WebSocket, identity: MachineIdentity, credential: string): void {
    if (this.stopping) {
      socket.close(DEVICE_CLOSE.shutdown, "shutting down");
      return;
    }
    const conn = new DeviceConnection(this, socket, identity, credential);
    this.connections.add(conn);
    conn.start();
  }

  /** @internal a connection that ended. */
  forget(conn: DeviceConnection): void {
    this.connections.delete(conn);
  }

  /** Closes every connection (1001) and hands their leases back. */
  async stop(): Promise<void> {
    this.stopping = true;
    await Promise.all(
      [...this.connections].map((c) => c.close(DEVICE_CLOSE.shutdown, "shutting down")),
    );
  }
}
