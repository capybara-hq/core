import { Badge, DeviceNameplate, KeycapCommand, ModeScale } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// DeviceNameplate and ModeScale (spec §6.41, §6.42; auto mode design §4): the blocks have the same
// ids and boxes as docs/design/reference/src/device-nameplate.html and mode-scale.html.

const noop = () => {};
const COMMAND = "capybara-device mode auto|sandbox";
const HINT = "在这台机器的终端里运行，切换模式。";

function command(): ReactNode {
  return <KeycapCommand command={COMMAND} hint={HINT} />;
}

function deviceNameplateBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="device-nameplate-cloud" width={640}>
        <DeviceNameplate
          name="staging-builder"
          origin="cloud"
          state="running"
          version="0.4.0"
          lastSeen="2026-11-13T16:21:00Z"
          badge={<Badge>开放（挡内网）</Badge>}
        />
      </RefBlock>
      <RefBlock id="device-nameplate-local" width={640}>
        <DeviceNameplate
          name="设计工作机"
          origin="local"
          state="online"
          version="0.4.0"
          lastSeen="2026-11-13T15:58:00Z"
          badge={<Badge tone="warn">自动</Badge>}
        />
      </RefBlock>
      <RefBlock id="device-nameplate-suspended" width={640}>
        <DeviceNameplate
          name="report-runner"
          origin="cloud"
          state="suspended"
          version="0.4.0"
          lastSeen="2026-11-12T09:04:00Z"
          badge={<Badge>白名单</Badge>}
        />
      </RefBlock>
      <RefBlock id="device-nameplate-offline" width={640}>
        <DeviceNameplate
          name="办公室工作站"
          origin="local"
          state="offline"
          version="0.3.9"
          lastSeen="2026-11-10T18:40:00Z"
          badge={<Badge>沙箱</Badge>}
        />
      </RefBlock>
    </>
  );
}

function modeScaleBlocks(): ReactNode {
  return (
    <>
      <RefBlock id="mode-scale-auto" width={560} pad>
        <ModeScale value="auto" onSelect={noop} command={command()} />
      </RefBlock>
      <RefBlock id="mode-scale-sandbox" width={560} pad>
        <ModeScale value="sandbox" onSelect={noop} command={command()} />
      </RefBlock>
      <RefBlock id="mode-scale-locked" width={560} pad>
        <ModeScale
          value="sandbox"
          locked
          lockedReason="云端设备不能选择模式：组织允许自动模式时运行自动，否则运行沙箱。"
        />
      </RefBlock>
      <RefBlock id="mode-scale-capped" width={560} pad>
        <ModeScale value="sandbox" onSelect={noop} unavailable={{ auto: "组织不允许" }} />
      </RefBlock>
      <RefBlock id="mode-scale-disabled" width={560} pad>
        <ModeScale
          value="auto"
          onSelect={noop}
          disabled
          disabledReason="这台设备离线，暂时不能修改。"
        />
      </RefBlock>
    </>
  );
}

export const DEVICE_BLOCKS = {
  "device-nameplate": deviceNameplateBlocks,
  "mode-scale": modeScaleBlocks,
} as const;
