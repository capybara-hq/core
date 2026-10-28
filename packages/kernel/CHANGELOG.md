# @capybara-hq/kernel

## 0.1.0-rc.1

### Patch Changes

- 75d7a0c: The kernel logs through pino: records are `{ level, time, role, msg, ...fields }` (`time` replaces
  `ts`), redacted as before. New config `log.format` (`auto` | `pretty` | `json`) and optional Loki
  push (`log.loki.url` / `username` / `password` / `labels`). HTTP requests get a request id
  (`x-request-id`) and an access line; records carry `reqId`, or `queue` / `jobId` / `runId` in jobs.
- e69c9d6: The bootstrap step obtains its packages itself: once it is not done for the manifest, under the
  advisory lock and before writing anything, each pinned plugin comes from a `*.tgz` of the offline
  directory whose sha512 matches (any file name), else from `packages.npmRegistry`, verified against
  the pin (new error `bootstrap.download_failed`, 502). A done run reads no directory and no network.
  New config key `bootstrap.dir` (`CAPYBARA_BOOTSTRAP__DIR`, default `bootstrap`). `createKernel`
  takes `bootstrap: { dir? }` instead of `bootstrapDir`, and the dual-replica harness's
  `bootstrap.dir` is optional.
