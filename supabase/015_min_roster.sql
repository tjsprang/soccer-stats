-- A league-wide minimum roster size for teams registered by team admins.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.leagues add column min_roster int not null default 0 check (min_roster between 0 and 60);

-- Creating a league now sets the minimum too (same as 007, plus p_min_roster).
drop function public.create_league(text, text);
create function public.create_league(p_name text, p_password text, p_min_roster int default 0)
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
  if exists (select 1 from public.leagues where lower(trim(name)) = lower(trim(p_name))) then
    raise exception 'A league with that name already exists.';
  end if;
  insert into public.leagues (name, created_by, min_roster) values (trim(p_name), auth.uid(), coalesce(p_min_roster, 0)) returning * into l;
  insert into public.league_secrets (league_id, password_hash)
    values (l.id, extensions.crypt(p_password, extensions.gen_salt('bf')));
  insert into public.league_admins (league_id, user_id, user_email) values (l.id, auth.uid(), auth.jwt() ->> 'email');
  insert into public.seasons (league_id, name, number) values (l.id, 'Season 1', 1);
  return l;
end;
$$;
revoke execute on function public.create_league(text, text, int) from public, anon;
grant execute on function public.create_league(text, text, int) to authenticated;

create or replace function public.set_league_min_roster(p_league_id uuid, p_min int)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if not public.is_league_admin(p_league_id) then raise exception 'Only league admins can change its settings.'; end if;
  if coalesce(p_min, 0) not between 0 and 60 then raise exception 'The minimum roster must be between 0 and 60 players.'; end if;
  update public.leagues set min_roster = coalesce(p_min, 0) where id = p_league_id returning * into l;
  return l;
end;
$$;
revoke execute on function public.set_league_min_roster(uuid, int) from public, anon;
grant execute on function public.set_league_min_roster(uuid, int) to authenticated;

-- Registering a team checks the minimum (same as 014, plus the check).
create or replace function public.submit_team_request(p_league_id uuid, p_kind text, p_team_id text, p_name text, p_color text, p_roster jsonb,
                                                      p_color2 text default null)
returns public.team_requests
language plpgsql security definer set search_path = ''
as $$
declare
  r public.team_requests;
  n int;
  need int;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  select min_roster into need from public.leagues where id = p_league_id;
  if not found then raise exception 'League not found.'; end if;
  if exists (select 1 from public.team_requests where league_id = p_league_id and user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a request waiting for this league’s admins.';
  end if;
  if p_kind = 'new' then
    if char_length(trim(coalesce(p_name, ''))) < 1 then raise exception 'Give your team a name.'; end if;
    select count(*) into n from jsonb_array_elements(coalesce(p_roster, '[]')) p where char_length(trim(coalesce(p ->> 'name', ''))) > 0;
    if n > 60 then raise exception 'That’s a lot of players. Keep a roster to 60 or fewer.'; end if;
    if n < need then
      raise exception 'This league needs at least % players on a roster (you have %).', need, n;
    end if;
  elsif p_kind = 'manage' then
    if not exists (select 1 from public.teams where id = p_team_id and league_id = p_league_id) then raise exception 'Team not found.'; end if;
    if public.is_team_admin(p_team_id) then raise exception 'You already manage this team.'; end if;
  else
    raise exception 'Unknown request.';
  end if;
  insert into public.team_requests (league_id, user_id, user_email, kind, team_id, name, color, color2, roster)
    values (p_league_id, auth.uid(), auth.jwt() ->> 'email', p_kind, case when p_kind = 'manage' then p_team_id end,
            case when p_kind = 'new' then trim(p_name) end, case when p_kind = 'new' then coalesce(p_color, '#888888') end,
            case when p_kind = 'new' then p_color2 end,
            case when p_kind = 'new' then coalesce(p_roster, '[]') else '[]' end)
    returning * into r;
  return r;
end;
$$;
