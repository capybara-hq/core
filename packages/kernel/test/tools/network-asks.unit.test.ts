import type { NetworkBlockedHost } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { NetworkRunState } from "../../src/sandbox/network-grants.js";
import {
  ESCALATION_UNATTENDED_WHY,
  escalationDeviceOffWhy,
} from "../../src/sandbox/review/permission-candidate.js";
import { networkGrantRefusal } from "../../src/schedules/grant-rules.js";
import type { UnattendedRun } from "../../src/schedules/unattended.js";
import {
  type ApprovalRecord,
  NETWORK_ASK_CANCELLED_NOTE,
} from "../../src/tools/approvals.service.js";
import {
  addedToDeviceNote,
  addressEscalationHint,
  allowedOnceNote,
  clipKept,
  deniedNote,
  deviceAskTerms,
  NETWORK_ASK_CLIPPED_NOTE,
  NETWORK_ASK_KEPT_MAX_BYTES,
  type NetworkAskOffer,
  networkAskOffer,
  onListNote,
  planNetworkAsk,
  settledNetworkNotes,
  withNetworkNotes,
} from "../../src/tools/network-asks.js";

const ESCALATION_DEVICE_OFF_WHY = escalationDeviceOffWhy(null);

/** Pure parts of the network ask (network ask-to-allow spec §6.2, §6.6, §6.8, §8.3). */

const dev = (host: string, port = 443): NetworkBlockedHost => ({ host, port, layer: "device" });
const run = (over: Partial<NetworkRunState> = {}): NetworkRunState => ({
  granted: new Set(),
  refused: new Set(),
  asks: 0,
  pending: false,
  ...over,
});
/** What a per-operation device offers for a host it cannot add to its own list. */
const OFFER: NetworkAskOffer = { scopes: ["once"], appliesAt: "next-command" };
const RUN = null;
/** An attended run on a device with something to offer. */
const attended = { offer: () => OFFER, unattended: null };
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

describe("networkAskOffer (device-provider spec §6.3)", () => {
  it("per-operation hosts: once and always, applies from the next command", () => {
    expect(networkAskOffer({ perOperationHosts: true }, undefined, true)).toEqual({
      scopes: ["once", "always"],
      appliesAt: "next-command",
    });
    expect(networkAskOffer({ perOperationHosts: true }, undefined, false)).toEqual({
      scopes: ["once"],
      appliesAt: "next-command",
    });
    // the provider's limitsApplyAt never matters with per-operation hosts
    expect(networkAskOffer({ perOperationHosts: true }, "fileSystem", true)).toEqual({
      scopes: ["once", "always"],
      appliesAt: "next-command",
    });
  });

  it("instance boundary: always only, next use or files reset; nothing when not addable", () => {
    expect(networkAskOffer({ perOperationHosts: false }, "instance", true)).toEqual({
      scopes: ["always"],
      appliesAt: "next-use",
    });
    expect(networkAskOffer({ perOperationHosts: false }, undefined, true)).toEqual({
      scopes: ["always"],
      appliesAt: "next-use",
    });
    expect(networkAskOffer({ perOperationHosts: false }, "fileSystem", true)).toEqual({
      scopes: ["always"],
      appliesAt: "files-reset",
    });
    expect(networkAskOffer({ perOperationHosts: false }, "instance", false)).toBeNull();
  });
});

describe("deviceAskTerms: what a device's sandbox lets an ask offer", () => {
  const outsideOrg = "an organization admin adds x.dev to the organization's device network list";
  const facts = (over: Partial<Parameters<typeof deviceAskTerms>[0]> = {}) => ({
    refusal: () => null,
    // x.dev is outside the org's effective hosts: never on the device's own list
    listAddRefusal: (h: string) => (h === "x.dev" ? outsideOrg : null),
    box: { perCallHosts: false },
    ownList: true,
    ownHosts: ["a.dev", "*.added.dev"],
    limitsApplyAt: "fileSystem" as const,
    ...over,
  });

  it("a host outside the org's effective hosts is never offered add to this device's list", () => {
    // list-only: the host is unavailable (its note names who adds it), never asked
    const listOnly = planNetworkAsk([dev("x.dev"), dev("b.dev")], run(), {
      unattended: null,
      ...deviceAskTerms(facts()),
    });
    expect(listOnly.ask).toEqual([{ host: "b.dev", port: 443 }]);
    expect(listOnly.offer).toEqual({ scopes: ["always"], appliesAt: "files-reset" });
    expect(listOnly.notes).toEqual([
      `[network] x.dev was blocked by this device's network policy and cannot be allowed from this conversation: ${outsideOrg}. Continue without it or tell the user.`,
    ]);
    // per-operation hosts: a run grant for it, never the device's list
    const perOp = planNetworkAsk([dev("x.dev"), dev("b.dev")], run(), {
      unattended: null,
      ...deviceAskTerms(facts({ box: { perCallHosts: true } })),
    });
    expect(perOp.ask.map((a) => a.host)).toEqual(["x.dev", "b.dev"]);
    expect(perOp.offer).toEqual({ scopes: ["once"], appliesAt: "next-command" });
    expect(deviceAskTerms(facts({ box: { perCallHosts: true } })).offer(["b.dev"])).toEqual({
      scopes: ["once", "always"],
      appliesAt: "next-command",
    });
  });

  it("no list of its own: never always (a per-operation device keeps once, a list-only one nothing)", () => {
    expect(
      deviceAskTerms(facts({ ownList: false, box: { perCallHosts: true } })).offer(["b.dev"]),
    ).toEqual({ scopes: ["once"], appliesAt: "next-command" });
    expect(deviceAskTerms(facts({ ownList: false })).offer(["b.dev"])).toBeNull();
    // an instance provider applies at the next use
    expect(deviceAskTerms(facts({ limitsApplyAt: "instance" })).offer(["b.dev"])).toEqual({
      scopes: ["always"],
      appliesAt: "next-use",
    });
  });

  it("a host already on the device's own list is not asked again: a note says when it applies", () => {
    const p = planNetworkAsk([dev("a.dev"), dev("x.added.dev"), dev("b.dev")], run(), {
      unattended: null,
      ...deviceAskTerms(facts()),
    });
    expect(p.ask).toEqual([{ host: "b.dev", port: 443 }]);
    expect(p.notes).toEqual([
      "[network] a.dev, x.added.dev were blocked by this device's network policy. a.dev, x.added.dev are already on this device's network list; it applies after the files are rebuilt. Continue without them until then or tell the user.",
    ]);
    expect(onListNote(["a.dev"], "next-use")).toBe(
      "[network] a.dev was blocked by this device's network policy. a.dev is already on this device's network list; it applies the next time the device is used. Continue without it until then or tell the user.",
    );
    expect(deviceAskTerms(facts({ limitsApplyAt: "instance" })).onList("a.dev")).toBe("next-use");
    expect(deviceAskTerms(facts({ box: { perCallHosts: true } })).onList("a.dev")).toBe(
      "next-command",
    );
    // a device following its org's hosts has no own list to name it
    expect(deviceAskTerms(facts({ ownList: false })).onList("a.dev")).toBeNull();
    expect(deviceAskTerms(facts()).onList("added.dev")).toBeNull();
  });

  it("a per-call grant refusal decides with per-operation hosts; the list refusal without", () => {
    const grant = "an organization admin adds b.dev to the organization's device network list";
    const f = facts({ refusal: (h) => (h === "b.dev" ? grant : null) });
    expect(deviceAskTerms({ ...f, box: { perCallHosts: true } }).refusal("b.dev")).toBe(grant);
    expect(deviceAskTerms(f).refusal("b.dev")).toBeNull();
    expect(deviceAskTerms(f).refusal("x.dev")).toBe(outsideOrg);
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
    // a run grant only: no "always" remnant in the plan
    expect(p).not.toHaveProperty("scopes");
    expect(p.notes).toEqual([
      "[network] api.foo.com is not in the organization's network allowlist. Only an organization admin can add it; the user can ask an admin from the conversation. Continue without it or tell the user.",
      "[network] 10.0.0.5 is a private or local address. Private and local addresses are closed inside the sandbox; only a command run outside the sandbox reaches it.",
    ]);
    expect(p.missingGrants).toEqual([]);
  });

  it("a host a per-call grant cannot reach on this device is not asked: added to the device's list", () => {
    const why =
      "a host cannot be granted per call on this device; add a.com to the device's network list";
    const p = planNetworkAsk([dev("a.com"), dev("b.com")], run(), {
      ...attended,
      refusal: (h) => (h === "a.com" ? why : null),
    });
    expect(p.ask).toEqual([{ host: "b.com", port: 443 }]);
    expect(p.notes).toEqual([
      `[network] a.com was blocked by this device's network policy and cannot be allowed from this conversation: ${why}. Continue without it or tell the user.`,
    ]);
  });

  it("a host beyond an org or platform allowlist ceiling names the organization admin, never asked", () => {
    const why = "an organization admin adds c.com to the organization's device network list";
    for (const layer of ["device", "org"] as const) {
      const p = planNetworkAsk([{ host: "c.com", port: 443, layer }], run(), {
        ...attended,
        refusal: () => why,
      });
      expect(p.ask).toEqual([]);
      expect(p.notes).toEqual([
        `[network] c.com was blocked by this device's network policy and cannot be allowed from this conversation: ${why}. Continue without it or tell the user.`,
      ]);
    }
  });

  it("the escalation hint follows admission's verdict and the open network only", () => {
    expect(addressEscalationHint("available", "open")).toBe(true);
    // a withheld runtime (or any escalation refusal): admission gives no `available`
    expect(addressEscalationHint(undefined, "open")).toBe(false);
    // an already escalated call has nothing to retry with
    expect(addressEscalationHint("escalated", "open")).toBe(false);
    // under an allowlist or a closed network a host grant (or nothing) is the remedy
    expect(addressEscalationHint("available", "allowlist")).toBe(false);
    expect(addressEscalationHint("available", "none")).toBe(false);
  });

  it("a private address under the open network gets the escalation hint, never an ask", () => {
    const blocked = [{ host: "10.0.0.5", port: 80, layer: "address" as const }];
    const p = planNetworkAsk(blocked, run(), { ...attended, escalation: true });
    expect(p.ask).toEqual([]);
    expect(p.notes).toEqual([
      '[network] 10.0.0.5 is a private or local address, which the sandbox never reaches. If the command must reach it, retry the same Bash call with sandbox: "escalated" and justification: one sentence saying why; this conversation\'s permission profile decides whether it may run outside the sandbox for this call only.',
    ]);
    // an unattended run cannot escalate: the plain note
    expect(
      planNetworkAsk(blocked, run(), {
        offer: () => OFFER,
        unattended: unattended("wait"),
        escalation: true,
      }).notes,
    ).toEqual([
      `[network] 10.0.0.5 is a private or local address. Private and local addresses are closed inside the sandbox; only a command run outside the sandbox reaches it, but ${ESCALATION_UNATTENDED_WHY}. Continue without it or tell the user.`,
    ]);
  });

  // R3 Mac dogfood: "commands can never reach" was untrue where the device's owner (or an admin)
  // can allow running outside the sandbox; the note now names who
  it("a private address where running outside the sandbox is off names who turns it on", () => {
    const blocked = [
      { host: "10.0.0.5", port: 80, layer: "address" as const },
      { host: "192.168.3.1", port: 80, layer: "address" as const },
    ];
    expect(
      planNetworkAsk(blocked, run(), { ...attended, escalationRefusal: ESCALATION_DEVICE_OFF_WHY })
        .notes,
    ).toEqual([
      `[network] 10.0.0.5, 192.168.3.1 are private or local addresses. Private and local addresses are closed inside the sandbox; only a command run outside the sandbox reaches them, but ${ESCALATION_DEVICE_OFF_WHY}. Continue without them or tell the user.`,
    ]);
  });

  it("an org-layer host beyond the platform ceiling names the super admin, not the org admins", () => {
    const p = planNetworkAsk(
      [
        { host: "api.foo.com", port: 443, layer: "org" },
        { host: "pypi.org", port: 443, layer: "org" },
      ],
      run(),
      { ...attended, outsideCeiling: (h) => h === "api.foo.com" },
    );
    expect(p.ask).toEqual([]);
    expect(p.notes).toEqual([
      "[network] pypi.org is not in the organization's network allowlist. Only an organization admin can add it; the user can ask an admin from the conversation. Continue without it or tell the user.",
      "[network] api.foo.com is not in the platform's network allowlist, which limits this organization. Only a super admin can add it; organization admins cannot. Continue without it or tell the user.",
    ]);
  });

  it("a scheduled task's grant of a host beyond the ceiling names the super admin", () => {
    const limits = { network: { kind: "allowlist" as const, hosts: [] } };
    expect(
      networkGrantRefusal("api.foo.com", { limits, outsideCeiling: () => true })?.message,
    ).toBe(
      "api.foo.com is not in the platform's network allowlist, which limits this organization; only a super admin can add it",
    );
    expect(networkGrantRefusal("api.foo.com", { limits })?.message).toMatch(
      /only an organization admin can add it$/,
    );
  });

  it("a host granted in the run tree but still refused is asked again", () => {
    expect(
      planNetworkAsk([dev("a.com")], run({ granted: new Set(["a.com"]) }), attended).ask,
    ).toEqual([{ host: "a.com", port: 443 }]);
  });

  it("a device-layer block is asked without any machine feature", () => {
    const plan = planNetworkAsk([{ host: "a.dev", port: 443, layer: "device" }], RUN, {
      offer: () => OFFER,
      unattended: null,
    });
    expect(plan.ask).toEqual([{ host: "a.dev", port: 443 }]);
    expect(plan.offer).toEqual(OFFER);
  });

  it("the offer is computed for the hosts asked, after the unavailable ones left", () => {
    const seen: string[][] = [];
    const p = planNetworkAsk([dev("a.dev"), dev("b.dev")], run(), {
      unattended: null,
      refusal: (h) => (h === "a.dev" ? "an organization admin adds a.dev" : null),
      offer: (hosts) => {
        seen.push(hosts);
        return OFFER;
      },
    });
    expect(seen).toEqual([["b.dev"]]);
    expect(p.ask).toEqual([{ host: "b.dev", port: 443 }]);
  });

  it("nothing to offer (a list-only device with no own list): an unavailable note, no ask", () => {
    const p = planNetworkAsk([dev("a.dev")], run(), { unattended: null, offer: () => null });
    expect(p.ask).toEqual([]);
    expect(p).not.toHaveProperty("offer");
    expect(p.notes).toEqual([
      "[network] a.dev was blocked by this device's network policy and cannot be allowed from this conversation: the device's owner changes the device's network on its page. Continue without it or tell the user.",
    ]);
    // without an offer (no device sandbox known) a device-layer host is left to the trailer
    expect(planNetworkAsk([dev("a.dev")], null, { unattended: null })).toMatchObject({
      ask: [],
      notes: [],
    });
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
      { offer: () => OFFER, unattended: unattended("fail") },
    );
    expect(p.ask).toEqual([]);
    expect(p.notes[0]).toBe(
      "[network] files.slack.com is blocked on this device and this scheduled run cannot ask for network access. The task's owner can add it to the task's approved domains. Continue without it.",
    );
    expect(p.missingGrants).toEqual(["network:files.slack.com", "network:api.foo.com"]);
    // wait mode and trial runs ask
    expect(
      planNetworkAsk([dev("a.com")], run(), {
        offer: () => OFFER,
        unattended: unattended("wait"),
      }).ask,
    ).toHaveLength(1);
    expect(
      planNetworkAsk([dev("a.com")], run(), {
        offer: () => OFFER,
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
      appliesAt: "next-command",
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
        rec({ status: "approved", detail: { ...d, grantedHosts: ["a.com", "b.com"] } }),
        24,
      ),
    ).toEqual([allowedOnceNote(["a.com", "b.com"])]);
    // "add to this device's list": the hosts were added, said when they apply; never run again
    expect(
      settledNetworkNotes(
        rec({
          status: "approved",
          scope: "always",
          detail: { ...d, appliesAt: "files-reset", grantedHosts: ["a.com"], outcome: "always" },
        }),
        24,
      ),
    ).toEqual([addedToDeviceNote(["a.com"], "files-reset"), deniedNote(["b.com"])]);
    expect(addedToDeviceNote(["a.com"], "files-reset")).toBe(
      "[network] a.com was blocked by this device's network policy. The person added a.com to this device's network list; it applies after the files are rebuilt. This command is not run again.",
    );
    expect(addedToDeviceNote(["a.com", "b.com"], "next-command")).toBe(
      "[network] a.com, b.com were blocked by this device's network policy. The person added a.com, b.com to this device's network list; it applies from the next command. This command is not run again.",
    );
    expect(addedToDeviceNote(["a.com"], "next-use")).toMatch(
      /it applies the next time the device is used\. This command is not run again\.$/,
    );
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
