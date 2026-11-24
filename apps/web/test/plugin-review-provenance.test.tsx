// The provenance fact of a plugin review is labelled as an unverified attestation: the kernel
// does not verify the SLSA signatures (packages/kernel/src/packages/provenance.ts).
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { PluginReviewBody } from "../src/components/PluginReviewBody";
import type { PluginReview } from "../src/lib/catalog";
import { renderPage } from "./support/render";

afterEach(cleanup);

const review: PluginReview = {
  name: "demo",
  version: "1.0.0",
  contentDigest: "sha256:abc",
  packageName: "@acme/plugin-demo",
  publisher: "acme",
  description: "Demo",
  skills: [],
  connectorTemplates: [],
  dependencies: [],
  source: { kind: "npm", ref: "@acme/plugin-demo@1.0.0" },
  provenance: {
    checked: true,
    repository: "https://github.com/acme/demo",
    commit: "0123456789abcdef0123456789abcdef01234567",
    workflow: ".github/workflows/release.yml",
    buildType: "slsa",
  },
  sensitive: false,
  reviewHash: "h",
};

describe("PluginReviewBody provenance", () => {
  for (const [locale, text] of [
    ["en", "https://github.com/acme/demo@0123456 (declared, not verified)"],
    ["zh", "https://github.com/acme/demo@0123456 （声明，未验证）"],
  ] as const) {
    it(`labels the attestation as unverified (${locale})`, () => {
      renderPage(<PluginReviewBody review={review} />, { locale });
      expect(document.body.textContent).toContain(text);
    });
  }
});

/** The review of a device provider plugin: one extension with a secret config field, no components. */
const deviceE2b: PluginReview = {
  ...review,
  name: "device-e2b",
  version: "0.1.0-rc.28",
  packageName: "@capybara-hq/plugin-device-e2b",
  publisher: "Capybara",
  description: "Runs devices in E2B sandboxes. It needs an E2B account and an API key.",
  extension: {
    name: "device-e2b",
    version: "0.1.0-rc.28",
    sha256: "a".repeat(64),
    action: "install",
    deployed: false,
    currentVersion: null,
    currentSha256: null,
    permissions: [
      {
        category: "provides",
        sensitive: true,
        items: ["device-provider@1"],
        entries: [{ value: "device-provider@1", sensitive: true, reason: "device_provider" }],
      },
      {
        category: "config",
        sensitive: false,
        items: ["deployment:apiKey", "deployment:domain", "deployment:limits.cpu"],
        entries: [
          { value: "deployment:apiKey", sensitive: false },
          { value: "deployment:domain", sensitive: false },
          { value: "deployment:limits.cpu", sensitive: false },
        ],
      },
      {
        category: "secrets",
        sensitive: true,
        items: ["deployment:apiKey"],
        entries: [{ value: "deployment:apiKey", sensitive: true, reason: "secrets" }],
      },
    ],
    added: [],
    addedItems: [],
    removed: [],
    warnings: [],
    reviewHash: "p1",
    sensitive: true,
  },
  sensitive: true,
};

const template = (id: string, name: string) => ({
  id,
  displayName: { en: name, zh: name },
  description: `${name} through its remote server`,
  plugin: "connector-mcp",
  connector: "mcp",
  endpoint: { url: `https://mcp.atlassian.com/v1/${id}`, transport: "http" },
  auth: { type: "oauth_client", tokenUrl: "https://auth.atlassian.com/token", scopes: [] },
  editableEndpoint: [],
  endpointChecked: true,
});

/** Three connector templates that each need an OAuth client. */
const atlassian: PluginReview = {
  ...review,
  name: "atlassian",
  packageName: null,
  connectorTemplates: [
    template("jira", "Jira"),
    template("confluence", "Confluence"),
    template("compass", "Compass"),
  ],
};

/** A translated Claude Code plugin: one skill imported, five parts ignored, the SessionStart hook. */
const claudeSessionDriver: PluginReview = {
  ...review,
  name: "session-driver",
  format: "claude-code",
  translation: {
    format: "claude-code",
    manifestPath: ".claude-plugin/plugin.json",
    sessionStart: true,
    items: [
      { group: "imported", component: "skill", name: "driver", code: "skill_imported" },
      ...["a", "b", "c", "d", "e"].map((n) => ({
        group: "ignored" as const,
        component: "file" as const,
        name: n,
        code: "other_harness" as const,
      })),
      { group: "warnings", component: "hook", name: "SessionStart", code: "session_start_hook" },
    ],
  },
};

const zh = { locale: "zh" } as const;

describe("PluginReviewBody contents", () => {
  it("the head shows the version chip and one sensitive total", () => {
    renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    expect(screen.getByText("安装 v0.1.0-rc.28")).toBeTruthy();
    expect(screen.getByText("2 项敏感")).toBeTruthy();
  });

  it("the description keeps its first sentence; the rest is behind 完整说明", async () => {
    renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    expect(screen.getByText("Runs devices in E2B sandboxes.")).toBeTruthy();
    expect(screen.queryByText(/E2B account/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "完整说明" }));
    expect(screen.getByText("It needs an E2B account and an API key.")).toBeTruthy();
  });

  it("an upgrade shows the version change in the chip", () => {
    const upgrade = {
      ...deviceE2b,
      extension: { ...deviceE2b.extension, action: "upgrade", currentVersion: "0.1.0-rc.2" },
    } as PluginReview;
    renderPage(<PluginReviewBody review={upgrade} />, zh);
    expect(screen.getByText("v0.1.0-rc.2 → v0.1.0-rc.28")).toBeTruthy();
  });

  it("config fields are chips without the deployment: prefix; secrets get a lock and no 密钥 section", () => {
    renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    const apiKey = screen.getByText("apiKey");
    expect(within(apiKey).getByRole("img", { name: "密钥" })).toBeTruthy();
    // a nested field shows as its top-level name, once
    expect(screen.getByText("limits")).toBeTruthy();
    expect(within(screen.getByText("domain")).queryByRole("img")).toBeNull();
    expect(screen.queryByText(/deployment:/)).toBeNull();
    expect(screen.queryByRole("heading", { name: "密钥" })).toBeNull();
    expect(screen.getByText("安装后在「扩展」页填写")).toBeTruthy();
    expect(screen.getByText("device-provider@1")).toBeTruthy();
  });

  it("empty sections collapse into one line", () => {
    renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    expect(screen.queryByRole("heading", { name: "技能" })).toBeNull();
    expect(screen.getByText("没有技能、连接器模板、智能体模板和依赖。")).toBeTruthy();
  });

  it("metadata: publisher, source chip with the package, build with the unverified note", () => {
    renderPage(<PluginReviewBody review={review} />, zh);
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.getByText("npm")).toBeTruthy();
    expect(screen.getByText("@acme/plugin-demo")).toBeTruthy();
    expect(screen.getByText(/@0123456 （声明，未验证）/)).toBeTruthy();
  });

  it("an org admin sees no source, build or license facts", () => {
    renderPage(
      <PluginReviewBody review={{ ...review, licenseText: "MIT License" }} audience="org" />,
      zh,
    );
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.queryByText("npm")).toBeNull();
    expect(screen.queryByText(/声明，未验证/)).toBeNull();
    expect(screen.queryByRole("button", { name: "许可证全文" })).toBeNull();
  });

  it("connector templates show a requirement tag per template, no checkbox", async () => {
    renderPage(<PluginReviewBody review={atlassian} />, zh);
    expect(screen.getAllByText("需要 OAuth 客户端")).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).toBeNull();
    // the full endpoint is folded; the host is on the row
    expect(screen.getAllByText("mcp.atlassian.com")).toHaveLength(3);
    expect(screen.queryByText("transport")).toBeNull();
    await userEvent
      .setup()
      .click(screen.getAllByRole("button", { name: "端点详情" })[0] as HTMLElement);
    expect(screen.getByText("transport")).toBeTruthy();
  });

  it("an unchecked endpoint is a warning tag; an org credential is its own tag", () => {
    const unchecked = {
      ...atlassian,
      connectorTemplates: [
        {
          ...template("gh", "GitHub"),
          auth: { type: "bearer", ownership: "org" },
          endpointChecked: false,
        },
      ],
    };
    renderPage(<PluginReviewBody review={unchecked} />, zh);
    expect(screen.getByText("需要组织凭据")).toBeTruthy();
    expect(screen.getByText("地址未检查")).toBeTruthy();
  });

  it("the translation report is a one-line summary with warnings shown", () => {
    renderPage(<PluginReviewBody review={claudeSessionDriver} />, zh);
    expect(screen.getByText("导入 1 · 转换 0 · 需要填写 0 · 忽略 5 · 警告 1")).toBeTruthy();
    expect(screen.getByText(/SessionStart/)).toBeTruthy();
    // the ignored group is in the details, closed
    expect(screen.queryByText(/other_harness|其他工具的文件/)).toBeNull();
  });
});
