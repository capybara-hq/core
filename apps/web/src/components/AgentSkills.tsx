"use client";

import { Button, Checkbox, DangerConfirm, Stack, Text, useToast } from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { deleteAgentSkill, listAgentSkills, listSkills, type SkillSummary } from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";

/**
 * 组织技能库（`GET /skills`）：读不到（如访客、接口出错）时为空列表，表单照常可用。
 * `undefined` 表示还在读取。
 */
export function useOrgSkills(orgId: string): SkillSummary[] | undefined {
  const [skills, setSkills] = useState<SkillSummary[]>();
  useEffect(() => {
    let disposed = false;
    listSkills(orgId).then(
      (r) => {
        if (!disposed) setSkills(r.skills);
      },
      () => {
        if (!disposed) setSkills([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId]);
  return skills;
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
          <Checkbox
            key={s.id}
            label={`${s.name} · ${s.description}`}
            checked={value.includes(s.id)}
            onChange={(on) => toggle(s.id, on)}
          />
        ))}
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
 * agent 自己写的技能（`scope=agent`，只读）：名称 · 版本与描述；负责人可删除（输入技能名二次确认）。
 */
export function OwnSkills({
  orgId,
  agentId,
  canDelete,
}: {
  orgId: string;
  agentId: string;
  canDelete: boolean;
}) {
  const t = useTranslations("agents.form");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [skills, setSkills] = useState<SkillSummary[]>();
  const [nonce, setNonce] = useState(0);
  const [target, setTarget] = useState<SkillSummary>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce 只用于触发重读
  useEffect(() => {
    let disposed = false;
    listAgentSkills(orgId, agentId).then(
      (r) => {
        if (!disposed) setSkills(r.skills);
      },
      () => {
        if (!disposed) setSkills([]);
      },
    );
    return () => {
      disposed = true;
    };
  }, [orgId, agentId, nonce]);

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
                size={24}
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
          setNonce((n) => n + 1);
        }}
      />
    </div>
  );
}
