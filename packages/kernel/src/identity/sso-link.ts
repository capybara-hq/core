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
 * Reserves one password attempt, atomically, before the password is checked: the pending link (a
 * hash `rec` + `attempts`) gains an attempt, which keeps its TTL. Returns 1 when reserved, 0 when
 * the link is gone or its attempts are all taken (the reservation is undone), so concurrent
 * submissions never check more than the limit of passwords.
 */
const RESERVE_ATTEMPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if n > tonumber(ARGV[1]) then redis.call('HINCRBY', KEYS[1], 'attempts', -1); return 0 end
return 1`;

/** Gives a reserved attempt back (the password was not wrong: a disabled account, a rate limit). */
const REFUND_ATTEMPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0') > 0 then
  redis.call('HINCRBY', KEYS[1], 'attempts', -1)
end
return 1`;

/** A reserved attempt was a wrong password: at the limit the link is deleted (burned). */
const SETTLE_FAILURE = `
local n = tonumber(redis.call('HGET', KEYS[1], 'attempts') or '0')
if n >= tonumber(ARGV[1]) then redis.call('DEL', KEYS[1]) end
return n`;

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
 * after {@link SSO_LINK_MAX_ATTEMPTS} wrong passwords (an attempt is reserved atomically before
 * each password check, {@link reserveAttempt}, on the same key, which keeps its TTL). All state is
 * in Redis: any replica serves any step.
 *
 * Deployment assumption: no sibling origin can set cookies for the kernel's host (no untrusted
 * subdomain sharing a parent domain cookie scope), so the `cap_sso` binding value is this
 * browser's own and cannot be planted to tie a victim's browser to an attacker's ticket.
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

  /**
   * Reserves one of the ticket's attempts before a password check; none left, or the ticket gone →
   * `sso.link_expired`.
   */
  async reserveAttempt(ticket: string): Promise<void> {
    if (!TICKET_RE.test(ticket)) throw linkExpired();
    const ok = await this.redis.eval(
      RESERVE_ATTEMPT,
      1,
      ticketKey(ticket),
      String(SSO_LINK_MAX_ATTEMPTS),
    );
    if (ok !== 1) throw linkExpired();
  }

  /** Gives a reserved attempt back (the check did not find a wrong password). */
  async refundAttempt(ticket: string): Promise<void> {
    if (TICKET_RE.test(ticket)) await this.redis.eval(REFUND_ATTEMPT, 1, ticketKey(ticket));
  }

  /** The reserved attempt was a wrong password; the one that reaches the limit burns the ticket. */
  async failedAttempt(ticket: string): Promise<void> {
    if (!TICKET_RE.test(ticket)) return;
    await this.redis.eval(SETTLE_FAILURE, 1, ticketKey(ticket), String(SSO_LINK_MAX_ATTEMPTS));
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
