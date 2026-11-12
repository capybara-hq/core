---
"@capybara-hq/device": patch
---

Version managers work inside the OS sandbox: asdf, nvm, pyenv, rbenv, mise, volta, sdkman and
rustup get their data directories under the real home (read only) instead of the workspace HOME.
