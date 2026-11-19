---
"@capybara-hq/kernel": patch
---

`Read` shows images to the model: a model with vision sees the image in its next request, and a
model without vision has the organization's new `vision` purpose (Models → Purposes → Vision) read
it. `Read` also takes `file_id` to read an attachment or artifact of the conversation, and works
without a device for it. Read images are kept as copies of the conversation and purged after it is
deleted. `GenerateImage` gains `resolution` (`standard` is about one megapixel, set by
`models.imageStandardPixels`; `high` is the model's largest size), and its reference images can be
any image of the conversation.

Agents without a device now list `Read` (for `file_id`), so their tool list changes once after the
upgrade.

On upgrade, a model without vision sees its earlier pasted-image placeholders with the new text once
(the placeholder now names the attachment's `file_id`), which costs one prompt-cache miss per
conversation.
