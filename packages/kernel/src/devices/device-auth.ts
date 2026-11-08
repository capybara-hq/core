import { randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { EnvironmentsService } from "../environments/environments.service.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { sha256Hex } from "../identity/hash.js";
import type { UserPrincipal } from "../identity/principal.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { afterCommit } from "../infra/database/after-commit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { authorizeOrgAction } from "../orgs/org.guard.js";
import { DEVICE_PROVIDER } from "../sandbox/providers.js";
import { environmentNotFound } from "../sandbox/sandbox.service.js";
import { MachinesService } from "./machines.js";

/** The 20 consonants a user code is made of (no vowels: no words; no look-alike letters). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;
const DEVICE_CODE_PREFIX = "cap_dvc_";
const DEVICE_CODE_RE = /^cap_dvc_[A-Za-z0-9_-]{43}$/;
/** What `slow_down` adds to the poll interval (RFC 8628 §3.5). */
export const SLOW_DOWN_STEP_SECONDS = 5;
/** Polls this much earlier than the interval are still on time (network jitter). */
const POLL_JITTER_MS = 500;
/** The web page that confirms a code: `<http.publicUrl>/device`. */
export const DEVICE_PAGE_PATH = "/device";
/** The machine's WebSocket route: `ws(s)://<http.publicUrl host>/device/connect`. */
export const DEVICE_CONNECT_PATH = "/device/connect";

/** The sign-in state of one device code: `capk:device-auth:<sha256(deviceCode)>` (a hash). */
export const deviceAuthKey = (deviceCode: string): string => authKeyOf(sha256Hex(deviceCode));
const authKeyOf = (deviceCodeHash: string) => `capk:device-auth:${deviceCodeHash}`;
/** The user code's pointer to its device code's hash: `capk:device-user:<XXXX-XXXX>`. */
export const deviceUserKey = (userCode: string): string => `capk:device-user:${userCode}`;

/**
 * The poll (`ARGV[1]` now in ms, `ARGV[2]` jitter ms, `ARGV[3]` slow-down step s). Missing →
 * `expired`. Earlier than the interval → `slow_down` with the grown interval. Approved → the
 * parked grant, and the code is deleted (get-and-delete: the credential is handed out once).
 * Otherwise the status (`pending`, `claimed`, `denied`). Every poll records its time.
 */
const POLL = `
if redis.call('EXISTS', KEYS[1]) == 0 then return {'expired'} end
local now = tonumber(ARGV[1])
local interval = tonumber(redis.call('HGET', KEYS[1], 'interval'))
local last = redis.call('HGET', KEYS[1], 'lastPollAt')
redis.call('HSET', KEYS[1], 'lastPollAt', ARGV[1])
if last and now - tonumber(last) < interval * 1000 - tonumber(ARGV[2]) then
  interval = interval + tonumber(ARGV[3])
  redis.call('HSET', KEYS[1], 'interval', interval)
  return {'slow_down', tostring(interval)}
end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'approved' then
  local grant = redis.call('HGET', KEYS[1], 'grant')
  redis.call('DEL', KEYS[1])
  return {'approved', grant}
end
return {status}
`;

/** Writes the user code's pointer (`ARGV[1]`, TTL `ARGV[2]` s) unless the code is in use. */
const CREATE_POINTER = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/** Moves the status from `ARGV[1]` to `ARGV[2]` (setting field `ARGV[3]` to `ARGV[4]` if given). */
const TRANSITION = `
if redis.call('HGET', KEYS[1], 'status') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
if ARGV[3] then redis.call('HSET', KEYS[1], ARGV[3], ARGV[4]) end
return 1
`;

/** The machine as `authorize` described it. */
export interface DeviceMachineInfo {
  name: string;
  os: "darwin" | "linux";
  arch: string;
  programVersion: string;
}

interface CodeInfo {
  machine: DeviceMachineInfo;
  userCode: string;
  expiresAt: string;
}

interface Grant {
  credential: string;
  orgId: string;
  environmentId: string;
}

/**
 * `pending`: waiting for the person; `claimed`: a confirmation is writing the machine (polls see
 * it as pending; a failed confirmation puts it back); `approved`: the credential is parked;
 * `denied`.
 */
type Status = "pending" | "claimed" | "approved" | "denied";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresIn: number;
}

export interface DeviceGrant extends Grant {
  connectUrl: string;
  reconnectGraceSeconds: number;
}

const codeInvalid = () =>
  new ApiError(
    "device.code_invalid",
    "This code is unknown or has expired; check the code shown by capybara-device, or run capybara-device login again",
  );

/** A user code as typed → `XXXX-XXXX`, or null when it cannot be one. */
export function normalizeUserCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== USER_CODE_LENGTH) return null;
  for (const c of s) if (!USER_CODE_ALPHABET.includes(c)) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A uniformly random user code (rejection sampling keeps every letter equally likely). */
function newUserCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < USER_CODE_LENGTH) {
    for (const b of randomBytes(USER_CODE_LENGTH * 2)) {
      if (b < limit && out.length < USER_CODE_LENGTH) out += USER_CODE_ALPHABET[b % n];
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Device authorization (environments spec §6.2, §13.3; the shape of RFC 8628). The program asks
 * for a code pair (`authorize`), the signed-in person confirms the user code on the web page
 * `/device` (`pending`, `confirm` or `deny`), and the program polls `token` until it gets the
 * machine credential, once. State lives only in Redis, both keys with the code's TTL
 * (`environments.device.authCodeTtlSeconds`): `capk:device-auth:<sha256(deviceCode)>` (a hash:
 * `info` JSON, `status`, `interval`, `lastPollAt`, the parked `grant`) and
 * `capk:device-user:<userCode>` → the device code's hash. The device code itself is never stored.
 */
@Injectable()
export class DeviceAuthService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(EnvironmentsService)
    private readonly environments: Pick<EnvironmentsService, "createDevice">,
    @Inject(MachinesService) private readonly machines: Pick<MachinesService, "issue">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
  ) {}

  /** A new code pair for a machine. Needs `http.publicUrl` (the page and the connection URL). */
  async authorize(machine: DeviceMachineInfo): Promise<DeviceAuthorization> {
    const web = this.publicUrl();
    const { authCodeTtlSeconds: ttl, pollIntervalSeconds: interval } =
      this.config.get().environments.device;
    const deviceCode = DEVICE_CODE_PREFIX + randomBytes(32).toString("base64url");
    const hash = sha256Hex(deviceCode);
    for (let attempt = 0; ; attempt++) {
      const userCode = newUserCode();
      // the pointer first: a user code is never shared by two device codes
      const free = await this.redis.eval(CREATE_POINTER, 1, deviceUserKey(userCode), hash, ttl);
      if (free !== 1) {
        if (attempt >= 4) throw new Error("could not find a free device user code");
        continue;
      }
      const info: CodeInfo = {
        machine,
        userCode,
        expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      };
      await this.redis
        .multi()
        .hset(authKeyOf(hash), {
          info: JSON.stringify(info),
          status: "pending" satisfies Status,
          interval: String(interval),
        })
        .expire(authKeyOf(hash), ttl)
        .exec();
      return {
        deviceCode,
        userCode,
        verificationUri: `${web}${DEVICE_PAGE_PATH}`,
        verificationUriComplete: `${web}${DEVICE_PAGE_PATH}?code=${userCode}`,
        interval,
        expiresIn: ttl,
      };
    }
  }

  /**
   * The program's poll: the grant once the person confirmed (the code is consumed), else
   * `device.authorization_pending`, `device.slow_down` (details `[{ interval }]`, the grown
   * interval), `device.denied` or `device.expired` (also for an unknown code).
   */
  async token(deviceCode: string): Promise<DeviceGrant> {
    const connectUrl = this.connectUrl();
    if (!DEVICE_CODE_RE.test(deviceCode)) throw expired();
    const r = (await this.redis.eval(
      POLL,
      1,
      deviceAuthKey(deviceCode),
      String(Date.now()),
      String(POLL_JITTER_MS),
      String(SLOW_DOWN_STEP_SECONDS),
    )) as [string, string?];
    switch (r[0]) {
      case "approved": {
        const grant = JSON.parse(r[1] as string) as Grant;
        return {
          ...grant,
          connectUrl,
          reconnectGraceSeconds: this.config.get().environments.device.reconnectGraceSeconds,
        };
      }
      case "slow_down":
        throw new ApiError(
          "device.slow_down",
          `Polling too fast; wait ${r[1]} seconds between polls`,
          [{ interval: Number(r[1]) }],
        );
      case "denied":
        throw new ApiError("device.denied", "The sign-in was denied in the browser");
      case "pending":
      case "claimed":
        throw new ApiError(
          "device.authorization_pending",
          "Waiting for the code to be confirmed in the browser",
        );
      default:
        throw expired();
    }
  }

  /** The machine waiting behind a user code, for the confirmation page. */
  async pending(userCode: string): Promise<{ machine: DeviceMachineInfo; expiresAt: string }> {
    const { info } = await this.lookup(userCode, "pending");
    return { machine: info.machine, expiresAt: info.expiresAt };
  }

  /**
   * The person confirms a user code: in an org where they may use agents (`agents.use`), into
   * one of their own live device environments or a new one named `name` (` 2`, ` 3`, … appended
   * while the name is taken). One transaction creates the environment if needed, issues the
   * machine (revoking the environment's previous one) and audits
   * `environment.machine_connected`; after the commit the credential is parked for the poll.
   * The code is claimed first, so two confirmations of one code cannot both issue a machine; a
   * failed confirmation leaves it pending.
   */
  async confirm(
    principal: UserPrincipal,
    input: {
      userCode: string;
      orgId: string;
      environmentId?: string | undefined;
      name?: string | undefined;
    },
  ): Promise<{ environmentId: string }> {
    await authorizeOrgAction(this.db.db, principal, input.orgId, "agents.use");
    const { info, hash } = await this.lookup(input.userCode, "pending");
    if (!(await this.transition(hash, "pending", "claimed"))) throw codeInvalid();
    try {
      return await this.confirmIn(principal.account.id, input, info, hash);
    } catch (e) {
      await this.transition(hash, "claimed", "pending").catch(() => undefined);
      throw e;
    }
  }

  /** The person refuses a user code: the program's next poll gets `device.denied`. */
  async deny(userCode: string): Promise<void> {
    const { info, hash } = await this.lookup(userCode, "pending");
    if (!(await this.transition(hash, "pending", "denied"))) throw codeInvalid();
    await this.redis.del(deviceUserKey(info.userCode));
  }

  @Transactional()
  private async confirmIn(
    accountId: string,
    input: { orgId: string; environmentId?: string | undefined; name?: string | undefined },
    info: CodeInfo,
    hash: string,
  ): Promise<{ environmentId: string }> {
    const { orgId } = input;
    let environmentId: string;
    if (input.name !== undefined) {
      const name = await this.freeName(orgId, accountId, input.name);
      environmentId = (await this.environments.createDevice(orgId, accountId, name)).id;
    } else {
      const env = await this.db
        .selectFrom("environments")
        .select("id")
        .where("id", "=", input.environmentId as string)
        .where("org_id", "=", orgId)
        .where("owner_kind", "=", "personal")
        .where("owner_account_id", "=", accountId)
        .where("source", "=", "device")
        .where("provider", "=", DEVICE_PROVIDER)
        .where("deleted_at", "is", null)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!env) throw environmentNotFound();
      environmentId = env.id;
    }
    const { machine } = info;
    const { machineId, credential } = await this.machines.issue({
      orgId,
      environmentId,
      accountId,
      ...machine,
    });
    await audit(this.db.db, {
      actorAccountId: accountId,
      orgId,
      action: "environment.machine_connected",
      target: environmentId,
      detail: { machineId, ...machine },
    });
    const grant: Grant = { credential, orgId, environmentId };
    afterCommit(async () => {
      if (!(await this.transition(hash, "claimed", "approved", JSON.stringify(grant)))) {
        // the code expired meanwhile: the machine row stays unused until a new login replaces it
        this.log.warn("device code expired before its credential was parked", {
          environmentId,
          machineId,
        });
      }
      await this.redis.del(deviceUserKey(info.userCode));
    });
    return { environmentId };
  }

  /** `name`, or `name 2`, `name 3`, … : the first that is none of the person's live names. */
  private async freeName(orgId: string, accountId: string, name: string): Promise<string> {
    const taken = new Set(
      (
        await this.db
          .selectFrom("environments")
          .select("name")
          .where("org_id", "=", orgId)
          .where("owner_account_id", "=", accountId)
          .where("deleted_at", "is", null)
          .where("name", "is not", null)
          .execute()
      ).map((r) => (r.name as string).toLowerCase()),
    );
    let candidate = name;
    for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
      const suffix = ` ${n}`;
      candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
    }
    return candidate;
  }

  /** The code behind a user code with status `status`, else `device.code_invalid`. */
  private async lookup(
    userCode: string,
    status: Status,
  ): Promise<{ info: CodeInfo; hash: string }> {
    const code = normalizeUserCode(userCode);
    if (code === null) throw codeInvalid();
    const hash = await this.redis.get(deviceUserKey(code));
    if (hash === null) throw codeInvalid();
    const [info, current] = await this.redis.hmget(authKeyOf(hash), "info", "status");
    if (info === null || info === undefined || current !== status) throw codeInvalid();
    return { info: JSON.parse(info) as CodeInfo, hash };
  }

  private async transition(
    hash: string,
    from: Status,
    to: Status,
    grant?: string,
  ): Promise<boolean> {
    const args = grant === undefined ? [from, to] : [from, to, "grant", grant];
    return (await this.redis.eval(TRANSITION, 1, authKeyOf(hash), ...args)) === 1;
  }

  /** `http.publicUrl` without trailing slashes; unset → `environment.unavailable`. */
  private publicUrl(): string {
    const url = this.config.get().http.publicUrl;
    if (!url) {
      throw new ApiError(
        "environment.unavailable",
        "Connecting machines needs http.publicUrl to be configured; ask the super admin",
      );
    }
    return url.replace(/\/+$/, "");
  }

  /** The machine's WebSocket URL: the public URL with `ws` / `wss` and `/device/connect`. */
  private connectUrl(): string {
    return `${this.publicUrl().replace(/^http/i, "ws")}${DEVICE_CONNECT_PATH}`;
  }
}

const expired = () =>
  new ApiError(
    "device.expired",
    "This sign-in code has expired or was already used; run capybara-device login again",
  );
