import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { NetDeniedError } from "../net/public-address.js";
import { safeFetch } from "../net/safe-fetch.js";
import { normalizeGitRepo } from "../schedules/grant-rules.js";
import { appendMissingGrant } from "../schedules/unattended.js";
import { type ConnectorAuth, CredentialMissing, Credentials } from "../tools/credentials.js";
import {
  gitAskedNote,
  gitNotConnectedNote,
  gitPolicyDeniedNote,
  gitUnattendedNote,
  recordGitAsk,
} from "../tools/git-asks.js";
import { decideGitPush, type GitPushDecision } from "../tools/git-push-policy.js";
import { gitNetPolicy } from "./identity.js";
import {
  advertisementError,
  ReceivePackParseError,
  type RefCommand,
  readReceivePackCommands,
  receivePackRefusal,
} from "./pkt-line.js";
import { type GitSourceFor, GitSources } from "./sources.js";
import { type GitTicketBinding, GitTickets, hashGitTicket } from "./tickets.js";

/**
 * The git gateway (sandbox git credentials spec §5): relays git smart-HTTP from a sandbox to a git
 * host, authenticated by a run ticket, adding the actor's credential on the way out. Stateless
 * across replicas: the ticket, the source, the push policy, the byte and concurrency counters are
 * read from Redis / PG on every request; only the request's own idle timer lives in the process.
 *
 * The route (`/git/v1/<host>/<owner>/<repo>[.git]/<endpoint>`, {@link GIT_GATEWAY_PREFIX}) is a raw
 * Fastify route (`gateway.route.ts`), like the channel webhook: git sends no CSRF header and the
 * ticket is not an API credential, so neither the `AuthGuard` nor the API's error envelope apply.
 * Everything git shows is plain text or pkt-lines in English.
 */

/** The route prefix. */
export const GIT_GATEWAY_PREFIX = "/git/v1/";

/** The smart-HTTP services. */
export type GitService = "git-upload-pack" | "git-receive-pack";

/** A parsed gateway path. */
export interface GitGatewayTarget {
  host: string;
  /** `<owner>/<repo>` as written (validated), for the upstream URL. */
  path: string;
  /** `<owner>/<repo>` normalized (lower case, no `.git`), for policy and allowlists. */
  repo: string;
  /** `info/refs` (GET, with `service`) or the service endpoint itself (POST). */
  endpoint: "info/refs" | GitService;
  service: GitService;
}

/**
 * Test seam (`KernelAppOptions.overrides`): the upstream origin of a git host (default
 * `https://<host>`), e.g. a loopback fake for `github.com`. Production validation is unchanged:
 * the fake is reached through the same `safeFetch` rules (loopback http only under
 * `tools.oauthAllowInsecureLoopback`).
 */
export const GIT_UPSTREAM_ORIGIN = Symbol("GIT_UPSTREAM_ORIGIN");
export type GitUpstreamOrigin = (host: string) => string;

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
const SEGMENT_RE = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Parses `/git/v1/<host>/<owner>/<repo>[.git]/<endpoint>` with its query: GET `info/refs` with
 * `service=git-upload-pack|git-receive-pack` and nothing else in the query, or POST
 * `git-upload-pack` / `git-receive-pack` without a query. Anything else (dumb HTTP, other paths,
 * other methods) is null (404).
 */
export function parseGitGatewayPath(method: string, url: string): GitGatewayTarget | null {
  const q = url.indexOf("?");
  const pathname = q >= 0 ? url.slice(0, q) : url;
  const query = q >= 0 ? url.slice(q + 1) : "";
  if (!pathname.startsWith(GIT_GATEWAY_PREFIX)) return null;
  const parts = pathname.slice(GIT_GATEWAY_PREFIX.length).split("/");
  let endpoint: GitGatewayTarget["endpoint"];
  let service: GitService;
  let head: string[];
  if (parts.length === 5 && parts[3] === "info" && parts[4] === "refs") {
    if (method !== "GET") return null;
    const params = new URLSearchParams(query);
    const svc = params.get("service");
    if (
      [...params.keys()].length !== 1 ||
      (svc !== "git-upload-pack" && svc !== "git-receive-pack")
    ) {
      return null;
    }
    endpoint = "info/refs";
    service = svc;
    head = parts.slice(0, 3);
  } else if (
    parts.length === 4 &&
    (parts[3] === "git-upload-pack" || parts[3] === "git-receive-pack")
  ) {
    if (method !== "POST" || query !== "") return null;
    endpoint = parts[3];
    service = parts[3];
    head = parts.slice(0, 3);
  } else {
    return null;
  }
  const [host, owner, name] = head;
  if (host === undefined || owner === undefined || name === undefined) return null;
  if (!HOST_RE.test(host)) return null;
  if (!SEGMENT_RE.test(owner) || !SEGMENT_RE.test(name)) return null;
  const bare = name.replace(/\.git$/i, "");
  const repo = normalizeGitRepo(`${owner}/${bare}`);
  if (repo === null) return null;
  return { host, path: `${owner}/${bare}`, repo, endpoint, service };
}

/**
 * Whether the ticket's repository allowlist admits `repo` (normalized). Entries are
 * `<owner>/<repo>`, `<owner>/*` or `*`, compared case-insensitively; no list admits every one.
 */
export function repoAllowed(repos: readonly string[] | undefined, repo: string): boolean {
  if (repos === undefined) return true;
  return repos.some((entry) => {
    const e = entry
      .trim()
      .toLowerCase()
      .replace(/\.git$/, "");
    if (e === "*") return true;
    if (e.endsWith("/*")) return repo.startsWith(e.slice(0, -1));
    return e === repo;
  });
}

/** Request headers relayed upstream (spec §5.3); `user-agent` is suffixed. */
const FORWARD_REQUEST = ["content-type", "content-encoding", "accept", "git-protocol"] as const;
/**
 * Response headers relayed downstream. `content-encoding` is not among them: the fetch below
 * decodes compressed answers, so the bytes sent on are identity-encoded.
 */
const FORWARD_RESPONSE = ["content-type", "cache-control", "expires", "pragma"] as const;

/** The Redis counter of a run's relayed bytes. */
export const gitBytesKey = (runId: string) => `git-bytes:${runId}`;
/** The Redis counter of an org's open gateway requests. */
export const gitConcurrencyKey = (orgId: string) => `git-conc:${orgId}`;
/** The byte counter lives a day after the run's last transfer (runs end long before). */
const BYTES_TTL_SECONDS = 24 * 60 * 60;
/**
 * The concurrency counter's TTL, refreshed by every request: a replica that died holding slots
 * frees them at the latest this long after the org's last request.
 */
const CONCURRENCY_TTL_SECONDS = 15 * 60;
/** Bytes counted locally before they are added to the Redis counter. */
const BYTES_FLUSH = 256 * 1024;

/** Texts git prints (`remote: …`). */
const TICKET_REFUSED =
  "Capybara: the git ticket is not valid (expired, revoked, or the task has ended). Run the command again from the agent's task.";
const TOO_MANY =
  "Capybara: too many git transfers are running in this organization; try again shortly.";
const BYTES_EXCEEDED =
  "Capybara: this task reached its git transfer limit (tools.git.maxBytesPerRun).";
const reconnect = (host: string) =>
  `Capybara: ${host} refused the connection's credential. Reconnect it under Settings → Connectors, then run the command again.`;
const repoRefused = (repo: string) => `Capybara: this task may not use the repository ${repo}.`;
const upstreamFailed = (host: string, detail: string) =>
  `Capybara: the request to ${host} failed (${detail}).`;
const BAD_PUSH = (why: string) => `Capybara: the push could not be read (${why}).`;
const notConnected = (host: string) =>
  `Capybara: you have no connection that can reach ${host}. Connect one under Settings → Connectors, then run the command again.`;

/** The bytes of one request, added to the run's Redis counter in batches. */
class ByteMeter {
  private pending = 0;
  private total: number;
  /** Bytes this request moved (both ways). */
  moved = 0;
  /** The run went over its cap during this request. */
  exceeded = false;
  constructor(
    private readonly redis: Redis,
    private readonly key: string,
    private readonly cap: number,
    start: number,
  ) {
    this.total = start;
  }

  /** Counts `n` bytes; rejects once the run is over its cap. */
  async add(n: number): Promise<void> {
    this.pending += n;
    this.moved += n;
    if (this.pending >= BYTES_FLUSH) await this.flush();
    else if (this.total + this.pending > this.cap) await this.flush();
  }

  /** Adds the pending bytes to the counter; rejects when the run is over its cap. */
  async flush(): Promise<void> {
    if (this.pending === 0) return;
    const n = this.pending;
    this.pending = 0;
    const res = await this.redis
      .multi()
      .incrby(this.key, n)
      .expire(this.key, BYTES_TTL_SECONDS)
      .exec();
    const v = res?.[0]?.[1];
    this.total = typeof v === "number" ? v : this.total + n;
    if (this.total > this.cap) {
      this.exceeded = true;
      throw new GitBytesExceeded();
    }
  }
}

class GitBytesExceeded extends Error {
  constructor() {
    super("git transfer limit reached");
    this.name = "GitBytesExceeded";
  }
}

/** A pass-through that counts bytes and resets the idle timer (backpressure kept). */
function meterStream(meter: ByteMeter, touch: () => void): Transform {
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      touch();
      meter.add(chunk.length).then(
        () => done(null, chunk),
        (e: unknown) => done(e as Error),
      );
    },
    flush(done: TransformCallback) {
      meter.flush().then(
        () => done(),
        (e: unknown) => done(e as Error),
      );
    },
  });
}

/** What one request is logged with (never a ticket or a token). */
interface LogFields {
  ticket?: string;
  host?: string;
  repo?: string;
  service?: string;
  [k: string]: unknown;
}

@Injectable()
export class GitGateway {
  constructor(
    @Inject(GitTickets) private readonly tickets: Pick<GitTickets, "resolve">,
    @Inject(GitSources) private readonly sources: Pick<GitSources, "sourcesFor">,
    @Inject(Credentials)
    private readonly credentials: Pick<Credentials, "gitAuthorization" | "gitUnauthorized">,
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    /** Read per request: `tools.git.*` is read live. */
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn" | "debug">,
    @Optional() @Inject(GIT_UPSTREAM_ORIGIN) private readonly upstreamOrigin?: GitUpstreamOrigin,
  ) {}

  /** Handles one gateway request (the raw route's handler). */
  async handle(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const started = performance.now();
    const fields: LogFields = {};
    const body = req.body instanceof Readable ? req.body : undefined;
    const text = (status: number, message: string) => {
      body?.resume();
      fields.status = status;
      return reply
        .code(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-cache")
        .send(`${message}\n`);
    };

    const target = parseGitGatewayPath(req.method, req.url);
    if (target === null) return text(404, "Capybara: not a git smart-HTTP endpoint.");
    if (req.method === "POST" && contentTypeOf(req) !== `application/x-${target.service}-request`) {
      return text(404, "Capybara: not a git smart-HTTP endpoint.");
    }
    fields.host = target.host;
    fields.repo = target.repo;
    fields.service = target.service;

    const raw = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (raw !== undefined) fields.ticket = hashGitTicket(raw).slice(0, 8);
    const binding = raw === undefined ? null : await this.tickets.resolve(raw);
    // 403, not 401: on a 401 git asks for a username and never prints the message
    if (binding === null) return this.done(text(403, TICKET_REFUSED), fields, started);
    if (!binding.hosts.map((h) => h.toLowerCase()).includes(target.host)) {
      return this.done(text(404, "Capybara: not a git smart-HTTP endpoint."), fields, started);
    }
    if (!repoAllowed(binding.repos, target.repo)) {
      return this.done(text(403, repoRefused(target.repo)), fields, started);
    }
    // the source is looked up on every request (the ticket's hosts are only an upper bound)
    const source = (await this.sources.sourcesFor(binding.orgId, binding.accountId)).find(
      (s) => s.host === target.host,
    );
    if (source === undefined) {
      const message =
        target.service === "git-receive-pack"
          ? `Capybara: ${gitNotConnectedNote(target.host)}`
          : notConnected(target.host);
      return this.done(text(403, message), fields, started);
    }
    fields.connectorId = source.connectorId;

    const cfg = this.config.get().tools.git;
    const meterKey = gitBytesKey(binding.runId);
    const used = Number((await this.redis.get(meterKey)) ?? 0);
    if (used >= cfg.maxBytesPerRun) return this.done(text(403, BYTES_EXCEEDED), fields, started);

    const { inUse, release } = await this.acquireOrgSlot(binding.orgId);
    if (inUse > cfg.maxConcurrentPerOrg) {
      release();
      return this.done(text(429, TOO_MANY), fields, started);
    }
    reply.raw.once("close", release);
    try {
      await this.relay(req, reply, { target, binding, source, body, fields, used, text });
    } catch (e) {
      // anything unexpected before the answer started is a 502 git prints; after, the
      // connection is cut (git reports the transfer broke)
      this.log.warn("git gateway: the relay failed", {
        ...fields,
        error: e instanceof Error ? e.name : "unknown",
      });
      if (!reply.sent && !reply.raw.headersSent) {
        text(502, upstreamFailed(target.host, "gateway error"));
      } else reply.raw.destroy();
    } finally {
      this.done(undefined, fields, started);
    }
  }

  /**
   * Takes one of the org's gateway slots (Redis `git-conc:<orgId>`, TTL refreshed by every
   * request) and returns how many are in use now with the slot's release (idempotent; a counter
   * that went below zero after an expiry is reset).
   */
  private async acquireOrgSlot(orgId: string): Promise<{ inUse: number; release: () => void }> {
    const key = gitConcurrencyKey(orgId);
    const res = await this.redis.multi().incr(key).expire(key, CONCURRENCY_TTL_SECONDS).exec();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      void this.redis
        .decr(key)
        .then((n) => (n < 0 ? this.redis.del(key) : 0))
        .catch(() => {});
    };
    const n = res?.[0]?.[1];
    // a failed count is taken as full: refuse rather than run unbounded
    return { inUse: typeof n === "number" ? n : Number.POSITIVE_INFINITY, release };
  }

  private done<T>(result: T, fields: LogFields, started: number): T {
    if (fields.logged !== true) {
      fields.logged = true;
      const { logged: _l, ...rest } = fields;
      this.log.info("git gateway request", {
        ...rest,
        ms: Math.round(performance.now() - started),
      });
    }
    return result;
  }

  private async relay(
    req: FastifyRequest,
    reply: FastifyReply,
    c: {
      target: GitGatewayTarget;
      binding: GitTicketBinding;
      source: GitSourceFor;
      body: Readable | undefined;
      fields: LogFields;
      used: number;
      text: (status: number, message: string) => FastifyReply;
    },
  ): Promise<void> {
    const { target, binding, source, fields, text } = c;
    const cfg = this.config.get().tools.git;
    let upstreamBody: Readable | undefined = c.body;

    // pushes: the policy decides before any byte reaches the host
    if (target.service === "git-receive-pack") {
      if (target.endpoint === "info/refs") {
        const decision = await this.decide(binding, source, target);
        if (decision.decision === "deny") {
          await this.recordRefusal(binding, source, target, [], decision);
          fields.status = 200;
          fields.push = decision.reason;
          reply
            .code(200)
            .header("content-type", "application/x-git-receive-pack-advertisement")
            .header("cache-control", "no-cache")
            .send(advertisementError(`Capybara: ${refusalNote(target.repo, [], decision)}`));
          return;
        }
      } else {
        if (c.body === undefined) {
          text(400, BAD_PUSH("no request body"));
          return;
        }
        const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();
        if (encoding !== "identity") {
          // the gateway must read the ref updates before it decides
          text(415, BAD_PUSH("compressed push requests are not supported"));
          return;
        }
        const iterator = c.body[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
        // a refused push's pack is read and dropped, so git gets the answer on a clean connection
        const drain = () => {
          void (async () => {
            for (;;) if ((await iterator.next()).done) return;
          })().catch(() => {});
        };
        let parsed: Awaited<ReturnType<typeof readReceivePackCommands>>;
        try {
          parsed = await readReceivePackCommands(iterator);
        } catch (e) {
          if (e instanceof ReceivePackParseError) {
            drain();
            text(400, BAD_PUSH(e.message));
            return;
          }
          throw e;
        }
        const refs = parsed.commands.map((cmd: RefCommand) => cmd.ref);
        if (refs.length > 0) {
          const decision = await this.decide(binding, source, target);
          fields.push = decision.reason;
          if (decision.decision !== "allow") {
            await this.recordRefusal(binding, source, target, refs, decision);
            const note = refusalNote(target.repo, refs, decision);
            fields.status = 200;
            drain();
            reply
              .code(200)
              .header("content-type", "application/x-git-receive-pack-result")
              .header("cache-control", "no-cache")
              .send(
                receivePackRefusal(
                  parsed.capabilities,
                  refs,
                  `Capybara: ${note}`,
                  decision.decision === "ask" ? "needs approval" : "not allowed",
                ),
              );
            return;
          }
        }
        // the bytes already read go first, then the rest of the body as it arrives
        upstreamBody = Readable.from(
          (async function* () {
            yield parsed.prefix;
            for (;;) {
              const next = await iterator.next();
              if (next.done) return;
              yield next.value;
            }
          })(),
          { objectMode: false },
        );
      }
    }

    // the idle timer: any byte either way resets it
    const ac = new AbortController();
    let idle: NodeJS.Timeout | undefined;
    const touch = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error("idle")), cfg.idleTimeoutMs);
    };
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) ac.abort(new Error("client closed"));
    });
    touch();
    const meter = new ByteMeter(this.redis, gitBytesKey(binding.runId), cfg.maxBytesPerRun, c.used);
    try {
      const url = `${(this.upstreamOrigin ?? defaultOrigin)(target.host)}/${target.path}.git/${target.endpoint}${
        target.endpoint === "info/refs" ? `?service=${target.service}` : ""
      }`;
      const headers = new Headers();
      for (const name of FORWARD_REQUEST) {
        const v = req.headers[name];
        if (typeof v === "string") headers.set(name, v);
      }
      const ua = req.headers["user-agent"];
      headers.set(
        "user-agent",
        `${typeof ua === "string" ? `${ua.slice(0, 200)} ` : ""}capybara-git-gateway`,
      );

      const auth = await this.connectorAuth(binding.orgId, source.connectorId);
      if (auth === null) {
        text(403, notConnected(target.host));
        return;
      }
      const authorization = () =>
        this.credentials.gitAuthorization(
          binding.orgId,
          source.connectorId,
          auth,
          binding.accountId,
          source.username,
        );
      const send = async (value: string) => {
        headers.set("authorization", value);
        const body =
          upstreamBody === undefined
            ? undefined
            : (Readable.toWeb(upstreamBody.pipe(meterStream(meter, touch))) as ReadableStream);
        return safeFetch(
          url,
          {
            method: req.method,
            headers,
            ...(body !== undefined && { body, duplex: "half" }),
            signal: ac.signal,
          } as RequestInit & { signal: AbortSignal },
          gitNetPolicy(this.config.get()),
        );
      };

      let res: Response;
      let value = "";
      try {
        value = await authorization();
        res = await send(value);
        if (res.status === 401 && req.method === "GET") {
          // one forced refresh and one retry; a POST body is not replayable
          await res.body?.cancel().catch(() => {});
          await this.credentials.gitUnauthorized(
            binding.orgId,
            source.connectorId,
            auth,
            binding.accountId,
            value,
          );
          value = await authorization();
          res = await send(value);
          fields.refreshed = true;
        }
      } catch (e) {
        if (e instanceof CredentialMissing) {
          text(403, reconnect(target.host));
          return;
        }
        if (e instanceof NetDeniedError) {
          fields.net = e.code;
          text(
            502,
            upstreamFailed(
              target.host,
              e.code === "net.redirect"
                ? "it answered with a redirect, which is not followed"
                : "refused by the network rules",
            ),
          );
          return;
        }
        if (e instanceof GitBytesExceeded || meter.exceeded) {
          text(403, BYTES_EXCEEDED);
          return;
        }
        if (ac.signal.aborted) {
          text(504, upstreamFailed(target.host, "no data within the idle timeout"));
          return;
        }
        throw e;
      }
      fields.upstream = res.status;
      if (res.status === 401) {
        await res.body?.cancel().catch(() => {});
        if (req.method === "POST") {
          // a refused POST credential is refreshed for the next command (no retry here)
          await this.credentials
            .gitUnauthorized(binding.orgId, source.connectorId, auth, binding.accountId, value)
            .catch(() => {});
        }
        text(403, reconnect(target.host));
        return;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        if (res.status === 404 || res.status === 403) {
          text(res.status, `Capybara: ${target.host} answered ${res.status} for ${target.repo}.`);
        } else {
          text(502, upstreamFailed(target.host, `status ${res.status}`));
        }
        return;
      }

      reply.code(200);
      for (const name of FORWARD_RESPONSE) {
        const v = res.headers.get(name);
        if (v !== null) reply.header(name, v);
      }
      fields.status = 200;
      if (res.body === null) {
        reply.send();
        return;
      }
      const down = meterStream(meter, touch);
      const source$ = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
      const done = pipeline(source$, down).catch((e: unknown) => {
        fields.broken = e instanceof Error ? e.name : "unknown";
      });
      reply.send(down);
      await done;
    } finally {
      if (idle !== undefined) clearTimeout(idle);
      fields.bytes = meter.moved;
    }
  }

  /** The push decision for this target (spec §7). */
  private decide(
    binding: GitTicketBinding,
    source: GitSourceFor,
    target: GitGatewayTarget,
  ): Promise<GitPushDecision> {
    return decideGitPush(this.db.db, this.config, {
      orgId: binding.orgId,
      accountId: binding.accountId,
      runId: binding.runId,
      connectorId: source.connectorId,
      host: target.host,
      repo: target.repo,
    });
  }

  /**
   * Records a refused push for the exec (`git-ask:<execId>`, read by the Bash pipeline after the
   * command) and, for an unattended run without a task grant, the missing grant on the task run.
   */
  private async recordRefusal(
    binding: GitTicketBinding,
    source: GitSourceFor,
    target: GitGatewayTarget,
    refs: string[],
    decision: GitPushDecision,
  ): Promise<void> {
    const outcome =
      decision.decision === "ask"
        ? "ask"
        : decision.reason === "unattended"
          ? "unattended"
          : "denied";
    await recordGitAsk(this.redis, binding.execId, {
      host: target.host,
      repo: target.repo,
      refs,
      connectorId: source.connectorId,
      ...(outcome !== "ask" && { outcome }),
    });
    if (decision.missingGrant !== undefined) {
      await appendMissingGrant(
        this.db.db,
        decision.missingGrant.taskRunId,
        decision.missingGrant.key,
      );
    }
  }

  /** The connector's auth (it may have changed since the source was chosen); null when gone. */
  private async connectorAuth(orgId: string, connectorId: string): Promise<ConnectorAuth | null> {
    const row = await this.db.db
      .selectFrom("connectors")
      .select("auth")
      .where("id", "=", connectorId)
      .where("org_id", "=", orgId)
      .where("deleted_at", "is", null)
      .where("status", "=", "active")
      .executeTakeFirst();
    return row === undefined ? null : (row.auth as unknown as ConnectorAuth);
  }
}

const defaultOrigin: GitUpstreamOrigin = (host) => `https://${host}`;

const contentTypeOf = (req: FastifyRequest): string =>
  String(req.headers["content-type"] ?? "")
    .split(";")[0]
    ?.trim()
    .toLowerCase() ?? "";

/** The note a refused push carries (the model reads it in the command's output). */
function refusalNote(repo: string, refs: string[], d: GitPushDecision): string {
  if (d.decision === "ask") return gitAskedNote(repo);
  if (d.reason === "unattended") return gitUnattendedNote(repo, refs);
  return gitPolicyDeniedNote(repo, refs);
}
