import { type ReactNode, useEffect, useRef } from "react";
import { FIELDS } from "../controls/a11y";
import {
  SkeletonAnnouncement,
  SkeletonGroup,
  SkeletonText,
  useSkeletonAnnounces,
} from "../display/skeleton";
import { BoxScope } from "../layout/box";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import {
  type FieldShape,
  type ItemShape,
  LoadingFields,
  LoadingItemRows,
  LoadingSwitchRows,
  loadingActionRow,
  loadingCount,
  loadingHeader,
  TemplateHead,
} from "./frame";

/**
 * T4 Form: Centered at the form width, no anchor navigation (spec §5.3), and an ActionRow that is
 * always there; unsaved changes guard leaving the page. `loading` draws the page's frame while its
 * data is on the way (spec §5.3): the header keeps its rows, the ActionRow stays with its buttons
 * disabled, and the sections are the page's own `children` (each `FormSection` says for itself
 * whether it is loading, so one whose data is ready renders for real); one busy announcement. A `create` form (a new object) starts on
 * its first field and never says "No unsaved changes": nothing exists yet to be unchanged.
 */
export function FormPage({
  header,
  actionRow,
  create,
  loading,
  children,
}: {
  header: PageHeaderProps;
  actionRow: ActionRowProps;
  /** A form that creates an object: focus starts on the first field, no "No unsaved changes". */
  create?: boolean;
  /** The page's data is not here yet (spec §5.3). */
  loading?: boolean;
  children?: ReactNode;
}) {
  const dirty = (actionRow.unsaved ?? 0) > 0;
  const body = useRef<HTMLDivElement>(null);
  const t = useDesignT();
  useEffect(() => {
    // While loading there are no fields yet: focus the first one when they arrive.
    if (!create || loading) return;
    body.current?.querySelector<HTMLElement>(FIELDS)?.focus();
  }, [create, loading]);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 旧版 Chrome / Safari 只认 returnValue
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(header) : header} />
      <Body layout="centered" loose width="content">
        {children}
      </Body>
      <ActionRow
        {...(loading
          ? loadingActionRow(actionRow)
          : create && !dirty
            ? withoutUnsaved(actionRow)
            : actionRow)}
      />
    </>
  );
  return (
    <div className="cb-template" data-template="FormPage" data-width="content" ref={body}>
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{page}</SkeletonGroup>
      ) : (
        page
      )}
    </div>
  );
}

/** The action row without its unsaved count (a create form with nothing typed yet). */
function withoutUnsaved({ unsaved: _, ...rest }: ActionRowProps): ActionRowProps {
  return rest;
}

/** How a form section places its head (spec §5.3). */
export type FormSectionLayout = "columns" | "stacked";

/**
 * A form section (spec §5.3): two columns, the title (h2) and a prose-small muted description on
 * the left, the fields on a `panel` card on the right. Sections are separated by spacing. The card
 * is the one box (spec §1): what it holds groups with headings and hairlines (`Subsection`,
 * `ItemList`), and boxed pieces inside draw their unboxed form (a DataTable unframed, a Repeater
 * divided, a CodeBlock borderless).
 * `loading` keeps the title and description real and draws `fields` field placeholders in the
 * card (a count of default inputs, or the page's static `FieldShape`s) in place of `children`; a
 * `flush` section keeps its flush card and draws `fields` switch rows instead; `items` draws item
 * row placeholders in a flush card (a section that lists items, spec §5.8); a section whose data
 * is ready renders for real next to loading ones. Outside a loading page it announces itself.
 * `layout="stacked"` puts the head above a fields card across the full width, for content that
 * needs it (an editor); below 960 every section is stacked anyway.
 */
export function FormSection({
  id,
  title,
  description,
  layout = "columns",
  flush,
  loading,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  /** `columns` (default): the head column beside the card; `stacked`: the head above it. */
  layout?: FormSectionLayout;
  /**
   * The card without padding, for content that reaches its edges: a SwitchList, a flush
   * `ItemList`, an unframed DataTable, flush `Subsection`s.
   */
  flush?: boolean;
  /**
   * The section's data is not here yet: `fields` field placeholders replace `children`, or, for a
   * section that lists items, `items` item row placeholders in a flush card (spec §5.8).
   */
  loading?: { fields: number | FieldShape[] } | { items: ItemShape[] };
  children?: ReactNode;
}) {
  const announces = useSkeletonAnnounces();
  const items = loading !== undefined && "items" in loading ? loading.items : undefined;
  return (
    <section
      id={id}
      className="cb-form-section"
      data-part="form-section"
      data-cap-part="section"
      data-layout={layout === "stacked" ? "stacked" : undefined}
      aria-label={title}
      aria-busy={loading && announces ? "true" : undefined}
    >
      {loading && announces ? <SkeletonAnnouncement /> : null}
      <div className="cb-form-section-head" data-part="form-section-head">
        <Text variant="h2">{title}</Text>
        {description ? <p className="cb-form-section-description">{description}</p> : null}
      </div>
      <div
        className="cb-form-section-fields"
        data-part="form-card"
        data-flush={flush || items !== undefined ? "true" : undefined}
      >
        <BoxScope kind="form-card">
          {items !== undefined ? (
            <LoadingItemRows items={items} />
          ) : loading && "fields" in loading ? (
            flush ? (
              <LoadingSwitchRows count={loadingCount(loading.fields)} />
            ) : (
              <LoadingFields fields={loading.fields} />
            )
          ) : (
            children
          )}
        </BoxScope>
      </div>
    </section>
  );
}

/**
 * A section whose title and description are not known either (SettingsPage's loading shorthand):
 * the `FormSection` frame with an h2-sized slot for the title and a prose-small slot for the
 * description. What the page does know (`title`, `description`) renders for real. The form card
 * holds `fields` field placeholders, or `items` item row placeholders in a flush card (a section
 * that lists items, spec §5.8).
 */
export function LoadingFormSection({
  fields,
  items,
  title,
  description,
  layout = "columns",
}: {
  layout?: FormSectionLayout;
  fields?: number | FieldShape[];
  items?: ItemShape[];
  title?: string;
  description?: string;
}) {
  const announces = useSkeletonAnnounces();
  return (
    <section
      className="cb-form-section"
      data-part="form-section"
      data-cap-part="section"
      data-layout={layout === "stacked" ? "stacked" : undefined}
      aria-busy={announces ? "true" : undefined}
    >
      {announces ? <SkeletonAnnouncement /> : null}
      <div className="cb-form-section-head" data-part="form-section-head">
        {title !== undefined ? (
          <Text variant="h2">{title}</Text>
        ) : (
          <SkeletonText width="45%" size="heading" />
        )}
        {description !== undefined ? (
          <p className="cb-form-section-description">{description}</p>
        ) : (
          <SkeletonText width="70%" />
        )}
      </div>
      <div
        className="cb-form-section-fields"
        data-part="form-card"
        data-flush={items !== undefined ? "true" : undefined}
      >
        <BoxScope kind="form-card">
          {items !== undefined ? (
            <LoadingItemRows items={items} />
          ) : (
            <LoadingFields fields={fields ?? 0} />
          )}
        </BoxScope>
      </div>
    </section>
  );
}
