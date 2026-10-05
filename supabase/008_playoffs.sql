-- Playoffs: games are tagged regular season or playoff, and each season can hold one bracket.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.games add column stage text not null default 'regular' check (stage in ('regular', 'playoff'));
alter table public.games add column bracket_slot text;   -- e.g. 'R1M2' = round 1, match 2
create unique index games_one_per_bracket_slot on public.games (season_id, bracket_slot) where bracket_slot is not null;

-- The bracket: { "size": 8, "seeds": [teamId, ...] } (seed 1 first). Null = no playoffs yet.
alter table public.seasons add column playoffs jsonb;

create or replace function public.set_season_playoffs(p_season_id text, p_playoffs jsonb)
returns public.seasons
language plpgsql security definer set search_path = ''
as $$
declare
  s public.seasons;
begin
  select * into s from public.seasons where id = p_season_id;
  if not found then raise exception 'Season not found.'; end if;
  if not public.is_league_admin(s.league_id) then raise exception 'Only league admins can set up playoffs.'; end if;
  if s.status <> 'active' then raise exception 'That season is finished.'; end if;
  update public.seasons set playoffs = p_playoffs where id = p_season_id returning * into s;
  return s;
end;
$$;
revoke execute on function public.set_season_playoffs(text, jsonb) from public, anon;
grant execute on function public.set_season_playoffs(text, jsonb) to authenticated;
