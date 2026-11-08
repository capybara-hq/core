import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** The counting window of every credential throttler, ms (first attempt starts it). */
export const CREDENTIAL_WINDOW_MS = 900_000;

/** A named throttler: a limit over a tracker, answering 429 `auth.rate_limited` with `message`. */
export interface NamedThrottler {
  name: string;
  limit: number;
  ttl: number;
  /** The 429 message (today's text of the route that used the limiter). */
  message: string;
  /** The credential group: throttlers of one group are reserved together (one Redis hash tag). */
  group: string;
  /** What a successful attempt does to this counter: delete it, or give one attempt back. */
  onSuccess: "clear" | "refund";
  getTracker: (req: FastifyRequest) => string;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Logins are normalized the way local accounts are (no format check): case / space variants share a count. */
const loginHash = (login: string) => sha256(login.normalize("NFKC").trim().toLowerCase());

const bodyLogin = (req: FastifyRequest): string => {
  const b = req.body;
  const login = typeof b === "object" && b !== null ? (b as { login?: unknown }).login : undefined;
  return typeof login === "string" ? login : "";
};

/** The client address: Fastify's `request.ip`, which already honors `http.trustProxy`. */
const ip = (req: FastifyRequest) => req.ip;

const principalAccountId = (req: FastifyRequest): string => {
  const p = (req as { principal?: { account?: { id?: string } } }).principal;
  return p?.account?.id ?? "";
};

const routeToken = (req: FastifyRequest): string =>
  String((req.params as { token?: unknown } | undefined)?.token ?? "");

const LOGIN_MSG = "Too many failed login attempts; try again later";

/**
 * Every rate limit of the kernel today, as named throttlers (spec §2.4). The credential routes
 * reserve theirs through `CredentialThrottler` inside the handler (one group per route, all or
 * nothing); a plain per-route limit would opt in with `@Throttled(...names)`.
 *
 * | route | names (reserved via `CredentialThrottler`) |
 * |---|---|
 * | `POST /api/v1/auth/login` | `login`, `login-ip`, `login-account` |
 * | `PUT /api/v1/me/password` | `change-password`, `change-password-ip` |
 * | `POST /api/v1/setup` | `setup-token`, `setup-ip` |
 * | `POST /api/v1/invitations/:token/accept` | `invitation`, `invitation-ip` |
 * | `GET /api/v1/device/pending/:userCode`, `POST /api/v1/device/confirm`, `POST /api/v1/device/deny` | `device-code-account` |
 *
 * `POST /api/v1/device/authorize` and `POST /api/v1/device/token` opt in to `device-authorize-ip`
 * and `device-token-ip` with `@Throttled` (every request counts; neither checks a guessable
 * credential: the device code is 32 random bytes).
 */
export const NAMED_THROTTLERS: readonly NamedThrottler[] = [
  // (login, IP): 10; an attacker filling one login from one IP leaves the owner's other IPs alone (R25)
  {
    name: "login",
    group: "login",
    onSuccess: "clear",
    limit: 10,
    ttl: CREDENTIAL_WINDOW_MS,
    message: LOGIN_MSG,
    getTracker: (req) => `${loginHash(bodyLogin(req))}:${sha256(ip(req))}`,
  },
  // client IP across logins (credential stuffing): 50
  {
    name: "login-ip",
    group: "login",
    onSuccess: "refund",
    limit: 50,
    ttl: CREDENTIAL_WINDOW_MS,
    message: LOGIN_MSG,
    getTracker: ip,
  },
  // one login across IPs (distributed guessing): 100
  {
    name: "login-account",
    group: "login",
    onSuccess: "clear",
    limit: 100,
    ttl: CREDENTIAL_WINDOW_MS,
    message: LOGIN_MSG,
    getTracker: (req) => loginHash(bodyLogin(req)),
  },
  {
    name: "change-password",
    group: "change-password",
    onSuccess: "clear",
    limit: 10,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many failed password attempts; try again later",
    getTracker: (req) => sha256(principalAccountId(req)),
  },
  {
    name: "change-password-ip",
    group: "change-password",
    onSuccess: "refund",
    limit: 50,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many failed password attempts; try again later",
    getTracker: ip,
  },
  {
    name: "setup-token",
    group: "setup",
    onSuccess: "clear",
    limit: 100,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many setup attempts; try again later",
    getTracker: () => sha256("token"),
  },
  {
    name: "setup-ip",
    group: "setup",
    onSuccess: "refund",
    limit: 10,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many setup attempts; try again later",
    getTracker: ip,
  },
  {
    name: "invitation",
    group: "invitation",
    onSuccess: "clear",
    limit: 10,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many invitation attempts; try again later",
    getTracker: (req) => sha256(routeToken(req)),
  },
  {
    name: "invitation-ip",
    group: "invitation",
    onSuccess: "refund",
    limit: 20,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many invitation attempts; try again later",
    getTracker: ip,
  },
  // device sign-in codes issued per client address (each one holds Redis state for its TTL): 20.
  // Opted in with @Throttled, which counts every request before the handler: group and onSuccess
  // are unused (they matter only to CredentialThrottler).
  {
    name: "device-authorize-ip",
    group: "device-authorize",
    onSuccess: "clear",
    limit: 20,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many device sign-in attempts; try again later",
    getTracker: ip,
  },
  // device token polls per client address (@Throttled like device-authorize-ip): 120, well above
  // one login's polls (600 s / 5 s) plus a few machines behind one address
  {
    name: "device-token-ip",
    group: "device-token",
    onSuccess: "clear",
    limit: 120,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many device sign-in polls; try again later",
    getTracker: ip,
  },
  // user codes tried per signed-in person (guessing another machine's code): 10, refunded on success
  {
    name: "device-code-account",
    group: "device-code",
    onSuccess: "refund",
    limit: 10,
    ttl: CREDENTIAL_WINDOW_MS,
    message: "Too many device code attempts; try again later",
    getTracker: (req) => sha256(principalAccountId(req)),
  },
];

/** The storage key of a named throttler's counter for a tracker (shared by the guard and success paths). */
export const throttlerKey = (name: string, tracker: string) => sha256(`${name}:${tracker}`);
