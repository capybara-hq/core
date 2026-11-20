"use client";

import {
  Button,
  Callout,
  type Column,
  DataTable,
  DateTime,
  FormSection,
  SettingsPage,
  Stack,
  SwitchList,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { PUSH_CATEGORIES, type PushRegistrationView } from "../../../../lib/push";
import { usePageQuery } from "../../../../lib/query/page-query";
import {
  pushPreferencesQuery,
  pushRegistrationsQuery,
  useRemovePushRegistration,
  useSetPushPreference,
} from "../../../../lib/query/push";
import { meQuery } from "../../../../lib/query/shell";
import { useErrorMessage } from "../../../../lib/use-error-message";
import { usePushRegistration } from "../../../../lib/use-push-registration";

/**
 * `/account/notifications` (SettingsPage; every signed-in person): Notifications. The devices that
 * receive push (name, last seen, Remove; the one this install registered is marked), the "Turn on
 * for this device" button where the shell offers `push@1`, and the four category switches (`PUT`
 * sends the one key that changed).
 * From the query cache (the layout prefetched both reads on a first load).
 */
export default function NotificationsView() {
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <Notifications accountId={me.account.id} />;
}

function Notifications({ accountId }: { accountId: string }) {
  const t = useTranslations("notifications");
  const scope = usePagePath("home");
  const nav = useAccountNav();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const registrations = usePageQuery(pushRegistrationsQuery(accountId));
  const preferences = usePageQuery(pushPreferencesQuery(accountId));
  const remove = useRemovePushRegistration(accountId);
  const setPreference = useSetPushPreference(accountId);
  const push = usePushRegistration();
  const header = {
    path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "notifications" }],
    title: t("title"),
    description: t("description"),
  };
  if (registrations.kind === "notFound" || registrations.kind === "error") {
    return (
      <SettingsPage header={header} nav={nav} activeNav="notifications">
        <ErrorFrame
          reset={registrations.kind === "error" ? registrations.retry : () => location.reload()}
        />
      </SettingsPage>
    );
  }
  const rows = registrations.kind === "ready" ? registrations.data : [];
  const hasCurrent = rows.some((r) => r.current);
  const canEnable = push.state === "prompt" || (push.state === "granted" && !hasCurrent);

  const columns: Column<PushRegistrationView>[] = [
    {
      key: "device",
      header: t("devices.device"),
      cell: (r) => (r.current ? `${r.deviceName} · ${t("devices.thisDevice")}` : r.deviceName),
    },
    {
      key: "lastSeen",
      header: t("devices.lastSeen"),
      tone: "muted",
      cell: (r) => <DateTime value={r.lastSeenAt} />,
    },
    {
      key: "actions",
      header: t("devices.actions"),
      align: "right",
      cell: (r) => (
        <Button
          density="dense"
          variant="danger"
          aria-label={`${t("devices.remove")} ${r.deviceName}`}
          disabled={remove.isPending}
          onClick={() =>
            void remove.mutateAsync(r.id).then(
              () => toast.success(t("devices.removed")),
              (e: unknown) => toast.error(errorMessage(e)),
            )
          }
        >
          {t("devices.remove")}
        </Button>
      ),
    },
  ];

  const prefs = preferences.kind === "ready" ? preferences.data : null;
  return (
    <SettingsPage header={header} nav={nav} activeNav="notifications">
      {push.state === "denied" && <Callout tone="warn">{t("devices.denied")}</Callout>}
      <FormSection
        id="notifications-devices"
        title={t("devices.title")}
        description={t("devices.description")}
        flush
      >
        <DataTable<PushRegistrationView>
          label={t("devices.title")}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.deviceName}
          state={registrations.kind === "ready" ? "ready" : "loading"}
          empty={{ title: t("devices.empty") }}
        />
      </FormSection>
      {canEnable && (
        <Stack direction="row" gap={8}>
          <Button
            onClick={() =>
              void push.enable().catch((e: unknown) => {
                // declining the OS prompt is an answer, not an error
                if ((e as { code?: unknown } | null)?.code !== "cancelled") {
                  toast.error(errorMessage(e));
                }
              })
            }
          >
            {t("devices.enable")}
          </Button>
        </Stack>
      )}
      <FormSection
        id="notifications-categories"
        title={t("categories.title")}
        description={t("categories.description")}
        flush
        {...(prefs === null ? { loading: { items: [{}, {}, {}, {}] } } : {})}
      >
        {prefs !== null && (
          <SwitchList
            label={t("categories.title")}
            rows={PUSH_CATEGORIES.map((category) => ({
              id: category,
              name: t(`categories.${category}`),
              description: t(`categories.${category}Hint`),
              checked: prefs[category],
              disabled: setPreference.isPending,
              onChange: (enabled: boolean) =>
                void setPreference
                  .mutateAsync({ category, enabled })
                  .catch((e: unknown) => toast.error(errorMessage(e))),
            }))}
          />
        )}
      </FormSection>
    </SettingsPage>
  );
}
