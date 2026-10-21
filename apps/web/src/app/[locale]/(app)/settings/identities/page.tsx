"use client";

import {
  Badge,
  Button,
  type Column,
  DataTable,
  Dialog,
  SettingsPage,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { FormError } from "../../../../../components/form-error";
import { useSettingsNav } from "../../../../../components/settings-nav";
import { RequireSession } from "../../../../../components/shell/session";
import { listAuthSources, ssoStartUrl } from "../../../../../lib/auth-sources";
import { navigateBrowser } from "../../../../../lib/browser";
import {
  type LinkedIdentity,
  listIdentities,
  splitSource,
  unlinkIdentity,
} from "../../../../../lib/identities";
import { useErrorMessage } from "../../../../../lib/use-error-message";
import { useLoad } from "../../../../../lib/use-load";

/**
 * `/[locale]/settings/identities`：本人已绑定的外部身份（IM 账号、第三方登录）（SettingsPage）：列表与解绑。
 * 不属于某个组织，只要已登录。账号没有密码时解绑最后一个登录方式会被拒（`identity.last_login_method`）。
 * 经 IM 绑定链接建立的身份（`linkedVia: "bind"`）标为未验证；该插件是可用的登录方式（`GET /auth/sources`）时
 * 行菜单提供「验证」：整页跳到该插件的第三方登录，
 * 本人在登录状态下完成一次后身份升级为可登录，回到本页。
 */
export default function IdentitiesPage() {
  return (
    <RequireSession>
      <Identities />
    </RequireSession>
  );
}

const rowKey = (x: LinkedIdentity) => `${x.source}\u0000${x.externalId}`;

function Identities() {
  const t = useTranslations("identities");
  const tc = useTranslations("common");
  const locale = useLocale();
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const nav = useSettingsNav();
  const { state, reload } = useLoad(() => listIdentities().then((r) => r.identities), []);
  // 「验证」只对可用的登录方式提供（插件在 `auth.loginSources` 中且已加载）；读不到时都不提供
  const sources = useLoad(
    () =>
      listAuthSources()
        .then((r) => new Set(r.sources.map((x) => x.plugin)))
        .catch(() => new Set<string>()),
    [],
  ).state;
  const canVerify = (x: LinkedIdentity) =>
    x.linkedVia === "bind" &&
    sources.kind === "ready" &&
    sources.data.has(splitSource(x.source).plugin);
  const [target, setTarget] = useState<LinkedIdentity>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const nameOf = (x: LinkedIdentity) => x.displayName ?? x.email ?? x.externalId;

  async function unlink(x: LinkedIdentity) {
    setPending(true);
    setError(undefined);
    try {
      await unlinkIdentity(x.source, x.externalId);
      setTarget(undefined);
      toast.success(t("unlinked", { name: nameOf(x) }));
      reload();
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
      cell: (x) => new Date(x.createdAt).toLocaleDateString(locale),
    },
  ];

  return (
    <SettingsPage header={{ title: t("title") }} nav={nav} activeNav="identities">
      <Stack gap={12}>
        <Text tone="muted">{t("hint")}</Text>
        <DataTable<LinkedIdentity>
          label={t("title")}
          columns={columns}
          rows={state.kind === "ready" ? state.data : []}
          rowKey={rowKey}
          rowLabel={nameOf}
          state={state.kind === "loading" ? "loading" : state.kind === "error" ? "error" : "ready"}
          {...(state.kind === "error" ? { error: { code: state.code, onRetry: reload } } : {})}
          empty={{ title: t("empty"), hint: t("emptyHint") }}
          rowMenu={(x) => [
            ...(canVerify(x)
              ? [
                  {
                    label: t("verify"),
                    onSelect: () =>
                      navigateBrowser(
                        ssoStartUrl(splitSource(x.source).plugin, "/settings/identities"),
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
          <Text>{t("unlinkHint")}</Text>
          {error !== undefined && <FormError message={error} />}
        </Stack>
      </Dialog>
    </SettingsPage>
  );
}
