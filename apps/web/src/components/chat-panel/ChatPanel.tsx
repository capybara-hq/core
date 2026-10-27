"use client";

import { Button, Stack, type TabItem, Tabs, Text } from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { artifactsOf } from "../../lib/artifacts";
import type { ChatItem } from "../../lib/stream";
import { listUiContributions, type UiContributionItem, uiKey, uiLocale } from "../../lib/ui";
import { useLoad } from "../../lib/use-load";
import type { ChatView } from "../ChatView";
import { SubagentView } from "../SubagentView";
import { ArtifactsTab } from "./ArtifactsTab";
import { ContextTab } from "./ContextTab";
import { EmbedTab } from "./EmbedTab";
import { ExtensionViewTab, useExtensionViews, useUiAction } from "./ExtensionViewTab";
import { RunTab, useArchivedOutputs } from "./RunTab";

/** 最后选中的标签（只是个人便利，存在浏览器本地；读写失败时忽略）。 */
export const PANEL_TAB_KEY = "cap.chat.panelTab";

function readTab(): string | undefined {
  try {
    return localStorage.getItem(PANEL_TAB_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeTab(id: string): void {
  try {
    localStorage.setItem(PANEL_TAB_KEY, id);
  } catch {
    // 隐私模式、禁用存储等：不记住即可
  }
}

const viewTab = (c: UiContributionItem) => `view:${uiKey(c.plugin, c.id)}`;
const embedTab = (c: UiContributionItem) => `embed:${uiKey(c.plugin, c.id)}`;

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/**
 * 对话页右侧面板（PlaygroundPage 的 Inspector）：顶部是运行状态与「停止」（`header`），下面一组标签：
 * 插件对话视图与嵌入应用（按贡献顺序；视图带插件给的 badge）、产物（agent 交付的文件，有产物时才显示，带数量）、
 * 运行（工具调用；有待批准的操作时带提醒）、
 * 上下文。插件标签各自取数、各自失败：一个插件慢了或挂了只影响它自己的标签，对话流照常。
 * 嵌入应用（`kind: "embed"`）在沙箱 iframe 里打开插件自己的页面（`EmbedTab`），只在选中时挂载。
 */
export function ChatPanel({
  orgId,
  conversationId,
  chat,
  header,
  subagent,
}: {
  orgId: string;
  conversationId: string;
  chat: ChatView;
  header: ReactNode;
  /** An open sub-agent: the panel shows its read-only view instead of the tabs. */
  subagent?: { id: string; onClose(): void };
}) {
  const t = useTranslations("chatPanel");
  const tc = useTranslations("common");
  const locale = uiLocale(useLocale());
  const contributions = useLoad(() => listUiContributions(orgId), [orgId]);
  const conversational = useMemo(
    () =>
      contributions.state.kind === "ready"
        ? contributions.state.data.items.filter((c) => c.place === "conversation")
        : [],
    [contributions.state],
  );
  const targets = useMemo(() => conversational.filter((c) => c.kind === "view"), [conversational]);
  const views = useExtensionViews(orgId, targets, {
    conversationId,
    locale,
    versions: chat.uiVersions,
  });
  const runAction = useUiAction(orgId, { conversationId, locale, onView: views.setView });
  // 运行标签取到的存档全文放在面板这一层：切到别的标签再回来不丢、不重取
  const outputs = useArchivedOutputs(orgId, conversationId);

  const tools = useMemo(
    () => chat.items.filter((i): i is ToolItem => i.kind === "tool"),
    [chat.items],
  );
  // 产物从日志重建：SSE 收到 artifact_created 时随 chat.events 实时更新
  const artifacts = useMemo(() => artifactsOf(chat.events), [chat.events]);
  const pendingApproval = chat.items.some((i) => i.kind === "approval" && i.decided === null);

  const items: TabItem[] = [
    ...conversational.map((c): TabItem => {
      if (c.kind === "embed") return { id: embedTab(c), label: c.title[locale] };
      const state = views.states[uiKey(c.plugin, c.id)];
      const badge = state?.kind === "ready" ? state.view.badge : undefined;
      return { id: viewTab(c), label: c.title[locale], ...(badge !== undefined && { badge }) };
    }),
    ...(artifacts.length > 0
      ? [{ id: "artifacts", label: t("artifacts"), count: artifacts.length } satisfies TabItem]
      : []),
    {
      id: "run",
      label: t("run"),
      ...(tools.length > 0 && { count: tools.length }),
      ...(pendingApproval && { alert: true }),
    },
    { id: "context", label: t("context") },
  ];

  // 挂载后再读本地存储：服务端渲染与水合时都没有它
  const [preferred, setPreferred] = useState<string>();
  useEffect(() => setPreferred(readTab()), []);
  // 记住的标签不在了（插件停用、贡献撤下）时回到「运行」；从没选过时取第一个标签
  const current =
    preferred === undefined
      ? items[0]?.id
      : items.some((i) => i.id === preferred)
        ? preferred
        : "run";
  const select = useCallback((id: string) => {
    setPreferred(id);
    writeTab(id);
  }, []);

  let content: ReactNode = null;
  if (current === "run") content = <RunTab tools={tools} outputs={outputs} />;
  else if (current === "artifacts") {
    content = <ArtifactsTab orgId={orgId} conversationId={conversationId} artifacts={artifacts} />;
  } else if (current === "context") {
    content = (
      <ContextTab
        orgId={orgId}
        conversationId={conversationId}
        agentName={chat.agentName}
        events={chat.events}
        contextWindowOf={chat.contextWindowOf}
      />
    );
  } else if (current?.startsWith("embed:")) {
    const c = conversational.find((x) => x.kind === "embed" && embedTab(x) === current);
    if (c !== undefined) {
      content = (
        <EmbedTab
          key={`${uiKey(c.plugin, c.id)}/${conversationId}`}
          orgId={orgId}
          plugin={c.plugin}
          id={c.id}
          title={c.title[locale]}
          conversationId={conversationId}
        />
      );
    }
  } else {
    const c = targets.find((x) => viewTab(x) === current);
    if (c !== undefined) {
      const key = uiKey(c.plugin, c.id);
      content = (
        <ExtensionViewTab
          key={key}
          state={views.states[key]}
          onRetry={() => views.retry(key)}
          onAction={runAction(c)}
        />
      );
    }
  }
  const label = items.find((i) => i.id === current)?.label ?? "";

  if (subagent !== undefined) {
    return (
      <Stack gap={12}>
        {header}
        <SubagentView
          key={subagent.id}
          orgId={orgId}
          subagentId={subagent.id}
          onClose={subagent.onClose}
        />
      </Stack>
    );
  }

  return (
    <Stack gap={12}>
      {header}
      {contributions.state.kind === "error" && (
        // 插件标签读不到：只提示，不影响运行 / 上下文标签与对话
        <Stack direction="row" gap={8} align="center" justify="between">
          <Text variant="small" tone="warn">
            {t("contributionsFailed")}
          </Text>
          <Button variant="ghost" onClick={contributions.reload}>
            {tc("retry")}
          </Button>
        </Stack>
      )}
      <Tabs label={t("label")} items={items} value={current ?? ""} onChange={select} />
      <div role="tabpanel" aria-label={label}>
        {content}
      </div>
    </Stack>
  );
}
