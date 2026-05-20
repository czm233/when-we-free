create table if not exists public.when_we_free_rooms (
  id text primary key,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_when_we_free_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_when_we_free_rooms_updated_at on public.when_we_free_rooms;

create trigger set_when_we_free_rooms_updated_at
before update on public.when_we_free_rooms
for each row
execute function public.set_when_we_free_updated_at();

alter table public.when_we_free_rooms replica identity full;
alter table public.when_we_free_rooms disable row level security;

grant usage on schema public to anon;
grant select, insert, update, delete on public.when_we_free_rooms to anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.when_we_free_rooms;
  end if;
exception
  when duplicate_object then null;
end;
$$;
