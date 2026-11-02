import {
  Button,
  Card,
  ItemList,
  OverviewPage,
  SetupPage,
  type SetupPageProps,
  StepList,
  Text,
} from "@capybara-hq/design";
import { FIXTURE_USER, ORG_SWITCHER_FIXTURE, STATUS_FIXTURE } from "@capybara-hq/design/fixtures";
import { setupStepsFixture } from "../shell-fixture";

const noop = () => {};
const stay = () => "/dev/ui/templates/setup";

/** The setup home (web-SSR spec §4): its own page head, the checklist, the later items. */
export function SetupHomeBody() {
  return (
    <OverviewPage
      header={{
        path: [{ label: ORG_SWITCHER_FIXTURE.slug }, { label: "开始之前" }],
        title: "开始之前",
        description: "还差几步才能开始对话。",
      }}
    >
      <Card title="开始之前" actions={<Text tone="muted">已完成 1 / 2</Text>}>
        <StepList
          inset="card"
          steps={[
            {
              label: "配置模型",
              description: "至少配置一个模型提供方，agent 才能回答。",
              done: true,
            },
            {
              label: "新建 agent",
              description: "agent 决定用哪个模型、能用哪些工具和技能。",
              done: false,
              action: <Button variant="primary">新建</Button>,
            },
          ]}
        />
      </Card>
      <Card title="可以稍后再做">
        <ItemList
          label="可以稍后再做"
          rows={[
            { id: "channels", title: "连接渠道", meta: "渠道", href: stay() },
            { id: "members", title: "邀请成员", meta: "设置 · 成员", href: stay() },
          ]}
        />
      </Card>
    </OverviewPage>
  );
}

/** The setup frame's props from the shared fixtures (`who`: whose steps). */
export function setupFrameProps(
  href: (id: string) => string,
  who: "admin" | "member" = "admin",
  activeNav = "home",
): Omit<SetupPageProps, "children"> {
  return {
    sidebar: {
      org: {
        ...ORG_SWITCHER_FIXTURE,
        menu: [
          { label: ORG_SWITCHER_FIXTURE.name, checked: true, onSelect: noop },
          { label: "另一个组织", checked: false, onSelect: noop },
        ],
      },
      home: { href: href("home") },
      steps: setupStepsFixture(who, href),
      activeNav,
      account: { name: FIXTURE_USER.name, menu: [{ label: "退出登录", onSelect: noop }] },
      ...(who === "admin" ? { adminHref: href("admin") } : {}),
    },
    status: {
      context: `${FIXTURE_USER.name}@${ORG_SWITCHER_FIXTURE.slug}:~/setup`,
      version: STATUS_FIXTURE.version,
      timeZone: STATUS_FIXTURE.timeZone,
    },
  };
}

/**
 * T13 Setup: the guided setup layout while the org has no model or no agent: the shell's geometry
 * with the setup sidebar (the steps are its navigation) and the setup home as the page.
 */
export function SetupTemplate() {
  return (
    <SetupPage {...setupFrameProps(stay)}>
      <SetupHomeBody />
    </SetupPage>
  );
}
