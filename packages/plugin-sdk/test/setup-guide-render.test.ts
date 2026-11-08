import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  type RenderedSetupGuideDoc,
  renderSetupGuide,
  type SetupGuideAudience,
  type SetupGuidePlace,
  setupGuideHash,
} from "../src/index.js";

const F = "```";

const doc = (...lines: string[]) => ["# Create the Slack app", "", ...lines, ""].join("\n");

const render = (
  source: string,
  over: {
    place?: SetupGuidePlace;
    mode?: string | null;
    audience?: SetupGuideAudience;
    values?: Record<string, string | null | undefined>;
  } = {},
): RenderedSetupGuideDoc =>
  renderSetupGuide(source, {
    place: over.place ?? "channel-connection",
    mode: over.mode ?? null,
    audience: over.audience ?? "admin",
    values: over.values ?? {},
  });

const md = (r: RenderedSetupGuideDoc) =>
  r.blocks
    .filter((b) => b.kind === "markdown")
    .map((b) => (b as { text: string }).text)
    .join("\n\n");

const parseMd = (text: string): Root =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const all = (node: Root | RootContent): (Root | RootContent)[] => [
  node,
  ...("children" in node ? node.children.flatMap((c) => all(c)) : []),
];

const slack = doc(
  "Common intro.",
  "",
  "::: mode long_connection",
  "Socket Mode text.",
  "",
  `${F}yaml title="App manifest (Socket Mode)"`,
  'name: "{{connectionName}}"',
  "socket_mode_enabled: true",
  F,
  "::check app-token App-level token works",
  ":::",
  "",
  "::: mode webhook",
  "Webhook text at `{{webhookUrl}}`.",
  "",
  `${F}yaml title="App manifest (webhook)"`,
  'name: "{{connectionName}}"',
  'request_url: "{{webhookUrl}}"',
  F,
  "::check capybara:webhook-public Webhook address is reachable",
  ":::",
  "",
  "## Install",
  "",
  "Copy the token.",
  "::check bot-token Bot token works",
);

describe("renderSetupGuide", () => {
  it("selects sections by mode and audience", () => {
    const values = { connectionName: "Sales", webhookUrl: "https://x.example/channels/webhook/c1" };
    const w = render(slack, { mode: "webhook", values });
    expect(w.title).toBe("Create the Slack app");
    expect(w.modes).toEqual(["long_connection", "webhook"]);
    expect(w.audiences).toEqual([]);
    expect(md(w)).toContain("Common intro.");
    expect(md(w)).toContain("Webhook text at `https://x.example/channels/webhook/c1`.");
    expect(md(w)).not.toContain("Socket Mode text");
    expect(md(w)).not.toContain("Create the Slack app");
    expect(w.checks).toEqual([
      { id: "capybara:webhook-public", label: "Webhook address is reachable", source: "kernel" },
      { id: "bot-token", label: "Bot token works", source: "plugin" },
    ]);
    const l = render(slack, { mode: "long_connection", values });
    expect(md(l)).toContain("Socket Mode text.");
    expect(md(l)).not.toContain("Webhook text");
    expect(l.checks.map((c) => c.id)).toEqual(["app-token", "bot-token"]);
    const none = render(slack, { values });
    expect(none.checks.map((c) => c.id)).toEqual(["bot-token"]);

    const ct = doc(
      "For all.",
      "::: audience admin",
      "Admin text.",
      ":::",
      "::: audience member",
      "Member text.",
      "::check capybara:connector-connected Connected",
      ":::",
    );
    const admin = render(ct, { place: "connector-template", audience: "admin" });
    const member = render(ct, { place: "connector-template", audience: "member" });
    expect(admin.audiences).toEqual(["admin", "member"]);
    expect(admin.modes).toEqual([]);
    expect(md(admin)).toContain("Admin text.");
    expect(md(admin)).not.toContain("Member text.");
    expect(admin.checks).toEqual([]);
    expect(md(member)).toContain("For all.");
    expect(md(member)).toContain("Member text.");
    expect(member.checks.map((c) => c.id)).toEqual(["capybara:connector-connected"]);
  });

  describe("escapes hostile values in every context", () => {
    const hostile = 'x`y"z\n[a](javascript:alert(1)) <script>{{orgName}}';
    const flat = 'x`y"z [a](javascript:alert(1)) <script>{{orgName}}';
    const values = { connectionName: hostile, orgName: "Acme" };

    it("in a paragraph", () => {
      const r = render(doc("{{connectionName}}"), { values });
      const tree = parseMd(md(r));
      const texts = all(tree).filter((n) => n.type === "text");
      expect(texts).toHaveLength(1);
      expect((texts[0] as { value: string }).value).toBe(flat);
      expect(all(tree).some((n) => n.type === "link" || n.type === "html")).toBe(false);
    });

    it("in a heading, emphasis and a table cell", () => {
      const r = render(
        doc(
          "## {{connectionName}}",
          "",
          "*{{connectionName}}*",
          "",
          "| a |",
          "|---|",
          "| {{connectionName}} |",
        ),
        { values },
      );
      const tree = parseMd(md(r));
      const values_ = all(tree)
        .filter((n) => n.type === "text")
        .map((n) => (n as { value: string }).value);
      expect(values_).toEqual([flat, flat, "a", flat]);
      expect(all(tree).some((n) => n.type === "link" || n.type === "html")).toBe(false);
    });

    it("in inline code", () => {
      const r = render(doc("`{{connectionName}}`"), { values });
      const codes = all(parseMd(md(r))).filter((n) => n.type === "inlineCode");
      expect(codes).toHaveLength(1);
      expect((codes[0] as { value: string }).value).toBe(flat);
    });

    it("in a yaml fence inside double quotes", () => {
      const r = render(doc(`${F}yaml`, 'name: "{{connectionName}}"', F), { values });
      const code = r.blocks.find((b) => b.kind === "code") as { text: string };
      expect(parseYaml(code.text)).toEqual({ name: hostile });
    });

    it("in a json fence", () => {
      const r = render(doc(`${F}json`, '{ "name": "{{connectionName}}" }', F), { values });
      const code = r.blocks.find((b) => b.kind === "code") as { text: string };
      expect(JSON.parse(code.text)).toEqual({ name: hostile });
    });

    it("values holding sentinel or marker characters stay literal", () => {
      const r = render(doc("{{connectionName}} and {{orgName}}"), {
        values: { connectionName: "a\uE0001\uE001b\uE0020\uE003", orgName: "Acme" },
      });
      expect(md(r)).toBe("a\uE0001\uE001b\uE0020\uE003 and Acme");
      expect(r.checks).toEqual([]);
    });

    it("a url variable that is not http(s) is no link", () => {
      const r = render(doc("[x]({{publicUrl}})", "", "<{{publicUrl}}>"), {
        values: { publicUrl: "javascript:alert(1)" },
      });
      expect(all(parseMd(md(r))).some((n) => n.type === "link")).toBe(false);
    });

    it("in a sh fence", () => {
      const r = render(doc(`${F}sh`, "echo {{connectionName}}", F), { values });
      const code = r.blocks.find((b) => b.kind === "code") as { text: string };
      expect(code.text).toBe(`echo ${flat}`);
      expect(code.text).not.toContain("\n");
    });
  });

  it("applies the link policy", () => {
    const values = { publicUrl: "http://localhost:3000", connectionName: "https://evil.example" };
    const links = (r: RenderedSetupGuideDoc) =>
      all(parseMd(md(r)))
        .filter((n) => n.type === "link")
        .map((n) => (n as { url: string }).url);
    expect(links(render(doc("[docs](https://docs.example/a)"), { values }))).toEqual([
      "https://docs.example/a",
    ]);
    for (const dest of [
      "http://docs.example",
      "mailto:a@b.example",
      "./README.md",
      "javascript:alert(1)",
    ]) {
      const r = render(doc(`[click](${dest})`), { values });
      expect(links(r)).toEqual([]);
      expect(md(r)).toContain("click");
    }
    expect(links(render(doc("<http://plain.example>"), { values }))).toEqual([]);
    expect(links(render(doc("[x]({{publicUrl}}/admin)"), { values }))).toEqual([
      "http://localhost:3000/admin",
    ]);
    expect(links(render(doc("<{{publicUrl}}>"), { values }))).toEqual(["http://localhost:3000"]);
    // a text variable in a destination stays literal and is no link
    const t = render(doc("[x]({{connectionName}})"), { values });
    expect(links(t)).toEqual([]);
    // link titles are dropped
    expect(md(render(doc('[x](https://a.example "Title")'), { values }))).not.toContain("Title");
  });

  it("renders raw HTML as text and images as links or alt text", () => {
    const r = render(doc("Hello <b>x</b>", "", "<div>block</div>"));
    const tree = parseMd(md(r));
    expect(all(tree).some((n) => n.type === "html")).toBe(false);
    expect(md(r)).toContain("\\<b>x\\</b>");
    const img = render(doc("![logo](https://a.example/l.png)", "", "![local](./l.png)"));
    const t = parseMd(md(img));
    expect(all(t).some((n) => n.type === "image")).toBe(false);
    const link = all(t).find((n) => n.type === "link") as { url: string };
    expect(link.url).toBe("https://a.example/l.png");
    expect(md(img)).toContain("local");
  });

  it("resolves reference links and drops definitions", () => {
    const r = render(
      doc("See [docs][d] and [bad][b].", "", "[d]: https://docs.example", "[b]: ./x"),
    );
    const tree = parseMd(md(r));
    const links = all(tree).filter((n) => n.type === "link") as { url: string }[];
    expect(links.map((l) => l.url)).toEqual(["https://docs.example"]);
    expect(all(tree).some((n) => n.type === "definition")).toBe(false);
  });

  it("splits blocks", () => {
    const r = render(
      doc(
        "Before one.",
        "",
        "Before two.",
        `${F}yaml title="App manifest"`,
        "a: 1",
        F,
        "Between.",
        "::check bot-token Bot token works",
        "After.",
      ),
    );
    expect(r.blocks).toEqual([
      { kind: "markdown", text: "Before one.\n\nBefore two." },
      { kind: "code", language: "yaml", title: "App manifest", text: "a: 1" },
      { kind: "markdown", text: "Between." },
      { kind: "check", id: "bot-token", label: "Bot token works" },
      { kind: "markdown", text: "After." },
    ]);
  });

  it("leaves unknown and unresolved variables as written", () => {
    const r = render(
      doc("Secret {{appSecret}} at `{{webhookUrl}}` for {{connectionName}} {{publicUrl}}"),
      {
        values: { webhookUrl: null, connectionName: "Sales" },
      },
    );
    expect(md(r)).toContain("{{appSecret}}");
    expect(md(r)).toContain("`{{webhookUrl}}`");
    expect(md(r)).toContain("Sales");
    expect(r.unresolved).toEqual(["publicUrl", "webhookUrl"]);
  });

  it("is deterministic", () => {
    const values = { connectionName: "Sales", webhookUrl: "https://x.example/w" };
    expect(JSON.stringify(render(slack, { mode: "webhook", values }))).toBe(
      JSON.stringify(render(slack, { mode: "webhook", values })),
    );
  });
});

describe("setupGuideHash", () => {
  const h = (
    source: string,
    mode: string | null = "webhook",
    audience: SetupGuideAudience = "admin",
  ) =>
    setupGuideHash(source, { place: "channel-connection", guideId: "slack-app", mode, audience });

  it("is a sha256 hex digest", () => {
    expect(h(slack)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("covers code blocks and check lines only", () => {
    const base = h(slack);
    expect(h(slack.replace("Common intro.", "A new intro."))).toBe(base);
    expect(h(slack.replace("## Install", "## Install the app"))).toBe(base);
    expect(h(slack.replace("Bot token works", "The bot token works"))).toBe(base);
    expect(h(slack.replace(/\n/g, "\r\n"))).toBe(base);
    // a code change in the other mode is not this mode's drift
    expect(h(slack.replace("socket_mode_enabled: true", "socket_mode_enabled: yes"))).toBe(base);

    expect(
      h(slack.replace('request_url: "{{webhookUrl}}"', 'request_url: "{{publicUrl}}"')),
    ).not.toBe(base);
    expect(h(`${slack}\n${F}text\nmore\n${F}\n`)).not.toBe(base);
    expect(h(`${slack}\n::check bot-scopes Scopes\n`)).not.toBe(base);
    expect(h(slack.replace("::check bot-token Bot token works", ""))).not.toBe(base);
  });

  it("differs per mode, audience, place and guide", () => {
    expect(h(slack, "webhook")).not.toBe(h(slack, "long_connection"));
    expect(h(slack, "webhook", "admin")).not.toBe(h(slack, "webhook", "member"));
    expect(
      setupGuideHash(slack, {
        place: "channel-connection",
        guideId: "other",
        mode: "webhook",
        audience: "admin",
      }),
    ).not.toBe(h(slack));
  });
});
