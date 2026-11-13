import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { KernelConfig } from "../config/schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { readOrgSettings } from "../orgs/settings.service.js";

/**
 * Run tickets of the git gateway (sandbox git credentials spec §4, §5.1, §9): an opaque bearer
 * value one exec gets in its environment, bound to one run and one person. Only the SHA-256 of
 * the ticket is stored (Redis `git-ticket:<hash>` → the JSON binding, TTL
 * `tools.git.ticketTtlSeconds`); the run's set `git-run-tickets:<runId>` lists the hashes for
 * revocation. The raw ticket is never stored or logged: logs carry the first 8 hex characters of
 * its hash. Every resolve re-checks the run, the membership and the switches live, so nothing is
 * cached in process memory (any replica resolves what another issued).
 */

/** What a ticket is issued for. */
export interface GitTicketRequest {
  orgId: string;
  /** The actor: the account the exec runs for (the run's trigger account). */
  accountId: string;
  runId: string;
  execId: string;
  /** The git hosts the ticket may reach (from the org's git sources), e.g. `github.com`. */
  hosts: string[];
  /** Optional repository allowlist (`owner/name`); absent = every repository on the hosts. */
  repos?: string[];
}

/** A ticket's stored binding. */
export interface GitTicketBinding extends GitTicketRequest {
  /** When the ticket was issued (epoch ms). */
  issuedAt: number;
}

const BindingSchema = z.object({
  orgId: z.string().min(1),
  accountId: z.string().min(1),
  runId: z.string().min(1),
  execId: z.string().min(1),
  hosts: z.array(z.string()),
  repos: z.array(z.string()).optional(),
  issuedAt: z.number(),
});

/** Run statuses during which the run's tickets stay valid. */
const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting"] as const;

/** A raw ticket: 32 random bytes in base64url (43 characters, no padding). */
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The Redis key of a ticket's binding. */
export const gitTicketKey = (hash: string): string => `git-ticket:${hash}`;

/** The Redis set of a run's ticket hashes. */
export const gitRunTicketsKey = (runId: string): string => `git-run-tickets:${runId}`;

/** The SHA-256 (hex) of a raw ticket: the only form the kernel stores. */
export const hashGitTicket = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

/**
 * The origin sandboxes reach the git gateway at: `tools.git.gatewayUrl`, else `http.publicUrl`;
 * null when neither is set (the gateway cannot be offered).
 */
export function gitGatewayOrigin(config: Pick<KernelConfig, "tools" | "http">): string | null {
  const url = config.tools.git.gatewayUrl ?? config.http.publicUrl;
  if (url === undefined || !URL.canParse(url)) return null;
  return new URL(url).origin;
}

@Injectable()
export class GitTickets {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelDb) private readonly db: KernelDb,
    /** Read per call: `tools.git.enabled` is hot. */
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "debug">,
  ) {}

  /**
   * Issues a ticket for one exec and returns the raw value (it goes only into that exec's
   * environment). Stores the binding under the ticket's hash and adds the hash to the run's set,
   * the ticket with the ticket TTL, the set with the longest TTL any of its tickets got.
   */
  async issue(req: GitTicketRequest): Promise<string> {
    const raw = randomBytes(32).toString("base64url");
    const hash = hashGitTicket(raw);
    const ttl = this.config.get().tools.git.ticketTtlSeconds;
    const binding: GitTicketBinding = {
      orgId: req.orgId,
      accountId: req.accountId,
      runId: req.runId,
      execId: req.execId,
      hosts: [...req.hosts],
      ...(req.repos !== undefined && { repos: [...req.repos] }),
      issuedAt: Date.now(),
    };
    try {
      await this.redis.eval(
        ISSUE,
        2,
        gitTicketKey(hash),
        gitRunTicketsKey(req.runId),
        JSON.stringify(binding),
        String(ttl),
        hash,
      );
    } catch {
      // a ticket whose binding or revocation entry was not written must not be handed out
      // (the script lists the ticket first, so a failure leaves no binding behind)
      throw new Error("git ticket: storing the binding in Redis failed");
    }
    this.log.debug("git ticket issued", {
      ticket: hash.slice(0, 8),
      runId: req.runId,
      execId: req.execId,
    });
    return raw;
  }

  /**
   * The binding of a raw ticket, or null: unknown or expired, or no longer usable because the run
   * is not active (or belongs to another org), the account is not an active member of the org, or
   * the gateway is off (`tools.git.enabled`, the org's `gitGateway.enabled`). Every check is live.
   */
  async resolve(raw: string): Promise<GitTicketBinding | null> {
    if (!TICKET_SHAPE.test(raw)) return null;
    const hash = hashGitTicket(raw);
    const refuse = (reason: string): null => {
      this.log.debug("git ticket refused", { ticket: hash.slice(0, 8), reason });
      return null;
    };
    if (!this.config.get().tools.git.enabled) return refuse("gateway disabled");
    const stored = await this.redis.get(gitTicketKey(hash));
    if (stored === null) return refuse("unknown or expired");
    const binding = parseBinding(stored);
    if (binding === null) return refuse("invalid binding");

    const run = await this.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .innerJoin("orgs", "orgs.id", "conversations.org_id")
      .select(["runs.status", "conversations.org_id"])
      .where("runs.id", "=", binding.runId)
      .where("orgs.deleted_at", "is", null)
      .executeTakeFirst();
    if (run === undefined || run.org_id !== binding.orgId) return refuse("run not in org");
    if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return refuse("run not active");
    }

    const member = await this.db
      .selectFrom("memberships")
      .innerJoin("accounts", "accounts.id", "memberships.account_id")
      .select("memberships.account_id")
      .where("memberships.org_id", "=", binding.orgId)
      .where("memberships.account_id", "=", binding.accountId)
      .where("accounts.status", "=", "active")
      .executeTakeFirst();
    if (member === undefined) return refuse("not an active member");

    const settings = await readOrgSettings(this.db.db, binding.orgId);
    if (settings.gitGateway?.enabled === false) return refuse("gateway off for the org");
    return binding;
  }

  /**
   * Deletes every ticket of the run (run end, abort, offboarding) in one Lua script, so a ticket
   * added concurrently is either deleted with the rest or left in a set that still lists it.
   */
  async revokeRun(runId: string): Promise<void> {
    const count = await this.redis.eval(REVOKE_RUN, 1, gitRunTicketsKey(runId), TICKET_KEY_PREFIX);
    if (typeof count === "number" && count > 0) {
      this.log.debug("git tickets revoked", { runId, count });
    }
  }
}

/**
 * Both scripts below build ticket keys from {@link TICKET_KEY_PREFIX} instead of declaring them in
 * KEYS, so they assume a non-Cluster Redis / Valkey (one node, or Sentinel).
 */
const TICKET_KEY_PREFIX = "git-ticket:";

/**
 * Lists the ticket in the run's set, stores its binding with the TTL and gives the set a TTL that
 * only grows (KEYS: ticket, run set; ARGV: binding, ttl, hash): lowering `ticketTtlSeconds` must
 * not cut the set below a live ticket.
 */
const ISSUE = `
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
if redis.call('TTL', KEYS[2]) < tonumber(ARGV[2]) then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
return 1
`;

/** Reads the run's set, deletes every listed ticket and the set (KEYS[1]; ARGV[1] the ticket key prefix). */
const REVOKE_RUN = `
local hashes = redis.call('SMEMBERS', KEYS[1])
for _, h in ipairs(hashes) do redis.call('DEL', ARGV[1] .. h) end
redis.call('DEL', KEYS[1])
return #hashes
`;

function parseBinding(stored: string): GitTicketBinding | null {
  try {
    const r = BindingSchema.safeParse(JSON.parse(stored));
    if (!r.success) return null;
    const { repos, ...rest } = r.data;
    return { ...rest, ...(repos !== undefined && { repos }) };
  } catch {
    return null;
  }
}
