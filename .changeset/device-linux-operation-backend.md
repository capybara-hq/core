---
"@capybara-hq/device": patch
---

Linux and local-Docker operation backends for permission profiles (dormant: reachable only through
the staged protocol 3 path). On Linux hosts the device runs restricted commands through the SDK's
Landlock and seccomp-broker launcher on pinned root descriptors, with network none or an allowlist
served by a proxy owned by the operation; native file work uses the SDK helper on the same kind of
pinned descriptors and refuses owner-denied paths and link targets; Full access runs as the OS user
without restricted filters. Background work, retained output and exact cancellation share the macOS
supervisor; a lost agent's recorded session (SID and start time) is reaped, also by the next device
process. Restricted support is the launcher's own probe: an unsupported kernel, ABI or architecture
reports restricted unavailable while Full access keeps working. A local-Docker device runs the same
agent inside its container from a root-owned runtime it stages there.
