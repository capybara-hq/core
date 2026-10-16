-- DROP TABLE x; BEGIN; in a line comment
/* DROP TABLE y; COMMIT;
   CREATE TABLE z (id int); */
CREATE TABLE IF NOT EXISTS capybara.t (
  id text DEFAULT 'DROP TABLE a; it''s; BEGIN;',
  note text DEFAULT $$ DROP COLUMN b; COMMIT; $$,
  other text DEFAULT $tag$ RENAME x; $tag$
);
