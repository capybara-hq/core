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
  base?: DraftBase;
}

/**
 * The file a streaming `Write` replaces (Write content-first spec §4.4). `guess` is set when the
 * kernel guessed the file before the call's path arrived (the model wrote `content` first); the
 * verdict follows once the path closes. A rejected guess stays marked (never deleted), so a
 * lagging draft read cannot bring it back.
 */
export interface DraftBase {
  text: string;
  sha256: string;
  guess?: { path: string };
  verdict?: "confirmed" | "rejected";
}

/** A well-formed base from a draft or a delta (anything else: undefined). */
export function parseDraftBase(v: unknown): DraftBase | undefined {
  const b = v as Partial<Record<keyof DraftBase, unknown>> | null | undefined;
  if (typeof b !== "object" || b === null) return undefined;
  if (typeof b.text !== "string" || typeof b.sha256 !== "string") return undefined;
  const base: DraftBase = { text: b.text, sha256: b.sha256 };
  const guess = parseGuess(b.guess);
  if (guess !== undefined) {
    base.guess = guess;
    // a verdict only means something for a guess
    if (b.verdict === "confirmed" || b.verdict === "rejected") base.verdict = b.verdict;
  }
  return base;
}

/** The base a `tool_base` delta carries (`text`, `sha256`, `guess`; undefined: malformed). */
export function baseOfDelta(d: {
  text?: unknown;
  sha256?: unknown;
  guess?: unknown;
}): DraftBase | undefined {
  if (typeof d.text !== "string" || typeof d.sha256 !== "string") return undefined;
  const guess = parseGuess(d.guess);
  return { text: d.text, sha256: d.sha256, ...(guess !== undefined ? { guess } : {}) };
}

/** A well-formed `guess` (`{ path }`), else undefined. */
export function parseGuess(v: unknown): { path: string } | undefined {
  const g = v as { path?: unknown } | null | undefined;
  return typeof g === "object" && g !== null && typeof g.path === "string"
    ? { path: g.path }
    : undefined;
}

/**
 * The base kept when another arrives for the same call (the plan's merge rule, the kernel's
 * draft applies the same): the first one is kept, except that the exact base read after a
 * rejection replaces the rejected guess, and a copy of the same guess carries its verdict over.
 * An exact base also replaces a guess still without a verdict: the kernel reads one only after a
 * rejection, so it stands for the verdict this viewer missed (a reconnect between the two).
 * Returns `prev` itself when nothing changes.
 */
export function mergeBase(
  prev: DraftBase | undefined,
  got: DraftBase | undefined,
): DraftBase | undefined {
  if (got === undefined) return prev;
  if (prev === undefined) return got;
  if (prev.guess !== undefined && prev.verdict !== "confirmed" && got.guess === undefined)
    return got;
  if (
    prev.verdict === undefined &&
    got.verdict !== undefined &&
    prev.sha256 === got.sha256 &&
    prev.guess?.path === got.guess?.path
  )
    return { ...prev, verdict: got.verdict };
  return prev;
}

/**
 * The base after a `tool_base_verdict`: it applies only to a guess without a verdict yet
 * (anything else, or no base: unchanged).
 */
export function applyBaseVerdict(
  base: DraftBase | undefined,
  confirmed: boolean,
): DraftBase | undefined {
  if (base === undefined || base.guess === undefined || base.verdict !== undefined) return base;
  return { ...base, verdict: confirmed ? "confirmed" : "rejected" };
}

/**
 * The base a streaming row may draw: an exact or confirmed one, or a guess without a verdict yet
 * (drawn as a guess); a rejected guess is never drawn.
 */
export function usableBase(base: DraftBase | undefined): DraftBase | undefined {
  return base?.verdict === "rejected" ? undefined : base;
}

/** True for a base the logged row may keep diffing against: exact, or a confirmed guess. */
export function isSettledBase(base: DraftBase | undefined): base is DraftBase {
  return base !== undefined && (base.guess === undefined || base.verdict === "confirmed");
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
    const base = parseDraftBase(t.base);
    if (base !== undefined) tool.base = base;
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
