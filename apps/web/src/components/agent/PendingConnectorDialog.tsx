"use client";

import {
  Button,
  Dialog,
  Field,
  ItemList,
  ItemListItem,
  LinkButton,
  RadioGroup,
  Select,
  Skeleton,
  Stack,
  Text,
  useToast,
} from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Link } from "../../i18n/navigation";
import { displayNameOf, type OrgCatalogTemplate } from "../../lib/catalog";
import {
  addTemplateConnector,
  bindPendingConnector,
  candidatesFor,
  customConnectorHref,
  mismatchReason,
  type PendingEntry,
} from "../../lib/pending-connectors";
import { orgCatalogItemQuery } from "../../lib/query/catalog";
import { retryOnMountOf } from "../../lib/query/client";
import { orgComponentsQuery } from "../../lib/query/components";
import { connectorsQuery } from "../../lib/query/conversation";
import { inboxChangeKeys } from "../../lib/query/inbox";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import { useErrorMessage } from "../../lib/use-error-message";
import {
  connectorInput,
  failureLines,
  initialTemplateDraft,
  missingInput,
  type TemplateDraft,
  TemplateStep,
} from "../CatalogInstallWizard";
import { FormError } from "../form-error";

/** How an entry's source reads: the connector template, or the protocol and endpoint it needs. */
export function useEntrySource(): (e: PendingEntry) => string {
  const t = useTranslations("agents.pending");
  const locale = useLocale();
  return (e) =>
    e.source.kind === "template"
      ? e.source.displayName !== null
        ? t("fromTemplateNamed", {
            name: displayNameOf({ name: e.label, displayName: e.source.displayName }, locale),
          })
        : t("fromTemplate")
      : t("needs", { protocol: e.source.protocol.toUpperCase(), endpoint: e.source.endpoint });
}

/** The tools an entry takes once bound, in words. */
export function useEntryTools(): (e: PendingEntry) => string {
  const t = useTranslations("agents.pending");
  const sep = useLocale() === "zh" ? "、" : ", ";
  return (e) => (e.tools === null ? t("toolsAll") : t("tools", { tools: e.tools.join(sep) }));
}

/** A bind refusal in words (`not_synced` links the connector to authorize first). */
function BindError({ error, connectorId }: { error: unknown; connectorId: string | null }) {
  const t = useTranslations("agents.pending.bindError");
  const errorMessage = useErrorMessage();
  const reason = mismatchReason(error);
  if (reason === "not_synced" && connectorId !== null) {
    return (
      <div role="alert">
        <Stack gap={4}>
          <Text tone="fail" icon="circle-x">
            {t("not_synced")}
          </Text>
          <Text variant="small">
            <Link href={`/connectors/${encodeURIComponent(connectorId)}`}>
              {t("openConnector")}
            </Link>
          </Text>
        </Stack>
      </div>
    );
  }
  if (reason !== null) return <FormError message={t(reason)} />;
  return <FormError message={errorMessage(error)} extra={failureLines(error)} />;
}

/**
 * Configuring pending connectors (ruling P4-7), for org admins (and `connectors.manage`): one
 * Dialog for the agent page's 配置 (`initialKey`, one entry) and the inbox's setup request (the list
 * of entries, each configured in turn; the request closes on the last bind). Per entry:
 * - 使用已有连接器: the org's active connectors made from that template (a `needs` entry: of that
 *   protocol), then bind;
 * - a template entry: 新建一个 from the template (the install's template step, the name and slug
 *   left empty so the kernel picks the free default), then bind;
 * - a `needs` entry: the custom connector wizard prefilled (protocol, endpoint, name), a page of its
 *   own; the person comes back and binds the new connector (a deployment that denies custom
 *   connectors refuses there, with its message).
 * A bind of an OAuth connector nobody authorized yet is refused (`not_synced`): the dialog says to
 * authorize it first, with a link to it.
 */
export function PendingConnectorDialog({
  orgId,
  agentId,
  agentName,
  entries,
  initialKey,
  onClose,
  onDone,
}: {
  orgId: string;
  agentId: string;
  agentName: string;
  entries: PendingEntry[];
  /** Opens this entry (the agent page's 配置); absent: the list (the inbox). */
  initialKey?: string;
  onClose(): void;
  /** Every entry is bound (the request closed). */
  onDone?(): void;
}) {
  const t = useTranslations("agents.pending");
  const tc = useTranslations("common");
  const toast = useToast();
  const source = useEntrySource();
  const toolsOf = useEntryTools();
  const [bound, setBound] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | undefined>(initialKey);
  const left = entries.filter((e) => !bound.has(e.key));
  const entry = left.find((e) => e.key === open);
  const single = initialKey !== undefined;

  const afterBind = (key: string, label: string, dropped: string[]) => {
    toast.success(
      dropped.length > 0
        ? t("boundDropped", { name: label, n: dropped.length })
        : t("bound", { name: label }),
    );
    const next = new Set(bound).add(key);
    setBound(next);
    setOpen(undefined);
    if (single || entries.every((e) => next.has(e.key))) {
      onDone?.();
      onClose();
    }
  };

  if (entry !== undefined) {
    return (
      <EntryDialog
        orgId={orgId}
        agentId={agentId}
        entry={entry}
        onBack={single ? onClose : () => setOpen(undefined)}
        backLabel={single ? tc("cancel") : t("back")}
        onBound={(dropped) => afterBind(entry.key, entry.label, dropped)}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      size={640}
      title={t("listTitle", { agent: agentName })}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">{t("listHint")}</Text>
        <ItemList label={t("listLabel")} empty={t("listEmpty")}>
          {left.map((e) => (
            <ItemListItem
              key={e.key}
              title={e.label}
              meta={
                <>
                  <Text variant="small" tone="muted">
                    {source(e)}
                  </Text>
                  <Text variant="small" tone="muted">
                    {toolsOf(e)}
                  </Text>
                </>
              }
              actions={
                <Button density="dense" onClick={() => setOpen(e.key)}>
                  {t("configure")}
                </Button>
              }
            />
          ))}
        </ItemList>
      </Stack>
    </Dialog>
  );
}

type Mode = "existing" | "create";

function EntryDialog({
  orgId,
  agentId,
  entry,
  onBack,
  backLabel,
  onBound,
}: {
  orgId: string;
  agentId: string;
  entry: PendingEntry;
  onBack(): void;
  backLabel: string;
  onBound(dropped: string[]): void;
}) {
  const t = useTranslations("agents.pending");
  const source = useEntrySource();
  const toolsOf = useEntryTools();
  const connectorsQ = connectorsQuery(orgId);
  const connectors = useQuery({
    ...connectorsQ,
    retryOnMount: retryOnMountOf(connectorsQ.queryKey),
  });
  const candidates = candidatesFor(entry, connectors.data?.connectors ?? []);
  const [mode, setMode] = useState<Mode | null>(null);
  // Without a connector to pick, creating one is the way (once the list answered).
  const shown: Mode =
    mode ?? (connectors.data !== undefined && candidates.length === 0 ? "create" : "existing");
  const [picked, setPicked] = useState<string>("");
  const connectorId = picked !== "" ? picked : (candidates[0]?.id ?? "");
  const [error, setError] = useState<{ error: unknown; connectorId: string | null } | null>(null);
  const k = keys.org(orgId);
  const bind = useAppMutation({
    fn: (id: string) => bindPendingConnector(orgId, agentId, entry.key, id),
    invalidates: () => [
      k.agent(agentId),
      k.agents(),
      k.setupRequest(agentId),
      ...inboxChangeKeys(orgId),
    ],
  });

  async function bindTo(id: string) {
    setError(null);
    try {
      const r = await bind.mutateAsync(id);
      onBound(r.dropped);
    } catch (e) {
      setError({ error: e, connectorId: id });
    }
  }

  const template = entry.source.kind === "template";
  const options = [
    { value: "existing", label: t("modeExisting"), description: t("modeExistingHint") },
    template
      ? { value: "create", label: t("modeCreate"), description: t("modeCreateHint") }
      : { value: "create", label: t("modeCustom"), description: t("modeCustomHint") },
  ];
  const body = (
    <Stack gap={16}>
      <Stack gap={4}>
        <Text variant="small" tone="muted">
          {source(entry)}
        </Text>
        <Text variant="small" tone="muted">
          {toolsOf(entry)}
        </Text>
      </Stack>
      <RadioGroup
        variant="card"
        label={t("modeLabel")}
        value={shown}
        onChange={(v) => {
          setMode(v as Mode);
          setError(null);
        }}
        options={options}
      />
      {shown === "existing" &&
        (connectors.data === undefined ? (
          connectors.error !== null ? (
            <FormError message={t("connectorsFailed")} />
          ) : (
            <Skeleton rows={1} />
          )
        ) : candidates.length === 0 ? (
          <Text variant="prose" tone="muted">
            {template ? t("noCandidatesTemplate") : t("noCandidatesNeeds")}
          </Text>
        ) : (
          <Field label={t("connectorLabel")}>
            <Select
              name="connector"
              value={connectorId}
              onChange={(e) => setPicked(e.target.value)}
              options={candidates.map((c) => ({ value: c.id, label: `${c.name} · ${c.slug}` }))}
            />
          </Field>
        ))}
      {shown === "create" && !template && (
        <Text variant="prose" tone="muted">
          {t("customHint")}
        </Text>
      )}
      {error !== null && <BindError error={error.error} connectorId={error.connectorId} />}
    </Stack>
  );

  if (shown === "create" && entry.source.kind === "template") {
    return (
      <TemplateCreate
        orgId={orgId}
        templateId={entry.source.templateId}
        title={t("entryTitle", { name: entry.label })}
        head={body}
        backLabel={backLabel}
        onBack={onBack}
        binding={bind.isPending}
        onCreated={(id) => void bindTo(id)}
      />
    );
  }
  const custom = customConnectorHref(entry);
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onBack();
      }}
      size={640}
      title={t("entryTitle", { name: entry.label })}
      footer={
        <>
          <Button variant="ghost" onClick={onBack}>
            {backLabel}
          </Button>
          {shown === "create" && custom !== null ? (
            <LinkButton variant="primary" href={custom}>
              {t("openCustom")}
            </LinkButton>
          ) : (
            <Button
              variant="primary"
              loading={bind.isPending}
              disabled={connectorId === "" || bind.isPending}
              onClick={() => void bindTo(connectorId)}
            >
              {t("bind")}
            </Button>
          )}
        </>
      }
    >
      {body}
    </Dialog>
  );
}

/**
 * 新建一个 from the platform connector template, then bind it: the template's input form (the
 * org component names its plugin and template id; the catalog item holds the template); name and
 * slug start empty (the kernel then picks the first free ones).
 */
function TemplateCreate({
  orgId,
  templateId,
  title,
  head,
  backLabel,
  onBack,
  binding,
  onCreated,
}: {
  orgId: string;
  templateId: string;
  title: string;
  head: ReactNode;
  backLabel: string;
  onBack(): void;
  binding: boolean;
  onCreated(connectorId: string): void;
}) {
  const t = useTranslations("agents.pending");
  const locale = useLocale();
  const errorMessage = useErrorMessage();
  const compQ = orgComponentsQuery(orgId, { kind: "connector_template" });
  const comps = useQuery({ ...compQ, retryOnMount: retryOnMountOf(compQ.queryKey) });
  const comp = comps.data?.components.find((c) => c.id === templateId);
  const itemId = comp?.itemId ?? "";
  const itemQ = orgCatalogItemQuery(orgId, itemId);
  const item = useQuery({ ...itemQ, enabled: comp?.on === true && itemId !== "" });
  const tpl: OrgCatalogTemplate | undefined = item.data?.templates.find((x) => x.id === comp?.name);
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const d =
    draft ??
    (tpl !== undefined && item.data
      ? { ...initialTemplateDraft(tpl, locale, item.data.item.name), name: "", slug: "" }
      : null);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const create = useAppMutation({
    fn: () => {
      const input = connectorInput(tpl as OrgCatalogTemplate, d as TemplateDraft);
      const { name, ...config } = input;
      return addTemplateConnector(orgId, templateId, {
        ...(name !== undefined ? { name } : {}),
        config,
      });
    },
    invalidates: () => [keys.org(orgId).connectors()],
  });
  const incomplete = tpl !== undefined && d !== null && missingInput(tpl, d) !== undefined;

  async function submit() {
    // a connector made on an earlier try that failed to bind is bound again, never made twice
    if (created !== null) {
      onCreated(created);
      return;
    }
    setError(null);
    try {
      const r = await create.mutateAsync(undefined);
      setCreated(r.connector.id);
      onCreated(r.connector.id);
    } catch (e) {
      setError(e);
    }
  }

  let content: ReactNode;
  if (comps.data === undefined || (comp?.on === true && item.data === undefined)) {
    content =
      comps.error !== null || item.error !== null ? (
        <FormError message={errorMessage(comps.error ?? item.error)} />
      ) : (
        <Skeleton rows={3} />
      );
  } else if (comp === undefined || tpl === undefined) {
    content = <Text variant="prose">{t("templateGone")}</Text>;
  } else if (!comp.on) {
    content = <Text variant="prose">{t("templateOff")}</Text>;
  } else if (created !== null) {
    content = <Text variant="prose">{t("createdRetryBind")}</Text>;
  } else {
    content = (
      <Stack gap={8}>
        <Text variant="small" tone="muted">
          {t("autoNameHint")}
        </Text>
        <TemplateStep template={tpl} draft={d as TemplateDraft} onChange={setDraft} />
      </Stack>
    );
  }
  const ready = tpl !== undefined && comp?.on === true && d !== null;
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onBack();
      }}
      size={640}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onBack}>
            {backLabel}
          </Button>
          <Button
            variant="primary"
            loading={create.isPending || binding}
            disabled={!ready || incomplete || create.isPending || binding}
            onClick={() => void submit()}
          >
            {created !== null ? t("bind") : t("createAndBind")}
          </Button>
        </>
      }
    >
      <Stack gap={16}>
        {head}
        {content}
        {error !== null && <FormError message={errorMessage(error)} extra={failureLines(error)} />}
      </Stack>
    </Dialog>
  );
}
