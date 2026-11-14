import { Badge, DeviceNameplate } from "@capybara-hq/design";
import type { ReactNode } from "react";
import { RefBlock } from "./ref-block";

// DeviceNameplate (spec §6.41; auto mode design §4): the blocks have the same ids and boxes as
// docs/design/reference/src/device-nameplate.html.

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
          created="2026-11-01T09:12:00Z"
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
          created="2026-11-02T10:04:00Z"
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
          created="2026-10-28T14:35:00Z"
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
          created="2026-10-20T08:50:00Z"
          badge={<Badge>沙箱</Badge>}
        />
      </RefBlock>
    </>
  );
}

export const DEVICE_BLOCKS = {
  "device-nameplate": deviceNameplateBlocks,
} as const;
