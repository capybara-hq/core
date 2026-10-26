import { execFile } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import {
  AccountsService,
  type ConversationEvent,
  createKernel,
  createLogger,
  type Kernel,
  type KernelConfig,
  KernelConfigSchema,
  type KernelDb,
  type KernelHttp,
  type LogLevel,
} from "@capybara-hq/kernel";
import { type Kysely, sql } from "kysely";

/**
 * Helpers for extension tests that run a real kernel: in process (`startTestKernel` +
 * `http.inject`) or as two replicas (`createDualReplicaHarness`). They only use the kernel's public
 * API and HTTP routes, so a plugin's tests can use them without reaching into kernel sources.
 */

/** The password `createLocalAccount` gives accounts (and `login` / `joinOrg` use by default). */
export const TEST_PASSWORD = "correct horse battery";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a value other than null / undefined / false; throws on timeout. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
  label = "condition",
  stepMs = 25,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

/**
 * A kernel config for tests: the given PG / Redis, a fixed master key, an ephemeral HTTP port,
 * auto-approved extension permissions, short run-lock timings and the official marketplace off
 * (its default address is on the internet). `overrides` are top-level config keys and win
 * (`runtime` is merged into the defaults).
 */
export function testKernelConfig(
  urls: { pg: string; redis: string },
  overrides: Record<string, unknown> & {
    extensions: string[];
    runtime?: Record<string, unknown>;
  },
): KernelConfig {
  const { runtime, ...rest } = overrides;
  return KernelConfigSchema.parse({
    db: { url: urls.pg, poolMax: 5 },
    redis: { url: urls.redis },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    extensionPermissions: { autoApprove: true },
    runtime: { jobLockMs: 2000, stalledIntervalMs: 1000, ...runtime },
    marketplaces: { official: { enabled: false } },
    ...rest,
  });
}

/**
 * Creates and starts an in-process kernel. Logs are discarded unless `log` is given (JSON lines at
 * `log.level` and above go to `log.write`, e.g. to assert a secret never reaches the log).
 * Extensions named by package resolve from `resolveFrom` (default `process.cwd()`). Stop it with
 * `stop()`.
 */
export async function startTestKernel(
  config: KernelConfig,
  opts: { resolveFrom?: string; log?: { level: LogLevel; write: (line: string) => void } } = {},
): Promise<Kernel> {
  const k = await createKernel(config, {
    env: {},
    logger: createLogger(opts.log?.level ?? "error", { write: opts.log?.write ?? (() => {}) }),
    ...(opts.resolveFrom !== undefined && { resolveFrom: opts.resolveFrom }),
  });
  await k.start();
  return k;
}

/** Options of a {@link KernelRequest} call (`http.inject` options; `csrf: false` drops the header). */
export type KernelRequestOptions = Parameters<KernelHttp["inject"]>[0] & { csrf?: boolean };
export type KernelResponse = Awaited<ReturnType<KernelHttp["inject"]>>;

/**
 * A signed-in user's request function: `http.inject` with the session cookies (kept from each
 * response) and the `X-Capybara-Csrf` header.
 */
export type KernelRequest = (opts: KernelRequestOptions) => Promise<KernelResponse>;

/** A request function with its own cookie jar (signed out until a response sets cookies). */
export function cookieRequest(http: KernelHttp): KernelRequest {
  const jar = new Map<string, string>();
  return async ({ csrf = true, ...opts }) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
    const res = await http.inject({
      ...opts,
      headers: {
        ...(cookie !== "" && { cookie }),
        ...(csrf && { "x-capybara-csrf": "1" }),
        ...(opts.headers as Record<string, string> | undefined),
      },
    });
    const set = res.headers["set-cookie"];
    for (const raw of set === undefined ? [] : Array.isArray(set) ? set : [String(set)]) {
      const [pair = "", ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = decodeURIComponent(pair.slice(eq + 1).trim());
      const gone = value === "" || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (gone) jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}

function expectStatus(res: KernelResponse, status: number, what: string): void {
  if (res.statusCode !== status) {
    throw new Error(`${what}: expected HTTP ${status}, got ${res.statusCode}: ${res.body}`);
  }
}

/** Creates a local account with {@link TEST_PASSWORD}; returns its id. */
export async function createLocalAccount(
  db: KernelDb,
  login: string,
  displayName = login,
): Promise<string> {
  return (
    await new AccountsService(db).createLocal({ login, password: TEST_PASSWORD, displayName })
  ).id;
}

/** Signs in over HTTP and returns the user's request function. */
export async function login(
  k: Pick<Kernel, "http">,
  name: string,
  password = TEST_PASSWORD,
): Promise<KernelRequest> {
  const req = cookieRequest(k.http);
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: name, password },
  });
  expectStatus(res, 200, `login ${name}`);
  return req;
}

/** Creates an org as `req`'s user (who becomes its owner); returns its id. */
export async function createOrg(req: KernelRequest, name = "Acme"): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expectStatus(res, 201, "create org");
  return (res.json() as { org: { id: string } }).org.id;
}

/**
 * A new account joins the org through an invitation (created by `owner`, accepted with `login`
 * and {@link TEST_PASSWORD}); returns the account id and its signed-in request function.
 */
export async function joinOrg(
  k: Pick<Kernel, "http">,
  owner: KernelRequest,
  orgId: string,
  name: string,
  role: "member" | "admin" = "member",
): Promise<{ accountId: string; req: KernelRequest }> {
  const inv = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/invitations`,
    payload: { role },
  });
  expectStatus(inv, 201, "create invitation");
  const req = cookieRequest(k.http);
  const accepted = await req({
    method: "POST",
    url: `/api/v1/invitations/${(inv.json() as { token: string }).token}/accept`,
    payload: { login: name, password: TEST_PASSWORD, displayName: name },
  });
  expectStatus(accepted, 200, "accept invitation");
  return { accountId: (accepted.json() as { account: { id: string } }).account.id, req };
}

/**
 * Creates an org-visible agent; returns its id. Without `tools` the agent has none (model-fake then
 * answers ordinary messages instead of calling the first tool).
 */
export async function createAgent(
  req: KernelRequest,
  orgId: string,
  opts: { model?: { provider: string; model: string }; tools?: unknown[] } = {},
): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: opts.model ?? { provider: "model-fake", model: "fake-1" },
        tools: opts.tools ?? [],
      },
      visibility: "org",
    },
  });
  expectStatus(res, 201, "create agent");
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** Creates a conversation with the agent; returns its id. */
export async function createConversation(
  req: KernelRequest,
  orgId: string,
  agentId: string,
): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expectStatus(res, 201, "create conversation");
  return (res.json() as { conversation: { id: string } }).conversation.id;
}

/** Posts a user message; returns its event seq. */
export async function postMessage(
  req: KernelRequest,
  orgId: string,
  conversationId: string,
  text: string,
): Promise<number> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations/${conversationId}/messages`,
    payload: { text },
  });
  expectStatus(res, 202, "post message");
  return (res.json() as { event: { seq: number } }).event.seq;
}

/** Every event of a conversation, in seq order (read from the database). */
export async function eventsOf(db: KernelDb, conversationId: string): Promise<ConversationEvent[]> {
  const rows = await db
    .selectFrom("conversation_events")
    .select(["conversation_id", "seq", "type", "run_id", "payload", "created_at"])
    .where("conversation_id", "=", conversationId)
    .orderBy("seq")
    .execute();
  return rows.map(
    (r) =>
      ({
        conversationId: r.conversation_id,
        seq: Number(r.seq),
        type: r.type,
        runId: r.run_id,
        payload: r.payload,
        createdAt: r.created_at,
      }) as ConversationEvent,
  );
}

/** Waits for the first event matching `pred` and returns it. */
export function waitForEvent(
  db: KernelDb,
  conversationId: string,
  pred: (e: ConversationEvent) => boolean,
  timeoutMs = 10_000,
  label = "event",
): Promise<ConversationEvent> {
  return waitFor(async () => (await eventsOf(db, conversationId)).find(pred), timeoutMs, label);
}

/** Waits for the conversation's `n`-th terminal event (run_finished / run_failed / run_aborted). */
export function waitForTerminal(
  db: KernelDb,
  conversationId: string,
  n = 1,
  timeoutMs = 15_000,
): Promise<ConversationEvent[]> {
  return waitFor(
    async () => {
      const t = (await eventsOf(db, conversationId)).filter((e) =>
        ["run_finished", "run_failed", "run_aborted"].includes(e.type),
      );
      return t.length >= n ? t : null;
    },
    timeoutMs,
    `${n} terminal event(s)`,
  );
}

/**
 * Waits until an IM card's message id is recorded (`channel_card_messages`). The kernel writes it in
 * the transaction after the card is sent; a click before that is treated as "not a card of this
 * conversation", so a test waits for this before it clicks, not only for the platform to get it.
 */
export async function cardRecorded(
  db: KernelDb,
  card: { messageId: string } | { kind: "approval" | "question" },
  timeoutMs = 20_000,
): Promise<void> {
  await waitFor(
    async () => {
      const q = db.selectFrom("channel_card_messages").select("card_id");
      const row = await ("messageId" in card
        ? q.where("message_id", "=", card.messageId)
        : q.where("card_kind", "=", card.kind)
      ).executeTakeFirst();
      return row !== undefined;
    },
    timeoutMs,
    "card message row",
  );
}

/** PG deadlock (40P01) and lock timeout (55P03). */
const LOCK_CONFLICTS = new Set(["40P01", "55P03"]);
const TRUNCATE_ATTEMPTS = 8;

/**
 * `TRUNCATE <tables> CASCADE` between tests, retried on deadlock / lock timeout: a kernel with the
 * worker role keeps scanning in the background (channel supervisor, deliveries, maintenance), and a
 * background join holding one table while waiting for another deadlocks with TRUNCATE's ordered
 * ACCESS EXCLUSIVE locks. TRUNCATE is atomic, so a retry is safe. `tables` is inlined into the SQL:
 * pass only table names written in the test.
 */
export async function truncateTables<DB>(db: Kysely<DB>, tables: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction().execute(async (t) => {
        await sql`SET LOCAL lock_timeout = '5s'`.execute(t);
        await sql.raw(`TRUNCATE ${tables} CASCADE`).execute(t);
      });
      return;
    } catch (e) {
      const code = typeof e === "object" && e !== null ? ((e as { code?: string }).code ?? "") : "";
      if (!LOCK_CONFLICTS.has(code) || attempt >= TRUNCATE_ATTEMPTS) throw e;
      console.warn(`truncateTables: ${code} on attempt ${attempt}/${TRUNCATE_ATTEMPTS}, retrying`);
      await sleep(50 * attempt + Math.floor(Math.random() * 50));
    }
  }
}

const run = promisify(execFile);

/**
 * Finds which of `pids` owns the local TCP port `port` (the client side of a connection). Dual
 * replica tests use it to map a fake platform's long-connection peer port (`socketPeerPorts()`) to
 * a replica process: a real extension connecting to a fake platform carries no pid marker.
 *
 * Linux reads `/proc/net/tcp{,6}` for the socket inode and looks for it under `/proc/<pid>/fd`,
 * falling back to `ss -tnp`, then `lsof`; other platforms (macOS) use `lsof`. Undefined when not
 * found.
 */
export async function pidOwningLocalPort(
  port: number,
  pids: readonly number[],
): Promise<number | undefined> {
  if (process.platform === "linux") {
    return (await viaProc(port, pids)) ?? (await viaSs(port, pids)) ?? (await viaLsof(port, pids));
  }
  return viaLsof(port, pids);
}

async function viaProc(port: number, pids: readonly number[]): Promise<number | undefined> {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(file, "utf8").catch(() => "");
    for (const line of text.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const inode = cols[9];
      if (local?.endsWith(`:${hexPort}`) && inode !== undefined && inode !== "0") inodes.add(inode);
    }
  }
  if (inodes.size === 0) return undefined;
  for (const pid of pids) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
    for (const fd of fds) {
      const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
      const m = /^socket:\[(\d+)\]$/.exec(target);
      if (m?.[1] !== undefined && inodes.has(m[1])) return pid;
    }
  }
  return undefined;
}

async function viaSs(port: number, pids: readonly number[]): Promise<number | undefined> {
  // Lines like `ESTAB 0 0 127.0.0.1:54321 127.0.0.1:8080 users:(("node",pid=1234,fd=20))`
  const out = await run("ss", ["-tnpH", "state", "established"]).then(
    (r) => r.stdout,
    () => "",
  );
  for (const line of out.split("\n")) {
    const cols = line.trim().split(/\s+/);
    const local = cols.find((c, i) => i < 5 && /:\d+$/.test(c));
    if (!local?.endsWith(`:${port}`)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (pids.includes(pid)) return pid;
    }
  }
  return undefined;
}

async function viaLsof(port: number, pids: readonly number[]): Promise<number | undefined> {
  // -a: AND the conditions; -iTCP:<port> matches the local or the peer port, and the peer is the
  // fake platform (this test process, not in pids)
  const args = ["-nP", "-a", "-p", pids.join(","), `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-Fp"];
  const out = await run("lsof", args).then(
    (r) => r.stdout,
    // lsof exits with 1 when nothing matches
    (e: { stdout?: string }) => e.stdout ?? "",
  );
  for (const line of out.split("\n")) {
    if (!line.startsWith("p")) continue;
    const pid = Number(line.slice(1));
    if (pids.includes(pid)) return pid;
  }
  return undefined;
}
