-- A device report's limit value became text (`DeviceReportLimit.value` is `{ en, zh? }`, core#663):
-- a stored report whose limit values are plain strings (written before) no longer passes
-- `parseDeviceReport`, so its device would show no report and lose its home until the next
-- refresh. Each string value becomes `{ "en": value }`; the order of the limits and every other
-- key (`support` included) are kept. Idempotent: a report without string values is not touched.
UPDATE devices
SET report = jsonb_set(
  report,
  '{limits}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN jsonb_typeof(l.value -> 'value') = 'string'
          THEN jsonb_set(l.value, '{value}', jsonb_build_object('en', l.value -> 'value'))
        ELSE l.value
      END
      ORDER BY l.ordinality
    )
    FROM jsonb_array_elements(report -> 'limits') WITH ORDINALITY AS l(value, ordinality)
  )
)
WHERE report IS NOT NULL
  AND jsonb_typeof(report -> 'limits') = 'array'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(report -> 'limits') AS s(value)
    WHERE jsonb_typeof(s.value -> 'value') = 'string'
  );
