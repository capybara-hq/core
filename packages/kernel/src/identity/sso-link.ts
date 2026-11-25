import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ExternalIdentity } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ApiError } from "../errors.js";
import { REDIS } from "../infra/tokens.js";

/** A pending link's lifetime (seconds). */
export const SSO_LINK_TTL_SECONDS = 600;
/** Wrong passwords a ticket survives: the fifth burns it. */
export const SSO_LINK_MAX_ATTEMPTS = 5;
/** The web's link page (next-intl adds the language prefix). */
export const SSO_LINK_PAGE_PATH = "/login/link";

/** The `cap_` prefix keeps the ticket masked in logged paths and queries. */
const TICKET_PREFIX = "cap_link_";
const TICKET_RE = /^cap_link_[A-Za-z0-9_-]{43}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
/** Redis holds only the ticket's hash: reading Redis gives no usable ticket. */
const ticketKey = (ticket: string) => `capk:sso-link:${sha256(ticket)}`;

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * One wrong password, atomically: the pending link (a hash `rec` + `attempts`) gains an attempt,
 * which keeps its TTL; at the limit it is deleted. Returns -1 when the link is gone, 0 when this
 * attempt burned it, else the attempts left.
 */
const FAIL_ATTEMPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
local left = tonumber(ARGV[1]) - n
if left <= 0 then redis.call('DEL', KEYS[1]); return 0 end
return left`;

/** Takes the pending link and deletes it in one step (GETDEL on the hash): one caller wins. */
const REDEEM = `
local v = redis.call('HGET', KEYS[1], 'rec')
if v then redis.call('DEL', KEYS[1]) end
return v`;

/** A sign-in that chose the link page, waiting for the person's password (spec §5). */
export interface PendingSsoLink {
  plugin: string;
  /** The normalized external identity the identity source verified. */
  identity: ExternalIdentity;
  /** The site path to go to after linking. */
  returnTo: string;
  /** SHA-256 of the browser binding value (`cap_sso`) the sign-in was started with. */
  binding: string;
}

export const linkExpired = () =>
  new ApiError("sso.link_expired", "The link request expired or was already used");
const sessionMismatch = () =>
  new ApiError("sso.session_mismatch", "The sign-in was started in a different browser");

/**
 * Link tickets (spec §5): `cap_link_<32 bytes base64url>`, kept in Redis as a hash
 * `capk:sso-link:<sha256(ticket)>` (`rec`: the pending link as JSON, `attempts`) for 10 minutes.
 * Every read checks the browser binding cookie against the recorded hash. Single use on success
 * ({@link redeem} deletes it atomically, so two concurrent submissions get one winner), burned
 * after {@link SSO_LINK_MAX_ATTEMPTS} wrong passwords ({@link failedAttempt}, an atomic counter on
 * the same key that keeps its TTL). All state is in Redis: any replica serves any step.
 */
@Injectable()
export class SsoLinkTickets {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Stores a pending link and returns its ticket. */
  async create(link: PendingSsoLink): Promise<string> {
    const ticket = TICKET_PREFIX + randomBytes(32).toString("base64url");
    const key = ticketKey(ticket);
    await this.redis
      .multi()
      .hset(key, { rec: JSON.stringify(link), attempts: 0 })
      .expire(key, SSO_LINK_TTL_SECONDS)
      .exec();
    return ticket;
  }

  /**
   * The pending link of `ticket` without consuming it. Unknown, expired, used or burned →
   * `sso.link_expired`; a browser binding value that does not match → `sso.session_mismatch`.
   */
  async peek(ticket: string, binding: string | undefined): Promise<PendingSsoLink> {
    if (!TICKET_RE.test(ticket)) throw linkExpired();
    const raw = await this.redis.hget(ticketKey(ticket), "rec");
    if (raw === null) throw linkExpired();
    return checkBinding(JSON.parse(raw) as PendingSsoLink, binding);
  }

  /** Counts one wrong password; the attempt that reaches the limit deletes the ticket. */
  async failedAttempt(ticket: string): Promise<void> {
    if (!TICKET_RE.test(ticket)) return;
    await this.redis.eval(FAIL_ATTEMPT, 1, ticketKey(ticket), String(SSO_LINK_MAX_ATTEMPTS));
  }

  /**
   * Takes the pending link and deletes it in one step: of concurrent callers exactly one gets it,
   * the others `sso.link_expired`. The binding is checked again on the taken record.
   */
  async redeem(ticket: string, binding: string | undefined): Promise<PendingSsoLink> {
    if (!TICKET_RE.test(ticket)) throw linkExpired();
    const raw = (await this.redis.eval(REDEEM, 1, ticketKey(ticket))) as string | null;
    if (raw === null) throw linkExpired();
    return checkBinding(JSON.parse(raw) as PendingSsoLink, binding);
  }

  /** Deletes the ticket (its login source was switched off). */
  async discard(ticket: string): Promise<void> {
    if (TICKET_RE.test(ticket)) await this.redis.del(ticketKey(ticket));
  }
}

function checkBinding(link: PendingSsoLink, binding: string | undefined): PendingSsoLink {
  if (binding === undefined || !sameHash(sha256(binding), link.binding)) throw sessionMismatch();
  return link;
}
