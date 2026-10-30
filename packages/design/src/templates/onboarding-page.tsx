import { type Step, StepList } from "../display/step-list";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateHead } from "./frame";

/** T12 first use: a centered checklist on a Single page. */
export function OnboardingPage({ header, steps }: { header: PageHeaderProps; steps: Step[] }) {
  return (
    <div className="cb-template" data-template="OnboardingPage" data-width="full">
      <TemplateHead header={header} width="full" />
      <Body layout="single">
        <StepList steps={steps} />
      </Body>
    </div>
  );
}
