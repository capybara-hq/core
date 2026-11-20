import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deviceSandboxHome,
  prepareSandboxHome,
  restrictedToolHomes,
  sandboxHomeEnv,
  TOOL_HOME_DIRS,
  TOOL_HOME_FILES,
  toolHomeEnv,
} from "../src/exec/shared.js";
import { deniedSecretPaths } from "../src/policy.js";

/**
 * Version managers inside the OS sandbox (HOME is the device's sandbox home there): their data
 * directories are pointed at the real home, read only.
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

  it("mise follows XDG_DATA_HOME of the device's environment", () => {
    const data = join(home, "xdg-data");
    const config = join(home, "xdg-config");
    mkdirSync(join(data, "mise"), { recursive: true });
    mkdirSync(join(config, "mise"), { recursive: true });
    expect(toolHomeEnv(home, { XDG_DATA_HOME: data, XDG_CONFIG_HOME: config })).toEqual({
      MISE_DATA_DIR: join(data, "mise"),
    });
  });

  // R3 final review m3: mise's config.toml may hold tokens (an [env] section)
  it("never grants mise's configuration directory, even when the device's environment names it", () => {
    make(".local/share/mise/installs/node/22.12.0/bin", ".config/mise");
    writeFileSync(join(home, ".config/mise/config.toml"), '[env]\nGITHUB_TOKEN = "secret"\n');
    writeFileSync(join(home, ".tool-versions"), "node 22.12.0\n");
    for (const env of [{}, { MISE_CONFIG_DIR: join(home, ".config/mise") }]) {
      const homes = restrictedToolHomes(home, env, deniedSecretPaths(home));
      expect(homes.env).toEqual({ MISE_DATA_DIR: join(home, ".local/share/mise") });
      expect(homes.readRoots).toEqual([join(home, ".local/share/mise")]);
      expect(homes.readFiles).toEqual([join(home, ".tool-versions")]);
      for (const path of [...homes.readRoots, ...homes.readFiles])
        expect(path.startsWith(join(home, ".config"))).toBe(false);
    }
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

/** A restricted exec on the host: the variables plus read-only roots, never a denied path. */
describe("restrictedToolHomes", () => {
  let home: string;
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "device-toolhome-")));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("grants the default directories it picks as read roots, with their variables", () => {
    mkdirSync(join(home, ".asdf"));
    mkdirSync(join(home, ".rustup"));
    expect(restrictedToolHomes(home, {}, deniedSecretPaths(home))).toEqual({
      env: { ASDF_DATA_DIR: join(home, ".asdf"), RUSTUP_HOME: join(home, ".rustup") },
      readRoots: [join(home, ".asdf"), join(home, ".rustup")],
      readFiles: [],
    });
  });

  it("passes a set absolute value on; it is read only when it is an existing directory", () => {
    const nvm = join(home, "opt-nvm");
    mkdirSync(nvm);
    expect(
      restrictedToolHomes(home, { NVM_DIR: `${nvm}/`, ASDF_DATA_DIR: "/no/such/asdf" }, []),
    ).toEqual({
      env: { NVM_DIR: `${nvm}/`, ASDF_DATA_DIR: "/no/such/asdf" },
      readRoots: [nvm],
      readFiles: [],
    });
  });

  it("never grants /, a denied path, a path under one or a directory containing one", () => {
    const denied = deniedSecretPaths(home);
    mkdirSync(join(home, ".ssh/keys"), { recursive: true });
    mkdirSync(join(home, ".aws"));
    symlinkSync(join(home, ".aws"), join(home, "aws-link"));
    const result = restrictedToolHomes(
      home,
      {
        ASDF_DATA_DIR: "/",
        NVM_DIR: home,
        PYENV_ROOT: join(home, ".ssh/keys"),
        RBENV_ROOT: join(home, "aws-link"),
      },
      denied,
    );
    // the variables still pass on; nothing of them becomes readable
    expect(result.env).toMatchObject({ ASDF_DATA_DIR: "/", NVM_DIR: home });
    expect(result.readRoots).toEqual([]);
  });

  it("grants asdf's global .tool-versions as a single read file when it is a regular file", () => {
    writeFileSync(join(home, ".tool-versions"), "nodejs 22.12.0\n");
    expect(restrictedToolHomes(home, {}, deniedSecretPaths(home)).readFiles).toEqual([
      join(home, ".tool-versions"),
    ]);
    // a directory of that name, or none at all, grants nothing
    rmSync(join(home, ".tool-versions"));
    expect(restrictedToolHomes(home, {}, []).readFiles).toEqual([]);
    mkdirSync(join(home, ".tool-versions"));
    expect(restrictedToolHomes(home, {}, []).readFiles).toEqual([]);
  });

  it("grants a linked .tool-versions by its real path, never one that leads into a denied root", () => {
    mkdirSync(join(home, "dotfiles"));
    writeFileSync(join(home, "dotfiles/tool-versions"), "python 3.12.0\n");
    symlinkSync(join(home, "dotfiles/tool-versions"), join(home, ".tool-versions"));
    expect(restrictedToolHomes(home, {}, deniedSecretPaths(home)).readFiles).toEqual([
      join(home, "dotfiles/tool-versions"),
    ]);
    rmSync(join(home, ".tool-versions"));
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, ".ssh/id_ed25519"), "secret");
    symlinkSync(join(home, ".ssh/id_ed25519"), join(home, ".tool-versions"));
    expect(restrictedToolHomes(home, {}, deniedSecretPaths(home)).readFiles).toEqual([]);
  });

  it("only real version pins are single read files: no other dotfile of the home", () => {
    expect(TOOL_HOME_FILES).toEqual([".tool-versions"]);
    for (const rel of TOOL_HOME_FILES)
      for (const d of deniedSecretPaths(home)) {
        const file = join(home, rel);
        expect(file === d || file.startsWith(`${d}/`)).toBe(false);
      }
  });
});

/**
 * A restricted command's HOME: the device's own sandbox home `<dir>/home`, persistent and outside
 * every workspace and project (a project's working directory is the person's repository, where a
 * tool's per-user state must not land).
 */
describe("the sandbox home", () => {
  let dir: string;
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "device-sandbox-home-")));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is <dir>/home, next to the workspace, skills and tmp roots", () => {
    expect(deviceSandboxHome("/devices/one")).toBe("/devices/one/home");
  });

  it("sets HOME and every XDG base directory under it", () => {
    expect(sandboxHomeEnv("/devices/one/home")).toEqual({
      HOME: "/devices/one/home",
      XDG_CACHE_HOME: "/devices/one/home/.cache",
      XDG_CONFIG_HOME: "/devices/one/home/.config",
      XDG_DATA_HOME: "/devices/one/home/.local/share",
      XDG_STATE_HOME: "/devices/one/home/.local/state",
    });
  });

  it("is created private (0700) and kept across commands", () => {
    const home = join(dir, "home");
    expect(prepareSandboxHome(home, [])).toBe(home);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    writeFileSync(join(home, "kept"), "x");
    expect(prepareSandboxHome(home, [])).toBe(home);
    expect(readFileSync(join(home, "kept"), "utf8")).toBe("x");
  });

  it("returns the canonical path when the device directory is reached through a link", () => {
    mkdirSync(join(dir, "real"));
    symlinkSync(join(dir, "real"), join(dir, "linked"));
    expect(prepareSandboxHome(join(dir, "linked", "home"), [])).toBe(join(dir, "real", "home"));
  });

  it("refuses a home that is a link, or a denied path, or contains one", () => {
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "home"));
    expect(() => prepareSandboxHome(join(dir, "home"), [])).toThrow(/not a directory/);
    rmSync(join(dir, "home"));
    expect(() => prepareSandboxHome(join(dir, "home"), [dir])).toThrow(/denies/);
    expect(() => prepareSandboxHome(join(dir, "home"), [join(dir, "home", ".ssh")])).toThrow(
      /denies/,
    );
  });

  it("links asdf's global .tool-versions when the real one is granted, and keeps the command's own", () => {
    const real = join(dir, "real-home");
    mkdirSync(real);
    writeFileSync(join(real, ".tool-versions"), "nodejs 22.12.0\n");
    const homes = restrictedToolHomes(real, {}, []);
    const home = join(dir, "home");
    prepareSandboxHome(home, [], { home: real, readFiles: homes.readFiles });
    expect(lstatSync(join(home, ".tool-versions")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(home, ".tool-versions"))).toBe(join(real, ".tool-versions"));
    // a file the command wrote there itself is never replaced
    rmSync(join(home, ".tool-versions"));
    writeFileSync(join(home, ".tool-versions"), "own\n");
    prepareSandboxHome(home, [], { home: real, readFiles: homes.readFiles });
    expect(readFileSync(join(home, ".tool-versions"), "utf8")).toBe("own\n");
    // not granted (absent, or denied): no link
    const other = join(dir, "other");
    prepareSandboxHome(other, [], { home: real, readFiles: [] });
    expect(() => lstatSync(join(other, ".tool-versions"))).toThrow();
  });
});
