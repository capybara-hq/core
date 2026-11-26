import { formatBytes } from "../display/attachments";
import { type DesignKey, type Locale, messages } from "../i18n";

/**
 * Tool kinds for display: the kernel's `ToolInfo.kind`, plus `question`, which the web derives
 * for the builtin `AskUserQuestion` (its row reads "已提问 <header>", §6.16.9).
 */
export type ToolKind =
  | "command"
  | "read"
  | "edit"
  | "search"
  | "connector"
  | "meta"
  /** Reading background tasks (`TaskOutput`, `TaskList`): waiting on one is not reading a file. */
  | "task"
  | "question"
  | "tool";

/**
 * Why a guard refused a done call (§6.16.9): `not_read`, the file was never read in the
 * conversation; `modified`, it changed since. The guard working, not a failure.
 */
export type ToolGuard = "not_read" | "modified";

/**
 * A protocol notice on a done call (§6.16.9): `not_loaded`, the call named a tool that the step's
 * request did not carry (the catalog holds it), so the kernel answered "load it first" and the
 * model retried in the next step; `reconciling`, a background start the kernel sent but could not
 * confirm, which it is reconciling until the task is confirmed running or ends. Expected
 * behaviour, not a failure: the row adds a neutral word.
 */
export type ToolNotice = "not_loaded" | "reconciling";

/**
 * The kind of a boundary crossing Auto granted by itself (§6.16.9): a directory outside the
 * scope, a new host on an allowlist, one call run outside the sandbox, or a sensitive command.
 */
export type ToolAutoGranted = "directory" | "host" | "outside-sandbox" | "sensitive";

/** What a call waits for from a person (§6.16.9): an approval, an answer or a connection. */
export type ToolWaiting = "approval" | "input" | "connect";

/**
 * The verb categories of the §7 table: search, meta, question and connector rows count with tools;
 * background task reads (`task`) have their own.
 */
export type ToolVerbGroup = "command" | "task" | "read" | "edit" | "tool";

export function verbGroup(kind: ToolKind): ToolVerbGroup {
  return kind === "command" || kind === "task" || kind === "read" || kind === "edit"
    ? kind
    : "tool";
}

/**
 * A call's status (§6.16.9). `streaming`: the model is still writing the call's input; nothing runs
 * yet (streaming tool input spec §6.4).
 */
export type ToolStatus = "streaming" | "pending" | "running" | "done" | "failed" | "cancelled";

/**
 * A streaming call's progress (§6.16.9): the lines of the text being written when the input view
 * counts them, and the input's size so far. `generic`: a tool without an input view, worded
 * "Writing input" (zh and en copy in i18n).
 */
export type ToolStreamProgress = { lines?: number; bytes: number; generic?: boolean };

/** "Writing · 86 lines · 2.7 KB" / "Writing input · 1.2 KB" (§6.16.9). */
export function streamProgressText(p: ToolStreamProgress, locale: Locale): string {
  const m = messages[locale];
  const parts = [m[p.generic ? "tool.streamingInput" : "tool.streaming"]];
  if (p.lines !== undefined && !p.generic) {
    parts.push(
      p.lines === 1
        ? m["tool.streamLines1"]
        : fmt(m["tool.streamLines"], {
            n: p.lines.toLocaleString(locale === "zh" ? "zh-CN" : "en-US"),
          }),
    );
  }
  parts.push(formatBytes(p.bytes));
  return parts.join(" · ");
}

export type SummaryRow = {
  kind: ToolKind;
  status: ToolStatus;
  /** A done call the read-before-write check refused (§6.16.9): counted apart, never failed. */
  guard?: ToolGuard;
  /** A done call with a protocol notice (§6.16.9): never failed, not counted apart either. */
  notice?: ToolNotice;
  /** The call waits for a person (only read while it runs). */
  waiting?: ToolWaiting;
  /** Who it waits for when that is not the viewer (a name or a role); absent = "you". */
  waitingFor?: string;
  keyArg?: string;
  added?: number;
  removed?: number;
};

/** One run of the group header text; `part` names the size-table part it carries. */
export type SummaryPart = {
  /** The run's text; for an error mark, its plain form (accessible names, tests). */
  text: string;
  tone?: "ink" | "faint" | "accent";
  part?: "key-arg" | "waiting-word";
  /**
   * The calls that returned an error (§6.16.8): drawn as the error dot and the count, not as
   * words; `label` is the dot's accessible name and tooltip.
   */
  errors?: { count: number; label: string };
};

const fmt = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The fixed order of the header's kinds, as reference set B draws it (§7). */
const SUMMARY_ORDER: readonly ToolVerbGroup[] = ["command", "task", "tool", "read", "edit"];

/**
 * The waiting word (§6.16.9): "等待你批准" for the viewer, "等待 张三 批准" when someone else (a
 * name or a role) has to act.
 */
export function waitingText(what: ToolWaiting, who: string | undefined, locale: Locale): string {
  const m = messages[locale];
  return who === undefined
    ? m[`tool.waiting.${what}` as DesignKey]
    : fmt(m[`tool.waiting.${what}By` as DesignKey], { who });
}

/** The group header (§6.16.8, §7) as styled runs. */
export function summaryParts(rows: readonly SummaryRow[], locale: Locale): SummaryPart[] {
  const m = messages[locale];
  // a streaming call counts as running (§6.16.9): its input is being written
  const active = rows.filter(
    (r) => r.status === "running" || r.status === "pending" || r.status === "streaming",
  );
  const running = active.find((r) => r.waiting === undefined) ?? active[0];
  if (running) {
    const done = rows.length - active.length;
    // Every live call waits for a person: say so instead of a running verb (§6.16.8).
    if (running.waiting !== undefined) {
      return [
        {
          text: waitingText(running.waiting, running.waitingFor, locale),
          tone: "accent",
          part: "waiting-word",
        },
        { text: fmt(m["tool.doneCount"], { n: done }), tone: "faint" },
      ];
    }
    return [
      { text: m[`tool.running.${verbGroup(running.kind)}` as DesignKey] },
      { text: fmt(m["tool.doneCount"], { n: done }), tone: "faint" },
    ];
  }
  const by = new Map<ToolVerbGroup, SummaryRow[]>();
  for (const r of rows) {
    const g = verbGroup(r.kind);
    by.set(g, [...(by.get(g) ?? []), r]);
  }
  const order = SUMMARY_ORDER.filter((g) => by.has(g));
  const out: SummaryPart[] = [];
  order.forEach((g, i) => {
    const list = by.get(g) ?? [];
    if (i > 0) out.push({ text: m["tool.join"] });
    const adjust = (s: string) => (i > 0 && locale === "en" ? lowerFirst(s) : s);
    const first = list[0]?.keyArg;
    const one =
      (g === "read" || g === "edit") &&
      first !== undefined &&
      first !== "" &&
      list.every((r) => r.keyArg === first);
    if (one) {
      out.push({ text: `${adjust(m[`tool.verb.${g}` as DesignKey])} ` });
      out.push({ text: first, tone: "ink", part: "key-arg" });
      return;
    }
    const key = (list.length === 1 ? `tool.count.${g}1` : `tool.count.${g}`) as DesignKey;
    out.push({ text: adjust(fmt(m[key], { n: list.length })) });
  });
  // calls that returned an error: a calm mark (the error dot and the count), never an alarm word;
  // the agent often corrects such a step itself on the next call
  const failed = rows.filter((r) => r.status === "failed").length;
  if (failed > 0) {
    const label = failed === 1 ? m["tool.errorCount1"] : fmt(m["tool.errorCount"], { n: failed });
    out.push({ text: ` · ${label}`, errors: { count: failed, label } });
  }
  // refused by a guard: told apart in the header's own color, never as a failure
  const guarded = rows.filter((r) => r.status === "done" && r.guard !== undefined).length;
  if (guarded > 0) out.push({ text: fmt(m["tool.guardedCount"], { n: guarded }) });
  const edits = by.get("edit") ?? [];
  if (edits.some((r) => r.added !== undefined || r.removed !== undefined)) {
    const a = edits.reduce((n, r) => n + (r.added ?? 0), 0);
    const d = edits.reduce((n, r) => n + (r.removed ?? 0), 0);
    out.push({ text: ` · +${a} −${d}`, tone: "faint" });
  }
  return out;
}

/** The group header as plain text (accessible names, tests). */
export function summarizeTools(rows: readonly SummaryRow[], locale: Locale): string {
  return summaryParts(rows, locale)
    .map((p) => p.text)
    .join("");
}

export { fmt as fillCopy };
