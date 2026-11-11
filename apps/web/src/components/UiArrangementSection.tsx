"use client";

import {
  Button,
  type Column,
  DataTable,
  FormSection,
  Icon,
  IconButton,
  Select,
  Stack,
  Subsection,
  Switch,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { updateDeploymentSettings } from "../lib/admin";
import { updateOrgSettings } from "../lib/org-settings";
import { retryOnMountOf } from "../lib/query/client";
import { invalidateClientSets } from "../lib/query/client-extensions";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { adminUiArrangementQuery, invalidateOrgUiLists, uiArrangementQuery } from "../lib/query/ui";
import {
  isSingleArrangementSlot,
  type UiArrangementEntry,
  type UiArrangementListEntry,
  type UiArrangementListSlot,
  type UiArrangementSingleSlot,
  uiLocale,
} from "../lib/ui";
import type { UiSlotId } from "../lib/ui-slots.generated";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * The message key of a slot's name under `uiArrangement.slots` (an id has dots, which a message
 * path cannot hold).
 */
export const SLOT_NAME: Record<UiSlotId, string> = {
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

/** A slot's name in the UI locale (its id when the catalog has a slot this web does not know). */
export function useSlotName(): (slot: string) => string {
  const t = useTranslations("uiArrangement.slots");
  return (slot) => {
    const key = (SLOT_NAME as Record<string, string | undefined>)[slot];
    return key === undefined ? slot : t(key);
  };
}

type Item = UiArrangementListSlot["items"][number];
const keyOf = (i: Item) => `${i.plugin}/${i.id}`;

/** The entry that says what the listing shows now: every key in order, the hidden ones. */
const entryOf = (items: Item[]): UiArrangementListEntry => ({
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

type Scope = { kind: "org"; orgId: string } | { kind: "platform" };

/**
 * The arrangement of a scope (an org, or the platform default) and its one write: every change is
 * saved at once (PATCH / PUT) and refreshes the lists that render the slots and the client code
 * the pages load. Shared by 替换 and 界面位置, which sit apart on the 外观 pages.
 */
function useArrangement(scope: Scope) {
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const qc = useQueryClient();
  const q = scope.kind === "org" ? uiArrangementQuery(scope.orgId) : adminUiArrangementQuery();
  const all = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) }).data ?? [];
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
            // a replacement changes the components the pages load
            keys.org(scope.orgId).clientExtensions(),
          ]
        : [keys.deployment().uiArrangement(), keys.deployment().uiContributions()],
    // the platform default changes what every org lists and loads
    onSuccess: () => {
      if (scope.kind === "platform") {
        void invalidateOrgUiLists(qc);
        void invalidateClientSets(qc);
      }
    },
  });
  const [busy, setBusy] = useState(false);
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
  return { all, busy, save };
}

/**
 * 界面位置: per list slot the extension contributions the scope lists, with a hide switch and up /
 * down ("hidden" means not listed: a direct link still opens; the first row's up and the last
 * row's down are disabled). `scope` is an org (on `/settings/appearance`: org admins write, below
 * admin it is read only) or the platform default (super admins, on the deployment settings page).
 */
export function UiPlacementSection({ scope, canEdit }: { scope: Scope; canEdit: boolean }) {
  const t = useTranslations("uiArrangement");
  const locale = uiLocale(useLocale());
  const { all, busy, save } = useArrangement(scope);
  const slots = all.filter(
    (s): s is UiArrangementListSlot => !isSingleArrangementSlot(s) && s.items.length > 0,
  );
  if (slots.length === 0) return null;

  const table = (s: UiArrangementListSlot, slotName: string) => {
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

/**
 * 替换: the replaceable slots (client extensions spec §6.3) the scope may change, listed when
 * something may replace one or a pick is stored; nothing when there is none.
 */
export function UiReplacementsSection({ scope, canEdit }: { scope: Scope; canEdit: boolean }) {
  const { all, busy, save } = useArrangement(scope);
  const singles = all.filter(
    (s): s is UiArrangementSingleSlot =>
      isSingleArrangementSlot(s) && (s.candidates.length > 0 || s.use !== null),
  );
  if (singles.length === 0) return null;
  return (
    <ReplaceableSlots
      scope={scope}
      canEdit={canEdit}
      busy={busy}
      slots={singles}
      save={(slot, entry) => void save(slot, entry)}
    />
  );
}

/** The select's value for 内置 (never a contribution key: keys hold a `/`). */
const BUILTIN = "builtin";

/**
 * 替换: one row per replaceable slot, with what it uses (内置 or a contribution) and, for an org,
 * 来源: 本组织 or 跟随平台. An org admin's 内置 is the org's own pick (`use: null`); on a row of the
 * org's own, 改为跟随平台 removes the org's entry. On the platform 内置 removes the entry (nothing
 * to follow, no 来源).
 */
function ReplaceableSlots({
  scope,
  canEdit,
  busy,
  slots,
  save,
}: {
  scope: Scope;
  canEdit: boolean;
  busy: boolean;
  slots: UiArrangementSingleSlot[];
  save(slot: UiSlotId, entry: UiArrangementEntry | null): void;
}) {
  const t = useTranslations("uiArrangement");
  const locale = uiLocale(useLocale());
  const slotName = (s: UiArrangementSingleSlot) => t(`slots.${SLOT_NAME[s.slot]}`);
  const pickLabel = (s: UiArrangementSingleSlot): string => {
    if (s.use === null) return t("builtin");
    const c = s.candidates.find((x) => x.key === s.use);
    return c === undefined ? t("unavailableUse", { key: s.use }) : c.title[locale];
  };
  const org = scope.kind === "org";
  const columns: Column<UiArrangementSingleSlot>[] = [
    { key: "slot", header: t("columns.slot"), cell: (s) => slotName(s) },
    canEdit
      ? {
          key: "use",
          header: t("columns.use"),
          interactive: true,
          cell: (s) => (
            <Select
              density="dense"
              aria-label={t("useLabel", { slot: slotName(s) })}
              value={s.use ?? BUILTIN}
              disabled={busy}
              options={[
                { value: BUILTIN, label: t("builtin") },
                ...s.candidates.map((c) => ({ value: c.key, label: c.title[locale] })),
                // a stored pick that is no candidate any more renders the built-in; kept visible
                ...(s.use !== null && !s.candidates.some((c) => c.key === s.use)
                  ? [{ value: s.use, label: pickLabel(s), disabled: true }]
                  : []),
              ]}
              onChange={(e) => {
                const v = e.target.value;
                save(s.slot, v === BUILTIN ? (org ? { use: null } : null) : { use: v });
              }}
            />
          ),
        }
      : { key: "use", header: t("columns.use"), cell: (s) => pickLabel(s) },
    ...(org
      ? [
          {
            key: "source",
            header: t("columns.source"),
            tone: "muted",
            interactive: canEdit,
            cell: (s: UiArrangementSingleSlot) =>
              s.followsPlatform ? (
                t("followsPlatform")
              ) : canEdit ? (
                <Stack direction="row" gap={8} align="center">
                  <Text tone="muted">{t("orgOwn")}</Text>
                  <Button
                    variant="ghost"
                    density="dense"
                    disabled={busy}
                    onClick={() => save(s.slot, null)}
                    aria-label={t("resetLabel", { slot: slotName(s) })}
                  >
                    {t("resetOrg")}
                  </Button>
                </Stack>
              ) : (
                t("orgOwn")
              ),
          } satisfies Column<UiArrangementSingleSlot>,
        ]
      : []),
  ];
  return (
    <FormSection
      id="ui-replace"
      flush
      title={t("replaceTitle")}
      description={t("replaceDescription")}
    >
      <DataTable<UiArrangementSingleSlot>
        label={t("replaceTitle")}
        columns={columns}
        rows={slots}
        rowKey={(s) => s.slot}
        rowLabel={slotName}
      />
    </FormSection>
  );
}
