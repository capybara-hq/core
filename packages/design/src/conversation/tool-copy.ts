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
  | "question"
  | "tool";

/** What a call waits for from a person (§6.16.9): an approval, an answer or a connection. */
export type ToolWaiting = "approval" | "input" | "connect";

/** The verb categories of the §7 table: search, meta, question and connector rows count with tools. */
export type ToolVerbGroup = "command" | "read" | "edit" | "tool";

export function verbGroup(kind: ToolKind): ToolVerbGroup {
  return kind === "command" || kind === "read" || kind === "edit" ? kind : "tool";
}

export type SummaryRow = {
  kind: ToolKind;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  /** The call waits for a person (only read while it runs). */
  waiting?: ToolWaiting;
  keyArg?: string;
  added?: number;
  removed?: number;
};

/** One run of the group header text; `part` names the size-table part it carries. */
export type SummaryPart = {
  text: string;
  tone?: "ink" | "fail" | "faint" | "accent";
  part?: "key-arg" | "fail-word" | "waiting-word";
};

const fmt = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The fixed order of the header's kinds, as reference set B draws it (§7). */
const SUMMARY_ORDER: readonly ToolVerbGroup[] = ["command", "tool", "read", "edit"];

/** The group header (§6.16.8, §7) as styled runs. */
export function summaryParts(rows: readonly SummaryRow[], locale: Locale): SummaryPart[] {
  const m = messages[locale];
  const active = rows.filter((r) => r.status === "running" || r.status === "pending");
  const running = active.find((r) => r.waiting === undefined) ?? active[0];
  if (running) {
    const done = rows.length - active.length;
    // Every live call waits for a person: say so instead of a running verb (§6.16.8).
    if (running.waiting !== undefined) {
      return [
        {
          text: m[`tool.waiting.${running.waiting}` as DesignKey],
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
  const failed = rows.filter((r) => r.status === "failed").length;
  if (failed > 0)
    out.push({ text: fmt(m["tool.failedCount"], { n: failed }), tone: "fail", part: "fail-word" });
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

/** Elapsed time of a running call: "12 秒" / "1 分 03 秒", "12s" / "1m 03s". */
export function elapsed(ms: number, locale: Locale): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  const t = messages[locale];
  if (m === 0) return fmt(t["tool.elapsedS"], { s });
  return fmt(t["tool.elapsedMS"], { m, s: String(s).padStart(2, "0") });
}

export { fmt as fillCopy };
