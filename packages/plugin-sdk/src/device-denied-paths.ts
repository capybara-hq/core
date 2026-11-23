/**
 * Paths a local device never opens to restricted work (Request approval, Approve for me), relative
 * to `~` (spec §13.6, extended by ruling R19): SSH keys, cloud CLI credentials, container and
 * Kubernetes credentials, netrc, GnuPG, git / npm / PyPI tokens, the macOS keychains, the
 * browser profile directories, other tool credential stores (cargo, 1Password, Vault, Terraform,
 * Claude, Codex, keyrings, pass, rclone, s3cmd), mise's config directory and the config files it
 * loads from the home (an `[env]` section may hold tokens; globbed names like `~/mise.<env>.toml`
 * are not listed), Maven and Gradle credential files, and shell histories. One source for
 * the device, which denies them (and its own state directory), and the kernel, which never proposes
 * an approval for a path under one. Full access and auto mode run as the owner and do not apply
 * them: the command review does.
 */
export const DEVICE_DENIED_SECRET_PATHS: readonly string[] = Object.freeze([
  "~/.ssh",
  "~/.aws",
  "~/.config/gcloud",
  "~/.azure",
  "~/.kube",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.gnupg",
  "~/Library/Application Support/Google/Chrome",
  "~/Library/Application Support/Firefox",
  "~/.mozilla",
  "~/.config/google-chrome",
  "~/.config/chromium",
  // Ruling R19: more credential stores and browser data.
  "~/.config/gh",
  "~/.git-credentials",
  "~/.npmrc",
  "~/.pypirc",
  "~/Library/Keychains",
  "~/Library/Cookies",
  "~/Library/Safari",
  "~/Library/Application Support/BraveSoftware",
  "~/Library/Application Support/Microsoft Edge",
  "~/Library/Application Support/Arc",
  "~/.config/BraveSoftware",
  "~/.config/microsoft-edge",
  // Machine reach reads the whole home, so more tool credential stores and shell histories.
  "~/.cargo/credentials",
  "~/.cargo/credentials.toml",
  "~/.config/op",
  "~/.vault-token",
  "~/.terraform.d/credentials.tfrc.json",
  "~/.claude/.credentials.json",
  "~/.codex/auth.json",
  "~/.local/share/keyrings",
  "~/.password-store",
  "~/.config/rclone",
  "~/.s3cfg",
  // mise: its whole config directory (config files with [env] sections, the sops age key; its
  // data lives in ~/.local/share/mise) and the config files it walks up to in the home. Globbed
  // spellings such as ~/mise.<env>.toml cannot be listed here and stay readable.
  "~/.config/mise",
  "~/.config/mise.toml",
  "~/.config/mise.local.toml",
  "~/.mise.toml",
  "~/.mise.local.toml",
  "~/.mise",
  "~/mise.toml",
  "~/mise.local.toml",
  "~/mise/config.toml",
  "~/mise/config.local.toml",
  "~/mise/conf.d",
  // mise's legacy (rtx) names
  "~/.rtx.toml",
  "~/.rtx.local.toml",
  // Maven server passwords (and their master keys), Gradle repository credentials and Develocity
  // (Gradle Enterprise) access keys
  "~/.m2/settings.xml",
  "~/.m2/settings-security.xml",
  "~/.m2/settings-security4.xml",
  "~/.gradle/gradle.properties",
  "~/.gradle/develocity/keys.properties",
  "~/.gradle/enterprise/keys.properties",
  "~/.bash_history",
  "~/.zsh_history",
]);

/**
 * The device program's default state directory (`$XDG_CONFIG_HOME/capybara-device` when that is
 * set), relative to `~`: denied to restricted work like the secret paths.
 */
export const DEVICE_DEFAULT_STATE_PATH = "~/.config/capybara-device";
