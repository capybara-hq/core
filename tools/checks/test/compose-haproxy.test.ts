import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkComposeHaproxy } from "../src/compose-haproxy.js";

const dir = fileURLToPath(new URL("../fixtures/compose-haproxy/", import.meta.url));
const cfg = join(dir, "haproxy.cfg");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("checkComposeHaproxy", () => {
  it("passes when the inline block matches the file, comments and blank lines aside", () => {
    expect(checkComposeHaproxy(join(dir, "clean.yaml"), cfg)).toEqual([]);
  });

  it("reports the first differing line", () => {
    const f = checkComposeHaproxy(join(dir, "drift.yaml"), cfg);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["compose-haproxy-drift", 8]]);
    expect(f[0]?.message).toContain("http-request allow if p_ping");
  });

  it("reports an unescaped $ (compose would interpolate it)", () => {
    const f = checkComposeHaproxy(join(dir, "dollar.yaml"), cfg);
    expect(f.map((x) => [x.rule, x.line])).toEqual([["compose-haproxy-dollar", 7]]);
  });

  it("reports a missing inline block", () => {
    const f = checkComposeHaproxy(join(dir, "missing.yaml"), cfg);
    expect(f.map((x) => x.rule)).toEqual(["compose-haproxy-missing"]);
  });

  it("passes on the repository's compose.yaml", () => {
    expect(
      checkComposeHaproxy(
        join(repoRoot, "docker/compose.yaml"),
        join(repoRoot, "docker/sandbox-proxy/haproxy.cfg"),
      ),
    ).toEqual([]);
  });
});
