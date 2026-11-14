-- A compact run (context compaction spec §4.7): the manual `POST .../compact` run takes the
-- conversation lock, runs the same compaction execution as a step's automatic path with
-- `force: true`, and writes only `compaction_summary` / `compaction_failed` + usage. Its
-- `run_started` is marked `trigger: "compact"`; `runs.compact` tells the run worker which path to
-- take. An ordinary run is `false` (not null), so every reader can test the column directly.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS compact boolean NOT NULL DEFAULT false;
