import { createHash, randomBytes } from "node:crypto";
import { SKILL_LIMITS } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { readSkillPackage, SKILL_PACKAGE_MAX_ENTRIES } from "../../src/skills/package.js";
import { makeZip, SKILL_MD } from "./zip.js";

const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

async function rejected(zip: Uint8Array): Promise<{ message: string; details: unknown[] }> {
  try {
    await readSkillPackage(zip);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe("skill.invalid_package");
    return { message: (e as ApiError).message, details: (e as ApiError).details ?? [] };
  }
  throw new Error("expected readSkillPackage to reject");
}

const text = (r: { message: string; details: unknown[] }) => JSON.stringify(r);

describe("readSkillPackage", () => {
  it("平铺的包：解出 name / description 与每个文件（大小、sha256、字节）", async () => {
    const md = SKILL_MD();
    const pkg = await readSkillPackage(
      makeZip([
        { name: "SKILL.md", data: md },
        { name: "scripts/", data: "" },
        { name: "scripts/run.py", data: "print(1)\n", method: 0 },
      ]),
    );
    expect(pkg.name).toBe("pdf-tools");
    expect(pkg.description).toBe("Work with PDFs.");
    expect(pkg.files.map(({ data, ...f }) => f)).toEqual([
      { path: "SKILL.md", size: md.length, sha256: sha(md) },
      { path: "scripts/run.py", size: 9, sha256: sha("print(1)\n") },
    ]);
    expect(Buffer.from(pkg.files[1]?.data ?? []).toString()).toBe("print(1)\n");
  });

  it("只有一层同名外层目录时去掉它；外层目录与 name 不同 → 拒绝", async () => {
    const pkg = await readSkillPackage(
      makeZip([
        { name: "pdf-tools/", data: "" },
        { name: "pdf-tools/SKILL.md", data: SKILL_MD() },
        { name: "pdf-tools/a.txt", data: "a" },
      ]),
    );
    expect(pkg.files.map((f) => f.path)).toEqual(["SKILL.md", "a.txt"]);
    const r = await rejected(
      makeZip([
        { name: "other/SKILL.md", data: SKILL_MD() },
        { name: "other/a.txt", data: "a" },
      ]),
    );
    expect(text(r)).toContain("must match the skill name");
  });

  it("忽略 __MACOSX/ 与 .DS_Store", async () => {
    const pkg = await readSkillPackage(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "__MACOSX/._SKILL.md", data: "junk" },
        { name: ".DS_Store", data: "junk" },
        { name: "docs/.DS_Store", data: "junk" },
      ]),
    );
    expect(pkg.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("缺少 SKILL.md", async () => {
    expect(text(await rejected(makeZip([{ name: "README.md", data: "x" }])))).toContain(
      "SKILL.md is required at the root",
    );
  });

  it("SKILL.md 的 frontmatter 不合法 / 不是 UTF-8", async () => {
    const r = await rejected(makeZip([{ name: "SKILL.md", data: "---\nname: Bad\n---\n" }]));
    expect(text(r)).toContain("name must be");
    expect(text(r)).toContain("description is required");
    const bin = await rejected(
      makeZip([{ name: "SKILL.md", data: new Uint8Array([0x2d, 0xff, 0xfe]) }]),
    );
    expect(text(bin)).toContain("UTF-8");
  });

  it("越界路径：..、绝对路径、反斜杠、盘符、控制字符", async () => {
    for (const name of ["../evil", "a/../../evil", "/etc/passwd", "a\\b", "C:/x", "a\u0001b"]) {
      const r = await rejected(
        makeZip([
          { name: "SKILL.md", data: SKILL_MD() },
          { name, data: "x" },
        ]),
      );
      expect(r.message, name).toBeTruthy();
    }
  });

  it("符号链接条目与非普通文件被拒绝", async () => {
    const r = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "link", data: "/etc/passwd", unixMode: 0o120777, method: 0 },
      ]),
    );
    expect(text(r)).toContain("symbolic link");
    const fifo = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "p", data: "", unixMode: 0o010644, method: 0 },
      ]),
    );
    expect(text(fifo)).toContain("regular file");
  });

  it("重复路径与只差大小写的路径", async () => {
    const dup = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "a.md", data: "1" },
        { name: "a.md", data: "2" },
      ]),
    );
    expect(text(dup)).toContain("duplicate path");
    const ci = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "Skill.md", data: "2" },
      ]),
    );
    expect(text(ci)).toContain("letter case");
  });

  it("加密条目与不是 zip 的内容", async () => {
    const enc = await rejected(makeZip([{ name: "SKILL.md", data: SKILL_MD(), encrypted: true }]));
    expect(text(enc)).toContain("encrypted");
    expect(text(await rejected(randomBytes(200)))).toContain("not a valid zip");
  });

  it("单文件超过 10MB（按声明大小提前拒绝）", async () => {
    const big = Buffer.from(randomBytes((SKILL_LIMITS.fileBytes + 2) / 2).toString("hex"));
    const r = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "big.txt", data: big },
      ]),
    );
    expect(text(r)).toContain(`larger than ${SKILL_LIMITS.fileBytes} bytes`);
  });

  it("声明的大小比实际小：按实际解压出的字节数拒绝", async () => {
    const r = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "liar.txt", data: randomBytes(5000).toString("hex"), declaredSize: 10 },
      ]),
    );
    expect(text(r)).toContain("liar.txt");
  });

  it("总量超过 50MB", { timeout: 60_000 }, async () => {
    const chunk = () => Buffer.from(randomBytes(4_500_000).toString("hex")); // 9MB，压缩比约 2
    const r = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        ...Array.from({ length: 6 }, (_, i) => ({ name: `part${i}.txt`, data: chunk() })),
      ]),
    );
    expect(text(r)).toContain(`larger than ${SKILL_LIMITS.totalBytes} bytes in total`);
  });

  it("压缩比异常（zip 炸弹）", async () => {
    const r = await rejected(
      makeZip([
        { name: "SKILL.md", data: SKILL_MD() },
        { name: "zeros.bin", data: new Uint8Array(5 * 1024 * 1024) },
      ]),
    );
    expect(text(r)).toContain("compression ratio");
  });

  it("条目数超过上限", async () => {
    const entries = Array.from({ length: SKILL_PACKAGE_MAX_ENTRIES }, (_, i) => ({
      name: `f${i}`,
      data: "",
      method: 0 as const,
    }));
    const r = await rejected(makeZip([{ name: "SKILL.md", data: SKILL_MD() }, ...entries]));
    expect(text(r)).toContain("entries");
  });
});
