-- Team registration requests can include a second team colour.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

alter table public.team_requests add column color2 text check (color2 is null or color2 ~ '^#[0-9a-fA-F]{6}$');

-- Same as 012, plus the optional second colour.
drop function public.submit_team_request(uuid, text, text, text, text, jsonb);
create function public.submit_team_request(p_league_id uuid, p_kind text, p_team_id text, p_name text, p_color text, p_roster jsonb,
                                           p_color2 text default null)
returns public.team_requests
language plpgsql security definer set search_path = ''
as $$
declare
  r public.team_requests;
  n int;
begin
  if auth.uid() is null then raise exception 'You must be signed in.'; end if;
  if not exists (select 1 from public.leagues where id = p_league_id) then raise exception 'League not found.'; end if;
  if exists (select 1 from public.team_requests where league_id = p_league_id and user_id = auth.uid() and status = 'pending') then
    raise exception 'You already have a request waiting for this league’s admins.';
  end if;
  if p_kind = 'new' then
    if char_length(trim(coalesce(p_name, ''))) < 1 then raise exception 'Give your team a name.'; end if;
    n := jsonb_array_length(coalesce(p_roster, '[]'));
    if n > 60 then raise exception 'That’s a lot of players. Keep a roster to 60 or fewer.'; end if;
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
revoke execute on function public.submit_team_request(uuid, text, text, text, text, jsonb, text) from public, anon;
grant execute on function public.submit_team_request(uuid, text, text, text, text, jsonb, text) to authenticated;

-- Approving a new team gives it both colours (same as 012, plus color2).
create or replace function public.decide_team_request(p_id uuid, p_approve boolean)
returns public.team_requests
language plpgsql security definer set search_path = ''
as $$
declare
  r public.team_requests;
  s public.seasons;
  new_team text;
  p jsonb;
  i int := 0;
begin
  select * into r from public.team_requests where id = p_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if not public.is_league_admin(r.league_id) then raise exception 'Only league admins can approve team requests.'; end if;
  if r.status <> 'pending' then raise exception 'This request has already been handled.'; end if;
  if p_approve then
    if r.kind = 'new' then
      select * into s from public.seasons where league_id = r.league_id and status = 'active';
      insert into public.teams (league_id, season_id, name, color, color2)
        values (r.league_id, s.id, r.name, r.color, r.color2) returning id into new_team;
      for p in select * from jsonb_array_elements(r.roster) loop
        if char_length(trim(coalesce(p ->> 'name', ''))) > 0 then
          insert into public.players (league_id, team_id, season_id, name, number, sort)
            values (r.league_id, new_team, s.id, left(trim(p ->> 'name'), 60), left(coalesce(trim(p ->> 'number'), ''), 4), i);
          i := i + 1;
        end if;
      end loop;
      r.team_id := new_team;
    end if;
    insert into public.team_admins (team_id, league_id, user_id, user_email) values (r.team_id, r.league_id, r.user_id, r.user_email)
      on conflict do nothing;
    update public.team_requests set status = 'approved', decided_at = now(), team_id = r.team_id where id = p_id returning * into r;
  else
    update public.team_requests set status = 'denied', decided_at = now() where id = p_id returning * into r;
  end if;
  return r;
end;
$$;
