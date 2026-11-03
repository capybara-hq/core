import type { ReactNode } from "react";
import { SkeletonBox, SkeletonText, StatCards } from "../display/index";
import { Grid } from "../layout/index";
import { type ActionRowProps, PageHeader, type PageHeaderProps } from "../shell/index";

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
 * one row per key with the 8ch key slot and the value slot, each a `body` line.
 */
export function LoadingInspector() {
  return (
    <dl className="cb-kv" data-part="loading-inspector">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="cb-kv-row" data-part="loading-inspector-row">
          <dt className="cb-kv-key" style={{ width: "8ch" }}>
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
 */
export type FieldShape = {
  control?: "input" | "textarea" | "select" | "segmented";
  help?: boolean;
  rows?: number;
  pair?: boolean;
};

/** The shapes a bare field count stands for: that many default inputs. */
const shapesOf = (fields: number | FieldShape[]): FieldShape[] =>
  typeof fields === "number" ? Array.from({ length: Math.max(0, fields) }, () => ({})) : fields;

/** One field placeholder: the loaded `.cb-field`'s own markup, with slots where the data goes. */
function LoadingField({ shape }: { shape: FieldShape }) {
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
