---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Linux machine reach reads the files beside a denied path. The SDK's restricted Linux launcher
accepts exact file read roots (`roots.readFiles`, exec mode only): each an O_PATH, no-follow
descriptor the consumer pinned, re-checked on that descriptor as a regular file with its recorded
identity at its canonical path (a link, directory, FIFO or other type is refused), and granted
file reads only, without directory listing or execution. The device's read carve now grants the
non-denied regular files directly inside each directory it expands (for example `~/.bashrc` when
`~/.ssh` is denied, `~/.cargo/config.toml` beside `~/.cargo/credentials`); the agent pins each
without following links and grants nothing for one that changed type or has a second name. Files
count toward the 4096-root cap, and the agent raises its soft open-file limit to fit the pinned
roots. `linux-sandbox.py` changed: a provider staging it needs the new digest.
