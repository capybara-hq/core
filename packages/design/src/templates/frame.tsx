import type { ReactNode } from "react";
import { SkeletonBox, SkeletonText, StatCards } from "../display/index";
import { Grid, Stack, Text } from "../layout/index";
import { type ActionRowProps, PageHeader, type PageHeaderProps } from "../shell/index";
import { type Column, DataTable } from "../table/index";

/**
 * The fixed header area of a template (spec §4.2): the PageHeader in a frame of the one content
 * width (`layout.content`, §4.3), so it lines up with the body below it on every page. Templates
 * without a list body (detail, trace, inbox, onboarding, status) draw the header's metrics here as
 * StatCards (`statsInHead`); list and overview pages draw them at the top of the body (WithStats).
 * `loose` leaves space.6 below the header for forms.
 */
export function TemplateHead({
  header,
  statsInHead,
  loose,
  children,
}: {
  header: PageHeaderProps;
  statsInHead?: boolean;
  loose?: boolean;
  /** Drawn under the header inside the same frame (DetailPage's tabs). */
  children?: ReactNode;
}) {
  const metrics = statsInHead ? (header.metrics ?? []) : [];
  return (
    <div className="cb-template-head" data-gap={loose ? "loose" : undefined}>
      <div
        className="cb-template-head-frame"
        data-width="content"
        data-stats={statsInHead ? "head" : undefined}
      >
        <PageHeader {...header} />
        {metrics.length > 0 ? <StatCards metrics={metrics} /> : null}
        {children}
      </div>
    </div>
  );
}

/** The header's metrics as StatCards above the page content (spec §5.1), when there are any. */
export function WithStats({ header, children }: { header: PageHeaderProps; children?: ReactNode }) {
  const metrics = header.metrics ?? [];
  return (
    <>
      {metrics.length > 0 ? <StatCards metrics={metrics} /> : null}
      {children}
    </>
  );
}

/**
 * The header of a loading template (spec §4.2): a title the page does not know yet (an empty
 * string) is a bar; what it knows renders for real. `header.loading` wins when the page sets it.
 */
export function loadingHeader(header: PageHeaderProps): PageHeaderProps {
  return { ...header, loading: header.loading ?? { title: header.title === "" } };
}

/**
 * Stat card placeholders in the loaded card's box (spec §5): the `.cb-stat-card` frame, a `small`
 * label slot and a `metric` value slot.
 */
export function LoadingStats({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="cb-stat-cards" data-part="stat-cards">
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <div key={i} className="cb-stat-card" data-part="stat-card">
          <div className="cb-stat-label" data-part="stat-label">
            <SkeletonText width="55%" size="small" />
          </div>
          <div className="cb-stat-value" data-part="stat-value">
            <SkeletonText width="45%" size="metric" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Card-shaped section placeholders (spec §5.2): the `cb-card` panel with its head band (a title
 * slot) and three text lines in the body.
 */
export function LoadingCards({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <section key={i} className="cb-card" data-part="loading-card">
          <header className="cb-card-head">
            <SkeletonText width="30%" />
          </header>
          <div className="cb-card-body cb-loading-stack">
            <SkeletonText width="100%" />
            <SkeletonText width="70%" />
            <SkeletonText width="55%" />
          </div>
        </section>
      ))}
    </>
  );
}

/**
 * The inspector's properties as placeholders, in KeyValue's own box (spec §5.2): the same `dl`,
 * one row per key (`rows`, default 4) with the key slot (`keyWidth`, default 8ch) and the value
 * slot, each a `body` line.
 */
export function LoadingInspector({
  rows = 4,
  keyWidth = "8ch",
}: {
  rows?: number;
  keyWidth?: string;
}) {
  return (
    <dl className="cb-kv" data-part="loading-inspector">
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <div key={i} className="cb-kv-row" data-part="loading-inspector-row">
          <dt className="cb-kv-key" style={{ width: keyWidth }}>
            <SkeletonText width="100%" />
          </dt>
          <dd className="cb-kv-value">
            <SkeletonText width="55%" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The action row of a loading page: the row stays, nothing is known to save or cancel yet, so its
 * buttons are disabled and it says nothing about unsaved changes (spec §5.3).
 */
export function loadingActionRow(row: ActionRowProps): ActionRowProps {
  const { unsaved: _u, errors: _e, ...rest } = row;
  return {
    ...rest,
    ...(row.cancel ? { cancel: { ...row.cancel, disabled: true } } : {}),
    ...(row.secondary ? { secondary: { ...row.secondary, disabled: true } } : {}),
    primary: { ...row.primary, disabled: true },
  };
}

/**
 * What a loading field looks like (spec §5.3): the page's static layout, which it knows before its
 * data arrives. `control` is the kind of control (default `input`; `input`, `select` and `segmented`
 * share the default control height); `rows` the textarea's lines (default 2); `help` a small line
 * under the control (help text, an error message or a counter); `pair` puts this field and the next
 * one in one row, as the loaded section's two-column grid does.
 *
 * Three shapes stand for a control group that is no `Field` (spec §5.8), each in a `Stack` (gap 8)
 * with the `help` line under it, as a settings section draws a group and its hint: `radio-cards`
 * is a card RadioGroup of `options` cards (default 2), each with its label and description lines;
 * `key-value` is a KeyValue of `rows` rows (default 3) with a `keyWidth` key column (default 8ch);
 * `switch` is a switch and its state word on one row; `radios` is a plain RadioGroup of `options`
 * rows (default 3), each its box and a label slot. Two more stand for static text and a block of
 * cards beside the controls (no stack): `text` is one `prose` line (a hint the section always
 * shows, the prose-small line); `card-group` is a small label line over a gap-12 stack of `options` untitled cards
 * (default {@link LOADING_GROUP_CARDS}), each a `body` line over `rows` `small` lines (default 2),
 * as a labelled list of cards (an extension's permissions) draws.
 */
export type FieldShape = {
  control?:
    | "input"
    | "textarea"
    | "select"
    | "segmented"
    | "radio-cards"
    | "radios"
    | "key-value"
    | "switch"
    | "text"
    | "card-group";
  help?: boolean;
  rows?: number;
  pair?: boolean;
  /** `radio-cards`, `card-group`: how many cards; `radios`: how many options. */
  options?: number;
  /** `key-value`: the key column's width (KeyValue's `keyWidth`). */
  keyWidth?: string;
};

/**
 * A titled card while it loads (spec §5.8): the `Card` frame with a title slot and `actions`
 * button slots in its head; the body holds `lines` text lines (`lineSize`, default `body`), and
 * with a `field` the lines (gap 4) and that field's placeholder below them (gap 12), as a card that
 * describes a setting and then edits it does. `list` adds a labelled list after the lines: a
 * `small` label line and `list` `small` lines in a gap-4 stack (an install's components).
 */
export type CardShape = {
  lines?: number;
  lineSize?: "body" | "small";
  field?: FieldShape;
  actions?: number;
  list?: number;
};

/** Cards a `card-group` draws when it is not told how many (spec §5.8). */
export const LOADING_GROUP_CARDS = 2;

/** A labelled list's small lines: its label, then `count` items (gap 4). */
function LoadingList({ count }: { count: number }) {
  return (
    <Stack gap={4}>
      <SkeletonText width="30%" size="small" />
      {Array.from({ length: Math.max(0, count) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <SkeletonText key={i} width="55%" size="small" />
      ))}
    </Stack>
  );
}

/** A small label over a gap-12 stack of untitled cards, each a body line over small lines. */
function LoadingCardGroup({ cards, rows }: { cards: number; rows: number }) {
  return (
    <Stack gap={8}>
      <SkeletonText width="30%" size="small" />
      <Stack gap={12}>
        {Array.from({ length: Math.max(0, cards) }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
          <section key={i} className="cb-card" data-part="loading-group-card">
            <div className="cb-card-body">
              <Stack gap={4}>
                <SkeletonText width="30%" />
                {Array.from({ length: Math.max(0, rows) }, (_, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
                  <SkeletonText key={j} width="55%" size="small" />
                ))}
              </Stack>
            </div>
          </section>
        ))}
      </Stack>
    </Stack>
  );
}

/** The shapes a bare field count stands for: that many default inputs. */
const shapesOf = (fields: number | FieldShape[]): FieldShape[] =>
  typeof fields === "number" ? Array.from({ length: Math.max(0, fields) }, () => ({})) : fields;

/** A card RadioGroup's own markup with slots for each card's label and description. */
function LoadingRadioCards({ options }: { options: number }) {
  return (
    <div className="cb-radios" data-variant="card" data-part="loading-radios">
      {Array.from({ length: Math.max(0, options) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <span key={i} className="cb-radio" data-variant="card" data-part="loading-radio">
          <SkeletonBox part="block" width={14} height={14} />
          <span className="cb-radio-text" data-loading="true">
            <SkeletonText width="30%" />
            <SkeletonText width="70%" size="small" />
          </span>
        </span>
      ))}
    </div>
  );
}

/** A plain RadioGroup's own markup: per option its box and a label slot. */
function LoadingRadios({ options }: { options: number }) {
  return (
    <div className="cb-radios" data-variant="plain" data-part="loading-plain-radios">
      {Array.from({ length: Math.max(0, options) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <span key={i} className="cb-radio" data-variant="plain" data-part="loading-radio">
          <SkeletonBox part="block" width={14} height={14} />
          <span className="cb-radio-text" data-loading="true">
            <SkeletonText width="30%" />
          </span>
        </span>
      ))}
    </div>
  );
}

/** KeyValue's own `dl` with a key slot and a value slot per row (`columns`: KeyValue's grid). */
function LoadingKeyValue({
  rows,
  keyWidth,
  columns = 1,
}: {
  rows: number;
  keyWidth: string;
  columns?: 1 | 2;
}) {
  const grid = columns === 2;
  return (
    <dl className="cb-kv" data-part="loading-key-value" data-columns={grid ? "2" : undefined}>
      {Array.from({ length: Math.max(0, rows) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <div key={i} className="cb-kv-row" data-part="key-value-row">
          {/* The key slot keeps `keyWidth` in the grid too: a max-content column would make its
              percentage bar 0 px wide. */}
          <dt className="cb-kv-key" style={{ width: keyWidth }}>
            <SkeletonText width="100%" />
          </dt>
          <dd className="cb-kv-value">
            <SkeletonText width="55%" />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** One field placeholder: the loaded `.cb-field`'s own markup, with slots where the data goes. */
function LoadingField({ shape }: { shape: FieldShape }) {
  // A hint is `Text variant="prose"`, whose line is prose-small's (20, the `body` line).
  if (shape.control === "text") return <SkeletonText width="70%" />;
  if (shape.control === "card-group") {
    return <LoadingCardGroup cards={shape.options ?? LOADING_GROUP_CARDS} rows={shape.rows ?? 2} />;
  }
  const group =
    shape.control === "radio-cards" ? (
      <LoadingRadioCards options={shape.options ?? 2} />
    ) : shape.control === "radios" ? (
      <LoadingRadios options={shape.options ?? 3} />
    ) : shape.control === "key-value" ? (
      <LoadingKeyValue rows={shape.rows ?? 3} keyWidth={shape.keyWidth ?? "8ch"} />
    ) : shape.control === "switch" ? (
      <Stack direction="row" gap={12} align="center">
        <span className="cb-loading-slot" data-part="loading-switch">
          <SkeletonBox part="block" width={32} height={20} />
        </span>
        <SkeletonText width={64} />
      </Stack>
    ) : null;
  if (group !== null) {
    return (
      <Stack gap={8}>
        {group}
        {shape.help ? <SkeletonText width="55%" size="small" /> : null}
      </Stack>
    );
  }
  const textarea = shape.control === "textarea";
  return (
    <div className="cb-field" data-part="loading-field">
      <div className="cb-field-head">
        <SkeletonText width="30%" />
      </div>
      {textarea ? (
        <SkeletonBox part="textarea" rows={shape.rows ?? 2} />
      ) : (
        <SkeletonBox part="default" />
      )}
      {shape.help ? <SkeletonText width="55%" size="small" /> : null}
    </div>
  );
}

/** Cards a loading page draws when it is not told how many (spec §5.8). */
export const LOADING_CARDS = 3;

/**
 * Titled card placeholders (spec §5.8), one per `CardShape`, in the `Card` frame: a title slot
 * (45%) and `actions` button slots (88 px, the control height) in the head, then the body.
 */
export function LoadingShapedCards({ cards }: { cards: CardShape[] }) {
  return (
    <>
      {cards.map((c, i) => {
        const size = c.lineSize ?? "body";
        const lines = Array.from({ length: Math.max(0, c.lines ?? 1) }, (_, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
          <SkeletonText key={j} width={j === 0 ? "70%" : "55%"} size={size} />
        ));
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
          <section key={i} className="cb-card" data-part="loading-shaped-card">
            <header className="cb-card-head">
              <div className="cb-card-title" data-loading="true">
                <SkeletonText width="45%" />
              </div>
              {(c.actions ?? 0) > 0 ? (
                <div className="cb-card-actions">
                  {Array.from({ length: c.actions ?? 0 }, (_, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
                    <SkeletonBox key={j} part="default" width={88} />
                  ))}
                </div>
              ) : null}
            </header>
            <div className="cb-card-body">
              {c.field ? (
                <Stack gap={12}>
                  <Stack gap={4}>{lines}</Stack>
                  <LoadingField shape={c.field} />
                </Stack>
              ) : (
                <Stack gap={8}>
                  {lines}
                  {c.list !== undefined ? <LoadingList count={c.list} /> : null}
                </Stack>
              )}
            </div>
          </section>
        );
      })}
    </>
  );
}

/**
 * Field placeholders (spec §5.3): each is the loaded `.cb-field` itself, a label slot (a `body`
 * line, 30% wide) in `.cb-field-head` where the label is, then a box at the control's own height
 * (a textarea `rows` lines high) directly in the field, so the box takes whatever width the
 * field's rule gives a control, and a `small` slot when the field has a line under it. `fields` is
 * a count (that many default inputs) or the page's static layout as `FieldShape`s; a `pair` shape
 * and the one after it share a two-column row (`Grid`), as in the loaded section. Drawn in the
 * container the loaded fields live in (a form card, a wizard card, the auth card).
 */
export function LoadingFields({ fields }: { fields: number | FieldShape[] }) {
  const shapes = shapesOf(fields);
  const out: ReactNode[] = [];
  for (let i = 0; i < shapes.length; i++) {
    const shape = shapes[i] as FieldShape;
    const next = shapes[i + 1];
    if (shape.pair && next) {
      out.push(
        <Grid key={i} columns={2} gap={12}>
          <LoadingField shape={shape} />
          <LoadingField shape={next} />
        </Grid>,
      );
      i++;
    } else {
      out.push(<LoadingField key={i} shape={shape} />);
    }
  }
  return <>{out}</>;
}

/** How many switch rows or fields a loading section draws, whichever its `fields` says. */
export const loadingCount = (fields: number | FieldShape[]): number => shapesOf(fields).length;

/**
 * Switch row placeholders for a flush form section (spec §5.3): SwitchList's own `ul` and `li`
 * (divider, padding, roomy row height), each with a name slot and a description slot in the text
 * column and a box in the switch's own size (32 x 20, the `Switch` box).
 */
export function LoadingSwitchRows({ count }: { count: number }) {
  return (
    <ul className="cb-switch-list" data-part="loading-switch-list">
      {Array.from({ length: Math.max(0, count) }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <li key={i} className="cb-switch-row" data-part="loading-switch-row">
          <span className="cb-switch-row-text">
            <SkeletonText width="30%" />
            <SkeletonText width="55%" size="small" />
          </span>
          <SkeletonBox part="block" width={32} height={20} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A block of a page's content while it loads (spec §5.2, §5.5): the static structure a detail
 * tab or a wizard step knows before its data arrives, drawn in the loaded blocks' own boxes.
 * - `lines`: a gap-4 stack of `lines` text lines (default 2), the first `body`, the rest `small`
 *   (a heading line over its facts);
 * - `list`: a labelled list as a component section draws it: a `body` label slot over `items`
 *   `body` lines (default 1, the empty note), gap 8;
 * - `key-value`: a KeyValue of `rows` rows (default 4) in `columns` (1 or 2) with `keyWidth`;
 * - `buttons`: a row (gap 8) of `count` control-height button slots (default 1, 88 px), with a
 *   `small` line under it (gap 8) when `help` is set;
 * - `table`: a `small` muted `title` (real text: the page knows it) over the DataTable's own
 *   loading state with the caller's `label` and header `columns`, gap 8;
 * - `card`: a titled card (`CardShape`, §5.8).
 */
export type BlockShape =
  | { kind: "lines"; lines?: number }
  | { kind: "list"; items?: number }
  | { kind: "key-value"; rows?: number; columns?: 1 | 2; keyWidth?: string }
  | { kind: "buttons"; count?: number; help?: boolean }
  | { kind: "table"; title?: string; label: string; columns: Column<never>[] }
  | { kind: "card"; card: CardShape };

function LoadingBlock({ block }: { block: BlockShape }) {
  switch (block.kind) {
    case "lines":
      return (
        <Stack gap={4}>
          {Array.from({ length: Math.max(0, block.lines ?? 2) }, (_, i) => (
            <SkeletonText
              // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
              key={i}
              width={i === 0 ? "45%" : "70%"}
              size={i === 0 ? "body" : "small"}
            />
          ))}
        </Stack>
      );
    case "list":
      return (
        <Stack gap={8}>
          <SkeletonText width="30%" />
          {Array.from({ length: Math.max(0, block.items ?? 1) }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
            <SkeletonText key={i} width="55%" />
          ))}
        </Stack>
      );
    case "key-value":
      return (
        <LoadingKeyValue
          rows={block.rows ?? 4}
          keyWidth={block.keyWidth ?? "8ch"}
          columns={block.columns ?? 1}
        />
      );
    case "buttons":
      return (
        <Stack gap={8}>
          <div className="cb-loading-buttons" data-part="loading-buttons">
            {Array.from({ length: Math.max(0, block.count ?? 1) }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
              <SkeletonBox key={i} part="default" width={88} />
            ))}
          </div>
          {block.help ? <SkeletonText width="55%" size="small" /> : null}
        </Stack>
      );
    case "table":
      return (
        <Stack gap={8}>
          {block.title !== undefined ? (
            <Text variant="small" tone="muted">
              {block.title}
            </Text>
          ) : null}
          <DataTable<never>
            label={block.label}
            state="loading"
            columns={block.columns}
            rows={[]}
            rowKey={() => ""}
          />
        </Stack>
      );
    case "card":
      return <LoadingShapedCards cards={[block.card]} />;
  }
}

/** A content column of block placeholders in a gap-16 stack, as the loaded content stacks them. */
export function LoadingBlocks({ blocks }: { blocks: BlockShape[] }) {
  return (
    <Stack gap={16}>
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the placeholders are positional
        <LoadingBlock key={i} block={b} />
      ))}
    </Stack>
  );
}
