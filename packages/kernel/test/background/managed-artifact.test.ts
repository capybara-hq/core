import { isSandboxScopeDeniedError } from "@capybara-hq/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  assertManagedArtifactAdmitted,
  managedTaskArtifactPath,
} from "../../src/background/launch.js";

/** The managed task artifact placement and its pre-effect admission (cutover phase 8.2). */

const scoped = (...writeRoots: string[]) => ({
  filesystem: { kind: "scoped" as const, readRoots: writeRoots, writeRoots },
});
const args = (cwd: string, taskId = "bt_abcdef") => ({
  cwd,
  taskId,
  outputPath: managedTaskArtifactPath(cwd, taskId),
  retainUntilMs: Date.now() + 60_000,
});
const denied = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    if (isSandboxScopeDeniedError(e)) return e.message;
    throw e;
  }
  throw new Error("expected a scope denial");
};

describe("managedTaskArtifactPath", () => {
  it("places the artifact under the working root's .capybara/tasks", () => {
    expect(managedTaskArtifactPath("/home/owner/app", "bt_abcdef")).toBe(
      "/home/owner/app/.capybara/tasks/bt_abcdef.out",
    );
    expect(managedTaskArtifactPath("/", "bt_abcdef")).toBe("/.capybara/tasks/bt_abcdef.out");
    expect(() => managedTaskArtifactPath("/w", "../x")).toThrow(/invalid background task id/);
  });
});

describe("assertManagedArtifactAdmitted", () => {
  it("accepts the placement inside an admitted write root, and Full access's device scope", () => {
    expect(() =>
      assertManagedArtifactAdmitted(scoped("/home/owner/app"), args("/home/owner/app")),
    ).not.toThrow();
    expect(() =>
      assertManagedArtifactAdmitted(scoped("/home/owner"), args("/home/owner/app")),
    ).not.toThrow();
    expect(() =>
      assertManagedArtifactAdmitted({ filesystem: { kind: "device" } }, args("/srv/app")),
    ).not.toThrow();
  });

  it("refuses a working root outside every write root: no workspace or tmp fallback", () => {
    expect(
      denied(() => assertManagedArtifactAdmitted(scoped("/work", "/tmp"), args("/home/owner/app"))),
    ).toMatch(/outside the admitted write roots/);
    // a sibling with a shared prefix is not inside
    expect(
      denied(() =>
        assertManagedArtifactAdmitted(scoped("/home/owner/ap"), args("/home/owner/app")),
      ),
    ).toMatch(/outside/);
  });

  it("refuses a caller-chosen path, a non-normalized root, protected Git metadata and bad retention", () => {
    const a = args("/work");
    expect(
      denied(() =>
        assertManagedArtifactAdmitted(scoped("/work"), { ...a, outputPath: "/tmp/x.out" }),
      ),
    ).toMatch(/placement/);
    expect(
      denied(() => assertManagedArtifactAdmitted(scoped("/work"), args("/work/../etc"))),
    ).toMatch(/normalized/);
    expect(denied(() => assertManagedArtifactAdmitted(scoped("/work"), args("/work/")))).toMatch(
      /normalized/,
    );
    expect(
      denied(() => assertManagedArtifactAdmitted(scoped("/work"), args("/work/.git/hooks"))),
    ).toMatch(/Git/);
    expect(
      denied(() => assertManagedArtifactAdmitted(scoped("/work"), { ...a, retainUntilMs: 0 })),
    ).toMatch(/retention/);
    expect(
      denied(() => assertManagedArtifactAdmitted(scoped("/work"), { ...a, taskId: "bt_x" })),
    ).toMatch(/task id/);
  });
});
