"use client";

import {
  Badge,
  Button,
  Checkbox,
  CheckList,
  DangerConfirm,
  Dialog,
  EmptyState,
  FilePicker,
  Icon,
  Input,
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
import type { DisabledSkillRef } from "../lib/agents";
import { ApiClientError, issueLines } from "../lib/api";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import {
  deleteAgentSkill,
  precheckSkillZip,
  type SkillSummary,
  shareAgentSkill,
  uploadAgentSkillZip,
} from "../lib/skills";
import {
  type PluginChange,
  pluginAllOff,
  type SkillKeyOf,
  setOwnSkills,
  setPluginSkills,
  skillIdKeys,
  skillIsOff,
} from "../lib/skills-off";
import { useErrorMessage } from "../lib/use-error-message";
import { FormError } from "./form-error";

/**
 * The skills on in the org, for an agent or a template (skills default-on spec §10): one grouped
 * list ({@link SkillGroups}) where a checked row is on. Every skill is on unless `value` turns it
 * off; entries for skills not listed here (a plugin the org turned off, a deleted skill) stay as
 * they are. The summary (on and off counts, with `extraOn` for skills always on that are listed
 * elsewhere, such as the agent's own) stands at the heading's right. A region of the skills card;
 * with no skills the panel empty state, linking to the skills page when `skillsHref` is given (the
 * viewer can see it).
 */
export function OrgSkillsPicker({
  skills,
  value,
  onChange,
  keyOf = skillIdKeys,
  extraOn = 0,
  skillsHref,
  disabled = false,
}: {
  skills: SkillSummary[] | undefined;
  /** What is turned off. */
  value: DisabledSkillRef[];
  onChange(next: DisabledSkillRef[]): void;
  /** How a skill without a plugin is named in `value` (an agent: by id; a template: by name). */
  keyOf?: SkillKeyOf;
  /** Skills on that this list does not show (the agent's own), for the summary. */
  extraOn?: number;
  /** The skills page, for the empty state's action; undefined when the viewer cannot see it. */
  skillsHref?: string | undefined;
  disabled?: boolean;
}) {
  const t = useTranslations("agents.form");
  const list = skills ?? [];
  const off = list.filter((s) => skillIsOff(value, s, keyOf)).length;
  return (
    <Subsection
      variant="divided"
      title={t("orgSkillsLabel")}
      actions={
        skills === undefined ? undefined : (
          <Text variant="small" tone="faint">
            {t("skillsSummary", { on: list.length - off + extraOn, off })}
          </Text>
        )
      }
    >
      <Stack gap={4}>
        {skills === undefined && (
          <Text variant="small" tone="faint">
            {t("skillsUnreadable")}
          </Text>
        )}
        {skills !== undefined && skills.length === 0 && (
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
        {skills !== undefined && skills.length > 0 && (
          <SkillGroups
            skills={skills}
            value={value}
            onChange={onChange}
            keyOf={keyOf}
            disabled={disabled}
          />
        )}
        {list.some((s) => s.manual === true) && (
          <Text variant="small" tone="faint">
            {t("manualHint")}
          </Text>
        )}
      </Stack>
    </Subsection>
  );
}

/** From this many skills a skill list draws its filter field (as ToolPolicyList's, spec §6.36). */
const SKILL_SEARCH_FROM = 8;

export type SkillGroup = {
  id: string;
  title: string;
  /** The plugin of a plugin group. */
  plugin?: string;
  skills: SkillSummary[];
};

/**
 * The skills grouped by where they come from: one group per plugin (by its name), then the org's
 * own skills (no plugin), then the built-in ones (a builtin plugin's: always on).
 */
export function skillGroupsOf(
  skills: readonly SkillSummary[],
  names: { org: string; builtin: string },
): SkillGroup[] {
  const plugins = new Map<string, SkillSummary[]>();
  const own: SkillSummary[] = [];
  const builtin: SkillSummary[] = [];
  for (const s of skills) {
    if (s.builtin === true) builtin.push(s);
    else if (s.plugin) plugins.set(s.plugin, [...(plugins.get(s.plugin) ?? []), s]);
    else own.push(s);
  }
  return [
    ...[...plugins.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([plugin, list]) => ({ id: `plugin:${plugin}`, title: plugin, plugin, skills: list })),
    ...(own.length > 0 ? [{ id: "org", title: names.org, skills: own }] : []),
    ...(builtin.length > 0 ? [{ id: "builtin", title: names.builtin, skills: builtin }] : []),
  ];
}

/**
 * The skills on / off, one `CheckList` per group ({@link skillGroupsOf}); a checked row is on and
 * every row starts checked. A plugin group's head is the whole plugin: unchecking it turns the
 * plugin off with its later skills (`"all"`, the line 「已关闭全部（含以后新增的）」 under it),
 * checking it clears the entry; unchecking the last row on one by one does the same. The 本组织
 * head turns its rows on or off one by one. Built-in skills are checked and locked. Each row is
 * the name with its tags on the first line and the description as one cut line (the full text on
 * hover). With many skills a filter field narrows the rows by name and description; a head then
 * acts on the rows it shows, by name, never on the whole plugin.
 */
export function SkillGroups({
  skills,
  value,
  onChange,
  keyOf = skillIdKeys,
  disabled = false,
}: {
  skills: readonly SkillSummary[];
  value: DisabledSkillRef[];
  onChange(next: DisabledSkillRef[]): void;
  keyOf?: SkillKeyOf;
  disabled?: boolean;
}) {
  const t = useTranslations("agents.form");
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (s: SkillSummary) =>
    q === "" || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
  const groups = skillGroupsOf(skills, {
    org: t("skillGroupOrg"),
    builtin: t("skillGroupBuiltin"),
  })
    .map((g) => ({ ...g, known: g.skills, skills: g.skills.filter(matches) }))
    .filter((g) => g.skills.length > 0);
  return (
    <Stack gap={12}>
      {skills.length >= SKILL_SEARCH_FROM && (
        <Input
          type="search"
          density="dense"
          prefix={<Icon name="search" size={14} />}
          placeholder={t("searchSkills")}
          aria-label={t("searchSkills")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {groups.length === 0 && <EmptyState size="panel" text={t("noSkillMatch")} />}
      {groups.map((g) => {
        const byId = new Map(g.skills.map((s) => [s.id, s]));
        const pick = (ids: string[]) =>
          ids.flatMap((id) => {
            const s = byId.get(id);
            return s === undefined ? [] : [s];
          });
        const change = (list: SkillSummary[], on: boolean, how: PluginChange) => {
          if (g.plugin === undefined) onChange(setOwnSkills(value, list, on, keyOf));
          else {
            onChange(
              setPluginSkills(
                value,
                g.plugin,
                g.known.map((s) => s.name),
                list.map((s) => s.name),
                on,
                how,
              ),
            );
          }
        };
        const allOff = g.plugin !== undefined && pluginAllOff(value, g.plugin);
        const offCount = g.known.filter((s) => skillIsOff(value, s, keyOf)).length;
        return (
          <Stack key={g.id} gap={4}>
            <CheckList
              label={g.title}
              title={g.title}
              disabled={disabled}
              rows={g.skills.map((s) => ({
                id: s.id,
                title: s.name,
                marks: <SkillTags skill={s} />,
                description: s.description,
                checked: !skillIsOff(value, s, keyOf),
                // a builtin plugin's skill: every agent has it
                locked: s.builtin === true,
              }))}
              onCheck={(id, on) => change(pick([id]), on, "row")}
              onCheckAll={(ids, on) => change(pick(ids), on, q === "" ? "head" : "shown")}
            />
            {g.id === "builtin" && (
              <Text variant="small" tone="faint">
                {t("builtinHint")}
              </Text>
            )}
            {allOff ? (
              <Text variant="small" tone="muted">
                {t("skillsOffAll")}
              </Text>
            ) : offCount > 0 ? (
              <Text variant="small" tone="muted">
                {t("skillsOffSome", { n: offCount })}
              </Text>
            ) : null}
          </Stack>
        );
      })}
    </Stack>
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
  onDeleted?(skillId: string): void;
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
          onDeleted?.(target.id);
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
