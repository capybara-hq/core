create table if not exists items (
  id bigint generated always as identity primary key,
  label text not null
);
