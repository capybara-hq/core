import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { IconButton } from "../controls/button";
import { Icon } from "../icons/icon";
import { Menu, type MenuItem } from "../overlays/menus";
import { useDesignT } from "../provider";
import { ClassForms } from "../shell/class-forms";
import { SkeletonBox, SkeletonGroup } from "./skeleton";

/** One column of a {@link Board} (spec §6.69). */
export interface BoardColumn {
  id: string;
  title: string;
  count?: number;
  /** A gate: still takes a drop (the plugin turns it into a request); the held card shows `hint`. */
  locked?: boolean;
  hint?: string;
}

/** The least a card carries: its id and its column. */
export interface BoardCard {
  id: string;
  columnId: string;
}

export interface BoardProps<C extends BoardCard> {
  columns: BoardColumn[];
  /** A column's cards in the order of this array. */
  cards: C[];
  /** The card's content: no buttons or links of its own (the card is the button). */
  renderCard(card: C): ReactNode;
  /** `index` in the target column without the moved card. A rejected promise snaps the card back. */
  onMove(cardId: string, toColumnId: string, index: number): void | Promise<void>;
  /** False refuses that drop. */
  canMove?(card: C, toColumnId: string): boolean;
  onOpen?(cardId: string): void;
  /** Drawn in place of the columns when there are no cards and the board is not loading. */
  empty?: ReactNode;
  loading?: boolean;
}

/** A card placed in a column at an index (the index counted without the card itself). */
export interface BoardPlace {
  cardId: string;
  columnId: string;
  index: number;
}

type Form = "wide" | "compact";
type Lanes<C> = Map<string, C[]>;
/** The column under the held card when it left its own: a drop target or a refused one. */
type Over = "true" | "refused" | undefined;

const COLUMN_DROP = "cb-board-column:";
/** The library's own announcements stay silent: the board speaks through its one live region. */
const SILENT = {
  onDragStart: () => undefined,
  onDragMove: () => undefined,
  onDragOver: () => undefined,
  onDragEnd: () => undefined,
  onDragCancel: () => undefined,
};

const fill = (text: string, vars: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** The columns' cards in order, with `moves` applied one after another (original card objects). */
function arrange<C extends BoardCard>(
  columns: BoardColumn[],
  cards: C[],
  moves: (BoardPlace | null | undefined)[],
): Lanes<C> {
  const lanes: Lanes<C> = new Map(columns.map((c) => [c.id, [] as C[]]));
  for (const card of cards) lanes.get(card.columnId)?.push(card);
  for (const move of moves) {
    if (!move || !lanes.has(move.columnId)) continue;
    let moved: C | undefined;
    for (const lane of lanes.values()) {
      const i = lane.findIndex((c) => c.id === move.cardId);
      if (i >= 0) {
        moved = lane.splice(i, 1)[0];
        break;
      }
    }
    if (!moved) continue;
    const target = lanes.get(move.columnId) as C[];
    target.splice(Math.max(0, Math.min(move.index, target.length)), 0, moved);
  }
  return lanes;
}

function where<C extends BoardCard>(lanes: Lanes<C>, id: string) {
  for (const [columnId, lane] of lanes) {
    const index = lane.findIndex((c) => c.id === id);
    if (index >= 0) return { columnId, index };
  }
  return null;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function isPromise(v: unknown): v is Promise<void> {
  return typeof (v as { then?: unknown } | undefined)?.then === "function";
}

/**
 * A kanban board (spec §6.69; plugin full pages design §6): columns of cards; pointer drag and a
 * keyboard model by position from 600 up, a Move to… menu per card on compact (`ClassForms`).
 */
export function Board<C extends BoardCard>(props: BoardProps<C>) {
  const { columns, cards, renderCard, onMove, canMove, onOpen, empty, loading } = props;
  const t = useDesignT();
  const instructionsId = useId();
  const [said, setSaid] = useState("");
  // A move waiting for its promise; once settled it stays applied until `cards` change.
  const [pending, setPending] = useState<{
    move: BoardPlace;
    token: object;
    settledWith?: C[];
  } | null>(null);
  const cardsRef = useRef(cards);
  useLayoutEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  const committed =
    pending && (pending.settledWith === undefined || pending.settledWith === cards)
      ? pending.move
      : null;

  const commit = useCallback(
    (move: BoardPlace) => {
      const result = onMove(move.cardId, move.columnId, move.index);
      if (!isPromise(result)) {
        setPending(null);
        return;
      }
      const token = {};
      setPending({ move, token });
      result.then(
        () => setPending((p) => (p?.token === token ? { ...p, settledWith: cardsRef.current } : p)),
        () => setPending((p) => (p?.token === token ? null : p)),
      );
    },
    [onMove],
  );

  const live = (
    <span className="cb-sr-only" data-part="board-live" role="status" aria-live="polite">
      {said}
    </span>
  );

  if (!loading && cards.length === 0 && empty !== undefined && empty !== null) {
    return (
      <div className="cb-board-root" data-part="board-root">
        {empty}
        {live}
      </div>
    );
  }

  const shared = { columns, cards, renderCard, canMove, onOpen, committed, commit, say: setSaid };
  return (
    <div className="cb-board-root" data-part="board-root">
      {loading ? (
        <ClassForms
          compact={<LoadingBoard columns={columns} form="compact" />}
          wide={<LoadingBoard columns={columns} form="wide" />}
        />
      ) : (
        <ClassForms
          compact={<CompactBoard {...shared} />}
          wide={<WideBoard {...shared} instructionsId={instructionsId} />}
        />
      )}
      <span id={instructionsId} className="cb-sr-only">
        {t("board.instructions")}
      </span>
      {live}
    </div>
  );
}

interface FormProps<C extends BoardCard> {
  columns: BoardColumn[];
  cards: C[];
  renderCard(card: C): ReactNode;
  canMove: ((card: C, toColumnId: string) => boolean) | undefined;
  onOpen: ((cardId: string) => void) | undefined;
  committed: BoardPlace | null;
  commit(move: BoardPlace): void;
  say(text: string): void;
}

// ── The parts both forms draw ────────────────────────────────────────────────

function Lane({
  column,
  over,
  empty,
  laneRef,
  children,
}: {
  column: BoardColumn;
  over?: Over;
  empty: boolean;
  laneRef?: (el: HTMLElement | null) => void;
  children?: ReactNode;
}) {
  const t = useDesignT();
  const titleId = useId();
  const lockLabel = column.locked
    ? [fill(t("board.locked"), { column: column.title }), column.hint].filter(Boolean).join(" ")
    : undefined;
  return (
    <section
      ref={laneRef}
      className="cb-board-column"
      data-part="board-column"
      data-column-id={column.id}
      data-over={over}
      aria-labelledby={titleId}
    >
      <div className="cb-board-head" data-part="board-column-head">
        <span id={titleId} className="cb-board-title" data-part="board-column-title">
          {column.title}
        </span>
        {column.count !== undefined ? (
          <span className="cb-board-count" data-part="board-column-count">
            {column.count}
          </span>
        ) : null}
        {column.locked ? (
          <span
            className="cb-board-lock"
            data-part="board-column-lock"
            role="img"
            aria-label={lockLabel}
            title={column.hint}
          >
            <Icon name="lock" size={14} />
          </span>
        ) : null}
      </div>
      <ul className="cb-board-list" aria-labelledby={titleId}>
        {empty ? (
          <li className="cb-board-item" aria-hidden="true">
            <span className="cb-board-empty" data-part="board-column-empty" />
          </li>
        ) : (
          children
        )}
      </ul>
    </section>
  );
}

function CardContent({ hint, children }: { hint?: string | undefined; children: ReactNode }) {
  return (
    <>
      {children}
      {hint ? (
        <span className="cb-board-card-hint" data-part="board-card-hint">
          <Icon name="lock" size={14} />
          {hint}
        </span>
      ) : null}
    </>
  );
}

function LoadingBoard({ columns, form }: { columns: BoardColumn[]; form: Form }) {
  const t = useDesignT();
  const counts = [3, 2, 1];
  return (
    <SkeletonGroup label={t("table.loading")}>
      <div className="cb-board" data-part="board" data-form={form === "compact" ? form : undefined}>
        {columns.map((column, i) => (
          <Lane key={column.id} column={column} empty={false}>
            {Array.from({ length: counts[i] ?? 1 }, (_, n) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
              <li key={n} className="cb-board-item">
                <SkeletonBox part="block" height={72} />
              </li>
            ))}
          </Lane>
        ))}
      </div>
    </SkeletonGroup>
  );
}

/**
 * The board drawn still, one card held (`held`), for the reference blocks of the dragging, over
 * and locked-over states and the compact form (spec §6.69). It moves nothing.
 */
export function BoardFrame<C extends BoardCard>({
  columns,
  cards,
  renderCard,
  held,
  form = "wide",
}: {
  columns: BoardColumn[];
  cards: C[];
  renderCard(card: C): ReactNode;
  held?: BoardPlace;
  form?: Form;
}) {
  const lanes = arrange(columns, cards, [held]);
  const origin = held ? cards.find((c) => c.id === held.cardId)?.columnId : undefined;
  const overId = held && held.columnId !== origin ? held.columnId : undefined;
  const overColumn = columns.find((c) => c.id === overId);
  return (
    <div className="cb-board-root" data-part="board-root">
      <div className="cb-board" data-part="board" data-form={form === "compact" ? form : undefined}>
        {columns.map((column) => {
          const lane = lanes.get(column.id) ?? [];
          return (
            <Lane
              key={column.id}
              column={column}
              over={column.id === overId ? "true" : undefined}
              empty={lane.length === 0}
            >
              {lane.map((card) => {
                const isHeld = held?.cardId === card.id;
                const hint = isHeld && overColumn?.locked ? overColumn.hint : undefined;
                return (
                  <li key={card.id} className="cb-board-item">
                    {form === "compact" ? (
                      <CompactCard id={card.id}>{renderCard(card)}</CompactCard>
                    ) : (
                      <div
                        className="cb-board-card"
                        data-part="board-card"
                        data-card-id={card.id}
                        data-held={isHeld ? "true" : undefined}
                      >
                        <CardContent hint={hint}>{renderCard(card)}</CardContent>
                      </div>
                    )}
                  </li>
                );
              })}
            </Lane>
          );
        })}
      </div>
    </div>
  );
}

// ── Compact: no drag, a Move to… menu per card ──────────────────────────────

/** A compact card: its body (the button that opens it) and the Move to… menu button. */
function CompactCard({
  id,
  items,
  onOpen,
  children,
}: {
  id: string;
  /** The Move to… choices; none draws the button alone (a still board). */
  items?: MenuItem[];
  onOpen?: ((cardId: string) => void) | undefined;
  children: ReactNode;
}) {
  const t = useDesignT();
  const button = (
    <IconButton
      part="board-move"
      label={t("board.moveTo")}
      icon={<Icon name="more-horizontal" />}
    />
  );
  return (
    <div className="cb-board-card" data-part="board-card" data-card-id={id} data-form="compact">
      {onOpen ? (
        // biome-ignore lint/a11y/useSemanticElements: the caller's content may hold blocks
        <div
          className="cb-board-card-body"
          role="button"
          tabIndex={0}
          onClick={() => onOpen(id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onOpen(id);
            }
          }}
        >
          {children}
        </div>
      ) : (
        <div className="cb-board-card-body">{children}</div>
      )}
      {items ? <Menu label={t("board.moveTo")} items={items} trigger={button} /> : button}
    </div>
  );
}

function CompactBoard<C extends BoardCard>(p: FormProps<C>) {
  const t = useDesignT();
  const lanes = arrange(p.columns, p.cards, [p.committed]);
  const moveTo = (card: C, column: BoardColumn) => {
    p.commit({ cardId: card.id, columnId: column.id, index: 0 });
    p.say(fill(t("board.movedTo"), { column: column.title, position: 1 }));
  };
  return (
    <div className="cb-board" data-part="board" data-form="compact">
      {p.columns.map((column) => {
        const lane = lanes.get(column.id) ?? [];
        return (
          <Lane key={column.id} column={column} empty={lane.length === 0}>
            {lane.map((card) => {
              const items: MenuItem[] = p.columns
                .filter((c) => c.id !== column.id)
                .map((c) => ({
                  label: c.title,
                  onSelect: () => moveTo(card, c),
                  ...(c.locked ? { icon: "lock" as const } : {}),
                  ...(c.locked && c.hint ? { description: c.hint } : {}),
                  ...(p.canMove && !p.canMove(card, c.id) ? { disabled: true } : {}),
                }));
              return (
                <li key={card.id} className="cb-board-item">
                  <CompactCard id={card.id} items={items} onOpen={p.onOpen}>
                    {p.renderCard(card)}
                  </CompactCard>
                </li>
              );
            })}
          </Lane>
        );
      })}
    </div>
  );
}

// ── Wide: pointer drag (dnd-kit) and the keyboard model by position ─────────

type Held = BoardPlace & {
  via: "keyboard" | "pointer";
  origin: { columnId: string; index: number };
};

function WideLane(props: Parameters<typeof Lane>[0]) {
  const { setNodeRef } = useDroppable({
    id: `${COLUMN_DROP}${props.column.id}`,
    data: { type: "column", columnId: props.column.id },
  });
  return <Lane {...props} laneRef={setNodeRef} />;
}

function SortableCard({
  id,
  columnId,
  register,
  tabStop,
  held,
  placeholder,
  describedBy,
  onKeyDown,
  onFocus,
  onClick,
  children,
}: {
  id: string;
  columnId: string;
  register(id: string, el: HTMLElement | null): void;
  tabStop: boolean;
  held: boolean;
  placeholder: boolean;
  describedBy: string;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  onFocus(): void;
  onClick(): void;
  children: ReactNode;
}) {
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition } = useSortable({
    id,
    data: { type: "card", columnId },
  });
  const activator = useCallback(
    (el: HTMLElement | null) => {
      setActivatorNodeRef(el);
      register(id, el);
    },
    [id, register, setActivatorNodeRef],
  );
  const style: CSSProperties | undefined = transform
    ? {
        transform: `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)`,
        // reduced motion: the cards make room without the slide (spec §6.69)
        ...(transition && !reducedMotion() ? { transition } : {}),
      }
    : undefined;
  return (
    <li ref={setNodeRef} className="cb-board-item" style={style}>
      {/* biome-ignore lint/a11y/useSemanticElements: the caller's content may hold blocks */}
      <div
        ref={activator}
        className="cb-board-card"
        data-part="board-card"
        data-card-id={id}
        data-drag-handle="true"
        data-held={held ? "true" : undefined}
        data-placeholder={placeholder ? "true" : undefined}
        role="button"
        tabIndex={tabStop ? 0 : -1}
        aria-describedby={describedBy}
        {...listeners}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onClick={onClick}
      >
        {children}
      </div>
    </li>
  );
}

function WideBoard<C extends BoardCard>(p: FormProps<C> & { instructionsId: string }) {
  const { columns, cards, renderCard, canMove, onOpen, committed, commit, say } = p;
  const t = useDesignT();
  const [held, setHeld] = useState<Held | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const focusNext = useRef<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const lanes = arrange(columns, cards, [committed, held]);
  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);
  const first = columns.map((c) => lanes.get(c.id)?.[0]).find(Boolean);
  const stop = focusId && where(lanes, focusId) ? focusId : (first?.id ?? null);

  // A keyboard move remounts the card in its new column: give it the focus back.
  useLayoutEffect(() => {
    const id = focusNext.current;
    if (id === null) return;
    focusNext.current = null;
    const el = elements.current.get(id);
    if (el && document.activeElement !== el) el.focus();
  });

  // Holding with the keyboard, a pointer press elsewhere puts the card back.
  useLayoutEffect(() => {
    if (held?.via !== "keyboard") return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && elements.current.get(held.cardId)?.contains(e.target)) return;
      cancel();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  });

  const columnById = (id: string) => columns.find((c) => c.id === id);
  const position = (columnId: string, index: number) => ({
    column: columnById(columnId)?.title ?? "",
    position: index + 1,
  });
  const cardById = (id: string) => cards.find((c) => c.id === id);
  const refusedAt = (cardId: string, columnId: string, origin: string) => {
    const card = cardById(cardId);
    return columnId !== origin && !!card && !!canMove && !canMove(card, columnId);
  };

  const sayOver = (next: Held) => {
    const column = columnById(next.columnId);
    const parts = [fill(t("board.position"), position(next.columnId, next.index))];
    if (column?.locked && next.columnId !== next.origin.columnId) {
      parts.push(fill(t("board.locked"), { column: column.title }));
      if (column.hint) parts.push(column.hint);
    }
    say(parts.join(" "));
  };

  const pick = (id: string, via: Held["via"]) => {
    const at = where(lanes, id);
    if (!at) return;
    setHeld({ cardId: id, ...at, via, origin: at });
    say(fill(t("board.pickedUp"), position(at.columnId, at.index)));
  };

  const cancel = () => {
    if (!held) return;
    focusNext.current = held.via === "keyboard" ? held.cardId : null;
    setHeld(null);
    say(fill(t("board.cancelled"), position(held.origin.columnId, held.origin.index)));
  };

  const drop = (final: { columnId: string; index: number }) => {
    if (!held) return;
    const { origin, cardId } = held;
    focusNext.current = held.via === "keyboard" ? cardId : null;
    setHeld(null);
    if (final.columnId === origin.columnId && final.index === origin.index) {
      say(fill(t("board.cancelled"), position(origin.columnId, origin.index)));
      return;
    }
    if (refusedAt(cardId, final.columnId, origin.columnId)) {
      say(fill(t("board.refused"), { column: columnById(final.columnId)?.title ?? "" }));
      return;
    }
    commit({ cardId, columnId: final.columnId, index: final.index });
    say(fill(t("board.movedTo"), position(final.columnId, final.index)));
  };

  const moveHeld = (next: Held) => {
    focusNext.current = next.cardId;
    setHeld(next);
    sayOver(next);
  };

  const focusCard = (id: string | undefined) => {
    if (!id) return;
    setFocusId(id);
    elements.current.get(id)?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLElement>, id: string) => {
    if (held?.via === "keyboard" && held.cardId === id) {
      const lane = lanes.get(held.columnId) ?? [];
      const col = columns.findIndex((c) => c.id === held.columnId);
      switch (e.key) {
        case "ArrowUp":
        case "ArrowDown": {
          const index = Math.max(
            0,
            Math.min(lane.length - 1, held.index + (e.key === "ArrowUp" ? -1 : 1)),
          );
          if (index !== held.index) moveHeld({ ...held, index });
          break;
        }
        case "ArrowLeft":
        case "ArrowRight": {
          const target = columns[col + (e.key === "ArrowLeft" ? -1 : 1)];
          if (target) {
            const size = lanes.get(target.id)?.length ?? 0;
            moveHeld({ ...held, columnId: target.id, index: Math.min(held.index, size) });
          }
          break;
        }
        case " ":
        case "Enter":
          drop(held);
          break;
        case "Escape":
          cancel();
          break;
        case "Tab":
          cancel();
          return;
        default:
          return;
      }
      e.preventDefault();
      return;
    }
    if (held) return;
    const at = where(lanes, id);
    if (!at) return;
    const lane = lanes.get(at.columnId) ?? [];
    switch (e.key) {
      case " ":
        pick(id, "keyboard");
        break;
      case "Enter":
        onOpen?.(id);
        break;
      case "ArrowUp":
        focusCard(lane[at.index - 1]?.id);
        break;
      case "ArrowDown":
        focusCard(lane[at.index + 1]?.id);
        break;
      case "Home":
        focusCard(lane[0]?.id);
        break;
      case "End":
        focusCard(lane[lane.length - 1]?.id);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        const step = e.key === "ArrowLeft" ? -1 : 1;
        const col = columns.findIndex((c) => c.id === at.columnId);
        for (let i = col + step; i >= 0 && i < columns.length; i += step) {
          const next = lanes.get(columns[i]?.id ?? "") ?? [];
          if (next.length > 0) {
            focusCard(next[Math.min(at.index, next.length - 1)]?.id);
            break;
          }
        }
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  // ── Pointer (dnd-kit) ──
  const overTarget = (e: DragOverEvent | DragEndEvent) => {
    const over = e.over;
    if (!over || over.id === e.active.id) return null;
    const data = over.data.current as { type?: string; columnId?: string } | undefined;
    if (data?.type === "column" && data.columnId) {
      return { columnId: data.columnId, card: null as string | null };
    }
    const at = where(lanes, String(over.id));
    return at ? { columnId: at.columnId, card: String(over.id) } : null;
  };
  const onDragStart = (e: DragStartEvent) => {
    if (held) return;
    pick(String(e.active.id), "pointer");
  };
  const onDragOver = (e: DragOverEvent) => {
    if (held?.via !== "pointer") return;
    const target = overTarget(e);
    if (!target || target.columnId === held.columnId) return;
    const lane = lanes.get(target.columnId) ?? [];
    const index = target.card
      ? Math.max(
          0,
          lane.findIndex((c) => c.id === target.card),
        )
      : lane.length;
    const next = { ...held, columnId: target.columnId, index };
    setHeld(next);
    sayOver(next);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (held?.via !== "pointer") return;
    if (!e.over) {
      cancel();
      return;
    }
    const target = overTarget(e);
    let index = held.index;
    if (target?.card && target.columnId === held.columnId) {
      index = (lanes.get(held.columnId) ?? []).findIndex((c) => c.id === target.card);
    }
    drop({ columnId: held.columnId, index: Math.max(0, index) });
  };

  const overColumn =
    held && held.columnId !== held.origin.columnId ? columnById(held.columnId) : undefined;
  const refused = held ? refusedAt(held.cardId, held.columnId, held.origin.columnId) : false;
  const hint = overColumn?.locked && !refused ? overColumn.hint : undefined;
  const heldCard = held ? cardById(held.cardId) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={cancel}
      accessibility={{ announcements: SILENT, screenReaderInstructions: { draggable: "" } }}
    >
      <div className="cb-board" data-part="board" data-dragging={held ? held.via : undefined}>
        {columns.map((column) => {
          const lane = lanes.get(column.id) ?? [];
          return (
            <WideLane
              key={column.id}
              column={column}
              over={overColumn?.id === column.id ? (refused ? "refused" : "true") : undefined}
              empty={lane.length === 0}
            >
              <SortableContext
                id={column.id}
                items={lane.map((c) => c.id)}
                strategy={verticalListSortingStrategy}
              >
                {lane.map((card) => {
                  const isHeld = held?.cardId === card.id;
                  return (
                    <SortableCard
                      key={card.id}
                      id={card.id}
                      columnId={column.id}
                      register={register}
                      tabStop={card.id === stop}
                      held={isHeld && held?.via === "keyboard"}
                      placeholder={isHeld && held?.via === "pointer"}
                      describedBy={p.instructionsId}
                      onKeyDown={(e) => onKey(e, card.id)}
                      onFocus={() => setFocusId(card.id)}
                      onClick={() => {
                        if (!held) onOpen?.(card.id);
                      }}
                    >
                      <CardContent hint={isHeld && held?.via === "keyboard" ? hint : undefined}>
                        {renderCard(card)}
                      </CardContent>
                    </SortableCard>
                  );
                })}
              </SortableContext>
            </WideLane>
          );
        })}
      </div>
      <DragOverlay dropAnimation={null}>
        {held?.via === "pointer" && heldCard ? (
          <div
            className="cb-board-card"
            data-part="board-card"
            data-held="true"
            data-overlay="true"
          >
            <CardContent hint={hint}>{renderCard(heldCard)}</CardContent>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
