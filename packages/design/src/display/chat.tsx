import { type ReactNode, useId, useState } from "react";
import { Icon } from "../icons/icon";
import type { IconName } from "../icons/paths";
import { useDesignT } from "../provider";
import { StatusMark } from "./basic";

/* 对话时间线与渲染 schema 积木（spec §6.9）。只接收普通 props，不依赖 SDK 类型。 */

export type TimelineProps = {
  /** 列表的可访问名称（如「本轮步骤」）。 */
  label?: string;
  children?: ReactNode;
};

/**
 * 时间线容器：竖线串起各步，每步左侧一个标记。
 * @deprecated Superseded by the conversation components (spec §6.16); removed when the page moves over.
 */
export function Timeline({ label, children }: TimelineProps) {
  return (
    <ol className="cb-timeline" aria-label={label}>
      {children}
    </ol>
  );
}

export type TimelineMark = "dot" | "hollow" | "running" | "error";

export type TimelineItemProps = {
  /** dot：已完成步骤；hollow：思考 / 次要步骤；running：进行中（主色）；error：出错（fail）。 */
  mark: TimelineMark;
  children?: ReactNode;
};

/** @deprecated Superseded by the conversation components (spec §6.16). */
export function TimelineItem({ mark, children }: TimelineItemProps) {
  return (
    <li className="cb-timeline-item" data-mark={mark}>
      <span className="cb-timeline-mark" aria-hidden="true" />
      <div className="cb-timeline-body">{children}</div>
    </li>
  );
}

const fill = (tpl: string, n: number | string) => tpl.replace("{n}", String(n));

export type ToolCallStatus = "running" | "done" | "error" | "cancelled";

export type ToolCallRowLabels = {
  /** 状态文字，默认取 design 的 status.running / status.failed / status.cancelled。 */
  running?: string;
  error?: string;
  cancelled?: string;
  /** 输出被截断时的提示。 */
  truncated?: string;
  /** 「查看全部输出」按钮。 */
  showAll?: string;
  /** 传给 IN / OUT 块的展开 / 收起文案。 */
  io?: IoBlockLabels;
};

export type ToolCallRowProps = {
  /** 工具名（等宽、ink）。 */
  name: string;
  /** 一句说明（muted）；缺省时只显示工具名。 */
  summary?: string;
  status: ToolCallStatus;
  /** 输入原文（通常是格式化后的 JSON）。 */
  input: string;
  /** 输出原文；运行中可缺省。出错时放错误详情。 */
  output?: string;
  /** 输出已截断（全文在存档里）。与 onShowAll 一起出现「查看全部输出」。 */
  outputTruncated?: boolean;
  onShowAll?(): void;
  /** 初始是否展开（默认折叠，只显示一行）。 */
  defaultExpanded?: boolean;
  labels?: ToolCallRowLabels;
};

const STATUS_MARK = { running: "running", error: "failed", cancelled: "cancelled" } as const;

/** @deprecated Use ToolGroup / ToolRow (spec §6.16.8, §6.16.9). */
export function ToolCallRow({
  name,
  summary,
  status,
  input,
  output,
  outputTruncated,
  onShowAll,
  defaultExpanded = false,
  labels,
}: ToolCallRowProps) {
  const t = useDesignT();
  const [open, setOpen] = useState(defaultExpanded);
  const id = useId();
  // 状态文字缺省由 StatusMark 取 design 的 status.* 文案
  const statusLabel = status === "done" ? undefined : labels?.[status];
  return (
    <div className="cb-toolcall" data-status={status}>
      <button
        type="button"
        className="cb-row-toggle cb-toolcall-head"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cb-toolcall-name">{name}</span>
        {summary ? <span className="cb-toolcall-summary">{summary}</span> : null}
        {status !== "done" ? (
          <span className="cb-toolcall-status">
            <StatusMark
              status={STATUS_MARK[status]}
              {...(statusLabel !== undefined ? { label: statusLabel } : {})}
            />
          </span>
        ) : null}
        <span className="cb-row-caret" aria-hidden="true">
          <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
        </span>
      </button>
      {open ? (
        <div id={id} className="cb-toolcall-detail">
          <IoBlock label="IN" text={input} labels={labels?.io} />
          {output !== undefined ? <IoBlock label="OUT" text={output} labels={labels?.io} /> : null}
          {outputTruncated ? (
            <div className="cb-toolcall-truncated">
              <span>{labels?.truncated ?? t("chat.outputTruncated")}</span>
              {onShowAll ? (
                <button type="button" className="cb-row-link" onClick={onShowAll}>
                  {labels?.showAll ?? t("chat.showAllOutput")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type IoBlockLabels = {
  /** 「展开全部」按钮，`{n}` 为总行数。 */
  expand?: string;
  collapse?: string;
};

export type IoBlockProps = {
  label: "IN" | "OUT";
  text: string;
  /** 超过此行数时折叠，默认 12。 */
  collapsedLines?: number;
  labels?: IoBlockLabels | undefined;
};

/** @deprecated Use ToolRow's expanded detail (spec §6.16.9). */
export function IoBlock({ label, text, collapsedLines = 12, labels }: IoBlockProps) {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  const id = useId();
  const all = text.split("\n");
  const limit = Math.max(1, Math.floor(collapsedLines));
  const overflow = all.length > limit;
  const shown = overflow && !open ? all.slice(0, limit).join("\n") : text;
  return (
    <div className="cb-io" data-label={label}>
      <span className="cb-io-label">{label}</span>
      <div className="cb-io-body">
        <pre id={id} className="cb-io-text" data-collapsed={overflow && !open ? "true" : undefined}>
          {shown}
        </pre>
        {overflow ? (
          <button
            type="button"
            className="cb-row-link"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((o) => !o)}
          >
            {open
              ? (labels?.collapse ?? t("chat.collapse"))
              : fill(labels?.expand ?? t("chat.expandAll"), all.length)}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export type ChecklistStatus = "pending" | "in_progress" | "completed";

export type ChecklistProps = {
  items: { text: string; status: ChecklistStatus }[];
  /** 列表的可访问名称。 */
  label?: string;
};

const CHECK_ICON: Record<ChecklistStatus, IconName> = {
  pending: "square",
  in_progress: "spinner",
  completed: "check",
};

/** 任务清单：进行中项主色高亮（aria-current="step"），已完成项划线（<s>）。 */
export function Checklist({ items, label }: ChecklistProps) {
  const t = useDesignT();
  return (
    <ul className="cb-tasklist" aria-label={label}>
      {items.map((it, i) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: 清单顺序由调用方给定，文本可能重复
          key={i}
          className="cb-tasklist-item"
          data-status={it.status}
          aria-current={it.status === "in_progress" ? "step" : undefined}
        >
          <span className="cb-tasklist-glyph" aria-hidden="true">
            <Icon name={CHECK_ICON[it.status]} size={14} />
          </span>
          <span className="cb-sr-only">{t(`checklist.${it.status}`)}</span>
          {it.status === "completed" ? (
            <s className="cb-tasklist-text">{it.text}</s>
          ) : (
            <span className="cb-tasklist-text">{it.text}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

export type CodeBlockProps = {
  language?: string;
  text: string;
};

/** 代码块：等宽、保留空白、横向滚动；不做语法高亮。 */
export function CodeBlock({ language, text }: CodeBlockProps) {
  return (
    <figure className="cb-code">
      {language ? <figcaption className="cb-code-lang">{language}</figcaption> : null}
      <pre className="cb-code-pre">
        <code data-language={language}>{text}</code>
      </pre>
    </figure>
  );
}

export type ImageBlockProps = {
  src: string;
  alt: string;
};

/** 只认 http(s) 绝对地址。 */
function isHttpUrl(src: string): boolean {
  try {
    const u = new URL(src);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 图片（插件视图）：宽度不超出容器、按比例缩放；不带 referrer、懒加载。
 * 只渲染 http(s) 绝对地址，其他（`javascript:`、`data:`、相对路径）什么都不渲染。
 */
export function ImageBlock({ src, alt }: ImageBlockProps) {
  if (!isHttpUrl(src)) return null;
  return (
    <img className="cb-image" src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" />
  );
}
