"use client";

import {
  Button,
  Dialog,
  FilePicker,
  formatDateTime,
  ListPage,
  ObjectCard,
  Stack,
  Text,
  useTimeZone,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useOwnerLabel } from "../../../components/CatalogParts";
import { useComponentState, useComponentSwitch } from "../../../components/ComponentSwitch";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { cardActions } from "../../../components/PluginSwitch";
import { usePagePath, usePathWord } from "../../../components/shell/path";
import { useSession } from "../../../components/shell/session";
import { type OwnerSide, ownerSide } from "../../../lib/catalog";
import { usableRows } from "../../../lib/components";
import { canUpdateOrg } from "../../../lib/org-settings";
import { retryOnMountOf } from "../../../lib/query/client";
import { orgComponentsQuery } from "../../../lib/query/components";
import { usePageQuery } from "../../../lib/query/page-query";
import { skillsQuery } from "../../../lib/query/skills";
import { useWorkspace } from "../../../lib/query/workspace";
import NotFound from "../not-found";
import { type SkillUpload, useSkillUpload } from "./use-skill-upload";

/**
 * `/skills` (spec §9): the skills the org can use and the platform skills offered to it (card
 * list). Org-own rows carry 本组织, platform rows 平台 with their state in the org (已启用 · 平台统一 for
 * `all`, 已启用, 未启用, 插件未启用); org admins switch platform skills (启用, 停用 with the preview of the agents
 * using it), upload a .zip (a name a platform skill offered here already has is refused, rule 10)
 * or write one with 新建 (plugin scope phase 3). A plugin filter narrows the rows to one plugin's
 * skills or the org's own (skills default-on spec §10). Members read the page. From the query cache (the
 * layout prefetched the library and the offered components on a first load); a switch or an upload
 * invalidates them.
 */
export default function SkillsView() {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Skills orgId={ws.orgId} />;
}

/** The plugin filter's value for the org's own skills (no plugin name contains a space). */
const NO_PLUGIN = " own";

function Skills({ orgId }: { orgId: string }) {
  const timeZone = useTimeZone();
  const scope = usePagePath("org");
  const pw = usePathWord("org");
  const t = useTranslations("skills");
  const tc = useTranslations("orgComponents");
  const { me } = useSession();
  const admin = canUpdateOrg(me);
  const [uploading, setUploading] = useState(false);
  const up = useSkillUpload(orgId, () => setUploading(false));
  const [plugin, setPlugin] = useState("");
  const list = usePageQuery(skillsQuery(orgId));
  const cq = orgComponentsQuery(orgId, { kind: "skill" });
  const offered = useQuery({ ...cq, retryOnMount: retryOnMountOf(cq.queryKey) });
  const stateOf = useComponentState();
  const { actionsOf, dialog, error } = useComponentSwitch({ orgId, admin });
  const ownerLabel = useOwnerLabel(orgId);
  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;
  const all = list.kind === "ready" ? usableRows(list.data.skills, offered.data?.components) : [];
  const pluginOf = (r: (typeof all)[number]): string | null =>
    (r.kind === "own" ? r.item.plugin : (r.item?.plugin ?? r.component?.plugin)) ?? null;
  const plugins = [...new Set(all.flatMap((r) => pluginOf(r) ?? []))].sort((a, b) =>
    a.localeCompare(b),
  );
  // the filter: every skill, one plugin's, or the org's own without a plugin (NO_PLUGIN)
  const rows =
    plugin === ""
      ? all
      : all.filter((r) => (plugin === NO_PLUGIN ? pluginOf(r) === null : pluginOf(r) === plugin));
  const scopeFilter =
    plugins.length === 0
      ? undefined
      : {
          label: t("filters.plugin"),
          value: plugin === "" ? "all" : plugin,
          onChange: (v: string) => setPlugin(v === "all" ? "" : v),
          options: [
            { value: "all", label: t("filters.allPlugins") },
            ...plugins.map((p) => ({ value: p, label: p })),
            { value: NO_PLUGIN, label: t("filters.noPlugin") },
          ],
        };
  const upload = {
    label: t("upload.open"),
    icon: "upload" as const,
    onSelect: () => {
      up.reset();
      setUploading(true);
    },
  };
  const empty =
    rows.length === 0 && all.length > 0
      ? { text: t("filters.noMatch") }
      : rows.length === 0
        ? {
            text: t("empty"),
            ...(admin
              ? {
                  action: {
                    label: upload.label,
                    variant: "primary" as const,
                    onSelect: upload.onSelect,
                  },
                }
              : {}),
          }
        : undefined;
  // Where it came from: its plugin, else whose upload it is (the same owner as the chip)
  const fromOf = (plugin: string | null | undefined, owner: OwnerSide) =>
    plugin
      ? tc("from.plugin", { plugin })
      : owner.kind === "platform"
        ? tc("from.platform")
        : owner.kind === "self"
          ? tc("from.org")
          : tc("from.orgNamed", { org: owner.name });
  return (
    <>
      <ListPage
        header={{
          path: [...scope, pw("skills")],
          title: t("title"),
          description: t("description"),
          ...(admin ? { actions: [{ ...upload, variant: "primary" as const }] } : {}),
        }}
        variant="cards"
        listLabel={t("listLabel")}
        {...(scopeFilter !== undefined ? { scope: scopeFilter } : {})}
        {...(error !== undefined
          ? {
              callout: {
                tone: "fail" as const,
                children: <FormError message={error.message} extra={error.extra} />,
              },
            }
          : offered.data === undefined && offered.error !== null
            ? // the offered components could not be read: the platform ones that are off and
              // their switches are missing until a retry
              {
                callout: {
                  tone: "warn" as const,
                  children: tc("listUnavailable"),
                  action: { label: tc("retry"), onSelect: () => void offered.refetch() },
                },
              }
            : {})}
        {...(list.kind === "loading" ? { loading: true } : empty ? { empty } : {})}
      >
        {rows.map((r) => {
          if (r.kind === "own") {
            const s = r.item;
            return (
              <ObjectCard
                key={s.id}
                avatar={{ image: null }}
                title={s.name}
                href={`/skills/${encodeURIComponent(s.id)}`}
                mono
                chips={[{ label: tc("origin.org") }]}
                description={s.description}
                meta={[
                  fromOf(s.plugin, { kind: "self" }),
                  t("version", { version: s.currentVersion }),
                  formatDateTime(s.updatedAt, "full", timeZone),
                ]}
                state={{ label: tc("state.on"), tone: "ok" }}
              />
            );
          }
          const c = r.component;
          const s = r.item;
          // The owner from owner_org_id: 本组织 for the org's own upload, else the owner org or 平台
          const owner = c?.owner ?? s?.owner;
          const id = s?.id ?? c?.id ?? "";
          const name = s?.name ?? c?.name ?? "";
          const on = c?.on ?? s !== undefined;
          return (
            <ObjectCard
              key={id}
              avatar={{ image: null }}
              title={name}
              mono
              {...(on && s !== undefined ? { href: `/skills/${encodeURIComponent(id)}` } : {})}
              chips={[{ label: ownerLabel(owner) }]}
              description={s?.description ?? c?.description ?? ""}
              meta={[
                fromOf(s?.plugin ?? c?.plugin, ownerSide(owner, orgId)),
                t("version", { version: s?.currentVersion ?? c?.version ?? "" }),
              ]}
              state={c !== undefined ? stateOf(c) : { label: tc("state.on"), tone: "ok" }}
              {...(c !== undefined ? cardActions(actionsOf(c)) : {})}
            />
          );
        })}
      </ListPage>
      {dialog}
      {admin && (
        <Dialog
          open={uploading}
          onOpenChange={setUploading}
          title={t("upload.title")}
          size={640}
          footer={<Button onClick={() => setUploading(false)}>{t("upload.close")}</Button>}
        >
          <UploadCard up={up} />
        </Dialog>
      )}
    </>
  );
}

/**
 * The admin's upload card: the accepted layout and limits; one .zip at a time, no new pick while one
 * uploads. An upload shows its progress and can be cancelled; a failure (not one the front-end check
 * stopped) can be retried with the same file. The state is the page's `useSkillUpload`, so the card
 * may remount when the window crosses a size class.
 */
function UploadCard({ up }: { up: SkillUpload }) {
  const t = useTranslations("skills.upload");
  const { busy, error, cancelled, failed } = up;
  const status =
    busy !== undefined
      ? t("uploading", { name: busy.name, percent: Math.round(busy.progress * 100) })
      : cancelled
        ? t("cancelled")
        : null;
  return (
    <Stack gap={12}>
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("layoutHint")}
        </Text>
        <Text variant="small" tone="muted">
          {t("limits")}
        </Text>
      </Stack>
      <FilePicker
        label={t("choose")}
        hint={t("chooseHint")}
        dropLabel={t("drop")}
        accept=".zip,application/zip"
        onFiles={(f) => void up.upload(f)}
        disabled={busy !== undefined}
      >
        {status !== null || failed !== undefined ? (
          <Stack direction="row" gap={8} align="center" wrap>
            {status !== null ? <Text variant="small">{status}</Text> : null}
            {busy !== undefined && (
              <Button variant="ghost" onClick={() => up.cancel()}>
                {t("cancel")}
              </Button>
            )}
            {busy === undefined && failed !== undefined && (
              <Button onClick={() => void up.upload([failed])}>{t("retry")}</Button>
            )}
          </Stack>
        ) : null}
      </FilePicker>
      {error !== undefined && <FormError message={error.message} extra={error.extra} />}
    </Stack>
  );
}
