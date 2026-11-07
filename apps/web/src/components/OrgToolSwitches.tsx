"use client";

import {
  Button,
  Dialog,
  Skeleton,
  Stack,
  Subsection,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ApiClientError } from "../lib/api";
import { type AffectedToolAgent, putOrgToolSwitch } from "../lib/extensions";
import { orgExtensionChangeKeys } from "../lib/query/admin";
import { extensionToolsQuery } from "../lib/query/agents";
import { orgToolSwitchesQuery } from "../lib/query/channels";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/** A switch-off waiting for the person's confirmation: the agents it takes the tool from. */
interface Pending {
  tool: string;
  agents: AffectedToolAgent[];
  confirm: string;
  notice?: string;
}

/**
 * The single-tool switches of an extension in the org's Sheet (layering spec A §7). Org admins
 * switch a tool off after a preview that lists the agents using it (confirmed with the preview's
 * hash; a changed list shows again before it can be confirmed); members read the states only.
 * Hidden while the extension registers no tool.
 */
export function OrgToolSwitches({
  orgId,
  plugin,
  canEdit,
}: {
  orgId: string;
  plugin: string;
  canEdit: boolean;
}) {
  const t = useTranslations("extensions.toolSwitches");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = orgToolSwitchesQuery(orgId, plugin);
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  // The display titles the agent editors show; unreadable (or a key not offered): the raw name
  const offerQ = extensionToolsQuery(orgId);
  const offer = useQuery({ ...offerQ, retryOnMount: retryOnMountOf(offerQ.queryKey) });
  const titles = new Map(
    (offer.data?.extensions.find((e) => e.plugin === plugin)?.tools ?? []).flatMap((x) =>
      x.title === null ? [] : [[x.name, x.title] as const],
    ),
  );
  const labelOf = (tool: string) => titles.get(tool) ?? tool;
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | undefined>();
  const sw = useAppMutation({
    fn: (v: { tool: string; enabled: boolean; confirm?: string }) =>
      putOrgToolSwitch(orgId, plugin, v.tool, {
        enabled: v.enabled,
        ...(v.confirm !== undefined && { confirm: v.confirm }),
      }),
    invalidates: () => [
      keys.org(orgId).extensionToolSwitches(plugin),
      ...orgExtensionChangeKeys(orgId),
    ],
  });

  const turnOn = async (tool: string) => {
    setFailure(undefined);
    try {
      await sw.mutateAsync({ tool, enabled: true });
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };
  // The first off call answers the preview (or switches off at once when the call applies)
  const turnOff = async (tool: string) => {
    setFailure(undefined);
    try {
      const r = await sw.mutateAsync({ tool, enabled: false });
      if (!r.applied) setPending({ tool, agents: r.affectedAgents, confirm: r.confirm });
      else toast.success(t("off"));
    } catch (e) {
      setFailure(errorMessage(e));
    }
  };
  const confirmOff = async () => {
    if (pending === null) return;
    const { tool, confirm } = pending;
    try {
      const r = await sw.mutateAsync({ tool, enabled: false, confirm });
      if (!r.applied) {
        setPending({ tool, agents: r.affectedAgents, confirm: r.confirm });
        return;
      }
      setPending(null);
      toast.success(t("off"));
    } catch (e) {
      // The agents using the tool changed since the preview: show the new list first
      if (e instanceof ApiClientError && e.code === "plugin.switch_stale") {
        try {
          const again = await sw.mutateAsync({ tool, enabled: false });
          if (again.applied) setPending(null);
          else
            setPending({
              tool,
              agents: again.affectedAgents,
              confirm: again.confirm,
              notice: t("stale"),
            });
        } catch (e2) {
          setPending({ ...pending, notice: errorMessage(e2) });
        }
        return;
      }
      setPending({ ...pending, notice: errorMessage(e) });
    }
  };

  if (read.data === undefined) {
    if (read.error)
      return (
        <Subsection title={t("title")} variant="divided">
          <FormError message={t("loadFailed")} />
          <Stack direction="row">
            <Button density="dense" onClick={() => void read.refetch()}>
              {t("retry")}
            </Button>
          </Stack>
        </Subsection>
      );
    return (
      <Subsection title={t("title")} variant="divided">
        <Skeleton rows={2} />
      </Subsection>
    );
  }
  const tools = read.data.tools;
  if (tools.length === 0) return null;
  // A region of the extension's Sheet (spec §6.7), titled 工具
  return (
    <Subsection title={t("title")} variant="divided">
      {canEdit && (
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
      )}
      {tools.map((x) =>
        canEdit ? (
          <Stack key={x.tool} gap={0}>
            <Switch
              label={labelOf(x.tool)}
              checked={x.enabled}
              disabled={sw.isPending}
              onChange={(on) => void (on ? turnOn(x.tool) : turnOff(x.tool))}
            />
            {labelOf(x.tool) !== x.tool && (
              <Text variant="small" tone="faint">
                {x.tool}
              </Text>
            )}
          </Stack>
        ) : (
          <Stack key={x.tool} direction="row" gap={8}>
            <Text>{labelOf(x.tool)}</Text>
            {labelOf(x.tool) !== x.tool && (
              <Text variant="small" tone="faint">
                {x.tool}
              </Text>
            )}
            {!x.enabled && (
              <Text variant="small" tone="warn">
                {t("off")}
              </Text>
            )}
          </Stack>
        ),
      )}
      {failure !== undefined && <FormError message={failure} />}
      {pending !== null && (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t("offTitle", { tool: labelOf(pending.tool) })}
          danger
          initialFocus="cancel"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)}>
                {t("offCancel")}
              </Button>
              <Button
                variant="danger-solid"
                loading={sw.isPending}
                disabled={sw.isPending}
                onClick={() => void confirmOff()}
              >
                {t("offConfirm")}
              </Button>
            </>
          }
        >
          <Stack gap={12}>
            {pending.notice !== undefined && <FormError message={pending.notice} />}
            {pending.agents.length === 0 ? (
              <Text variant="prose">{t("offNoAgents")}</Text>
            ) : (
              <Stack gap={4}>
                <Text variant="small" tone="warn">
                  {t("offAgents")}
                </Text>
                {pending.agents.map((a) => (
                  <Text key={a.id} variant="small">{`· ${a.name}`}</Text>
                ))}
              </Stack>
            )}
          </Stack>
        </Dialog>
      )}
    </Subsection>
  );
}
