import { Button, OnboardingPage } from "@capybara-hq/design";
import { FixtureShell } from "../frame";

/** T12 首次使用：新组织清单。 */
export function OnboardingTemplate() {
  return (
    <FixtureShell nav="overview" context="onboarding">
      <OnboardingPage
        header={{ path: [{ label: "capybara" }, { label: "start" }], title: "开始使用" }}
        steps={[
          { label: "新建组织", description: "示例组织 · 生产环境", done: true },
          { label: "接入模型", description: "Anthropic · claude-opus-5-5", done: true },
          {
            label: "创建第一个智能体",
            description: "从模板开始，或导入 YAML",
            done: false,
            action: <Button variant="primary">+ 新建智能体</Button>,
          },
          {
            label: "邀请成员",
            description: "成员可按角色查看或编辑智能体",
            done: false,
            action: <Button>邀请</Button>,
          },
        ]}
      />
    </FixtureShell>
  );
}
