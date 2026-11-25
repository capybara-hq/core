"use client";

import {
  Button,
  Callout,
  type Column,
  DataTable,
  Dialog,
  PersonName,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { ACCOUNT_HOME, useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { startLink } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { labelLocale } from "../../../../lib/extension-label";
import {
  type LinkErrorCode,
  type LinkedIdentity,
  splitSource,
  unlinkIdentity,
} from "../../../../lib/identities";
import { identitiesQuery } from "../../../../lib/query/account";
import { keys } from "../../../../lib/query/keys";
import { useAppMutation } from "../../../../lib/query/mutation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { meQuery } from "../../../../lib/query/shell";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * `/account/identities` (SettingsPage): the person's linked accounts (IM and sign-in accounts),
 * whatever their org. One row per identity: the account, its platform and tenant, whether it works
 * in IM (`channel`) and for sign-in (`login`, decided by the kernel). A row that came from an IM
 * bind link while its platform's sign-in is on (`needs_link`) offers "Turn on sign-in", and every
 * enabled login method the person has no identity of gets a "Link <platform>" button: both start a
 * link intent (`POST …/start`, CSRF-protected) and navigate to the identity provider, which comes
 * back here, with `?error=<code>` on failure. Unlinking the last sign-in of an account without a
 * password is refused (`identity.last_login_method`). From the query cache (the layout prefetched
 * the identities on a first load); an unlink invalidates them.
 */
const rowKey = (x: LinkedIdentity) => `${x.source}\u0000${x.externalId}`;

/** Where a link intent comes back to. */
const RETURN_TO = "/account/identities";

export default function IdentitiesView({ error }: { error: LinkErrorCode | null }) {
  // Any signed-in person (the layout's session gate): no org, no readiness.
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <Identities accountId={me.account.id} error={error} />;
}

function Identities({
  accountId,
  error: linkError,
}: {
  accountId: string;
  error: LinkErrorCode | null;
}) {
  const scope = usePagePath("home");
  const t = useTranslations("identities");
  const tc = useTranslations("common");
  const locale = labelLocale(useLocale());
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const read = usePageQuery(identitiesQuery(accountId));
  const qc = useQueryClient();
  const retry = () => void qc.refetchQueries({ queryKey: identitiesQuery(accountId).queryKey });
  const unlinkOne = useAppMutation({
    fn: (x: LinkedIdentity) => unlinkIdentity(x.source, x.externalId),
    invalidates: () => [keys.account(accountId).identities()],
  });
  // a link intent: the kernel answers where to go (the identity provider, or back here with ?error=)
  const link = useAppMutation({
    fn: (plugin: string) => startLink(plugin, RETURN_TO),
    invalidates: () => [],
    onSuccess: (r) => navigateBrowser(r.location),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [target, setTarget] = useState<LinkedIdentity>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const nameOf = (x: LinkedIdentity) => x.displayName ?? x.email ?? x.externalId;
  const linking = (plugin: string) => link.isPending && link.variables === plugin;

  async function unlink(x: LinkedIdentity) {
    setPending(true);
    setError(undefined);
    try {
      await unlinkOne.mutateAsync(x);
      setTarget(undefined);
      toast.success(t("unlinked", { name: nameOf(x) }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setPending(false);
    }
  }

  const columns: Column<LinkedIdentity>[] = [
    {
      key: "name",
      header: t("columns.account"),
      compact: "title",
      cell: (x) => (
        <PersonName
          name={nameOf(x)}
          avatarUrl={x.avatarUrl}
          size={16}
          {...(x.email !== null && x.email !== nameOf(x) ? { secondary: x.email } : {})}
        />
      ),
    },
    {
      key: "platform",
      header: t("columns.platform"),
      compact: "subtitle",
      cell: (x) => x.label[locale],
    },
    {
      key: "tenant",
      header: t("columns.tenant"),
      compact: "hidden",
      tone: "muted",
      cell: (x) => splitSource(x.source).tenant || "—",
    },
    {
      key: "im",
      header: t("columns.im"),
      compact: "meta",
      tone: "muted",
      fit: true,
      cell: (x) => (x.channel ? t("im.on") : "—"),
    },
    {
      key: "login",
      header: t("columns.login"),
      compact: "trailing",
      interactive: true,
      cell: (x) =>
        x.login === "needs_link" ? (
          <Button
            density="dense"
            loading={linking(splitSource(x.source).plugin)}
            disabled={link.isPending}
            onClick={() => link.mutate(splitSource(x.source).plugin)}
          >
            {t("login.enable")}
          </Button>
        ) : (
          <Text tone={x.login === "on" ? "ink" : "muted"}>{t(`login.${x.login}`)}</Text>
        ),
    },
  ];

  // A 404 of my own list is no missing object: it is an error with a retry, like any failure.
  if (read.kind === "notFound") return <ErrorFrame reset={retry} />;
  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <SettingsPage
      header={{
        path: [...scope, { label: "account", href: ACCOUNT_HOME }, { label: "identities" }],
        title: t("title"),
        actions: (read.kind === "ready" ? read.data.linkable : []).map((m) => ({
          label: t("link", { platform: m.label[locale] }),
          variant: "default" as const,
          icon: "link" as const,
          loading: linking(m.plugin),
          disabled: link.isPending && !linking(m.plugin),
          onSelect: () => link.mutate(m.plugin),
        })),
      }}
      nav={nav}
      activeNav="identities"
    >
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        {linkError !== null && <Callout tone="fail">{t(`linkError.${linkError}`)}</Callout>}
        <DataTable<LinkedIdentity>
          label={t("title")}
          columns={columns}
          rows={read.kind === "ready" ? read.data.identities : []}
          rowKey={rowKey}
          rowLabel={nameOf}
          state={read.kind === "ready" ? "ready" : "loading"}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
          rowMenu={(x) => [
            {
              label: t("unlink"),
              onSelect: () => {
                setError(undefined);
                setTarget(x);
              },
            },
          ]}
        />
      </Stack>
      <Dialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined);
        }}
        title={target ? t("unlinkTitle", { name: nameOf(target) }) : t("unlink")}
        danger
        footer={
          <>
            <Button disabled={pending} onClick={() => setTarget(undefined)}>
              {tc("cancel")}
            </Button>
            <Button
              variant="danger"
              loading={pending}
              onClick={() => {
                if (target) void unlink(target);
              }}
            >
              {t("unlink")}
            </Button>
          </>
        }
      >
        <Stack gap={8}>
          <Text variant="prose">{t("unlinkHint")}</Text>
          {error !== undefined && <FormError message={error} />}
        </Stack>
      </Dialog>
    </SettingsPage>
  );
}
