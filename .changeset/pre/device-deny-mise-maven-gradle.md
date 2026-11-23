---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

`DEVICE_DENIED_SECRET_PATHS` denies mise's whole config directory `~/.config/mise` (config files
with `[env]` sections, the sops age key) and the config files mise loads from the home
(`~/.config/mise.toml`, `~/.config/mise.local.toml`, `~/.mise.toml`, `~/.mise.local.toml`,
`~/.mise`, `~/mise.toml`, `~/mise.local.toml`, `~/mise/config.toml`, `~/mise/config.local.toml`,
`~/mise/conf.d`, the legacy `~/.rtx.toml` and `~/.rtx.local.toml`; globbed names such as
`~/mise.<env>.toml` cannot be listed and stay readable), and the Maven and Gradle credential files
(`~/.m2/settings.xml`, `~/.m2/settings-security.xml`, `~/.m2/settings-security4.xml`,
`~/.gradle/gradle.properties`, `~/.gradle/develocity/keys.properties`,
`~/.gradle/enterprise/keys.properties`). Sandboxed work on a local device never reads them, and the
kernel never proposes an approval for them. A sandboxed Maven or Gradle build no longer gets those
settings: on Linux it sees the files exist but cannot open them and may fail (Maven: "Non-readable
settings"); on macOS they look absent. Gradle init scripts and a moved `GRADLE_USER_HOME` are not
covered. On Linux under `machine` reach, files directly in `~/mise`, `~/.m2` and `~/.gradle` become
unreadable too.
