---
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
---

The bootstrap step obtains its packages itself: once it is not done for the manifest, under the
advisory lock and before writing anything, each pinned plugin comes from a `*.tgz` of the offline
directory whose sha512 matches (any file name), else from `packages.npmRegistry`, verified against
the pin (new error `bootstrap.download_failed`, 502). A done run reads no directory and no network.
New config key `bootstrap.dir` (`CAPYBARA_BOOTSTRAP__DIR`, default `bootstrap`). `createKernel`
takes `bootstrap: { dir? }` instead of `bootstrapDir`, and the dual-replica harness's
`bootstrap.dir` is optional.
