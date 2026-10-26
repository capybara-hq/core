import {
  Button,
  Checkbox,
  CommandPalette,
  DangerConfirm,
  Dialog,
  Grid,
  Icon,
  IconButton,
  Input,
  Menu,
  Popover,
  Sheet,
  Stack,
  StatusMark,
  Tabs,
  Text,
  useToast,
} from "@capybara-hq/design";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { COMMANDS, RERUN_IDS, RUN_MENU, SHEET_PROPS, STATUS_FILTERS } from "./fixtures";
import { CatalogPage, Row, Section } from "./frame";
import type { OverlayRoute } from "./routes";

const noop = () => {};

/** 浮层下方的「页面内容」与重新打开按钮。 */
function Backdrop({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen?: () => void;
  children?: ReactNode;
}) {
  return (
    <CatalogPage
      title="浮层 Overlays"
      subtitle="对话框 · 危险确认 · Sheet · 菜单 · Popover · 命令面板 · Toast"
    >
      <Section title={label}>
        <Text tone="muted">运行记录 · 1,284 ……（页面内容）</Text>
        {children}
        {onOpen ? (
          <Stack direction="row">
            <Button onClick={onOpen}>重新打开</Button>
          </Stack>
        ) : null}
      </Section>
    </CatalogPage>
  );
}

function DialogDemo() {
  const [open, setOpen] = useState(true);
  const [latest, setLatest] = useState(true);
  return (
    <Backdrop
      label="对话框 Dialog — 宽 480 / 640；遮罩；Esc 关闭；焦点锁定；主操作在右"
      onOpen={() => setOpen(true)}
    >
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="重新运行 3 个任务？"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button variant="primary" shortcut="↵" onClick={() => setOpen(false)}>
              重新运行
            </Button>
          </>
        }
      >
        <Stack gap={12}>
          <Text>将以相同输入重新触发以下运行，预计消耗约 43,000 tokens。</Text>
          <Text variant="small" tone="muted">
            {RERUN_IDS}
          </Text>
          <Checkbox checked={latest} onChange={setLatest} label="使用最新的 Agent 版本" />
        </Stack>
      </Dialog>
    </Backdrop>
  );
}

function DangerDemo() {
  const [open, setOpen] = useState(true);
  return (
    <Backdrop
      label="危险确认 — 输入名称才可执行；匹配后按钮变为实心 fail 色"
      onOpen={() => setOpen(true)}
    >
      <DangerConfirm
        open={open}
        onOpenChange={setOpen}
        title="删除 Agent"
        description="此操作不可撤销。历史运行记录保留 30 天。"
        confirmName="support-triage"
        confirmLabel="删除"
        onConfirm={() => setOpen(false)}
      />
    </Backdrop>
  );
}

function SheetDemo() {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState("summary");
  return (
    <Backdrop
      label="Sheet — 右侧滑出，宽 480 / 720；不加遮罩时列表仍可操作"
      onOpen={() => setOpen(true)}
    >
      <Text tone="muted">列表 ……</Text>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="support-triage"
        meta="v12"
        openHref="/dev/ui/templates/detail"
        tabs={
          <Tabs
            label="support-triage"
            value={tab}
            onChange={setTab}
            items={[
              { id: "summary", label: "概要" },
              { id: "config", label: "配置" },
              { id: "runs", label: "运行" },
              { id: "versions", label: "版本" },
            ]}
          />
        }
        footer={
          <>
            <Button>编辑</Button>
            <Button variant="secondary">试运行</Button>
          </>
        }
      >
        <Grid columns={2} gap={8}>
          <Text tone="muted">状态</Text>
          <StatusMark status="success" label="已发布" />
          {SHEET_PROPS.map(([k, v]) => (
            <SheetProp key={k} k={k} v={v} />
          ))}
        </Grid>
      </Sheet>
    </Backdrop>
  );
}

function SheetProp({ k, v }: { k: string; v: string }) {
  return (
    <>
      <Text tone="muted">{k}</Text>
      <Text truncate>{v}</Text>
    </>
  );
}

function MenuDemo() {
  const [on, setOn] = useState<Set<string>>(
    () => new Set(STATUS_FILTERS.filter((f) => f.on).map((f) => f.status)),
  );
  const toggle = (s: string) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  return (
    <CatalogPage title="浮层 Overlays" subtitle="菜单 Menu · 筛选 Popover（截图前由用例点开）">
      <Section title="行内菜单 Menu" note="≤5 项，危险项置底并以分隔线隔开">
        <Row label="行菜单触发">
          <Menu
            items={RUN_MENU}
            trigger={
              <IconButton
                label="行操作"
                icon={<Icon name="more-horizontal" size={14} />}
                density="dense"
              />
            }
          />
        </Row>
      </Section>
      <Section title="筛选 Popover" note="多选 + 应用；打开且有值时触发按钮描边主色">
        <Row label="触发">
          <Popover
            active={on.size > 0}
            trigger={
              <Button density="dense">
                {`状态: ${on.size} 项`}
                <Icon name="chevron-down" size={14} />
              </Button>
            }
          >
            <Stack gap={8}>
              <Input aria-label="筛选状态" placeholder="筛选状态" prefix=">" />
              {STATUS_FILTERS.map((f) => (
                <Stack key={f.status} direction="row" justify="between" align="center">
                  <Checkbox
                    checked={on.has(f.status)}
                    onChange={() => toggle(f.status)}
                    label={<StatusMark status={f.status} label={f.label} />}
                  />
                  <Text variant="small" tone="faint">
                    {f.count.toLocaleString("en-US")}
                  </Text>
                </Stack>
              ))}
              <Stack direction="row" justify="between">
                <Button density="dense" variant="ghost" onClick={() => setOn(new Set())}>
                  清除
                </Button>
                <Button density="dense" variant="primary" shortcut="↵">
                  应用
                </Button>
              </Stack>
            </Stack>
          </Popover>
        </Row>
      </Section>
    </CatalogPage>
  );
}

function CommandDemo() {
  const [open, setOpen] = useState(true);
  return (
    <Backdrop label="命令面板 ⌘K" onOpen={() => setOpen(true)}>
      <CommandPalette open={open} onOpenChange={setOpen} groups={COMMANDS} />
    </Backdrop>
  );
}

function ToastDemo() {
  const toast = useToast();
  const fired = useRef(false);
  const fire = () => {
    toast.success("已复制 run_8f2jh8");
    toast.progress("正在重新运行 3 个任务", { done: 2, total: 3 });
    toast.error("终止失败：运行已结束", { actionLabel: "查看运行", onAction: noop });
  };
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    fire();
  });
  return <Backdrop label="Toast — 右下堆叠；4s 消失；错误需手动关" onOpen={fire} />;
}

/** `/dev/ui/overlays/*`：每条路由打开一种浮层。 */
export function OverlayCatalog({ route }: { route: OverlayRoute }) {
  switch (route) {
    case "overlays/dialog":
      return <DialogDemo />;
    case "overlays/danger":
      return <DangerDemo />;
    case "overlays/sheet":
      return <SheetDemo />;
    case "overlays/menu":
      return <MenuDemo />;
    case "overlays/command":
      return <CommandDemo />;
    case "overlays/toast":
      return <ToastDemo />;
  }
}
