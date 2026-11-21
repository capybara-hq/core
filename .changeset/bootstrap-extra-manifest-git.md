---
"@capybara-hq/kernel": minor
---

Install the `git` entries of the extra bootstrap manifest: the tree at the pinned commit (or its pack
from the offline directory), verified against the entry's integrity before anything is imported,
with the marketplace's token and username sent only to its origin, and recorded as the
config-managed marketplace's source. New error code `bootstrap.git_read_failed`.
