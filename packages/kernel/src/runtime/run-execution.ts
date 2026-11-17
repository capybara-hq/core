import { AsyncLocalStorage } from "node:async_hooks";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost, withTransactionFence } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
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

/** Internal interruption: a revoked execution must never write its own terminal failure. */
export class ExecutionRevoked extends Error {
  constructor() {
    super("execution revoked");
  }
}

/** Claims serialize on the same conversation lock as the event log and all fenced writes. */
@Injectable()
export class RunExecution {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
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
      withTransactionFence(async () => {
        if (!live() || !(await this.lockLiveConversation(claim))) throw new ExecutionRevoked();
        const run = await this.db
          .selectFrom("runs")
          .select("execution_id")
          .where("id", "=", claim.runId)
          .where("conversation_id", "=", claim.conversationId)
          .executeTakeFirst();
        if (run?.execution_id !== claim.executionId || !live()) throw new ExecutionRevoked();
      }, fn),
    );
  }

  /** Org, root, current conversation; allow FK references while excluding deletion and writes. */
  private async lockLiveConversation(claim: ExecutionClaim): Promise<boolean> {
    const org = await this.db
      .selectFrom("orgs")
      .select("deleted_at")
      .where("id", "=", claim.orgId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!org || !isLive(org.deleted_at)) return false;
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
