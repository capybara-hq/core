import { type DesignKey, type Locale, messages } from "../i18n";

/** Tool kinds for display (kernel `ToolInfo.kind`). */
export type ToolKind = "command" | "read" | "edit" | "search" | "connector" | "meta" | "tool";

/** The verb categories of the §7 table: search, meta and connector rows count with tools. */
export type ToolVerbGroup = "command" | "read" | "edit" | "tool";

export function verbGroup(kind: ToolKind): ToolVerbGroup {
  return kind === "command" || kind === "read" || kind === "edit" ? kind : "tool";
}

/** The row verb of a kind ("已运行", "Used" …). */
export function rowVerb(kind: ToolKind, locale: Locale): string {
  const k = kind === "connector" ? "tool" : kind;
  return messages[locale][`tool.verb.${k}` as DesignKey];
}

export type SummaryRow = {
  kind: ToolKind;
  status: "pending" | "running" | "done" | "failed" | "cancelled";
  keyArg?: string;
  added?: number;
  removed?: number;
};

/** One run of the group header text; `part` names the size-table part it carries. */
export type SummaryPart = {
  text: string;
  tone?: "ink" | "fail" | "faint";
  part?: "key-arg" | "fail-word";
};

const fmt = (tpl: string, vars: Record<string, string | number>) =>
  tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The group header (§6.16.8, §7) as styled runs. */
export function summaryParts(rows: readonly SummaryRow[], locale: Locale): SummaryPart[] {
  const m = messages[locale];
  const running = rows.find((r) => r.status === "running" || r.status === "pending");
  if (running) {
    const done = rows.filter((r) => r.status !== "running" && r.status !== "pending").length;
    return [
      { text: m[`tool.running.${verbGroup(running.kind)}` as DesignKey] },
      { text: fmt(m["tool.doneCount"], { n: done }), tone: "faint" },
    ];
  }
  const order: ToolVerbGroup[] = [];
  const by = new Map<ToolVerbGroup, SummaryRow[]>();
  for (const r of rows) {
    const g = verbGroup(r.kind);
    if (!by.has(g)) {
      by.set(g, []);
      order.push(g);
    }
    by.get(g)?.push(r);
  }
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

/** Elapsed time of a running call as `m:ss`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export { fmt as fillCopy };
