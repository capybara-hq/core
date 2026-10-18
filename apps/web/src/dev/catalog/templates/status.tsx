import { Button, StatusPage } from "@capybara-hq/design";
import { FixtureShell } from "../frame";

/** T11 系统状态：404。 */
export function StatusTemplate() {
  return (
    <FixtureShell nav="" context="agents/unknown">
      <StatusPage
        header={{ title: "页面不存在" }}
        kind="404"
        title="页面不存在"
        description="链接可能已失效，或该 Agent 已被删除。"
        action={<Button variant="primary">返回概览</Button>}
      />
    </FixtureShell>
  );
}
