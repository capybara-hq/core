import { type ReactNode, useEffect } from "react";
import { Text } from "../layout/index";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/**
 * T4 Form: Centered at the form width, no anchor navigation (spec §5.3), and an ActionRow that is
 * always there; unsaved changes guard leaving the page.
 */
export function FormPage({
  header,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  actionRow: ActionRowProps;
  children?: ReactNode;
}) {
  const dirty = (actionRow.unsaved ?? 0) > 0;
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
  return (
    <div className="cb-template" data-template="FormPage" data-width="form">
      <TemplateHead header={header} width="form" />
      <Body layout="centered" width="form">
        {children}
      </Body>
      <ActionRow {...actionRow} />
    </div>
  );
}

/**
 * A form section (spec §5.3): two columns, the title (h2) and a prose-small muted description on
 * the left, the fields on a `panel` card on the right. Sections are separated by spacing.
 */
export function FormSection({
  id,
  title,
  description,
  flush,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  /** The card without padding, for content that reaches its edges (a SwitchList). */
  flush?: boolean;
  children?: ReactNode;
}) {
  return (
    <section id={id} className="cb-form-section" data-part="form-section" aria-label={title}>
      <div className="cb-form-section-head" data-part="form-section-head">
        <Text variant="h2">{title}</Text>
        {description ? <p className="cb-form-section-description">{description}</p> : null}
      </div>
      <div
        className="cb-form-section-fields"
        data-part="form-card"
        data-flush={flush ? "true" : undefined}
      >
        {children}
      </div>
    </section>
  );
}
