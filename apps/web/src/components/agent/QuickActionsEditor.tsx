"use client";

import {
  Field,
  Input,
  ItemList,
  ItemListItem,
  Repeater,
  Stack,
  Text,
  Textarea,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import type { QuickAction } from "../../lib/agents";

/** The profile limits (agent profile design §2.1), which templates share (SDK limits). */
export const QUICK_ACTIONS_MAX = 9;
const TITLE_MAX = 40;
const BODY_MAX = 20_000;

/** One quick action being edited, keyed for the Repeater. */
export type QuickActionEntry = QuickAction & { key: string };

/** The entries of saved quick actions. */
export const quickActionEntries = (list: readonly QuickAction[]): QuickActionEntry[] =>
  list.map((q, i) => ({ key: `saved-${i}`, ...q }));

/** What entries save: the actions in order, without their keys. */
export const quickActionsOf = (items: readonly QuickActionEntry[]): QuickAction[] =>
  items.map(({ title, body }) => ({ title, body }));

/** Whether an entry's title or body is missing. */
export const quickActionInvalid = (e: QuickAction) => ({
  title: e.title.trim() === "",
  body: e.body.trim() === "",
});

/**
 * The quick actions read-only (agent page and template page): the section card is the one box,
 * each action a row (its title, then its body), not a card.
 */
export function QuickActionsList({ list }: { list: readonly QuickAction[] }) {
  const t = useTranslations("agents.page");
  return (
    <ItemList label={t("quickActions.list")} inset="flush" empty={t("quickActions.none")}>
      {list.map((q, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: titles may repeat; the order is the identity
        <ItemListItem key={i} title={q.title}>
          <Text variant="prose">{q.body}</Text>
        </ItemListItem>
      ))}
    </ItemList>
  );
}

/**
 * The quick actions' editor (agent page and template page, ruling P4-12): up to 9 title + body
 * entries; add, edit, delete, reorder. `edit` changes the entries; `checked` shows the missing
 * titles and bodies (after a save attempt).
 */
export function QuickActionsEditor({
  items,
  edit,
  pending,
  checked,
}: {
  items: QuickActionEntry[];
  edit(fn: (items: QuickActionEntry[]) => QuickActionEntry[]): void;
  pending: boolean;
  checked: boolean;
}) {
  const t = useTranslations("agents.page");
  const next = useRef(0);
  return (
    <Repeater
      label={t("quickActions.list")}
      addLabel={t("quickActions.add")}
      max={QUICK_ACTIONS_MAX}
      disabled={pending}
      empty={t("quickActions.none")}
      items={items.map((e) => {
        const bad = checked ? quickActionInvalid(e) : { title: false, body: false };
        return {
          key: e.key,
          title: e.title,
          invalid: bad.title || bad.body,
          body: (
            <Stack gap={12}>
              <Field
                label={t("quickActions.titleLabel")}
                required
                count={{ value: e.title.length, max: TITLE_MAX }}
                {...(bad.title ? { error: t("quickActions.titleRequired") } : {})}
              >
                <Input
                  disabled={pending}
                  maxLength={TITLE_MAX}
                  value={e.title}
                  onChange={(ev) => {
                    const title = ev.target.value;
                    edit((list) => list.map((x) => (x.key === e.key ? { ...x, title } : x)));
                  }}
                />
              </Field>
              <Field
                label={t("quickActions.bodyLabel")}
                required
                help={t("quickActions.bodyHelp")}
                {...(bad.body ? { error: t("quickActions.bodyRequired") } : {})}
              >
                <Textarea
                  disabled={pending}
                  rows={4}
                  maxLength={BODY_MAX}
                  value={e.body}
                  onChange={(ev) => {
                    const body = ev.target.value;
                    edit((list) => list.map((x) => (x.key === e.key ? { ...x, body } : x)));
                  }}
                />
              </Field>
            </Stack>
          ),
        };
      })}
      onAdd={() => {
        next.current += 1;
        const key = `new-${next.current}`;
        edit((list) =>
          list.length >= QUICK_ACTIONS_MAX ? list : [...list, { key, title: "", body: "" }],
        );
      }}
      onRemove={(key) => {
        const before = items;
        edit((list) => list.filter((x) => x.key !== key));
        return () => edit(() => before);
      }}
      onMove={(key, to) =>
        edit((list) => {
          const from = list.findIndex((x) => x.key === key);
          if (from < 0) return list;
          const out = [...list];
          const [moved] = out.splice(from, 1);
          if (moved) out.splice(to, 0, moved);
          return out;
        })
      }
    />
  );
}
