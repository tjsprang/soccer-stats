-- Practice scrimmages: a team splits its own roster into two sides (Dark and Light) and tracks the scrimmage
-- like a game. They're stored with the other games (stage 'practice') but never count toward league stats,
-- and only that team's players, its team admins and the league's admins can see them.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- A practice game's two sides aren't teams, so the "both teams must exist" rules move from foreign keys
-- into triggers that skip practice games. Find the old constraints by what they check (their names vary).
do $$
declare c record;
begin
  for c in
    select conname, conrelid::regclass as tbl from pg_constraint
    where (conrelid = 'public.games'::regclass and (
             (contype = 'f' and (pg_get_constraintdef(oid) like 'FOREIGN KEY (home_id%' or pg_get_constraintdef(oid) like 'FOREIGN KEY (away_id%'))
          or (contype = 'c' and (pg_get_constraintdef(oid) like '%home_id <> away_id%' or pg_get_constraintdef(oid) like '%stage%'))))
       or (conrelid = 'public.events'::regclass and contype = 'f' and pg_get_constraintdef(oid) like 'FOREIGN KEY (team_id%')
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table public.games add column practice_team text;   -- the team practising (practice games only)
alter table public.games add column sides jsonb;           -- { dark: [playerId, …], light: [playerId, …] }
alter table public.games add constraint games_stage_check check (stage in ('regular', 'playoff', 'practice'));
-- Practice games have a team and sides named after the game; other games have two different teams.
alter table public.games add constraint games_shape_check check (
  (stage = 'practice') = (practice_team is not null)
  and (stage <> 'practice' or (home_id = id || ':dark' and away_id = id || ':light'))
  and (stage = 'practice' or home_id <> away_id));
alter table public.games add constraint games_practice_team_fkey
  foreign key (practice_team, league_id) references public.teams(id, league_id) on delete cascade;
create index games_practice_team on public.games (practice_team) where practice_team is not null;

-- League games: both teams must be in the league (what the foreign keys used to check).
create or replace function public.check_game_teams()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.stage <> 'practice' and (
       not exists (select 1 from public.teams where id = new.home_id and league_id = new.league_id)
    or not exists (select 1 from public.teams where id = new.away_id and league_id = new.league_id)) then
    raise exception 'Both teams must be in this league.' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger games_check_teams before insert or update of home_id, away_id, stage, league_id on public.games
  for each row execute function public.check_game_teams();

-- Plays: the team is one of the game's two sides (or a team in the league, as before).
create or replace function public.check_event_team()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.team_id is not null
     and not exists (select 1 from public.games g where g.id = new.game_id and new.team_id in (g.home_id, g.away_id))
     and not exists (select 1 from public.teams where id = new.team_id and league_id = new.league_id) then
    raise exception 'That play’s team isn’t in this game.' using errcode = '23503';
  end if;
  return new;
end;
$$;
create trigger events_check_team before insert or update of team_id, game_id on public.events
  for each row execute function public.check_event_team();

-- Deleting a team deletes its games (the app already did this first; now the database makes sure).
create or replace function public.delete_team_games()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.games where league_id = old.league_id and stage <> 'practice' and (home_id = old.id or away_id = old.id);
  return old;
end;
$$;
create trigger teams_delete_games after delete on public.teams
  for each row execute function public.delete_team_games();

-- ----- Who can see practice games -----
-- League admins, the team's admins, and players who have claimed a spot on the team.
create or replace function public.can_see_practice(p_team_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.teams t where t.id = p_team_id and (
    public.is_league_admin(t.league_id) or public.is_team_admin(t.id)
    or exists (select 1 from public.players p where p.team_id = t.id and p.user_id = auth.uid())));
$$;
grant execute on function public.can_see_practice(text) to authenticated;

drop policy "Signed-in users can view games" on public.games;
create policy "Signed-in users can view games (practices: only the team)" on public.games for select to authenticated
  using (practice_team is null or public.can_see_practice(practice_team));
drop policy "Signed-in users can view events" on public.events;
create policy "Signed-in users can view plays in games they can see" on public.events for select to authenticated
  using (game_id in (select id from public.games));   -- the games policy above decides

drop policy "Anyone can view public league games" on public.games;
create policy "Anyone can view public league games (not practices)" on public.games for select to anon
  using (practice_team is null and public.is_public_league(league_id));
drop policy "Anyone can view public league plays" on public.events;
create policy "Anyone can view public league plays (not practices)" on public.events for select to anon
  using (public.is_public_league(league_id) and game_id in (select id from public.games));

-- ----- Team admins run their own team's practices (start, track and delete them) -----
create policy "Team admins run their practices" on public.games for all to authenticated
  using (practice_team is not null and public.is_team_admin(practice_team))
  with check (practice_team is not null and public.is_team_admin(practice_team));
create or replace function public.is_team_admin_of_game(p_game_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.games g where g.id = p_game_id
    and (public.is_team_admin(g.home_id) or public.is_team_admin(g.away_id) or public.is_team_admin(g.practice_team)));
$$;
