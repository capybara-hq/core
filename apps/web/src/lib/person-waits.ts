import type { ConversationEvent } from "./conversations";

/**
 * A run's waits for a person (an approval, a question), the one reading the status (`runPhase`)
 * and the elapsed time (`runStats`) share: a wait opens with `approval_requested` /
 * `question_asked` and closes with the `approval_decided` / `question_answered` of the same id,
 * so the run waits while any wait is open (two approvals at once: until both are decided).
 */
export class PersonWaits {
  private readonly open = new Set<string>();

  /** Whether any wait is open. */
  get waiting(): boolean {
    return this.open.size > 0;
  }

  /** What the latest open wait waits for, or null when none is open. */
  get kind(): "approval" | "input" | null {
    const last = [...this.open].at(-1);
    return last === undefined ? null : last.startsWith("a:") ? "approval" : "input";
  }

  /**
   * Applies `e` (an event of the run being followed). Returns `"start"` when the run began
   * waiting with it, `"end"` when its last open wait closed with it, else null.
   */
  apply(e: ConversationEvent): "start" | "end" | null {
    const p = e.payload as { approvalId?: string; questionId?: string };
    const id =
      e.type === "approval_requested" || e.type === "approval_decided"
        ? p.approvalId
        : e.type === "question_asked" || e.type === "question_answered"
          ? p.questionId
          : undefined;
    if (id === undefined) return null;
    const key = `${e.type.startsWith("approval") ? "a" : "q"}:${id}`;
    if (e.type === "approval_requested" || e.type === "question_asked") {
      const was = this.open.size;
      this.open.add(key);
      return was === 0 ? "start" : null;
    }
    return this.open.delete(key) && this.open.size === 0 ? "end" : null;
  }

  /** The run started or ended: no wait is open. */
  clear(): void {
    this.open.clear();
  }
}
