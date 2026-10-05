-- A second (optional) colour for teams.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.teams add column color2 text check (color2 is null or color2 ~ '^#[0-9a-fA-F]{6}$');

-- New seasons with the same teams copy both colours (same as 012, plus color2).
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
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can start a new season.'; end if;
  select * into old from public.seasons where league_id = p_league_id and status = 'active' for update;
  if not found then raise exception 'This league has no active season.'; end if;
  if exists (select 1 from public.games where season_id = old.id and status = 'live') then
    raise exception 'Finish or delete the live games in % first.', old.name;
  end if;
  update public.seasons set status = 'archived', ended_at = now() where id = old.id;
  delete from public.games where season_id = old.id and status = 'scheduled';
  insert into public.seasons (league_id, name, number)
    values (p_league_id, coalesce(nullif(trim(p_name), ''), 'Season ' || (old.number + 1)), old.number + 1)
    returning * into s;
  if p_copy_teams then
    for t in select * from public.teams where season_id = old.id order by created_at, id loop
      insert into public.teams (league_id, season_id, name, color, color2, created_at)
        values (p_league_id, s.id, t.name, t.color, t.color2, clock_timestamp()) returning id into new_team;
      insert into public.players (league_id, team_id, season_id, name, number, sort, person_id, user_id)
        select league_id, new_team, s.id, name, number, sort, person_id, user_id from public.players where team_id = t.id;
      insert into public.team_admins (team_id, league_id, user_id, user_email)
        select new_team, league_id, user_id, user_email from public.team_admins where team_id = t.id;
    end loop;
  end if;
  return s;
end;
$$;
