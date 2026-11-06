"use client";

import {
  AVATAR_PRESET_IDS,
  AvatarPicker,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Disclosure,
  Field,
  Input,
  ItemList,
  type PresetId,
  Select,
  Skeleton,
  Stack,
  Text,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import type { Agent, AgentVisibility } from "../../lib/agents";
import { ApiClientError } from "../../lib/api";
import type { ModelRef } from "../../lib/conversations";
import { labelLocale, modelLabel } from "../../lib/extension-label";
import {
  connectorNamer,
  createFromTemplate,
  droppedLine,
  groupItems,
  hasChanges,
  type PlanItem,
  type PlanItemState,
  type PreviewChange,
  previewChanges,
  reasonKey,
  type TemplatePreview,
} from "../../lib/from-template";
import { canUpdateOrg } from "../../lib/org-settings";
import { retryOnMountOf } from "../../lib/query/client";
import { modelsQuery } from "../../lib/query/conversation";
import { templatePreviewQuery } from "../../lib/query/from-template";
import { keys } from "../../lib/query/keys";
import { membersQuery } from "../../lib/query/members";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import { FormError } from "../form-error";
import { useSession } from "../shell/session";
import { decodeModel, encodeModel } from "./definition-parts";

const NAME_MAX = 80;
const VISIBILITIES = ["private", "org", "members"] as const satisfies readonly AgentVisibility[];
const STATES: readonly PlanItemState[] = ["carried", "pending", "unavailable"];

const randomPreset = (): PresetId =>
  AVATAR_PRESET_IDS[Math.floor(Math.random() * AVATAR_PRESET_IDS.length)] as PresetId;

/** Where a created agent opens: its Tools section when connectors wait (the 待配置 notice). */
export const createdAgentHref = (agent: Pick<Agent, "id" | "definition">): string =>
  `/agents/${encodeURIComponent(agent.id)}${
    (agent.definition.pendingConnectors ?? []).length > 0 ? "?s=tools" : ""
  }`;

/**
 * 用它创建 (rulings P4-3…P4-5, P4-18): the name (the template's by default), a preset avatar, the
 * visibility (org admins only: anyone else's agent is private, the field is not shown), the model
 * (the preview's automatic choice preselected; a change sends `model`), then what carries over as
 * 带入 / 待配置 / 不可用 with counts, each group expandable with its items and reasons, and the
 * template's settings with no place in the agent in plain words. 创建 sends the preview's hash and
 * lands on the new agent (its Tools section and 待配置 notice when connectors wait). A plan that
 * changed meanwhile (409) is previewed again and the changes are shown before the next 创建; a
 * template no longer usable here (404) says so and offers nothing to create.
 */
export function CreateFromTemplateDialog({
  orgId,
  template,
  onClose,
}: {
  orgId: string;
  template: { id: string; name: string };
  onClose(): void;
}) {
  const t = useTranslations("agents.fromTemplate");
  const ta = useTranslations("agents");
  const tc = useTranslations("common");
  const tp = useTranslations("agents.page");
  const lang = labelLocale(useLocale());
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const qc = useQueryClient();
  const { me } = useSession();
  const admin = canUpdateOrg(me);

  const previewQ = templatePreviewQuery(orgId, template.id);
  const preview = useQuery({ ...previewQ, refetchOnMount: "always" });
  const modelsQ = modelsQuery(orgId);
  const models = useQuery({ ...modelsQ, retryOnMount: retryOnMountOf(modelsQ.queryKey) });
  const membersQ = membersQuery(orgId);
  const members = useQuery({ ...membersQ, enabled: admin });

  const [name, setName] = useState(template.name.slice(0, NAME_MAX));
  const [preset, setPreset] = useState<PresetId | null>(null);
  useEffect(() => setPreset((p) => p ?? randomPreset()), []);
  const [visibility, setVisibility] = useState<AgentVisibility>("private");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  // The person's pick; null = the preview's automatic choice.
  const [picked, setPicked] = useState<string | null>(null);
  // The preview the person saw before a 409 and what changed since, shown above the groups.
  const [changes, setChanges] = useState<{
    change: PreviewChange;
    before: readonly PlanItem[];
    after: readonly PlanItem[];
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The template stopped being usable here between the preview and the create (404 on create).
  const [goneOnCreate, setGoneOnCreate] = useState(false);

  const data = preview.data;
  const auto = data?.model ? encodeModel(data.model) : "";
  const options = (models.data?.providers ?? []).flatMap((p) =>
    p.models.map((m) => ({
      value: encodeModel({ provider: p.provider, model: m.id }),
      label: modelLabel(
        { name: p.provider, displayName: p.displayName },
        m.displayName || m.id,
        lang,
      ),
    })),
  );
  const model = picked ?? auto;
  const gone =
    goneOnCreate || (preview.error instanceof ApiClientError && preview.error.status === 404);

  const create = useAppMutation({
    fn: (p: TemplatePreview) => {
      const chosen: ModelRef | null =
        picked !== null && picked !== auto ? decodeModel(picked) : null;
      return createFromTemplate(orgId, {
        templateId: template.id,
        name: name.trim(),
        ...(admin && visibility !== "private" ? { visibility } : {}),
        ...(admin && visibility === "members" ? { members: memberIds } : {}),
        ...(chosen !== null ? { model: chosen } : {}),
        ...(preset !== null ? { avatar: { kind: "preset" as const, id: preset } } : {}),
        previewHash: p.previewHash,
      });
    },
    invalidates: (_, r) => [
      keys.org(orgId).agents(),
      keys.org(orgId).agent(r.agent.id),
      keys.org(orgId).readiness(),
    ],
  });

  async function submit() {
    if (data === undefined || create.isPending) return;
    setError(null);
    try {
      const r = await create.mutateAsync(data);
      onClose();
      router.push(createdAgentHref(r.agent));
    } catch (e) {
      if (e instanceof ApiClientError && e.code === "agent.template_preview_stale") {
        // read the plan again and show what changed; the next 创建 sends the new hash
        const before = data;
        const after = await qc.fetchQuery({ ...previewQ, staleTime: 0 }).catch(() => undefined);
        if (after !== undefined) {
          const c = previewChanges(before, after);
          setChanges({ change: c, before: before.items, after: after.items });
          if (!hasChanges(c)) setError(e);
          return;
        }
      }
      if (e instanceof ApiClientError && e.status === 404) {
        setGoneOnCreate(true);
        return;
      }
      setError(e);
    }
  }

  const ready = data !== undefined;
  const nameOk = name.trim() !== "";
  const noModels = models.data !== undefined && options.length === 0;
  const modelsLoading = models.data === undefined && models.error === null;
  const canCreate = ready && !gone && nameOk && !noModels && model !== "" && !create.isPending;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size={640}
      title={t("title", { name: template.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc("cancel")}
          </Button>
          {gone ? null : (
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!canCreate}
              onClick={() => void submit()}
            >
              {t("submit")}
            </Button>
          )}
        </>
      }
    >
      {gone ? (
        <Text variant="prose">{t("gone")}</Text>
      ) : (
        <Stack gap={16}>
          {error !== null && <FormError message={errorMessage(error)} />}
          <AvatarPicker
            value={preset === null ? null : { kind: "preset", id: preset }}
            label={tp("avatarLabel")}
            disabled={create.isPending}
            onChange={(v) => {
              if (v?.kind === "preset") setPreset(v.id);
            }}
            uploadOffReason={t("uploadLater")}
          />
          <Field
            label={ta("form.nameLabel")}
            required
            count={{ value: name.length, max: NAME_MAX }}
            {...(!nameOk ? { error: ta("form.nameRequired") } : {})}
          >
            <Input
              name="name"
              maxLength={NAME_MAX}
              value={name}
              disabled={create.isPending}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {admin && (
            <Field label={ta("form.visibilityLabel")}>
              <Select
                name="visibility"
                value={visibility}
                disabled={create.isPending}
                onChange={(e) => setVisibility(e.target.value as AgentVisibility)}
                options={VISIBILITIES.map((v) => ({
                  value: v,
                  label: ta(`form.visibility.${v}`),
                }))}
              />
            </Field>
          )}
          {admin && visibility === "members" && (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset brings the browser's border and padding, and apps/web writes no styles: role=group groups it
            <div role="group" aria-label={tp("membersLabel")}>
              <Stack gap={4}>
                <Text variant="small" tone="muted">
                  {tp("membersLabel")}
                </Text>
                {members.data === undefined ? (
                  <Text variant="small" tone="faint">
                    {members.error === null ? tp("membersLoading") : tp("membersFailed")}
                  </Text>
                ) : (
                  members.data.members
                    .filter((m) => !m.anonymous)
                    .map((m) => (
                      <Checkbox
                        key={m.account.id}
                        label={m.account.displayName}
                        checked={memberIds.includes(m.account.id)}
                        onChange={(on) =>
                          setMemberIds((cur) =>
                            on ? [...cur, m.account.id] : cur.filter((x) => x !== m.account.id),
                          )
                        }
                      />
                    ))
                )}
              </Stack>
            </div>
          )}
          <Field
            label={ta("form.modelLabel")}
            required
            {...(noModels
              ? { error: ta("form.noModels") }
              : data?.model && picked === null
                ? { help: t(`modelSource.${data.model.source}`) }
                : {})}
          >
            <Select
              name="model"
              disabled={!ready || modelsLoading || noModels || create.isPending}
              value={model}
              onChange={(e) => setPicked(e.target.value)}
              options={[...(model === "" ? [{ value: "", label: "—" }] : []), ...options]}
            />
          </Field>
          {changes !== null && (
            <PreviewChanges
              changes={changes.change}
              before={changes.before}
              after={changes.after}
            />
          )}
          {data === undefined ? (
            preview.error !== null ? (
              <Callout
                tone="fail"
                action={{ label: t("retry"), onSelect: () => void preview.refetch() }}
              >
                {errorMessage(preview.error)}
              </Callout>
            ) : (
              <div role="status" aria-busy="true" aria-label={t("previewLoading")}>
                <Skeleton rows={3} />
              </div>
            )
          ) : (
            <PreviewGroups preview={data} />
          )}
        </Stack>
      )}
    </Dialog>
  );
}

/** The item's line: its kind as the tag, its name, its reason in words. */
function useItemRow() {
  const t = useTranslations("agents.fromTemplate");
  return (i: PlanItem, n: number) => {
    const r = reasonKey(i);
    return {
      id: `${i.kind}-${i.name}-${n}`,
      tag: { label: t(`kinds.${i.kind}`) },
      title: i.name,
      ...(r !== null ? { meta: t(`reasons.${r}`) } : i.reason ? { meta: i.reason } : {}),
    };
  };
}

/**
 * The preview by state (P4-18): 带入 / 待配置 / 不可用 with their counts, each expandable to its
 * items (待配置 and 不可用 open when they hold something: they need the person's attention), then
 * the template settings the agent has no place for, in plain words.
 */
export function PreviewGroups({ preview }: { preview: TemplatePreview }) {
  const t = useTranslations("agents.fromTemplate");
  const row = useItemRow();
  const groups = groupItems(preview.items);
  return (
    <Stack gap={8}>
      <Text variant="small" tone="muted">
        {t("previewTitle")}
      </Text>
      {STATES.map((s) => (
        <div key={s} data-preview-group={s}>
          <Disclosure
            summary={<Text>{t(`groups.${s}`, { n: groups[s].length })}</Text>}
            defaultOpen={s !== "carried" && groups[s].length > 0}
          >
            <ItemList
              label={t(`groups.${s}`, { n: groups[s].length })}
              rows={groups[s].map(row)}
              empty={t(`emptyGroup.${s}`)}
            />
            {s === "pending" && groups[s].length > 0 && (
              <Text variant="small" tone="muted">
                {t("pendingHint")}
              </Text>
            )}
          </Disclosure>
        </div>
      ))}
      {preview.dropped.length > 0 && (
        <DroppedList dropped={preview.dropped} items={preview.items} />
      )}
    </Stack>
  );
}

function DroppedList({
  dropped,
  items,
}: {
  dropped: readonly string[];
  items: readonly PlanItem[];
}) {
  const t = useTranslations("agents.fromTemplate");
  const named = connectorNamer(items);
  return (
    <div data-preview-group="dropped">
      <Disclosure summary={<Text>{t("droppedTitle", { n: dropped.length })}</Text>}>
        <Stack gap={4}>
          {dropped.map((d) => {
            const l = droppedLine(d, named);
            return (
              <Text key={d} variant="small">
                {t(`dropped.${l.key}`, l.values)}
              </Text>
            );
          })}
        </Stack>
      </Disclosure>
    </div>
  );
}

/** What changed since the preview the person saw (after a 409): the new preview is below. */
function PreviewChanges({
  changes,
  before,
  after,
}: {
  changes: PreviewChange;
  before: readonly PlanItem[];
  after: readonly PlanItem[];
}) {
  const t = useTranslations("agents.fromTemplate");
  const kind = (i: PlanItem) => t(`kinds.${i.kind}`);
  const what = (d: string, items: readonly PlanItem[]) => {
    const l = droppedLine(d, connectorNamer(items));
    return t(`dropped.${l.key}`, l.values);
  };
  const lines = [
    ...changes.added.map((i) =>
      t("changes.added", { kind: kind(i), name: i.name, state: t(`state.${i.state}`) }),
    ),
    ...changes.removed.map((i) => t("changes.removed", { kind: kind(i), name: i.name })),
    ...changes.moved.map(({ item, from }) =>
      t("changes.moved", {
        kind: kind(item),
        name: item.name,
        from: t(`state.${from}`),
        to: t(`state.${item.state}`),
      }),
    ),
    ...changes.droppedAdded.map((d) => t("changes.droppedAdded", { what: what(d, after) })),
    ...changes.droppedRemoved.map((d) => t("changes.droppedRemoved", { what: what(d, before) })),
    ...(changes.modelChanged ? [t("changes.model")] : []),
  ];
  return (
    <Stack gap={4}>
      <Callout tone="warn">{t("stale")}</Callout>
      {lines.map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the lines are computed once per 409 and never reorder
        <Text key={i} variant="small">
          {l}
        </Text>
      ))}
    </Stack>
  );
}
