import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TOOL_HOME_DIRS, toolHomeEnv } from "../src/exec/shared.js";
import { deniedSecretPaths } from "../src/policy.js";

/**
 * Version managers inside the OS sandbox (HOME is the workspace there): their data directories are
 * pointed at the real home, read only.
 */
describe("toolHomeEnv", () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "device-toolhome-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const make = (...rel: string[]) => {
    for (const r of rel) mkdirSync(join(home, r), { recursive: true });
  };

  it("points each unset variable at its default directory under the real home when it exists", () => {
    make(".asdf", ".nvm", ".pyenv", ".rbenv", ".local/share/mise", ".config/mise", ".volta");
    make(".sdkman", ".rustup");
    expect(toolHomeEnv(home, {})).toEqual({
      ASDF_DATA_DIR: join(home, ".asdf"),
      NVM_DIR: join(home, ".nvm"),
      PYENV_ROOT: join(home, ".pyenv"),
      RBENV_ROOT: join(home, ".rbenv"),
      MISE_DATA_DIR: join(home, ".local/share/mise"),
      MISE_CONFIG_DIR: join(home, ".config/mise"),
      VOLTA_HOME: join(home, ".volta"),
      SDKMAN_DIR: join(home, ".sdkman"),
      RUSTUP_HOME: join(home, ".rustup"),
    });
  });

  it("leaves out tools whose directory is missing or not a directory", () => {
    make(".pyenv");
    writeFileSync(join(home, ".asdf"), "not a dir");
    expect(toolHomeEnv(home, {})).toEqual({ PYENV_ROOT: join(home, ".pyenv") });
  });

  it("passes a variable the device's environment sets on as it is; a relative one is dropped", () => {
    make(".asdf", ".nvm");
    expect(
      toolHomeEnv(home, { ASDF_DATA_DIR: "/opt/asdf", NVM_DIR: "relative/nvm", PYENV_ROOT: "" }),
    ).toEqual({ ASDF_DATA_DIR: "/opt/asdf" });
  });

  it("mise follows XDG_DATA_HOME and XDG_CONFIG_HOME of the device's environment", () => {
    const data = join(home, "xdg-data");
    const config = join(home, "xdg-config");
    mkdirSync(join(data, "mise"), { recursive: true });
    mkdirSync(join(config, "mise"), { recursive: true });
    expect(toolHomeEnv(home, { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config })).toEqual({
      MISE_DATA_DIR: join(data, "mise"),
      MISE_CONFIG_DIR: join(config, "mise"),
    });
  });

  it("no default directory is under, or contains, a denied secret path", () => {
    const denied = deniedSecretPaths(home);
    for (const [, rel] of TOOL_HOME_DIRS) {
      const dir = join(home, rel);
      for (const d of denied) {
        expect(dir === d || dir.startsWith(`${d}/`) || d.startsWith(`${dir}/`)).toBe(false);
      }
    }
  });
});
