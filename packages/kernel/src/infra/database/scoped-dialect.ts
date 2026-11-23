import {
  CompiledQuery,
  type ControlConnectionProvider,
  type DatabaseConnection,
  type Driver,
  PostgresDialect,
  type PostgresDialectConfig,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { currentScope, type OrgScope, scopeKey, unscopedQueryCheck } from "./org-scope.js";

/**
 * `db.rls`: how the kernel pool carries the org scope to Postgres (RLS spec §5.2, §7).
 * - `off`: nothing is sent; the pool is a plain Kysely pool (no extra round trip).
 * - `scoped`: every connection carries the scope, with `capybara.rls = off`, so the policies admit
 *   every row; for measuring the round-trip cost (§8) and for the unscoped-query check.
 * - `enforce`: the same with `capybara.rls = enforce`: the policies filter by the scope.
 */
export type RlsMode = "off" | "scoped" | "enforce";

const SET_SCOPE =
  "select set_config('capybara.org_id', $1, $4), set_config('capybara.scope', $2, $4), " +
  "set_config('capybara.rls', $3, $4)";

/** The three settings for `scope`; an unscoped context sends empty values (fail closed). */
function setScopeQuery(scope: OrgScope | undefined, rls: string, local: boolean): CompiledQuery {
  const orgId = scope?.kind === "org" ? scope.orgId : "";
  const kind = scope?.kind ?? "";
  return CompiledQuery.raw(SET_SCOPE, [orgId, kind, rls, local]);
}

/** Tables of the `capybara` schema with an `org_id` column (for the unscoped-query check). */
const ORG_TABLES_SQL =
  "select table_name from information_schema.columns " +
  "where table_schema = 'capybara' and column_name = 'org_id'";
const TABLE_REF = /"capybara"\."([a-z0-9_]+)"|\bcapybara\.([a-z0-9_]+)/g;

/**
 * One checkout of a pool connection. Before a query runs, the scope of the caller's async context
 * is put on the connection unless it is already there: session-level (`set_config(…, false)`)
 * outside a transaction, transaction-local (`true`) inside one, the first right after `BEGIN`.
 * A fresh checkout knows nothing about the session's values, so its first query always sets all
 * three: whatever an earlier holder left on the connection is overwritten before it can be read,
 * and a returned connection carries no scope into its next user. Queries on one checkout run one
 * after another (as pg runs them anyway), so a scope change and the query it precedes are never
 * split by another query of the same transaction.
 */
class ScopedConnection implements DatabaseConnection {
  /** The scope key now on the connection; undefined when unknown (fresh, or after a commit). */
  private applied: string | undefined;
  private inTransaction = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly inner: DatabaseConnection,
    private readonly rls: "off" | "enforce",
    private readonly orgTables: (conn: DatabaseConnection) => Promise<ReadonlySet<string>>,
  ) {}

  // cancellation (an aborted query) goes to the inner connection, which knows the backend; the
  // kernel passes no abort signal to queries, so terminating a whole session is never asked for
  cancelQuery(provider: ControlConnectionProvider): Promise<void> {
    return this.inner.cancelQuery?.(provider) ?? Promise.resolve();
  }

  collectSessionInfo(): Promise<void> {
    return this.inner.collectSessionInfo?.() ?? Promise.resolve();
  }

  /** Runs `fn` after every earlier operation of this checkout settled. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => {});
    return run;
  }

  private async ensure(scope: OrgScope | undefined): Promise<void> {
    const key = scopeKey(scope);
    if (this.applied === key) return;
    this.applied = undefined;
    await this.inner.executeQuery(setScopeQuery(scope, this.rls, this.inTransaction));
    this.applied = key;
  }

  private async check(scope: OrgScope | undefined, sql: string): Promise<void> {
    const check = unscopedQueryCheck();
    if (!check || scope) return;
    const tables = await this.orgTables(this.inner);
    for (const m of sql.matchAll(TABLE_REF)) {
      const table = m[1] ?? m[2];
      if (table && tables.has(table)) check(table, sql);
    }
  }

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const scope = currentScope();
    return this.serial(async () => {
      await this.check(scope, query.sql);
      await this.ensure(scope);
      return this.inner.executeQuery<R>(query);
    });
  }

  /**
   * A cursor holds this checkout until it is closed: the scope is set and the stream read inside
   * one serial step, so no query of another scope runs in between.
   */
  async *streamQuery<R>(
    query: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    const scope = currentScope();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready: (error?: unknown) => void = () => {};
    const started = new Promise<void>((resolve, reject) => {
      ready = (error) => (error === undefined ? resolve() : reject(error));
    });
    void this.serial(async () => {
      try {
        await this.check(scope, query.sql);
        await this.ensure(scope);
      } catch (error) {
        ready(error ?? new Error("scope setup failed"));
        return;
      }
      ready();
      await held;
    });
    try {
      await started;
      yield* this.inner.streamQuery<R>(query, chunkSize);
    } finally {
      release();
    }
  }

  /** `BEGIN`, then the scope of the caller transaction-local, as the transaction's first statement. */
  begin(driver: Driver, settings: TransactionSettings): Promise<void> {
    const scope = currentScope();
    return this.serial(async () => {
      await driver.beginTransaction(this.inner, settings);
      this.inTransaction = true;
      this.applied = undefined;
      try {
        await this.ensure(scope);
      } catch (error) {
        // Kysely rolls back only a transaction whose begin resolved: end this one here, or the
        // connection would return to the pool inside it (best effort; the error is the caller's)
        await driver.rollbackTransaction(this.inner).catch(() => {});
        this.inTransaction = false;
        this.applied = undefined;
        throw error;
      }
    });
  }

  /** `COMMIT` / `ROLLBACK`: the local values end, the session's (unknown here) apply again. */
  end(fn: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      try {
        await fn();
      } finally {
        this.inTransaction = false;
        this.applied = undefined;
      }
    });
  }

  /**
   * A savepoint statement, in order with the queries. A rollback to a savepoint also undoes a
   * scope set after it, so the scope on the connection is unknown again.
   */
  step(fn: () => Promise<void>, rollsBack = false): Promise<void> {
    return this.serial(async () => {
      try {
        await fn();
      } finally {
        if (rollsBack) this.applied = undefined;
      }
    });
  }
}

/**
 * Wraps Kysely's Postgres driver so every connection carries the caller's org scope
 * ({@link ScopedConnection}). Everything else (pooling, cancellation, savepoints) is the inner
 * driver's.
 */
class ScopedDriver implements Driver {
  private tables: Promise<ReadonlySet<string>> | undefined;

  constructor(
    private readonly inner: Driver,
    private readonly rls: "off" | "enforce",
  ) {}

  init(): Promise<void> {
    return this.inner.init();
  }

  /**
   * The org-scoped tables, read once (on the connection of the query that first needs them, so the
   * check never waits for a second pool connection).
   */
  private orgTables = (conn: DatabaseConnection): Promise<ReadonlySet<string>> => {
    this.tables ??= conn
      .executeQuery<{ table_name: string }>(CompiledQuery.raw(ORG_TABLES_SQL))
      .then((r) => new Set(r.rows.map((row) => row.table_name)));
    this.tables.catch(() => {
      this.tables = undefined;
    });
    return this.tables;
  };

  async acquireConnection(): Promise<DatabaseConnection> {
    const inner = await this.inner.acquireConnection();
    return new ScopedConnection(inner, this.rls, this.orgTables);
  }

  beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    return scoped(conn).begin(this.inner, settings);
  }

  commitTransaction(conn: DatabaseConnection): Promise<void> {
    const c = scoped(conn);
    return c.end(() => this.inner.commitTransaction(c.inner));
  }

  rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    const c = scoped(conn);
    return c.end(() => this.inner.rollbackTransaction(c.inner));
  }

  async savepoint(
    conn: DatabaseConnection,
    name: string,
    compile: QueryCompiler["compileQuery"],
  ): Promise<void> {
    const c = scoped(conn);
    await c.step(async () => this.inner.savepoint?.(c.inner, name, compile));
  }

  async rollbackToSavepoint(
    conn: DatabaseConnection,
    name: string,
    compile: QueryCompiler["compileQuery"],
  ): Promise<void> {
    const c = scoped(conn);
    await c.step(async () => this.inner.rollbackToSavepoint?.(c.inner, name, compile), true);
  }

  async releaseSavepoint(
    conn: DatabaseConnection,
    name: string,
    compile: QueryCompiler["compileQuery"],
  ): Promise<void> {
    const c = scoped(conn);
    await c.step(async () => this.inner.releaseSavepoint?.(c.inner, name, compile));
  }

  releaseConnection(conn: DatabaseConnection): Promise<void> {
    return this.inner.releaseConnection(scoped(conn).inner);
  }

  destroy(): Promise<void> {
    return this.inner.destroy();
  }
}

function scoped(conn: DatabaseConnection): ScopedConnection {
  if (!(conn instanceof ScopedConnection)) throw new Error("Not a scoped pool connection");
  return conn;
}

/**
 * The kernel pool's dialect: Kysely's Postgres dialect, with {@link ScopedDriver} unless `rls` is
 * `off` (then nothing changes, not even a round trip).
 */
export class ScopedPostgresDialect extends PostgresDialect {
  constructor(
    config: PostgresDialectConfig,
    private readonly rls: RlsMode,
  ) {
    super(config);
  }

  override createDriver(): Driver {
    const inner = super.createDriver();
    if (this.rls === "off") return inner;
    return new ScopedDriver(inner, this.rls === "enforce" ? "enforce" : "off");
  }
}
