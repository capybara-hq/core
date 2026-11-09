"use client";

import {
  Button,
  type Column,
  DataTable,
  FormSection,
  Icon,
  IconButton,
  Stack,
  Subsection,
  Switch,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { updateDeploymentSettings } from "../lib/admin";
import { updateOrgSettings } from "../lib/org-settings";
import { retryOnMountOf } from "../lib/query/client";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { adminUiArrangementQuery, invalidateOrgUiLists, uiArrangementQuery } from "../lib/query/ui";
import { type UiArrangementEntry, type UiArrangementSlot, uiLocale } from "../lib/ui";
import type { UiSlotId } from "../lib/ui-slots.generated";
import { useErrorMessage } from "../lib/use-error-message";

/** The message key of a slot's name (an id has dots, which a message path cannot hold). */
const SLOT_NAME: Record<UiSlotId, string> = {
  "conversation.panel": "conversationPanel",
  "conversation.properties.section": "conversationProperties",
  "conversation.tool-result.card": "conversationCard",
  "org.page": "orgPage",
  "file.preview": "filePreview",
  "agent.detail.section": "agentSection",
  "org.settings.section": "orgSettingsSection",
  "platform.page": "platformPage",
  "shell.brand": "shellBrand",
  "shell.overlay": "shellOverlay",
  "conversation.empty": "conversationEmpty",
  "conversation.composer.frame": "composerFrame",
};

type Item = UiArrangementSlot["items"][number];
const keyOf = (i: Item) => `${i.plugin}/${i.id}`;

/** The entry that says what the listing shows now: every key in order, the hidden ones. */
const entryOf = (items: Item[]): UiArrangementEntry => ({
  hidden: items.filter((i) => i.hidden).map(keyOf),
  order: items.map(keyOf),
});

/** Swaps an item with its neighbour of the same anchor (an order never crosses anchors). */
function neighbour(items: Item[], i: number, dir: -1 | 1): number | null {
  for (let j = i + dir; j >= 0 && j < items.length; j += dir) {
    if (items[j]?.after === items[i]?.after) return j;
  }
  return null;
}

/**
 * 界面位置: per slot the extension contributions the scope lists, with a hide switch and up / down.
 * "Hidden" means not listed (a direct link still opens). `scope` is an org (org admins write; below
 * admin it is read only) or the platform default (super admins, on the deployment settings page);
 * every change is saved at once (PATCH / PUT) and refreshes the lists that render the slots.
 */
export function UiArrangementSection({
  scope,
  canEdit,
}: {
  scope: { kind: "org"; orgId: string } | { kind: "platform" };
  canEdit: boolean;
}) {
  const t = useTranslations("uiArrangement");
  const locale = uiLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const q = scope.kind === "org" ? uiArrangementQuery(scope.orgId) : adminUiArrangementQuery();
  const slots = (useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data ?? []).filter(
    (s) => s.items.length > 0,
  );
  const put = useAppMutation({
    fn: async (patch: Record<string, UiArrangementEntry | null>) => {
      if (scope.kind === "org") await updateOrgSettings(scope.orgId, { uiArrangement: patch });
      else await updateDeploymentSettings({ uiArrangement: patch });
    },
    invalidates: () =>
      scope.kind === "org"
        ? [
            keys.org(scope.orgId).uiArrangement(),
            keys.org(scope.orgId).contributions(),
            keys.org(scope.orgId).extensionPages(),
          ]
        : [keys.deployment().uiArrangement(), keys.deployment().uiContributions()],
    // the platform default changes what every org lists
    onSuccess: () => (scope.kind === "platform" ? invalidateOrgUiLists(qc) : undefined),
  });
  const [busy, setBusy] = useState(false);
  if (slots.length === 0) return null;

  async function save(slot: UiSlotId, entry: UiArrangementEntry | null) {
    setBusy(true);
    try {
      await put.mutateAsync({ [slot]: entry });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const table = (s: UiArrangementSlot, slotName: string) => {
    const items = s.items;
    const columns: Column<Item>[] = [
      { key: "title", header: t("columns.title"), cell: (r) => r.title[locale] },
      { key: "extension", header: t("columns.extension"), tone: "muted", cell: (r) => r.plugin },
      canEdit
        ? {
            key: "hidden",
            header: t("columns.hidden"),
            interactive: true,
            fit: true,
            cell: (r) => (
              <Switch
                label={t("hideLabel", { name: r.title[locale] })}
                checked={r.hidden}
                disabled={busy}
                onChange={(on) =>
                  void save(s.slot, {
                    ...entryOf(items),
                    hidden: items.filter((x) => (x === r ? on : x.hidden)).map(keyOf),
                  })
                }
              />
            ),
          }
        : {
            key: "hidden",
            header: t("columns.hidden"),
            fit: true,
            cell: (r) => (r.hidden ? t("hiddenState") : t("shownState")),
          },
      ...(canEdit
        ? [
            {
              key: "move",
              header: t("columns.move"),
              interactive: true,
              fit: true,
              cell: (r: Item) => {
                const i = items.indexOf(r);
                const up = neighbour(items, i, -1);
                const down = neighbour(items, i, 1);
                const move = (to: number) => {
                  const next = [...items];
                  const [m] = next.splice(i, 1);
                  next.splice(to, 0, m as Item);
                  void save(s.slot, { ...entryOf(items), order: next.map(keyOf) });
                };
                const name = r.title[locale];
                return (
                  <Stack direction="row" gap={4}>
                    <IconButton
                      label={t("moveUp", { name })}
                      icon={<Icon name="arrow-up" size={14} />}
                      disabled={busy || up === null}
                      onClick={() => up !== null && move(up)}
                    />
                    <IconButton
                      label={t("moveDown", { name })}
                      icon={<Icon name="arrow-down" size={14} />}
                      disabled={busy || down === null}
                      onClick={() => down !== null && move(down)}
                    />
                  </Stack>
                );
              },
            } satisfies Column<Item>,
          ]
        : []),
    ];
    // where this slot's entry comes from: an org follows the platform until it arranges the slot
    const follows = scope.kind === "org" && s.source !== "org";
    const own = s.source === (scope.kind === "org" ? "org" : "platform");
    return (
      <Subsection
        key={s.slot}
        variant="flush"
        title={slotName}
        count={items.length}
        description={follows && s.source === "platform" ? t("followsPlatform") : undefined}
        actions={
          canEdit && own ? (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void save(s.slot, null)}
              aria-label={t("resetLabel", { slot: slotName })}
            >
              {scope.kind === "org" ? t("resetOrg") : t("resetPlatform")}
            </Button>
          ) : undefined
        }
      >
        <DataTable<Item>
          label={slotName}
          columns={columns}
          rows={items}
          rowKey={keyOf}
          rowLabel={(r) => r.title[locale]}
        />
      </Subsection>
    );
  };

  return (
    <FormSection
      id="ui-arrangement"
      flush
      title={t("title")}
      description={canEdit ? t("description") : t("descriptionReadonly")}
    >
      {slots.map((s) => table(s, t(`slots.${SLOT_NAME[s.slot]}`)))}
    </FormSection>
  );
}
