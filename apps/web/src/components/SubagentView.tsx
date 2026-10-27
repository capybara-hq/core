"use client";

import { Button, KeyValue, Stack, StatusMark, Text } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { Link } from "../i18n/navigation";
import type { ConversationEvent, SubagentToolRef } from "../lib/conversations";
import { useChat } from "./ChatView";
import { FormError } from "./form-error";
import { MessageList } from "./MessageList";

type Started = Extract<ConversationEvent, { type: "subagent_started" }>["payload"];

const toolName = (r: SubagentToolRef): string =>
  r.kind === "builtin" ? r.name : r.kind === "plugin" ? `${r.plugin}__${r.name}` : r.connectorId;

/**
 * A sub-agent opened read-only in the Inspector (phase C interim, spec §17; UI refresh B replaces
 * it with its right panel): back, status and stop, a line with its type, agent, model and tools,
 * then its own messages with the existing timeline (the task is its first message). It reads and
 * streams the child conversation through the same routes as any conversation; there is no
 * composer (a child is read-only; `POST …/messages` would be refused). An org agent sub-agent
 * shows that agent's name with a link to it.
 */
export function SubagentView({
  orgId,
  subagentId,
  onClose,
}: {
  orgId: string;
  subagentId: string;
  onClose(): void;
}) {
  const t = useTranslations("subagents.view");
  const tc = useTranslations("chat");
  const child = useChat(orgId, subagentId);
  const started = child.events.find(
    (e): e is Extract<ConversationEvent, { type: "subagent_started" }> =>
      e.type === "subagent_started",
  )?.payload as Started | undefined;
  let model: string | null = null;
  for (const e of child.events) {
    if (e.type === "run_started") model = `${e.payload.model.provider}/${e.payload.model.model}`;
  }
  const tools = (started?.definition.tools ?? []).map(toolName);
  const orgAgentId = started?.template.source === "agent" ? started.template.id : undefined;
  // an org agent: that agent's name; a template: the frozen "Parent › type" name
  const agentName =
    orgAgentId !== undefined
      ? (child.agentName ?? started?.definition.name ?? "—")
      : (started?.definition.name ?? child.agentName ?? "—");
  const active = child.running || child.waiting;
  const status = child.running ? (
    <StatusMark status="running" label={tc("running")} />
  ) : child.waiting ? (
    <StatusMark status="waiting" label={tc("waiting")} />
  ) : (
    <StatusMark status="success" label={tc("idle")} />
  );
  return (
    <section aria-label={t("title")}>
      <Stack gap={12}>
        <Stack direction="row" gap={8} align="center" justify="between">
          <Button variant="ghost" onClick={onClose}>
            {t("back")}
          </Button>
          <Stack direction="row" gap={8} align="center">
            {status}
            {active && (
              <Button onClick={child.stop} disabled={child.stopping}>
                {t("stop")}
              </Button>
            )}
          </Stack>
        </Stack>
        <KeyValue
          keyWidth="8ch"
          rows={[
            { k: t("type"), v: started?.agentType ?? "—" },
            {
              k: t("agent"),
              v:
                orgAgentId !== undefined ? (
                  <Link href={`/agents/${encodeURIComponent(orgAgentId)}`}>{agentName}</Link>
                ) : (
                  agentName
                ),
            },
            { k: t("model"), v: model ?? "—" },
            { k: t("tools"), v: tools.length > 0 ? tools.join(", ") : t("toolsNone") },
          ]}
        />
        <Text variant="small" tone="muted">
          {t("readOnly")}
        </Text>
        {child.error !== undefined && <FormError message={child.error} />}
        <MessageList orgId={orgId} items={child.items} reasoningOf={child.reasoningOf} />
      </Stack>
    </section>
  );
}
