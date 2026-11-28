import {
  KeyValue,
  type LibraryAction,
  LibraryPage,
  type LibraryPageProps,
  ListDetailList,
  type ListDetailListGroup,
  Select,
  Stack,
  Text,
} from "@capybara-hq/design";
import { type ReactNode, useState } from "react";
import { FixtureShell } from "../frame";
import { RefBlock } from "../ref-block";

// T15 Library (spec §5.13): the Files page's template with seeded files. The catalog page runs in
// the fixture shell (its sidebar, the compact floating row); the reference blocks draw the loaded
// and loading states at the 1280 content area, from the same fixture.

const noop = () => {};

type SeedFile = {
  id: string;
  name: string;
  origin: "agent" | "upload";
  agent?: string;
  size: string;
  at: string;
  group: "today" | "week" | "older";
  icon: "file-text" | "image" | "file";
};

const FILES: SeedFile[] = [
  {
    id: "fil_q3",
    name: "2026 第三季度经营分析.pdf",
    origin: "agent",
    agent: "研究助手",
    size: "2.4 MB",
    at: "14:02",
    group: "today",
    icon: "file-text",
  },
  {
    id: "fil_chart",
    name: "渠道转化漏斗.png",
    origin: "agent",
    agent: "数据分析",
    size: "312 KB",
    at: "11:40",
    group: "today",
    icon: "image",
  },
  {
    id: "fil_brief",
    name: "客户访谈纪要.md",
    origin: "upload",
    size: "18 KB",
    at: "周二",
    group: "week",
    icon: "file-text",
  },
  {
    id: "fil_sheet",
    name: "门店销售明细.xlsx",
    origin: "agent",
    agent: "数据分析",
    size: "1.1 MB",
    at: "周一",
    group: "week",
    icon: "file",
  },
  {
    id: "fil_logo",
    name: "品牌标识-横版.svg",
    origin: "upload",
    size: "9 KB",
    at: "11-12",
    group: "older",
    icon: "image",
  },
  {
    id: "fil_contract",
    name: "供应商框架协议（终版）.docx",
    origin: "upload",
    size: "204 KB",
    at: "11-03",
    group: "older",
    icon: "file",
  },
];

const ORIGIN = { agent: "智能体交付", upload: "我上传的" } as const;
const GROUPS: { id: SeedFile["group"]; label: string }[] = [
  { id: "today", label: "今天" },
  { id: "week", label: "本周" },
  { id: "older", label: "更早" },
];

function groupsOf(files: SeedFile[]): ListDetailListGroup[] {
  return GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: files
      .filter((f) => f.group === g.id)
      .map((f) => ({
        id: f.id,
        title: f.name,
        meta: `${f.agent ?? ORIGIN[f.origin]} · ${f.size}`,
        at: f.at,
        icon: f.icon,
      })),
  }));
}

const ACTIONS: LibraryAction[] = [
  { id: "use", label: "在新对话中使用", icon: "square-pen", onSelect: noop },
  { id: "share", label: "分享", icon: "share", onSelect: noop },
  { id: "download", label: "下载", icon: "download", href: "#", download: true },
  { id: "delete", label: "删除", icon: "x", onSelect: noop, menu: true, danger: true },
];

function Preview({ file }: { file: SeedFile }): ReactNode {
  return (
    <Stack gap={12}>
      <Text variant="prose" tone="muted">
        {file.name} 的预览由文件预览插件绘制；这里是目录页的占位内容。
      </Text>
      <KeyValue
        variant="facts"
        rows={[
          { k: "来源", v: ORIGIN[file.origin] },
          ...(file.agent ? [{ k: "智能体", v: file.agent }] : []),
          { k: "大小", v: file.size, mono: true },
          { k: "来自对话", v: "季度复盘" },
          { k: "被引用", v: "3 次", mono: true },
        ]}
      />
    </Stack>
  );
}

function baseProps(
  origin: string,
  setOrigin: (v: string) => void,
  q: string,
  setQ: (v: string) => void,
) {
  return {
    header: {
      path: [{ label: "capybara", href: "/dev/ui" }, { label: "文件" }],
      title: "文件",
      tabs: [
        { id: "all", label: "全部", onSelect: () => setOrigin("all") },
        { id: "agent", label: "智能体交付", onSelect: () => setOrigin("agent") },
        { id: "upload", label: "我上传的", onSelect: () => setOrigin("upload") },
      ],
      activeTab: origin,
      search: { label: "搜索文件", value: q, onChange: setQ },
    },
    actions: [{ label: "上传", icon: "upload", variant: "primary", onSelect: noop }],
    filters: (
      <>
        <Select
          aria-label="智能体"
          value=""
          onChange={noop}
          options={[
            { value: "", label: "全部智能体" },
            { value: "research", label: "研究助手" },
            { value: "data", label: "数据分析" },
          ]}
        />
        <Select
          aria-label="类型"
          value=""
          onChange={noop}
          options={[
            { value: "", label: "全部类型" },
            { value: "document", label: "文档" },
            { value: "image", label: "图片" },
          ]}
        />
      </>
    ),
    usage: "已用 4.0 MB · 6 个文件",
  } satisfies Partial<LibraryPageProps>;
}

function LibraryBody() {
  const [origin, setOrigin] = useState("all");
  const [q, setQ] = useState("");
  const [current, setCurrent] = useState(FILES[0]?.id ?? "");
  const [open, setOpen] = useState(false);
  const shown = FILES.filter(
    (f) => (origin === "all" || f.origin === origin) && (q === "" || f.name.includes(q)),
  );
  const file = shown.find((f) => f.id === current) ?? null;
  return (
    <LibraryPage
      {...baseProps(origin, setOrigin, q, setQ)}
      list={
        <ListDetailList
          label="文件"
          groups={groupsOf(shown)}
          current={file?.id}
          onOpen={(id) => {
            setCurrent(id);
            setOpen(true);
          }}
        />
      }
      detail={file ? <Preview file={file} /> : null}
      {...(file ? { detailTitle: file.name } : {})}
      detailActions={ACTIONS}
      detailEmpty={{ text: "选择一个文件查看预览" }}
      open={open}
      onBack={() => setOpen(false)}
      {...(shown.length === 0
        ? { empty: { text: "没有符合条件的文件", hint: "换个来源或清除搜索再试。" } }
        : {})}
    />
  );
}

/** T15 Files: the person's file library, list and preview. */
export function LibraryTemplate() {
  return (
    <FixtureShell nav="files" title="文件">
      <LibraryBody />
    </FixtureShell>
  );
}

const W = 1280;
const H = 640;

/** The reference blocks of `template-library` (spec §5.13): the loaded page and its loading state. */
export function libraryBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="template-library-default" width={W} height={H}>
        <LibraryBody />
      </RefBlock>
      <RefBlock id="template-library-loading" width={W} height={H}>
        <LibraryPage
          {...baseProps("all", noop, "", noop)}
          list={null}
          detail={null}
          onBack={noop}
          loading={{ rows: FILES.length }}
        />
      </RefBlock>
    </>
  );
}
