import * as RP from "@radix-ui/react-popover";
import {
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { Input } from "../controls/inputs";
import { Avatar, type AvatarValue } from "../display/avatar";
import { COLLISION_PADDING } from "../overlays/menus";
import { useDesignT } from "../provider";

/** An agent a person can start a conversation with (§6.16.26). */
export type AgentRowItem = {
  id: string;
  name: string;
  /** One line in the panel (and the chip's tooltip); may be empty. */
  description?: string;
  avatar: AvatarValue;
};

export type AgentRowProps = {
  /** In the page's order (most recent use, then name: the page decides). */
  agents: AgentRowItem[];
  /** The selected agent's id: its chip is pressed. */
  selected?: string;
  onSelect(id: string): void;
  /** Chips before 「更多 +N」 (default 5). */
  max?: number;
  /** The panel's 「最近用过」 group: agent ids, most recent first. */
  recent?: string[];
  /** Replaces 「更多 +N」 (the page already counted). */
  moreLabel?: string;
  /** The row's accessible name; default 「选择 agent」. */
  label?: string;
  /** The reference set only: the panel drawn open in place, under the row. */
  referenceOpen?: boolean;
};

/**
 * The chips the row shows: the first `max`, except that a selected agent further down takes the
 * last place, so the selection is always visible.
 */
function visibleAgents(agents: AgentRowItem[], max: number, selected?: string): AgentRowItem[] {
  if (agents.length <= max) return agents;
  const head = agents.slice(0, max);
  if (selected === undefined || head.some((a) => a.id === selected)) return head;
  const pick = agents.find((a) => a.id === selected);
  return pick ? [...agents.slice(0, max - 1), pick] : head;
}

/**
 * The agents row of a new conversation (§6.16.26, agent profile design §4.2): an `Avatar` (24)
 * and name chip per agent, the selected one pressed, at most `max`, then 「更多 +N」, which opens
 * the agent panel in a popover anchored under the row. With one agent or none it draws nothing.
 */
export function AgentRow({
  agents,
  selected,
  onSelect,
  max = 5,
  recent = [],
  moreLabel,
  label,
  referenceOpen,
}: AgentRowProps): JSX.Element | null {
  const t = useDesignT();
  const [open, setOpen] = useState(false);
  if (agents.length <= 1) return null;
  const shown = visibleAgents(agents, Math.max(1, max), selected);
  const hidden = agents.length - shown.length;
  const more = moreLabel ?? t("agents.more").replace("{n}", String(hidden));
  const pick = (id: string) => {
    setOpen(false);
    onSelect(id);
  };
  const panel = (
    <AgentPanel
      agents={agents}
      recent={recent}
      {...(selected !== undefined ? { selected } : {})}
      onSelect={pick}
      onClose={() => setOpen(false)}
      {...(referenceOpen ? { inline: true } : {})}
    />
  );
  const chips: ReactNode = shown.map((a) => (
    <button
      key={a.id}
      type="button"
      className="cb-agent-chip"
      data-part="agent-chip"
      aria-pressed={a.id === selected}
      title={a.description || undefined}
      onClick={() => onSelect(a.id)}
    >
      <Avatar value={a.avatar} name={a.name} size={24} />
      <span className="cb-agent-chip-name" data-part="agent-chip-name">
        {a.name}
      </span>
    </button>
  ));
  const moreChip = (
    <button
      type="button"
      className="cb-agent-chip"
      data-part="agent-more"
      data-open={referenceOpen || open ? "true" : undefined}
    >
      {more}
    </button>
  );
  const row = (trigger: ReactNode) => (
    // biome-ignore lint/a11y/useSemanticElements: a row of buttons, not a form control group
    <div
      className="cb-agent-row"
      data-part="agent-row"
      role="group"
      aria-label={label ?? t("agents.label")}
    >
      {chips}
      {hidden > 0 ? trigger : null}
    </div>
  );
  if (hidden === 0) return row(null);
  if (referenceOpen) {
    return (
      <div className="cb-agent-row-stage" data-part="agent-row-stage">
        {row(moreChip)}
        {panel}
      </div>
    );
  }
  return (
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Anchor asChild>{row(<RP.Trigger asChild>{moreChip}</RP.Trigger>)}</RP.Anchor>
      <RP.Portal>
        <RP.Content
          className="cb-popover cb-agent-panel"
          data-part="agent-panel-pop"
          aria-label={t("agents.panel")}
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={COLLISION_PADDING}
        >
          {panel}
        </RP.Content>
      </RP.Portal>
    </RP.Root>
  );
}

export type AgentPanelProps = {
  agents: AgentRowItem[];
  /** Agent ids, most recent first: the 「最近用过」 group (none when empty). */
  recent?: string[];
  /** The selected agent: its row is marked current. */
  selected?: string;
  onSelect(id: string): void;
  /** Escape. Inside the row's popover Radix also closes it and gives focus back to 「更多」. */
  onClose(): void;
  /** The search's first text (the reference set's no-match state). */
  defaultQuery?: string;
  /** The reference set only: drawn in the popover's frame in place (no portal, not floating). */
  inline?: boolean;
};

const matches = (a: AgentRowItem, q: string) =>
  q === "" ||
  a.name.toLocaleLowerCase().includes(q) ||
  (a.description ?? "").toLocaleLowerCase().includes(q);

/** Columns of each group's grid in the agent panel. */
export const AGENT_PANEL_COLUMNS = 2;

/**
 * The next active option of the agent panel's grids (§6.16.26) after an arrow key. `sizes` are the
 * groups' option counts in order; `at` is `[group, index]`. ← / → move within the row (no wrap);
 * ↑ / ↓ move one row (two options). From a group's last row ↓ goes to the next group's first row,
 * from its first row ↑ to the previous group's last row, in the same column or the nearest one
 * that exists there; on a row with no option below the current column ↓ goes to the group's last
 * option. At the edges the active option stays.
 */
export function gridStep(
  sizes: readonly number[],
  at: readonly [number, number],
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown",
): [number, number] {
  const C = AGENT_PANEL_COLUMNS;
  const [g, i] = at;
  const len = sizes[g] ?? 0;
  const col = i % C;
  const row = Math.floor(i / C);
  const lastRow = Math.floor((len - 1) / C);
  if (key === "ArrowLeft") return col > 0 ? [g, i - 1] : [g, i];
  if (key === "ArrowRight") return col < C - 1 && i + 1 < len ? [g, i + 1] : [g, i];
  if (key === "ArrowDown") {
    if (row < lastRow) return [g, Math.min(i + C, len - 1)];
    const next = sizes[g + 1];
    return next ? [g + 1, Math.min(col, next - 1)] : [g, i];
  }
  if (row > 0) return [g, i - C];
  const prev = sizes[g - 1];
  if (!prev) return [g, i];
  const start = Math.floor((prev - 1) / C) * C;
  return [g - 1, Math.min(start + col, prev - 1)];
}

/**
 * The agent panel (§6.16.26): a search over name and description (case-insensitive), then the
 * 「最近用过」 and 「全部 N 个」 groups of rows (an `Avatar` 28, the name and the description on
 * one line), each group a two-column grid. A combobox over a listbox: focus stays in the search,
 * the arrows move the active row in two dimensions ({@link gridStep}), Enter selects it, Escape
 * closes. No match: a quiet line.
 */
export function AgentPanel({
  agents,
  recent = [],
  selected,
  onSelect,
  onClose,
  defaultQuery = "",
  inline,
}: AgentPanelProps): JSX.Element {
  const t = useDesignT();
  const base = useId();
  const [query, setQuery] = useState(defaultQuery);
  const [active, setActive] = useState(0);
  const q = query.trim().toLocaleLowerCase();
  const groups = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const recentItems = recent
      .map((id) => byId.get(id))
      .filter((a): a is AgentRowItem => a !== undefined && matches(a, q));
    const all = agents.filter((a) => matches(a, q));
    const out: { key: string; label: string; items: AgentRowItem[] }[] = [];
    if (recentItems.length > 0)
      out.push({ key: "r", label: t("agents.recent"), items: recentItems });
    if (all.length > 0)
      out.push({ key: "a", label: t("agents.all").replace("{n}", String(all.length)), items: all });
    return out;
  }, [agents, recent, q, t]);
  const flat = groups.flatMap((g) => g.items.map((a) => ({ id: `${base}-${g.key}-${a.id}`, a })));
  const current = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const activeId = current >= 0 ? flat[current]?.id : undefined;
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // An IME is composing (pinyin): its Enter and arrows belong to the IME, not the list.
    if (e.nativeEvent.isComposing) return;
    if (
      e.key === "ArrowDown" ||
      e.key === "ArrowUp" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight"
    ) {
      // ← / → keep moving the text caret while nothing is listed
      if (flat.length === 0) return;
      e.preventDefault();
      const sizes = groups.map((g) => g.items.length);
      let g = 0;
      let i = Math.max(0, current);
      while (g < sizes.length - 1 && i >= (sizes[g] ?? 0)) {
        i -= sizes[g] ?? 0;
        g += 1;
      }
      const [ng, ni] = gridStep(sizes, [g, i], e.key);
      let next = ni;
      for (let k = 0; k < ng; k++) next += sizes[k] ?? 0;
      setActive(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = flat[current];
      if (hit) onSelect(hit.a.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const listId = `${base}-list`;
  const body = (
    <div className="cb-agent-panel-body" data-part="agent-panel">
      <Input
        type="text"
        role="combobox"
        aria-expanded={flat.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        {...(activeId ? { "aria-activedescendant": activeId } : {})}
        aria-label={t("agents.search")}
        placeholder={t("agents.search")}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {flat.length > 0 ? (
        <div
          id={listId}
          role="listbox"
          aria-label={t("agents.panel")}
          className="cb-agent-list"
          data-part="agent-list"
        >
          {groups.map((g) => {
            const labelId = `${base}-${g.key}-label`;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a listbox's option group (no fieldset there)
              <div
                key={g.key}
                role="group"
                aria-labelledby={labelId}
                className="cb-agent-group"
                data-part="agent-group"
              >
                <div id={labelId} className="cb-agent-group-label" data-part="agent-group-label">
                  {g.label}
                </div>
                {g.items.map((a) => {
                  const id = `${base}-${g.key}-${a.id}`;
                  const on = id === activeId;
                  return (
                    // biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keyboard (aria-activedescendant)
                    <div
                      key={id}
                      id={id}
                      role="option"
                      tabIndex={-1}
                      aria-selected={on}
                      className="cb-agent-option"
                      data-part="agent-option"
                      data-active={on ? "true" : undefined}
                      data-current={a.id === selected ? "true" : undefined}
                      onMouseMove={() => {
                        const i = flat.findIndex((f) => f.id === id);
                        if (i !== current) setActive(i);
                      }}
                      onClick={() => onSelect(a.id)}
                    >
                      <Avatar value={a.avatar} name={a.name} size={28} />
                      <span className="cb-agent-option-name" data-part="agent-option-name">
                        {a.name}
                      </span>
                      {a.description ? (
                        <span className="cb-agent-option-desc" data-part="agent-option-desc">
                          {a.description}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="cb-agent-empty" data-part="agent-empty" role="status">
          {t("agents.empty")}
        </p>
      )}
    </div>
  );
  return inline ? (
    <div className="cb-popover cb-agent-panel" data-inline="true" data-part="agent-panel-pop">
      {body}
    </div>
  ) : (
    body
  );
}
