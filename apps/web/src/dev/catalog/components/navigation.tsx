import { Pagination, Segmented, Stack, Tabs } from "@capybara-hq/design";
import { useState } from "react";
import { RUNS_TOTAL, SEGMENTS } from "../fixtures";
import { Row, Section } from "../frame";

const TAB_ITEMS = [
  { id: "runs", label: "运行记录" },
  { id: "config", label: "配置" },
  { id: "versions", label: "版本", count: 12 },
  { id: "permissions", label: "权限", disabled: true },
];

/** spec §6.4：Tabs（按钮 / 链接两种）、Segmented、Pagination。 */
export function NavigationSection() {
  const [tab, setTab] = useState("runs");
  const [seg, setSeg] = useState("24h");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [middle, setMiddle] = useState(13);
  return (
    <Section title="标签页 Tabs / 分段 Segmented / 分页 Pagination">
      <Row label="Tabs · 选中 / 计数 / 禁用">
        <Tabs label="示例标签" items={TAB_ITEMS} value={tab} onChange={setTab} />
      </Row>
      <Row label="Tabs · 链接式">
        <Tabs
          label="示例链接标签"
          value="table"
          items={[
            { id: "components", label: "组件", href: "/dev/ui/components" },
            { id: "table", label: "表格", href: "/dev/ui/table", count: 9 },
            { id: "overlays", label: "浮层", href: "/dev/ui/overlays/dialog" },
            { id: "soon", label: "即将上线", disabled: true },
          ]}
        />
      </Row>
      <Row label="Segmented">
        <Segmented label="时间范围" options={SEGMENTS} value={seg} onChange={setSeg} />
      </Row>
      <Row label="Pagination · 首页 + 每页">
        <Stack>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={RUNS_TOTAL}
            pageSizes={[20, 50, 100]}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        </Stack>
      </Row>
      <Row label="Pagination · 中间页（省略号）">
        <Pagination page={middle} pageSize={50} total={RUNS_TOTAL} onPage={setMiddle} />
      </Row>
      <Row label="Pagination · 空">
        <Pagination page={1} pageSize={50} total={0} onPage={() => {}} />
      </Row>
    </Section>
  );
}
