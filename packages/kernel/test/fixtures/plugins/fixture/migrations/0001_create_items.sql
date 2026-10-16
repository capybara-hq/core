create table if not exists plugin_fixture.items (
  id bigint generated always as identity primary key,
  label text not null
);
