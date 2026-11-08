-- A deployment that already has two enabled providers of one single-provider extension point
-- (sandbox, object-store, secret-store, config-source; enabled before the second enable was
-- refused) loads the one with the earliest `enabled_at` (0097). 0097 backfilled it from the audit
-- or the install time, which can name a provider other than the one the replicas run now: the
-- rolling deploy would switch the provider. Prefer what is running: of the enabled providers of a
-- contested point, the one with a `loaded` replica status row (the most recent heartbeat) gets an
-- `enabled_at` just before every other provider of that point. A point with no loaded provider
-- keeps the 0097 values. Idempotent: once the running provider is the earliest, nothing matches.
WITH provided AS (
  SELECT i.name, split_part(p.ref, '@', 1) AS point, i.enabled_at
    FROM extension_installs i
    JOIN extension_packages k ON k.sha256 = i.sha256
   CROSS JOIN LATERAL jsonb_array_elements_text(
           CASE WHEN jsonb_typeof(k.section -> 'manifest' -> 'provides') = 'array'
                THEN k.section -> 'manifest' -> 'provides' ELSE '[]'::jsonb END) AS p(ref)
   WHERE i.desired_state = 'enabled'
     AND split_part(p.ref, '@', 1) IN ('sandbox', 'object-store', 'secret-store', 'config-source')
),
contested AS (
  SELECT point FROM provided GROUP BY point HAVING count(DISTINCT name) > 1
),
running AS (
  SELECT DISTINCT ON (pr.point) pr.point, pr.name
    FROM provided pr
    JOIN contested c ON c.point = pr.point
    JOIN extension_replica_status s
      ON s.plugin = pr.name AND s.source = 'install' AND s.state = 'loaded'
   ORDER BY pr.point, s.heartbeat_at DESC, pr.name
),
target AS (
  SELECT r.name, min(o.enabled_at) AS others_first
    FROM running r
    JOIN provided o ON o.point = r.point AND o.name <> r.name
   GROUP BY r.name
)
UPDATE extension_installs i
   SET enabled_at = t.others_first - interval '1 millisecond'
  FROM target t
 WHERE i.name = t.name
   AND t.others_first IS NOT NULL
   AND (i.enabled_at IS NULL OR i.enabled_at >= t.others_first);
