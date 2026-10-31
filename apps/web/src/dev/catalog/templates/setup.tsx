import { Button, Card, ItemList, SetupPage, StepList, Text } from "@capybara-hq/design";

const noop = () => {};

/** T13 Setup: the guided setup layout while the org has no model or no agent (no sidebar). */
export function SetupTemplate() {
  return (
    <SetupPage
      org={{
        name: "示例组织",
        slug: "demo",
        role: "所有者",
        menu: [
          { label: "示例组织", checked: true, onSelect: noop },
          { label: "另一个组织", checked: false, onSelect: noop },
        ],
      }}
      account={{ name: "grant", menu: [{ label: "退出登录", onSelect: noop }] }}
      status={{ context: "grant@demo:~/setup", version: "v0.1.0", timeZone: "UTC+8" }}
      header={{
        path: [{ label: "demo" }, { label: "开始之前" }],
        title: "开始之前",
        description: "还差几步才能开始对话。",
      }}
    >
      <Card title="开始之前" actions={<Text tone="muted">已完成 1 / 3</Text>}>
        <StepList
          inset="card"
          steps={[
            { label: "组织已建好", description: "示例组织", done: true },
            {
              label: "配置模型",
              description: "至少配置一个模型提供方，agent 才能回答。",
              done: false,
              action: <Button variant="primary">去配置</Button>,
            },
            {
              label: "新建 agent",
              description: "agent 决定用哪个模型、能用哪些工具和技能。",
              done: false,
              action: <Button disabled>新建</Button>,
            },
          ]}
        />
      </Card>
      <Card title="可以稍后再做">
        <ItemList
          label="可以稍后再做"
          rows={[
            { id: "members", title: "邀请成员", meta: "设置 · 成员", href: "#" },
            { id: "channels", title: "接入飞书或 Slack", meta: "渠道", href: "#" },
          ]}
        />
      </Card>
    </SetupPage>
  );
}
