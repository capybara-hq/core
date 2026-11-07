-- Model platform providers (spec 2026-11-06-model-platform-providers-design.md). Expand-only: two
-- new tables, nothing existing changes.

-- 0089, spec §5.3: models disabled on two layers. `org_id` null is the platform's list (the super
-- admin; such a model is invisible to every org), otherwise the org's own list (an org admin, among
-- the models the platform left on). No row means the model is enabled; a model a provider lists
-- later is enabled everywhere until someone disables it. Keyed on the model id, so a row applies to
-- whichever list the org sees (the platform's config or the org's own copy); an id the list does
-- not contain is kept harmlessly.
CREATE TABLE IF NOT EXISTS model_disabled (
  org_id text NULL REFERENCES orgs(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  disabled_by text REFERENCES accounts(id) ON DELETE SET NULL,
  disabled_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS model_disabled_scope_key
  ON model_disabled ((coalesce(org_id, '')), provider, model);

-- 0089, spec §5.4: model usage outside conversations (an extension's `ctx.models.embed` call). One
-- row per call; `reported_at` is set once the `usage.report` job for the row (eventId = id) has
-- nothing left to deliver (delivered, no subscriber, or a definite drop); `report_failed_at` once
-- the job gave up after its last attempt. The sweeper re-enqueues recent rows where both are null.
CREATE TABLE IF NOT EXISTS model_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  extension text NOT NULL,
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reported_at timestamptz NULL,
  report_failed_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS model_usage_org_time ON model_usage (org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS model_usage_unreported ON model_usage (occurred_at)
  WHERE reported_at IS NULL AND report_failed_at IS NULL;
