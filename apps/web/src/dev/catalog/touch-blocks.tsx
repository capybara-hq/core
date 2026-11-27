import {
  DrawerFrame,
  DrawerLevel,
  FloatingIconButton,
  NavRow,
  Stack,
  Text,
} from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// The touch components' reference blocks (design spec §6.51 FloatingIconButton, §6.52 Drawer,
// §6.53 NavRow): the drawer and the inbox boards of the touch canvas, drawn at a phone's width.
// The blocks are measured in a desktop-pointer window, so the tables hold the base sizes; the
// touch sizes are in the spec's prose and in `touch-rows.test.ts` / `floating-button.test.tsx`.

const PHONE = 390;

const noop = () => {};

function floatingButtonBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="floating-button-default" width={96} height={72} pad>
        <FloatingIconButton icon="menu" label="Menu" onClick={noop} />
      </RefBlock>
      <RefBlock id="floating-button-badge" width={96} height={72} pad>
        <FloatingIconButton
          icon="menu"
          label="Menu, 3 pending"
          badge={{ count: 3 }}
          onClick={noop}
        />
      </RefBlock>
    </>
  );
}

function rows(): ReactNode {
  return (
    <>
      <NavRow icon="search" label="搜索" onSelect={noop} />
      <NavRow icon="inbox" label="收件箱" href="#" badge={{ count: 3 }} />
      <NavRow icon="agent" label="智能体" href="#" />
      <NavRow icon="clock" label="自动化" href="#" />
      <NavRow icon="skills" label="技能、连接器、设备…" trailing="chevron" onSelect={noop} />
    </>
  );
}

const page = (
  <Stack>
    <Text tone="muted">新对话</Text>
  </Stack>
);

function drawerBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="drawer-open" width={PHONE} height={620}>
        <DrawerFrame label="菜单" page={page}>
          {rows()}
        </DrawerFrame>
      </RefBlock>
      <RefBlock id="drawer-level" width={PHONE} height={620}>
        <DrawerFrame label="菜单" page={page}>
          <DrawerLevel title="技能、连接器、设备" backLabel="返回" onBack={noop}>
            <NavRow icon="skills" label="技能" href="#" />
            <NavRow icon="connector" label="连接器" href="#" />
            <NavRow icon="cpu" label="设备" href="#" />
          </DrawerLevel>
        </DrawerFrame>
      </RefBlock>
    </>
  );
}

function navRowBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="nav-row-default" width={320}>
        <NavRow icon="agent" label="智能体" href="#" />
      </RefBlock>
      <RefBlock id="nav-row-current" width={320}>
        <NavRow icon="agent" label="智能体" href="#" current />
      </RefBlock>
      <RefBlock id="nav-row-badge" width={320}>
        <NavRow icon="inbox" label="收件箱" href="#" badge={{ count: 3 }} />
      </RefBlock>
    </>
  );
}

export const TOUCH_BLOCKS = {
  "floating-button": floatingButtonBlocks,
  drawer: drawerBlocks,
  "nav-row": navRowBlocks,
} as const;
