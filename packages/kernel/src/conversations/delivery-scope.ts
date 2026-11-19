/**
 * The delivery scope (truthful delivery spec §2): the current run of a conversation after the
 * person last spoke in it. The same bytes reach the user once per scope; this file holds the
 * shapes and the pure repeat decision, {@link EventLog.readDeliveryScope} reads a scope.
 */

/** An `artifact_created` event of the scope, as the repeat decision needs it. */
export interface ScopeArtifact {
  seq: number;
  artifactId: string;
  name: string;
  /** Absent on events written before the field existed: such an artifact never matches. */
  sha256?: string;
  sourcePath: string;
}

/** A run's delivery scope: its boundary seq and the artifacts delivered after it. */
export interface DeliveryScope {
  /**
   * The highest seq among the run's `user_message` events and `question_answered` events with
   * outcome `answered` / `skipped`; the run's `run_started` seq when there is none.
   */
  boundary: number;
  /** This scope's `artifact_created` events (seq above the boundary), in ascending seq. */
  artifacts: ScopeArtifact[];
}

/**
 * Whether a file with `sha256` from `sourcePath` repeats an artifact of the scope: with M the
 * latest scope artifact with that hash and L the latest with that source path, the file repeats
 * M when M exists and L does not come after M (so v1, v2, v1 of one path delivers v1 again).
 * `lastOfSource` is L's seq (0 without one), part of the append's idempotency key.
 */
export function findRepeat(
  scope: DeliveryScope,
  sha256: string,
  sourcePath: string,
): { repeatOf: ScopeArtifact | null; lastOfSource: number } {
  let m: ScopeArtifact | null = null;
  let lastOfSource = 0;
  for (const a of scope.artifacts) {
    if (a.sha256 !== undefined && a.sha256 === sha256 && (m === null || a.seq > m.seq)) m = a;
    if (a.sourcePath === sourcePath && a.seq > lastOfSource) lastOfSource = a.seq;
  }
  const repeatOf = m !== null && !(lastOfSource > m.seq) ? m : null;
  return { repeatOf, lastOfSource };
}
