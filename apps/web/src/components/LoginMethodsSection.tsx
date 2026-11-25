"use client";

import {
  Callout,
  FormSection,
  ItemList,
  Repeater,
  Stack,
  Text,
  TextLink,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { labelLocale } from "../lib/extension-label";
import { type LoginSource, reorderLoginSources } from "../lib/login-sources";
import { loginSourceChangeKeys, loginSourcesQuery } from "../lib/query/admin";
import { retryOnMountOf } from "../lib/query/client";
import { useAppMutation } from "../lib/query/mutation";
import { useErrorMessage } from "../lib/use-error-message";

/** The loading shape: rows of methods under a small label line. */
export const LOGIN_METHODS_LOADING = { fields: [{ control: "item-group" as const, options: 2 }] };
const LOADING = LOGIN_METHODS_LOADING;

const extensionHref = (plugin: string) => `/admin/extensions/${encodeURIComponent(plugin)}`;

/** `keys` with `key` moved to index `to`. */
const movedTo = (keys: string[], key: string, to: number): string[] => {
  const rest = keys.filter((k) => k !== key);
  rest.splice(to, 0, key);
  return rest;
};

/**
 * Login methods on `/admin/settings` (login extensions spec §3): the platform's login methods. The
 * ones the login page offers come first, in its order, as an order-only `Repeater` (drag handle,
 * move up / down, Alt+↑/↓), each linking to its extension page, where everything about one method
 * lives; every move saves the whole order at once (apart from the page's ActionRow) and shows it
 * while the save runs. The others (off, waiting for config, not running) follow as a plain list
 * with their state, not reorderable.
 */
export function LoginMethodsSection() {
  const t = useTranslations("loginSources.methods");
  const tc = useTranslations("common");
  const lang = labelLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const q = loginSourcesQuery();
  const read = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  const qc = useQueryClient();
  // the order being saved, drawn until the save settles (focus stays on the moved item)
  const [moving, setMoving] = useState<string[] | null>(null);
  const reorder = useAppMutation({
    // the answer is the new overview: cached before `moving` clears, so the old order never flashes
    fn: async (plugins: string[]) => {
      const r = await reorderLoginSources(plugins);
      qc.setQueryData(q.queryKey, r);
      return r;
    },
    invalidates: () => loginSourceChangeKeys(),
    onSuccess: () => toast.success(t("reordered")),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const head = { id: "login-methods", title: t("title"), description: t("description") };
  if (read.isPending) {
    return <FormSection {...head} loading={LOADING} />;
  }
  if (read.isError) {
    return (
      <FormSection {...head}>
        <Callout tone="fail" action={{ label: tc("retry"), onSelect: () => void read.refetch() }}>
          {errorMessage(read.error)}
        </Callout>
      </FormSection>
    );
  }

  const items = read.data.items;
  const byPlugin = new Map(items.map((s) => [s.plugin, s]));
  const saved = items.filter((s) => s.enabled).map((s) => s.plugin);
  const order = (moving ?? saved).filter((p) => byPlugin.has(p));
  const others = items.filter((s) => !s.enabled);
  const label = (s: LoginSource) => s.label[lang];
  const stateOf = (s: LoginSource) =>
    s.needsConfig ? t("needsConfig") : !s.available ? t("unavailable") : t("off");

  const move = (key: string, to: number) => {
    const next = movedTo(order, key, to);
    setMoving(next);
    reorder.mutate(next, { onSettled: () => setMoving(null) });
  };

  if (items.length === 0) {
    return (
      <FormSection {...head}>
        <ItemList label={t("title")} empty={t("empty")} />
      </FormSection>
    );
  }

  return (
    <FormSection {...head}>
      <Stack gap={16}>
        {order.length > 0 && (
          <Repeater
            label={t("orderLabel")}
            variant="rows"
            disabled={reorder.isPending}
            items={order.map((plugin) => {
              const s = byPlugin.get(plugin) as LoginSource;
              return {
                key: plugin,
                // in the rows variant the title is only the row's accessible name
                title: label(s),
                body: (
                  <Stack direction="row" gap={8}>
                    <TextLink href={extensionHref(plugin)}>{label(s)}</TextLink>
                    <Text variant="small" tone="muted">
                      {plugin}
                    </Text>
                  </Stack>
                ),
              };
            })}
            onMove={move}
          />
        )}
        {others.length > 0 && (
          <Stack gap={8}>
            <Text variant="small" tone="muted">
              {t("others")}
            </Text>
            <ItemList
              label={t("others")}
              rows={others.map((s) => ({
                id: s.plugin,
                title: label(s),
                href: extensionHref(s.plugin),
                meta: s.plugin,
                status: { label: stateOf(s) },
              }))}
            />
          </Stack>
        )}
      </Stack>
    </FormSection>
  );
}
