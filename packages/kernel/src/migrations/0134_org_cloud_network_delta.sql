-- Org egress ceiling (spec 2026-11-15-org-egress-ceiling-design.md §D5): an org's cloudNetwork
-- stops replacing the platform's allowlist with a copy (`allowHosts`) and stores a delta over it
-- (`base`, `extraHosts`, `excludedHosts`). A migration cannot read the deployment's config, so a
-- stored list is kept exactly: `base: none` (only the org's own hosts) with the list as its extras,
-- never wider than before. An org admin re-attaches to the platform by following it again.
--
-- Only an object cloudNetwork whose allowHosts is an array of distinct strings is converted, in its
-- order. Anything else (a non-array allowHosts copied in by 0130, duplicates, non-string elements)
-- is left alone: the old reader already read it as invalid, the empty allowlist, and so does the
-- new one; converting it would widen it. Idempotent: a converted row has no allowHosts left.
UPDATE orgs
SET settings = jsonb_set(
  settings,
  '{cloudNetwork}',
  ((settings->'cloudNetwork') - 'allowHosts')
    || '{"base":"none"}'::jsonb
    || COALESCE(
         (
           SELECT jsonb_build_object('extraHosts', jsonb_agg(h ORDER BY first_pos))
           FROM (
             SELECT e.value AS h, min(e.pos) AS first_pos
             FROM jsonb_array_elements(settings->'cloudNetwork'->'allowHosts')
                    WITH ORDINALITY AS e(value, pos)
             WHERE jsonb_typeof(e.value) = 'string'
             GROUP BY e.value
           ) AS uniq
           HAVING count(*) > 0
         ),
         '{}'::jsonb
       )
)
WHERE jsonb_typeof(settings->'cloudNetwork') = 'object'
  AND jsonb_typeof(settings->'cloudNetwork'->'allowHosts') = 'array'
  AND jsonb_array_length(settings->'cloudNetwork'->'allowHosts') = (
    SELECT count(DISTINCT e.value)
    FROM jsonb_array_elements(settings->'cloudNetwork'->'allowHosts') AS e(value)
    WHERE jsonb_typeof(e.value) = 'string'
  );
