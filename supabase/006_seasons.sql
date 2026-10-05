-- Seasons, all-time player identity, and the Hall of Fame.
-- Existing teams and games become each league's "Season 1".
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

create table public.seasons (
  id text primary key default gen_random_uuid()::text,
  league_id uuid not null references public.leagues(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  number int not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  unique (id, league_id),
  unique (league_id, number)
);
create unique index seasons_one_active on public.seasons (league_id) where status = 'active';

-- Every league starts with Season 1, holding everything it already has.
insert into public.seasons (league_id, name, number) select id, 'Season 1', 1 from public.leagues;

alter table public.teams add column season_id text;
alter table public.players add column season_id text;
alter table public.games add column season_id text;
update public.teams t set season_id = s.id from public.seasons s where s.league_id = t.league_id;
update public.games g set season_id = s.id from public.seasons s where s.league_id = g.league_id;
update public.players p set season_id = t.season_id from public.teams t where t.id = p.team_id;
alter table public.teams alter column season_id set not null;
alter table public.players alter column season_id set not null;
alter table public.games alter column season_id set not null;
alter table public.teams add constraint teams_season_fkey foreign key (season_id, league_id) references public.seasons(id, league_id) on delete cascade;
alter table public.players add constraint players_season_fkey foreign key (season_id, league_id) references public.seasons(id, league_id) on delete cascade;
alter table public.games add constraint games_season_fkey foreign key (season_id, league_id) references public.seasons(id, league_id) on delete cascade;

-- A player's lasting identity across seasons: the same person_id on each season's roster entry.
alter table public.players add column person_id text;
update public.players set person_id = id;
alter table public.players alter column person_id set not null;
alter table public.players alter column person_id set default gen_random_uuid()::text;
create index players_person on public.players (league_id, person_id);

-- Claims: one claimed player per person per SEASON (so a claim can carry into the next season).
drop index public.players_one_claim_per_league;
create unique index players_one_claim_per_season on public.players (season_id, user_id) where user_id is not null;

create table public.hall_of_fame (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  person_id text not null,
  name text not null,              -- their name when inducted
  season_id text,                  -- the season they were inducted after
  note text check (note is null or char_length(note) <= 280),
  inducted_at timestamptz not null default now(),
  unique (league_id, person_id)
);

alter table public.seasons enable row level security;
alter table public.hall_of_fame enable row level security;
create policy "Signed-in users can view seasons" on public.seasons for select to authenticated using (true);
create policy "Signed-in users can view the hall of fame" on public.hall_of_fame for select to authenticated using (true);
create policy "League admins manage the hall of fame" on public.hall_of_fame for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
-- Seasons change only through start_new_season below.

-- End the current season and start the next one, optionally carrying the teams and rosters over.
create or replace function public.start_new_season(p_league_id uuid, p_name text, p_copy_teams boolean)
returns public.seasons
language plpgsql security definer set search_path = ''
as $$
declare
  old public.seasons;
  s public.seasons;
  t record;
  new_team text;
begin
  if not public.is_league_admin(p_league_id) then
    raise exception 'Only league admins can start a new season.';
  end if;
  select * into old from public.seasons where league_id = p_league_id and status = 'active' for update;
  if not found then raise exception 'This league has no active season.'; end if;
  if exists (select 1 from public.games where season_id = old.id and status = 'live') then
    raise exception 'Finish or delete the live games in % first.', old.name;
  end if;

  update public.seasons set status = 'archived', ended_at = now() where id = old.id;
  delete from public.games where season_id = old.id and status = 'scheduled';   -- games never played
  insert into public.seasons (league_id, name, number)
    values (p_league_id, coalesce(nullif(trim(p_name), ''), 'Season ' || (old.number + 1)), old.number + 1)
    returning * into s;

  if p_copy_teams then
    for t in select * from public.teams where season_id = old.id order by created_at, id loop
      insert into public.teams (league_id, season_id, name, color, created_at)
        values (p_league_id, s.id, t.name, t.color, clock_timestamp())
        returning id into new_team;
      insert into public.players (league_id, team_id, season_id, name, number, sort, person_id, user_id)
        select league_id, new_team, s.id, name, number, sort, person_id, user_id
        from public.players where team_id = t.id;
    end loop;
  end if;
  return s;
end;
$$;
revoke execute on function public.start_new_season(uuid, text, boolean) from public, anon;
grant execute on function public.start_new_season(uuid, text, boolean) to authenticated;

-- Claiming now works within a season (see 004).
create or replace function public.request_claim(p_player_id text)
returns public.player_claims
language plpgsql security definer set search_path = ''
as $$
declare
  pl public.players;
  c public.player_claims;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select * into pl from public.players where id = p_player_id;
  if not found then raise exception 'Player not found.'; end if;
  if pl.user_id = auth.uid() then raise exception 'You’ve already claimed this player.'; end if;
  if pl.user_id is not null then raise exception 'Someone has already claimed this player.'; end if;
  if exists (select 1 from public.players where season_id = pl.season_id and user_id = auth.uid()) then
    raise exception 'You’ve already claimed a player this season.';
  end if;
  if exists (select 1 from public.player_claims where league_id = pl.league_id and user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a claim waiting for approval in this league.';
  end if;
  insert into public.player_claims (league_id, player_id, user_id, user_email)
    values (pl.league_id, pl.id, auth.uid(), auth.jwt() ->> 'email')
    returning * into c;
  return c;
end;
$$;

create or replace function public.decide_claim(p_claim_id uuid, p_approve boolean)
returns public.player_claims
language plpgsql security definer set search_path = ''
as $$
declare
  c public.player_claims;
  pl public.players;
begin
  select * into c from public.player_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found.'; end if;
  if not public.is_league_admin(c.league_id) then raise exception 'Only league admins can approve or deny claims.'; end if;
  if c.status <> 'pending' then raise exception 'This claim has already been handled.'; end if;

  if p_approve then
    select * into pl from public.players where id = c.player_id;
    if pl.user_id is not null and pl.user_id <> c.user_id then
      raise exception 'Someone else has already claimed this player.';
    end if;
    if exists (select 1 from public.players where season_id = pl.season_id and user_id = c.user_id and id <> c.player_id) then
      raise exception 'This person has already claimed a different player this season.';
    end if;
    update public.players set user_id = c.user_id where id = c.player_id;
    update public.player_claims set status = 'approved', decided_at = now() where id = c.id returning * into c;
    update public.player_claims set status = 'denied', decided_at = now()
      where player_id = c.player_id and status = 'pending';
  else
    update public.player_claims set status = 'denied', decided_at = now() where id = c.id returning * into c;
  end if;
  return c;
end;
$$;

-- New leagues start with Season 1 (same as 001, plus the season).
create or replace function public.create_league(p_name text, p_password text)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'League name must be at least 2 characters.';
  end if;
  if char_length(coalesce(p_password, '')) < 4 then
    raise exception 'League password must be at least 4 characters.';
  end if;
  if exists (select 1 from public.leagues where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A league with that name already exists.';
  end if;

  insert into public.leagues (name, created_by) values (trim(p_name), auth.uid()) returning * into l;
  insert into public.league_secrets (league_id, password_hash)
    values (l.id, extensions.crypt(p_password, extensions.gen_salt('bf')));
  insert into public.league_admins (league_id, user_id) values (l.id, auth.uid());
  insert into public.seasons (league_id, name, number) values (l.id, 'Season 1', 1);
  return l;
end;
$$;

alter publication supabase_realtime add table public.seasons, public.hall_of_fame;
