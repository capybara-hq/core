import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readCatalogArchive } from "../../src/catalog/archive.js";
import { ApiError } from "../../src/errors.js";
import { pluginTgz, tgz } from "../helpers/plugin-packages.js";
import { makeZip, SKILL_MD } from "../skills/zip.js";
import {
  appTgz,
  mcpTemplate,
  SVG_ICON,
  skillPackageJson,
  skillTgz,
  skillZip,
  templateTgz,
} from "./packages.js";

const MAX = 4 * 1024 * 1024;
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

async function rejected(bytes: Uint8Array, max = MAX): Promise<string> {
  try {
    await readCatalogArchive(bytes, max);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("catalog.invalid_package");
    return JSON.stringify({ m: (e as ApiError).message, d: (e as ApiError).details });
  }
  throw new Error("expected readCatalogArchive to reject");
}

describe("readCatalogArchive: skills", () => {
  it("tgz：技能名取 SKILL.md，文件不含 package.json（带 sha256 与字节）", async () => {
    const r = await readCatalogArchive(await skillTgz(), MAX);
    expect(r.section).toEqual({ kind: "skill", publisher: "Acme", description: "PDF helpers" });
    expect(r.name).toBe("pdf-tools");
    expect(r.packageJson.name).toBe("@acme/skill-pdf-tools");
    expect(r.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    const md = r.files.find((f) => f.path === "SKILL.md");
    expect(md?.sha256).toBe(sha(SKILL_MD("pdf-tools")));
    expect(Buffer.from(md?.data ?? []).toString()).toBe(SKILL_MD("pdf-tools"));
  });

  it("zip：根目录放 package.json；单个外层目录也接受", async () => {
    for (const prefix of ["", "pdf-tools-main/"]) {
      const r = await readCatalogArchive(skillZip({ prefix }), MAX);
      expect(r.section.kind).toBe("skill");
      expect(r.files.map((f) => f.path).sort()).toEqual(["SKILL.md", "scripts/run.py"]);
    }
  });

  it("缺 SKILL.md 被拒", async () => {
    expect(await rejected(await skillTgz({ skillMd: null }))).toMatch(/SKILL\.md/);
  });

  it("SKILL.md 的 frontmatter 不合法被拒", async () => {
    expect(await rejected(await skillTgz({ skillMd: "no frontmatter" }))).toMatch(/frontmatter/);
  });

  it("tgz 路径越界被拒", async () => {
    const bytes = await tgz([
      { name: "package/package.json", data: JSON.stringify(skillPackageJson()) },
      { name: "package/SKILL.md", data: SKILL_MD() },
      { name: "package/../evil.sh", data: "rm -rf /" },
    ]);
    expect(await rejected(bytes)).toMatch(/unsafe path|under package/);
  });

  it("zip 路径越界被拒", async () => {
    const bytes = new Uint8Array(
      makeZip([
        { name: "package.json", data: JSON.stringify(skillPackageJson()) },
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "../evil.sh", data: "x" },
      ]),
    );
    expect(await rejected(bytes)).toMatch(/evil|invalid|path/i);
  });

  it("zip 里的符号链接被拒", async () => {
    const bytes = new Uint8Array(
      makeZip([
        { name: "package.json", data: JSON.stringify(skillPackageJson()) },
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "link", data: "/etc/passwd", unixMode: 0o120777 },
      ]),
    );
    expect(await rejected(bytes)).toMatch(/symbolic link/);
  });

  it("超过上限被拒（tgz 与 zip）", async () => {
    const t = await skillTgz();
    expect(await rejected(t, t.byteLength - 1)).toMatch(/larger than/);
    const z = skillZip();
    expect(await rejected(z, z.byteLength - 1)).toMatch(/larger than/);
  });

  it("不是 tgz 也不是 zip 被拒", async () => {
    expect(await rejected(new TextEncoder().encode("hello"))).toMatch(/tgz|zip/);
  });

  it("package.json 的 capybara 段不合法被拒（逐条列出）", async () => {
    const bytes = await skillTgz({ section: { publisher: "", extra: 1 } });
    const msg = await rejected(bytes);
    expect(msg).toMatch(/publisher/);
    expect(msg).toMatch(/unknown field/);
  });
});

describe("readCatalogArchive: connector templates", () => {
  it("tgz：段与模板原样返回，文件只有图标；条目名 = 去掉 scope 的包名", async () => {
    const r = await readCatalogArchive(await templateTgz(), MAX);
    expect(r.section).toMatchObject({ kind: "connector-template", template: mcpTemplate() });
    expect(r.name).toBe("github-mcp");
    expect(r.files.map((f) => f.path)).toEqual(["icon.svg"]);
    expect(r.files[0]?.sha256).toBe(sha(SVG_ICON));
  });

  it("没有图标的模板没有文件", async () => {
    const { icon: _, ...noIcon } = mcpTemplate();
    const r = await readCatalogArchive(await templateTgz({ template: noIcon, icon: null }), MAX);
    expect(r.files).toEqual([]);
  });

  it("模板里含凭据字段（token）被拒", async () => {
    const msg = await rejected(
      await templateTgz({
        template: mcpTemplate({ auth: { type: "bearer", ownership: "org", token: "s3cr3t" } }),
      }),
    );
    expect(msg).toMatch(/token/);
    expect(msg).not.toMatch(/s3cr3t/);
  });

  it("图标缺失、超过 64KB、内容不是 svg / png 被拒", async () => {
    expect(await rejected(await templateTgz({ icon: null }))).toMatch(/icon/);
    expect(
      await rejected(await templateTgz({ icon: `<svg>${"x".repeat(64 * 1024)}</svg>` })),
    ).toMatch(/icon/);
    expect(await rejected(await templateTgz({ icon: "not an image" }))).toMatch(/icon/);
  });
});

describe("readCatalogArchive: other kinds", () => {
  it("插件包不由它读（交给插件包流程）", async () => {
    expect(
      await rejected(await pluginTgz({ manifest: { name: "demo-pkg" }, extension: {} })),
    ).toMatch(/plugin/);
  });

  it("应用包：返回段（内容留给 T25），没有文件", async () => {
    const r = await readCatalogArchive(await appTgz(), MAX);
    expect(r.section).toEqual({ kind: "app", manifest: "app.yaml" });
    expect(r.files).toEqual([]);
  });

  it("插件 / 应用只接受 tgz，zip 被拒", async () => {
    const bytes = new Uint8Array(
      makeZip([
        {
          name: "package.json",
          data: JSON.stringify({
            name: "x-app",
            version: "1.0.0",
            capybara: { kind: "app", manifest: "app.yaml" },
          }),
        },
      ]),
    );
    expect(await rejected(bytes)).toMatch(/tgz/);
  });
});
