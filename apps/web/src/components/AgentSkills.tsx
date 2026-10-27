"use client";

import { Badge, Button, Checkbox, DangerConfirm, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  deleteAgentSkill,
  listAgentSkills,
  listSkills,
  PINNED_SKILLS_LIMITS,
  type SkillSummary,
} from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 组织技能库（`GET /skills`）：读不到（如访客、接口出错）时为空列表，表单照常可用。
 * `undefined` 表示还在读取。
 */
export function useOrgSkills(orgId: string): {
  skills: SkillSummary[] | undefined;
  /** The list could not be read (`skills` is then empty). */
  failed: boolean;
} {
  const [state, setState] = useState<{ skills: SkillSummary[] | undefined; failed: boolean }>({
    skills: undefined,
    failed: false,
  });
  useEffect(() => {
    let disposed = false;
    listSkills(orgId).then(
      (r) => {
        if (!disposed) setState({ skills: r.skills, failed: false });
      },
      () => {
        if (!disposed) setState({ skills: [], failed: true });
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);
  return state;
}

/**
 * 组织技能多选：每个技能一个复选框（名称 · 描述）。已选但不在库里的 id（技能已被删除）显示为
 * 「已删除的技能」并保持勾选，取消勾选即从定义里移除（内核修改时只核对新加的引用，保留它不会报错）。
 */
export function OrgSkillsPicker({
  skills,
  value,
  onChange,
}: {
  skills: SkillSummary[] | undefined;
  value: string[];
  onChange(next: string[]): void;
}) {
  const t = useTranslations("agents.form");
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  const known = new Set((skills ?? []).map((s) => s.id));
  const deleted = skills === undefined ? [] : value.filter((id) => !known.has(id));
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组
    <div role="group" aria-label={t("orgSkillsLabel")}>
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("orgSkillsLabel")}
        </Text>
        {skills !== undefined && skills.length === 0 && deleted.length === 0 && (
          <Text variant="small" tone="faint">
            {t("noOrgSkills")}
          </Text>
        )}
        {(skills ?? []).map((s) => (
          <Stack key={s.id} direction="row" gap={8} align="center">
            <Checkbox
              label={`${s.name} · ${s.description}`}
              checked={value.includes(s.id)}
              onChange={(on) => toggle(s.id, on)}
            />
            <SkillTags skill={s} />
          </Stack>
        ))}
        {(skills ?? []).some((s) => s.manual === true) && (
          <Text variant="small" tone="faint">
            {t("manualHint")}
          </Text>
        )}
        {deleted.map((id) => (
          <Checkbox
            key={id}
            label={t("deletedSkill", { id })}
            checked
            onChange={(on) => toggle(id, on)}
          />
        ))}
        {deleted.length > 0 && (
          <Text variant="small" tone="warn">
            {t("deletedSkillHint")}
          </Text>
        )}
      </Stack>
    </div>
  );
}

/** Phase D tags: "manual" (not in the model's catalog), "sub-agent" (runs as one when invoked). */
function SkillTags({ skill }: { skill: Pick<SkillSummary, "manual" | "fork"> }) {
  const t = useTranslations("agents.form");
  return (
    <>
      {skill.manual === true && <Badge>{t("skillTag.manual")}</Badge>}
      {skill.fork === true && <Badge>{t("skillTag.fork")}</Badge>}
    </>
  );
}

/**
 * 私有 agent 的 `skill_write` 确认开关（`skills.writePolicy`，D10）：勾选 = `ask`，agent 每次写技能前都要负责人确认；
 * 不勾选（缺省）= 直接生效。共享 agent 的技能变更一律走审批，表单只在私有 agent 上显示它。
 */
export function SkillWriteSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange(next: boolean): void;
}) {
  const t = useTranslations("agents.form");
  return (
    <Stack gap={4}>
      <Checkbox label={t("confirmSkillWrite")} checked={value} onChange={onChange} />
      <Text variant="small" tone="faint">
        {t("confirmSkillWriteHint")}
      </Text>
    </Stack>
  );
}

/**
 * The agent's own skills (`GET /agents/:id/skills`; none for a new agent, `undefined` while
 * loading, empty and `failed` when unreadable) and a reload after a change.
 */
export function useAgentOwnSkills(
  orgId: string,
  agentId: string | undefined,
): { skills: SkillSummary[] | undefined; failed: boolean; reload(): void } {
  const [skills, setSkills] = useState<SkillSummary[] | undefined>(
    agentId === undefined ? [] : undefined,
  );
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce only triggers a reload
  useEffect(() => {
    if (agentId === undefined) return;
    let disposed = false;
    listAgentSkills(orgId, agentId).then(
      (r) => {
        if (disposed) return;
        setSkills(r.skills);
        setFailed(false);
      },
      () => {
        if (disposed) return;
        setSkills([]);
        setFailed(true);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, agentId, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { skills, failed, reload };
}

/**
 * The agent's pinned skills (`skills.pinned`, spec §9.1): one checkbox per selected skill (the
 * org skills in `orgSkills` and the agent's own skills, in that order), with a "suggested" badge
 * when its plugin suggests pinning it and its token estimate; the pinned count and summed token
 * estimate; at the count limit the other boxes are disabled with a hint. Over the SKILL.md byte
 * limit (the current versions' sizes) a warning: when the list is unchanged runs keep what fits
 * (the kernel only refuses a changed list); when it changed, saving is refused. A pinned id that
 * is no longer selectable (its skill was deleted) stays ticked as a deleted skill until unticked.
 * `skills` is undefined while either skill list loads (`unavailable` when one could not be read):
 * the pins are then kept as they are and only a status line shows, so a live pin never looks
 * deleted.
 */
export function PinnedSkillsPicker({
  skills,
  selected,
  value,
  onChange,
  changed = false,
  unavailable = false,
}: {
  skills: SkillSummary[] | undefined;
  /** A skill list could not be read (with `skills` undefined). */
  unavailable?: boolean;
  /** Ids of the selected skills (org skills in `orgSkills`, then the agent's own). */
  selected: string[];
  value: string[];
  onChange(next: string[]): void;
  /** The pinned list differs from the saved definition. */
  changed?: boolean;
}) {
  const t = useTranslations("agents.form");
  if (skills === undefined) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: fieldset has default browser border and padding, apps/web cannot style it; group with role=group
      <div role="group" aria-label={t("pinnedLabel")}>
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("pinnedLabel")}
          </Text>
          <Text variant="small" tone="faint">
            {unavailable ? t("pinnedUnavailable") : t("pinnedLoading")}
          </Text>
        </Stack>
      </div>
    );
  }
  const byId = new Map(skills.map((s) => [s.id, s]));
  const rows = selected.flatMap((id) => {
    const s = byId.get(id);
    return s === undefined ? [] : [s];
  });
  const stale = value.filter((id) => !rows.some((s) => s.id === id));
  const pinnedRows = rows.filter((s) => value.includes(s.id));
  const bytes = pinnedRows.reduce((n, s) => n + (s.entryBytes ?? 0), 0);
  const tokens = pinnedRows.reduce((n, s) => n + (s.tokenEstimate ?? 0), 0);
  const max = PINNED_SKILLS_LIMITS.count;
  const full = value.length >= max;
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset has default browser border and padding, apps/web cannot style it; group with role=group
    <div role="group" aria-label={t("pinnedLabel")}>
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {t("pinnedLabel")}
        </Text>
        <Text variant="small" tone="faint">
          {t("pinnedHint")}
        </Text>
        {rows.length === 0 && stale.length === 0 && (
          <Text variant="small" tone="faint">
            {t("noPinnable")}
          </Text>
        )}
        {rows.map((s) => {
          const on = value.includes(s.id);
          // a manual-only skill is not in the model's catalog: never newly pinned (phase D)
          const manual = s.manual === true;
          return (
            <Stack key={s.id} direction="row" gap={8} align="center">
              <Checkbox
                label={t("pinSkill", { name: s.name })}
                checked={on}
                disabled={!on && (full || manual)}
                onChange={(next) => toggle(s.id, next)}
              />
              <SkillTags skill={s} />
              {s.suggestPinned === true && <Badge>{t("suggested")}</Badge>}
              {s.tokenEstimate !== undefined && (
                <Text variant="small" tone="muted">
                  {t("tokenEstimate", { n: s.tokenEstimate })}
                </Text>
              )}
            </Stack>
          );
        })}
        {stale.map((id) => (
          <Checkbox
            key={id}
            label={t("deletedSkill", { id })}
            checked
            onChange={(next) => toggle(id, next)}
          />
        ))}
        {rows.some((s) => s.manual === true && !value.includes(s.id)) && (
          <Text variant="small" tone="faint">
            {t("manualNotPinnable")}
          </Text>
        )}
        {pinnedRows
          .filter((s) => s.manual === true)
          .map((s) => (
            <Text key={s.id} variant="small" tone="warn">
              {t("pinnedManualOnly", { name: s.name })}
            </Text>
          ))}
        {value.length > 0 && (
          <Text variant="small" tone="muted">
            {t("pinnedTotal", { count: value.length, max, n: tokens })}
          </Text>
        )}
        {full && rows.length > value.length && (
          <Text variant="small" tone="faint">
            {t("tooMany", { max })}
          </Text>
        )}
        {bytes > PINNED_SKILLS_LIMITS.totalBytes && (
          <>
            <Text variant="small" tone="warn">
              {t("overLimit", { bytes, max: PINNED_SKILLS_LIMITS.totalBytes })}
            </Text>
            <Text variant="small" tone="warn">
              {changed ? t("overLimitRefused") : t("overLimitKept")}
            </Text>
          </>
        )}
      </Stack>
    </div>
  );
}

/**
 * agent 自己写的技能（`scope=agent`，只读）：名称 · 版本与描述；负责人可删除（输入技能名二次确认），
 * 删除后 `onDeleted` 让调用方重读。
 */
export function OwnSkills({
  orgId,
  agentId,
  skills,
  canDelete,
  onDeleted,
}: {
  orgId: string;
  agentId: string;
  skills: SkillSummary[] | undefined;
  canDelete: boolean;
  onDeleted(skillId: string): void;
}) {
  const t = useTranslations("agents.form");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [target, setTarget] = useState<SkillSummary>();

  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset 带浏览器默认边框与内边距，apps/web 不能写样式；用 role=group 分组
    <div role="group" aria-label={t("ownSkillsLabel")}>
      <Stack gap={8}>
        <Stack gap={4}>
          <Text variant="small" tone="muted">
            {t("ownSkillsLabel")}
          </Text>
          <Text variant="small" tone="faint">
            {t("ownSkillsHint")}
          </Text>
        </Stack>
        {skills !== undefined && skills.length === 0 && (
          <Text variant="small" tone="faint">
            {t("noOwnSkills")}
          </Text>
        )}
        {(skills ?? []).map((s) => (
          <Stack key={s.id} direction="row" gap={12} align="center" justify="between">
            <Stack gap={0}>
              <Text>{t("ownSkillVersion", { name: s.name, version: s.currentVersion })}</Text>
              <Text variant="small" tone="muted" truncate>
                {s.description}
              </Text>
            </Stack>
            {canDelete && (
              <Button
                variant="danger"
                density="dense"
                aria-label={t("deleteOwnSkillLabel", { name: s.name })}
                onClick={() => setTarget(s)}
              >
                {t("deleteOwnSkill")}
              </Button>
            )}
          </Stack>
        ))}
      </Stack>
      <DangerConfirm
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined);
        }}
        title={t("deleteOwnSkillTitle", { name: target?.name ?? "" })}
        description={t("deleteOwnSkillHint")}
        confirmName={target?.name ?? ""}
        confirmLabel={t("deleteOwnSkill")}
        onConfirm={async () => {
          if (!target) return;
          try {
            await deleteAgentSkill(orgId, agentId, target.id);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast.success(t("ownSkillDeleted", { name: target.name }));
          setTarget(undefined);
          onDeleted(target.id);
        }}
      />
    </div>
  );
}
