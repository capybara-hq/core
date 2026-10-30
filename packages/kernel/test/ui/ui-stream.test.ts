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
const streamsFor = (memberRole: () => Promise<OrgRole | undefined>) =>
  new OrgUiStreams(bus, { role: memberRole }, { get: config }, quiet);

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
    const streams = streamsFor(async () => role);
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
    const streams = streamsFor(async () => role);
    const o = output();
    const h = await streams.open(params, o.out);
    h.begin();
    role = "guest";
    await waitFor(async () => o.ended(), 2_000);
    expect(o.chunks.join("")).toContain('event: error\ndata: {"code":"ui.not_found"}');
    expect(streams.size).toBe(0);
  });
});

describe("OrgUiStreams shutdown", () => {
  it("after closeAll a new stream ends right after its headers", async () => {
    const streams = streamsFor(async () => "member");
    const o = output();
    const first = await streams.open(params, o.out);
    first.begin();
    streams.closeAll();
    expect(o.ended()).toBe(true);
    const late = output();
    const h = await streams.open(params, late.out);
    expect(late.ended()).toBe(false);
    h.begin();
    expect(late.ended()).toBe(true);
    expect(late.chunks).toEqual([]);
    expect(streams.size).toBe(0);
  });
});
