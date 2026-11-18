import { createHash } from "node:crypto";
import type { ModelInfo, PermissionProfile } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AgentDefinitionSchema } from "../../src/agents/definition.js";
import {
  type ConversationEvent,
  ConversationEventSchema,
  type ManagedDevicePathsV1,
  ManagedDevicePathsV1Schema,
  type PermissionContextMetaV1,
  type PermissionContextV1,
  PermissionContextV1Schema,
} from "../../src/conversations/events.js";
import { ApiError } from "../../src/errors.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { COMPACTION_SETTINGS } from "../../src/identity/settings.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import {
  devicePathsChange,
  devicePathsChangeFromPayload,
  devicePathsIdemKey,
  devicePathsLevel,
  devicePathsText,
  type LegacyDevicePathsPayload,
} from "../../src/runtime/context/device-paths.js";
import {
  canonicalPermissionJson,
  managedDevicePathsHash,
  managedDevicePathsIdemKey,
  permissionContextAt,
  permissionContextHash,
  permissionContextIdemKey,
  permissionContextMeta,
  permissionContextText,
  permissionQuote,
  RecordedPermissionContextError,
} from "../../src/runtime/context/permission-profile.js";
import { coversHost } from "../../src/sandbox/modes.js";

const root = "00000000-0000-4000-8000-000000000001";
const device = "00000000-0000-4000-8000-000000000002";
const supported: PermissionContextV1 = {
  version: 1,
  rootConversationId: root,
  profileRevision: 0,
  selectedProfile: "request-approval",
  effectiveProfile: "request-approval",
  execution: "interactive",
  inherited: false,
  deviceId: device,
  scopeRevision: "scope-1",
  authorityRevision: "authority-1",
  availability: { state: "supported" },
  scope: {
    location: "local",
    workingRoot: "/project",
    filesystem: { kind: "scoped", readDirectories: ["/project"], writeDirectories: ["/project"] },
    network: { kind: "none" },
    outerNetwork: { kind: "host-environment" },
  },
};
const paths: ManagedDevicePathsV1 = {
  permissionContextVersion: 1,
  deviceId: device,
  roots: { workspace: "/workspace", skills: "/skills", tmp: "/tmp" },
  workingRoot: "/project",
};
const expected =
  'Permission context for new operations: Request approval.\nThis context supersedes earlier device-mode descriptions for new operations.\nWorking directory: "/project".\nReadable directories: ["/project"].\nWritable directories: ["/project"].\nNetwork: no destinations are authorized for new commands.\nOuter network boundary: the host environment.\nExtra filesystem or network scope requires the person\'s approval.\nChanges apply to new operations. Work already started keeps its starting permissions. Actual owner or organization revocation may still stop affected work.';
const pathsExpected =
  'Device directories: workspace "/workspace", skills "/skills", temporary files "/tmp".\nSelected working directory: "/project". These paths do not grant access; the current permission context governs new operations.';
const agent = AgentDefinitionSchema.parse({
  name: "test",
  instructions: "instructions",
  model: { provider: "fake", model: "fake" },
});
const model: ModelInfo = {
  id: "fake",
  displayName: "Fake",
  parameters: [],
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: {
    tools: true,
    vision: false,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
  },
};
function event(type: string, payload: unknown, seq: number): ConversationEvent {
  return {
    type,
    payload,
    seq,
    runId: null,
    conversationId: root,
    createdAt: new Date("2026-11-16T00:00:00.000Z"),
  } as ConversationEvent;
}
function build(events: ConversationEvent[]) {
  return buildModelRequest({
    events,
    agent,
    agentVersion: 1,
    model,
    step: 0,
    absorbedUpToSeq: 100,
  });
}

describe("recorded permission context", () => {
  it("accepts a complete v1 snapshot without stripping its fields", () => {
    expect(
      ConversationEventSchema.safeParse({ type: "permission_context", payload: supported }),
    ).toMatchObject({ success: true, data: { payload: supported } });
  });
  it("renders the recorded permission snapshot in history and attaches metadata", () => {
    const result = build([event("permission_context", supported, 1)]);
    expect(result.request.messages).toEqual([{ role: "system", content: expected }]);
    expect(result.meta).toHaveProperty("permissionContext.contextSeq", 1);
    expect(result.request.system).toEqual(build([]).request.system);
  });
  it("renders marked paths without legacy permission claims", () => {
    const result = build([event("device_paths", paths, 1)]);
    expect(result.request.messages).toEqual([{ role: "system", content: pathsExpected }]);
    expect(result.meta).toHaveProperty("permissionContext.contextSeq", null);
  });
  it("rejects marked paths mixed with a legacy mode instead of stripping the marker", () => {
    expect(
      ConversationEventSchema.safeParse({
        type: "device_paths",
        payload: { ...paths, mode: "auto" },
      }).success,
    ).toBe(false);
  });
  // 9.2 review M1: live build and the raw-coordinate checker share one marker/version rule
  it.each<[string, ConversationEvent[]]>([
    [
      "a device_paths marker 2",
      [event("device_paths", { ...paths, permissionContextVersion: 2 }, 1)],
    ],
    [
      "a device_paths null marker",
      [event("device_paths", { ...paths, permissionContextVersion: null }, 1)],
    ],
    [
      "a device_paths string marker",
      [event("device_paths", { roots: paths.roots, permissionContextVersion: "1" }, 1)],
    ],
    [
      "a permission_context version 2",
      [event("permission_context", { ...supported, version: 2 }, 1)],
    ],
    [
      "a permission_context with an unknown key",
      [event("permission_context", { ...supported, grant: true }, 1)],
    ],
    [
      "a summary-restored device_paths marker 2",
      [
        event("device_paths", { ...paths, permissionContextVersion: 2 }, 1),
        event("compaction_summary", { coversUpToSeq: 1, text: "Summary" }, 2),
      ],
    ],
    [
      "a covered superseded permission_context version 2",
      [
        event("permission_context", { ...supported, version: 2 }, 1),
        event("permission_context", supported, 2),
        event("compaction_summary", { coversUpToSeq: 2, text: "Summary" }, 3),
      ],
    ],
  ])("live build refuses %s with the typed recorded-context error", (_name, events) => {
    let thrown: unknown;
    try {
      build(events);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RecordedPermissionContextError);
  });
  it("live build keeps an unmarked path whose marker key is explicitly undefined", () => {
    const legacy = { roots: paths.roots, permissionContextVersion: undefined };
    expect(build([event("device_paths", legacy, 1)]).request.messages).toEqual([
      { role: "system", content: devicePathsText({ roots: paths.roots }) },
    ]);
  });
  it("restores the latest covered permission after paths and before plugins", () => {
    const result = build([
      event("permission_context", supported, 1),
      event("device_paths", paths, 2),
      event("plugin_context", { plugin: "memory", text: "Remember", hash: "hash" }, 3),
      event("compaction_summary", { coversUpToSeq: 3, text: "Summary" }, 4),
    ]);
    expect(result.request.messages.slice(1, 3)).toEqual([
      { role: "system", content: pathsExpected },
      { role: "system", content: expected },
    ]);
  });
});

const closing =
  "Changes apply to new operations. Work already started keeps its starting permissions. Actual owner or organization revocation may still stop affected work.";
const supersedes = "This context supersedes earlier device-mode descriptions for new operations.";
const restrictedFs = [
  'Working directory: "/project".',
  'Readable directories: ["/project"].',
  'Writable directories: ["/project"].',
];
const requestPolicy = "Extra filesystem or network scope requires the person's approval.";
const approvePolicy =
  "A separate reviewer may approve eligible extra scope; uncertainty asks the person.";
const fullPolicy =
  "No discretionary command approval; explicit policy, device-owner limits and OS permissions still apply.";
const localOuter = "Outer network boundary: the host environment.";
const offNetwork = "Network: no destinations are authorized for new commands.";
function snapshot(profile: PermissionProfile, location: "local" | "cloud"): PermissionContextV1 {
  return {
    ...structuredClone(supported),
    selectedProfile: profile,
    effectiveProfile: profile,
    scope: {
      location,
      workingRoot: "/project",
      filesystem:
        profile === "full-access"
          ? { kind: "device" }
          : { kind: "scoped", readDirectories: ["/project"], writeDirectories: ["/project"] },
      network: profile === "full-access" ? { kind: "environment" } : { kind: "none" },
      outerNetwork: location === "local" ? { kind: "host-environment" } : { kind: "open-public" },
    },
  };
}
function scopeOf(p: PermissionContextV1): NonNullable<PermissionContextV1["scope"]> {
  if (p.scope === null) throw new Error("Expected a supported snapshot with a scope");
  return p.scope;
}
function scopedFs(p: PermissionContextV1) {
  const fs = scopeOf(p).filesystem;
  if (fs.kind !== "scoped") throw new Error("Expected a scoped filesystem");
  return fs;
}
const literalCases: { profile: PermissionProfile; location: "local" | "cloud"; lines: string[] }[] =
  [
    {
      profile: "request-approval",
      location: "local",
      lines: [
        "Permission context for new operations: Request approval.",
        supersedes,
        ...restrictedFs,
        offNetwork,
        localOuter,
        requestPolicy,
        closing,
      ],
    },
    {
      profile: "approve-for-me",
      location: "local",
      lines: [
        "Permission context for new operations: Approve for me.",
        supersedes,
        ...restrictedFs,
        offNetwork,
        localOuter,
        approvePolicy,
        closing,
      ],
    },
    {
      profile: "full-access",
      location: "local",
      lines: [
        "Permission context for new operations: Full access.",
        supersedes,
        'Working directory: "/project".',
        "Filesystem: this device as the existing OS user; no additional OS privileges.",
        "Network: the host environment; restricted-profile host lists do not restrict Full access.",
        localOuter,
        fullPolicy,
        closing,
      ],
    },
    {
      profile: "request-approval",
      location: "cloud",
      lines: [
        "Permission context for new operations: Request approval.",
        supersedes,
        ...restrictedFs,
        offNetwork,
        "Outer network boundary: public addresses only.",
        requestPolicy,
        closing,
      ],
    },
    {
      profile: "approve-for-me",
      location: "cloud",
      lines: [
        "Permission context for new operations: Approve for me.",
        supersedes,
        ...restrictedFs,
        offNetwork,
        "Outer network boundary: public addresses only.",
        approvePolicy,
        closing,
      ],
    },
    {
      profile: "full-access",
      location: "cloud",
      lines: [
        "Permission context for new operations: Full access.",
        supersedes,
        'Working directory: "/project".',
        "Filesystem: the provisioned device environment as its existing OS user; no additional OS privileges.",
        "Network: the provisioned environment, subject to its outer network boundary.",
        "Outer network boundary: public addresses only.",
        fullPolicy,
        closing,
      ],
    },
  ];
function literalText(index: number): string {
  return literalLines(index).join("\n");
}
function literalLines(index: number): string[] {
  const row = literalCases[index];
  if (row === undefined) throw new Error(`No literal case ${index}`);
  return row.lines;
}
describe("frozen v1 text and availability matrix", () => {
  for (const row of literalCases) {
    it(`${row.location} ${row.profile} supported uses exact authority lines`, () => {
      expect(permissionContextText(snapshot(row.profile, row.location))).toBe(row.lines.join("\n"));
    });
    for (const state of ["unprobed", "unsupported"] as const) {
      it(`${row.location} ${row.profile} ${state} makes no scope promise`, () => {
        const p = {
          ...snapshot(row.profile, row.location),
          scope: null,
          availability: { state, reason: "Runtime capability not established" },
        };
        expect(permissionContextText(p)).toBe(
          [
            "Permission context for new operations: unavailable.",
            supersedes,
            state === "unprobed"
              ? 'Device operations are unverified: "Runtime capability not established".'
              : 'Device operations are unavailable: "Runtime capability not established".',
            closing,
          ].join("\n"),
        );
      });
    }
    it(`${row.location} ${row.profile} unavailable redacts device facts`, () => {
      const p: PermissionContextV1 = {
        ...snapshot(row.profile, row.location),
        effectiveProfile: null,
        deviceId: null,
        scopeRevision: null,
        authorityRevision: null,
        scope: null,
        availability: {
          state: "unavailable",
          cause: "no-device",
          reason: "Choose a device to run device operations",
        },
      };
      expect(permissionContextText(p)).toBe(
        [
          "Permission context for new operations: unavailable.",
          supersedes,
          'Device operations are unavailable: "Choose a device to run device operations".',
          closing,
        ].join("\n"),
      );
    });
  }
  it("uses the scheduled policy only and accepts a selected Full profile with restricted effective scope", () => {
    const p = snapshot("request-approval", "local");
    p.selectedProfile = "full-access";
    p.execution = "scheduled";
    expect(permissionContextText(p)).toBe(
      [
        ...literalLines(0).slice(0, -2),
        "Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply.",
        closing,
      ].join("\n"),
    );
  });
  it("renders allowlists and applied cloud network-off exactly", () => {
    const p = snapshot("approve-for-me", "cloud");
    scopeOf(p).network = { kind: "allowlist", hosts: ["api.example.com"] };
    scopeOf(p).outerNetwork = { kind: "allowlist", hosts: ["*.example.com"] };
    expect(permissionContextText(p)).toBe(
      [
        "Permission context for new operations: Approve for me.",
        supersedes,
        ...restrictedFs,
        'Network: new commands may reach only these authorized hosts: ["api.example.com"].',
        'Outer network boundary: allowed hosts ["*.example.com"].',
        approvePolicy,
        closing,
      ].join("\n"),
    );
    const full = snapshot("full-access", "cloud");
    scopeOf(full).outerNetwork = { kind: "none" };
    expect(permissionContextText(full)).toBe(
      [
        ...literalLines(5).slice(0, -3),
        "Outer network boundary: network access is disabled.",
        fullPolicy,
        closing,
      ].join("\n"),
    );
  });
  it("escapes controls and markup without normalizing user text or adding physical lines", () => {
    expect(permissionQuote('a"\n<>&\u2028\u2029\\\u0000\t')).toBe(
      '"a\\"\\n\\u003c\\u003e\\u0026\\u2028\\u2029\\\\\\u0000\\t"',
    );
    const reason = 'Use "capability"\n<test>&\u2028\u2029';
    const p: PermissionContextV1 = {
      ...supported,
      scope: null,
      availability: { state: "unprobed", reason },
    };
    expect(permissionContextText(p)).toBe(
      [
        "Permission context for new operations: unavailable.",
        supersedes,
        'Device operations are unverified: "Use \\"capability\\"\\n\\u003ctest\\u003e\\u0026\\u2028\\u2029".'.replace(
          '\\\\"',
          '\\"',
        ),
        closing,
      ].join("\n"),
    );
    const unusual = { ...paths, workingRoot: '/a"<>&\u2028\u2029' };
    expect(devicePathsText(unusual)).toBe(
      'Device directories: workspace "/workspace", skills "/skills", temporary files "/tmp".\nSelected working directory: "/a\\"\\u003c\\u003e\\u0026\\u2028\\u2029". These paths do not grant access; the current permission context governs new operations.',
    );
  });
});

describe("complete strict schema", () => {
  const invalid: [string, (p: PermissionContextV1) => void][] = [
    [
      "unknown top-level key",
      (p) => {
        Object.assign(p, { grant: true });
      },
    ],
    [
      "unknown version",
      (p) => {
        Object.assign(p, { version: 2 });
      },
    ],
    [
      "omitted null field",
      (p) => {
        Reflect.deleteProperty(p, "scopeRevision");
      },
    ],
    [
      "undefined required field",
      (p) => {
        Object.assign(p, { authorityRevision: undefined });
      },
    ],
    [
      "negative revision",
      (p) => {
        p.profileRevision = -1;
      },
    ],
    [
      "unsafe revision",
      (p) => {
        p.profileRevision = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "revision null without null profile",
      (p) => {
        p.profileRevision = null;
      },
    ],
    [
      "missing device",
      (p) => {
        p.deviceId = null;
      },
    ],
    [
      "bad root ID",
      (p) => {
        p.rootConversationId = "not-an-id";
      },
    ],
    [
      "empty revision",
      (p) => {
        p.scopeRevision = "";
      },
    ],
    [
      "oversized revision",
      (p) => {
        p.authorityRevision = "x".repeat(257);
      },
    ],
    [
      "supported null scope",
      (p) => {
        p.scope = null;
      },
    ],
    [
      "supported reason",
      (p) => {
        Object.assign(p.availability, { reason: "No" });
      },
    ],
    [
      "unsupported scope",
      (p) => {
        p.availability = { state: "unsupported", reason: "No" };
      },
    ],
    [
      "unprobed no reason",
      (p) => {
        Object.assign(p, { availability: { state: "unprobed" }, scope: null });
      },
    ],
    [
      "oversized reason",
      (p) => {
        p.availability = { state: "unprobed", reason: "x".repeat(1001) };
        p.scope = null;
      },
    ],
    [
      "empty reason",
      (p) => {
        p.availability = { state: "unprobed", reason: " " };
        p.scope = null;
      },
    ],
    [
      "restricted to Full",
      (p) => {
        p.effectiveProfile = "full-access";
      },
    ],
    [
      "Full to Request interactive",
      (p) => {
        p.selectedProfile = "full-access";
      },
    ],
    [
      "scheduled Approve",
      (p) => {
        p.execution = "scheduled";
        p.selectedProfile = p.effectiveProfile = "approve-for-me";
      },
    ],
    [
      "restricted device filesystem",
      (p) => {
        scopeOf(p).filesystem = { kind: "device" };
      },
    ],
    [
      "restricted environment network",
      (p) => {
        scopeOf(p).network = { kind: "environment" };
      },
    ],
    [
      "missing readable write root",
      (p) => {
        scopedFs(p).writeDirectories.push("/write");
      },
    ],
    [
      "missing working root",
      (p) => {
        scopedFs(p).readDirectories = ["/other"];
        scopedFs(p).writeDirectories = ["/other"];
      },
    ],
    [
      "unsorted roots",
      (p) => {
        scopedFs(p).readDirectories = ["/z", "/project"];
      },
    ],
    [
      "duplicate roots",
      (p) => {
        scopedFs(p).readDirectories.push("/project");
      },
    ],
    [
      "too many roots",
      (p) => {
        scopedFs(p).readDirectories = Array.from(
          { length: 65 },
          (_, i) => `/p${i.toString().padStart(2, "0")}`,
        );
      },
    ],
    [
      "relative working root",
      (p) => {
        scopeOf(p).workingRoot = "project";
      },
    ],
    [
      "oversized path",
      (p) => {
        scopeOf(p).workingRoot = `/${"x".repeat(4096)}`;
      },
    ],
    [
      "dot-dot path",
      (p) => {
        scopeOf(p).workingRoot = "/a/../project";
      },
    ],
    [
      "control path",
      (p) => {
        scopeOf(p).workingRoot = "/a\nproject";
      },
    ],
    [
      "empty allowlist",
      (p) => {
        scopeOf(p).network = { kind: "allowlist", hosts: [] };
      },
    ],
    [
      "unsorted hosts",
      (p) => {
        scopeOf(p).network = { kind: "allowlist", hosts: ["z.example.com", "a.example.com"] };
      },
    ],
    [
      "duplicate hosts",
      (p) => {
        scopeOf(p).network = { kind: "allowlist", hosts: ["a.example.com", "a.example.com"] };
      },
    ],
    [
      "unnormalized host",
      (p) => {
        scopeOf(p).network = { kind: "allowlist", hosts: ["A.example.com"] };
      },
    ],
    [
      "too many hosts",
      (p) => {
        scopeOf(p).network = {
          kind: "allowlist",
          hosts: Array.from(
            { length: 101 },
            (_, i) => `h${i.toString().padStart(3, "0")}.example.com`,
          ),
        };
      },
    ],
    [
      "extra network field",
      (p) => {
        Object.assign(scopeOf(p).network, { hosts: [] });
      },
    ],
    [
      "local cloud outer boundary",
      (p) => {
        scopeOf(p).outerNetwork = { kind: "open-public" };
      },
    ],
    [
      "cloud host outer boundary",
      (p) => {
        scopeOf(p).location = "cloud";
      },
    ],
    [
      "cloud none with allowlist",
      (p) => {
        scopeOf(p).location = "cloud";
        scopeOf(p).outerNetwork = { kind: "none" };
        scopeOf(p).network = { kind: "allowlist", hosts: ["example.com"] };
      },
    ],
    [
      "cloud hosts exceeding outer ceiling",
      (p) => {
        scopeOf(p).location = "cloud";
        scopeOf(p).outerNetwork = { kind: "allowlist", hosts: ["other.com"] };
        scopeOf(p).network = { kind: "allowlist", hosts: ["example.com"] };
      },
    ],
    [
      "unavailable leaked device",
      (p) => {
        p.scope = null;
        p.availability = {
          state: "unavailable",
          cause: "no-device",
          reason: "Choose a device to run device operations",
        };
      },
    ],
  ];
  it.each(invalid)("rejects %s instead of inventing a usable scope", (_name, mutate) => {
    const p = structuredClone(supported);
    mutate(p);
    expect(PermissionContextV1Schema.safeParse(p).success).toBe(false);
    expect(() => permissionContextText(p)).toThrow();
    expect(() => permissionContextHash(p)).toThrow();
  });
  it("accepts consent fallback and Unicode code-point sorted roots without reordering", () => {
    const p = snapshot("approve-for-me", "local");
    p.selectedProfile = "full-access";
    scopeOf(p).filesystem = {
      kind: "scoped",
      readDirectories: ["/project", "/\ue000", "/\u{10000}"],
      writeDirectories: ["/project"],
    };
    expect(PermissionContextV1Schema.parse(p)).toEqual(p);
    const q = structuredClone(p);
    if (q.scope?.filesystem.kind === "scoped") q.scope.filesystem.readDirectories.reverse();
    expect(PermissionContextV1Schema.safeParse(q).success).toBe(false);
  });
  it("redacts actor-device-access and uses exact unavailable diagnostics", () => {
    const p: PermissionContextV1 = {
      ...supported,
      selectedProfile: null,
      profileRevision: null,
      effectiveProfile: null,
      deviceId: null,
      scopeRevision: null,
      authorityRevision: null,
      scope: null,
      availability: {
        state: "unavailable",
        cause: "actor-device-access",
        reason: "This run's actor cannot use the selected device",
      },
    };
    expect(permissionContextText(p)).toBe(
      [
        "Permission context for new operations: unavailable.",
        supersedes,
        'Device operations are unavailable: "This run\'s actor cannot use the selected device".',
        closing,
      ].join("\n"),
    );
    expect(
      PermissionContextV1Schema.safeParse({
        ...p,
        selectedProfile: "full-access",
        profileRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      PermissionContextV1Schema.safeParse({
        ...p,
        availability: { ...p.availability, reason: "Other" },
      }).success,
    ).toBe(false);
  });
  it.each([0, 2, null, "1"])("rejects unsupported managed marker %s", (version) => {
    expect(
      ConversationEventSchema.safeParse({
        type: "device_paths",
        payload: { ...paths, permissionContextVersion: version },
      }).success,
    ).toBe(false);
  });
  it("validates every managed path and exact roots keys", () => {
    expect(
      ManagedDevicePathsV1Schema.safeParse({ ...paths, roots: { ...paths.roots, home: "/home" } })
        .success,
    ).toBe(false);
    expect(
      ManagedDevicePathsV1Schema.safeParse({ ...paths, workingRoot: "relative" }).success,
    ).toBe(false);
    expect(ManagedDevicePathsV1Schema.safeParse({ ...paths, deviceId: "" }).success).toBe(false);
  });
});

describe("canonical hashes and predecessor identity", () => {
  it("uses frozen canonical tuples, UTF-8 bytes and code-point keys", () => {
    const canonical =
      '["device_paths",1,{"deviceId":"00000000-0000-4000-8000-000000000002","permissionContextVersion":1,"roots":{"skills":"/skills","tmp":"/tmp","workspace":"/workspace"},"workingRoot":"/project"}]';
    expect(canonicalPermissionJson(["device_paths", 1, paths])).toBe(canonical);
    expect(managedDevicePathsHash(paths)).toBe(
      createHash("sha256").update(canonical, "utf8").digest("hex"),
    );
    expect(canonicalPermissionJson({ "\u{10000}": null, "\ue000": "é" })).toBe(
      '{"\ue000":"é","\u{10000}":null}',
    );
    expect(canonicalPermissionJson(["permission_context", 1, supported])).toBe(
      '["permission_context",1,{"authorityRevision":"authority-1","availability":{"state":"supported"},"deviceId":"00000000-0000-4000-8000-000000000002","effectiveProfile":"request-approval","execution":"interactive","inherited":false,"profileRevision":0,"rootConversationId":"00000000-0000-4000-8000-000000000001","scope":{"filesystem":{"kind":"scoped","readDirectories":["/project"],"writeDirectories":["/project"]},"location":"local","network":{"kind":"none"},"outerNetwork":{"kind":"host-environment"},"workingRoot":"/project"},"scopeRevision":"scope-1","selectedProfile":"request-approval","version":1}]',
    );
  });
  it("ignores object insertion order but rejects missing nulls and unnormalized arrays", () => {
    const reordered = Object.fromEntries(
      Object.entries(supported).reverse(),
    ) as PermissionContextV1;
    expect(permissionContextHash(reordered)).toBe(permissionContextHash(supported));
    expect(permissionContextHash(PermissionContextV1Schema.parse(supported))).toBe(
      permissionContextHash(supported),
    );
    expect(canonicalPermissionJson({ value: null })).not.toBe(canonicalPermissionJson({}));
    for (const value of [
      { value: undefined },
      [undefined],
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Array(2),
    ])
      expect(() => canonicalPermissionJson(value)).toThrow();
    expect(() =>
      permissionContextHash({ ...supported, scope: undefined } as unknown as PermissionContextV1),
    ).toThrow();
  });
  it("hashes rendered contributions in order independently from payload revisions and initial system", () => {
    const contributions = [
      { type: "permission_context" as const, text: "héllo" },
      { type: "device_paths" as const, text: "paths" },
    ];
    const meta = permissionContextMeta([event("permission_context", supported, 7)], contributions);
    expect(meta).toEqual({
      version: 1,
      contextSeq: 7,
      hash: createHash("sha256")
        .update('[1,[["permission_context","héllo"],["device_paths","paths"]]]', "utf8")
        .digest("hex"),
    });
    expect(permissionContextMeta([], contributions.slice(1))).toMatchObject({ contextSeq: null });
    expect(permissionContextMeta([], [])).toBeUndefined();
    expect(permissionContextMeta([], [...contributions].reverse())?.hash).not.toBe(meta?.hash);
    expect(
      build([event("permission_context", supported, 7)]).meta.permissionContext?.hash,
    ).not.toBe(permissionContextHash(supported));
  });
  it("uses sentinel zero, all hash digits and predecessor identity for A to B to A", () => {
    const key = permissionContextIdemKey(supported, 0);
    expect(key).toMatch(/^permission_context:v1:[a-f0-9]{64}:0$/);
    expect(key).toBe(`permission_context:v1:${permissionContextHash(supported)}:0`);
    expect(permissionContextIdemKey(supported, 2)).not.toBe(key);
    expect(managedDevicePathsIdemKey(paths, 0)).toBe(
      `device_paths:permission-v1:${managedDevicePathsHash(paths)}:0`,
    );
    const first = devicePathsChangeFromPayload(undefined, paths, "run");
    expect(first).toMatchObject({
      payload: paths,
      idemKey: managedDevicePathsIdemKey(paths, 0),
      runId: "run",
    });
    expect(devicePathsChangeFromPayload({ seq: 1, payload: paths }, paths)).toBeNull();
    const second = { ...paths, workingRoot: "/elsewhere" };
    expect(devicePathsChangeFromPayload({ seq: 1, payload: paths }, second)?.idemKey).toBe(
      managedDevicePathsIdemKey(second, 1),
    );
    expect(devicePathsChangeFromPayload({ seq: 2, payload: second }, paths)?.idemKey).toBe(
      managedDevicePathsIdemKey(paths, 2),
    );
    expect(
      devicePathsChangeFromPayload({ seq: 1, payload: { roots: paths.roots } }, paths),
    ).not.toBeNull();
    for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      expect(() => permissionContextIdemKey(supported, seq)).toThrow();
  });
  it.each(["deviceId", "workingRoot", "roots"] as const)(
    "managed equality includes %s",
    (field) => {
      const next = structuredClone(paths);
      if (field === "roots") next.roots.tmp = "/temporary";
      else next[field] = field === "deviceId" ? root : "/other";
      expect(devicePathsChangeFromPayload({ seq: 7, payload: paths }, next)).not.toBeNull();
    },
  );
});

describe("ordered history, summaries and original request metadata", () => {
  const b = snapshot("approve-for-me", "local");
  const changes = [
    event("permission_context", supported, 1),
    event("permission_context", b, 3),
    event("permission_context", supported, 5),
  ];
  it("renders A to B to A append-only and folds only at the requested bound", () => {
    expect(build(changes).request.messages.map((m) => m.content)).toEqual([
      expected,
      literalText(1),
      expected,
    ]);
    expect(permissionContextAt([...changes].reverse(), 4)?.seq).toBe(3);
    expect(permissionContextAt(changes, 0)).toBeUndefined();
    expect(build(changes).meta.permissionContext?.contextSeq).toBe(5);
  });
  it.each([
    [0, [expected, literalText(1), expected]],
    [1, [expected, literalText(1), expected]],
    [2, [expected, literalText(1), expected]],
    [3, [literalText(1), expected]],
    [4, [literalText(1), expected]],
    [5, [expected]],
  ])(
    "summary at %s restores only the latest covered snapshot and later transitions",
    (coversUpToSeq, texts) => {
      const result = build([
        ...changes,
        event("compaction_summary", { coversUpToSeq, text: "Summary" }, 6),
      ]);
      expect(result.request.messages.slice(1).map((m) => m.content)).toEqual(texts);
      expect(result.meta.permissionContext?.contextSeq).toBe(5);
    },
  );
  it("excludes permission, managed paths and audit-only events from compaction transcripts", () => {
    const log = [
      event("user_message", { content: [{ type: "text", text: "Question" }] }, 1),
      event("permission_context", supported, 2),
      event("device_paths", paths, 3),
      event("permission_profile_changed", { selectedProfile: "full-access" }, 4),
      event("permission_reviewed", {}, 5),
    ];
    expect(
      compactionPlan(log, { ...COMPACTION_SETTINGS.parse({}), keepRecentTurns: 0 }, 100000)
        ?.transcript,
    ).toBe("User: Question");
    const result = build(log.slice(3));
    expect(result.request.messages).toEqual([]);
    expect(result.meta).not.toHaveProperty("permissionContext");
  });
  function recording(events = [...changes]): { snap: CaseSnapshot; callSeq: number } {
    const built = build(events);
    const callSeq = Math.max(...events.map((e) => e.seq)) + 1;
    const call = event(
      "model_call",
      {
        step: 1,
        attempt: 1,
        provider: "fake",
        model: "fake",
        fallback: false,
        request: { ...built.meta, maxOutputTokens: 4096 },
      },
      callSeq,
    );
    return structuredClone({
      callSeq,
      snap: {
        version: 1,
        orgId: root,
        conversationId: root,
        runId: root,
        agentId: root,
        agentVersion: 1,
        definitions: { "1": agent },
        toolSpecs: {},
        events: [...events, call].map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      },
    });
  }
  type ModelCallPayload = Extract<ConversationEvent, { type: "model_call" }>["payload"];
  function eventAt(snap: CaseSnapshot, seq: number): CaseSnapshot["events"][number] {
    const found = snap.events.find((e) => e.seq === seq);
    if (found === undefined) throw new Error(`No event at seq ${seq}`);
    return found;
  }
  const callOf = (snap: CaseSnapshot, callSeq: number) =>
    eventAt(snap, callSeq).payload as ModelCallPayload;
  function metaOf(call: ModelCallPayload): PermissionContextMetaV1 {
    const meta = call.request.permissionContext;
    if (meta === undefined) throw new Error("Expected recorded permission metadata");
    return meta;
  }
  it("normal recorded transitions are zero drift and candidate instructions/model retain permission history", () => {
    const { snap, callSeq } = recording();
    const baseline = reconstructRequest(snap, callSeq, { model });
    expect(baseline.drift).toEqual([]);
    const candidate = reconstructRequest(snap, callSeq, {
      model: { ...model, id: "other" },
      definition: { ...agent, instructions: "New instructions" },
    });
    expect(candidate.request.messages).toEqual(baseline.request.messages);
    expect(candidate.drift).toEqual([]);
    expect(candidate.meta.permissionContext).toEqual(baseline.meta.permissionContext);
  });
  it.each([
    "missing context",
    "altered context",
    "missing metadata",
    "altered hash",
    "bad locator",
    "future locator",
    "null metadata",
    "wrong version",
  ])("diagnoses %s using only the original bounded request", (kind) => {
    const { snap, callSeq } = recording();
    const payload = callOf(snap, callSeq);
    if (kind === "missing context") snap.events = snap.events.filter((e) => e.seq !== 3);
    if (kind === "altered context") {
      const altered = eventAt(snap, 3).payload as PermissionContextV1;
      altered.effectiveProfile = "request-approval";
      altered.selectedProfile = "request-approval";
    }
    if (kind === "missing metadata") delete payload.request.permissionContext;
    if (kind === "altered hash") metaOf(payload).hash = "a".repeat(64);
    if (kind === "bad locator") metaOf(payload).contextSeq = 3;
    if (kind === "future locator") {
      metaOf(payload).contextSeq = callSeq + 1;
      snap.events.push({ ...eventAt(snap, 1), seq: callSeq + 1 });
    }
    if (kind === "null metadata") Object.assign(payload.request, { permissionContext: null });
    if (kind === "wrong version") Object.assign(metaOf(payload), { version: 2 });
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([
      "permission_profile_changed",
    ]);
  });
  it("detects altered managed paths when there is no permission locator", () => {
    const { snap, callSeq } = recording([event("device_paths", paths, 1)]);
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([]);
    (eventAt(snap, 1).payload as ManagedDevicePathsV1).workingRoot = "/tampered";
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([
      "permission_profile_changed",
    ]);
  });
  const second: ManagedDevicePathsV1 = { ...paths, workingRoot: "/elsewhere" };
  const summaryAt = (coversUpToSeq: number, seq: number) =>
    event("compaction_summary", { coversUpToSeq, text: "Summary" }, seq);
  it.each<[string, ConversationEvent[], number, (payload: Record<string, unknown>) => void]>([
    [
      "an uncovered legacy path with marker 2",
      [event("device_paths", { roots: paths.roots }, 1)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: 2 }),
    ],
    [
      "an uncovered managed path with marker 2",
      [event("device_paths", paths, 1)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: 2 }),
    ],
    [
      "an uncovered managed path with a null marker",
      [event("device_paths", paths, 1)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: null }),
    ],
    [
      "an uncovered managed path with a string marker",
      [event("device_paths", paths, 1)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: "1" }),
    ],
    [
      "a covered superseded permission context with version 2",
      [...changes.slice(0, 2), summaryAt(3, 4)],
      1,
      (p) => Object.assign(p, { version: 2 }),
    ],
    [
      "a covered superseded permission context with an unknown key",
      [...changes.slice(0, 2), summaryAt(3, 4)],
      1,
      (p) => Object.assign(p, { grant: true }),
    ],
    [
      "a covered superseded managed path with marker 2",
      [event("device_paths", paths, 1), event("device_paths", second, 2), summaryAt(2, 3)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: 2 }),
    ],
    [
      "the latest covered managed path with marker 2",
      [event("device_paths", paths, 1), summaryAt(1, 2)],
      1,
      (p) => Object.assign(p, { permissionContextVersion: 2 }),
    ],
  ])(
    "rejects %s in a raw snapshot instead of replaying it as history",
    (_name, events, seq, mutate) => {
      const { snap, callSeq } = recording(events);
      expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([]);
      mutate(eventAt(snap, seq).payload as Record<string, unknown>);
      // 9.2 review M2: the snapshot's failure (4xx), never a provider error
      let thrown: unknown;
      try {
        reconstructRequest(snap, callSeq, { model });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      expect(thrown).toMatchObject({ code: "eval.snapshot_invalid", status: 422 });
    },
  );
  it("keeps unmarked historical paths replayable with their legacy text", () => {
    const legacy = {
      roots: paths.roots,
      tier: "dev",
      isolation: "sandbox",
      network: "none",
    } as const;
    const { snap, callSeq } = recording([event("device_paths", legacy, 1)]);
    const result = reconstructRequest(snap, callSeq, { model });
    expect(result.drift).toEqual([]);
    expect(result.meta).not.toHaveProperty("permissionContext");
    expect(result.request.messages).toEqual([{ role: "system", content: devicePathsText(legacy) }]);
  });
  it("cannot satisfy metadata from events after min(toSeq, callSeq - 1)", () => {
    for (const futureToSeq of [false, true]) {
      const { snap, callSeq } = recording();
      const call = callOf(snap, callSeq);
      snap.events.push({ ...eventAt(snap, 1), seq: callSeq + 1, payload: b });
      if (futureToSeq) call.request.toSeq = 100;
      expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([]);
    }
  });
});

/** Bytes and keys produced by the base commit (94bc2dddd) helpers; historical logs keep them. */
const legacyRootsLine =
  "This device's directories: workspace /workspace, skills /skills (read only), temporary files /tmp. Use these paths in commands and tool calls.";
const legacyMatrix: [string, Record<string, unknown>, string | null, string][] = [
  ["roots only", {}, null, "8afd61ecbef8c4de"],
  [
    "strict sandbox",
    { tier: "strict", isolation: "sandbox" },
    "Sandbox level: strict. Only the organization's allowed domains are reachable; other domains need the user's approval.",
    "9ec00bbe602a0f98",
  ],
  [
    "strict unattended",
    { tier: "strict", isolation: "sandbox", unattended: true },
    "Sandbox level: strict. Only the organization's allowed domains are reachable; approvals are not available in a scheduled run, so other domains stay blocked.",
    "53e6947b45444f6a",
  ],
  [
    "dev sandbox without local facts",
    { tier: "dev", isolation: "sandbox" },
    "Sandbox level: development. Package registries and common developer hosts are reachable; other domains need the user's approval. Local servers and unix sockets work.",
    "28637d57393a1fe2",
  ],
  [
    "dev local facts",
    { tier: "dev", isolation: "sandbox", localhost: "off-proxy-detected", unixSockets: "roots" },
    "Sandbox level: development. Package registries and common developer hosts are reachable; other domains need the user's approval. Local servers are blocked on this machine because a local proxy was detected (the user can allow them on the device); unix sockets work under the device's directories only.",
    "faa3d716c4d72d02",
  ],
  [
    "open container",
    { tier: "open", isolation: "sandbox", localhost: "on", unixSockets: "all-masked" },
    "Sandbox level: open. Any public address is reachable. Local servers work; unix sockets work inside the device's container only.",
    "411828ad28e6ab81",
  ],
  [
    "open without sandbox",
    { tier: "open", isolation: "none" },
    "Sandbox level: open, without a sandbox. Commands run directly on the user's computer as the user, with their files, credentials and network; be careful with anything that deletes files or sends data out.",
    "6f1093b66c0fb300",
  ],
  [
    "network off",
    { tier: "dev", isolation: "sandbox", network: "none" },
    "Sandbox level: development. The network is switched off for this organization: no domain is reachable and approval requests cannot change that.",
    "ba44d14b22c09651",
  ],
  [
    "tier without isolation",
    { tier: "strict" },
    "Sandbox level: strict. Only the organization's allowed domains are reachable; other domains need the user's approval.",
    "9ec00bbe602a0f98",
  ],
  [
    "auto local",
    {
      mode: "auto",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: ["a.example.com"] },
      local: true,
    },
    "Mode: auto. Commands run as the user on this machine, with their files, credentials and network; every command is reviewed and dangerous ones are blocked or need approval.",
    "cff5540b9e34d187",
  ],
  [
    "sandbox local",
    {
      mode: "sandbox",
      allowedMode: "auto",
      network: { kind: "allowlist", hosts: [] },
      local: true,
    },
    "Mode: sandbox. Only the workspace, skills and temporary files are writable; the network reaches the allowed hosts.",
    "b5082f56227562e5",
  ],
  [
    "cloud public",
    {
      mode: "sandbox",
      allowedMode: "sandbox",
      network: { kind: "open-public", hosts: [] },
      local: false,
    },
    "Mode: sandbox. Commands run in the device's container; outside it only public addresses are reachable (loopback, private and cloud metadata addresses are blocked).",
    "e843762dbbff2c3c",
  ],
  [
    "cloud allowlist",
    { mode: "auto", allowedMode: "auto", network: { kind: "allowlist", hosts: ["a.example.com"] } },
    "Mode: auto. Commands run in the device's container; outside it the network reaches the organization's allowlisted hosts.",
    "cff5540b9e34d187",
  ],
];
describe("historical device paths keep their exact bytes and keys", () => {
  it.each(legacyMatrix)("%s renders, keys and compares as before", (_name, level, line, digest) => {
    const p = { roots: paths.roots, ...level } as LegacyDevicePathsPayload;
    const text = line === null ? legacyRootsLine : `${legacyRootsLine}\n${line}`;
    expect(devicePathsText(p)).toBe(text);
    expect(devicePathsIdemKey(p, 0)).toBe(`device_paths:${digest}:0`);
    expect(devicePathsIdemKey(p, 7)).toBe(`device_paths:${digest}:7`);
    const first = devicePathsChange(undefined, p.roots, "run", devicePathsLevel(p));
    expect(first?.idemKey).toBe(`device_paths:${digest}:0`);
    expect(devicePathsChangeFromPayload(undefined, p, "run")).toEqual(first);
    expect(
      devicePathsChange({ seq: 3, payload: p }, p.roots, undefined, devicePathsLevel(p)),
    ).toBeNull();
    expect(devicePathsChangeFromPayload({ seq: 3, payload: p }, p)).toBeNull();
    expect(ConversationEventSchema.safeParse({ type: "device_paths", payload: p }).success).toBe(
      true,
    );
    const result = build([event("device_paths", p, 1)]);
    expect(result.request.messages).toEqual([{ role: "system", content: text }]);
    expect(result.meta).not.toHaveProperty("permissionContext");
  });
  it("leaves audit-only profile, review and approval events without text, metadata or drift", () => {
    const audit = [
      event("device_paths", { roots: paths.roots, tier: "dev", isolation: "sandbox" }, 1),
      event("permission_profile_changed", { selectedProfile: "full-access" }, 2),
      event("permission_reviewed", {}, 3),
      event("approval_requested", {}, 4),
    ];
    const result = build(audit);
    expect(result.request.messages.map((m) => m.content)).toEqual([
      devicePathsText({ roots: paths.roots, tier: "dev", isolation: "sandbox" }),
    ]);
    expect(result.meta).not.toHaveProperty("permissionContext");
    expect(result.meta.systemHash).toBe(build([]).meta.systemHash);
  });
});

describe("authority boundary normalization", () => {
  const scoped = (readDirectories: string[], writeDirectories = ["/project"]) => {
    const p = snapshot("request-approval", "local");
    if (p.scope === null) throw new Error("supported snapshot has a scope");
    p.scope.filesystem = { kind: "scoped", readDirectories, writeDirectories };
    return p;
  };
  const withScope = (
    profile: PermissionProfile,
    location: "local" | "cloud",
    edit: (scope: NonNullable<PermissionContextV1["scope"]>) => void,
  ) => {
    const p = snapshot(profile, location);
    if (p.scope === null) throw new Error("supported snapshot has a scope");
    edit(p.scope);
    return p;
  };
  const host253 = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.com`;
  it.each<[string, PermissionContextV1]>([
    [
      "64 combined roots",
      scoped([
        "/project",
        ...Array.from({ length: 63 }, (_, i) => `/r${String(i).padStart(2, "0")}`),
      ]),
    ],
    [
      "100 hosts",
      withScope("request-approval", "local", (s) => {
        s.network = {
          kind: "allowlist",
          hosts: Array.from(
            { length: 100 },
            (_, i) => `h${String(i).padStart(3, "0")}.example.com`,
          ),
        };
      }),
    ],
    [
      "a 253-character host",
      withScope("request-approval", "local", (s) => {
        s.network = { kind: "allowlist", hosts: [host253] };
      }),
    ],
    [
      "a 4096-character working root",
      (() => {
        const long = `/${"x".repeat(4095)}`;
        const p = scoped([long], [long]);
        if (p.scope) p.scope.workingRoot = long;
        return p;
      })(),
    ],
    [
      "the largest safe profile revision",
      { ...supported, profileRevision: Number.MAX_SAFE_INTEGER },
    ],
    [
      "256-character revisions",
      { ...supported, scopeRevision: "s".repeat(256), authorityRevision: "a".repeat(256) },
    ],
    [
      "a 1000-character reason",
      {
        ...supported,
        scope: null,
        availability: { state: "unsupported", reason: "r".repeat(1000) },
      },
    ],
    [
      "a wildcard outer pattern covering a nested host",
      withScope("approve-for-me", "cloud", (s) => {
        s.network = { kind: "allowlist", hosts: ["a.b.example.com", "api.example.com"] };
        s.outerNetwork = { kind: "allowlist", hosts: ["*.example.com"] };
      }),
    ],
    [
      "an exact outer host equal to the restricted host",
      withScope("request-approval", "cloud", (s) => {
        s.network = { kind: "allowlist", hosts: ["example.com"] };
        s.outerNetwork = { kind: "allowlist", hosts: ["example.com"] };
      }),
    ],
    [
      "restricted hosts under an open public outer boundary",
      withScope("request-approval", "cloud", (s) => {
        s.network = { kind: "allowlist", hosts: ["*.example.com"] };
      }),
    ],
    [
      "Full cloud environment behind a disabled outer boundary",
      withScope("full-access", "cloud", (s) => {
        s.outerNetwork = { kind: "none" };
      }),
    ],
  ])("accepts %s at the authority bound", (_name, p) => {
    expect(PermissionContextV1Schema.parse(p)).toEqual(p);
    expect(permissionContextHash(p)).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each<[string, PermissionContextV1]>([
    ["a dot segment in a readable directory", scoped(["/./project", "/project"])],
    ["a nested dot segment in a readable directory", scoped(["/a/./b", "/project"])],
    ["a trailing slash in a readable directory", scoped(["/project", "/z/"])],
    ["a trailing slash in a writable directory", scoped(["/project", "/z/"], ["/project", "/z/"])],
    ["an empty segment in a readable directory", scoped(["//z", "/project"])],
    [
      "a trailing slash in the working root",
      withScope("full-access", "local", (s) => {
        s.workingRoot = "/project/";
      }),
    ],
    [
      "a dot segment in the working root",
      withScope("full-access", "local", (s) => {
        s.workingRoot = "/project/.";
      }),
    ],
    [
      "a 254-character host",
      withScope("request-approval", "local", (s) => {
        s.network = { kind: "allowlist", hosts: [`a${host253}`] };
      }),
    ],
    [
      "a wildcard outer pattern used for its bare apex",
      withScope("request-approval", "cloud", (s) => {
        s.network = { kind: "allowlist", hosts: ["example.com"] };
        s.outerNetwork = { kind: "allowlist", hosts: ["*.example.com"] };
      }),
    ],
    [
      "a restricted wildcard wider than an exact outer host",
      withScope("request-approval", "cloud", (s) => {
        s.network = { kind: "allowlist", hosts: ["*.example.com"] };
        s.outerNetwork = { kind: "allowlist", hosts: ["api.example.com"] };
      }),
    ],
    [
      "a host with a port",
      withScope("request-approval", "local", (s) => {
        s.network = { kind: "allowlist", hosts: ["example.com:443"] };
      }),
    ],
    [
      "an IP literal host",
      withScope("request-approval", "local", (s) => {
        s.network = { kind: "allowlist", hosts: ["10.0.0.1"] };
      }),
    ],
    [
      "an empty outer allowlist",
      withScope("full-access", "cloud", (s) => {
        s.outerNetwork = { kind: "allowlist", hosts: [] };
      }),
    ],
  ])("rejects %s instead of normalizing it", (_name, p) => {
    expect(PermissionContextV1Schema.safeParse(p).success).toBe(false);
    expect(() => permissionContextText(p)).toThrow();
  });
  // 9.2 review M4: the schema's outer-allowlist coverage is the authority's own coversHost
  it.each<[string, string]>([
    ["example.com", "example.com"],
    ["example.com", "api.example.com"],
    ["*.example.com", "api.example.com"],
    ["*.example.com", "a.b.example.com"],
    ["*.example.com", "example.com"],
    ["*.example.com", "badexample.com"],
    ["*.example.com", "*.example.com"],
    ["*.example.com", "*.api.example.com"],
    ["api.example.com", "*.example.com"],
  ])("outer allowlist %s covers %s exactly as sandbox coversHost", (pattern, host) => {
    const p = withScope("request-approval", "cloud", (s) => {
      s.network = { kind: "allowlist", hosts: [host] };
      s.outerNetwork = { kind: "allowlist", hosts: [pattern] };
    });
    expect(PermissionContextV1Schema.safeParse(p).success).toBe(coversHost(pattern, host));
  });
  it.each(["/project/", "/./project", "/a/../project", "//project"])(
    "rejects managed working root %s",
    (workingRoot) => {
      expect(ManagedDevicePathsV1Schema.safeParse({ ...paths, workingRoot }).success).toBe(false);
      expect(
        ManagedDevicePathsV1Schema.safeParse({
          ...paths,
          roots: { ...paths.roots, tmp: workingRoot },
        }).success,
      ).toBe(false);
    },
  );
});
