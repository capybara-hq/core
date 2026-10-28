---
"@capybara-hq/capybara": patch
---

`capybara start` always runs the bootstrap step (when it is not done for the manifest), from the
offline directory of config `bootstrap.dir` (default `./bootstrap`, `/app/bootstrap` in the image)
or else downloading the pins from `packages.npmRegistry`; `--bootstrap-dir` is removed.
`capybara bootstrap --dir` defaults to the same directory and downloads what it does not hold.
