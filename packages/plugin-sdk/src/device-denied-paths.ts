/**
 * Paths a local device never opens to restricted work (Request approval, Approve for me), relative
 * to `~` (spec §13.6, extended by ruling R19): SSH keys, cloud CLI credentials, container and
 * Kubernetes credentials, netrc, GnuPG, git / npm / PyPI tokens, the macOS keychains, and the
 * browser profile directories. One source for the device, which denies them (and its own state
 * directory), and the kernel, which never proposes an approval for a path under one. Full access
 * and auto mode run as the owner and do not apply them: the command review does.
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
]);

/**
 * The device program's default state directory (`$XDG_CONFIG_HOME/capybara-device` when that is
 * set), relative to `~`: denied to restricted work like the secret paths.
 */
export const DEVICE_DEFAULT_STATE_PATH = "~/.config/capybara-device";
