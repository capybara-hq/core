---
"@capybara-hq/device": patch
---

The device package now ships a canonical installed-byte manifest (`dist/runtime-manifest.json`,
written by `tools/runtime-manifest.ts` at pack time from the emitted modules, the inline helper
sources and the installed sandbox runtime closure) and a private verifier that re-hashes the
installed bytes and the interpreter environment before attesting a runtime identity. Nothing uses
it on the active protocol 2 path yet.
