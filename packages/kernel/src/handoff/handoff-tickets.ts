import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { REDIS } from "../infra/tokens.js";
import { publicUrlRequired } from "../tools/oauth/flow-paths.js";
import { HANDOFF_PAGE_PATH, type HandoffRecord } from "./handoff-paths.js";

export { HANDOFF_DONE_PATH, type HandoffRecord, handoffDonePath } from "./handoff-paths.js";

/** A ticket's lifetime (seconds): the same as the OAuth state and the app sign-in attempt. */
export const HANDOFF_TTL_SECONDS = 600;

/** The `cap_` prefix keeps the ticket masked in logged paths and queries. */
const TICKET_PREFIX = "cap_ho_";
const TICKET_RE = /^cap_ho_[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
/** Redis holds only the ticket's hash: reading Redis gives no usable ticket. */
const ticketKey = (ticket: string) => `capk:handoff:${sha256(ticket)}`;

/**
 * Browser handoff tickets (shell external authorization spec §1): a native shell's start stores
 * what it checked and gets a single-use ticket for the web page `/handoff/<ticket>`, which the
 * person opens in the system browser. 32 random bytes, stored hashed in Redis for 10 minutes,
 * taken with GETDEL (one redeem wins across replicas). Nothing lives in process memory.
 */
@Injectable()
export class HandoffTickets {
  constructor(
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "getdel">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
  ) {}

  /** Stores the record and returns its ticket. */
  async create(rec: HandoffRecord): Promise<string> {
    const ticket = `${TICKET_PREFIX}${randomBytes(32).toString("base64url")}`;
    await this.redis.set(ticketKey(ticket), JSON.stringify(rec), "EX", HANDOFF_TTL_SECONDS);
    return ticket;
  }

  /** Takes the ticket's record and deletes it in one step; null when malformed, unknown or used. */
  async take(ticket: string): Promise<HandoffRecord | null> {
    if (!TICKET_RE.test(ticket)) return null;
    const raw = await this.redis.getdel(ticketKey(ticket));
    return raw === null ? null : (JSON.parse(raw) as HandoffRecord);
  }

  /** The web page that redeems the ticket; needs `http.publicUrl`. */
  url(ticket: string): string {
    const publicUrl = this.config.get().http.publicUrl;
    if (!publicUrl) throw publicUrlRequired();
    return `${publicUrl.replace(/\/+$/, "")}${HANDOFF_PAGE_PATH}/${ticket}`;
  }
}

@Module({ providers: [HandoffTickets], exports: [HandoffTickets] })
export class HandoffTicketsModule {}
