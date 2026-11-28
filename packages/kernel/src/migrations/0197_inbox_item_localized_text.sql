-- Localized inbox item texts: `ctx.inbox.post` takes a title and a body as a single string or as
-- `{ zh, en }` (like its action labels). A bilingual text is kept as given in `title_localized` /
-- `body_localized`, and `title` / `body` keep its English text, so every reader of the single
-- string (the Platform tool's English rows, a replica still on the previous version) reads one.
-- Null: the post gave a single string (or no body).

ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS title_localized jsonb;
ALTER TABLE inbox_items ADD COLUMN IF NOT EXISTS body_localized jsonb;
