---
"@capybara-hq/device": minor
---

Each connection records the project directories it used (`projects.json` in its connection
directory, most recent first, at most 256). A directory another connection on the same machine also
uses stays allowed and is marked: `status` adds "(N project directories also used by another
connection on this machine)" to the connection's line and `status --json` gives `sharedProjects`;
the hello's and the `policy` event's policy summary carry `sharedProjectRoots`, sent again when
they change, with only the shared directories the owner listed in that connection's
`projectPaths` (never one the deployment picked itself). The other connection is never named.

A `--connection` selector shaped like a device id (a UUID) matches a device id only, never a device
name or host, so `-c <deviceId>` never acts on another connection when that device was logged out.
