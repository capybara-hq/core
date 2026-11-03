"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  DateTime,
  Dialog,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { FormError } from "../../../../components/form-error";
import { useAccountNav } from "../../../../components/settings-nav";
import { usePagePath } from "../../../../components/shell/path";
import { ssoStartUrl } from "../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../lib/browser";
import { type LinkedIdentity, splitSource, unlinkIdentity } from "../../../../lib/identities";
import { identitiesQuery } from "../../../../lib/query/account";
import { authSourcesQuery } from "../../../../lib/query/auth";
import { retryOnMountOf } from "../../../../lib/query/client";
import { useAppMutation } from "../../../../lib/query/define";
import { keys } from "../../../../lib/query/keys";
import { usePageQuery } from "../../../../lib/query/page-query";
import { meQuery } from "../../../../lib/query/shell";
import { useErrorMessage } from "../../../../lib/use-error-message";

/**
 * `/account/identities`：本人已绑定的外部身份（IM 账号、第三方登录）（SettingsPage）：列表与解绑。
 * 不属于某个组织，只要已登录。账号没有密码时解绑最后一个登录方式会被拒（`identity.last_login_method`）。
 * 经 IM 绑定链接建立的身份（`linkedVia: "bind"`）标为未验证；该插件是可用的登录方式（`GET /auth/sources`）时
 * 行菜单提供「验证」：整页跳到该插件的第三方登录，
 * 本人在登录状态下完成一次后身份升级为可登录，回到本页。
 * From the query cache (the layout prefetched it on a first load): the identities and the sign-in
 * sources (a section: no 验证 while they are unknown or could not be read); an unlink invalidates the
 * identities, which are read again.
 */
const rowKey = (x: LinkedIdentity) => `${x.source}\u0000${x.externalId}`;

export default function IdentitiesView() {
  // Any signed-in person (the layout's session gate): no org, no readiness.
  const me = useQuery(meQuery()).data;
  if (me === undefined) return null;
  return <Identities accountId={me.account.id} />;
}

function Identities({ accountId }: { accountId: string }) {
  const scope = usePagePath("home");
  const t = useTranslations("identities");
  const tc = useTranslations("common");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useAccountNav();
  const read = usePageQuery(identitiesQuery(accountId));
  const sourcesQ = authSourcesQuery();
  const sources = useQuery({ ...sourcesQ, retryOnMount: retryOnMountOf(sourcesQ.queryKey) });
  const loginPlugins = sources.data?.map((x) => x.plugin) ?? null;
  const unlinkOne = useAppMutation({
    fn: (x: LinkedIdentity) => unlinkIdentity(x.source, x.externalId),
    invalidates: () => [keys.account(accountId).identities()],
  });
  // 「验证」只对可用的登录方式提供（插件在 `auth.loginSources` 中且已加载）；读不到时都不提供
  const canVerify = (x: LinkedIdentity) =>
    x.linkedVia === "bind" && (loginPlugins?.includes(splitSource(x.source).plugin) ?? false);
  const [target, setTarget] = useState<LinkedIdentity>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const nameOf = (x: LinkedIdentity) => x.displayName ?? x.email ?? x.externalId;

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
      header: t("columns.name"),
      cell: (x) => (
        <Stack gap={0}>
          <Stack direction="row" gap={8} align="center">
            <Text>{nameOf(x)}</Text>
            {x.linkedVia === "bind" && <Badge>{t("unverified")}</Badge>}
          </Stack>
          {x.email !== null && x.email !== nameOf(x) && (
            <Text variant="small" tone="muted">
              {x.email}
            </Text>
          )}
        </Stack>
      ),
    },
    { key: "source", header: t("columns.source"), cell: (x) => splitSource(x.source).plugin },
    {
      key: "tenant",
      header: t("columns.tenant"),
      tone: "muted",
      cell: (x) => splitSource(x.source).tenant || "—",
    },
    {
      key: "externalId",
      header: t("columns.externalId"),
      tone: "muted",
      cell: (x) => x.externalId,
    },
    {
      key: "linkedAt",
      header: t("columns.linkedAt"),
      tone: "muted",
      width: 160,
      cell: (x) => <DateTime value={x.createdAt} />,
    },
  ];

  if (read.kind === "error") return <ErrorFrame reset={read.retry} />;
  return (
    <SettingsPage
      header={{
        path: [
          ...scope,
          { label: "account", href: "/account/connections" },
          { label: "identities" },
        ],
        title: t("title"),
      }}
      nav={nav}
      activeNav="identities"
    >
      <Stack gap={12}>
        <Text variant="prose" tone="muted">
          {t("hint")}
        </Text>
        <DataTable<LinkedIdentity>
          label={t("title")}
          columns={columns}
          rows={read.kind === "ready" ? read.data.identities : []}
          rowKey={rowKey}
          rowLabel={nameOf}
          state={read.kind === "ready" ? "ready" : "loading"}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
          rowMenu={(x) => [
            ...(canVerify(x)
              ? [
                  {
                    label: t("verify"),
                    onSelect: () =>
                      navigateBrowser(
                        ssoStartUrl(splitSource(x.source).plugin, "/account/identities"),
                      ),
                  },
                ]
              : []),
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
          <Stack direction="row" gap={8} justify="end">
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
          </Stack>
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
