/**
 * An operation executing on this machine now, as the control socket's `running` op lists it: who
 * asked and how it runs. Never the command, its arguments, its environment or its output.
 */
export interface RunningOperation {
  tag: string;
  conversationId: string | null;
  accountId: string | null;
  isolation: "restricted" | "full";
  startedAt: string;
}

/**
 * The operations executing in this process: an exec while it runs, a background task from its
 * start until its worker is gone (completed or killed, reported by the backend). In-process by
 * design: only this runner's control socket reads it, and it dies with the process whose
 * operations it lists.
 */
export class RunningOperations {
  private readonly ops: { operationId?: string; op: RunningOperation }[] = [];

  /** `operationId` lets {@link endOperation} end exactly this one. */
  begin(op: RunningOperation, operationId?: string): void {
    // a retried start of the same operation replaces its entry instead of adding one
    if (operationId !== undefined) this.endOperation(operationId);
    // copy only the known fields: whatever else the caller holds never reaches the socket
    this.ops.push({
      ...(operationId !== undefined && { operationId }),
      op: {
        tag: op.tag,
        conversationId: op.conversationId,
        accountId: op.accountId,
        isolation: op.isolation,
        startedAt: op.startedAt,
      },
    });
  }

  /** Ends the oldest running operation with this tag (tags may repeat); unknown tags are ignored. */
  end(tag: string): void {
    const i = this.ops.findIndex((o) => o.op.tag === tag);
    if (i >= 0) this.ops.splice(i, 1);
  }

  /** Ends the operation begun with this id; ids already ended are ignored. */
  endOperation(operationId: string): void {
    const i = this.ops.findIndex((o) => o.operationId === operationId);
    if (i >= 0) this.ops.splice(i, 1);
  }

  list(): RunningOperation[] {
    return this.ops.map((o) => ({ ...o.op }));
  }
}
