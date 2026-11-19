---
"@capybara-hq/device": patch
---

`capybara-device`: restricted commands on macOS and Linux hosts find version managers again
(asdf, nvm, pyenv, rbenv, mise, volta, sdkman, rustup). Their variables are set from the device's
real home and environment, as the protocol 2 OS sandbox did, and the directories they name are
granted read only, with asdf's global `~/.tool-versions` as a single read-only file; nothing
that is `/`, is, lies under or holds an owner-denied path is granted.
Commands in the local-Docker container keep the image's home.
