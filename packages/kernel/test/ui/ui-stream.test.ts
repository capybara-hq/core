import { describe, expect, it } from "vitest";
import type { KernelConfig } from "../../src/config/schema.js";
import type { OrgRole } from "../../src/orgs/roles.js";
import { OrgUiStreams } from "../../src/ui/ui-stream.js";
import { waitFor } from "../helpers/runs.js";

/** 组织级刷新流只给 member 以上（A38，组织页面不给 guest）：建立时与每次复核都按当前角色判定。 */

const config = () =>
  ({ runtime: { sseHeartbeatMs: 60_000, sseRecheckMs: 20 } }) as unknown as KernelConfig;
const bus = { subscribe: async () => async () => {} };
const quiet = { warn() {} };

function output() {
  const chunks: string[] = [];
  let ended = false;
  return {
    chunks,
    ended: () => ended,
    out: {
      write: (c: string) => {
        chunks.push(c);
      },
      backlog: () => 0,
      end: () => {
        ended = true;
      },
      abort: () => {
        ended = true;
      },
    },
  };
}

const params = { orgId: "o1", viewerAccountId: "a1", credential: async () => null };

describe("OrgUiStreams 角色", () => {
  it("guest → ui.not_found；非成员 → org.not_found；member 可以连上", async () => {
    let role: OrgRole | undefined = "guest";
    const streams = new OrgUiStreams({ bus, memberRole: async () => role, config, log: quiet });
    await expect(streams.open(params, output().out)).rejects.toMatchObject({
      code: "ui.not_found",
    });
    role = undefined;
    await expect(streams.open(params, output().out)).rejects.toMatchObject({
      code: "org.not_found",
    });
    role = "member";
    const h = await streams.open(params, output().out);
    expect(streams.size).toBe(1);
    h.close();
  });

  it("连接中被降为 guest：复核时发 event: error（ui.not_found）并关闭", async () => {
    let role: OrgRole | undefined = "admin";
    const streams = new OrgUiStreams({ bus, memberRole: async () => role, config, log: quiet });
    const o = output();
    const h = await streams.open(params, o.out);
    h.begin();
    role = "guest";
    await waitFor(async () => o.ended(), 2_000);
    expect(o.chunks.join("")).toContain('event: error\ndata: {"code":"ui.not_found"}');
    expect(streams.size).toBe(0);
  });
});
