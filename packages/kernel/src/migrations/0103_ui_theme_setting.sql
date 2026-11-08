-- The platform default theme setting `uiTheme` (themes spec §7) always has a row: the guards that
-- refuse taking the default theme away from an org read it FOR SHARE, and the setting's write
-- locks it FOR UPDATE before checking the chosen theme, so the two serialize on this row.
-- `{"id": null}` is the built-in theme (the default when the key is missing).
INSERT INTO deployment_settings (key, value)
VALUES ('uiTheme', '{"id": null}'::jsonb)
ON CONFLICT (key) DO NOTHING;
