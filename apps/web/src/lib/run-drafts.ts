import { apiFetch } from "./api";

/** What one step of a running run has streamed so far (kernel `RunDraft`). */
export interface RunDraftSnapshot {
  step: number;
  text: string;
  thinking: string;
}

const isSnapshot = (v: unknown): v is RunDraftSnapshot => {
  const d = v as Partial<RunDraftSnapshot> | null;
  return (
    typeof d === "object" &&
    d !== null &&
    typeof d.step === "number" &&
    typeof d.text === "string" &&
    typeof d.thinking === "string"
  );
};

/**
 * The live drafts of one run (`GET …/conversations/:id/runs/:runId/draft`, spec 2026-11-07 §3.2):
 * what the stream asks for when a delta's `offset` is past the draft it holds. `[]` for a run that
 * is no longer running (and when the kernel cannot read them). Not a cached read: the stream
 * opener calls it while it holds the deltas past the gap (spec 2026-11-03 web query cache §6, the
 * stream opener reads outside the query cache).
 */
export async function fetchRunDrafts(
  orgId: string,
  conversationId: string,
  runId: string,
): Promise<RunDraftSnapshot[]> {
  const res = await apiFetch<{ drafts?: unknown }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}/runs/${encodeURIComponent(runId)}/draft`,
  );
  return Array.isArray(res?.drafts) ? res.drafts.filter(isSnapshot) : [];
}
