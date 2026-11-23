---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

`DEVICE_DENIED_SECRET_PATHS` also lists mise's other env-carrying config files in the home
(`~/.config/mise/conf.d`, `~/.config/mise/config.local.toml`, `~/.config/mise.toml`, `~/.mise.toml`,
`~/.mise.local.toml`) and the Maven and Gradle credential files (`~/.m2/settings.xml`,
`~/.m2/settings-security.xml`, `~/.gradle/gradle.properties`). Sandboxed work on a local device
never reads them, and the kernel never proposes an approval for them; a sandboxed Maven or Gradle
build no longer sees those settings (on Linux under `machine` reach, files directly in `~/.m2` and
`~/.gradle` become unreadable too).
