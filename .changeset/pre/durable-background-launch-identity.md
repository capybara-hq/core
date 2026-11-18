---
"@capybara-hq/kernel": patch
---

Stage durable managed background launches: the full launch reservation (operation, input digest,
run claim, task tag, instance generation, starting revisions, grant locator, network authority,
retention and the project-rooted artifact path) is persisted before dispatch, an acknowledged start
keeps its intent as revocable running authority with the exact typed reference, lost
acknowledgements are recovered under the same identity, and stop or ceiling races owe an exact
cancellation instead of a relaunch. The protocol-2 background launch remains the active path.
