-- Game details: timeouts, wind, and an optional time cap.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- Timeouts are recorded as plays (team_id = the team that called it).
alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check check (type in (
  'goal', 'd', 'throwaway', 'drop', 'callahan', 'half',
  'pull', 'pickup', 'pass', 'stall',
  'timeout'
));

-- Wind for a game: { "mph": 12, "dir": "cross" }. dir is how it blows across the field:
-- "left" / "right" (toward an end zone, as seen from the stat-keeper's sideline) or "cross" (sideline to sideline).
alter table public.games add column wind jsonb;

-- League setting: game time cap in minutes (null = no cap).
alter table public.leagues add column time_cap int check (time_cap is null or time_cap between 10 and 240);

create or replace function public.set_league_time_cap(p_league_id uuid, p_minutes int)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can change its settings.'; end if;
  if p_minutes is not null and p_minutes not between 10 and 240 then raise exception 'The time cap must be between 10 and 240 minutes.'; end if;
  update public.leagues set time_cap = p_minutes where id = p_league_id returning * into l;
  return l;
end;
$$;
revoke execute on function public.set_league_time_cap(uuid, int) from public, anon;
grant execute on function public.set_league_time_cap(uuid, int) to authenticated;
