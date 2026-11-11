"use client";

import {
  Badge,
  Button,
  Checkbox,
  DangerConfirm,
  Dialog,
  EmptyState,
  FilePicker,
  ItemList,
  ItemListItem,
  Stack,
  Subsection,
  Text,
  useToast,
  versionLabel,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { ApiClientError, issueLines } from "../lib/api";
import { type OrgComponent, unavailableComponent } from "../lib/components";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import {
  deleteAgentSkill,
  PINNED_SKILLS_LIMITS,
  precheckSkillZip,
  type SkillSummary,
  shareAgentSkill,
  skillAliases,
  uploadAgentSkillZip,
} from "../lib/skills";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The org skills multi-select: one checkbox per skill (name · description), platform skills with a
 * "platform" tag. A selected id that is not in the library (the skill was deleted) shows as a
 * deleted skill and stays ticked; unticking removes it from the definition (the kernel checks only
 * newly added references on save, so keeping it is not an error).
 * A platform skill is selected when the definition names it or one of the org copies linked to it
 * (`linkedIds`, older agents); those copy ids are never shown as deleted. Unticking it removes
 * every alias; ticking it adds the platform skill's own id. A builtin plugin's skill (`builtin`)
 * shows ticked and disabled: every agent has it without selecting it. A region of the skills card; with no
 * org skills the panel empty state, linking to the skills page when `skillsHref` is given (the
 * viewer can see it).
 */
export function OrgSkillsPicker({
  skills,
  offered,
  value,
  onChange,
  skillsHref,
  alsoKnown = [],
}: {
  skills: SkillSummary[] | undefined;
  /** The platform components offered to the org: an id of one that is off reads as unavailable. */
  offered?: OrgComponent[] | null;
  /** Ids listed elsewhere on the page (skills the agent shared): never shown as deleted here. */
  alsoKnown?: readonly string[];
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
  const known = new Set([...(skills ?? []).flatMap(skillAliases), ...alsoKnown]);
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
              // a builtin plugin's skill: every agent has it, nothing to select
              checked={s.builtin === true || skillAliases(s).some((id) => value.includes(id))}
              disabled={s.builtin === true}
              onChange={(on) => toggle(s, on)}
            />
            <SkillTags skill={s} />
          </Stack>
        ))}
        {(skills ?? []).some((s) => s.builtin === true) && (
          <Text variant="small" tone="faint">
            {t("builtinHint")}
          </Text>
        )}
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
 * Tags: "platform" (a platform skill on in the org), "built-in" (a builtin plugin's skill, always
 * included), and phase D's "manual" (not in the model's
 * catalog), "sub-agent" (runs as one when invoked).
 */
function SkillTags({
  skill,
}: {
  skill: Pick<SkillSummary, "manual" | "fork" | "origin" | "builtin">;
}) {
  const t = useTranslations("agents.form");
  return (
    <>
      {skill.origin === "platform" && <Badge>{t("skillTag.platform")}</Badge>}
      {skill.builtin === true && <Badge>{t("skillTag.builtin")}</Badge>}
      {skill.manual === true && <Badge>{t("skillTag.manual")}</Badge>}
      {skill.fork === true && <Badge>{t("skillTag.fork")}</Badge>}
    </>
  );
}

/**
 * A private agent's registration confirmation (`skills.writePolicy`, governs
 * `agents.register-skill`): ticked = `ask`, every registration waits for the owner's confirmation
 * and the answer is never remembered; unticked (the default) = it takes effect directly. A shared
 * agent's registrations always ask, so the form shows it only on private agents, inside the
 * agent's own skills region.
 */
export function SkillRegistrationSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange(next: boolean): void;
}) {
  const t = useTranslations("agents.form");
  return (
    <Stack gap={4}>
      <Checkbox label={t("confirmSkillRegister")} checked={value} onChange={onChange} />
      <Text variant="small" tone="faint">
        {t("confirmSkillRegisterHint")}
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
 * The agent's own skills (`scope=agent`) and the org skills it shared (marked "shared with the
 * org", no actions): name · version and description. Everyone who can open
 * the agent reads the list; only the owner (`canManage`) sees the actions: upload a skill package
 * (zip), share one with the org (a confirm dialog; for a non-admin it files a request, shown as
 * "waiting for an org admin" from then on) and delete (typing its name to confirm). `onDeleted`
 * lets the caller drop what referenced it. A region of the skills card; `children` (the
 * registration confirmation) stand under its heading, above the list.
 */
export function OwnSkills({
  orgId,
  agentId,
  skills,
  canManage,
  onDeleted,
  children,
}: {
  orgId: string;
  agentId: string;
  skills: SkillSummary[] | undefined;
  canManage: boolean;
  onDeleted(skillId: string): void;
  children?: ReactNode;
}) {
  const t = useTranslations("agents.form");
  const toast = useToast();
  const qc = useQueryClient();
  const errorMessage = useErrorMessage();
  const [target, setTarget] = useState<SkillSummary>();
  const [shareTarget, setShareTarget] = useState<SkillSummary>();
  const [shareError, setShareError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  // A delete invalidates the agent's own skills: the list is read again.
  const remove = useAppMutation({
    fn: (skillId: string) => deleteAgentSkill(orgId, agentId, skillId),
    invalidates: () => [keys.org(orgId).agentSkills(agentId)],
  });
  // A shared skill joins the org's list and stays in the agent's, marked shared
  const share = useAppMutation({
    fn: (skillId: string) => shareAgentSkill(orgId, agentId, skillId),
    invalidates: () => [
      keys.org(orgId).agentSkills(agentId),
      keys.org(orgId).skills(),
      keys.org(orgId).componentsAll(),
    ],
  });

  return (
    <Subsection
      variant="divided"
      title={t("ownSkillsLabel")}
      actions={
        canManage ? (
          <Button density="dense" onClick={() => setUploading(true)}>
            {t("uploadSkill")}
          </Button>
        ) : undefined
      }
    >
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
                marks={s.shared === true ? <Badge>{t("sharedWithOrg")}</Badge> : undefined}
                actions={
                  // a shared skill is the org's now: no share or delete from the agent
                  canManage && s.shared !== true ? (
                    <Stack direction="row" gap={8} align="center">
                      {s.sharePending === true ? (
                        <Text variant="small" tone="muted">
                          {t("shareWaiting")}
                        </Text>
                      ) : (
                        <Button
                          density="dense"
                          aria-label={t("shareOwnSkillLabel", { name: s.name })}
                          onClick={() => {
                            setShareError(undefined);
                            setShareTarget(s);
                          }}
                        >
                          {t("shareOwnSkill")}
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        density="dense"
                        aria-label={t("deleteOwnSkillLabel", { name: s.name })}
                        onClick={() => setTarget(s)}
                      >
                        {t("deleteOwnSkill")}
                      </Button>
                    </Stack>
                  ) : undefined
                }
              />
            ))}
          </ItemList>
        )}
      </Stack>
      {uploading && (
        <UploadSkillDialog orgId={orgId} agentId={agentId} onClose={() => setUploading(false)} />
      )}
      <Dialog
        open={shareTarget !== undefined}
        onOpenChange={(open) => {
          if (!open && !share.isPending) setShareTarget(undefined);
        }}
        title={t("shareOwnSkillTitle", { name: shareTarget?.name ?? "" })}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={share.isPending}
              onClick={() => setShareTarget(undefined)}
            >
              {t("shareCancel")}
            </Button>
            <Button
              variant="primary"
              loading={share.isPending}
              onClick={async () => {
                if (!shareTarget) return;
                setShareError(undefined);
                try {
                  const r = await share.mutateAsync(shareTarget.id);
                  if (r.kind === "shared")
                    toast.success(t("ownSkillShared", { name: shareTarget.name }));
                  else {
                    toast.success(t("shareRequested", { name: shareTarget.name }));
                  }
                  setShareTarget(undefined);
                } catch (e) {
                  if (e instanceof ApiClientError && e.code === "skill.share_pending") {
                    // Already waiting (another tab, or a stale list): read the list again
                    await qc.invalidateQueries({ queryKey: keys.org(orgId).agentSkills(agentId) });
                    setShareTarget(undefined);
                    toast.error(errorMessage(e));
                  } else setShareError(errorMessage(e));
                }
              }}
            >
              {t("shareConfirm")}
            </Button>
          </>
        }
      >
        <Stack gap={8}>
          <Text variant="prose">{t("shareOwnSkillHint")}</Text>
          {shareError !== undefined && <FormError message={shareError} />}
        </Stack>
      </Dialog>
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

/**
 * Picks one skill package (.zip) for the agent: prechecked in the browser, uploaded with its
 * progress and registered by the kernel. A new version of a shared skill the owner maintains may
 * be proposed to the org admins instead of applied (a different toast).
 */
function UploadSkillDialog({
  orgId,
  agentId,
  onClose,
}: {
  orgId: string;
  agentId: string;
  onClose(): void;
}) {
  const t = useTranslations("agents.form.uploadSkillDialog");
  const toast = useToast();
  const errorMessage = useErrorMessage();
  const [progress, setProgress] = useState<number>();
  const [error, setError] = useState<{ message: string; extra: string[] }>();
  // A registration adds the agent's skill, or a version of a shared skill (the org's lists too)
  const send = useAppMutation({
    fn: (file: File) =>
      uploadAgentSkillZip(orgId, agentId, file, { onProgress: (f) => setProgress(f) }),
    invalidates: () => [
      keys.org(orgId).agentSkills(agentId),
      keys.org(orgId).skills(),
      keys.org(orgId).componentsAll(),
    ],
  });

  async function pick(files: File[]) {
    const file = files[0];
    if (!file || send.isPending) return;
    const bad = precheckSkillZip(file);
    if (bad !== null) {
      setError({ message: t(bad), extra: [] });
      return;
    }
    setError(undefined);
    setProgress(0);
    try {
      const r = await send.mutateAsync(file);
      toast.success(
        r.kind === "proposed"
          ? t("proposed", { name: r.name })
          : r.created
            ? t("created", { name: r.name })
            : t("versionCreated", { name: r.name, version: r.version }),
      );
      onClose();
    } catch (e) {
      setError({ message: errorMessage(e), extra: issueLines(e) });
    } finally {
      setProgress(undefined);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !send.isPending) onClose();
      }}
      title={t("title")}
      footer={
        <Button variant="ghost" disabled={send.isPending} onClick={onClose}>
          {t("cancel")}
        </Button>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("hint")}</Text>
        <FilePicker
          label={t("choose")}
          hint={t("chooseHint")}
          dropLabel={t("drop")}
          accept=".zip,application/zip"
          onFiles={(f) => void pick(f)}
          disabled={send.isPending}
        >
          {progress !== undefined && (
            <Text variant="small">{t("uploading", { percent: Math.round(progress * 100) })}</Text>
          )}
        </FilePicker>
        {error !== undefined && <FormError message={error.message} extra={error.extra} />}
      </Stack>
    </Dialog>
  );
}
