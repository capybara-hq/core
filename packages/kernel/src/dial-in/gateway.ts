import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  DeviceOfflineError,
  type DeviceStream,
  DIAL_IN_PROTOCOL_RE,
  type DialInConnectionInfo,
  type DialInKernelFrame,
  type DialInMachineFrame,
  DialInStreamElsewhereError,
  type ExtensionContext,
  parseDialInMachineFrame,
} from "@capybara-hq/plugin-sdk";
import type { WebSocket } from "@fastify/websocket";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { asPlatform, withOrgScope, withoutOrgScope } from "../infra/database/org-scope.js";
import { type LeaseHandle, LockService } from "../infra/lock/lock.service.js";
import { KERNEL_BUS, KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { DialInAccess } from "./access.js";
import { storedResult, wireFrameOf } from "./envelope.js";
import { DialInHandlers, type DialInServing, type DialInUnavailable } from "./handlers.js";
import {
  DEVICE_TAKEN_PREFIX,
  deviceHolderAddrKey,
  deviceLeaseKey,
  deviceReqKey,
  deviceReqTopic,
  deviceResKey,
  deviceResTopic,
  deviceRevokedTopic,
  deviceTakenKey,
  deviceTakeoverTopic,
  deviceTransportKey,
} from "./keys.js";
import { DialInMachines, type MachineIdentity, type MachineRevokedMessage } from "./machines.js";
import { LIST_TTL_MARGIN_MS } from "./relay.js";
import { DialInStreams, isStreamFrame, STREAM_OPEN_TIMEOUT_MS } from "./streams.js";

/** WebSocket close codes the gateway uses (the program reads 4002 and 4003). */
export const DEVICE_CLOSE = {
  /** The kernel is shutting down: reconnect (another gateway replica takes over). */
  shutdown: 1001,
  /** A frame larger than `devices.dialIn.maxFrameBytes` (sent by `ws` itself). */
  tooBig: 1009,
  /** The kernel failed (e.g. the database): reconnect. */
  internal: 1011,
  /** The lease was lost (renewal kept failing or the key was taken): reconnect. */
  leaseLost: 4001,
  /** A newer connection of the device took over: the program exits. */
  replaced: 4002,
  /** The machine's credential was revoked: the program exits. */
  revoked: 4003,
  /**
   * No valid `hello` first, a frame that is no valid envelope or does not fit the negotiated
   * capacity, or the provider refused the hello (the reason carries its code).
   */
  protocol: 4400,
  /** The lease could not be claimed in time: reconnect. */
  claimTimeout: 4409,
} as const;

/** How long the program has to send `hello` after the upgrade, and the provider to answer it. */
export const HELLO_TIMEOUT_MS = 10_000;
/** How often a connection is pinged; two pings without a pong close it. */
export const PING_INTERVAL_MS = 20_000;
/** How long a new connection retries the lease after asking the holder to let go. */
export const CLAIM_TIMEOUT_MS = 5_000;
/** The pause between two tries at the lease while claiming. */
export const CLAIM_RETRY_MS = 250;
/** Traffic marks the machine seen at most this often per connection (the row has its own gate). */
const TOUCH_EVERY_MS = 30_000;
/**
 * Consecutive failed capacity publications on ping after which a connection closes (its
 * transport key lives three pings, so two misses still leave it readable).
 */
const MAX_PUBLISH_FAILURES = 3;
/**
 * The most `event` frames a connection may have waiting for the provider (received, not yet
 * handled): a machine sending faster than its provider handles them is closed (4400) instead of
 * growing the gateway's memory.
 */
export const MAX_EVENTS_IN_FLIGHT = 32;
/** How often a held connection re-checks its credential (membership, org, device). */
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
 * the same step: `<ARGV[1]><id>` → the device id `ARGV[2]`, for the reconnect grace
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
 * device `ARGV[1]`. Stores the frame `ARGV[2]` under `KEYS[2]` for what is left of the taken
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

/**
 * Writes the holder record `ARGV[2]` (`{ token, address }`) under `KEYS[2]` for `ARGV[3]` ms, only
 * while the lease `KEYS[1]` is held by the token `ARGV[1]` (a connection that lost its lease never
 * overwrites its successor's address). Returns 1 when written.
 */
const WRITE_ADDR = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
return 1
`;

/**
 * Reads the lease `KEYS[1]` and the holder record `KEYS[2]` in one step: the record's address
 * only when its token is the current lease's (an expired lease or a takeover whose holder has not
 * written its address yet answers nothing, never a gone or replaced replica's address).
 */
const READ_ADDR = `
local holder = redis.call('GET', KEYS[1])
if not holder then return false end
local raw = redis.call('GET', KEYS[2])
if not raw then return false end
local ok, rec = pcall(cjson.decode, raw)
if not ok or type(rec) ~= 'table' or rec.token ~= holder or type(rec.address) ~= 'string' then
  return false
end
return rec.address
`;

/**
 * Deletes the holder's address `KEYS[2]` once the lease `KEYS[1]` is free or still the token
 * `ARGV[1]`'s: a successor that already claimed the lease keeps the address it writes.
 */
const DELETE_ADDR = `
local holder = redis.call('GET', KEYS[1])
if holder and holder ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[2])
`;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A WebSocket close reason is at most 123 UTF-8 bytes. */
const closeReason = (text: string): string => {
  let out = text;
  while (Buffer.byteLength(out) > 123) out = out.slice(0, -1);
  return out;
};

/** Why a provider's `onClose` is called. */
type CloseReason = "offline" | "replaced" | "revoked" | "deleted";

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
  /** The hello's handling, then each event's, one after another (never rejects). */
  private handled: Promise<void> = Promise.resolve();
  /** Aborted when the connection closes: the provider's `onHello` stops waiting. */
  private readonly ended = new AbortController();
  /** The provider whose `onHello` accepted this connection: it gets `onClose`. */
  private accepted: DialInServing | undefined;
  /** `event` frames received and not yet handled ({@link MAX_EVENTS_IN_FLIGHT}). */
  private eventsInFlight = 0;
  /** Why the connection closed, for the provider's `onClose` (offline unless set). */
  private closeReason: CloseReason = "offline";

  constructor(
    private readonly gw: DialInGateway,
    private readonly socket: WebSocket,
    readonly identity: MachineIdentity,
    private readonly credential: string,
    /** The protocol the route admitted (the serving provider's `permissions.dialIn.protocol`). */
    private readonly protocol: string,
    /** The local port the socket arrived on (the holder address's default port when unset). */
    private readonly localPort: number | undefined,
  ) {
    this.streams = new DialInStreams(
      identity.deviceId,
      {
        send: (text) => {
          if (this.state === "closed" || this.socket.readyState !== this.socket.OPEN) return false;
          this.socket.send(text);
          return true;
        },
        maxFrameBytes: () => this.effectiveCap ?? 0,
      },
      () => this.gw.streamOpenTimeoutMs,
    );
  }

  /** This connection's streams (the socket's own state, ended with it). */
  private readonly streams: DialInStreams;

  /**
   * The id a connection fences requests and results with (sent to the machine in `ready`).
   * Random and separate from the lease token, which stays internal to the kernel.
   */
  readonly connectionId = randomUUID();
  /** The negotiated capacity: the smaller of the machine's and the kernel's frame limits. */
  private effectiveCap: number | undefined;
  /** The program run the hello named (`programRunId`), published with the capacity. */
  private programRunId: string | undefined;
  private ready = false;
  /** Consecutive failed capacity publications on ping (this socket's own state). */
  private publishFailures = 0;
  private async publishCapacity(): Promise<void> {
    if (this.effectiveCap === undefined || this.state !== "holding") return;
    if (this.gw.maxFrameBytes() < this.effectiveCap) {
      await this.close(DEVICE_CLOSE.protocol, "Frame capacity changed; reconnect");
      return;
    }
    const ttl = Math.max(this.gw.leaseTtlMs(), this.gw.pingIntervalMs * 3);
    await this.gw.redis.set(
      deviceTransportKey(this.deviceId, this.token),
      JSON.stringify({
        connectionId: this.connectionId,
        maxFrameBytes: this.effectiveCap,
        ...(this.programRunId !== undefined && { programRunId: this.programRunId }),
      }),
      "PX",
      ttl,
    );
    await this.writeAddress();
  }

  /**
   * Where other replicas hop a device stream to: the holder record `{ token, address }` next to
   * the lease (written at the claim, refreshed with the capacity), read only under that token.
   */
  private async writeAddress(): Promise<void> {
    await this.gw.redis.eval(
      WRITE_ADDR,
      2,
      deviceLeaseKey(this.deviceId),
      deviceHolderAddrKey(this.deviceId),
      this.token,
      JSON.stringify({ token: this.token, address: this.gw.internalAddress(this.localPort) }),
      String(Math.max(this.gw.leaseTtlMs(), this.gw.pingIntervalMs * 3)),
    );
  }

  /** Whether this connection holds its device and sent `ready` (streams may open). */
  get serving(): boolean {
    return this.state === "holding" && this.ready;
  }

  /** Opens a stream to the machine on this socket ({@link DialInStreams.openStream}). */
  openStream(body: unknown, signal: AbortSignal): Promise<DeviceStream> {
    if (!this.serving) return Promise.reject(new DeviceOfflineError(this.deviceId));
    return this.streams.openStream(body, signal);
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  /**
   * Runs `fn` in the device's org (RLS spec §5.3: per-event work of a long connection enters the
   * org its credential resolved). Socket listeners run in the emitter's async context, not the
   * one that registered them, so each enters it again.
   */
  private inOrg<T>(fn: () => T): T {
    // never throw inside a socket listener: a device without an org (impossible by the schema)
    // runs unscoped, which fails closed
    const { orgId } = this.identity;
    return orgId ? withOrgScope(orgId, fn) : withoutOrgScope(fn);
  }

  start(): void {
    // the timers armed here keep this scope (timers carry their creator's async context)
    this.inOrg(() => this.arm());
  }

  private arm(): void {
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
      void this.inOrg(() => this.onFrame(text));
    });
    socket.on("close", () => {
      void this.inOrg(() => this.shutdown());
    });
  }

  private async onFrame(text: string): Promise<void> {
    let frame: DialInMachineFrame;
    try {
      // the envelope only (the body is the provider's), bounded by the negotiated capacity once
      // the hello set it, by the kernel's own limit before
      frame = parseDialInMachineFrame(text, this.effectiveCap ?? this.gw.maxFrameBytes());
      if (this.effectiveCap !== undefined && this.gw.maxFrameBytes() < this.effectiveCap)
        throw new Error("Frame capacity changed; reconnect");
    } catch (e) {
      this.gw.log.warn("device sent an invalid frame", {
        deviceId: this.deviceId,
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
      if (frame.protocol !== this.protocol) {
        this.close(DEVICE_CLOSE.protocol, `unsupported protocol; expected ${this.protocol}`);
        return;
      }
      // the machine's announced limit never raises the kernel's own
      this.effectiveCap = Math.min(frame.transport.maxFrameBytes, this.gw.maxFrameBytes());
      if (this.effectiveCap < 1024 || Buffer.byteLength(text) > this.effectiveCap) {
        this.close(DEVICE_CLOSE.protocol, "Check frame limits: hello cannot fit");
        return;
      }
      clearTimeout(this.helloTimer);
      this.programRunId = frame.programRunId;
      this.state = "claiming";
      // set before the first await: an event that follows is handled after the hello
      const hello = frame;
      this.handled = this.welcome(hello);
      await this.handled;
      return;
    }
    if (frame.type === "event") {
      if (this.state === "hello") {
        this.close(DEVICE_CLOSE.protocol, "hello expected");
        return;
      }
      if (this.eventsInFlight >= MAX_EVENTS_IN_FLIGHT) {
        this.gw.log.warn("device sent more events than its provider handles", {
          deviceId: this.deviceId,
        });
        this.close(DEVICE_CLOSE.protocol, "too many events in flight; slow down and reconnect");
        return;
      }
      this.eventsInFlight++;
      // after the hello and the earlier events, in the order they came
      const body = frame.body;
      this.handled = this.handled
        .then(() => this.dispatchEvent(body))
        .finally(() => {
          this.eventsInFlight--;
        });
      await this.handled;
      return;
    }
    if (this.state === "hello" || !this.ready) {
      this.close(DEVICE_CLOSE.protocol, "hello expected");
      return;
    }
    // stream frames go to this socket's stream table, never through shared state
    if (isStreamFrame(frame)) {
      this.streams.onFrame(frame);
      return;
    }
    // results are stored in any state after ready: the program sends those it kept while
    // disconnected right after its ready
    await this.store(frame);
  }

  /**
   * The accepted hello: claims the lease, records the program facts, then asks the provider
   * (`onHello`, within {@link HELLO_TIMEOUT_MS}); only an accepted hello gets `ready`. A refusal, a
   * failure or the timeout releases the lease and closes 4400 with the provider's code.
   */
  private async welcome(hello: Extract<DialInMachineFrame, { type: "hello" }>): Promise<void> {
    if (!(await this.claim())) return;
    try {
      await this.gw.machines.recordConnect(this.identity.machineId, hello.program);
    } catch (e) {
      this.gw.log.warn("could not record a device connection", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
    }
    if (this.state !== "holding") return;
    let serving: DialInServing | DialInUnavailable;
    try {
      serving = await this.gw.handlers.forDevice(this.deviceId);
    } catch (e) {
      this.gw.log.warn("could not read a device's dial-in provider", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
      await this.close(DEVICE_CLOSE.internal, "internal error");
      return;
    }
    if ("unavailable" in serving || serving.protocol !== this.protocol) {
      await this.close(DEVICE_CLOSE.protocol, "the device's provider is unavailable");
      return;
    }
    const verdict = await this.askProvider(serving, hello.body);
    if (this.state !== "holding") return;
    if (!verdict.ok) {
      this.gw.log.info("device provider refused a hello", {
        deviceId: this.deviceId,
        plugin: serving.plugin,
        code: verdict.code,
      });
      await this.close(DEVICE_CLOSE.protocol, closeReason(`${verdict.code}: ${verdict.message}`));
      return;
    }
    this.accepted = serving;
    try {
      await this.sendReady();
    } catch (e) {
      this.gw.log.warn("could not open a device connection", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
      await this.close(DEVICE_CLOSE.internal, "internal error");
    }
  }

  /** The provider's answer to the hello body; a throw or the timeout is a refusal. */
  private async askProvider(
    serving: DialInServing,
    body: unknown,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const signal = AbortSignal.any([this.ended.signal, AbortSignal.timeout(HELLO_TIMEOUT_MS)]);
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = serving.handler.onHello(this.deviceId, body, signal, this.info());
      const r = await Promise.race([
        answer,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("the provider did not answer the hello in time")),
            HELLO_TIMEOUT_MS,
          );
        }),
      ]);
      if (r?.ok === true) return { ok: true };
      if (r?.ok === false && typeof r.code === "string")
        return { ok: false, code: r.code, message: String(r.message ?? "") };
      return { ok: false, code: "provider.invalid_answer", message: "no valid answer" };
    } catch (e) {
      this.gw.log.warn("device provider failed a hello", {
        deviceId: this.deviceId,
        plugin: serving.plugin,
        error: errMsg(e),
      });
      return { ok: false, code: "provider.failed", message: "the provider failed the hello" };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hands one event body to the provider that accepted the hello (dropped otherwise). */
  private async dispatchEvent(body: unknown): Promise<void> {
    if (this.state === "closed" || this.accepted === undefined) return;
    try {
      // read again: a provider switched off (or replaced) since the hello gets no more frames
      const serving = await this.gw.handlers.forDevice(this.deviceId);
      if ("unavailable" in serving || serving.plugin !== this.accepted.plugin) return;
      await serving.handler.onFrame?.(this.deviceId, body, this.info());
    } catch (e) {
      this.gw.log.warn("device provider failed a frame", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
    }
  }

  /**
   * Stores one result and announces it (the relay's wire, envelope.ts), only for a request taken
   * for this device (ruling R20); anything else is dropped. `notSent`: the gateway's own refusal
   * of a request it never sent (never a machine's frame).
   */
  private async store(res: { id: string; body?: unknown }, notSent?: string): Promise<void> {
    if (this.effectiveCap === undefined) return;
    try {
      const tagged = storedResult(
        res,
        { connectionId: this.connectionId, maxFrameBytes: this.effectiveCap },
        notSent,
      );
      const stored = await this.gw.redis.eval(
        ACCEPT,
        2,
        deviceTakenKey(res.id),
        deviceResKey(res.id),
        this.deviceId,
        JSON.stringify(tagged),
      );
      if (Number(stored) !== 1) {
        this.gw.log.warn("dropping a device result for a request not taken for its device", {
          deviceId: this.deviceId,
        });
        return;
      }
      await this.gw.bus.publish(deviceResTopic(res.id), tagged);
    } catch (e) {
      this.gw.log.warn("could not store a device result", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
    }
  }

  /**
   * Claims the device's lease; true when this connection holds it. The newest connection
   * wins (ruling R21): when another connection holds the lease, a takeover is published (the
   * holder yields to any takeover) and the lease retried every {@link CLAIM_RETRY_MS} for
   * {@link CLAIM_TIMEOUT_MS}, then 4409 (the program reconnects). A claimer never yields.
   */
  private async claim(): Promise<boolean> {
    const env = this.deviceId;
    try {
      // subscribed before claiming, so a takeover right after the claim is not missed
      await this.subscribe(deviceTakeoverTopic(env), (p) => {
        const token = (p as { token?: unknown } | null)?.token;
        if (this.state === "holding" && token !== this.token) {
          this.closeReason = "replaced";
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
        this.close(DEVICE_CLOSE.claimTimeout, "the device is held by another connection");
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
      await this.writeAddress();
      await this.subscribe(deviceReqTopic(env), () => this.drain());
      await this.subscribe(deviceRevokedTopic(env), (p) => {
        const message = p as Partial<MachineRevokedMessage> | null;
        if (message?.machineId !== this.identity.machineId) return;
        // the device signed in from another machine: replaced (the program exits as replaced)
        if (message.reason === "replaced") {
          this.closeReason = "replaced";
          this.chain = this.chain.then(() =>
            this.close(DEVICE_CLOSE.replaced, "the device signed in from another machine"),
          );
          return;
        }
        const deleted = message.reason === "deleted";
        this.closeReason = deleted ? "deleted" : "revoked";
        // one more drain first: a stop frame whose nudge was lost still goes out before the close
        this.drain();
        this.chain = this.chain.then(() =>
          this.close(
            DEVICE_CLOSE.revoked,
            deleted ? "the device was deleted" : "the machine was disconnected",
          ),
        );
      });
      return this.state === "holding";
    } catch (e) {
      this.gw.log.warn("could not claim a device connection", {
        deviceId: env,
        error: errMsg(e),
      });
      this.close(DEVICE_CLOSE.internal, "internal error");
      return false;
    }
  }

  /** Publishes the capacity, sends `ready` and drains what was queued meanwhile. */
  private async sendReady(): Promise<void> {
    // the effective capacity: the smaller of the machine's announced limit and the kernel's
    const ready: DialInKernelFrame = {
      type: "ready",
      connectionId: this.connectionId,
      maxFrameBytes: this.effectiveCap ?? 0,
    };
    const raw = JSON.stringify(ready);
    if (this.effectiveCap === undefined || Buffer.byteLength(raw) > this.effectiveCap)
      throw new Error("Check frame limits: ready cannot fit");
    // published before ready: a reader that sees the machine ready also finds its capacity
    await this.publishCapacity();
    if (this.state !== "holding") return;
    this.gw.log.info("device connected", {
      deviceId: this.deviceId,
      machineId: this.identity.machineId,
    });
    this.socket.send(raw);
    this.ready = true;
    // what was queued while nobody held the machine
    this.drain();
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
          deviceId: this.deviceId,
          error: errMsg(e),
        });
      });
  }

  private async drainOnce(): Promise<void> {
    const key = deviceReqKey(this.deviceId);
    while (this.state === "holding" && this.ready && this.effectiveCap !== undefined) {
      const cap = this.effectiveCap;
      if (this.gw.maxFrameBytes() < cap) {
        await this.close(DEVICE_CLOSE.protocol, "Frame capacity changed; reconnect");
        return;
      }
      // no lease fencing needed: the pop is atomic, so each frame reaches one connection only, and
      // a holder that lost its lease still talks to the device's own machine (or puts it back)
      const raw = (await this.gw.redis.eval(
        TAKE,
        1,
        key,
        DEVICE_TAKEN_PREFIX,
        this.deviceId,
        String(this.gw.graceMs()),
        String(LIST_TTL_MARGIN_MS),
      )) as string | null;
      if (raw === null) return;
      // a request goes out only on the connection it was fenced to, a stop only to its machine,
      // without the kernel-internal fields (envelope.ts)
      const decision = wireFrameOf(raw, {
        connectionId: this.connectionId,
        maxFrameBytes: cap,
        machineId: this.identity.machineId,
      });
      if ("drop" in decision) {
        this.gw.log.warn(`dropping ${decision.drop}`, { deviceId: this.deviceId });
        continue;
      }
      if ("refuse" in decision) {
        await this.store({ id: decision.id }, decision.refuse);
        continue;
      }
      const { send, text } = decision;
      const ttlMs =
        this.gw.graceMs() + (send.type === "req" ? send.deadlineMs : 0) + LIST_TTL_MARGIN_MS;
      if (this.state !== "holding" || this.socket.readyState !== this.socket.OPEN) {
        // closed while popping: back to the head of the list for the next connection
        await this.gw.redis.eval(PUT_BACK, 1, key, raw, String(ttlMs));
        return;
      }
      if (send.type === "req" && Buffer.byteLength(text) > cap) {
        await this.store(
          { id: send.id },
          `The request is larger than the connection's frame limit of ${cap} bytes`,
        );
        continue;
      }
      this.socket.send(text);
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
      this.gw.log.info("device connection missed two pongs", { deviceId: this.deviceId });
      this.socket.terminate();
      void this.shutdown();
      return;
    }
    this.missedPongs++;
    this.socket.ping();
    // a backstop for a lost nudge (the bus delivers at most once)
    if (this.state === "holding" && this.ready) {
      void this.publishCapacity().then(
        () => {
          this.publishFailures = 0;
        },
        (e: unknown) => {
          // the key lives three pings: a transient failure is retried on the next ping, and
          // only failures that would let the key expire close the connection
          this.publishFailures++;
          this.gw.log.warn("could not publish a device connection's capacity", {
            deviceId: this.deviceId,
            failures: this.publishFailures,
            error: errMsg(e),
          });
          if (this.publishFailures >= MAX_PUBLISH_FAILURES)
            void this.close(DEVICE_CLOSE.internal, "Capacity publication failed; reconnect");
        },
      );
      this.drain();
    }
    if (this.state === "holding" && Date.now() - this.lastAuth >= this.gw.reauthEveryMs) {
      this.lastAuth = Date.now();
      void this.reauthenticate();
    }
  }

  /**
   * The credential still stands (membership, org and device are read live); a deleted device
   * closes as deleted, like its revocation does.
   */
  private async reauthenticate(): Promise<void> {
    try {
      const id = await this.gw.machines.authenticate(this.credential);
      if (id === null || id.machineId !== this.identity.machineId) {
        const deleted = await this.gw.machines.isDeviceDeleted(this.deviceId);
        this.closeReason = deleted ? "deleted" : "revoked";
        this.close(
          DEVICE_CLOSE.revoked,
          deleted ? "the device was deleted" : "the machine was disconnected",
        );
      }
    } catch (e) {
      this.gw.log.warn("could not re-check a device credential", {
        deviceId: this.deviceId,
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
        deviceId: this.deviceId,
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

  /**
   * Stops timers and subscriptions, releases the lease (a lost one is abandoned) and tells the
   * provider that accepted the hello why the connection ended (`onClose`).
   */
  shutdown(): Promise<void> {
    if (this.released) return this.released;
    this.state = "closed";
    this.ready = false;
    this.ended.abort();
    this.streams.closeAll();
    clearTimeout(this.helloTimer);
    clearTimeout(this.pingTimer);
    const lease = this.lease;
    this.released = (async () => {
      try {
        await this.gw.redis.del(deviceTransportKey(this.deviceId, this.token));
        if (lease) {
          if (lease.lost.aborted) lease.abandon();
          else await lease.release();
          await this.gw.redis.eval(
            DELETE_ADDR,
            2,
            deviceLeaseKey(this.deviceId),
            deviceHolderAddrKey(this.deviceId),
            this.token,
          );
        }
      } catch (e) {
        this.gw.log.warn("could not release a device lease", {
          deviceId: this.deviceId,
          error: errMsg(e),
        });
      }
      await Promise.all(this.unsubscribes.splice(0).map((u) => u().catch(() => {})));
      this.gw.forget(this);
      if (lease) {
        this.gw.log.info("device disconnected", {
          deviceId: this.deviceId,
          machineId: this.identity.machineId,
        });
      }
      this.tellClosed();
    })();
    return this.released;
  }

  /** The machine and connection a provider callback is about (a fresh object per call). */
  private info(): DialInConnectionInfo {
    return { machineId: this.identity.machineId, connectionId: this.connectionId };
  }

  /** The provider's `onClose`, after the lease is handed back; its failure is only logged. */
  private tellClosed(): void {
    const accepted = this.accepted;
    if (accepted === undefined) return;
    this.accepted = undefined;
    try {
      const r = accepted.handler.onClose?.(this.deviceId, this.closeReason, this.info()) as unknown;
      if (r instanceof Promise)
        r.catch((e: unknown) =>
          this.gw.log.warn("device provider failed onClose", {
            deviceId: this.deviceId,
            error: errMsg(e),
          }),
        );
    } catch (e) {
      this.gw.log.warn("device provider failed onClose", {
        deviceId: this.deviceId,
        error: errMsg(e),
      });
    }
  }
}

/** What the device connection route learns before the upgrade: who connects and what it speaks. */
export type DialInAdmission =
  | { identity: MachineIdentity; serving: DialInServing }
  | { identity: MachineIdentity; unavailable: DialInUnavailable["unavailable"] }
  | null;

/**
 * The gateway role's half of the dial-in relay (environments spec §13.4): holds the WebSocket
 * connections of connected machines (`GET /device/connect`, routes.ts) and speaks the dial-in
 * envelope with them. One connection per device across replicas, under the lease
 * `capk:device-lease:<deviceId>` (the newest connection wins: it publishes
 * `device.takeover.<deviceId>` and the holder lets go). A hello is answered by the device's
 * provider (`DialInHandler.onHello`, {@link DialInHandlers}) once the lease is held; only an
 * accepted hello gets `ready`. The holder drains `capk:device-req:<deviceId>` on every
 * `device.req.<deviceId>` nudge, once after `ready` and on every ping, marking each forwarded
 * request taken for its device (`capk:device-taken:<id>`, TTL the reconnect grace plus the
 * request's deadline plus a margin). A `res` is accepted only for a request taken for the socket's
 * device: it is stored under `capk:device-res:<id>` for the rest of that TTL and published on
 * `device.res.<id>`. An `event` goes to the provider's `onFrame`; the close to its `onClose`.
 * `device.revoked.<deviceId>` closes the connection of that machine only (ruling R16). Device
 * streams ({@link DialInStreams}) run straight over the socket, so only the holder opens them; it
 * writes its internal address under `capk:device-holder-addr:<deviceId>` next to the lease for
 * the other replicas to hop to. The sockets are this process's own; everything other replicas
 * need is in Redis.
 */
@Injectable()
export class DialInGateway {
  /** This replica's open connections (the sockets cannot live anywhere else). */
  private readonly connections = new Set<DeviceConnection>();
  private stopping = false;
  /** How often connections are pinged ({@link PING_INTERVAL_MS}; a test seam). */
  pingIntervalMs = PING_INTERVAL_MS;
  /** How long a machine has to answer a stream open ({@link STREAM_OPEN_TIMEOUT_MS}; test seam). */
  streamOpenTimeoutMs = STREAM_OPEN_TIMEOUT_MS;
  /** How often a held connection re-checks its credential ({@link REAUTH_EVERY_MS}; test seam). */
  reauthEveryMs = REAUTH_EVERY_MS;

  constructor(
    @Inject(DialInMachines)
    readonly machines: Pick<
      DialInMachines,
      "authenticate" | "isDeviceDeleted" | "recordConnect" | "touch"
    >,
    @Inject(DialInHandlers) readonly handlers: Pick<DialInHandlers, "forDevice">,
    @Inject(LockService) readonly locks: Pick<LockService, "hold">,
    @Inject(KERNEL_BUS) readonly bus: ExtensionContext["bus"],
    @Inject(REDIS) readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    @Inject(KERNEL_LOGGER) readonly log: Pick<KernelLogger, "info" | "warn">,
    @Inject(DialInAccess) access: Pick<DialInAccess, "serveStreams">,
  ) {
    // ctx.dialIn.openStream on this process reaches the sockets this gateway holds
    access.serveStreams(this);
  }

  /**
   * This replica's internal origin for device stream hops: `gateway.internalUrl`, else
   * `http://<hostname>:<http.port>` (with `http.port` 0, the port the connection arrived on).
   */
  internalAddress(localPort?: number): string {
    const c = this.config.get();
    if (c.gateway.internalUrl !== undefined) return c.gateway.internalUrl.replace(/\/+$/, "");
    const port = c.http.port !== 0 ? c.http.port : (localPort ?? 0);
    return `http://${hostname()}:${port}`;
  }

  /** The connection of `deviceId` this replica holds and serves, if any. */
  private serving(deviceId: string): DeviceConnection | undefined {
    for (const c of this.connections) if (c.deviceId === deviceId && c.serving) return c;
    return undefined;
  }

  /** Whether this replica holds `deviceId`'s machine socket (past `ready`). */
  holdsLocally(deviceId: string): boolean {
    return this.serving(deviceId) !== undefined;
  }

  /**
   * The internal address of the gateway replica holding `deviceId`'s machine
   * (`capk:device-holder-addr:<deviceId>`, read under the current lease token), or null when no
   * replica holds it or its holder has not recorded its address yet.
   */
  async holderAddress(deviceId: string): Promise<string | null> {
    const r = await this.redis.eval(
      READ_ADDR,
      2,
      deviceLeaseKey(deviceId),
      deviceHolderAddrKey(deviceId),
    );
    return typeof r === "string" ? r : null;
  }

  /**
   * Opens a stream to `deviceId`'s machine over the socket this replica holds
   * ({@link DialInStreams}). Throws `DialInStreamElsewhereError` when another replica holds it
   * (hop to {@link holderAddress}), `DeviceOfflineError` when none does.
   */
  async openStream(deviceId: string, body: unknown, signal: AbortSignal): Promise<DeviceStream> {
    const conn = this.serving(deviceId);
    if (conn !== undefined) return conn.openStream(body, signal);
    const holder = await this.redis.get(deviceLeaseKey(deviceId));
    // a connection of this replica still claiming or before ready is not elsewhere
    const mine = [...this.connections].some((c) => c.token === holder);
    if (holder !== null && !mine) throw new DialInStreamElsewhereError(deviceId);
    throw new DeviceOfflineError(deviceId);
  }

  graceMs(): number {
    return this.config.get().devices.dialIn.reconnectGraceSeconds * 1000;
  }

  leaseTtlMs(): number {
    return this.config.get().devices.dialIn.leaseTtlMs;
  }

  maxFrameBytes(): number {
    return this.config.get().devices.dialIn.maxFrameBytes;
  }

  /**
   * Who a `Bearer` machine credential stands for and the provider serving its device (checked
   * before the upgrade): null for an unknown or revoked credential.
   */
  async admit(credential: string): Promise<DialInAdmission> {
    // the credential names the device and its org: looked up before any org is known
    return asPlatform("dial-in credential lookup", () => this.admitted(credential));
  }

  private async admitted(credential: string): Promise<DialInAdmission> {
    const identity = await this.machines.authenticate(credential);
    if (identity === null) return null;
    const serving = await this.handlers.forDevice(identity.deviceId);
    return "unavailable" in serving
      ? { identity, unavailable: serving.unavailable }
      : { identity, serving };
  }

  /**
   * Serves one upgraded socket of a machine until it closes, speaking `protocol` (the route
   * admitted it). The credential and the provider are checked again here, with the socket paused,
   * so a credential revoked or a provider switched off since the upgrade check never gets a
   * connection.
   */
  async accept(
    socket: WebSocket,
    credential: string,
    protocol: string,
    localPort?: number,
  ): Promise<void> {
    socket.pause();
    try {
      if (this.stopping) {
        socket.close(DEVICE_CLOSE.shutdown, "shutting down");
        return;
      }
      const admission = await this.admit(credential);
      if (socket.readyState !== socket.OPEN) return;
      if (this.stopping) {
        socket.close(DEVICE_CLOSE.shutdown, "shutting down");
        return;
      }
      if (!admission) {
        socket.close(DEVICE_CLOSE.revoked, "Reconnect with a current credential");
        return;
      }
      if (
        !("serving" in admission) ||
        admission.serving.protocol !== protocol ||
        !DIAL_IN_PROTOCOL_RE.test(protocol)
      ) {
        socket.close(DEVICE_CLOSE.protocol, "the device's provider is unavailable");
        return;
      }
      const conn = new DeviceConnection(
        this,
        socket,
        admission.identity,
        credential,
        protocol,
        localPort,
      );
      this.connections.add(conn);
      conn.start();
    } catch (error) {
      this.log.warn("could not authenticate a device connection", { error: errMsg(error) });
      socket.close(DEVICE_CLOSE.internal, "Authentication unavailable; reconnect");
    } finally {
      socket.resume();
    }
  }

  /**
   * How many devices this process holds the connection of (replica presence reports it): only
   * sockets past the hello that hold their device's lease, so a socket still claiming or being
   * replaced by a newer one does not count a device twice.
   */
  connectionCount(): number {
    let n = 0;
    for (const c of this.connections) if (c.state === "holding") n++;
    return n;
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
