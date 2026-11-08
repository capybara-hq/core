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
  DEVICE_TAKEN_PREFIX,
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
  deviceRevokedTopic,
  deviceTakenKey,
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

/**
 * Pops the next frame of the request list (`KEYS[1]`) and, when it is a `req`, marks it taken in
 * the same step: `<ARGV[1]><id>` → the environment id `ARGV[2]`, for the reconnect grace
 * `ARGV[3]` ms plus the request's deadline plus the margin `ARGV[4]` ms (ruling R20). Returns the
 * frame, or false when the list is empty. A frame that is not JSON is returned as is (the caller
 * drops it). The taken key cannot be declared in KEYS (its id is known only after the pop): like
 * the rest of the kernel, this assumes a single-node Valkey / Redis, not a cluster.
 */
const TAKE = `
local raw = redis.call('LPOP', KEYS[1])
if not raw then return false end
local ok, f = pcall(cjson.decode, raw)
if ok and type(f) == 'table' and f.type == 'req' and type(f.id) == 'string'
  and type(f.deadlineMs) == 'number' and f.deadlineMs > 0 then
  local ttl = tonumber(ARGV[3]) + math.ceil(f.deadlineMs) + tonumber(ARGV[4])
  redis.call('SET', ARGV[1] .. f.id, ARGV[2], 'PX', ttl)
end
return raw
`;

/**
 * Accepts a result (ruling R20): only when its request is marked taken (`KEYS[1]`) for the
 * environment `ARGV[1]`. Stores the frame `ARGV[2]` under `KEYS[2]` for what is left of the taken
 * mark's TTL (the caller's whole window, also after a reconnect) and clears the mark. Returns 1
 * when stored, 0 otherwise.
 */
const ACCEPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ttl)
redis.call('DEL', KEYS[1])
return 1
`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type State = "hello" | "claiming" | "holding" | "closed";

/**
 * One machine connection on this replica. Its state (the socket, the lease handle, the requests
 * it forwarded) is the socket's own and lives exactly as long as the socket.
 */
class DeviceConnection {
  readonly token = randomUUID();
  state: State = "hello";
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
      if (!(await this.claim())) return;
      try {
        await this.gw.machines.recordHello(this.identity.machineId, frame);
      } catch (e) {
        this.gw.log.warn("could not record a device hello", {
          environmentId: this.environmentId,
          error: errMsg(e),
        });
      }
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

  /**
   * Stores one result and announces it (the relay's wire, relay.ts), only for a request taken for
   * this environment (ruling R20); anything else is dropped.
   */
  private async store(res: DeviceRes): Promise<void> {
    try {
      const stored = await this.gw.redis.eval(
        ACCEPT,
        2,
        deviceTakenKey(res.id),
        deviceResKey(res.id),
        this.environmentId,
        JSON.stringify(res),
      );
      if (Number(stored) !== 1) {
        this.gw.log.warn("dropping a device result for a request not taken for its environment", {
          environmentId: this.environmentId,
        });
        return;
      }
      await this.gw.bus.publish(deviceResTopic(res.id), res);
    } catch (e) {
      this.gw.log.warn("could not store a device result", {
        environmentId: this.environmentId,
        error: errMsg(e),
      });
    }
  }

  /**
   * Claims the environment's lease; true when this connection holds it. The newest connection
   * wins (ruling R21): when another connection holds the lease, a takeover is published (the
   * holder yields to any takeover) and the lease retried every {@link CLAIM_RETRY_MS} for
   * {@link CLAIM_TIMEOUT_MS}, then 4409 (the program reconnects). A claimer never yields.
   */
  private async claim(): Promise<boolean> {
    const env = this.environmentId;
    try {
      // subscribed before claiming, so a takeover right after the claim is not missed
      await this.subscribe(deviceTakeoverTopic(env), (p) => {
        const token = (p as { token?: unknown } | null)?.token;
        if (this.state === "holding" && token !== this.token) {
          this.close(DEVICE_CLOSE.replaced, "replaced by a newer connection");
        }
      });
      if (this.state !== "claiming") return false;
      const ttl = this.gw.leaseTtlMs();
      let lease = await this.gw.locks.hold(deviceLeaseKey(env), this.token, ttl);
      if (!lease) {
        await this.gw.bus.publish(deviceTakeoverTopic(env), { token: this.token });
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
        return false;
      }
      if (!lease) {
        this.close(DEVICE_CLOSE.claimTimeout, "the environment is held by another connection");
        return false;
      }
      this.lease = lease;
      this.state = "holding";
      const onLost = () => this.close(DEVICE_CLOSE.leaseLost, "lease lost");
      if (lease.lost.aborted) {
        onLost();
        return false;
      }
      lease.lost.addEventListener("abort", onLost, { once: true });
      await this.subscribe(deviceReqTopic(env), () => this.drain());
      await this.subscribe(deviceRevokedTopic(env), (p) => {
        const id = (p as { machineId?: unknown } | null)?.machineId;
        if (id !== this.identity.machineId) return;
        // one more drain first: a stop frame whose nudge was lost still goes out before the close
        this.drain();
        this.chain = this.chain.then(() =>
          this.close(DEVICE_CLOSE.revoked, "the machine was disconnected"),
        );
      });
      if (this.state !== "holding") return false;
      this.gw.log.info("device connected", {
        environmentId: env,
        machineId: this.identity.machineId,
      });
      // what was queued while nobody held the machine
      this.drain();
      return true;
    } catch (e) {
      this.gw.log.warn("could not claim a device connection", {
        environmentId: env,
        error: errMsg(e),
      });
      this.close(DEVICE_CLOSE.internal, "internal error");
      return false;
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
      // no lease fencing needed: the pop is atomic, so each frame reaches one connection only, and
      // a holder that lost its lease still talks to the environment's own machine (or puts it back)
      const raw = (await this.gw.redis.eval(
        TAKE,
        1,
        key,
        DEVICE_TAKEN_PREFIX,
        this.environmentId,
        String(this.gw.graceMs()),
        String(LIST_TTL_MARGIN_MS),
      )) as string | null;
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
      this.socket.send(raw);
    }
  }

  /** The next ping (a chain of timeouts; the lease renewal is LockService's, not this timer's). */
  private schedulePing(): void {
    this.pingTimer = setTimeout(() => {
      this.ping();
      if (this.state !== "closed") this.schedulePing();
    }, this.gw.pingIntervalMs);
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
 * holder drains `capk:device-req:<environmentId>` on every `device.req.<environmentId>` nudge,
 * once after claiming and on every ping, marking each forwarded request taken for its environment
 * (`capk:device-taken:<id>`, TTL the reconnect grace plus the request's deadline plus a margin).
 * A `res` is accepted only for a request taken for the socket's environment: it is stored under
 * `capk:device-res:<id>` for the rest of that TTL and published on `device.res.<id>`.
 * `device.revoked.<environmentId>` closes the connection of that machine only (ruling R16). The
 * sockets are this process's own; everything other replicas need is in Redis.
 */
@Injectable()
export class DeviceGateway {
  /** This replica's open connections (the sockets cannot live anywhere else). */
  private readonly connections = new Set<DeviceConnection>();
  private stopping = false;
  /** How often connections are pinged ({@link PING_INTERVAL_MS}; a test seam). */
  pingIntervalMs = PING_INTERVAL_MS;

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
