"use client";

import {
  Badge,
  CodeBlock,
  DisclosureLinks,
  Icon,
  ItemList,
  ItemListItem,
  KeyValue,
  Stack,
  Subsection,
  Text,
  TextLink,
  versionLabel,
} from "@capybara-hq/design";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { endpointLeaves, hasHiddenCharacters, showValue } from "../../lib/catalog";
import { HiddenCharactersWarning } from "../CatalogParts";
import { PermissionReview } from "../PermissionReview";
import {
  type AgentRow,
  type ContentsDependency,
  type ContentsExtension,
  hostOf,
  type RowMark,
  type SkillRow,
  type Stage,
  type TemplateRow,
  type ThemeRow,
} from "./model";

const hasHidden = (texts: (string | undefined)[]): boolean =>
  texts.some((x) => x !== undefined && hasHiddenCharacters(x));

/** A row's change mark: the update's change word as a badge (a loss in warn). */
export function MarkBadge({ mark }: { mark: RowMark }) {
  const t = useTranslations("catalog.update.change");
  return (
    <Badge
      tone={
        mark === "removed" || mark === "downgrade"
          ? "warn"
          : mark === "added"
            ? "accent"
            : "default"
      }
    >
      {t(mark)}
    </Badge>
  );
}

/**
 * A row's generic end as ItemListItem / Subsection `actions`: its change mark and the surface's
 * trailing slot; nothing (no prop) when it has neither.
 */
function rowEnd(mark: RowMark | undefined, trailing: ReactNode): { actions?: ReactNode } {
  if (mark === undefined && (trailing === undefined || trailing === null)) return {};
  return {
    actions: (
      <Stack direction="row" gap={8} align="center">
        {mark !== undefined && <MarkBadge mark={mark} />}
        {trailing}
      </Stack>
    ),
  };
}

/** Short values as a row of chips; the ones in `added` carry the "new" mark. */
export function Chips({ items, added = new Set() }: { items: string[]; added?: Set<string> }) {
  const t = useTranslations("catalog.admin.review");
  return (
    <Stack direction="row" gap={4} wrap>
      {items.map((x, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: names may repeat; the order is fixed
        <Stack key={`${i}:${x}`} direction="row" gap={4} align="center">
          <Badge>{x}</Badge>
          {added.has(x) && <Badge tone="accent">{t("newMark")}</Badge>}
        </Stack>
      ))}
    </Stack>
  );
}

/**
 * The extension: what it provides (extension point chips and, in plain words, why that is
 * sensitive), its top-level config fields as chips (a lock on the secret ones), one note line on
 * where they are filled in (install and update: after installing; enable: after enabling; only
 * when there is config), then the rest of its permissions.
 */
export function ExtensionBlock({
  extension,
  stage,
}: {
  extension: ContentsExtension;
  stage: Stage;
}) {
  const t = useTranslations("catalog.admin.review");
  const tp = useTranslations("extensions");
  const reasons = [
    ...new Set(
      extension.provides.flatMap((e) => {
        const key = `review.reason.${e.reason}`;
        return e.sensitive && e.reason !== undefined && tp.has(key) ? [tp(key)] : [];
      }),
    ),
  ];
  const addedProvides = new Set(extension.provides.filter((e) => e.added).map((e) => e.value));
  const rows = [
    ...(extension.provides.length > 0
      ? [
          {
            k: t("provides"),
            v: (
              <Stack gap={4}>
                <Stack direction="row" gap={4} wrap align="center">
                  <Chips items={extension.provides.map((e) => e.value)} added={addedProvides} />
                  {extension.provides.some((e) => e.sensitive) && (
                    <Badge tone="warn">{tp("sensitive")}</Badge>
                  )}
                </Stack>
                {reasons.map((r) => (
                  <Text key={r} variant="small" tone="warn">
                    {r}
                  </Text>
                ))}
              </Stack>
            ),
          },
        ]
      : []),
    ...(extension.config.length > 0
      ? [
          {
            k: t("config"),
            v: (
              <Stack direction="row" gap={4} wrap>
                {extension.config.map((f) => (
                  <Stack key={f.name} direction="row" gap={4} align="center">
                    {/* A secret field is counted among the sensitive items: drawn in warn */}
                    <Badge {...(f.secret && { tone: "warn" as const })}>
                      {f.secret && <Icon name="lock" size={12} label={t("secret")} />}
                      {f.name}
                    </Badge>
                    {f.added === true && <Badge tone="accent">{t("newMark")}</Badge>}
                  </Stack>
                ))}
              </Stack>
            ),
          },
        ]
      : []),
  ];
  const note =
    !extension.needsConfig || stage === "detail"
      ? null
      : stage === "enable"
        ? t("configAfterEnable")
        : t("configAfterInstall");
  const p = extension.permissions;
  // A subsection, not a card (spec §6.32): the contents sit on pages and in Dialogs, and the
  // permission rows already group with hairlines.
  return (
    <Subsection title={extension.name} {...rowEnd(extension.mark, extension.state)}>
      <Stack gap={8}>
        {extension.keptVersion !== undefined && (
          <Text>{t("action.keep", { version: versionLabel(extension.keptVersion) })}</Text>
        )}
        {rows.length > 0 && <KeyValue rows={rows} keyWidth="8ch" />}
        {note !== null && (
          <Text variant="small" tone="muted">
            {note}
          </Text>
        )}
        {p !== undefined && (
          <PermissionReview
            plugin={extension.name}
            groups={p.groups}
            {...(p.added !== undefined && { added: p.added })}
            {...(p.removed !== undefined && { removed: p.removed })}
            warnings={p.warnings}
            {...(p.clientFiles !== undefined && { clientFiles: p.clientFiles })}
          />
        )}
        {extension.trailing}
      </Stack>
    </Subsection>
  );
}

/** Skills: name, file count, description; SKILL.md opens inline. */
export function SkillRows({ rows }: { rows: SkillRow[] }) {
  const t = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  return (
    <ItemList label={tc("skills")}>
      {rows.map((s) => (
        <ItemListItem
          key={s.key}
          title={s.name}
          {...(s.href !== undefined && { href: s.href })}
          marks={
            <>
              {s.files !== undefined && <Badge>{tc("skillFiles", { n: s.files })}</Badge>}
              {hasHidden([s.description, s.body]) && (
                <Badge tone="warn">{t("hiddenCharacters")}</Badge>
              )}
            </>
          }
          {...rowEnd(s.mark, s.trailing)}
          meta={
            s.description !== "" ? (
              <Text variant="small" tone="muted">
                {s.description}
              </Text>
            ) : undefined
          }
        >
          {s.body !== undefined && (
            <DisclosureLinks
              items={[
                {
                  key: "body",
                  summary: t("skillBody"),
                  children: (
                    <Stack gap={8}>
                      <HiddenCharactersWarning texts={[s.description, s.body]} />
                      <CodeBlock text={s.body} />
                    </Stack>
                  ),
                },
              ]}
            />
          )}
        </ItemListItem>
      ))}
    </ItemList>
  );
}

/**
 * Connector templates: the icon, the name, what the template needs, and one line (the host and
 * whether orgs can change it) that is the toggle opening the description, the full address and
 * the auth.
 */
export function TemplateRows({ rows }: { rows: TemplateRow[] }) {
  const t = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  return (
    <ItemList label={tc("templates")}>
      {rows.map((c) => {
        const host = hostOf(c.endpoint);
        const editable = c.editableEndpoint ?? [];
        const line = [host, editable.length > 0 ? t("orgCanChange") : ""].filter((x) => x !== "");
        const details = c.endpoint !== undefined || c.auth !== undefined || c.description !== "";
        return (
          <ItemListItem
            key={c.key}
            title={c.name}
            {...(c.href !== undefined && { href: c.href })}
            mark={{ text: c.name, image: c.icon ?? null }}
            marks={
              <>
                {c.need !== undefined && (
                  <Badge>
                    {c.need === "client" ? t("needsOAuthClient") : t("needsOrgCredential")}
                  </Badge>
                )}
                {c.endpointChecked === false && <Badge tone="warn">{t("endpointUnchecked")}</Badge>}
                {c.defaultOff === true && (
                  <Text variant="small" tone="muted">
                    {t("defaultOff")}
                  </Text>
                )}
              </>
            }
            {...rowEnd(c.mark, c.trailing)}
            meta={
              details ? (
                <DisclosureLinks
                  items={[
                    {
                      key: "endpoint",
                      summary: line.length > 0 ? line.join(" · ") : t("endpointDetails"),
                      children: (
                        <Stack gap={4}>
                          {c.description !== "" && (
                            <Text variant="small" tone="muted">
                              {c.description}
                            </Text>
                          )}
                          {c.endpoint !== undefined && (
                            <KeyValue
                              keyWidth="14ch"
                              rows={endpointLeaves(c.endpoint).map(([k, v]) => ({
                                k,
                                v: showValue(v),
                              }))}
                            />
                          )}
                          {editable.length > 0 && (
                            <Text variant="small" tone="muted">
                              {t("editable", { paths: editable.join(", ") })}
                            </Text>
                          )}
                          {c.auth !== undefined && (
                            <Text variant="small">
                              {t("auth", { type: String(c.auth.type ?? "none") })}
                            </Text>
                          )}
                        </Stack>
                      ),
                    },
                  ]}
                />
              ) : undefined
            }
          />
        );
      })}
    </ItemList>
  );
}

/** Agent templates: name, model tier, description, needs and tools rows, the instructions inline. */
export function AgentRows({ rows }: { rows: AgentRow[] }) {
  const t = useTranslations("catalog.admin.review");
  const tc = useTranslations("catalog.components");
  const tier = useTranslations("agents.form.subagents.tier");
  return (
    <ItemList label={tc("agentTemplates")}>
      {rows.map((a) => {
        const inherit = a.tools === undefined && (a.disallowedTools ?? []).length === 0;
        return (
          <ItemListItem
            key={a.key}
            title={a.name}
            {...(a.href !== undefined && { href: a.href })}
            marks={
              <>
                {a.model !== undefined && <Badge>{tier(a.model)}</Badge>}
                {hasHidden([a.description, a.instructions]) && (
                  <Badge tone="warn">{t("hiddenCharacters")}</Badge>
                )}
              </>
            }
            {...rowEnd(a.mark, a.trailing)}
            meta={
              a.description !== "" ? (
                <Text variant="small" tone="muted">
                  {a.description}
                </Text>
              ) : undefined
            }
          >
            <Stack gap={8}>
              {(a.needs.length > 0 || a.toolsUnknown !== true) && (
                <KeyValue
                  keyWidth="6ch"
                  rows={[
                    ...(a.needs.length > 0
                      ? [
                          {
                            k: t("agentNeeds"),
                            v: (
                              <Chips
                                items={a.needs.map((n) =>
                                  n.host === undefined
                                    ? n.label
                                    : t("agentNeedsDescribed", { label: n.label, host: n.host }),
                                )}
                              />
                            ),
                          },
                        ]
                      : []),
                    ...(a.toolsUnknown === true
                      ? []
                      : [
                          {
                            k: t("tools"),
                            v: inherit ? (
                              tc("agentToolsInherit")
                            ) : (
                              <Chips
                                items={[
                                  ...(a.tools ?? []),
                                  ...(a.disallowedTools ?? []).map((x) =>
                                    tc("agentToolsRemoved", { tools: x }),
                                  ),
                                ]}
                              />
                            ),
                          },
                        ]),
                  ]}
                />
              )}
              {a.instructions !== undefined && (
                <DisclosureLinks
                  items={[
                    {
                      key: "instructions",
                      summary: tc("agentInstructions"),
                      children: (
                        <Stack gap={8}>
                          <HiddenCharactersWarning texts={[a.description, a.instructions]} />
                          <CodeBlock text={a.instructions} />
                        </Stack>
                      ),
                    },
                  ]}
                />
              )}
            </Stack>
          </ItemListItem>
        );
      })}
    </ItemList>
  );
}

/** Themes: name and description. */
export function ThemeRows({ rows }: { rows: ThemeRow[] }) {
  const tc = useTranslations("catalog.components");
  return (
    <ItemList label={tc("themes")}>
      {rows.map((th) => (
        <ItemListItem
          key={th.key}
          title={th.name}
          {...(th.href !== undefined && { href: th.href })}
          {...rowEnd(th.mark, th.trailing)}
          meta={
            th.description !== undefined && th.description !== "" ? (
              <Text variant="small" tone="muted">
                {th.description}
              </Text>
            ) : undefined
          }
        />
      ))}
    </ItemList>
  );
}

/**
 * Dependencies: on the platform "{name} will use {version}" (a warn line when none matches yet);
 * on an org's enable the plugins installed with it; on a plugin page each name and its range.
 */
export function DependencyLines({ rows, stage }: { rows: ContentsDependency[]; stage: Stage }) {
  const tc = useTranslations("catalog.components");
  const name = (d: ContentsDependency) =>
    d.href !== undefined ? <TextLink href={d.href}>{d.name}</TextLink> : d.name;
  return (
    <Stack gap={4}>
      {rows.map((d) => (
        <Stack key={d.name} direction="row" gap={8} align="center" wrap>
          {stage === "enable" || stage === "detail" ? (
            <>
              <Text>{name(d)}</Text>
              <Text variant="small" tone="muted">
                {d.resolved !== null && stage === "enable" ? versionLabel(d.resolved) : d.range}
              </Text>
            </>
          ) : d.resolved !== null ? (
            <Text>
              {tc("dependencyResolved", { name: d.name, version: versionLabel(d.resolved) })}
            </Text>
          ) : (
            <Text tone="warn">{tc("dependencyUnresolved", { name: d.name, range: d.range })}</Text>
          )}
          {rowEnd(d.mark, d.trailing).actions}
        </Stack>
      ))}
    </Stack>
  );
}
