-- Image generation through `ctx.models.generateImage` (image generation spec §9): a `model_usage`
-- row records the kind of call that made it, so its `usage.report` purpose is `image` or
-- `embedding` (the `purpose` column keeps the extension's own purpose name), how many images
-- the call produced, and the answer's output and cache tokens (an image model may bill output
-- tokens). Existing rows are embedding calls with no images and no output or cache tokens.
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'embedding';
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS output_images integer NOT NULL DEFAULT 0;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS output_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS cache_read_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0;
