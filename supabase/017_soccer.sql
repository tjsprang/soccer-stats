-- Soccer: leagues get a sport, and games can record soccer match events.
-- The frisbee app and the soccer app share this database (same accounts). Each app only shows its own sport's leagues.
-- Run 016 first if you haven't. Then run this once in Supabase: SQL Editor → New query → paste → Run.

-- Every existing league is a frisbee league.
alter table public.leagues add column sport text not null default 'frisbee' check (sport in ('frisbee', 'soccer'));
create index leagues_sport on public.leagues (sport);

-- Soccer match events, alongside the frisbee ones (same table):
--   kickoff  start of a half (detail: { period, len, gk: { teamId: keeperId } }, played: { teamId: [playerIds on the pitch] })
--   half     end of the first half          full      final whistle
--   goal     player_id scored, assist_id assisted (detail: { pen: true } for a penalty)
--   own_goal team_id = the team the goal counts for, player_id = the player who put it in their own net
--   shot     detail: { on: true } saved / on target, { blk: true } blocked, otherwise off target (and { pen: true } for penalties)
--   corner, foul, offside, yellow, red      sub   player_id came on, target_id went off
--   gk       player_id is now the team's goalkeeper
--   shootout a penalty shootout's result (detail: { score: { teamId: goals } })
alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check check (type in (
  'goal', 'd', 'throwaway', 'drop', 'callahan', 'half',
  'pull', 'pickup', 'pass', 'stall',
  'timeout',
  'kickoff', 'full', 'own_goal', 'shot', 'corner', 'foul', 'offside', 'yellow', 'red', 'sub', 'gk', 'shootout'
));

-- Creating a league now says which sport it's for, and how many players are on the field (same as 015, plus both).
drop function public.create_league(text, text, int);
create function public.create_league(p_name text, p_password text, p_min_roster int default 0,
                                     p_sport text default 'frisbee', p_on_field int default null)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if char_length(trim(coalesce(p_name, ''))) < 2 then raise exception 'League name must be at least 2 characters.'; end if;
  if char_length(coalesce(p_password, '')) < 4 then raise exception 'League password must be at least 4 characters.'; end if;
  if coalesce(p_min_roster, 0) not between 0 and 60 then raise exception 'The minimum roster must be between 0 and 60 players.'; end if;
  if coalesce(p_sport, 'frisbee') not in ('frisbee', 'soccer') then raise exception 'Unknown sport.'; end if;
  if p_on_field is not null and p_on_field not between 3 and 11 then raise exception 'Players on the field must be between 3 and 11.'; end if;
  if exists (select 1 from public.leagues where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A league with that name already exists.';
  end if;
  insert into public.leagues (name, created_by, min_roster, sport, on_field)
    values (trim(p_name), auth.uid(), coalesce(p_min_roster, 0), coalesce(p_sport, 'frisbee'),
            coalesce(p_on_field, case when p_sport = 'soccer' then 11 else 7 end))
    returning * into l;
  insert into public.league_secrets (league_id, password_hash)
    values (l.id, extensions.crypt(p_password, extensions.gen_salt('bf')));
  insert into public.league_admins (league_id, user_id, user_email) values (l.id, auth.uid(), auth.jwt() ->> 'email');
  insert into public.seasons (league_id, name, number) values (l.id, 'Season 1', 1);
  return l;
end;
$$;
revoke execute on function public.create_league(text, text, int, text, int) from public, anon;
grant execute on function public.create_league(text, text, int, text, int) to authenticated;
