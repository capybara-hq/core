import { type Step, StepList } from "../display/step-list";
import { Body, type PageHeaderProps } from "../shell/index";
import { TemplateFrame, TemplateHead } from "./frame";

/**
 * T12 first use: a centered checklist on a Single page. On compact a step's action takes its own
 * full-width line under the step's text (`data-stack`, responsive system spec §3.5).
 */
export function OnboardingPage({ header, steps }: { header: PageHeaderProps; steps: Step[] }) {
  return (
    <TemplateFrame template="OnboardingPage">
      <TemplateHead header={header} statsInHead />
      <Body layout="single" width="content">
        <div className="cb-onboarding-steps" data-part="onboarding-steps" data-stack="true">
          <StepList steps={steps} />
        </div>
      </Body>
    </TemplateFrame>
  );
}
