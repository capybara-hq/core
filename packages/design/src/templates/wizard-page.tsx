import type { ReactNode } from "react";
import { Icon } from "../icons/icon";
import { useDesignT } from "../provider";
import {
  ActionRow,
  type ActionRowProps,
  Body,
  PageHeader,
  type PageHeaderProps,
} from "../shell/index";

/** T9 向导：Centered + 步骤条 + 始终存在的 ActionRow。 */
export function WizardPage({
  header,
  steps,
  current,
  actionRow,
  children,
}: {
  header: PageHeaderProps;
  steps: string[];
  current: number;
  actionRow: ActionRowProps;
  children?: ReactNode;
}) {
  const t = useDesignT();
  return (
    <div className="cb-template" data-template="WizardPage">
      <PageHeader {...header} />
      <Body layout="centered">
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
        {children}
      </Body>
      <ActionRow {...actionRow} />
    </div>
  );
}
