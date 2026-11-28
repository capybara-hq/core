"use client";

import {
  Button,
  DateTime,
  Dialog,
  dayBucket,
  EmptyState,
  type EmptyStateProps,
  formatBytes,
  formatListTime,
  type HeaderAction,
  type IconName,
  KeyValue,
  type LibraryAction,
  LibraryPage,
  ListDetailList,
  type ListDetailListGroup,
  LoadFailed,
  Segmented,
  Select,
  Skeleton,
  Stack,
  Text,
  TextLink,
  useNow,
  useTimeZone,
  useToast,
} from "@capybara-hq/design";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useCursorPages } from "../../../components/cursor-pages";
import { ErrorFrame } from "../../../components/ErrorFrame";
import { LibraryPreviewEmbed } from "../../../components/extension-ui/LibraryPreviewEmbed";
import { FilePreviewBody } from "../../../components/file-preview/FilePreviewBody";
import { ShareDialog } from "../../../components/file-preview/ShareDialog";
import { FormError } from "../../../components/form-error";
import { NoAccess } from "../../../components/NoAccess";
import { useOpenDownload } from "../../../components/SessionFilePreview";
import { usePagePath } from "../../../components/shell/path";
import { useRouter } from "../../../i18n/navigation";
import { sourceUrls } from "../../../lib/file-source";
import {
  type FilesUrl,
  fieldFilterCount,
  isFiltered,
  LIBRARY_TYPES,
  libraryFilterOf,
  parseAgent,
  parseOrigin,
  parseSearch,
  parseType,
} from "../../../lib/files-url";
import { useHashItem } from "../../../lib/hash-item";
import type {
  LibraryConversation,
  LibraryFileDetails,
  LibraryFileView,
  LibraryOrigin,
} from "../../../lib/library-files";
import { agentsQuery } from "../../../lib/query/agents";
import { retryOnMountOf } from "../../../lib/query/client";
import { libraryFileQuery, libraryFilesQuery, libraryUsageQuery } from "../../../lib/query/library";
import { useDeleteLibraryFile, useUploadLibraryFile } from "../../../lib/query/library-mutations";
import { usePageQuery } from "../../../lib/query/page-query";
import { useWorkspace } from "../../../lib/query/workspace";
import { uiLocale } from "../../../lib/ui";
import { useUrlParam } from "../../../lib/url-tab";
import { useErrorMessage } from "../../../lib/use-error-message";
import NotFound from "../not-found";

type FilesT = ReturnType<typeof useTranslations<"files">>;

/** The head's tabs: every file, then each origin (`?origin=`). */
const TABS: readonly (LibraryOrigin | "")[] = ["", "delivered", "generated", "upload"];

/** How long the search waits after typing stops before it reads (as the admin lists do). */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * The list's time groups (today / this week / earlier): yesterday and the days before it fall in
 * this week.
 */
const GROUPS = ["today", "week", "older"] as const;
type Group = (typeof GROUPS)[number];

/** A file's row icon by its content type. */
function iconOf(f: LibraryFileView): IconName {
  if (f.contentType.startsWith("image/")) return "image";
  if (f.contentType.startsWith("text/") || f.previewable === "text") return "file-text";
  return "file";
}

/**
 * `/files` (Files): the person's file library (file library spec §6, §8), LibraryPage: the head's
 * tabs pick the origin, the search and the agent and type filters narrow the list (all in the
 * address), the list is grouped by time (today / this week / earlier) with the usage under it, and
 * the open file (`#item=<id>`) shows its preview and details beside the list (a side sheet or its
 * own screen where two panes do not fit: the template decides). Upload, share, download and delete
 * (confirmed). Members up (guests have no library). From the query cache (the layout prefetched the
 * list for the address's filters and the usage on a first load).
 */
export default function FilesView({ initial }: { initial: FilesUrl }) {
  const ws = useWorkspace({ min: "member" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Files orgId={ws.orgId} initial={initial} />;
}

function Files({ orgId, initial }: { orgId: string; initial: FilesUrl }) {
  const scope = usePagePath("org");
  const t = useTranslations("files");
  const locale = uiLocale(useLocale());
  const now = useNow();
  const timeZone = useTimeZone();
  const toast = useToast();
  const router = useRouter();
  const errorMessage = useErrorMessage();
  const openDownload = useOpenDownload();

  // The filters live in the address (each set is its own cache entry).
  const [origin, setOrigin] = useUrlParam("origin", initial.origin, parseOrigin, "");
  const [agent, setAgent] = useUrlParam("agent", initial.agent, parseAgent, "");
  const [type, setType] = useUrlParam("type", initial.type, parseType, "");
  const [q, setQ] = useUrlParam("q", initial.q, parseSearch, "");
  const url: FilesUrl = { origin, agent, type, q };
  const filter = libraryFilterOf(url);
  const filtered = isFiltered(url);

  // The search box: typed here, written to the address 300 ms after typing stops; an address
  // change from elsewhere (Clear filters, Back) replaces the text.
  const [text, setText] = useState(q);
  const [seenQ, setSeenQ] = useState(q);
  if (seenQ !== q) {
    setSeenQ(q);
    setText(q);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onSearch = (v: string) => {
    const next = parseSearch(v);
    setText(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
  };

  // A new filter keeps the rows shown until its own answer lands (no flash of the loading list).
  const listQ = { ...libraryFilesQuery(orgId, filter), placeholderData: keepPreviousData };
  const list = usePageQuery(listQ);
  const placeholder = useQuery({
    ...listQ,
    retryOnMount: retryOnMountOf(listQ.queryKey),
  }).isPlaceholderData;
  // Later pages (Load more) continue the current filter's first page by the kernel's cursor.
  const pages = useCursorPages(
    list.kind === "ready" && !placeholder ? list.data : undefined,
    (after) => libraryFilesQuery(orgId, { ...filter, cursor: after }),
    (p) => ({ rows: p.files, next: p.next }),
  );
  const usageQ = libraryUsageQuery(orgId);
  const usage = useQuery({ ...usageQ, retryOnMount: retryOnMountOf(usageQ.queryKey) }).data;
  const agentsQ = agentsQuery(orgId);
  const agents = useQuery({ ...agentsQ, retryOnMount: retryOnMountOf(agentsQ.queryKey) }).data;

  // The open file is the hash (so the system back closes it, as on the inbox); the last file
  // opened stays the current row and the two-pane detail after it is closed.
  const hashItem = useHashItem();
  const [lastId, setLastId] = useState<string | null>(null);
  const selectedId = hashItem.id ?? lastId;
  const open = hashItem.id !== null;
  const detailQ = libraryFileQuery(orgId, selectedId ?? "");
  const details = useQuery({
    ...detailQ,
    enabled: selectedId !== null,
    retryOnMount: retryOnMountOf(detailQ.queryKey),
  });

  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState<LibraryFileView | null>(null);
  const remove = useDeleteLibraryFile(orgId);
  const upload = useUploadLibraryFile(orgId);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);

  const pick = () => fileInput.current?.click();
  const uploadAll = async (files: File[]) => {
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        await upload.mutateAsync({ file });
        pages.reset();
        toast.success(t("uploaded", { name: file.name }));
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  if (list.kind === "notFound") return <NotFound />;
  if (list.kind === "error") return <ErrorFrame reset={list.retry} />;

  const agentName = (id: string | null, known?: string): string | null => {
    if (id === null) return null;
    return (
      known || (agents?.agents ?? []).find((a) => a.id === id)?.definition.name || t("unknownAgent")
    );
  };
  const clear = () => {
    clearTimeout(timer.current);
    setText("");
    setOrigin("");
    setAgent("");
    setType("");
    setQ("");
  };

  const header = {
    path: [...scope, { label: "files" }],
    title: t("title"),
    tabs: TABS.map((o) => ({
      id: o === "" ? "all" : o,
      label: t(`tabs.${o === "" ? "all" : o}`),
      onSelect: () => setOrigin(o),
    })),
    activeTab: origin === "" ? "all" : origin,
    search: { label: t("search"), value: text, onChange: onSearch },
  };
  const uploadAction: HeaderAction = {
    label: t("upload"),
    icon: "upload",
    variant: "primary",
    onSelect: pick,
    ...(uploading > 0 ? { loading: true } : {}),
  };

  const agentOptions = [
    { value: "", label: t("filters.allAgents") },
    ...(agents?.agents ?? []).map((a) => ({ value: a.id, label: a.definition.name || a.id })),
  ];
  // An agent in the address missing from the list (deleted, or not readable) keeps an option
  if (agent !== "" && !agentOptions.some((o) => o.value === agent)) {
    agentOptions.push({ value: agent, label: t("unknownAgent") });
  }
  const filters = (
    <>
      <Select
        aria-label={t("filters.agent")}
        value={agent}
        onChange={(e) => setAgent(e.target.value)}
        options={agentOptions}
      />
      <Select
        aria-label={t("filters.type")}
        value={type}
        onChange={(e) => setType(parseType(e.target.value))}
        options={[
          { value: "", label: t("filters.allTypes") },
          ...LIBRARY_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) })),
        ]}
      />
    </>
  );

  const input = (
    <input
      ref={fileInput}
      type="file"
      hidden
      multiple
      aria-label={t("upload")}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const picked = Array.from(e.target.files ?? []);
        e.target.value = "";
        if (picked.length > 0) void uploadAll(picked);
      }}
    />
  );

  const common = {
    actions: [uploadAction],
    filters,
    filterCount: fieldFilterCount(url),
    onBack: () => hashItem.close(),
  };
  if (list.kind === "loading") {
    return (
      <>
        <LibraryPage header={header} {...common} list={null} detail={null} loading />
        {input}
      </>
    );
  }

  // The rows: the placeholder's while a new filter loads, else every page read, each file once.
  const seen = new Set<string>();
  const files = (placeholder ? list.data.files : pages.rows).filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  });
  const groups: ListDetailListGroup[] = GROUPS.map((g) => ({
    id: g,
    label: t(`groups.${g}`),
    items: files
      .filter((f) => groupOf(f.createdAt, now, timeZone) === g)
      .map((f) => ({
        id: f.id,
        title: f.name,
        meta: `${agentName(f.agentId, f.agentName) ?? t(`origin.${f.origin}`)} · ${formatBytes(f.size)}`,
        at: formatListTime(f.createdAt, locale, now, timeZone),
        icon: iconOf(f),
        ...(f.versions > 1 ? { trailing: t("versionsShort", { count: f.versions }) } : {}),
      })),
  })).filter((g) => g.items.length > 0);

  // The open file: the row's view, else (a deep link past the pages read or another filter) the
  // details' own view.
  const loaded = details.data?.file.id === selectedId ? details.data : undefined;
  const file: LibraryFileView | null =
    selectedId === null ? null : (files.find((f) => f.id === selectedId) ?? loaded?.file ?? null);
  const gone = selectedId !== null && file === null && details.error != null;
  const pending = selectedId !== null && file === null && !gone;
  const shown = file;

  const empty: EmptyStateProps | undefined =
    files.length > 0
      ? undefined
      : filtered
        ? {
            text: t("empty.filtered"),
            hint: t("empty.filteredHint"),
            action: { label: t("empty.clear"), variant: "secondary", onSelect: clear },
          }
        : {
            text: t("empty.text"),
            hint: t("empty.hint"),
            action: { label: t("upload"), icon: "upload", variant: "primary", onSelect: pick },
          };

  const source = shown?.sourceConversation ?? null;
  const actions: LibraryAction[] =
    shown === null
      ? []
      : [
          ...(source !== null && !source.deleted
            ? [
                {
                  id: "conversation",
                  label: t("actions.openConversation"),
                  icon: "chats" as const,
                  onSelect: () => router.push(`/chat/${encodeURIComponent(source.id)}`),
                },
              ]
            : []),
          {
            id: "share",
            label: t("actions.share"),
            icon: "share",
            onSelect: () => setSharing(true),
          },
          {
            id: "download",
            label: t("actions.download"),
            icon: "download",
            onSelect: () =>
              openDownload(sourceUrls({ kind: "library", orgId, file: shown }).download),
          },
          {
            id: "delete",
            label: t("actions.delete"),
            icon: "trash-2",
            menu: true,
            danger: true,
            onSelect: () => setDeleting(shown),
          },
        ];

  // The detail: the file, or (a deep link) its loading state or why it is not there.
  const detail: ReactNode | null =
    shown !== null ? (
      <FileDetail
        key={shown.id}
        orgId={orgId}
        file={shown}
        details={loaded}
        agent={agentName(shown.agentId, shown.agentName)}
        t={t}
      />
    ) : pending ? (
      <Skeleton rows={8} />
    ) : gone ? (
      <EmptyState size="panel" text={t("detail.gone")} />
    ) : null;

  return (
    <>
      <LibraryPage
        header={header}
        {...common}
        {...(usage !== undefined
          ? {
              usage: t("usage", { size: formatBytes(usage.bytes), count: usage.files }),
            }
          : {})}
        list={
          <ListDetailList
            label={t("listLabel")}
            groups={groups}
            current={selectedId ?? undefined}
            onOpen={(id) => {
              setLastId(id);
              hashItem.open(id);
            }}
            // Later pages by the kernel's cursor (not while a new filter's answer is on its way)
            onLoadMore={pages.loadMore}
            hasMore={pages.next !== null && !placeholder}
            loadingMore={pages.loadingMore}
            loadMoreError={pages.error}
          />
        }
        detail={detail}
        {...(shown !== null ? { detailTitle: shown.name } : {})}
        detailActions={actions}
        detailEmpty={{ text: t("detail.pick") }}
        open={open && detail !== null}
        {...(empty !== undefined ? { empty } : {})}
      />
      {input}
      {shown !== null && (
        <ShareDialog
          orgId={orgId}
          target={{ kind: "library", file: shown }}
          open={sharing}
          onOpenChange={setSharing}
        />
      )}
      {deleting !== null && (
        <DeleteFileDialog
          name={deleting.name}
          versions={deleting.versions}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            await remove.mutateAsync({ fileId: deleting.id });
            pages.reset();
            if (selectedId === deleting.id) {
              setLastId(null);
              if (hashItem.id === deleting.id) hashItem.close();
            }
            toast.success(t("delete.done", { name: deleting.name }));
            setDeleting(null);
          }}
        />
      )}
    </>
  );
}

/** The time group of a file's creation in the viewer's zone. */
function groupOf(iso: string, now: number, timeZone: string | undefined): Group {
  const b = dayBucket(iso, now, timeZone);
  return b === "today" ? "today" : b === "older" ? "older" : "week";
}

/** A conversation as a link, or "deleted conversation" / "untitled conversation" in words. */
function ConversationRef({ c, t }: { c: LibraryConversation; t: FilesT }) {
  if (c.deleted) return <>{t("conversationDeleted")}</>;
  return <TextLink href={`/chat/${encodeURIComponent(c.id)}`}>{c.title || t("untitled")}</TextLink>;
}

/**
 * The open file: its preview (the previewer switch when more than one takes it) over its facts:
 * origin, agent, size, time, the conversation it came from, the conversations that refer to it and
 * its versions (the details read; the facts the list row knows show at once).
 */
function FileDetail({
  orgId,
  file,
  details,
  agent,
  t,
}: {
  orgId: string;
  file: LibraryFileView;
  details: LibraryFileDetails | undefined;
  agent: string | null;
  t: FilesT;
}) {
  const openDownload = useOpenDownload();
  const [picked, setPicked] = useState<string | null>(null);
  const source = { kind: "library" as const, orgId, file };
  const download = () => openDownload(sourceUrls(source).download);
  // The conversations that refer to it besides the one it came from (shown on its own row)
  const referring = (details?.conversations ?? []).filter(
    (c) => c.id !== file.sourceConversation?.id,
  );
  const rows: { k: ReactNode; v: ReactNode; mono?: boolean }[] = [
    { k: t("facts.origin"), v: t(`origin.${file.origin}`) },
    ...(agent !== null ? [{ k: t("facts.agent"), v: agent }] : []),
    { k: t("facts.size"), v: formatBytes(file.size), mono: true },
    { k: t("facts.created"), v: <DateTime value={file.createdAt} /> },
    ...(file.sourceConversation !== null
      ? [{ k: t("facts.conversation"), v: <ConversationRef c={file.sourceConversation} t={t} /> }]
      : []),
    ...(details !== undefined
      ? [
          {
            k: t("facts.referencedBy"),
            v:
              referring.length === 0 ? (
                t("facts.none")
              ) : (
                <Stack gap={4}>
                  {referring.map((c) => (
                    <span key={c.id}>
                      <ConversationRef c={c} t={t} />
                    </span>
                  ))}
                </Stack>
              ),
          },
          {
            k: t("facts.versions"),
            v: (
              <Stack gap={4}>
                {details.versions.map((v, i) => (
                  <Text key={v.id} variant="small">
                    {`${details.versions.length - i} · ${formatBytes(v.size)} · `}
                    <DateTime value={v.createdAt} />
                  </Text>
                ))}
              </Stack>
            ),
          },
        ]
      : file.versions > 1
        ? [{ k: t("facts.versions"), v: t("versionsShort", { count: file.versions }), mono: true }]
        : []),
  ];
  return (
    <Stack gap={16}>
      <FilePreviewBody
        source={source}
        previewer={picked}
        onDownload={download}
        embed={(h) => <LibraryPreviewEmbed orgId={orgId} fileId={file.id} host={h} />}
        frame={({ state, failure, onRetry, children, previewers, previewer }) => (
          <Stack gap={12}>
            {previewers.length > 1 && previewer !== undefined && (
              <Segmented
                label={t("detail.previewers")}
                density="dense"
                options={previewers.map((p) => ({ value: p.id, label: p.title }))}
                value={previewer}
                onChange={setPicked}
              />
            )}
            {state === "loading" ? (
              <Skeleton rows={8} />
            ) : state === "failed" ? (
              <>
                <LoadFailed
                  name={failure?.name ?? file.name}
                  {...(failure?.reason !== undefined ? { reason: failure.reason } : {})}
                  {...(onRetry ? { onRetry } : {})}
                />
                {children}
              </>
            ) : (
              children
            )}
          </Stack>
        )}
      />
      <KeyValue variant="facts" rows={rows} />
    </Stack>
  );
}

/**
 * Confirms deleting a file: its share links stop working and conversations show it as gone. A row
 * with versions deletes only the newest; the body says the earlier ones stay.
 */
function DeleteFileDialog({
  name,
  versions,
  onClose,
  onDelete,
}: {
  name: string;
  /** The row's versions: only the newest is deleted, the earlier ones stay. */
  versions: number;
  onClose(): void;
  onDelete(): Promise<void>;
}) {
  const t = useTranslations("files.delete");
  const tc = useTranslations("common");
  const errorMessage = useErrorMessage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async () => {
    setPending(true);
    setError(undefined);
    try {
      await onDelete();
    } catch (e) {
      setError(errorMessage(e));
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      danger
      initialFocus="cancel"
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
      title={t("title", { name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            {tc("cancel")}
          </Button>
          <Button
            variant="danger-solid"
            loading={pending}
            disabled={pending}
            onClick={() => void submit()}
          >
            {t("confirm")}
          </Button>
        </>
      }
    >
      <Stack gap={12}>
        <Text variant="prose">
          {versions > 1 ? t("bodyNewest", { count: versions - 1 }) : t("body")}
        </Text>
        {error !== undefined && <FormError message={error} />}
      </Stack>
    </Dialog>
  );
}
