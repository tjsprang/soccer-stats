-- Public read-only links, player photos and bios, and game availability.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- ----- Public links -----
-- When a league is public, anyone with its link can view it without an account (read only).
alter table public.leagues add column is_public boolean not null default false;

create or replace function public.set_league_public(p_league_id uuid, p_public boolean)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can change this.'; end if;
  update public.leagues set is_public = coalesce(p_public, false) where id = p_league_id returning * into l;
  return l;
end;
$$;
revoke execute on function public.set_league_public(uuid, boolean) from public, anon;
grant execute on function public.set_league_public(uuid, boolean) to authenticated;

create or replace function public.is_public_league(p_league_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$ select coalesce((select is_public from public.leagues where id = p_league_id), false); $$;
grant execute on function public.is_public_league(uuid) to anon, authenticated;

-- Visitors who aren't signed in (the "anon" role) can read public leagues only.
create policy "Anyone can view public leagues" on public.leagues for select to anon using (is_public);
create policy "Anyone can view public league seasons" on public.seasons for select to anon using (public.is_public_league(league_id));
create policy "Anyone can view public league teams" on public.teams for select to anon using (public.is_public_league(league_id));
create policy "Anyone can view public league players" on public.players for select to anon using (public.is_public_league(league_id));
create policy "Anyone can view public league games" on public.games for select to anon using (public.is_public_league(league_id));
create policy "Anyone can view public league plays" on public.events for select to anon using (public.is_public_league(league_id));
create policy "Anyone can view public league hall of fame" on public.hall_of_fame for select to anon using (public.is_public_league(league_id));

-- ----- Player photos and bios -----
-- One profile per person (their all-time identity), so it follows them across seasons.
-- Editable by league admins, or by whoever has claimed that player.
create or replace function public.can_edit_person(p_league_id uuid, p_person_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_league_admin(p_league_id)
      or exists (select 1 from public.players where league_id = p_league_id and person_id = p_person_id and user_id = auth.uid());
$$;

create table public.person_profiles (
  league_id uuid not null references public.leagues(id) on delete cascade,
  person_id text not null,
  bio text check (bio is null or char_length(bio) <= 400),
  position text check (position is null or char_length(position) <= 30),
  photo_path text,   -- in the player-photos storage bucket
  updated_at timestamptz not null default now(),
  primary key (league_id, person_id)
);
alter table public.person_profiles enable row level security;
create policy "Signed-in users can view profiles" on public.person_profiles for select to authenticated using (true);
create policy "Anyone can view public league profiles" on public.person_profiles for select to anon using (public.is_public_league(league_id));
create policy "Admins and the player can add a profile" on public.person_profiles for insert to authenticated
  with check (public.can_edit_person(league_id, person_id));
create policy "Admins and the player can edit a profile" on public.person_profiles for update to authenticated
  using (public.can_edit_person(league_id, person_id)) with check (public.can_edit_person(league_id, person_id));
create policy "Admins and the player can remove a profile" on public.person_profiles for delete to authenticated
  using (public.can_edit_person(league_id, person_id));

-- Photos live at player-photos/<league id>/<person id>.jpg. Anyone can view them (the bucket is public);
-- only admins or the player can upload, replace or delete.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('player-photos', 'player-photos', true, 1048576, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do nothing;

create or replace function public.can_edit_photo(p_name text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  parts text[] := string_to_array(p_name, '/');
begin
  if array_length(parts, 1) <> 2 then return false; end if;
  return public.can_edit_person(parts[1]::uuid, split_part(parts[2], '.', 1));
exception when others then
  return false;   -- not a valid league id
end;
$$;

create policy "Admins and the player can upload photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'player-photos' and public.can_edit_photo(name));
create policy "Admins and the player can replace photos" on storage.objects for update to authenticated
  using (bucket_id = 'player-photos' and public.can_edit_photo(name));
create policy "Admins and the player can delete photos" on storage.objects for delete to authenticated
  using (bucket_id = 'player-photos' and public.can_edit_photo(name));

-- ----- Availability -----
-- Whether a player is coming to an upcoming game: set by that player (if claimed) or a league admin.
create table public.availability (
  league_id uuid not null,
  game_id text not null,
  player_id text not null,
  status text not null check (status in ('yes', 'maybe', 'no')),
  updated_at timestamptz not null default now(),
  primary key (game_id, player_id),
  foreign key (game_id, league_id) references public.games(id, league_id) on delete cascade,
  foreign key (player_id, league_id) references public.players(id, league_id) on delete cascade
);
create index availability_league on public.availability (league_id);
alter table public.availability enable row level security;

create or replace function public.can_set_availability(p_league_id uuid, p_player_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_league_admin(p_league_id)
      or exists (select 1 from public.players where id = p_player_id and league_id = p_league_id and user_id = auth.uid());
$$;

create policy "Signed-in users can view availability" on public.availability for select to authenticated using (true);
create policy "Players and admins can set availability" on public.availability for insert to authenticated
  with check (public.can_set_availability(league_id, player_id));
create policy "Players and admins can change availability" on public.availability for update to authenticated
  using (public.can_set_availability(league_id, player_id)) with check (public.can_set_availability(league_id, player_id));
create policy "Players and admins can clear availability" on public.availability for delete to authenticated
  using (public.can_set_availability(league_id, player_id));

alter publication supabase_realtime add table public.person_profiles, public.availability;
