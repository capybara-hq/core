import {
  Badge,
  BarChart,
  Button,
  Card,
  Grid,
  Kbd,
  Logo,
  Metric,
  Skeleton,
  StatusMark,
  Text,
  Tooltip,
} from "@capybara-hq/design";
import { RUN_TREND } from "../fixtures";
import { Row, Section } from "../frame";

/** spec §2.4 / §3 / §6.5 / §6.8：状态、徽标、快捷键、提示、指标、Logo、图表与文字。 */
export function DisplaySection() {
  return (
    <Section title="状态 Status / 徽标 Badge / 快捷键 Kbd / 指标">
      <Row label="状态（符号 + 颜色 + 文字）">
        <StatusMark status="running" />
        <StatusMark status="success" />
        <StatusMark status="failed" />
        <StatusMark status="waiting" />
        <StatusMark status="queued" />
        <StatusMark status="cancelled" />
      </Row>
      <Row label="Badge · 默认 / 强调 / 计数">
        <Badge>PROD</Badge>
        <Badge tone="accent">NEW</Badge>
        <Badge tone="count">12</Badge>
      </Row>
      <Row label="Kbd / Tooltip">
        <Kbd>⌘K</Kbd>
        <Tooltip content="延迟 400ms 出现">
          <Button size={24} variant="ghost">
            提示 Tooltip：延迟 400ms 出现
          </Button>
        </Tooltip>
      </Row>
      <Row label="指标 · 涨跌">
        <Metric label="24H 运行" value="1,284" delta={{ value: "8.2%", direction: "up" }} />
        <Metric label="P50" value="6.9s" delta={{ value: "1.1s", direction: "down" }} />
        <Metric label="本月成本" value="¥8,412" />
      </Row>
      <Row label="Logo · 2 / 3 / 6 · 主色 / 灰">
        <Logo scale={2} />
        <Logo scale={3} />
        <Logo scale={6} />
        <Logo scale={3} tone="muted" />
        <Logo scale={2} wordmark />
      </Row>
      <Row label="柱状图（失败叠加 · 当前时段主色）">
        <BarChart label="运行趋势" series={RUN_TREND} current={RUN_TREND.length - 1} />
      </Row>
      <Grid columns="form" gap={12}>
        <Text variant="small" tone="muted">
          骨架行（加载，不用转圈）
        </Text>
        <Skeleton rows={3} />
      </Grid>
      <Row label="文字 · 字号">
        <Text variant="h1">H1 20/28 运行记录</Text>
        <Text variant="h2">H2 16/24 执行链路</Text>
        <Text>正文 13/20 中文一字 = 英文两格</Text>
        <Text variant="small">辅助 12/16 表头、帮助文字</Text>
        <Text variant="micro">MICRO 标签</Text>
      </Row>
      <Row label="文字 · 色调">
        <Text>ink</Text>
        <Text tone="muted">muted</Text>
        <Text tone="faint">faint</Text>
        <Text tone="accent">● accent</Text>
        <Text tone="ok">✓ ok</Text>
        <Text tone="warn">‖ warn</Text>
        <Text tone="fail">✗ fail</Text>
      </Row>
      <Row label="卡片 · 默认 / 危险">
        <Grid columns={2}>
          <Card title="执行链路" actions={<Button size={24}>查看全部</Button>}>
            <Text tone="muted">区块头 h2 + 右侧操作</Text>
          </Card>
          <Card title="危险区" tone="danger">
            <Text tone="muted">删除后历史运行记录保留 30 天。</Text>
          </Card>
        </Grid>
      </Row>
    </Section>
  );
}
