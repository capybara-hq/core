import { createHash } from "node:crypto";
import type { ModelInfo, PermissionProfile } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { AgentDefinitionSchema } from "../../src/agents/definition.js";
import {
  type ConversationEvent,
  ConversationEventSchema,
  type ManagedDevicePathsV1,
  ManagedDevicePathsV1Schema,
  type PermissionContextV1,
  PermissionContextV1Schema,
} from "../../src/conversations/events.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import type { CaseSnapshot } from "../../src/evals/snapshot.js";
import { COMPACTION_SETTINGS } from "../../src/identity/settings.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { compactionPlan } from "../../src/runtime/context/compaction.js";
import {
  type DevicePathsPayload,
  devicePathsChange,
  devicePathsChangeFromPayload,
  devicePathsText,
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
} from "../../src/runtime/context/permission-profile.js";

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
        ...literalCases[0]!.lines.slice(0, -2),
        "Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply.",
        closing,
      ].join("\n"),
    );
  });
  it("renders allowlists and applied cloud network-off exactly", () => {
    const p = snapshot("approve-for-me", "cloud");
    p.scope!.network = { kind: "allowlist", hosts: ["api.example.com"] };
    p.scope!.outerNetwork = { kind: "allowlist", hosts: ["*.example.com"] };
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
    full.scope!.outerNetwork = { kind: "none" };
    expect(permissionContextText(full)).toBe(
      [
        ...literalCases[5]!.lines.slice(0, -3),
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
  const invalid: [string, (p: Record<string, any>) => void][] = [
    [
      "unknown top-level key",
      (p) => {
        p.grant = true;
      },
    ],
    [
      "unknown version",
      (p) => {
        p.version = 2;
      },
    ],
    [
      "omitted null field",
      (p) => {
        delete p.scopeRevision;
      },
    ],
    [
      "undefined required field",
      (p) => {
        p.authorityRevision = undefined;
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
        p.availability.reason = "No";
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
        p.availability = { state: "unprobed" };
        p.scope = null;
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
        p.scope.filesystem = { kind: "device" };
      },
    ],
    [
      "restricted environment network",
      (p) => {
        p.scope.network = { kind: "environment" };
      },
    ],
    [
      "missing readable write root",
      (p) => {
        p.scope.filesystem.writeDirectories.push("/write");
      },
    ],
    [
      "missing working root",
      (p) => {
        p.scope.filesystem.readDirectories = p.scope.filesystem.writeDirectories = ["/other"];
      },
    ],
    [
      "unsorted roots",
      (p) => {
        p.scope.filesystem.readDirectories = ["/z", "/project"];
      },
    ],
    [
      "duplicate roots",
      (p) => {
        p.scope.filesystem.readDirectories.push("/project");
      },
    ],
    [
      "too many roots",
      (p) => {
        p.scope.filesystem.readDirectories = Array.from(
          { length: 65 },
          (_, i) => `/p${i.toString().padStart(2, "0")}`,
        );
      },
    ],
    [
      "relative working root",
      (p) => {
        p.scope.workingRoot = "project";
      },
    ],
    [
      "oversized path",
      (p) => {
        p.scope.workingRoot = `/${"x".repeat(4096)}`;
      },
    ],
    [
      "dot-dot path",
      (p) => {
        p.scope.workingRoot = "/a/../project";
      },
    ],
    [
      "control path",
      (p) => {
        p.scope.workingRoot = "/a\nproject";
      },
    ],
    [
      "empty allowlist",
      (p) => {
        p.scope.network = { kind: "allowlist", hosts: [] };
      },
    ],
    [
      "unsorted hosts",
      (p) => {
        p.scope.network = { kind: "allowlist", hosts: ["z.example.com", "a.example.com"] };
      },
    ],
    [
      "duplicate hosts",
      (p) => {
        p.scope.network = { kind: "allowlist", hosts: ["a.example.com", "a.example.com"] };
      },
    ],
    [
      "unnormalized host",
      (p) => {
        p.scope.network = { kind: "allowlist", hosts: ["A.example.com"] };
      },
    ],
    [
      "too many hosts",
      (p) => {
        p.scope.network = {
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
        p.scope.network.hosts = [];
      },
    ],
    [
      "local cloud outer boundary",
      (p) => {
        p.scope.outerNetwork = { kind: "open-public" };
      },
    ],
    [
      "cloud host outer boundary",
      (p) => {
        p.scope.location = "cloud";
      },
    ],
    [
      "cloud none with allowlist",
      (p) => {
        p.scope.location = "cloud";
        p.scope.outerNetwork = { kind: "none" };
        p.scope.network = { kind: "allowlist", hosts: ["example.com"] };
      },
    ],
    [
      "cloud hosts exceeding outer ceiling",
      (p) => {
        p.scope.location = "cloud";
        p.scope.outerNetwork = { kind: "allowlist", hosts: ["other.com"] };
        p.scope.network = { kind: "allowlist", hosts: ["example.com"] };
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
    p.scope!.filesystem = {
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
      literalCases[1]!.lines.join("\n"),
      expected,
    ]);
    expect(permissionContextAt([...changes].reverse(), 4)?.seq).toBe(3);
    expect(permissionContextAt(changes, 0)).toBeUndefined();
    expect(build(changes).meta.permissionContext?.contextSeq).toBe(5);
  });
  it.each([
    [0, [expected, literalCases[1]!.lines.join("\n"), expected]],
    [1, [expected, literalCases[1]!.lines.join("\n"), expected]],
    [2, [expected, literalCases[1]!.lines.join("\n"), expected]],
    [3, [literalCases[1]!.lines.join("\n"), expected]],
    [4, [literalCases[1]!.lines.join("\n"), expected]],
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
    const call = snap.events.at(-1)!;
    const payload = call.payload as Extract<ConversationEvent, { type: "model_call" }>["payload"];
    if (kind === "missing context") snap.events = snap.events.filter((e) => e.seq !== 3);
    if (kind === "altered context")
      ((snap.events.find((e) => e.seq === 3)!.payload as PermissionContextV1).effectiveProfile =
        "request-approval"),
        ((snap.events.find((e) => e.seq === 3)!.payload as PermissionContextV1).selectedProfile =
          "request-approval");
    if (kind === "missing metadata") delete payload.request.permissionContext;
    if (kind === "altered hash") payload.request.permissionContext!.hash = "a".repeat(64);
    if (kind === "bad locator") payload.request.permissionContext!.contextSeq = 3;
    if (kind === "future locator") {
      payload.request.permissionContext!.contextSeq = callSeq + 1;
      snap.events.push({ ...snap.events[0]!, seq: callSeq + 1 });
    }
    if (kind === "null metadata") Object.assign(payload.request, { permissionContext: null });
    if (kind === "wrong version") Object.assign(payload.request.permissionContext!, { version: 2 });
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([
      "permission_profile_changed",
    ]);
  });
  it("detects altered managed paths when there is no permission locator", () => {
    const { snap, callSeq } = recording([event("device_paths", paths, 1)]);
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([]);
    (snap.events[0]!.payload as ManagedDevicePathsV1).workingRoot = "/tampered";
    expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([
      "permission_profile_changed",
    ]);
  });
  it("cannot satisfy metadata from events after min(toSeq, callSeq - 1)", () => {
    for (const futureToSeq of [false, true]) {
      const { snap, callSeq } = recording();
      const call = snap.events.at(-1)!.payload as Extract<
        ConversationEvent,
        { type: "model_call" }
      >["payload"];
      snap.events.push({ ...snap.events[0]!, seq: callSeq + 1, payload: b });
      if (futureToSeq) call.request.toSeq = 100;
      expect(reconstructRequest(snap, callSeq, { model }).drift).toEqual([]);
    }
  });
});
