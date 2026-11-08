"use client";

import {
  BarChart,
  Button,
  Checklist,
  CodeBlock,
  type Column,
  DangerConfirm,
  DataTable,
  EmptyState,
  ImageBlock,
  KeyValue,
  Markdown,
  Sparkline,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { buildAnswer, type FormDraft, initialDraft } from "../../lib/questions";
import {
  cellOf,
  isHttpUrl,
  type UiActionRequest,
  type UiBlock,
  type UiOpen,
  type UiView,
} from "../../lib/ui";
import { InputFormFields } from "../QuestionCard";

/** 提交一个动作；失败时以 toast 显示原因，`quiet` 时不弹（危险按钮的失败显示在确认对话框里）。 */
type Run = (req: UiActionRequest, opts?: { quiet?: boolean }) => Promise<void>;

/** 图表的可访问名称：逐点列出「标签: 值」。 */
const chartLabel = (series: { label: string; value: number }[]) =>
  series.map((p) => `${p.label}: ${p.value}`).join(", ");

type ButtonSpec = Extract<UiBlock, { type: "actions" }>["buttons"][number];

/** 一个按钮：危险按钮先经 DangerConfirm（输入按钮文字）二次确认。 */
function ActionButton({ spec, busy, run }: { spec: ButtonSpec; busy: boolean; run: Run }) {
  const t = useTranslations("ui");
  const [confirming, setConfirming] = useState(false);
  const req: UiActionRequest = {
    actionId: spec.actionId,
    ...(spec.payload !== undefined && { payload: spec.payload }),
  };
  if (!spec.danger) {
    return (
      <Button disabled={busy} onClick={() => void run(req).catch(() => {})}>
        {spec.label}
      </Button>
    );
  }
  return (
    <>
      <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
        {spec.label}
      </Button>
      <DangerConfirm
        open={confirming}
        onOpenChange={setConfirming}
        title={spec.label}
        description={t("dangerDescription")}
        confirmName={spec.label}
        confirmLabel={spec.label}
        onConfirm={async () => {
          // 失败时 DangerConfirm 保持打开并显示原因
          await run(req, { quiet: true });
          setConfirming(false);
        }}
      />
    </>
  );
}

type FormBlock = Extract<UiBlock, { type: "form" }>;

/** 表单块：复用对话里的 InputForm 渲染器；必填项为空时只标出，不提交。 */
function FormView({ block, busy, run }: { block: FormBlock; busy: boolean; run: Run }) {
  const [draft, setDraft] = useState<FormDraft>(() => initialDraft(block.form));
  const [missing, setMissing] = useState<string[]>([]);
  const submit = () => {
    const built = buildAnswer(block.form, draft);
    setMissing(built.missing);
    if (built.missing.length > 0) return;
    void run({ actionId: block.actionId, answer: built.answer }).catch(() => {});
  };
  return (
    <Stack gap={12}>
      <InputFormFields
        form={block.form}
        draft={draft}
        onChange={setDraft}
        missing={missing}
        disabled={busy}
      />
      <Stack direction="row" gap={8}>
        {/* 对话里唯一的主操作是输入框的「发送」：插件视图不用主按钮 */}
        <Button variant="secondary" loading={busy} onClick={submit}>
          {block.submitLabel}
        </Button>
      </Stack>
    </Stack>
  );
}

type Row = { i: number; cells: Record<string, string> };

/** A list block with nothing in it: a checklist or key-value list without items, a table without rows. */
function isEmptyListBlock(block: UiBlock): boolean {
  if (block.type === "checklist" || block.type === "keyValue") return block.items.length === 0;
  if (block.type === "table") return block.rows.length === 0;
  return false;
}

/**
 * A view with nothing to show: no blocks, or only list blocks without items (the todo panel with no
 * tasks). The host then draws one empty state in place of the blocks.
 */
function isEmptyView(view: UiView): boolean {
  return view.blocks.every(isEmptyListBlock);
}

function Block({
  block,
  busy,
  run,
  onOpen,
  emptyText,
}: {
  block: UiBlock;
  busy: boolean;
  run: Run;
  onOpen: ((target: UiOpen) => void) | undefined;
  emptyText: string;
}): ReactNode {
  // An empty checklist or key-value list among other blocks: the panel empty state in its place
  // (spec §6.18); the UiView contract has no empty text, so the host's generic sentence.
  if ((block.type === "checklist" || block.type === "keyValue") && block.items.length === 0)
    return <EmptyState size="panel" text={emptyText} />;
  switch (block.type) {
    case "heading":
      return (
        <Text variant="h2" as="h3">
          {block.text}
        </Text>
      );
    case "text":
      // The design Markdown rules: raw HTML is text, links are http(s) only.
      return <Markdown text={block.markdown} />;
    case "checklist":
      return (
        <Checklist
          items={block.items.map((it) => {
            const target = it.open;
            return {
              text: it.text,
              status: it.status,
              ...(it.id !== undefined ? { id: it.id } : {}),
              ...(target && onOpen ? { onOpen: () => onOpen(target) } : {}),
            };
          })}
        />
      );
    case "keyValue":
      return (
        <KeyValue keyWidth="12ch" rows={block.items.map((it) => ({ k: it.label, v: it.value }))} />
      );
    case "table": {
      const columns: Column<Row>[] = block.columns.map((c) => ({
        key: c.key,
        header: c.label,
        cell: (r) => cellOf(r.cells, c.key),
      }));
      return (
        <DataTable
          label={block.columns.map((c) => c.label).join(" / ")}
          columns={columns}
          rows={block.rows.map((cells, i) => ({ i, cells }))}
          rowKey={(r) => String(r.i)}
          empty={{ title: emptyText }}
        />
      );
    }
    case "code":
      return (
        <CodeBlock text={block.text} {...(block.language ? { language: block.language } : {})} />
      );
    case "image":
      return isHttpUrl(block.url) ? <ImageBlock src={block.url} alt={block.alt} /> : null;
    case "chart":
      return block.kind === "bar" ? (
        <BarChart
          label={chartLabel(block.series)}
          series={block.series.map((p) => ({ value: p.value }))}
        />
      ) : (
        <Sparkline label={chartLabel(block.series)} values={block.series.map((p) => p.value)} />
      );
    case "actions":
      return (
        <Stack direction="row" gap={8} wrap>
          {block.buttons.map((b) => (
            <ActionButton key={b.actionId} spec={b} busy={busy} run={run} />
          ))}
        </Stack>
      );
    case "form":
      return <FormView block={block} busy={busy} run={run} />;
    default:
      return null;
  }
}

/**
 * 插件视图（渲染 schema）：每种块映射到 design 组件，插件写不了样式也执行不了代码。
 * 按钮与表单经 `onAction` 提交（由调用方 POST `.../ui/actions`，处理返回的视图 / 提示）；
 * `onAction` 失败时以 toast 显示原因（危险按钮的失败显示在确认对话框里）。
 */
export function UiViewRenderer({
  view,
  onAction,
  onOpen,
  emptySize = "panel",
}: {
  view: UiView;
  onAction(req: UiActionRequest): Promise<void>;
  /** Opens an item's open target (an extension's right panel scrolled to an item). */
  onOpen?(target: UiOpen): void;
  /**
   * The empty state's style when the view has nothing to show (spec §6.18): `panel` (default) in a
   * box (a properties section, a right panel, an inline card, a file preview); `page` for an
   * extension's own page.
   */
  emptySize?: "page" | "panel";
}) {
  const t = useTranslations("ui");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run: Run = async (req, opts) => {
    setBusy(true);
    try {
      await onAction(req);
    } catch (e) {
      if (!opts?.quiet && e instanceof Error && e.message !== "") toast.error(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  // Nothing to show (no blocks, or only empty lists): one empty state instead of a blank body
  if (isEmptyView(view)) return <EmptyState size={emptySize} text={t("empty")} />;
  return (
    <Stack gap={12}>
      {view.blocks.map((block, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 块的顺序由插件给定，没有稳定 id
        <div key={i} data-block={block.type}>
          <Block block={block} busy={busy} run={run} onOpen={onOpen} emptyText={t("empty")} />
        </div>
      ))}
    </Stack>
  );
}
