import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PLATFORM_EXCLUSIONS } from "../../src/platform/exclusions.js";
import { SetupOperations } from "../../src/platform/ops/setup.ops.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { guideMarkdown } from "../../src/setup/setup-guides.service.js";

// The `setup` domain of the Platform tool (spec 2026-11-09-setup-guides-v2-design.md §12, plan
// task 13): four read operations mirroring the guide routes, no operation taking a value, and the
// human-only boundaries kept as exclusions.

function setupOps() {
  const registry = new PlatformOperations();
  const ctor = SetupOperations as unknown as new (
    r: PlatformOperations,
  ) => {
    onModuleInit(): void;
  };
  new ctor(registry).onModuleInit();
  return registry.all().filter((o) => o.id.startsWith("setup."));
}

const exclusion = (route: string) => PLATFORM_EXCLUSIONS.find((e) => e.route === route);

describe("Platform setup domain", () => {
  it("has four read operations, each mirroring its route", () => {
    const ops = setupOps();
    expect(Object.fromEntries(ops.map((o) => [o.id, [o.confirm, o.mirrors]]))).toEqual({
      "setup.guides": ["read", ["GET /api/v1/orgs/:orgId/setup-guides"]],
      "setup.read": ["read", ["GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId"]],
      "setup.status": ["read", ["GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks"]],
      "setup.check": [
        "read",
        ["POST /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks/:checkId/run"],
      ],
    });
  });

  it("the target operations say what to do when the target is gone or in another org", () => {
    for (const o of setupOps().filter((x) => x.id !== "setup.guides")) {
      const codes = (o.errors ?? []).map((e) => e.code);
      expect(codes, o.id).toEqual(
        expect.arrayContaining(["channel.not_found", "connector.not_found"]),
      );
    }
  });

  it("no setup operation takes a secret, a config or a credential", () => {
    for (const o of setupOps()) {
      const fields = Object.keys(
        (z.toJSONSchema(o.input, { io: "input" }) as { properties?: object }).properties ?? {},
      );
      for (const f of fields) {
        expect(f, `${o.id}.${f}`).not.toMatch(/secret|token|config|credential|value|password/i);
      }
    }
  });

  it("the org guide route is mirrored now; the ack routes stay human-only", () => {
    expect(exclusion("GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId")).toBeUndefined();
    expect(exclusion("GET /api/v1/orgs/:orgId/setup-guides")).toBeUndefined();
    expect(exclusion("POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack")?.category).toBe(
      "human-only",
    );
    expect(exclusion("POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack")?.category).toBe(
      "human-only",
    );
    // the super admin's preview stays internal
    expect(exclusion("GET /api/v1/admin/catalog/:itemId/guides/:guideId")?.category).toBe(
      "internal",
    );
  });
});

describe("guideMarkdown", () => {
  it("joins the blocks, writes checks as lines and fences code longer than its backticks", () => {
    const md = guideMarkdown("Create the app", [
      { kind: "markdown", text: "Open the console.\n" },
      { kind: "code", language: "yaml", title: "Manifest", text: "name: bot\n" },
      { kind: "code", language: "md", title: null, text: "```inner```" },
      { kind: "check", id: "bot-token", label: "Bot token works" },
    ]);
    expect(md).toBe(
      [
        "# Create the app",
        "",
        "Open the console.",
        "",
        "**Manifest**",
        "",
        "```yaml",
        "name: bot",
        "```",
        "",
        "````md",
        "```inner```",
        "````",
        "",
        "- [check bot-token] Bot token works",
        "",
      ].join("\n"),
    );
  });
});
