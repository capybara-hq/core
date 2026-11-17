---
"@capybara-hq/device": patch
---

Linux and local-Docker operation backends for permission profiles (dormant: reachable only through
the staged protocol 3 path). On Linux hosts the device runs restricted commands through the SDK's
Landlock and seccomp-broker launcher on pinned root descriptors, with every filesystem write
brokered and the mandatory write denies refused, and network none or an allowlist served by a
token-protected proxy owned by the operation (CONNECT to ports 80 and 443 and plain requests to
port 80 only, globally routable addresses only). Native file work uses the SDK helper on pinned descriptors and refuses
owner-denied paths (compared by real path too), link targets and the mandatory write denies; Full
access runs as the OS user without restricted filters. The agent runs from inline source and
executes the SDK runtime only from sealed memfds whose digests it checked. Background work,
retained output and exact cancellation share the macOS supervisor; cancellation works without
pidfds too, an abort escalates like a cancel, and a lost agent's recorded session (SID and start
time) is reaped, also by the next device process. Restricted support is the launcher's own probe:
an unsupported kernel, ABI, architecture or Python below 3.9 fails closed. A local-Docker device
runs the same agent in its container. The macOS worker now enforces the same write policy through ordered Seatbelt regex rules (the
pnpm patch of `@anthropic-ai/sandbox-runtime` accepts `writeRegexRules`): case-insensitive denies,
the gitdir allowlist, no bare-repository `HEAD`, no forged repository and no `.git` moved away.
The README recommends `git config --global safe.bareRepository explicit` as defence in depth.
