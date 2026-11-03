import { type ReactNode, useEffect, useRef } from "react";
import { FIELDS } from "../controls/a11y";
import {
  SkeletonAnnouncement,
  SkeletonGroup,
  SkeletonText,
  useSkeletonAnnounces,
} from "../display/skeleton";
import { Text } from "../layout/index";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { LoadingFields, loadingActionRow, loadingHeader, TemplateHead } from "./frame";

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
      <TemplateHead header={loading ? loadingHeader(header) : header} loose />
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

/**
 * A form section (spec §5.3): two columns, the title (h2) and a prose-small muted description on
 * the left, the fields on a `panel` card on the right. Sections are separated by spacing.
 * `loading` keeps the title and description real and draws `fields` field placeholders in the
 * card (a label slot and a control-height box each) in place of `children`; a section whose data
 * is ready renders for real next to loading ones. Outside a loading page it announces itself.
 */
export function FormSection({
  id,
  title,
  description,
  flush,
  loading,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  /** The card without padding, for content that reaches its edges (a SwitchList). */
  flush?: boolean;
  /** The section's data is not here yet: this many field placeholders replace `children`. */
  loading?: { fields: number };
  children?: ReactNode;
}) {
  const announces = useSkeletonAnnounces();
  return (
    <section
      id={id}
      className="cb-form-section"
      data-part="form-section"
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
        data-flush={flush && !loading ? "true" : undefined}
      >
        {loading ? <LoadingFields count={loading.fields} /> : children}
      </div>
    </section>
  );
}

/**
 * A section whose title and description are not known either (SettingsPage's loading shorthand):
 * the `FormSection` frame with an h2-sized slot for the title and a prose-small slot for the
 * description. What the page does know (`title`, `description`) renders for real.
 */
export function LoadingFormSection({
  fields,
  title,
  description,
}: {
  fields: number;
  title?: string;
  description?: string;
}) {
  const announces = useSkeletonAnnounces();
  return (
    <section
      className="cb-form-section"
      data-part="form-section"
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
      <div className="cb-form-section-fields" data-part="form-card">
        <LoadingFields count={fields} />
      </div>
    </section>
  );
}
