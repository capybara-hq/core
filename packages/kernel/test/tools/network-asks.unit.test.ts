import type { NetworkBlockedHost } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { NetworkRunState } from "../../src/local-devices/network-grants.js";
import type { UnattendedRun } from "../../src/schedules/unattended.js";
import {
  type ApprovalRecord,
  NETWORK_ASK_CANCELLED_NOTE,
} from "../../src/tools/approvals.service.js";
import {
  allowedAlwaysNote,
  allowedOnceNote,
  clipKept,
  deniedNote,
  localOnlyNote,
  NETWORK_ASK_CLIPPED_NOTE,
  NETWORK_ASK_KEPT_MAX_BYTES,
  planNetworkAsk,
  settledNetworkNotes,
  withNetworkNotes,
} from "../../src/tools/network-asks.js";

/** Pure parts of the network ask (network ask-to-allow spec §6.2, §6.6, §6.8, §8.3). */

const dev = (host: string, port = 443): NetworkBlockedHost => ({ host, port, layer: "device" });
const run = (over: Partial<NetworkRunState> = {}): NetworkRunState => ({
  granted: new Set(),
  refused: new Set(),
  asks: 0,
  pending: false,
  ...over,
});
const owner = {
  features: ["networkReport", "policyOp", "policyOpId"] as const,
  policy: {
    effectiveTier: "strict" as const,
    isolation: "sandbox" as const,
    localhost: "off" as const,
    unixSockets: "off" as const,
    allowedDomains: [],
    remoteGrants: "owner" as const,
  },
};
const attended = { device: { ...owner, features: [...owner.features] }, unattended: null };
const unattended = (mode: "fail" | "wait", trial = false): UnattendedRun => ({
  taskId: "t",
  taskRunId: "tr",
  trial,
  unattendedAsk: mode,
  forbiddenTools: [],
});

describe("note texts (spec §6.6, §8.3)", () => {
  it("are exactly the spec's for one host", () => {
    expect(allowedOnceNote(["files.slack.com"])).toBe(
      "[network] files.slack.com was blocked by this device's network policy. The user allowed it for the rest of this task. Run the command again.",
    );
    expect(allowedAlwaysNote(["files.slack.com"])).toBe(
      "[network] files.slack.com was blocked by this device's network policy. The user allowed it on this device from now on. Run the command again.",
    );
    expect(deniedNote(["files.slack.com"], "not for work")).toBe(
      "[network] files.slack.com was blocked by this device's network policy. The user declined access to files.slack.com. Do not try to reach it another way; continue without it or ask the user. Reason: not for work",
    );
  });

  it("group several hosts on one line", () => {
    expect(allowedOnceNote(["a.com", "b.com"])).toBe(
      "[network] a.com, b.com were blocked by this device's network policy. The user allowed them for the rest of this task. Run the command again.",
    );
  });
});

describe("planNetworkAsk", () => {
  it("asks device-layer hosts, notes the org and address layers, ignores unknown", () => {
    const p = planNetworkAsk(
      [
        dev("files.slack.com"),
        { host: "api.foo.com", port: 443, layer: "org" },
        { host: "10.0.0.5", port: 80, layer: "address" },
        { host: "x.y", port: 1, layer: "unknown" },
        dev("FILES.slack.com."),
      ],
      run(),
      attended,
    );
    expect(p.ask).toEqual([{ host: "files.slack.com", port: 443 }]);
    expect(p.scopes).toEqual(["once", "always"]);
    expect(p.notes).toEqual([
      "[network] api.foo.com is not in the organization's network allowlist. Only an organization admin can add it; the user can ask an admin from the conversation. Continue without it or tell the user.",
      "[network] 10.0.0.5 is a private or local address, which commands can never reach.",
    ]);
    expect(p.missingGrants).toEqual([]);
  });

  it("a device that takes no remote grants: no ask, the allow-it-locally note", () => {
    const p = planNetworkAsk([dev("a.com"), dev("b.com")], run(), {
      device: { ...attended.device, policy: { ...owner.policy, remoteGrants: "off" } },
      unattended: null,
    });
    expect(p.ask).toEqual([]);
    expect(p.notes).toEqual([
      "[network] a.com, b.com were blocked by this device's network policy, and this device does not accept network changes from the conversation. The device owner can allow them locally: capybara-device policy add allowedDomains a.com and capybara-device policy add allowedDomains b.com. Continue without them or tell the user.",
    ]);
    expect(localOnlyNote(["a.com"])).toBe(
      "[network] a.com was blocked by this device's network policy, and this device does not accept network changes from the conversation. The device owner can allow it locally: capybara-device policy add allowedDomains a.com. Continue without it or tell the user.",
    );
  });

  it("a host granted in the run tree but still refused is asked again", () => {
    expect(
      planNetworkAsk([dev("a.com")], run({ granted: new Set(["a.com"]) }), attended).ask,
    ).toEqual([{ host: "a.com", port: 443 }]);
  });

  it("a machine without networkReport (Docker mode) is never asked", () => {
    const p = planNetworkAsk([dev("a.com")], run(), {
      device: { features: ["policyOp", "policyOpId"], policy: owner.policy },
      unattended: null,
    });
    expect(p).toMatchObject({ ask: [], notes: [] });
  });

  it("a program without policyOpId: no ask, no note for the device layer", () => {
    for (const features of [["networkReport"], ["networkReport", "policyOp"]] as const) {
      const p = planNetworkAsk([dev("a.com")], run(), {
        device: { features, policy: owner.policy },
        unattended: null,
      });
      expect(p).toMatchObject({ ask: [], notes: [] });
    }
    expect(planNetworkAsk([dev("a.com")], null, { device: null, unattended: null }).notes).toEqual(
      [],
    );
  });

  it("refused before → denied note; another ask pending; the run's cap", () => {
    expect(planNetworkAsk([dev("a.com")], run({ refused: new Set(["a.com"]) }), attended)).toEqual(
      expect.objectContaining({ ask: [], notes: [deniedNote(["a.com"])] }),
    );
    expect(planNetworkAsk([dev("a.com")], run({ pending: true }), attended).notes).toEqual([
      "[network] a.com was blocked by this device's network policy; another network request is waiting for the user.",
    ]);
    expect(planNetworkAsk([dev("a.com")], run({ asks: 5 }), attended).notes).toEqual([
      "[network] a.com was blocked by this device's network policy. Too many network requests in this task; ask the user to allow the domains on the device page.",
    ]);
    expect(planNetworkAsk([dev("a.com")], run({ asks: 4 }), attended).ask).toHaveLength(1);
  });

  it("unattended fail: no ask, the §8.3 note and missing grants (org layer too)", () => {
    const p = planNetworkAsk(
      [dev("files.slack.com"), { host: "api.foo.com", port: 443, layer: "org" }],
      run(),
      { device: attended.device, unattended: unattended("fail") },
    );
    expect(p.ask).toEqual([]);
    expect(p.notes[0]).toBe(
      "[network] files.slack.com is blocked on this device and this scheduled run cannot ask for network access. The task's owner can add it to the task's approved domains. Continue without it.",
    );
    expect(p.missingGrants).toEqual(["network:files.slack.com", "network:api.foo.com"]);
    // wait mode and trial runs ask
    expect(
      planNetworkAsk([dev("a.com")], run(), {
        device: attended.device,
        unattended: unattended("wait"),
      }).ask,
    ).toHaveLength(1);
    expect(
      planNetworkAsk([dev("a.com")], run(), {
        device: attended.device,
        unattended: unattended("fail", true),
      }).ask,
    ).toHaveLength(1);
  });
});

const rec = (over: Partial<ApprovalRecord>): ApprovalRecord =>
  ({
    status: "pending",
    denyReason: null,
    detail: {
      deviceId: "d",
      hosts: [
        { host: "a.com", port: 443 },
        { host: "b.com", port: 443 },
      ],
      command: "curl",
      description: null,
      result: { content: "out", isError: false },
    },
    ...over,
  }) as ApprovalRecord;

describe("settledNetworkNotes", () => {
  it("pending → null; each outcome's note", () => {
    expect(settledNetworkNotes(rec({}), 24)).toBeNull();
    const d = rec({}).detail;
    if (d === null) throw new Error("detail");
    expect(
      settledNetworkNotes(
        rec({ status: "approved", detail: { ...d, grantedHosts: ["a.com"], outcome: "once" } }),
        24,
      ),
    ).toEqual([allowedOnceNote(["a.com"]), deniedNote(["b.com"])]);
    expect(
      settledNetworkNotes(
        rec({
          status: "approved",
          detail: { ...d, grantedHosts: ["a.com", "b.com"], outcome: "always" },
        }),
        24,
      ),
    ).toEqual([allowedAlwaysNote(["a.com", "b.com"])]);
    expect(
      settledNetworkNotes(
        rec({
          status: "approved",
          detail: { ...d, grantedHosts: ["a.com", "b.com"], outcome: "once_fallback" },
        }),
        24,
      ),
    ).toEqual([allowedOnceNote(["a.com", "b.com"])]);
    // allowed always, but the device refused the policy op: nothing granted
    expect(
      settledNetworkNotes(
        rec({
          status: "approved",
          detail: { ...d, grantedHosts: [], outcome: "refused" as never },
        }),
        24,
      ),
    ).toEqual([
      "[network] a.com, b.com were blocked by this device's network policy. The user allowed them on this device, but the device does not accept network changes from the deployment; access stays blocked. The device owner can allow them locally: capybara-device policy add allowedDomains a.com and capybara-device policy add allowedDomains b.com.",
    ]);
    expect(settledNetworkNotes(rec({ status: "denied", denyReason: "no" }), 24)).toEqual([
      deniedNote(["a.com", "b.com"], "no"),
    ]);
    expect(settledNetworkNotes(rec({ status: "expired" }), 24)).toEqual([
      "[network] a.com, b.com were blocked by this device's network policy. The user did not answer within 24h; access stays blocked.",
    ]);
    expect(settledNetworkNotes(rec({ status: "skipped" }), 24)).toEqual([
      "[network] a.com, b.com were blocked by this device's network policy. The user sent a message instead of answering; access stays blocked.",
    ]);
    expect(settledNetworkNotes(rec({ status: "cancelled" }), 24)).toEqual([
      NETWORK_ASK_CANCELLED_NOTE,
    ]);
  });
});

describe("kept result", () => {
  it("notes follow a blank line; content over 16 KB is clipped with a note", () => {
    expect(withNetworkNotes("out", ["n1", "n2"])).toBe("out\n\nn1\nn2");
    expect(withNetworkNotes("out", [])).toBe("out");
    expect(clipKept("small")).toBe("small");
    const big = "é".repeat(NETWORK_ASK_KEPT_MAX_BYTES);
    const clipped = clipKept(big);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(NETWORK_ASK_KEPT_MAX_BYTES);
    expect(clipped.endsWith(NETWORK_ASK_CLIPPED_NOTE)).toBe(true);
    expect(clipped).not.toContain("�");
  });
});
