import { AsyncLocalStorage } from "node:async_hooks";
import type { Socket } from "node:net";
import { type ControlledTransaction, Kysely, PostgresDialect, type Transaction } from "kysely";
import pg from "pg";
import { pgConnectOptions } from "../../db/pool.js";

export interface StartupActivationOptions {
  connectionString: string;
  connectTimeoutMs?: number;
  signal: AbortSignal;
  remainingMs: () => number;
}

/** Deliberately safe diagnostics: driver errors may contain connection or statement inputs. */
export class StartupActivationError extends Error {
  constructor(readonly outcome: "aborted" | "rolled-back" | "uncertain") {
    super(
      `Permission configuration startup transaction ${outcome}; retry the same resolved configuration and expected hash`,
    );
    this.name = "StartupActivationError";
  }
}
interface StartupGuard {
  check(): void;
}
const startup = new AsyncLocalStorage<StartupGuard>();
export function startupActivationGuard(): StartupGuard | undefined {
  return startup.getStore();
}

// pg's BackendKeyData and protocol encoder are internal, pinned to the installed pg version.
// The key is never exposed from this module or put in an Error.
interface PgInternals {
  processID: number;
  secretKey: number;
  connectionParameters: {
    host: string;
    port: number;
    options?: string;
    statement_timeout?: number;
    lock_timeout?: number;
    idle_in_transaction_session_timeout?: number;
    query_timeout?: number;
  };
  connection: {
    stream: Socket;
    connect(port: number | string, host?: string): void;
    cancel(pid: number, key: number): void;
    once(event: string, fn: (...args: unknown[]) => void): void;
  };
}
const internal = (client: pg.Client) => client as unknown as PgInternals;

/** Bounded await; timeout never means the remote transaction rolled back. */
async function within<T>(promise: Promise<T>, deadline: number): Promise<{ value: T } | undefined> {
  const ms = deadline - performance.now();
  if (ms <= 0) {
    void promise.catch(() => {});
    return undefined;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function cancelSession(
  connectionString: string,
  identity: Readonly<{ pid: number; key: number }>,
  deadline: number,
): Promise<void> {
  if (deadline <= performance.now()) return;
  const client = new pg.Client({ connectionString });
  const { connection, connectionParameters } = internal(client);
  const closed = new Promise<void>((resolve) => {
    connection.stream.once("close", () => resolve());
    connection.stream.once("error", () => resolve());
    connection.once("error", () => resolve());
    connection.once("connect", () => {
      connection.cancel(identity.pid, identity.key);
    });
  });
  try {
    if (connectionParameters.host.startsWith("/"))
      connection.connect(`${connectionParameters.host}/.s.PGSQL.${connectionParameters.port}`);
    else connection.connect(connectionParameters.port, connectionParameters.host);
    await within(closed, deadline);
  } finally {
    connection.stream.destroy();
    await within(closed, deadline);
  }
}

/** A one-use owned session. Neither this pool nor its client can reach the shared pool. */
export async function runOwnedStartupActivation<T>(
  // biome-ignore lint/suspicious/noExplicitAny: TransactionHost provides the schema view
  fn: (trx: Transaction<any>) => Promise<T>,
  options: StartupActivationOptions,
): Promise<T> {
  const workDeadline = performance.now() + Math.max(0, Math.min(30_000, options.remainingMs()));
  let cleanupDeadline = workDeadline;
  const cleanupControl = new AsyncLocalStorage<boolean>();
  let transaction: ControlledTransaction<unknown> | undefined;
  let closed = false;
  let committed = false;
  let commitDispatched = false;
  let connected = false;
  let released = false;
  let client: pg.Client | undefined;
  let identity: Readonly<{ pid: number; key: number }> | undefined;
  let rawQuery:
    | ((text: string, values?: readonly unknown[]) => Promise<pg.QueryResult>)
    | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  let rejectAborted!: (error: Error) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  // A synchronous entry failure can occur before Promise.race installs its handler.
  void aborted.catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    cleanupDeadline = performance.now() + Math.max(0, Math.min(1_500, options.remainingMs()));
    rejectAborted(new StartupActivationError(commitDispatched ? "uncertain" : "aborted"));
    if (!connected && client) internal(client).connection.stream.destroy();
  };
  const guard: StartupGuard = {
    check() {
      if (options.signal.aborted || performance.now() >= workDeadline || options.remainingMs() <= 0)
        close();
      if (closed) throw new StartupActivationError(commitDispatched ? "uncertain" : "aborted");
    },
  };
  const timer = setTimeout(close, Math.max(1, workDeadline - performance.now()));
  options.signal.addEventListener("abort", close, { once: true });
  // pg parses connectionString after object options. Pin defaults on the parsed parameters,
  // before the first handshake; no SQL is needed to establish the protected session defaults.
  class OwnedClient extends pg.Client {
    constructor(config: pg.ClientConfig = {}) {
      super(config);
      client = this;
      const params = internal(this).connectionParameters;
      params.options = `${params.options ?? ""} -c statement_timeout=500 -c lock_timeout=500 -c idle_in_transaction_session_timeout=500`;
      // pg also sends direct startup GUC fields after options, so pin both DSN spellings.
      params.statement_timeout = 500;
      params.lock_timeout = 500;
      params.idle_in_transaction_session_timeout = 500;
      // A client read timeout rejects before server completion and would advance our tail
      // into pg's unguarded queue. Server timeouts and our owned deadline bound this session.
      params.query_timeout = 0;
      this.on("error", () => {});
      const dispatch = super.query.bind(this) as (
        text: string,
        values?: readonly unknown[],
      ) => Promise<pg.QueryResult>;
      rawQuery = dispatch;
      // Kysely calls only the promise text+parameters form. Keep pg's own queue empty:
      // every dispatch checks the guard after dequeue, immediately before sending SQL.
      this.query = ((text: string, values?: readonly unknown[]) => {
        const ownerRollback = cleanupControl.getStore() === true && text === "rollback";
        const pending = tail.then(() => {
          if (!ownerRollback) guard.check();
          if (text === "commit") commitDispatched = true;
          return dispatch(text, values);
        });
        tail = pending.catch(() => {});
        return pending;
      }) as pg.Client["query"];
    }
  }
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 1,
    ...pgConnectOptions({
      connectTimeoutMs: Math.max(
        1,
        Math.min(
          options.connectTimeoutMs ?? 30_000,
          workDeadline - performance.now(),
          options.remainingMs(),
        ),
      ),
    }),
    keepAlive: true,
    Client: OwnedClient,
  });
  pool.on("error", () => {});
  pool.on("release", () => {
    released = true;
  });
  pool.on("connect", (owned) => {
    connected = true;
    const original = internal(owned);
    identity = Object.freeze({ pid: original.processID, key: original.secretKey });
    if (closed) original.connection.stream.destroy();
  });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  let rollbackConfirmed = false;
  try {
    guard.check();
    return await startup.run(guard, async () => {
      const work = (async () => {
        const trx = await db.startTransaction().execute();
        transaction = trx;
        guard.check();
        const result = await fn(trx);
        guard.check();
        await trx.commit().execute();
        committed = true;
        return result;
      })();
      return await Promise.race([work, aborted]);
    });
  } catch (error) {
    close();
    const deadline = cleanupDeadline;
    if (identity && !committed)
      await cancelSession(
        options.connectionString,
        identity,
        Math.min(deadline, performance.now() + 500),
      );
    // Only this fixed owner-private command bypasses the closed dispatch gate. Domain work
    // retains the closed guard, including captured transactions and late ALS descendants.
    if (!commitDispatched && connected && rawQuery) {
      try {
        const settled = await within(tail, deadline);
        if (settled) {
          const current = transaction;
          const rollback = current
            ? cleanupControl.run(true, () => current.rollback().execute())
            : rawQuery("rollback");
          rollbackConfirmed = (await within<unknown>(rollback, deadline)) !== undefined;
        }
      } catch {
        /* Disposal below closes a failed rollback session. */
      }
    }
    if (commitDispatched || (connected && !rollbackConfirmed))
      throw new StartupActivationError("uncertain");
    // Preserve safe domain errors such as a fingerprint CAS conflict. Driver errors carry
    // SQL/connection details and are replaced with a bounded outcome diagnostic.
    if (
      error instanceof Error &&
      ["PermissionConfigActivationConflict", "SandboxScopeDeniedError"].includes(error.name)
    )
      throw error;
    throw new StartupActivationError(rollbackConfirmed ? "rolled-back" : "aborted");
  } finally {
    close();
    clearTimeout(timer);
    options.signal.removeEventListener("abort", close);
    // Destroy the owned socket, including a half-authenticated or busy client, before ending
    // its private pool. Never wait indefinitely for pool.end() on a checked-out connection.
    if (client) {
      const stream = internal(client).connection.stream;
      const ended = new Promise<void>((resolve) => {
        if (stream.closed) resolve();
        else stream.once("close", () => resolve());
      });
      stream.destroy();
      if (connected && !released && "release" in client) (client as pg.PoolClient).release(true);
      await within(ended, cleanupDeadline);
    }
    await within(
      db.destroy().catch(() => {}),
      cleanupDeadline,
    );
  }
}
