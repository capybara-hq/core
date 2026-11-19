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
 * The operations executing in this process, fed by the operation dispatch where it notes an exec's
 * start and end in the command log. In-process by design: only this runner's control socket reads
 * it, and it dies with the process whose operations it lists.
 */
export class RunningOperations {
  private readonly ops: RunningOperation[] = [];

  begin(op: RunningOperation): void {
    // copy only the known fields: whatever else the caller holds never reaches the socket
    this.ops.push({
      tag: op.tag,
      conversationId: op.conversationId,
      accountId: op.accountId,
      isolation: op.isolation,
      startedAt: op.startedAt,
    });
  }

  /** Ends the oldest running operation with this tag (tags may repeat); unknown tags are ignored. */
  end(tag: string): void {
    const i = this.ops.findIndex((o) => o.tag === tag);
    if (i >= 0) this.ops.splice(i, 1);
  }

  list(): RunningOperation[] {
    return this.ops.map((o) => ({ ...o }));
  }
}
