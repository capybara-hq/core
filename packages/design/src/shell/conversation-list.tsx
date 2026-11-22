import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useNow, useTimeZone } from "../clock";
import { Button, IconButton } from "../controls/button";
import { Input } from "../controls/inputs";
import { Avatar, type AvatarValue } from "../display/avatar";
import { type DayBucket, dayBucket, formatListTime } from "../display/date-time";
import { PullToRefresh } from "../display/pull-refresh";
import { SkeletonBox, SkeletonText } from "../display/skeleton";
import type { DesignKey } from "../i18n";
import { Icon } from "../icons/icon";
import { ActionSheet } from "../overlays/action-sheet";
import { Dialog } from "../overlays/dialog";
import { useLongPress } from "../overlays/long-press";
import { Menu, type MenuItem } from "../overlays/menus";
import { LinkPendingMark, useDesignLink, useDesignLocale, useDesignT } from "../provider";
import { DeleteConfirm, type SidebarActivity, untitledLabel } from "./sidebar-conversations";

/** One row of a conversation list (design spec §6.60). */
export type ConversationListItem = {
  id: string;
  /** null until the conversation has a title: shown as `untitledLabel(startedAt)`. */
  title: string | null;
  startedAt: Date;
  /** The latest activity: the row's time and the section it falls in. */
  updatedAt: string | Date;
  href: string;
  /** The agent: its avatar (a rounded square; `null`: the initial) and name. */
  agent: { name: string; avatar?: AvatarValue };
  /** A state after the agent name: running (ok) or waiting for me (warn). */
  activity: SidebarActivity;
};

/** What a row's long press, right click or ⋯ offers; absent: the rows only open. */
export type ConversationListActions = {
  /** The list shows archived conversations: Unarchive instead of Rename and Archive. */
  archived?: boolean;
  /** Resolves once renamed; a rejection keeps the dialog open. */
  onRename(id: string, title: string): Promise<void>;
  onArchive(id: string, archived: boolean): Promise<void>;
  /** Resolves once deleted; a rejection keeps the confirmation open. */
  onDelete(id: string): Promise<void>;
};

export type ConversationListProps = {
  /** The list's accessible name. */
  label: string;
  items: ConversationListItem[];
  /** Section the rows by time (Today / Yesterday / This week / Earlier), each section one card. */
  sections?: boolean;
  /** The open conversation's row is current. */
  activeId?: string | undefined;
  /** `loading`: skeleton rows in the card; `error`: the failure with Retry (`onRetry`). */
  state?: "loading" | "ready" | "error";
  onRetry?(): void;
  /** Drawn instead of the card when there are no rows (and the list is ready). */
  empty?: ReactNode;
  actions?: ConversationListActions;
  /**
   * More pages after the last row: the next one is read when the list's end comes near
   * (`onMore`), never by a button; a failure shows its message and Retry at the end.
   */
  end?: { more: boolean; loading: boolean; error?: string | null; onMore(): void };
  /** A pull down in a native shell reads the list again (interaction spec §3, D4). */
  onRefresh?: () => Promise<unknown>;
};

const BUCKETS: readonly DayBucket[] = ["today", "yesterday", "week", "older"];
const BUCKET_KEY: Record<DayBucket, DesignKey> = {
  today: "convlist.today",
  yesterday: "convlist.yesterday",
  week: "convlist.week",
  older: "convlist.older",
};

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** How far before the list's end the next page is asked for. */
const END_MARGIN = "600px";

/**
 * A conversation list sectioned by time (design spec §6.60): the drawer's recent conversations and
 * the conversations page. Rows lie in one grouped card per section (no card in a card: the card is
 * the list's only box): the agent's avatar, the title (500, one line) over the agent name and its
 * state, the time at the end (mono, `faint`). A row is a link; its actions (Rename, Archive, Delete) open
 * in an action sheet on a long press or a right click, and on a wide window also from the row's ⋯
 * (hidden below 600, where rows carry no buttons). The next page is read as the end nears.
 */
export function ConversationList({
  label,
  items,
  sections = false,
  activeId,
  state = "ready",
  onRetry,
  empty,
  actions,
  end,
  onRefresh,
}: ConversationListProps) {
  const t = useDesignT();
  const locale = useDesignLocale();
  const timeZone = useTimeZone();
  const now = useNow();
  const uid = useId();
  const [sheet, setSheet] = useState<ConversationListItem | null>(null);
  const [renaming, setRenaming] = useState<ConversationListItem | null>(null);
  const [deleting, setDeleting] = useState<ConversationListItem | null>(null);
  const textOf = (x: ConversationListItem) =>
    x.title ?? untitledLabel(x.startedAt, locale, timeZone);
  const itemsOf = (x: ConversationListItem): MenuItem[] => {
    if (!actions) return [];
    const archive = (archived: boolean) => void actions.onArchive(x.id, archived).catch(() => {});
    return actions.archived
      ? [
          { label: t("sidebar.unarchive"), onSelect: () => archive(false) },
          {
            label: t("sidebar.delete"),

            danger: true,
            onSelect: () => setDeleting(x),
          },
        ]
      : [
          { label: t("sidebar.rename"), onSelect: () => setRenaming(x) },
          { label: t("sidebar.archive"), onSelect: () => archive(true) },
          {
            label: t("sidebar.delete"),

            danger: true,
            onSelect: () => setDeleting(x),
          },
        ];
  };
  const row = (x: ConversationListItem) => (
    <Row
      key={x.id}
      x={x}
      text={textOf(x)}
      time={formatListTime(x.updatedAt, locale, now, timeZone)}
      current={x.id === activeId}
      menu={actions ? itemsOf(x) : null}
      onActions={actions ? () => setSheet(x) : null}
    />
  );
  let body: ReactNode;
  if (state === "loading" && items.length === 0) {
    body = (
      <ul className="cb-convlist-card" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="cb-convlist-row" data-part="convlist-skeleton">
            <span className="cb-convlist-link">
              <span className="cb-convlist-avatar">
                <SkeletonBox part="block" width={30} height={30} />
              </span>
              <span className="cb-convlist-text">
                <SkeletonText width="70%" />
                <SkeletonText width="45%" size="small" />
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  } else if (state === "error" && items.length === 0) {
    body = (
      <div className="cb-convlist-failed" data-part="convlist-failed">
        <span>{t("sidebar.loadFailed")}</span>
        {onRetry ? (
          <Button variant="ghost" onClick={onRetry}>
            {t("sidebar.retry")}
          </Button>
        ) : null}
      </div>
    );
  } else if (items.length === 0) {
    body = empty ?? null;
  } else if (sections) {
    body = BUCKETS.map((b) => {
      const rows = items.filter((x) => dayBucket(x.updatedAt, now, timeZone) === b);
      if (rows.length === 0) return null;
      const id = `${uid}-${b}`;
      return (
        <section key={b} className="cb-convlist-section" aria-labelledby={id}>
          <h2 id={id} className="cb-convlist-section-label" data-part="convlist-section-label">
            {t(BUCKET_KEY[b])}
          </h2>
          <ul className="cb-convlist-card" data-part="convlist-card">
            {rows.map(row)}
          </ul>
        </section>
      );
    });
  } else {
    body = (
      <ul className="cb-convlist-card" data-part="convlist-card">
        {items.map(row)}
      </ul>
    );
  }
  const list = (
    <section
      className="cb-convlist"
      data-part="conversation-list"
      aria-label={label}
      aria-busy={state === "loading" || end?.loading ? true : undefined}
    >
      {body}
      {end && items.length > 0 ? <End end={end} /> : null}
      {actions ? (
        <>
          <ActionSheet
            open={sheet !== null}
            onOpenChange={(o) => {
              if (!o) setSheet(null);
            }}
            title={sheet ? textOf(sheet) : t("overlay.actions")}
            items={sheet ? itemsOf(sheet) : []}
          />
          <RenameDialog
            target={renaming}
            initial={renaming ? textOf(renaming) : ""}
            onClose={() => setRenaming(null)}
            onRename={actions.onRename}
          />
          <DeleteConfirm
            target={deleting}
            text={deleting ? textOf(deleting) : ""}
            onClose={() => setDeleting(null)}
            onDelete={actions.onDelete}
          />
        </>
      ) : null}
    </section>
  );
  return onRefresh ? <PullToRefresh onRefresh={onRefresh}>{list}</PullToRefresh> : list;
}

function Row({
  x,
  text,
  time,
  current,
  menu,
  onActions,
}: {
  x: ConversationListItem;
  text: string;
  time: string;
  current: boolean;
  menu: MenuItem[] | null;
  onActions: (() => void) | null;
}) {
  const t = useDesignT();
  const Link = useDesignLink();
  const press = useLongPress(() => onActions?.(), { enabled: onActions !== null });
  const stateKey =
    x.activity === "running"
      ? "convlist.running"
      : x.activity === "waiting"
        ? "convlist.waiting"
        : null;
  return (
    <li
      className="cb-convlist-row"
      data-part="convlist-row"
      data-current={current ? "true" : undefined}
      {...press}
    >
      <Link
        href={x.href}
        className="cb-convlist-link"
        data-part="convlist-link"
        data-drawer-pick="true"
        aria-current={current ? "page" : undefined}
      >
        <span className="cb-convlist-avatar">
          <Avatar value={x.agent.avatar ?? null} name={x.agent.name} size={28} />
        </span>
        <span className="cb-convlist-text">
          <span className="cb-convlist-title" data-part="convlist-title">
            {text}
          </span>
          <span className="cb-convlist-sub">
            <span className="cb-convlist-agent">{x.agent.name}</span>
            {stateKey ? (
              <span
                className="cb-convlist-state"
                data-part="convlist-state"
                data-tone={x.activity === "running" ? "ok" : "warn"}
              >
                <span className="cb-convlist-dot" aria-hidden="true" />
                {t(stateKey)}
              </span>
            ) : null}
          </span>
        </span>
        <span className="cb-convlist-time" data-part="convlist-time">
          {time}
        </span>
        <LinkPendingMark />
      </Link>
      {menu && menu.length > 0 ? (
        <span className="cb-convlist-menu" data-part="convlist-menu">
          <Menu
            items={menu}
            label={fill(t("sidebar.rowActions"), { title: text })}
            trigger={
              <IconButton
                density="dense"
                label={fill(t("sidebar.rowActions"), { title: text })}
                icon={<Icon name="more-horizontal" size={14} />}
              />
            }
          />
        </span>
      ) : null}
    </li>
  );
}

/** The list's end: it asks for the next page as it comes near; a failure offers Retry. */
function End({ end }: { end: NonNullable<ConversationListProps["end"]> }) {
  const t = useDesignT();
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(end);
  latest.current = end;
  const wanted = end.more && !end.loading && !end.error;
  useEffect(() => {
    const el = ref.current;
    if (!wanted || el === null || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) latest.current.onMore();
      },
      { rootMargin: END_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wanted]);
  if (!end.more && !end.error) return null;
  return (
    <div className="cb-convlist-end" data-part="convlist-end" ref={ref}>
      {end.error ? (
        <>
          <span className="cb-convlist-end-error">{end.error}</span>
          <Button variant="ghost" onClick={end.onMore}>
            {t("sidebar.retry")}
          </Button>
        </>
      ) : end.loading ? (
        <span className="cb-convlist-end-loading" role="status">
          {t("convlist.loadingMore")}
        </span>
      ) : null}
    </div>
  );
}

function RenameDialog({
  target,
  initial,
  onClose,
  onRename,
}: {
  target: ConversationListItem | null;
  initial: string;
  onClose(): void;
  onRename(id: string, title: string): Promise<void>;
}) {
  const t = useDesignT();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [shownFor, setShownFor] = useState<string | null>(null);
  // a new target starts from its own title
  if ((target?.id ?? null) !== shownFor) {
    setShownFor(target?.id ?? null);
    setValue(initial);
    setBusy(false);
  }
  const title = value.trim();
  const save = () => {
    if (target === null || title === "" || busy) return;
    setBusy(true);
    onRename(target.id, title).then(
      () => {
        setBusy(false);
        onClose();
      },
      () => setBusy(false),
    );
  };
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={t("convlist.renameTitle")}
      footer={
        <>
          <Button variant="default" disabled={busy} onClick={onClose}>
            {t("overlay.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={title === ""} onClick={save}>
            {t("convlist.save")}
          </Button>
        </>
      }
    >
      <form
        method="post"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Input
          aria-label={t("sidebar.renameLabel")}
          value={value}
          maxLength={200}
          readOnly={busy}
          onChange={(e) => setValue(e.target.value)}
        />
      </form>
    </Dialog>
  );
}
