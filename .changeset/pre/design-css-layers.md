---
"@capybara-hq/design": minor
---

The design stylesheet declares the cascade layer order `@layer design, theme, extensions;` and
puts every file in the `design` layer, so theme and plugin CSS win by layer, not by specificity
or source order; the design's `!important` rules still beat theirs.
