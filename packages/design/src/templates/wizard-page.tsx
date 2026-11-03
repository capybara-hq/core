import type { ReactNode } from "react";
import { SkeletonGroup, SkeletonText } from "../display/skeleton";
import { Icon } from "../icons/icon";
import { Card, Stack } from "../layout/index";
import { useDesignT } from "../provider";
import { ActionRow, type ActionRowProps, Body, type PageHeaderProps } from "../shell/index";
import {
  type FieldShape,
  LoadingFields,
  loadingActionRow,
  loadingHeader,
  TemplateHead,
} from "./frame";

/**
 * T9 向导：Centered + 步骤条 + 始终存在的 ActionRow. `loading` draws the frame while the wizard's
 * data is on the way (spec §5.5): the header keeps its rows, the step bar is real (the steps are
 * static), the ActionRow stays with its buttons disabled, and the step's body is one card (a
 * title slot, `fields` field placeholders) in place of `children`. One busy announcement.
 */
export function WizardPage({
  header,
  steps,
  current,
  actionRow,
  loading,
  children,
}: {
  header: PageHeaderProps;
  steps: string[];
  current: number;
  actionRow: ActionRowProps;
  loading?: { fields: number | FieldShape[] };
  children?: ReactNode;
}) {
  const t = useDesignT();
  const page = (
    <>
      <TemplateHead header={loading ? loadingHeader(header) : header} loose />
      <Body layout="centered" loose width="content">
        <ol className="cb-steps" aria-label={t("shell.steps")}>
          {steps.map((label, i) => {
            const state = i < current ? "done" : i === current ? "current" : "todo";
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: 静态步骤列表，标签可能重复，需带序号
                key={`${i}-${label}`}
                className="cb-step"
                data-step={i + 1}
                data-state={state}
                {...(state === "current" ? { "aria-current": "step" as const } : {})}
              >
                <span className="cb-step-mark">
                  {state === "done" ? <Icon name="check" size={12} /> : String(i + 1)}
                </span>
                <span className="cb-step-label">{label}</span>
              </li>
            );
          })}
        </ol>
        {loading ? (
          <Card title={<SkeletonText width="30%" />}>
            <Stack gap={16}>
              <LoadingFields fields={loading.fields} />
            </Stack>
          </Card>
        ) : (
          children
        )}
      </Body>
      <ActionRow {...(loading ? loadingActionRow(actionRow) : actionRow)} />
    </>
  );
  return (
    <div className="cb-template" data-template="WizardPage" data-width="content">
      {loading ? (
        <SkeletonGroup label={header.title || t("table.loading")}>{page}</SkeletonGroup>
      ) : (
        page
      )}
    </div>
  );
}
