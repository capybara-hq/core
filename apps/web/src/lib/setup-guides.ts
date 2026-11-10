import { apiFetch } from "./api";

/** Where a plugin's setup guide is (the org's catalog route). */
export interface SetupGuideRef {
  itemId: string;
  guideId: string;
  /** The item's latest version when known (a connection's `setupGuide`): part of the read's key. */
  version?: string;
}

/** A place a setup guide is shown at (setup guides v2 spec §9.1). */
export type SetupGuidePlace = "channel-connection" | "connector-template";

/** Who the guide's text is for: the page passes the audience it serves (spec §8). */
export type SetupGuideAudience = "admin" | "member";

/**
 * Why a known variable has no value here (spec §6.3): the connection is not saved yet, no name is
 * typed yet on 新建渠道 (`no_name`), the
 * deployment has no `http.publicUrl` or no `channels.webhookBaseUrl`, the org has no connector made
 * from the template yet, or the guide is rendered for the platform (no org).
 */
export type UnresolvedReason =
  | "not_saved"
  | "no_name"
  | "public_url"
  | "webhook_base"
  | "no_connector"
  | "no_org";

/**
 * One block of a rendered guide (spec §7.2): sanitized Markdown prose (it may hold U+2060 word
 * joiners that keep text from being auto-linked: rendered as is), a code block with its title, or
 * a check line.
 */
export type SetupGuideBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; language: string; title: string | null; text: string }
  | { kind: "check"; id: string; label: string };

/** A plugin's setup guide rendered by the kernel for an org and target (spec §7.2). */
export interface RenderedSetupGuide {
  itemId: string;
  plugin: string;
  version: string;
  id: string;
  place: SetupGuidePlace;
  /** The document rendered (zh falls back to en). */
  locale: "en" | "zh";
  title: string;
  /** The modes the document's sections use; empty or one = no mode switch. */
  modes: string[];
  mode: string | null;
  audiences: SetupGuideAudience[];
  audience: SetupGuideAudience;
  blocks: SetupGuideBlock[];
  /** The check lines in document order. */
  checks: { id: string; label: string; source: "plugin" | "kernel" }[];
  /** Known variables without a value here (left as `{{name}}`), with the reason. */
  unresolved: { name: string; reason: UnresolvedReason }[];
  /** The content hash of this mode and audience: what an ack records (spec §11). */
  hash: string;
  target: { kind: "channel-connection" | "connector"; id: string } | null;
}

/** What to render the guide for: a target, a mode, an audience, the language. */
export interface SetupGuideQuery {
  mode?: string;
  audience?: SetupGuideAudience;
  locale?: "en" | "zh";
  /** channel-connection: a saved connection, or the name typed so far on 新建渠道. */
  connectionId?: string;
  name?: string;
  /** connector-template: the org's connector made from the template. */
  connectorId?: string;
}

const guideParams = (q: SetupGuideQuery): string => {
  const params = new URLSearchParams();
  if (q.mode) params.set("mode", q.mode);
  if (q.audience) params.set("audience", q.audience);
  if (q.locale) params.set("locale", q.locale);
  if (q.connectionId) params.set("connectionId", q.connectionId);
  if (q.name) params.set("name", q.name);
  if (q.connectorId) params.set("connectorId", q.connectorId);
  const query = params.toString();
  return query ? `?${query}` : "";
};

export const getSetupGuide = (orgId: string, ref: SetupGuideRef, q: SetupGuideQuery = {}) =>
  apiFetch<{ guide: RenderedSetupGuide }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/catalog/${encodeURIComponent(ref.itemId)}/guides/${encodeURIComponent(ref.guideId)}${guideParams(q)}`,
  );

/** The super admin's view of a template's guide: no org, no target (spec §9.3). */
export const getAdminSetupGuide = (ref: SetupGuideRef, q: { locale?: "en" | "zh" } = {}) =>
  apiFetch<{ guide: RenderedSetupGuide }>(
    `/api/v1/admin/catalog/${encodeURIComponent(ref.itemId)}/guides/${encodeURIComponent(ref.guideId)}${guideParams(q)}`,
  );

/** A check result's text in English and, when the plugin wrote one, Chinese. */
export interface SetupCheckText {
  en: string;
  zh?: string;
}

/**
 * The state of one live check (spec §10.3): a result (`ok` / `failing` / `unknown`), `running`
 * while a run holds it (on any replica), or `not_run` without a fresh result for the target's
 * current input. `cooldownUntil`: a forced rerun is refused until then.
 */
export interface SetupCheckState {
  status: "ok" | "failing" | "unknown" | "running" | "not_run";
  reason?: SetupCheckText;
  fix?: SetupCheckText;
  checkedAt?: string;
  cooldownUntil?: string;
}

/** Which rendered guide the checks belong to: the target, its mode and the audience. */
export interface SetupCheckSelection {
  connectionId?: string;
  connectorId?: string;
  mode?: string;
  audience?: SetupGuideAudience;
}

const checksPath = (orgId: string, ref: SetupGuideRef) =>
  `/api/v1/orgs/${encodeURIComponent(orgId)}/catalog/${encodeURIComponent(ref.itemId)}/guides/${encodeURIComponent(ref.guideId)}/checks`;

const selectionOf = (s: SetupCheckSelection): SetupCheckSelection => ({
  ...(s.connectionId && { connectionId: s.connectionId }),
  ...(s.connectorId && { connectorId: s.connectorId }),
  ...(s.mode && { mode: s.mode }),
  ...(s.audience && { audience: s.audience }),
});

/** The cached state of each check of the rendered guide, by check id; runs nothing. */
export const getSetupCheckStates = (
  orgId: string,
  ref: SetupGuideRef,
  s: SetupCheckSelection,
  signal?: AbortSignal,
) => {
  const query = new URLSearchParams(selectionOf(s) as Record<string, string>).toString();
  return apiFetch<{ results: Record<string, SetupCheckState> }>(
    `${checksPath(orgId, ref)}${query ? `?${query}` : ""}`,
    signal ? { signal } : {},
  );
};

/**
 * Runs one check unless a fresh result is cached; `force` (重新检查) reruns it, refused within the
 * cooldown (the cached state comes back with `cooldownUntil`). 429 `rate_limited` over the
 * per-account budget.
 */
export const runSetupCheck = (
  orgId: string,
  ref: SetupGuideRef,
  checkId: string,
  s: SetupCheckSelection & { force?: boolean },
) =>
  apiFetch<{ result: SetupCheckState }>(
    `${checksPath(orgId, ref)}/${encodeURIComponent(checkId)}/run`,
    {
      method: "POST",
      body: JSON.stringify({ ...selectionOf(s), ...(s.force && { force: true }) }),
    },
  );

/** A top-level thematic break line of serialized Markdown (the kernel writes `***`). */
const BREAK_LINE = /^ {0,3}([*_-])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * The blocks before the guide's last top-level thematic break (channel inbound mode fields spec §5):
 * what follows it is reference material for a saved target (Slack: Sign in with Slack, manifest
 * updates), not shown on 新建渠道. A guide without a break is returned whole. Prose blocks hold no
 * fenced code (the kernel splits code out), so a line of only `***` is a break.
 */
export function beforeReference(blocks: readonly SetupGuideBlock[]): SetupGuideBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind !== "markdown") continue;
    const lines = b.text.split("\n");
    let at = -1;
    for (let j = lines.length - 1; j >= 0; j--) {
      if (BREAK_LINE.test(lines[j] ?? "")) {
        at = j;
        break;
      }
    }
    if (at === -1) continue;
    const head = lines.slice(0, at).join("\n").trim();
    return [
      ...blocks.slice(0, i),
      ...(head === "" ? [] : [{ kind: "markdown" as const, text: head }]),
    ];
  }
  return [...blocks];
}
