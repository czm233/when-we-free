create extension if not exists pgcrypto with schema extensions;

create table if not exists public.when_we_free_rooms (
  id text primary key,
  room_key_hash text,
  state jsonb not null,
  dissolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.when_we_free_rooms
  add column if not exists room_key_hash text,
  add column if not exists dissolved_at timestamptz;

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

create or replace function public.when_we_free_state_participants(room_state jsonb)
returns setof jsonb
language sql
stable
set search_path = public
as $$
  select value
  from jsonb_array_elements(
    case
      when jsonb_typeof(room_state->'participants') = 'array' then room_state->'participants'
      else '[]'::jsonb
    end
  ) as entries(value);
$$;

create or replace function public.when_we_free_is_valid_state(room_state jsonb)
returns boolean
language sql
stable
set search_path = public
as $$
  with participant_rows as (
    select participant
    from public.when_we_free_state_participants(room_state) as entries(participant)
  ),
  availability_rows as (
    select date_key, ids
    from jsonb_each(
      case
        when jsonb_typeof(room_state->'availability') = 'object' then room_state->'availability'
        else '{}'::jsonb
      end
    ) availability(date_key, ids)
  )
  select
    jsonb_typeof(room_state) = 'object'
    and jsonb_typeof(room_state->'participants') = 'array'
    and ((room_state ? 'availability') = false or jsonb_typeof(room_state->'availability') = 'object')
    and (
      room_state->>'version' is null
      or room_state->>'version' = '2'
    )
    and (
      room_state->>'adminKeyHash' is null
      or room_state->>'adminKeyHash' ~ '^[0-9a-f]{64}$'
    )
    and (select count(*) from participant_rows) > 0
    and (
      select count(*) = count(distinct participant->>'id')
      from participant_rows
    )
    and not exists (
      select 1
      from participant_rows
      where jsonb_typeof(participant) <> 'object'
        or not (participant ? 'id')
        or not (participant ? 'name')
        or not (participant ? 'color')
        or participant->>'id' !~ '^(p-[A-Za-z0-9._:-]+|[0-9a-f-]{36})$'
        or jsonb_typeof(participant->'id') <> 'string'
        or jsonb_typeof(participant->'name') <> 'string'
        or jsonb_typeof(participant->'color') <> 'string'
        or (
          participant->>'keyHash' is not null
          and participant->>'keyHash' !~ '^[0-9a-f]{64}$'
        )
        or exists (
          select 1
          from jsonb_object_keys(participant) as participant_key(key)
          where participant_key.key not in ('id', 'name', 'color', 'keyHash')
        )
    )
    and not exists (
      select 1
      from availability_rows
      where date_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or jsonb_typeof(ids) <> 'array'
        or exists (
          select 1
          from jsonb_array_elements(
            case
              when jsonb_typeof(ids) = 'array' then ids
              else '[]'::jsonb
            end
          ) available_id
          where jsonb_typeof(available_id) <> 'string'
             or not exists (
               select 1
               from participant_rows
               where participant->>'id' = trim(both '"' from available_id::text)
             )
        )
    );
$$;

create or replace function public.when_we_free_participant_entry(
  room_state jsonb,
  participant_id text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select participant
  from public.when_we_free_state_participants(room_state) as entries(participant)
  where participant->>'id' = participant_id
  limit 1;
$$;

create or replace function public.when_we_free_participants_except(
  room_state jsonb,
  participant_id text
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(participant order by ordinal), '[]'::jsonb)
  from jsonb_array_elements(
    case
      when jsonb_typeof(room_state->'participants') = 'array' then room_state->'participants'
      else '[]'::jsonb
    end
  ) with ordinality as entries(participant, ordinal)
  where participant->>'id' <> participant_id;
$$;

create or replace function public.when_we_free_availability_except(
  room_state jsonb,
  participant_id text
)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  date_key text;
  ids jsonb;
  filtered_ids jsonb;
  normalized jsonb := '{}'::jsonb;
begin
  for date_key, ids in
    select key, value
    from jsonb_each(
      case
        when jsonb_typeof(room_state->'availability') = 'object' then room_state->'availability'
        else '{}'::jsonb
      end
    )
  loop
    select coalesce(jsonb_agg(to_jsonb(available_id) order by ordinal), '[]'::jsonb)
    into filtered_ids
    from jsonb_array_elements_text(
      case
        when jsonb_typeof(ids) = 'array' then ids
        else '[]'::jsonb
      end
    ) with ordinality as entries(available_id, ordinal)
    where available_id <> participant_id;

    if jsonb_array_length(filtered_ids) > 0 then
      normalized := normalized || jsonb_build_object(date_key, filtered_ids);
    end if;
  end loop;

  return normalized;
end;
$$;

drop function if exists public.when_we_free_can_participant_update(jsonb, jsonb, text, text);

create or replace function public.when_we_free_can_participant_update(
  old_state jsonb,
  new_state jsonb,
  participant_key_hash text
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
declare
  participant_id text;
  old_participant jsonb;
  new_participant jsonb;
begin
  select participant->>'id'
  into participant_id
  from public.when_we_free_state_participants(old_state) as entries(participant)
  where participant->>'keyHash' = participant_key_hash
  limit 1;

  if participant_id is null then
    return false;
  end if;

  old_participant := public.when_we_free_participant_entry(old_state, participant_id);
  new_participant := public.when_we_free_participant_entry(new_state, participant_id);

  if old_participant is null or new_participant is null then
    return false;
  end if;

  if new_participant->>'keyHash' is distinct from participant_key_hash then
    return false;
  end if;

  return
    old_state - 'participants' - 'availability' = new_state - 'participants' - 'availability'
    and public.when_we_free_participants_except(old_state, participant_id)
      = public.when_we_free_participants_except(new_state, participant_id)
    and old_participant - 'name' - 'color' = new_participant - 'name' - 'color'
    and public.when_we_free_availability_except(old_state, participant_id)
      = public.when_we_free_availability_except(new_state, participant_id);
end;
$$;

create or replace function public.get_when_we_free_room(room_id text, room_key text)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  key_hash text := public.when_we_free_hash_key(room_key);
  room_state jsonb;
  room_dissolved_at timestamptz;
begin
  if room_id !~ '^[0-9a-f]{32}$' or room_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid room credentials' using errcode = '22023';
  end if;

  perform set_config('request.when_we_free_key_hash', key_hash, true);

  select state, dissolved_at into room_state, room_dissolved_at
  from public.when_we_free_rooms
  where id = room_id;

  if room_dissolved_at is not null then
    raise exception 'Room has been dissolved' using errcode = '42501';
  end if;

  return room_state;
end;
$$;

drop function if exists public.save_when_we_free_room(text, text, jsonb);

create or replace function public.save_when_we_free_room(
  room_id text,
  room_key text,
  room_state jsonb,
  admin_key text default null,
  participant_id text default null,
  participant_key text default null
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  key_hash text := public.when_we_free_hash_key(room_key);
  admin_key_hash text := case
    when admin_key ~ '^[0-9a-f]{64}$' then public.when_we_free_hash_key(admin_key)
    else null
  end;
  participant_key_hash text := case
    when participant_key ~ '^[0-9a-f]{64}$' then public.when_we_free_hash_key(participant_key)
    else null
  end;
  existing_state jsonb;
  existing_admin_key_hash text;
  existing_dissolved_at timestamptz;
  saved_state jsonb;
begin
  if room_id !~ '^[0-9a-f]{32}$' or room_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid room credentials' using errcode = '22023';
  end if;

  if not coalesce(public.when_we_free_is_valid_state(room_state), false) then
    raise exception 'Invalid room state' using errcode = '22023';
  end if;

  perform set_config('request.when_we_free_key_hash', key_hash, true);

  select state, dissolved_at into existing_state, existing_dissolved_at
  from public.when_we_free_rooms
  where id = room_id;

  if existing_dissolved_at is not null then
    raise exception 'Room has been dissolved' using errcode = '42501';
  end if;

  if existing_state is null then
    if admin_key_hash is null or room_state->>'adminKeyHash' is distinct from admin_key_hash then
      raise exception 'Admin key required to create room' using errcode = '42501';
    end if;

    insert into public.when_we_free_rooms (id, room_key_hash, state)
    values (room_id, key_hash, room_state)
    on conflict (id) do nothing
    returning state into saved_state;

    if saved_state is null then
      raise exception 'Room not found or key mismatch' using errcode = '42501';
    end if;

    return saved_state;
  end if;

  existing_admin_key_hash := existing_state->>'adminKeyHash';

  if existing_admin_key_hash is null then
    if admin_key_hash is null or room_state->>'adminKeyHash' is distinct from admin_key_hash then
      raise exception 'Admin key required to upgrade room permissions' using errcode = '42501';
    end if;
  elsif admin_key_hash is distinct from existing_admin_key_hash then
    if participant_key_hash is null
       or not public.when_we_free_can_participant_update(
         existing_state,
         room_state,
         participant_key_hash
       ) then
      raise exception 'Not allowed to edit this room state' using errcode = '42501';
    end if;
  end if;

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

create or replace function public.save_when_we_free_room(
  room_id text,
  room_key text,
  room_state jsonb
)
returns jsonb
language sql
set search_path = public
as $$
  select public.save_when_we_free_room(room_id, room_key, room_state, null, null, null);
$$;

create or replace function public.dissolve_when_we_free_room(
  room_id text,
  room_key text,
  admin_key text
)
returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  key_hash text := public.when_we_free_hash_key(room_key);
  admin_key_hash text := case
    when admin_key ~ '^[0-9a-f]{64}$' then public.when_we_free_hash_key(admin_key)
    else null
  end;
  existing_state jsonb;
  existing_dissolved_at timestamptz;
  dissolved_state jsonb;
begin
  if room_id !~ '^[0-9a-f]{32}$' or room_key !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid room credentials' using errcode = '22023';
  end if;

  if admin_key_hash is null then
    raise exception 'Admin key required to dissolve room' using errcode = '42501';
  end if;

  perform set_config('request.when_we_free_key_hash', key_hash, true);

  select state, dissolved_at into existing_state, existing_dissolved_at
  from public.when_we_free_rooms
  where id = room_id;

  if existing_state is null then
    raise exception 'Room not found or key mismatch' using errcode = '42501';
  end if;

  if existing_dissolved_at is not null then
    raise exception 'Room has been dissolved' using errcode = '42501';
  end if;

  if existing_state->>'adminKeyHash' is distinct from admin_key_hash then
    raise exception 'Admin key required to dissolve room' using errcode = '42501';
  end if;

  update public.when_we_free_rooms
  set dissolved_at = now()
  where id = room_id
    and room_key_hash = key_hash
  returning state into dissolved_state;

  if dissolved_state is null then
    raise exception 'Room not found or key mismatch' using errcode = '42501';
  end if;

  return dissolved_state;
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
revoke all on function public.save_when_we_free_room(text, text, jsonb, text, text, text) from public;
revoke all on function public.dissolve_when_we_free_room(text, text, text) from public;
revoke all on function public.get_when_we_free_room(text, text) from authenticated;
revoke all on function public.save_when_we_free_room(text, text, jsonb) from authenticated;
revoke all on function public.save_when_we_free_room(text, text, jsonb, text, text, text) from authenticated;
revoke all on function public.dissolve_when_we_free_room(text, text, text) from authenticated;
grant usage on schema public to anon;
grant execute on function public.get_when_we_free_room(text, text) to anon;
grant execute on function public.save_when_we_free_room(text, text, jsonb) to anon;
grant execute on function public.save_when_we_free_room(text, text, jsonb, text, text, text) to anon;
grant execute on function public.dissolve_when_we_free_room(text, text, text) to anon;
