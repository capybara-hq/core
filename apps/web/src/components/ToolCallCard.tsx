"use client";

import { ToolCallRow, type ToolCallStatus } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { formatInput } from "../lib/approvals";
import type { ChatItem } from "../lib/stream";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 对话流里展示的结果上限（内核已把超大结果转存并截为预览，这里再兜一次底）；运行标签显示全文。 */
export const RESULT_PREVIEW_CHARS = 4000;

/** 退回摘要里取输入的前几个字段，每个值至多这么多字符。 */
const SUMMARY_FIELDS = 2;
const SUMMARY_VALUE_CHARS = 40;

const clip = (s: string) =>
  s.length > SUMMARY_VALUE_CHARS ? `${s.slice(0, SUMMARY_VALUE_CHARS - 1)}…` : s;

/** 输入的前几个字段，如 `id: x1 · reason: cleanup`；输入不是对象时取其文本。 */
export function inputPreview(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object" || Array.isArray(input)) {
    return clip(typeof input === "string" ? input : (JSON.stringify(input) ?? ""));
  }
  return Object.entries(input as Record<string, unknown>)
    .slice(0, SUMMARY_FIELDS)
    .map(([k, v]) => `${k}: ${clip(typeof v === "string" ? v : (JSON.stringify(v) ?? ""))}`)
    .join(" · ");
}

/** 工具调用的一句说明：工具给的 `display.summary[locale]`，没有时退回输入的前几个字段。 */
export function toolSummary(item: ToolItem, locale: string): string {
  const summary = item.display?.summary;
  const text = summary === undefined ? undefined : locale === "zh" ? summary.zh : summary.en;
  return typeof text === "string" && text !== "" ? text : inputPreview(item.input);
}

/** 对话项的状态 → 工具调用行的状态（等待中按「运行中」画，文案另给）。 */
const ROW_STATUS: Record<ToolItem["status"], ToolCallStatus> = {
  pending: "running",
  running: "running",
  done: "done",
  error: "error",
  cancelled: "cancelled",
};

/**
 * 工具调用行（时间线里一行，默认折叠）：工具名 + 一句说明 + 非完成态的状态；展开为 IN / OUT。
 * `full` 时显示完整结果（运行标签），否则超过 {@link RESULT_PREVIEW_CHARS} 的结果只显示预览。
 * 结果已存档（内核截断）时给出存档 id。外层带 `data-call-id` 与 `data-status`；`data-role` 在对话流里为
 * `tool`，在运行标签里（`full`）为 `run-call`。
 */
export function ToolCallCard({
  item,
  full = false,
  archived,
  onShowAll,
}: {
  item: ToolItem;
  full?: boolean;
  /** 从存档取到的全文（运行标签）：有它时 OUT 显示全文、不再标为截断（`complete` 为 false 时仍标截断）。 */
  archived?: { text: string; complete: boolean };
  /** 结果已存档时「查看全部输出」：交给调用方取全文。 */
  onShowAll?(): void;
}) {
  const t = useTranslations("tools");
  const locale = useLocale();
  const result = archived?.text ?? item.result;
  const cut = !full && result !== null && result.length > RESULT_PREVIEW_CHARS;
  const output = result === null ? undefined : cut ? result.slice(0, RESULT_PREVIEW_CHARS) : result;
  const truncated = cut || (archived === undefined ? item.outputId !== null : !archived.complete);
  return (
    <div
      data-role={full ? "run-call" : "tool"}
      data-call-id={item.callId}
      data-status={item.status}
    >
      <ToolCallRow
        name={item.name}
        summary={toolSummary(item, locale)}
        status={ROW_STATUS[item.status]}
        input={formatInput(item.input)}
        {...(output !== undefined && { output })}
        outputTruncated={truncated}
        {...(onShowAll !== undefined && archived === undefined && { onShowAll })}
        labels={{
          running: t(`status.${item.status === "pending" ? "pending" : "running"}`),
          error: t("status.error"),
          cancelled: t("status.cancelled"),
          ...(item.outputId !== null && { truncated: t("outputId", { id: item.outputId }) }),
        }}
      />
    </div>
  );
}
