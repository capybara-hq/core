---
"@capybara-hq/capybara": patch
"@capybara-hq/design": patch
---

The super admin pages follow the responsive system. The admin views' choices (the owner filter of
the template lists and the like) are scopes, and the super admin lists page through their list
(`onLoadMore`) instead of loading everything at once.

`ItemList` pages: `onLoadMore`, `hasMore`, `loadingMore` and `loadMoreError` draw the Load more row
at its end.

The `SCOPE_PENDING` and `LOAD_MORE_PENDING` allowlists of the guards are gone: `check:web-ui` now
fails a `Segmented` / `Tabs` inside `ListPage.filters` and a Load more row drawn by a page.

Sizing audit: three super admin pages (a list, a detail and a form) join the responsive visual
matrix, with the 44 px hit-size and no-horizontal-scroll checks at 390.
