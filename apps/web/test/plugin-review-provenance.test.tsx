// The provenance fact of a plugin review is labelled as an unverified attestation: the kernel
// does not verify the SLSA signatures (packages/kernel/src/packages/provenance.ts). The rest covers
// the plugin contents view as the review draws it (plugin contents spec).
import { describeNestedBox, findNestedBoxes } from "@capybara-hq/design/reference";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import enMessages from "../messages/en.json";
import zhMessages from "../messages/zh.json";
import { PlatformUpdatePreviewBody } from "../src/components/PlatformUpdateDialog";
import { PluginReviewBody } from "../src/components/PluginReviewBody";
import { fromReview } from "../src/components/plugin-contents/from-review";
import { firstSentence } from "../src/components/plugin-contents/model";
import { PluginContents } from "../src/components/plugin-contents/PluginContents";
import type { PlatformUpdatePreview, PluginReview } from "../src/lib/catalog";
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

const R = zhMessages.catalog.admin.review;
const C = zhMessages.catalog.components;

describe("PluginReviewBody provenance", () => {
  for (const [locale, msgs] of [
    ["en", enMessages],
    ["zh", zhMessages],
  ] as const) {
    it(`labels the attestation as unverified (${locale})`, () => {
      renderPage(<PluginReviewBody review={review} />, { locale });
      const build = screen.getByText("https://github.com/acme/demo@0123456");
      expect(build.parentElement?.textContent).toContain(msgs.catalog.admin.review.unverified);
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
  icon: null,
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

  it("the description shows its first sentence and 完整说明; opening shows all of it in place", async () => {
    renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    expect(screen.getByText("Runs devices in E2B sandboxes.")).toBeTruthy();
    expect(screen.queryByText(/E2B account/)).toBeNull();
    const more = screen.getByRole("button", { name: R.fullDescription });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await userEvent.setup().click(more);
    // the whole description, not the remainder under a guide
    expect(screen.getByText(deviceE2b.description)).toBeTruthy();
    expect(screen.getByRole("button", { name: R.collapse })).toBeTruthy();
  });

  it("a one-sentence description has no 完整说明", () => {
    renderPage(<PluginReviewBody review={review} />, zh);
    expect(screen.getByText("Demo")).toBeTruthy();
    expect(screen.queryByRole("button", { name: R.fullDescription })).toBeNull();
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

  it("every counted sensitive item is drawn in warn: the total equals the warn marks", () => {
    const { container } = renderPage(<PluginReviewBody review={deviceE2b} />, zh);
    expect(screen.getByText("2 项敏感")).toBeTruthy();
    // the sensitive provides row (one mark) and the secret config chip (warn, with its lock)
    const marks = [...container.querySelectorAll('.cb-badge[data-tone="warn"]')].filter(
      (b) => !/项敏感$/.test(b.textContent ?? ""),
    );
    expect(marks).toHaveLength(2);
    expect(screen.getByText("apiKey").getAttribute("data-tone")).toBe("warn");
    expect(screen.getByText("domain").getAttribute("data-tone")).toBe("default");
  });

  it("each migration warning counts as one sensitive item and is drawn in warn", () => {
    const warned = {
      ...deviceE2b,
      extension: {
        ...deviceE2b.extension,
        warnings: [
          {
            kind: "destructive_migration",
            sensitive: true,
            file: "migrations/0002_drop.sql",
            line: 3,
            statement: "DROP TABLE notes",
          },
          {
            kind: "dynamic_sql",
            sensitive: true,
            file: "migrations/0003_do.sql",
            line: 1,
            statement: "DO $$ BEGIN END $$",
          },
        ],
      },
    } as PluginReview;
    renderPage(<PluginReviewBody review={warned} />, zh);
    // two permission entries plus two warnings
    expect(screen.getByText("4 项敏感")).toBeTruthy();
    const w = zhMessages.extensions.review;
    for (const [kind, file, line] of [
      ["destructive_migration", "migrations/0002_drop.sql", 3],
      ["dynamic_sql", "migrations/0003_do.sql", 1],
    ] as const) {
      const place = w.at.replace("{file}", file).replace("{line}", String(line));
      const row = screen.getByText(`${w.warning[kind]} · ${place}`);
      expect(row.closest('[data-tone="warn"]')).not.toBeNull();
    }
    // the warnings block carries the sensitive mark
    const block = screen.getByText(w.warnings).closest("li") as HTMLElement;
    expect(within(block).getByText(zhMessages.extensions.sensitive)).toBeTruthy();
  });

  it("a kept extension's header chip shows the plugin version, not the extension's", () => {
    const kept = {
      ...deviceE2b,
      extension: { ...deviceE2b.extension, action: "keep", currentVersion: "0.0.9" },
    } as PluginReview;
    renderPage(<PluginReviewBody review={kept} />, zh);
    // the head chip names the plugin version, the extension's own line its kept version
    expect(screen.getByText(R.action.keep.replace("{version}", "v0.1.0-rc.28"))).toBeTruthy();
    expect(screen.getByText(R.action.keep.replace("{version}", "v0.0.9"))).toBeTruthy();
  });

  it("on an update, a provides or config permission added gets the 新增 mark", () => {
    const upgrade = {
      ...deviceE2b,
      extension: {
        ...deviceE2b.extension,
        action: "upgrade",
        currentVersion: "0.1.0-rc.2",
        addedItems: [
          { value: "provides:device-provider@1", sensitive: true, reason: "device_provider" },
          { value: "config.deployment:domain", sensitive: false },
        ],
        added: ["provides:device-provider@1", "config.deployment:domain"],
      },
    } as PluginReview;
    renderPage(<PluginReviewBody review={upgrade} />, zh);
    expect(screen.getAllByText("新增")).toHaveLength(2);
    expect(screen.getByText("device-provider@1").parentElement?.textContent).toContain("新增");
    expect(screen.getByText("domain").parentElement?.textContent).toContain("新增");
    expect(screen.getByText("apiKey").parentElement?.textContent).not.toContain("新增");
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
    const build = screen.getByText("https://github.com/acme/demo@0123456");
    expect(build.parentElement?.textContent).toContain(R.unverified);
  });

  it("an org admin sees no source, build or license facts", () => {
    renderPage(
      <PluginReviewBody review={{ ...review, licenseText: "MIT License" }} audience="org" />,
      zh,
    );
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.queryByText("npm")).toBeNull();
    expect(screen.queryByText(R.build)).toBeNull();
    expect(screen.queryByText(R.facts.license)).toBeNull();
    expect(screen.queryByRole("button", { name: R.licenseText })).toBeNull();
  });

  it("connector templates show a requirement tag per template, no checkbox", async () => {
    renderPage(<PluginReviewBody review={atlassian} />, zh);
    expect(screen.getAllByText("需要 OAuth 客户端")).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).toBeNull();
    // the full endpoint is folded; the host is on the row and is the toggle (no endpoint details line)
    const hosts = screen.getAllByRole("button", { name: "mcp.atlassian.com" });
    expect(hosts).toHaveLength(3);
    expect(screen.queryByRole("button", { name: R.endpointDetails })).toBeNull();
    expect(screen.queryByText("transport")).toBeNull();
    await userEvent.setup().click(hosts[0] as HTMLElement);
    expect(screen.getByText("transport")).toBeTruthy();
  });

  it("a template row leads with the template's icon, else its initial", () => {
    const icons = {
      ...atlassian,
      connectorTemplates: [
        { ...template("jira", "Jira"), icon: "data:image/png;base64,AA==" },
        template("confluence", "Confluence"),
      ],
    };
    renderPage(<PluginReviewBody review={icons} />, zh);
    const list = screen.getByRole("list", { name: "连接器模板" });
    const [jira, confluence] = within(list).getAllByRole("listitem");
    expect(jira?.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(confluence?.querySelector("img")).toBeNull();
  });

  it("an unchecked endpoint is a warning tag; an org credential is its own tag", () => {
    const unchecked = {
      ...atlassian,
      connectorTemplates: [
        {
          ...template("gh", "GitHub"),
          auth: { type: "bearer", ownership: "org" },
          endpointChecked: false,
          icon: null,
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

describe("PluginReviewBody rows", () => {
  it("agent templates: name and tier, a tools row with inherit and removed chips, instructions folded", async () => {
    const agents: PluginReview = {
      ...review,
      agentTemplates: [
        {
          name: "reviewer",
          path: "agents/reviewer.md",
          description: "Reviews work.",
          instructions: "Review it carefully.",
          model: "fast",
          tools: ["Read", "Grep"],
          disallowedTools: ["Bash"],
          connectors: [],
        },
        {
          name: "planner",
          path: "agents/planner.md",
          description: "Plans.",
          instructions: "Plan.",
          model: "inherit",
          connectors: [],
        },
      ],
    };
    renderPage(<PluginReviewBody review={agents} />, zh);
    const reviewer = screen.getByRole("group", { name: "reviewer" });
    expect(within(reviewer).getByText("快速档")).toBeTruthy();
    expect(within(reviewer).getByText("工具")).toBeTruthy();
    expect(within(reviewer).getByText("Read")).toBeTruthy();
    expect(within(reviewer).getByText("Grep")).toBeTruthy();
    expect(within(reviewer).getByText(C.agentToolsRemoved.replace("{tools}", "Bash"))).toBeTruthy();
    expect(within(reviewer).queryByText("Review it carefully.")).toBeNull();
    await userEvent
      .setup()
      .click(within(reviewer).getByRole("button", { name: C.agentInstructions }));
    expect(within(reviewer).getByText("Review it carefully.")).toBeTruthy();
    const planner = screen.getByRole("group", { name: "planner" });
    expect(within(planner).getByText(C.agentToolsInherit)).toBeTruthy();
    expect(screen.queryByText("需要")).toBeNull();
  });

  it("an agent template's 需要 row names the templates it uses and a described need's label and host", () => {
    const agents: PluginReview = {
      ...atlassian,
      agentTemplates: [
        {
          name: "triager",
          path: "agents/triager.md",
          description: "Triages issues.",
          instructions: "Triage.",
          model: "standard",
          connectors: [
            { template: "jira" },
            { template: "atlassian:confluence" },
            { template: "other:wiki" },
            {
              needs: { label: "Docs", endpoint: "https://docs.example.com/mcp", protocol: "mcp" },
            },
          ],
        },
      ],
    };
    renderPage(<PluginReviewBody review={agents} />, zh);
    const triager = screen.getByRole("group", { name: "triager" });
    expect(within(triager).getByText("需要")).toBeTruthy();
    expect(within(triager).getByText("Jira")).toBeTruthy();
    expect(within(triager).getByText("Confluence")).toBeTruthy();
    expect(within(triager).getByText("other:wiki")).toBeTruthy();
    expect(
      within(triager).getByText(
        R.agentNeedsDescribed.replace("{label}", "Docs").replace("{host}", "docs.example.com"),
      ),
    ).toBeTruthy();
  });

  it("skills: name, file count, description and a hidden-characters tag", () => {
    const skills: PluginReview = {
      ...review,
      skills: [
        { name: "pdf", description: "PDF helpers", body: "# PDF", path: "skills/pdf", files: 2 },
        { name: "odd", description: "Odd\u202e", body: "# Odd", path: "skills/odd", files: 1 },
      ],
    };
    renderPage(<PluginReviewBody review={skills} />, zh);
    const pdf = screen.getByRole("group", { name: "pdf" });
    expect(within(pdf).getByText("2 个文件")).toBeTruthy();
    expect(within(pdf).getByText("PDF helpers")).toBeTruthy();
    expect(within(pdf).queryByText("含隐藏字符")).toBeNull();
    const odd = screen.getByRole("group", { name: "odd" });
    expect(within(odd).getByText("含隐藏字符")).toBeTruthy();
  });
});

describe("PluginReviewBody license fact", () => {
  it("许可证 is a fact with the SPDX name; 全文 opens a Dialog with the text, one box", async () => {
    renderPage(
      <PluginReviewBody review={{ ...review, license: "MIT", licenseText: "MIT License\u202e" }} />,
      zh,
    );
    const row = screen.getByText(R.facts.license).parentElement as HTMLElement;
    expect(within(row).getByText("MIT")).toBeTruthy();
    // the text is not on the page until the full-text link opens it
    expect(screen.queryByText(/MIT License/)).toBeNull();
    expect(within(row).getByText(R.hiddenCharacters)).toBeTruthy();
    await userEvent.setup().click(within(row).getByRole("button", { name: R.licenseText }));
    const dialog = await screen.findByRole("dialog", { name: R.translation.license });
    expect(within(dialog).getByText(/MIT License/)).toBeTruthy();
    expect(within(dialog).getByText(R.translation.bidiWarning)).toBeTruthy();
    expect(findNestedBoxes(document.body).map(describeNestedBox)).toEqual([]);
  });

  it("without an SPDX name the fact says LICENSE", () => {
    renderPage(<PluginReviewBody review={{ ...review, licenseText: "Apache License" }} />, zh);
    const row = screen.getByText(R.facts.license).parentElement as HTMLElement;
    expect(within(row).getByText("LICENSE")).toBeTruthy();
    expect(within(row).getByRole("button", { name: R.licenseText })).toBeTruthy();
  });

  it("a license too large to keep says so, with no 全文", () => {
    renderPage(<PluginReviewBody review={{ ...review, licenseTruncated: true }} />, zh);
    const row = screen.getByText(R.facts.license).parentElement as HTMLElement;
    expect(within(row).getByText("LICENSE")).toBeTruthy();
    expect(within(row).getByText(R.translation.licenseTruncated)).toBeTruthy();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("no license: no 许可证 fact", () => {
    renderPage(<PluginReviewBody review={review} />, zh);
    expect(screen.queryByText(R.facts.license)).toBeNull();
  });
});

describe("PluginReviewBody extension note and inline texts", () => {
  it("an extension without config has no note line", () => {
    const noConfig = {
      ...deviceE2b,
      extension: {
        ...deviceE2b.extension,
        permissions: deviceE2b.extension?.permissions.filter((g) => g.category === "provides"),
      },
    } as PluginReview;
    renderPage(<PluginReviewBody review={noConfig} />, zh);
    expect(screen.getByText("device-provider@1")).toBeTruthy();
    expect(screen.queryByText(R.configAfterInstall)).toBeNull();
  });

  it("a skill's SKILL.md opens inline under its row", async () => {
    const skills: PluginReview = {
      ...review,
      skills: [
        { name: "pdf", description: "PDF", body: "# PDF body", path: "skills/pdf", files: 1 },
      ],
    };
    renderPage(<PluginReviewBody review={skills} />, zh);
    const pdf = screen.getByRole("group", { name: "pdf" });
    expect(within(pdf).queryByText("# PDF body")).toBeNull();
    await userEvent.setup().click(within(pdf).getByRole("button", { name: R.skillBody }));
    expect(within(pdf).getByText("# PDF body")).toBeTruthy();
  });

  it("dependencies read 「{name} 将使用 {version}」 on the platform", () => {
    const deps: PluginReview = {
      ...review,
      dependencies: [{ name: "crm-core", range: "^1.0.0", resolved: "1.2.0" }],
    };
    renderPage(<PluginReviewBody review={deps} />, zh);
    expect(
      screen.getByText(
        C.dependencyResolved.replace("{name}", "crm-core").replace("{version}", "v1.2.0"),
      ),
    ).toBeTruthy();
  });
});

describe("PluginContents stages, audiences and the row slots", () => {
  const model = (r: PluginReview) => fromReview(r, { locale: "zh" });

  it("enable: the plain version, the after-enabling note, 同时安装, no source facts for an org", () => {
    const deps: PluginReview = {
      ...deviceE2b,
      dependencies: [{ name: "crm-core", range: "^1.0.0", resolved: "1.2.0" }],
    };
    renderPage(<PluginContents model={model(deps)} audience="org" stage="enable" />, zh);
    expect(screen.getByText("v0.1.0-rc.28")).toBeTruthy();
    expect(screen.getByText(R.configAfterEnable)).toBeTruthy();
    expect(screen.queryByText(R.configAfterInstall)).toBeNull();
    expect(screen.getByRole("heading", { name: C.dependenciesWith })).toBeTruthy();
    expect(screen.getByText("crm-core")).toBeTruthy();
    expect(screen.getByText(R.facts.publisher)).toBeTruthy();
    expect(screen.queryByText(R.facts.origin)).toBeNull();
    expect(screen.queryByText(R.build)).toBeNull();
  });

  it("detail: the plain version and no note line", () => {
    renderPage(<PluginContents model={model(deviceE2b)} audience="platform" stage="detail" />, zh);
    expect(screen.getByText("v0.1.0-rc.28")).toBeTruthy();
    expect(screen.queryByText(R.configAfterInstall)).toBeNull();
    expect(screen.queryByText(R.configAfterEnable)).toBeNull();
  });

  it("an org's own upload of a Claude Code package shows the translation summary", () => {
    renderPage(<PluginReviewBody review={claudeSessionDriver} audience="org" />, zh);
    expect(screen.getByRole("region", { name: R.translation.title })).toBeTruthy();
    expect(screen.getByText("导入 1 · 转换 0 · 需要填写 0 · 忽略 5 · 警告 1")).toBeTruthy();
  });

  it("an org reading a plugin page or its enable page gets no translation summary", () => {
    for (const stage of ["enable", "detail"] as const) {
      renderPage(
        <PluginContents model={model(claudeSessionDriver)} audience="org" stage={stage} />,
        zh,
      );
      expect(screen.queryByRole("region", { name: R.translation.title })).toBeNull();
      cleanup();
    }
  });

  it("the extension's state slot is drawn on its title line", () => {
    const m = model(deviceE2b);
    const withState = {
      ...m,
      ...(m.extension && { extension: { ...m.extension, state: <span>待配置</span> } }),
    };
    renderPage(<PluginContents model={withState} audience="org" stage="enable" />, zh);
    const head = screen
      .getByRole("region", { name: "device-e2b" })
      .querySelector('[data-part="subsection-head"]');
    expect(head?.textContent).toContain("待配置");
  });

  it("each row draws its change mark and the surface's trailing slot; themes have a section", () => {
    const m = model({
      ...atlassian,
      skills: [{ name: "pdf", description: "", body: "#", path: "p", files: 1 }],
    });
    const marked = {
      ...m,
      skills: m.skills.map((s) => ({ ...s, mark: "removed" as const })),
      templates: m.templates.map((c, i) =>
        i === 0 ? { ...c, mark: "added" as const, trailing: <span>可用</span> } : c,
      ),
      themes: [{ kind: "theme" as const, key: "neon", name: "Neon", mark: "upgrade" as const }],
    };
    renderPage(<PluginContents model={marked} audience="platform" stage="update" />, zh);
    const U = zhMessages.catalog.update.change;
    const pdf = screen.getByRole("group", { name: "pdf" });
    expect(within(pdf).getByText(U.removed).getAttribute("data-tone")).toBe("warn");
    const [jira] = within(screen.getByRole("list", { name: C.templates })).getAllByRole("listitem");
    expect(within(jira as HTMLElement).getByText(U.added)).toBeTruthy();
    expect(within(jira as HTMLElement).getByText("可用")).toBeTruthy();
    const themes = screen.getByRole("list", { name: C.themes });
    expect(within(themes).getByText("Neon")).toBeTruthy();
    expect(within(themes).getByText(U.upgrade)).toBeTruthy();
  });
});

describe("firstSentence", () => {
  it("cuts at a CJK full stop or a period before a new sentence, not at an abbreviation", () => {
    expect(firstSentence("运行设备。需要账号。")).toBe("运行设备。");
    expect(firstSentence("Runs devices. It needs a key.")).toBe("Runs devices.");
    expect(firstSentence("Tools, e.g. linters, for v1. builds. Then more.")).toBe(
      "Tools, e.g. linters, for v1. builds.",
    );
    expect(firstSentence("One sentence.")).toBe("One sentence.");
    expect(firstSentence("No stop")).toBe("No stop");
  });
});

describe("PlatformUpdatePreviewBody header and chips", () => {
  it("shows the name with a version chip and a chip per component change", () => {
    const preview = {
      itemId: "i1",
      name: "neon",
      from: "0.1.0-rc.2",
      to: "0.1.0-rc.4",
      components: [
        { kind: "skill", name: "a", change: "upgrade", from: "1", to: "2", pinnedOrgs: [] },
        { kind: "skill", name: "b", change: "removed", from: "1", to: null, pinnedOrgs: [] },
      ],
      extension: null,
      connectorOrgs: [],
      scopeInstalls: [],
      diffHash: "h",
    } as unknown as PlatformUpdatePreview;
    renderPage(<PlatformUpdatePreviewBody preview={preview} orgName={() => undefined} />, zh);
    expect(screen.getByText("neon")).toBeTruthy();
    const chip = screen.getByText("v0.1.0-rc.2 → v0.1.0-rc.4");
    expect(chip.getAttribute("data-part") ?? chip.className).toContain("badge");
    const up = screen.getByText("升级");
    expect(up.className).toContain("badge");
    expect(up.getAttribute("data-tone")).toBe("default");
    const removed = screen.getByText(zhMessages.catalog.update.change.removed);
    expect(removed.getAttribute("data-tone")).toBe("warn");
  });
});
