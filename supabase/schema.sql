create extension if not exists pgcrypto with schema extensions;

create table if not exists public.when_we_free_rooms (
  id text primary key,
  room_key_hash text,
  state jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.when_we_free_rooms
  add column if not exists room_key_hash text;

alter table public.when_we_free_rooms
  drop constraint if exists when_we_free_room_id_format,
  drop constraint if exists when_we_free_room_key_hash_format,
  drop constraint if exists when_we_free_state_object;

alter table public.when_we_free_rooms
  add constraint when_we_free_room_id_format check (id ~ '^[0-9a-f]{32}$'),
  add constraint when_we_free_room_key_hash_format check (
    room_key_hash is null or room_key_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint when_we_free_state_object check (jsonb_typeof(state) = 'object');

create or replace function public.set_when_we_free_updated_at()
returns trigger
language plpgsql
set search_path = public
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

create or replace function public.when_we_free_hash_key(room_key text)
returns text
language sql
immutable
strict
set search_path = public, extensions
as $$
  select encode(extensions.digest(room_key, 'sha256'), 'hex');
$$;

create or replace function public.when_we_free_request_key_hash()
returns text
language sql
stable
set search_path = public
as $$
  select nullif(current_setting('request.when_we_free_key_hash', true), '');
$$;

create or replace function public.get_when_we_free_room(room_id text, room_key text)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  key_hash text := public.when_we_free_hash_key(room_key);
  room_state jsonb;
begin
  if room_id !~ '^[0-9a-f]{32}$' or room_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid room credentials' using errcode = '22023';
  end if;

  perform set_config('request.when_we_free_key_hash', key_hash, true);

  select state into room_state
  from public.when_we_free_rooms
  where id = room_id;

  return room_state;
end;
$$;

create or replace function public.save_when_we_free_room(
  room_id text,
  room_key text,
  room_state jsonb
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  key_hash text := public.when_we_free_hash_key(room_key);
  saved_state jsonb;
begin
  if room_id !~ '^[0-9a-f]{32}$' or room_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid room credentials' using errcode = '22023';
  end if;

  if jsonb_typeof(room_state) is distinct from 'object' then
    raise exception 'Invalid room state' using errcode = '22023';
  end if;

  perform set_config('request.when_we_free_key_hash', key_hash, true);

  insert into public.when_we_free_rooms (id, room_key_hash, state)
  values (room_id, key_hash, room_state)
  on conflict (id) do nothing;

  update public.when_we_free_rooms
  set
    state = room_state
  where id = room_id
  returning state into saved_state;

  if saved_state is null then
    raise exception 'Room not found or key mismatch' using errcode = '42501';
  end if;

  return saved_state;
end;
$$;

alter table public.when_we_free_rooms enable row level security;

drop policy if exists "when_we_free_rooms_select_by_room_key" on public.when_we_free_rooms;
drop policy if exists "when_we_free_rooms_insert_by_room_key" on public.when_we_free_rooms;
drop policy if exists "when_we_free_rooms_update_by_room_key" on public.when_we_free_rooms;

create policy "when_we_free_rooms_select_by_room_key"
on public.when_we_free_rooms
for select
to anon
using (room_key_hash = public.when_we_free_request_key_hash());

create policy "when_we_free_rooms_insert_by_room_key"
on public.when_we_free_rooms
for insert
to anon
with check (
  room_key_hash = public.when_we_free_request_key_hash()
  and id ~ '^[0-9a-f]{32}$'
  and jsonb_typeof(state) = 'object'
);

create policy "when_we_free_rooms_update_by_room_key"
on public.when_we_free_rooms
for update
to anon
using (room_key_hash = public.when_we_free_request_key_hash())
with check (
  room_key_hash = public.when_we_free_request_key_hash()
  and id ~ '^[0-9a-f]{32}$'
  and jsonb_typeof(state) = 'object'
);

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'when_we_free_rooms'
  ) then
    alter publication supabase_realtime drop table public.when_we_free_rooms;
  end if;
exception
  when undefined_object then null;
end;
$$;

revoke all on public.when_we_free_rooms from anon, authenticated;
grant select, insert, update on public.when_we_free_rooms to anon;
revoke all on function public.get_when_we_free_room(text, text) from public;
revoke all on function public.save_when_we_free_room(text, text, jsonb) from public;
revoke all on function public.get_when_we_free_room(text, text) from authenticated;
revoke all on function public.save_when_we_free_room(text, text, jsonb) from authenticated;
grant usage on schema public to anon;
grant execute on function public.get_when_we_free_room(text, text) to anon;
grant execute on function public.save_when_we_free_room(text, text, jsonb) to anon;
