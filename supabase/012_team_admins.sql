-- Team admins: captains who manage one team in a league (its roster, its games, its players' claims and
-- availability), and team registration requests that league admins approve.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

create table public.team_admins (
  team_id text not null,
  league_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  created_at timestamptz not null default now(),
  primary key (team_id, user_id),
  foreign key (team_id, league_id) references public.teams(id, league_id) on delete cascade
);
create index team_admins_user on public.team_admins (user_id);
alter table public.team_admins enable row level security;

create or replace function public.is_team_admin(p_team_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.team_admins where team_id = p_team_id and user_id = auth.uid()); $$;

-- League admins, and team admins themselves, can see who manages which team.
create policy "See team admins (yours, or all in leagues you run)" on public.team_admins for select to authenticated
  using (user_id = auth.uid() or public.is_league_admin(league_id));
create policy "League admins remove team admins" on public.team_admins for delete to authenticated
  using (public.is_league_admin(league_id));

-- ----- What team admins can change (only things involving their own team) -----
create policy "Team admins edit their team" on public.teams for update to authenticated
  using (public.is_team_admin(id)) with check (public.is_team_admin(id));
-- Saving uses insert-or-update, which is also checked as an insert. This only matches teams they already
-- manage, so team admins can't create new teams this way.
create policy "Team admins save their team" on public.teams for insert to authenticated
  with check (public.is_team_admin(id));
create policy "Team admins add to their roster" on public.players for insert to authenticated
  with check (public.is_team_admin(team_id));
create policy "Team admins edit their roster" on public.players for update to authenticated
  using (public.is_team_admin(team_id)) with check (public.is_team_admin(team_id));
create policy "Team admins remove from their roster" on public.players for delete to authenticated
  using (public.is_team_admin(team_id));
-- Games their team plays in (they can't delete games; league admins can).
create policy "Team admins start their games" on public.games for insert to authenticated
  with check (public.is_team_admin(home_id) or public.is_team_admin(away_id));
create policy "Team admins track their games" on public.games for update to authenticated
  using (public.is_team_admin(home_id) or public.is_team_admin(away_id))
  with check (public.is_team_admin(home_id) or public.is_team_admin(away_id));
create or replace function public.is_team_admin_of_game(p_game_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.games g where g.id = p_game_id and (public.is_team_admin(g.home_id) or public.is_team_admin(g.away_id))); $$;
create policy "Team admins record plays in their games" on public.events for insert to authenticated
  with check (public.is_team_admin_of_game(game_id));
create policy "Team admins correct plays in their games" on public.events for update to authenticated
  using (public.is_team_admin_of_game(game_id)) with check (public.is_team_admin_of_game(game_id));
create policy "Team admins undo plays in their games" on public.events for delete to authenticated
  using (public.is_team_admin_of_game(game_id));

-- Availability and claims for their own players.
create or replace function public.can_set_availability(p_league_id uuid, p_player_id text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select public.is_league_admin(p_league_id)
      or exists (select 1 from public.players where id = p_player_id and league_id = p_league_id
                 and (user_id = auth.uid() or public.is_team_admin(team_id)));
$$;
create policy "Team admins see claims on their players" on public.player_claims for select to authenticated
  using (exists (select 1 from public.players p where p.id = player_id and public.is_team_admin(p.team_id)));

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
  select * into pl from public.players where id = c.player_id;
  if not (public.is_league_admin(c.league_id) or public.is_team_admin(pl.team_id)) then
    raise exception 'Only league admins or this team’s admins can approve or deny claims.';
  end if;
  if c.status <> 'pending' then raise exception 'This claim has already been handled.'; end if;
  if p_approve then
    if pl.user_id is not null and pl.user_id <> c.user_id then raise exception 'Someone else has already claimed this player.'; end if;
    if exists (select 1 from public.players where season_id = pl.season_id and user_id = c.user_id and id <> c.player_id) then
      raise exception 'This person has already claimed a different player this season.';
    end if;
    update public.players set user_id = c.user_id where id = c.player_id;
    update public.player_claims set status = 'approved', decided_at = now() where id = c.id returning * into c;
    update public.player_claims set status = 'denied', decided_at = now() where player_id = c.player_id and status = 'pending';
  else
    update public.player_claims set status = 'denied', decided_at = now() where id = c.id returning * into c;
  end if;
  return c;
end;
$$;

-- ----- Team requests: register a new team (with its roster), or ask to manage an existing one -----
create table public.team_requests (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_email text,
  kind text not null check (kind in ('new', 'manage')),
  team_id text,                    -- for 'manage': the existing team
  name text check (name is null or char_length(name) between 1 and 60),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  roster jsonb not null default '[]',   -- for 'new': [{ "name": "...", "number": "..." }, ...]
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index team_requests_league on public.team_requests (league_id, status);
alter table public.team_requests enable row level security;
create policy "See your own team requests, or all in leagues you run" on public.team_requests for select to authenticated
  using (user_id = auth.uid() or public.is_league_admin(league_id));

create or replace function public.submit_team_request(p_league_id uuid, p_kind text, p_team_id text, p_name text, p_color text, p_roster jsonb)
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
  insert into public.team_requests (league_id, user_id, user_email, kind, team_id, name, color, roster)
    values (p_league_id, auth.uid(), auth.jwt() ->> 'email', p_kind, case when p_kind = 'manage' then p_team_id end,
            case when p_kind = 'new' then trim(p_name) end, case when p_kind = 'new' then coalesce(p_color, '#888888') end,
            case when p_kind = 'new' then coalesce(p_roster, '[]') else '[]' end)
    returning * into r;
  return r;
end;
$$;

create or replace function public.cancel_team_request(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$ begin delete from public.team_requests where id = p_id and user_id = auth.uid() and status = 'pending'; end; $$;

-- Approving a new team creates it (in the current season) with its roster, and makes the sender its team admin.
-- Approving a 'manage' request makes the sender an admin of that existing team.
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
      insert into public.teams (league_id, season_id, name, color) values (r.league_id, s.id, r.name, r.color) returning id into new_team;
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

revoke execute on function public.submit_team_request(uuid, text, text, text, text, jsonb) from public, anon;
revoke execute on function public.cancel_team_request(uuid) from public, anon;
revoke execute on function public.decide_team_request(uuid, boolean) from public, anon;
grant execute on function public.submit_team_request(uuid, text, text, text, text, jsonb) to authenticated;
grant execute on function public.cancel_team_request(uuid) to authenticated;
grant execute on function public.decide_team_request(uuid, boolean) to authenticated;

-- ----- New seasons with the same teams keep their team admins (same as 006, plus team_admins) -----
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
      insert into public.teams (league_id, season_id, name, color, created_at)
        values (p_league_id, s.id, t.name, t.color, clock_timestamp()) returning id into new_team;
      insert into public.players (league_id, team_id, season_id, name, number, sort, person_id, user_id)
        select league_id, new_team, s.id, name, number, sort, person_id, user_id from public.players where team_id = t.id;
      insert into public.team_admins (team_id, league_id, user_id, user_email)
        select new_team, league_id, user_id, user_email from public.team_admins where team_id = t.id;
    end loop;
  end if;
  return s;
end;
$$;

alter publication supabase_realtime add table public.team_admins, public.team_requests;
