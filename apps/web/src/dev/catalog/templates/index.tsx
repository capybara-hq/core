import { ConversationTemplateDemo } from "../conversation-page-blocks";
import type { TemplateRoute } from "../routes";
import { AuthTemplate } from "./auth";
import { DetailTemplate } from "./detail";
import { FormTemplate } from "./form";
import { InboxTemplate } from "./inbox";
import { ListTemplate } from "./list";
import { OnboardingTemplate } from "./onboarding";
import { OverviewTemplate } from "./overview";
import { SettingsTemplate } from "./settings";
import { SetupTemplate } from "./setup";
import { SharedFileTemplate } from "./shared-file";
import { StatusTemplate } from "./status";
import { TraceTemplate } from "./trace";
import { WizardTemplate } from "./wizard";

const TEMPLATES: Record<TemplateRoute, () => React.JSX.Element> = {
  "templates/overview": OverviewTemplate,
  "templates/list": ListTemplate,
  "templates/detail": DetailTemplate,
  "templates/form": FormTemplate,
  "templates/settings": SettingsTemplate,
  "templates/inbox": InboxTemplate,
  "templates/conversation": ConversationTemplateDemo,
  "templates/trace": TraceTemplate,
  "templates/wizard": WizardTemplate,
  "templates/auth": AuthTemplate,
  "templates/status": StatusTemplate,
  "templates/onboarding": OnboardingTemplate,
  "templates/setup": SetupTemplate,
  "templates/shared-file": SharedFileTemplate,
};

/** `/dev/ui/templates/*`: the 14 page templates, all but the auth and shared file pages in a fake App Shell. */
export function TemplateCatalog({ route }: { route: TemplateRoute }) {
  const Template = TEMPLATES[route];
  return <Template />;
}
