import { Button, IconButton, Stack, Text } from "@capybara-hq/design";
import { BUTTON_VARIANTS } from "../fixtures";
import { Row, Section } from "../frame";

/** spec §6.1：每个变体的默认 / 禁用 / 加载态；悬停与按下由截图交互用例覆盖。 */
export function ButtonsSection() {
  return (
    <Section
      title="按钮 Button"
      note="一个视图最多一个 primary；高度 24 / 28 / 36；直角；焦点环 2px 主色、外扩 2px"
    >
      <Row label="变体 \ 状态">
        <Text variant="small" tone="muted">
          默认 · 禁用 · 加载中（悬停 / 按下 / 焦点见交互截图）
        </Text>
      </Row>
      {BUTTON_VARIANTS.map((v) => (
        <Row key={v.variant} label={`${v.name} · ${v.use}`}>
          <Button variant={v.variant}>{v.label}</Button>
          <Button variant={v.variant} disabled>
            {v.label}
          </Button>
          <Button variant={v.variant} loading>
            处理中
          </Button>
        </Row>
      ))}
      <Row label="Danger-solid · 危险确认满足后">
        <Button variant="danger-solid">删除</Button>
      </Row>
      <Row label="尺寸">
        <Button size={24}>24 表格内</Button>
        <Button size={28}>28 默认</Button>
        <Button size={36}>36 页面级</Button>
        <IconButton label="更多操作" icon="⋯" variant="default" />
        <Text variant="small" tone="muted">
          图标按钮为正方形，必须有 aria-label
        </Text>
      </Row>
      <Row label="快捷键提示">
        <Stack direction="row" gap={8}>
          <Button variant="default" shortcut="⌘S">
            保存草稿
          </Button>
          <Button variant="primary" shortcut="↵">
            重新运行
          </Button>
        </Stack>
      </Row>
    </Section>
  );
}
