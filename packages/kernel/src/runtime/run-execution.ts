import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost, withTransactionFence } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { XactLock } from "../infra/database/xact-lock.js";
import { isLive } from "./run-liveness.js";
import { rootConversationOf } from "./subagents/child.js";

export interface ExecutionClaim {
  runId: string;
  conversationId: string;
  orgId: string;
  rootId: string;
  executionId: string;
}

// This carries invocation identity only. Consumers must revalidate it in PostgreSQL.
const invocationClaim = new AsyncLocalStorage<Readonly<ExecutionClaim>>();
export const currentExecutionClaim = (): Readonly<ExecutionClaim> | undefined =>
  invocationClaim.getStore();

/** Set inside a tool step: every fenced transaction there is admitted exclusively. */
const exclusiveScope = new AsyncLocalStorage<true>();

/**
 * Runs `fn` (a tool step, a sub-agent dispatch) with every fenced transaction it opens admitted
 * exclusively, even one that asks for shared admission (an event append made by a tool). Tool code
 * takes org-level locks (`OrgLock`, agents, memberships, devices) after the conversation rows,
 * which only the exclusive admission (the org row first) keeps in the global lock order; a
 * transaction asking for shared admission takes none (an org-level lock in one throws,
 * `assertNotSharedAdmission`), so this scope is not what keeps the order: it keeps tool steps
 * serialized per org as the design states, and is defence in depth for a write a tool makes
 * through a path marked shared.
 */
export function withExclusiveAdmission<T>(fn: () => Promise<T>): Promise<T> {
  return exclusiveScope.run(true, fn);
}

/**
 * Whether the caller runs inside {@link withExclusiveAdmission} (a tool step, a dispatch). A test
 * seam: the kernel never reads it (the fence reads the scope directly); tests use it to prove which
 * loop steps run under exclusive admission (`langgraph-loop.test.ts`).
 */
export function inExclusiveAdmission(): boolean {
  return exclusiveScope.getStore() === true;
}

/** Internal interruption: a revoked execution must never write its own terminal failure. */
export class ExecutionRevoked extends Error {
  constructor() {
    super("execution revoked");
  }
}

/**
 * Claims serialize on the same conversation lock as the event log and all fenced writes.
 *
 * The fence admits every writable transaction of a claimed run in one of two modes, then locks the
 * root and the current conversation rows `FOR NO KEY UPDATE` and compares `runs.execution_id`:
 * - **exclusive** (the default, and every transaction inside a tool step,
 *   {@link withExclusiveAdmission}: conformance with the design and defence in depth): the org row
 *   `FOR NO KEY UPDATE`, `OrgLock`'s mode. These
 *   transactions serialize per org with each other and with org admin writes, so whatever they
 *   lock after the conversation rows (`OrgLock`, agents, memberships, the default device) stays in
 *   the order org row → conversations that offboarding and the decisions take.
 * - **shared** (a transaction opened with `admission: "shared"`: the run loop's event appends,
 *   checkpoint writes and suspend): the org admission lock shared
 *   (`XactLock.admitOrgShared`), and the org row read without a lock. These transactions lock
 *   nothing org-level after the conversation rows (enforced: `OrgLock`, the membership locks and
 *   `XactLock.lock` throw in one, `assertNotSharedAdmission`; only READ COMMITTED), so the runs of
 *   one org append in parallel.
 *   Org deletion and offboarding take the admission lock exclusively first
 *   (`OrgLock.lockForRemoval`): they wait for the admitted writes, keep new ones out (a later one
 *   then sees the org deleted), and are not starved by a stream of them (the lock queues fairly).
 *
 * Global order (`OrgLock`): org admission lock → org row → membership → device row → super admin
 * lock → permission authority locks (an ordered prelude, `withTransactionFencePrelude`, runs here
 * and takes them with the locks before them) → root conversation → conversation; a writer that
 * locks several conversation or run rows of one tree locks the tree's root first (the fence
 * does, so every fenced write of a tree serializes on its root). A claim never
 * opens a nested fenced `requires_new` transaction (shared or not) and waits for it while its
 * outer fenced transaction is open: the inner one waits for the outer's root row (and, behind a
 * queued deletion, for the admission lock) on another connection, which PostgreSQL cannot see as
 * a deadlock.
 */
@Injectable()
export class RunExecution {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(XactLock) private readonly xactLock: XactLock,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional({ propagation: "requires_new" })
  async claim(
    conversationId: string,
    runId: string,
    executionId: string,
    live: () => boolean = () => true,
  ): Promise<ExecutionClaim | null> {
    if (!live()) return null;
    const conv = await this.db
      .selectFrom("conversations")
      .select("org_id")
      .where("id", "=", conversationId)
      .executeTakeFirst();
    if (!conv) return null;
    const rootId = await rootConversationOf(this.db.db, conversationId);
    const claim = { conversationId, runId, executionId, orgId: conv.org_id, rootId };
    if (!(await this.lockLiveConversation(claim)) || !live()) return null;
    const run = await this.db
      .updateTable("runs")
      .set({ execution_id: executionId })
      .where("id", "=", runId)
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ["queued", "running"])
      .returning("id")
      .executeTakeFirst();
    return run ? claim : null;
  }

  withClaim<T>(claim: ExecutionClaim, live: () => boolean, fn: () => Promise<T>): Promise<T> {
    return invocationClaim.run(Object.freeze({ ...claim }), () =>
      withTransactionFence(async ({ shared, prelude }) => {
        const admitShared = shared && !exclusiveScope.getStore();
        if (prelude && admitShared) throw new Error("An ordered prelude needs exclusive admission");
        if (!live() || !(await this.lockLiveConversation(claim, admitShared, prelude))) {
          throw new ExecutionRevoked();
        }
        const run = await this.db
          .selectFrom("runs")
          .select("execution_id")
          .where("id", "=", claim.runId)
          .where("conversation_id", "=", claim.conversationId)
          .executeTakeFirst();
        if (run?.execution_id !== claim.executionId || !live()) throw new ExecutionRevoked();
        return admitShared ? "shared" : "exclusive";
      }, fn),
    );
  }

  /**
   * The admission (see the class), then the root and the current conversation; NO KEY UPDATE
   * allows foreign key references while excluding deletion and other writers. The root stays
   * `FOR NO KEY UPDATE` in both modes: a sub-agent's handback appends to its parent (the root at
   * depth 1) under `FOR UPDATE`, so two siblings holding the root only shared would deadlock
   * upgrading it.
   */
  private async lockLiveConversation(
    claim: ExecutionClaim,
    shared = false,
    prelude?: () => Promise<void>,
  ): Promise<boolean> {
    // shared: after the admission lock, a plain read sees a committed deletion (a new statement
    // under READ COMMITTED), and the deletion cannot commit before this transaction ends
    if (shared) await this.xactLock.admitOrgShared(claim.orgId);
    const org = await this.db
      .selectFrom("orgs")
      .select("deleted_at")
      .where("id", "=", claim.orgId)
      .$call((q) => (shared ? q : q.forNoKeyUpdate()))
      .executeTakeFirst();
    if (!org || !isLive(org.deleted_at)) return false;
    // the permission authority locks: after the org row, before the conversation rows
    await prelude?.();
    const root = await this.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", claim.rootId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!root || !isLive(root.deleted_at)) return false;
    if (claim.rootId === claim.conversationId) return true;
    const conv = await this.db
      .selectFrom("conversations")
      .select("deleted_at")
      .where("id", "=", claim.conversationId)
      .where("org_id", "=", claim.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return conv !== undefined && isLive(conv.deleted_at);
  }
}
