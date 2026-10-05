-- Teams, players, games and play-by-play, shared by everyone in a league.
-- Anyone signed in can view a league's data; only that league's admins can change it.
-- Run this once in Supabase: SQL Editor → New query → paste → Run.

-- League setting: players on the field at once.
alter table public.leagues
  add column on_field int not null default 7 check (on_field between 3 and 11);

create or replace function public.is_league_admin(p_league_id uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.league_admins where league_id = p_league_id and user_id = auth.uid()
  );
$$;

-- IDs are text so the app can create them up front (and so older browser-saved data can be uploaded).
create table public.teams (
  id text primary key default gen_random_uuid()::text,
  league_id uuid not null references public.leagues(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  color text not null default '#888888' check (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz not null default now(),
  unique (id, league_id)
);

create table public.players (
  id text primary key default gen_random_uuid()::text,
  league_id uuid not null,
  team_id text not null,
  name text not null check (char_length(name) between 1 and 60),
  number text not null default '' check (char_length(number) <= 4),
  sort int not null default 0,  -- roster order
  foreign key (team_id, league_id) references public.teams(id, league_id) on delete cascade,
  unique (id, league_id)
);

create table public.games (
  id text primary key default gen_random_uuid()::text,
  league_id uuid not null references public.leagues(id) on delete cascade,
  home_id text not null,
  away_id text not null,
  status text not null check (status in ('scheduled', 'live', 'final')),
  created_ms bigint not null,   -- when the game started (or was scheduled), in ms
  scheduled_at text,            -- local date and time, e.g. 2026-10-03T18:00
  field int,
  round int,
  lineup jsonb,                 -- { teamId: [playerId, ...] } currently on the field
  point_players jsonb,          -- everyone on the field so far this point (for points played)
  check (home_id <> away_id),
  foreign key (home_id, league_id) references public.teams(id, league_id),
  foreign key (away_id, league_id) references public.teams(id, league_id),
  unique (id, league_id)
);

create table public.events (
  id text primary key default gen_random_uuid()::text,
  seq bigint generated always as identity,   -- keeps plays in the order they were recorded
  league_id uuid not null,
  game_id text not null,
  t bigint not null,                         -- when it happened, in ms
  type text not null check (type in ('goal', 'd', 'throwaway', 'drop', 'callahan', 'half')),
  team_id text,
  player_id text,
  assist_id text,
  played jsonb,                              -- on point-ending plays: who played the point
  foreign key (game_id, league_id) references public.games(id, league_id) on delete cascade,
  foreign key (team_id, league_id) references public.teams(id, league_id),
  foreign key (player_id, league_id) references public.players(id, league_id),
  foreign key (assist_id, league_id) references public.players(id, league_id)
);

create index teams_league on public.teams (league_id);
create index players_league on public.players (league_id);
create index games_league on public.games (league_id);
create index events_league on public.events (league_id, seq);
create index events_game on public.events (game_id);

alter table public.teams enable row level security;
alter table public.players enable row level security;
alter table public.games enable row level security;
alter table public.events enable row level security;

create policy "Signed-in users can view teams" on public.teams for select to authenticated using (true);
create policy "Signed-in users can view players" on public.players for select to authenticated using (true);
create policy "Signed-in users can view games" on public.games for select to authenticated using (true);
create policy "Signed-in users can view events" on public.events for select to authenticated using (true);

create policy "League admins manage teams" on public.teams for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "League admins manage players" on public.players for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "League admins manage games" on public.games for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));
create policy "League admins manage events" on public.events for all to authenticated
  using (public.is_league_admin(league_id)) with check (public.is_league_admin(league_id));

create or replace function public.set_league_on_field(p_league_id uuid, p_on_field int)
returns public.leagues
language plpgsql security definer set search_path = ''
as $$
declare
  l public.leagues;
begin
  if not public.is_league_admin(p_league_id) then
    raise exception 'Only admins of this league can change its settings.';
  end if;
  if p_on_field is null or p_on_field not between 3 and 11 then
    raise exception 'Players on the field must be between 3 and 11.';
  end if;
  update public.leagues set on_field = p_on_field where id = p_league_id returning * into l;
  return l;
end;
$$;

revoke execute on function public.set_league_on_field(uuid, int) from public, anon;
grant execute on function public.set_league_on_field(uuid, int) to authenticated;

-- Live updates: phones watching a league see changes as they happen.
alter publication supabase_realtime add table public.leagues, public.teams, public.players, public.games, public.events;
