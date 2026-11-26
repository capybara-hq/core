import { apiFetch } from "./api";

/**
 * A tool call a step streams (kernel `DraftTool`; display only: the logged `assistant_message` is
 * what runs). `input` is the head of the call's JSON input as streamed, not parseable until it is
 * complete; `base` is the file a streaming `Write` replaces.
 */
export interface DraftTool {
  id: string;
  name: string;
  input: string;
  inputTruncated?: boolean;
  base?: { text: string; sha256: string };
}

/** What one step of a running run has streamed so far (kernel `RunDraft`). */
export interface RunDraftSnapshot {
  step: number;
  text: string;
  thinking: string;
  tools: DraftTool[];
}

/** The well-formed tools of a draft's `tools` (anything else is dropped). */
export function parseDraftTools(v: unknown): DraftTool[] {
  if (!Array.isArray(v)) return [];
  const out: DraftTool[] = [];
  for (const x of v) {
    const t = x as Partial<DraftTool> | null;
    if (typeof t !== "object" || t === null || typeof t.id !== "string") continue;
    const tool: DraftTool = {
      id: t.id,
      name: typeof t.name === "string" ? t.name : "",
      input: typeof t.input === "string" ? t.input : "",
    };
    if (t.inputTruncated === true) tool.inputTruncated = true;
    const b = t.base as Partial<{ text: string; sha256: string }> | undefined;
    if (b && typeof b.text === "string" && typeof b.sha256 === "string")
      tool.base = { text: b.text, sha256: b.sha256 };
    out.push(tool);
  }
  return out;
}

const toSnapshot = (v: unknown): RunDraftSnapshot | null => {
  const d = v as Partial<RunDraftSnapshot> | null;
  if (
    typeof d !== "object" ||
    d === null ||
    typeof d.step !== "number" ||
    typeof d.text !== "string" ||
    typeof d.thinking !== "string"
  )
    return null;
  return { step: d.step, text: d.text, thinking: d.thinking, tools: parseDraftTools(d.tools) };
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
  return Array.isArray(res?.drafts)
    ? res.drafts.map(toSnapshot).filter((d): d is RunDraftSnapshot => d !== null)
    : [];
}
