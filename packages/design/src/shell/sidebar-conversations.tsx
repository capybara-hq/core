import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTimeZone } from "../clock";
import { Button, IconButton, Input } from "../controls/index";
import { Avatar, type AvatarValue } from "../display/avatar";
import { formatDateTime } from "../display/date-time";
import { EmptyState } from "../display/empty-state";
import { Segmented } from "../display/tabs";
import { type Locale, messages } from "../i18n";
import { Icon } from "../icons/icon";
import { Dialog, Menu, type MenuItem } from "../overlays/index";
import { LinkPendingMark, useDesignLink, useDesignLocale, useDesignT } from "../provider";

/** What a conversation is doing: a state dot shows only for `running` (ok) and `waiting` (warn). */
export type SidebarActivity = "running" | "waiting" | null;

export type SidebarConversation = {
  id: string;
  /** null until the conversation has a title: shown as `untitledLabel(startedAt)`. */
  title: string | null;
  startedAt: Date;
  href: string;
  activity: SidebarActivity;
};

export type SidebarGroup = {
  agentId: string;
  agentName: string;
  /** The agent's avatar, drawn at 16 before the name (§6.30; `null`: the initial); absent, none. */
  agentAvatar?: AvatarValue;
  conversations: SidebarConversation[];
  /** The group has more conversations than it shows: a "Show more" row calls `onMore`. */
  more: boolean;
  /** How many more there are, when known: the row reads "Show N more". */
  moreCount?: number;
  onMore(): void;
  /** The group's ＋: a new conversation with this agent. */
  onNew(): void;
};

/** The conversation filter: a title substring (case-insensitive) and a state. */
export type SidebarFilter = { q: string; state: "all" | "running" | "waiting" };

export type SidebarConversations = {
  state: "loading" | "ready" | "error";
  /** The conversations to list: the archived ones while `archived.open`. */
  groups: SidebarGroup[];
  activeId?: string;
  /** More groups than shown: a "More groups" row calls `onMoreGroups`. */
  moreGroups: boolean;
  onMoreGroups(): void;
  onRetry(): void;
  /**
   * Collapsed groups to start with, used instead of the viewer's remembered ones (the reference
   * set and the catalog only).
   */
  collapsed?: string[];
  /**
   * Whose groups these are (the org id): the remembered collapsed groups are kept per scope, so
   * pruning in one org never drops another org's. Without it one list per browser.
   */
  scope?: string;
  /**
   * The filter (controlled). The caller asks the kernel with it; the rows shown are also narrowed
   * here, so a change applies before the answer arrives.
   */
  filter: SidebarFilter & { onChange(f: SidebarFilter): void };
  /** The archived list swaps the list in place (`open`); its entry shows when `count` > 0. */
  archived: { count: number; open: boolean; onOpenChange(open: boolean): void };
  onRename(id: string, title: string): Promise<void>;
  onArchive(id: string, archived: boolean): Promise<void>;
  onDelete(id: string): Promise<void>;
  /** The filter drawn open (the reference set and the catalog only). */
  filterOpen?: boolean;
};

/**
 * `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm`, in local time: in a component
 * pass `useTimeZone()` as `timeZone` (see `formatDateTime`).
 */
export function untitledLabel(startedAt: Date, locale: Locale, timeZone?: string): string {
  // The compact date form of dense lists (spec §2.2).
  const at = formatDateTime(startedAt, "compact", timeZone);
  return `${messages[locale]["sidebar.untitled"]} · ${at}`;
}

/**
 * One roving tab stop for a list (spec §6.11): items carry `data-rove="<key>"`; the item whose
 * key is `stop` (else `fallback`, else the first) has tabIndex 0, the others -1. ↑ / ↓ / Home /
 * End move focus between items; focusing an item makes it the stop.
 */
export function useRoving(fallback: string | undefined) {
  const [stop, setStop] = useState<string | null>(null);
  const holderOf = (keys: readonly string[]) => {
    const current = stop !== null && keys.includes(stop) ? stop : fallback;
    return current !== undefined && keys.includes(current) ? current : keys[0];
  };
  const tabIndexOf = (key: string, keys: readonly string[]) => (key === holderOf(keys) ? 0 : -1);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>("[data-rove]:not([inert] *)"),
    );
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)));
    items[to]?.focus();
  };
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const key = (e.target as HTMLElement).getAttribute("data-rove");
    if (key !== null) setStop(key);
  };
  return { tabIndexOf, holderOf, onKeyDown, onFocus };
}

const COLLAPSED_KEY = "cap.sidebar.collapsed";
/** At most this many remembered collapsed groups (the most recent toggles). */
const COLLAPSED_CAP = 100;

/**
 * The collapsed groups, per viewer and scope (org) in localStorage. The stored set is read in a
 * layout effect, so it applies before the first paint, and read again when the scope changes;
 * storage errors mean "all expanded". `known` is the full list of agent ids when every group is
 * loaded (stale ids are then pruned, within this scope only), else null.
 */
function useCollapsed(
  initial: string[] | undefined,
  known: string[] | null,
  scope: string | undefined,
): [Set<string>, (agentId: string) => void] {
  const key = scope === undefined ? COLLAPSED_KEY : `${COLLAPSED_KEY}.${scope}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(initial));
  const knownRef = useRef(known);
  knownRef.current = known;
  const dirty = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read on mount and per scope
  useLayoutEffect(() => {
    if (initial) return;
    dirty.current = false;
    try {
      const raw = localStorage.getItem(key);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      setCollapsed(
        new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []),
      );
    } catch {
      // Storage blocked or malformed: render expanded.
      setCollapsed(new Set());
    }
  }, [key]);
  // The write happens after a toggle commits, never inside the state updater.
  useEffect(() => {
    if (!dirty.current) return;
    dirty.current = false;
    const k = knownRef.current;
    const ids = [...collapsed].filter((id) => k === null || k.includes(id)).slice(-COLLAPSED_CAP);
    try {
      localStorage.setItem(key, JSON.stringify(ids));
    } catch {
      // Not remembered; the toggle still applies.
    }
  }, [collapsed, key]);
  const toggle = useCallback((agentId: string) => {
    dirty.current = true;
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }, []);
  return [collapsed, toggle];
}

/** Loading: three groups of skeleton bars (widths in %), as the reference set draws them. */
const SKELETON = [
  [64, 88, 72],
  [56, 80],
  [60, 76],
] as const;

const fill = (s: string, vars: Record<string, string | number>) =>
  s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/**
 * The sidebar's conversation section (spec §6.13): a `会话` label with the filter, the groups by
 * agent (collapse, ＋, rows with a state dot and the `⋯` menu, "Show more"), and the archived
 * entry, which swaps the list in place for the archived conversations.
 */
export function Conversations({
  c,
  newHref,
}: {
  c: SidebarConversations;
  /** The empty list's New conversation link. */
  newHref?: string;
}) {
  const t = useDesignT();
  const locale = useDesignLocale();
  const known = c.state === "ready" && !c.moreGroups ? c.groups.map((g) => g.agentId) : null;
  const [collapsed, toggleGroup] = useCollapsed(c.collapsed, known, c.scope);
  // Height motion only after the viewer toggles a group: the remembered state applies without it.
  const [motion, setMotion] = useState(false);
  const [filterOpen, setFilterOpen] = useState(c.filterOpen ?? false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<SidebarConversation | null>(null);
  const toggle = (agentId: string) => {
    setMotion(true);
    toggleGroup(agentId);
  };
  const f = c.filter;
  const filtering = f.q.trim() !== "" || f.state !== "all";
  const timeZone = useTimeZone();
  const textOf = (x: SidebarConversation) =>
    x.title ?? untitledLabel(x.startedAt, locale, timeZone);
  const q = f.q.trim().toLocaleLowerCase();
  const matches = (x: SidebarConversation) =>
    (q === "" || textOf(x).toLocaleLowerCase().includes(q)) &&
    (f.state === "all" || x.activity === f.state);
  const groups = c.groups
    .map((g) => (filtering ? { ...g, conversations: g.conversations.filter(matches) } : g))
    .filter((g) => !filtering || g.conversations.length > 0);
  const archivedList = c.archived.open;

  // A rename whose row left the list (filtered out, another view) ends.
  const shownIds = groups.flatMap((g) => g.conversations.map((x) => x.id));
  const renamingShown = renaming !== null && shownIds.includes(renaming);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ends a rename when its row goes away
  useEffect(() => {
    if (renaming !== null && !renamingShown) setRenaming(null);
  }, [renamingShown]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a view or filter change ends a rename
  useEffect(() => {
    setRenaming(null);
  }, [archivedList, f.q, f.state]);

  const keys: string[] = [];
  // The way back from the archived list is there in every state (loading, error too).
  if (archivedList) keys.push("ab");
  if (c.state === "ready") {
    for (const g of groups) {
      keys.push(`t:${g.agentId}`);
      if (!archivedList) keys.push(`n:${g.agentId}`);
      if (!collapsed.has(g.agentId)) {
        keys.push(...g.conversations.map((x) => `c:${x.id}`));
        if (g.more && !filtering) keys.push(`m:${g.agentId}`);
      }
    }
    if (c.moreGroups && !filtering) keys.push("mg");
    if (!archivedList && c.archived.count > 0) keys.push("ae");
  }
  const roving = useRoving(c.activeId === undefined ? undefined : `c:${c.activeId}`);
  const tab = (key: string) => roving.tabIndexOf(key, keys);
  const holder = roving.holderOf(keys);

  const closeFilter = () => {
    setFilterOpen(false);
    if (filtering) f.onChange({ q: "", state: "all" });
  };

  let body: ReactNode;
  if (c.state === "loading") {
    body = (
      <div className="cb-sidebar-loading">
        {SKELETON.map((group, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed skeleton
          <div key={i} className="cb-sidebar-skeleton-group">
            {group.map((w) => (
              <span key={w} className="cb-sidebar-skeleton" data-part="skeleton-bar" data-w={w} />
            ))}
          </div>
        ))}
      </div>
    );
  } else if (c.state === "error") {
    body = (
      <div className="cb-sidebar-error" role="alert">
        <span className="cb-sidebar-error-text">
          <Icon name="circle-alert" size={14} />
          {t("sidebar.loadFailed")}
        </span>
        <span className="cb-sidebar-retry" data-part="retry">
          <Button variant="ghost" density="dense" onClick={c.onRetry}>
            <Icon name="refresh" size={14} />
            {t("sidebar.retry")}
          </Button>
        </span>
      </div>
    );
  } else if (groups.length === 0) {
    body = (
      <div className="cb-sidebar-empty" data-part="empty-hint">
        {filtering ? (
          <EmptyState
            size="compact"
            text={t("sidebar.noMatch")}
            action={{
              label: t("sidebar.clearFilter"),
              variant: "default",
              onSelect: () => f.onChange({ q: "", state: "all" }),
            }}
          />
        ) : archivedList ? (
          <EmptyState size="compact" text={t("sidebar.archivedEmpty")} />
        ) : (
          <EmptyState
            size="compact"
            text={t("sidebar.empty")}
            {...(newHref !== undefined
              ? { action: { label: t("sidebar.new"), variant: "default", href: newHref } }
              : {})}
          />
        )}
      </div>
    );
  } else {
    body = (
      <>
        {groups.map((g) => (
          <Group
            key={g.agentId}
            g={g}
            activeId={c.activeId}
            collapsed={collapsed.has(g.agentId)}
            archived={archivedList}
            showMore={!filtering}
            onToggle={() => toggle(g.agentId)}
            tab={tab}
            holder={holder}
            renaming={renaming}
            onRenameStart={setRenaming}
            onRenameEnd={() => setRenaming(null)}
            c={c}
            onDelete={setDeleting}
          />
        ))}
        {c.moreGroups && !filtering ? (
          <button
            type="button"
            className="cb-sidebar-more"
            data-part="more"
            data-rove="mg"
            tabIndex={tab("mg")}
            onClick={c.onMoreGroups}
          >
            {t("sidebar.moreGroups")}
          </button>
        ) : null}
      </>
    );
  }
  const count = c.archived.count;
  return (
    <section
      className="cb-sidebar-convs"
      aria-label={t("sidebar.conversations")}
      aria-busy={c.state === "loading" ? true : undefined}
      data-motion={motion ? "on" : undefined}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <div className="cb-sidebar-convs-head">
        <span className="cb-sidebar-section-label" aria-hidden="true">
          {t("sidebar.conversations")}
        </span>
        <IconButton
          density="dense"
          label={t("sidebar.filter")}
          icon={<Icon name="filter" size={14} />}
          aria-expanded={filterOpen}
          data-active={filtering ? "true" : undefined}
          onClick={() => (filterOpen ? closeFilter() : setFilterOpen(true))}
        />
      </div>
      {filterOpen ? (
        <div className="cb-sidebar-filter" data-part="filter">
          <Input
            density="dense"
            aria-label={t("sidebar.filterQuery")}
            placeholder={t("sidebar.filterQuery")}
            prefix={<Icon name="search" size={14} />}
            value={f.q}
            onChange={(e) => f.onChange({ q: e.target.value, state: f.state })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                closeFilter();
              }
            }}
          />
          <Segmented
            density="dense"
            fill
            label={t("sidebar.filterState")}
            value={f.state}
            options={[
              { value: "all", label: t("sidebar.stateAll") },
              { value: "running", label: t("sidebar.stateRunning") },
              { value: "waiting", label: t("sidebar.stateWaiting") },
            ]}
            onChange={(v) => f.onChange({ q: f.q, state: v as SidebarFilter["state"] })}
          />
        </div>
      ) : null}
      {archivedList ? (
        <button
          type="button"
          className="cb-sidebar-archived"
          data-part="archived-back"
          data-rove="ab"
          tabIndex={tab("ab")}
          aria-label={fill(t("sidebar.archivedBack"), { n: count })}
          onClick={() => c.archived.onOpenChange(false)}
        >
          <Icon name="arrow-left" size={14} />
          <span className="cb-sidebar-label">{fill(t("sidebar.archived"), { n: count })}</span>
        </button>
      ) : null}
      <div className="cb-sidebar-convs-body">{body}</div>
      {!archivedList && count > 0 && c.state === "ready" ? (
        <button
          type="button"
          className="cb-sidebar-archived"
          data-part="archived-entry"
          data-rove="ae"
          tabIndex={tab("ae")}
          onClick={() => c.archived.onOpenChange(true)}
        >
          <Icon name="archive" size={14} />
          <span className="cb-sidebar-label">{fill(t("sidebar.archived"), { n: count })}</span>
        </button>
      ) : null}
      <DeleteConfirm
        target={deleting}
        text={deleting ? textOf(deleting) : ""}
        onClose={() => setDeleting(null)}
        onDelete={c.onDelete}
      />
    </section>
  );
}

function Group({
  g,
  activeId,
  collapsed,
  archived,
  showMore,
  onToggle,
  tab,
  holder,
  renaming,
  onRenameStart,
  onRenameEnd,
  c,
  onDelete,
}: {
  g: SidebarGroup;
  activeId: string | undefined;
  collapsed: boolean;
  archived: boolean;
  showMore: boolean;
  onToggle(): void;
  tab(key: string): number;
  holder: string | undefined;
  renaming: string | null;
  onRenameStart(id: string): void;
  onRenameEnd(): void;
  c: SidebarConversations;
  onDelete(x: SidebarConversation): void;
}) {
  const t = useDesignT();
  return (
    <div className="cb-sidebar-group">
      <div className="cb-sidebar-group-head">
        <button
          type="button"
          className="cb-sidebar-group-toggle"
          data-part="group-label"
          data-rove={`t:${g.agentId}`}
          tabIndex={tab(`t:${g.agentId}`)}
          aria-expanded={!collapsed}
          title={g.agentName}
          onClick={onToggle}
        >
          {g.agentAvatar !== undefined ? (
            <Avatar value={g.agentAvatar} name={g.agentName} size={16} />
          ) : null}
          <span className="cb-sidebar-label">{g.agentName}</span>
          <Icon name={collapsed ? "chevron-right" : "chevron-down"} size={12} />
        </button>
        {archived ? null : (
          <IconButton
            density="dense"
            label={t("sidebar.newWith").replace("{agent}", g.agentName)}
            icon={<Icon name="plus" size={14} />}
            data-rove={`n:${g.agentId}`}
            tabIndex={tab(`n:${g.agentId}`)}
            onClick={g.onNew}
          />
        )}
      </div>
      <div
        className="cb-sidebar-group-body"
        data-part="group-body"
        data-collapsed={collapsed ? "true" : undefined}
        inert={collapsed}
        aria-hidden={collapsed ? true : undefined}
      >
        <div className="cb-sidebar-group-rows">
          {g.conversations.map((x) => (
            <Row
              key={x.id}
              x={x}
              current={x.id === activeId}
              archived={archived}
              tab={tab}
              holder={holder}
              renaming={renaming === x.id}
              onRenameStart={() => onRenameStart(x.id)}
              onRenameEnd={onRenameEnd}
              c={c}
              onDelete={() => onDelete(x)}
            />
          ))}
          {g.more && showMore ? (
            <button
              type="button"
              className="cb-sidebar-more"
              data-part="more"
              data-rove={`m:${g.agentId}`}
              tabIndex={tab(`m:${g.agentId}`)}
              onClick={g.onMore}
            >
              {g.moreCount !== undefined
                ? fill(t("sidebar.moreN"), { n: g.moreCount })
                : t("sidebar.more")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Row({
  x,
  current,
  archived,
  tab,
  holder,
  renaming,
  onRenameStart,
  onRenameEnd,
  c,
  onDelete,
}: {
  x: SidebarConversation;
  current: boolean;
  archived: boolean;
  tab(key: string): number;
  holder: string | undefined;
  renaming: boolean;
  onRenameStart(): void;
  onRenameEnd(): void;
  c: SidebarConversations;
  onDelete(): void;
}) {
  const t = useDesignT();
  const locale = useDesignLocale();
  const Link = useDesignLink();
  const timeZone = useTimeZone();
  const text = x.title ?? untitledLabel(x.startedAt, locale, timeZone);
  const key = `c:${x.id}`;
  const rowRef = useRef<HTMLDivElement>(null);
  // A rename chosen from the menu keeps focus in the input (the menu would return it to ⋯).
  const keepFocus = useRef(false);
  const wasRenaming = useRef(renaming);
  useEffect(() => {
    // Back from the input: focus returns to the row.
    if (wasRenaming.current && !renaming)
      rowRef.current?.querySelector<HTMLElement>("[data-rove]")?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);
  // The caller reports a failure (toast); the menu has nothing left to do with it.
  const archive = (to: boolean) => {
    c.onArchive(x.id, to).catch(() => {});
  };
  const items: MenuItem[] = archived
    ? [
        { label: t("sidebar.unarchive"), onSelect: () => archive(false) },
        { label: t("sidebar.delete"), danger: true, onSelect: onDelete },
      ]
    : [
        {
          label: t("sidebar.rename"),
          onSelect: () => {
            keepFocus.current = true;
            onRenameStart();
          },
        },
        { label: t("sidebar.archive"), onSelect: () => archive(true) },
        { label: t("sidebar.delete"), danger: true, onSelect: onDelete },
      ];
  const dot =
    x.activity === "running" || x.activity === "waiting" ? (
      <span
        className="cb-sidebar-dot"
        data-part="state-dot"
        data-activity={x.activity}
        role="img"
        aria-label={t(x.activity === "running" ? "sidebar.stateRunning" : "sidebar.stateWaiting")}
      />
    ) : null;
  return (
    <div
      ref={rowRef}
      className="cb-sidebar-row"
      data-part="conversation-row"
      data-current={current ? "true" : undefined}
    >
      {dot}
      {renaming ? (
        <RenameInput
          initial={x.title ?? ""}
          onCancel={onRenameEnd}
          onSave={async (title) => {
            await c.onRename(x.id, title);
            onRenameEnd();
          }}
        />
      ) : (
        <>
          <Link
            href={x.href}
            className="cb-sidebar-conv"
            data-part="conversation"
            data-rove={key}
            tabIndex={tab(key)}
            title={text}
            {...(current ? { "aria-current": "page" as const } : {})}
          >
            <span className="cb-sidebar-label">{text}</span>
            <LinkPendingMark />
          </Link>
          <Menu
            items={items}
            onCloseAutoFocus={(e) => {
              if (keepFocus.current) {
                keepFocus.current = false;
                e.preventDefault();
              }
            }}
            trigger={
              <button
                type="button"
                className="cb-sidebar-row-menu"
                data-part="row-menu"
                aria-label={fill(t("sidebar.rowActions"), { title: text })}
                // Tab reaches the actions of the row holding the list's tab stop only.
                tabIndex={holder === key ? 0 : -1}
              >
                <Icon name="more-horizontal" size={14} />
              </button>
            }
          />
        </>
      )}
    </div>
  );
}

function RenameInput({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave(title: string): Promise<void>;
  onCancel(): void;
}) {
  const t = useDesignT();
  const [value, setValue] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector("input");
    input?.focus();
    input?.select();
  }, []);
  return (
    <div ref={ref} className="cb-sidebar-rename" data-part="rename">
      <Input
        density="dense"
        aria-label={t("sidebar.renameLabel")}
        value={value}
        invalid={invalid}
        // Read-only while saving, not disabled: focus stays in the input, also after a failure.
        readOnly={busy}
        aria-busy={busy || undefined}
        maxLength={200}
        onChange={(e) => {
          setValue(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          // An IME composition takes Enter and Escape for itself.
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (busy) return;
            const title = value.trim();
            if (title === "") {
              setInvalid(true);
              return;
            }
            setBusy(true);
            onSave(title).catch(() => setBusy(false));
          }
        }}
      />
    </div>
  );
}

function DeleteConfirm({
  target,
  text,
  onClose,
  onDelete,
}: {
  target: SidebarConversation | null;
  text: string;
  onClose(): void;
  onDelete(id: string): Promise<void>;
}) {
  const t = useDesignT();
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o && !busy) onClose();
      }}
      title={t("sidebar.deleteTitle")}
      danger
      initialFocus="cancel"
      footer={
        <>
          <Button variant="default" disabled={busy} onClick={onClose}>
            {t("overlay.cancel")}
          </Button>
          <Button
            variant="danger-solid"
            disabled={busy}
            onClick={() => {
              if (target === null) return;
              setBusy(true);
              onDelete(target.id).then(
                () => {
                  setBusy(false);
                  onClose();
                },
                () => setBusy(false),
              );
            }}
          >
            {t("sidebar.delete")}
          </Button>
        </>
      }
    >
      <p className="cb-sidebar-dialog-text">{fill(t("sidebar.deleteBody"), { title: text })}</p>
    </Dialog>
  );
}
