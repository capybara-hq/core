import { type ReactNode, useEffect } from "react";
import { Grid, Text } from "../layout/index.js";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  PageHeader,
  type PageHeaderProps,
} from "../shell/index.js";

/** T4 表单：Centered + 始终存在的 ActionRow；有未保存改动时拦截离开页面。 */
export function FormPage({
  header,
  anchors,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  anchors: { id: string; label: string; error?: boolean }[];
  actionRow: ActionRowProps;
  children?: ReactNode;
}) {
  const dirty = (actionRow.unsaved ?? 0) > 0;
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  return (
    <div className="cb-template" data-template="FormPage">
      <PageHeader {...header} />
      <Body layout="centered" anchors={anchors}>
        {children}
      </Body>
      <ActionRow {...actionRow} />
    </div>
  );
}

/** 表单分组：左为组标题 + 说明，右为字段（spec §5.3）。 */
export function FormSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <section id={id} className="cb-form-section">
      <Grid columns="form" gap={24}>
        <div className="cb-form-section-head">
          <Text variant="h2">{title}</Text>
          {description ? (
            <Text variant="small" tone="muted">
              {description}
            </Text>
          ) : null}
        </div>
        <div className="cb-form-section-fields">{children}</div>
      </Grid>
    </section>
  );
}
