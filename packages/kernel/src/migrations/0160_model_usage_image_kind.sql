-- Image generation through `ctx.models.generateImage` (image generation spec §9): a `model_usage`
-- row records the kind of call that made it, so its `usage.report` purpose is `image` or
-- `embedding` (the `purpose` column keeps the extension's own purpose name), and how many images
-- the call produced. Existing rows are embedding calls with no images.
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'embedding';
ALTER TABLE model_usage ADD COLUMN IF NOT EXISTS output_images integer NOT NULL DEFAULT 0;
