"use client";

import {
  Badge,
  Button,
  Checkbox,
  DangerConfirm,
  EmptyState,
  ItemList,
  ItemListItem,
  Stack,
  Subsection,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { type OrgComponent, unavailableComponent } from "../lib/components";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import {
  deleteAgentSkill,
  PINNED_SKILLS_LIMITS,
  type SkillSummary,
  skillAliases,
} from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 组织技能多选：每个技能一个复选框（名称 · 描述），平台技能带「平台」标记。已选但不在库里的 id（技能已被删除）显示为
 * 「已删除的技能」并保持勾选，取消勾选即从定义里移除（内核修改时只核对新加的引用，保留它不会报错）。
 * A platform skill is selected when the definition names it or one of the org copies linked to it
 * (`linkedIds`, older agents); those copy ids are never shown as deleted. Unticking it removes
 * every alias; ticking it adds the platform skill's own id. A region of the skills card; with no
 * org skills the panel empty state, linking to the skills page when `skillsHref` is given (the
 * viewer can see it).
 */
export function OrgSkillsPicker({
  skills,
  offered,
  value,
  onChange,
  skillsHref,
}: {
  skills: SkillSummary[] | undefined;
  /** The platform components offered to the org: an id of one that is off reads as unavailable. */
  offered?: OrgComponent[] | null;
  value: string[];
  onChange(next: string[]): void;
  /** The skills page, for the empty state's action; undefined when the viewer cannot see it. */
  skillsHref?: string | undefined;
}) {
  const t = useTranslations("agents.form");
  const toggle = (s: SkillSummary, on: boolean) => {
    const aliases = skillAliases(s);
    onChange(on ? [...value, s.id] : value.filter((x) => !aliases.includes(x)));
  };
  const known = new Set((skills ?? []).flatMap(skillAliases));
  const missing = skills === undefined ? [] : value.filter((id) => !known.has(id));
  // a platform skill off in the org (spec §5 rule 8): unavailable, back when it is on again
  const unavailable = missing.flatMap((id) => {
    const c = unavailableComponent(offered, "skill", id);
    return c === undefined ? [] : [{ id, name: c.name }];
  });
  const deleted = missing.filter((id) => !unavailable.some((u) => u.id === id));
  return (
    <Subsection variant="divided" title={t("orgSkillsLabel")}>
      <Stack gap={4}>
        {skills !== undefined && skills.length === 0 && missing.length === 0 && (
          <EmptyState
            size="panel"
            text={t("noOrgSkills")}
            {...(skillsHref === undefined
              ? {}
              : {
                  action: { label: t("goToSkills"), variant: "default" as const, href: skillsHref },
                })}
          />
        )}
        {(skills ?? []).map((s) => (
          <Stack key={s.id} direction="row" gap={8} align="center">
            <Checkbox
              label={`${s.name} · ${s.description}`}
              checked={skillAliases(s).some((id) => value.includes(id))}
              onChange={(on) => toggle(s, on)}
            />
            <SkillTags skill={s} />
          </Stack>
        ))}
        {(skills ?? []).some((s) => s.manual === true) && (
          <Text variant="small" tone="faint">
            {t("manualHint")}
          </Text>
        )}
        {unavailable.map((u) => (
          <Checkbox
            key={u.id}
            label={t("unavailableSkill", { name: u.name })}
            checked
            onChange={(on) => onChange(on ? value : value.filter((x) => x !== u.id))}
          />
        ))}
        {unavailable.length > 0 && (
          <Text variant="small" tone="warn">
            {t("unavailableSkillHint")}
          </Text>
        )}
        {deleted.map((id) => (
          <Checkbox
            key={id}
            label={t("deletedSkill", { id })}
            checked
            onChange={(on) => onChange(on ? value : value.filter((x) => x !== id))}
          />
        ))}
        {deleted.length > 0 && (
          <Text variant="small" tone="warn">
            {t("deletedSkillHint")}
          </Text>
        )}
      </Stack>
    </Subsection>
  );
}

/**
 * Tags: "platform" (a platform skill on in the org), and phase D's "manual" (not in the model's
 * catalog), "sub-agent" (runs as one when invoked).
 */
function SkillTags({ skill }: { skill: Pick<SkillSummary, "manual" | "fork" | "origin"> }) {
  const t = useTranslations("agents.form");
  return (
    <>
      {skill.origin === "platform" && <Badge>{t("skillTag.platform")}</Badge>}
      {skill.manual === true && <Badge>{t("skillTag.manual")}</Badge>}
      {skill.fork === true && <Badge>{t("skillTag.fork")}</Badge>}
    </>
  );
}

/**
 * A private agent's `SkillWrite` confirmation (`skills.writePolicy`, D10): ticked = `ask`, every
 * skill write waits for the owner's confirmation; unticked (the default) = it takes effect
 * directly. A shared agent's skill changes always go through approval, so the form shows it only
 * on private agents, inside the agent-written skills region.
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
 * The agent's pinned skills (`skills.pinned`, spec §9.1): one checkbox per selected skill (the
 * org skills in `orgSkills` and the agent's own skills, in that order), with a "suggested" badge
 * when its plugin suggests pinning it and its token estimate; the pinned count and summed token
 * estimate; at the count limit the other boxes are disabled with a hint. Over the SKILL.md byte
 * limit (the current versions' sizes) a warning: when the list is unchanged runs keep what fits
 * (the kernel only refuses a changed list); when it changed, saving is refused. A pinned id that
 * is no longer selectable (its skill was deleted) stays ticked as a deleted skill until unticked.
 * `skills` is undefined when either skill list could not be read: the pins are then kept as they
 * are and only a status line shows, so a live pin never looks deleted. A region of the skills
 * card: the count against the limit at the heading's right; with nothing selected, one short line
 * where the pin list would be.
 */
export function PinnedSkillsPicker({
  skills,
  offered,
  selected,
  value,
  onChange,
  changed = false,
}: {
  /** Undefined when a skill list could not be read. */
  skills: SkillSummary[] | undefined;
  /** The platform components offered to the org: a pin of one that is off reads as unavailable. */
  offered?: OrgComponent[] | null;
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
      <Subsection variant="divided" title={t("pinnedLabel")} description={t("pinnedHint")}>
        <Text variant="small" tone="faint">
          {t("pinnedUnavailable")}
        </Text>
      </Subsection>
    );
  }
  // a linked copy's id stands for its platform skill (older agents select and pin copy ids)
  const byId = new Map(skills.flatMap((s) => skillAliases(s).map((id) => [id, s] as const)));
  /** Each selected skill once, under the id the definition selects it by. */
  const rows: (SkillSummary & { ref: string })[] = [];
  for (const id of selected) {
    const s = byId.get(id);
    if (s !== undefined && !rows.some((r) => r.id === s.id)) rows.push({ ...s, ref: id });
  }
  const pinnedOf = (s: SkillSummary) => skillAliases(s).some((id) => value.includes(id));
  const stale = value.filter((id) => !rows.some((s) => skillAliases(s).includes(id)));
  const pinnedRows = rows.filter(pinnedOf);
  const bytes = pinnedRows.reduce((n, s) => n + (s.entryBytes ?? 0), 0);
  const tokens = pinnedRows.reduce((n, s) => n + (s.tokenEstimate ?? 0), 0);
  const max = PINNED_SKILLS_LIMITS.count;
  const full = value.length >= max;
  const toggle = (id: string, on: boolean) =>
    onChange(on ? [...value, id] : value.filter((x) => x !== id));
  /** Pins a row under the id it is selected by; unpins every alias of it. */
  const toggleRow = (s: SkillSummary & { ref: string }, on: boolean) => {
    const aliases = skillAliases(s);
    onChange(on ? [...value, s.ref] : value.filter((x) => !aliases.includes(x)));
  };
  return (
    <Subsection
      variant="divided"
      title={t("pinnedLabel")}
      description={t("pinnedHint")}
      actions={
        <Text variant="small" tone="faint">
          {t("pinnedCount", { count: value.length, max })}
        </Text>
      }
    >
      <Stack gap={4}>
        {rows.length === 0 && stale.length === 0 && (
          <Text variant="small" tone="faint">
            {t("noPinnable")}
          </Text>
        )}
        {rows.map((s) => {
          const on = pinnedOf(s);
          // a manual-only skill is not in the model's catalog: never newly pinned (phase D)
          const manual = s.manual === true;
          return (
            <Stack key={s.id} direction="row" gap={8} align="center">
              <Checkbox
                label={t("pinSkill", { name: s.name })}
                checked={on}
                disabled={!on && (full || manual)}
                onChange={(next) => toggleRow(s, next)}
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
            label={(() => {
              const off = unavailableComponent(offered, "skill", id);
              return off !== undefined
                ? t("unavailableSkill", { name: off.name })
                : t("deletedSkill", { id });
            })()}
            checked
            onChange={(next) => toggle(id, next)}
          />
        ))}
        {rows.some((s) => s.manual === true && !pinnedOf(s)) && (
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
        {tokens > 0 && (
          <Text variant="small" tone="muted">
            {t("pinnedTotal", { n: tokens })}
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
    </Subsection>
  );
}

/**
 * The skills the agent wrote itself (`scope=agent`, read-only): name · version and description;
 * the owner may delete one (typing its name to confirm), then `onDeleted` lets the caller read
 * again. A region of the skills card; `children` (the write confirmation) stand under its heading,
 * above the list or its panel empty state.
 */
export function OwnSkills({
  orgId,
  agentId,
  skills,
  canDelete,
  onDeleted,
  children,
}: {
  orgId: string;
  agentId: string;
  skills: SkillSummary[] | undefined;
  canDelete: boolean;
  onDeleted(skillId: string): void;
  children?: ReactNode;
}) {
  const t = useTranslations("agents.form");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [target, setTarget] = useState<SkillSummary>();
  // A delete invalidates the agent's own skills: the list is read again.
  const remove = useAppMutation({
    fn: (skillId: string) => deleteAgentSkill(orgId, agentId, skillId),
    invalidates: () => [keys.org(orgId).agentSkills(agentId)],
  });

  return (
    <Subsection variant="divided" title={t("ownSkillsLabel")}>
      <Stack gap={8}>
        {children}
        {skills !== undefined && (
          <ItemList label={t("ownSkillsLabel")} empty={t("noOwnSkills")}>
            {skills.map((s) => (
              <ItemListItem
                key={s.id}
                title={s.name}
                code={versionLabel(s.currentVersion)}
                meta={s.description}
                actions={
                  canDelete ? (
                    <Button
                      variant="danger"
                      density="dense"
                      aria-label={t("deleteOwnSkillLabel", { name: s.name })}
                      onClick={() => setTarget(s)}
                    >
                      {t("deleteOwnSkill")}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </ItemList>
        )}
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
            await remove.mutateAsync(target.id);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast.success(t("ownSkillDeleted", { name: target.name }));
          setTarget(undefined);
          onDeleted(target.id);
        }}
      />
    </Subsection>
  );
}
