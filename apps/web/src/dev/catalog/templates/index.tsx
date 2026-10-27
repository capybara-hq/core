import { ConversationTemplateDemo } from "../conversation-page-blocks";
import type { TemplateRoute } from "../routes";
import { AuthTemplate } from "./auth";
import { DetailTemplate } from "./detail";
import { FormTemplate } from "./form";
import { InboxTemplate } from "./inbox";
import { ListTemplate } from "./list";
import { OnboardingTemplate } from "./onboarding";
import { OverviewTemplate } from "./overview";
import { PlaygroundTemplate } from "./playground";
import { SettingsTemplate } from "./settings";
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
  "templates/playground": PlaygroundTemplate,
  "templates/conversation": ConversationTemplateDemo,
  "templates/trace": TraceTemplate,
  "templates/wizard": WizardTemplate,
  "templates/auth": AuthTemplate,
  "templates/status": StatusTemplate,
  "templates/onboarding": OnboardingTemplate,
};

/** `/dev/ui/templates/*`：12 个页面模板，除认证页外都套在假 App Shell 里。 */
export function TemplateCatalog({ route }: { route: TemplateRoute }) {
  const Template = TEMPLATES[route];
  return <Template />;
}
